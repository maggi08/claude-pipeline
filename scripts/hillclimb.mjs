#!/usr/bin/env node
/**
 * Hill-climb an agent's method on its eval cases: an opus editor makes one edit per iteration, the cases decide whether it stays.
 *
 *   node scripts/hillclimb.mjs --agent pro-review --max-cost-usd 20 --budget-usd 40 --budget-since 2026-10-30T07:42:03Z
 *   node scripts/hillclimb.mjs --agent pro-review --max-cost-usd 20 --run hc-1 --resume hc-1      # continue a run from its decision.tsv and branch, no second baseline
 *   node scripts/hillclimb.mjs --agent pro-review --max-cost-usd 20 --dry-run                     # the plan and the estimates; nothing is created, no model is called
 *   node scripts/hillclimb.mjs --self-test                                                       # free: a stub editor and a scripted evaluator in a temp git repo (CI runs it through validate.mjs)
 *
 * Never edits the checkout it is started from (D5): a temp git worktree under the system temp dir on a new local branch `hillclimb/<run>` from HEAD carries the edits and is
 * removed at the end (the branch stays); every eval inside it goes through that worktree's own scripts/eval.mjs, so the plugin copy it tests is the edited one, with
 * EVAL_LEDGER / EVAL_RESULTS pointing at THIS checkout. The log is evals/hillclimb/<run>/decision.tsv here; a kept edit is a commit on the branch whose message carries its row.
 *
 * Flags:
 *   --agent <a>              the agent to tune (default pro-review)
 *   --train a,b,c            case names (default: pro-review-recall-logic, -recall-parity, -language-en; -cross-stage-dup is out: all its recorded runs are W- harness failures); a case under evals/pending/ is named bare (when no evals/cases/ case has
 *                            that name) or as `pending/<name>`; the evaluator then runs it with `eval.mjs --pending`
 *   --holdout x,y            case names (default: pro-review-clean-ac, pro-review-language-ru), the same forms
 *   --runs 3                 runs per case (a case scores the median)
 *   --max-iterations 8       attempts in total, those of an earlier part of a resumed run included
 *   --min-attempts 3         the target alone does not stop the run before this many attempts ran (target met AND attempts >= N)
 *   --target 0.9             train mean at which the run may stop
 *   --max-cost-usd <x>       this run's own cap (required): no eval or editor call starts whose estimate (ledger mean per case; editor: mean of its own rows, else its budget) on top of the spend
 *                            of this run would pass it. The spend is the sum of the ledger rows the run wrote (its evals carry `--label hillclimb:<run>`, its editor rows `hillclimb:<run>`; an editor call
 *                            that times out or reports no cost is charged its budget), so a resumed run re-reads it; with --jobs the estimates of the cases already running are reserved
 *   --editor-model opus  --editor-budget-usd 1.5     per editor call (--max-budget-usd of the call)
 *   --jobs 3                 cases run in parallel inside one evaluation (4 train + 2 holdout cases x 3 runs one after another is ~12 minutes)
 *   --budget-usd/--budget-since   passed to every eval.mjs call (less what the cases running in parallel have reserved) and checked here too (the whole ledger since that time, editor rows included)
 *
 * A run stops with a row of its own: stopped-no-headroom (the baseline train mean + 0.1 passes 1: no edit could be kept; train on cases with headroom), stopped-eval-failed (a case with a
 * harness failure or fewer graded runs than --runs, named in the row), stopped-cap, stopped-target, stopped-max-iterations, stopped-checkout-touched (the editor call changed the starting checkout's tracked files or rewrote its ledger).
 * A signal charges the editor call and the eval children in flight into the ledger before the run exits (evals/hillclimb/<run>/inflight/ marks; a SIGKILL's are charged by the next --resume); --resume refuses while the
 * previous process of the run is alive (the worktree lock names its pid) and never prunes or removes any worktree but the run's own. --resume refuses a run whose baseline row is not `baseline`.
 *   --run <id>  --resume <id>
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CASES, LEDGER, RESULTS_DIR, ROOT, SOURCE_PLUGIN, readCase, readLedger } from './eval-lib.mjs'
import { agentTreeAt } from './release-lib.mjs'
import { DEFAULT_HOLDOUT, DEFAULT_TRAIN, caseLedgerSummary, climb, decisionPath, editorArgs, estimateEdit, estimateEval, makeEditor, makeEvaluator } from './hillclimb-lib.mjs'

const argv = process.argv.slice(2)
const fail = (message) => {
  console.error(message)
  process.exit(2)
}

if (argv.includes('--self-test')) {
  const { selfTest } = await import('./hillclimb-test.mjs')
  process.exit((await selfTest()) ? 0 : 1)
}

const opts = { agent: 'pro-review', runs: 3, maxIterations: 8, minAttempts: 3, target: 0.9, editorModel: 'opus', editorBudget: 1.5, jobs: 3, train: DEFAULT_TRAIN, holdout: DEFAULT_HOLDOUT }
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  const value = () => argv[++i] ?? fail(`${arg} expects a value`)
  const number = () => {
    const parsed = Number(value())
    return Number.isFinite(parsed) ? parsed : fail(`${arg} expects a number`)
  }
  if (arg === '--agent') opts.agent = value()
  else if (arg === '--train') opts.train = value().split(',').filter(Boolean)
  else if (arg === '--holdout') opts.holdout = value().split(',').filter(Boolean)
  else if (arg === '--runs') opts.runs = number()
  else if (arg === '--max-iterations') opts.maxIterations = number()
  else if (arg === '--min-attempts') opts.minAttempts = number()
  else if (arg === '--target') opts.target = number()
  else if (arg === '--max-cost-usd') opts.capUsd = number()
  else if (arg === '--editor-model') opts.editorModel = value()
  else if (arg === '--editor-budget-usd') opts.editorBudget = number()
  else if (arg === '--jobs') opts.jobs = number()
  else if (arg === '--budget-usd') opts.budgetUsd = number()
  else if (arg === '--budget-since') opts.budgetSince = value()
  else if (arg === '--run') opts.run = value()
  else if (arg === '--resume') opts.resume = value()
  else if (arg === '--claude-bin') opts.claudeBin = value()
  else if (arg === '--dry-run') opts.dryRun = true
  else fail(`unknown flag ${arg}`)
}
if (opts.resume) opts.run ??= opts.resume
if (opts.resume && opts.run !== opts.resume) fail('--run and --resume name different runs')
opts.run ??= `hc-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`
if (!/^[\w.-]+$/.test(opts.run)) fail('--run expects letters, digits, dots, dashes')
if (!(opts.capUsd > 0)) fail('--max-cost-usd <x> is required: the run never starts a call whose estimate passes it')
if (!(opts.runs >= 1) || !(opts.maxIterations >= 1) || !(opts.jobs >= 1)) fail('--runs, --max-iterations and --jobs expect numbers >= 1')

// The cases: they must exist and belong to the agent (a routing or decision case names none). A bare name is looked up under evals/cases/, then under evals/pending/;
// `pending/<name>` names a pending case explicitly. Either way the case is stored by its bare name, and the evaluator hands eval.mjs `--pending` for it.
const PENDING = join(ROOT, 'evals/pending')
const bare = (name) => name.replace(/^pending\//, '')
for (const list of [opts.train, opts.holdout]) list.forEach((name, i) => (list[i] = bare(name)))
for (const name of [...opts.train, ...opts.holdout]) {
  const dir = existsSync(join(CASES, name, 'case.json')) ? join(CASES, name) : join(PENDING, name)
  if (!existsSync(join(dir, 'case.json'))) fail(`no case ${name} under evals/cases/ or evals/pending/`)
  if (readCase(dir).agent !== opts.agent) fail(`case ${name} is not a case of ${opts.agent}`)
}
const overlap = opts.train.filter((name) => opts.holdout.includes(name))
if (overlap.length) fail(`train and holdout share ${overlap.join(', ')}`)
if (!existsSync(join(SOURCE_PLUGIN, 'agents', `${opts.agent}.md`))) fail(`no agent ${opts.agent}`)

const ledger = readLedger()
if (opts.dryRun) {
  const trainEst = estimateEval(ledger, opts.train, opts.runs)
  const holdEst = estimateEval(ledger, opts.holdout, opts.runs)
  const editEst = estimateEdit(ledger, opts.editorBudget)
  console.log(`hillclimb dry run — nothing is created, no model is called\n  run ${opts.run}, agent ${opts.agent}, branch hillclimb/${opts.run}, decision log ${decisionPath(ROOT, opts.run)}\n  train: ${opts.train.join(', ')}\n  holdout: ${opts.holdout.join(', ')}\n  runs per case ${opts.runs}, jobs ${opts.jobs}, max iterations ${opts.maxIterations}, min attempts ${opts.minAttempts}, target ${opts.target}`)
  console.log(`  estimates from the ledger: baseline $${(trainEst + holdEst).toFixed(2)}, one iteration $${(editEst + trainEst + holdEst).toFixed(2)} (editor $${editEst.toFixed(2)}, train $${trainEst.toFixed(2)}, holdout $${holdEst.toFixed(2)}); cap $${opts.capUsd}${opts.budgetUsd ? `, lane budget $${opts.budgetUsd} since ${opts.budgetSince ?? 'the start of the ledger'}` : ''}`)
  const fmt = (value) => (value === null || value === undefined ? '-' : value.toFixed(3))
  // Only the CURRENT agent counts: rows of the working tree (plugin_ref exactly `working-tree`, not a hill-climb candidate, `--ref`, effort or ablation run) at this checkout's plugin version, on a clean
  // sha whose agent bytes (agents/<a>.md + skills/<a>/) are HEAD's. A score of an older plugin says nothing about the headroom of this one.
  const version = JSON.parse(readFileSync(join(SOURCE_PLUGIN, '.claude-plugin/plugin.json'), 'utf8')).version
  const gitHere = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const headTree = agentTreeAt(gitHere, 'HEAD', opts.agent)
  const trees = new Map()
  const treeOf = (sha) => {
    if (!trees.has(sha)) trees.set(sha, agentTreeAt(gitHere, String(sha).replace(/\+dirty$/, ''), opts.agent))
    return trees.get(sha)
  }
  const summaries = Object.fromEntries([...opts.train, ...opts.holdout].map((name) => [name, caseLedgerSummary(ledger, name, { version, treeOf, agentTree: headTree })]))
  console.log(`  per case, from the ledger — runs of the current ${opts.agent} only (plugin ${version}, plugin_ref working-tree, agent_tree ${headTree ?? 'unknown'}); last invocation: median score and marks; runs; harness failures W-:`)
  for (const [split, names] of [['train', opts.train], ['holdout', opts.holdout]]) {
    for (const name of names) {
      const { runs, failures, score, marks, sha, excluded } = summaries[name]
      if (!runs) console.log(`    ${split} ${name}: unmeasured — the current ${opts.agent} has no run of this case in the ledger${excluded ? ` (${excluded} row(s) of another plugin, sha or label ignored)` : ''}: headroom unknown`)
      else console.log(`    ${split} ${name}: last score ${fmt(score)} [${marks}] at ${String(sha).slice(0, 9)}, ${runs} run(s), ${failures} W-${excluded ? `; ${excluded} row(s) of another plugin, sha or label ignored` : ''}`)
    }
  }
  const unmeasured = opts.train.filter((name) => !summaries[name].runs || summaries[name].score === null)
  const scored = opts.train.map((name) => summaries[name].score).filter((score) => score !== null)
  const trainMean = scored.length ? scored.reduce((sum, score) => sum + score, 0) / scored.length : null
  if (unmeasured.length) console.log(`  headroom unknown: no scored run of the current ${opts.agent} for the train case(s) ${unmeasured.join(', ')}; the baseline measures them`)
  else if (trainMean !== null && trainMean >= 0.9) console.log(`  ⚠ train mean of the last scores is ${trainMean.toFixed(3)} >= 0.9: little headroom, the run would stop right after the baseline (~$${(trainEst + holdEst).toFixed(2)}) as stopped-no-headroom if it measures the same`)
  for (const name of [...opts.train, ...opts.holdout]) if (summaries[name].runs > 0 && summaries[name].failures === summaries[name].runs) console.log(`  ⚠ ${name}: every recorded run is W- (a harness failure): it would stop the run as stopped-eval-failed; pick another case`)
  console.log(`  editor: ${opts.editorModel}, per call $${opts.editorBudget}; argv: claude ${editorArgs({ prompt: '<prompt>', model: opts.editorModel, budget: opts.editorBudget, agent: opts.agent, repo: ROOT, resultsDir: RESULTS_DIR }).join(' ')}`)
  process.exit(0)
}

// The temp worktree is made from HEAD and runs ITS scripts/eval.mjs on ITS plugin and cases: an uncommitted change in the plugin, the harness or the cases would not be in it, and the baseline
// would silently measure something else (a stale eval.mjs without EVAL_LEDGER would even write its rows into the worktree's own ledger, deleted at the end, and the paid runs would go uncounted).
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'scripts', 'evals/cases', 'evals/pending', 'plugins'], { cwd: ROOT, encoding: 'utf8' }).trim()
if (dirty && !opts.resume) fail(`uncommitted changes in scripts/, evals/cases/, evals/pending/ or plugins/; the hill-climb starts from HEAD, commit them first:\n${dirty}`)
const headEvalLib = execFileSync('git', ['show', 'HEAD:scripts/eval-lib.mjs'], { cwd: ROOT, encoding: 'utf8' })
if (!headEvalLib.includes('EVAL_LEDGER')) fail("HEAD's scripts/eval-lib.mjs has no EVAL_LEDGER: the worktree's evals would write their ledger rows into the worktree and not here; commit the tooling first")

const evaluator = makeEvaluator({ repo: ROOT, run: opts.run, runs: opts.runs, jobs: opts.jobs, budgetUsd: opts.budgetUsd, budgetSince: opts.budgetSince, capUsd: opts.capUsd, ledgerPath: LEDGER, resultsDir: RESULTS_DIR })
const editor = makeEditor({ repo: ROOT, run: opts.run, model: opts.editorModel, budget: opts.editorBudget, ledgerPath: LEDGER, resultsDir: RESULTS_DIR, claudeBin: opts.claudeBin })
console.log(`hillclimb ${opts.run}: ${opts.agent}, train ${opts.train.length} / holdout ${opts.holdout.length} cases, cap $${opts.capUsd}`)
try {
  const result = await climb({ ...opts, repo: ROOT, ledgerPath: LEDGER }, { evaluator, editor, log: (line) => console.log(line) })
  const kept = result.rows.filter((row) => row.decision === 'kept').length
  console.log(`\n✔ ${result.stopped}: ${kept} edit(s) kept on branch ${result.branch}; log ${decisionPath(ROOT, opts.run)}`)
} catch (error) {
  console.error(`✘ ${error.message}`)
  process.exit(1)
}
