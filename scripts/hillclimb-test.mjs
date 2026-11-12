/**
 * Free self-test of scripts/hillclimb.mjs (`node scripts/hillclimb.mjs --self-test`, run by validate.mjs): the real loop in a temp git repo with a stub editor and a scripted
 * evaluator; the real editor and evaluator code paths against stub executables. No `claude`, no model.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { alive } from '../plugins/stage-pipeline/scripts/processes.mjs'
import { INVOCATION_RE, appendLedger, readLedger, sessionEnv } from './eval-lib.mjs'
import { assertNoLiveEvalChildren, caseLedgerSummary, chargeInflight, climb, climbLabel, DEFAULT_HOLDOUT, DEFAULT_TRAIN, identityArgs, decisionPath, editorArgs, editorEnv, inflightDir, makeEditor, markInflight, makeEvaluator, median, missExcerpts, parseDecision, resumedHoldout, resumedTrain, runScore, spentByRun, splitMean } from './hillclimb-lib.mjs'

const INV = '20261030T000000'
const AGENT = 'pro-review'
const REF = `plugins/stage-pipeline/skills/${AGENT}/references/a.md`
const AGENT_FILE = `plugins/stage-pipeline/agents/${AGENT}.md`
const TRAIN = ['t1', 't2']
const HOLD = ['h1']

const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const put = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

/** `identity: false`: no user.name/email anywhere (the repo's own config, the init commit's -c flags only), `user.useConfigOnly=true`: a runner with no git identity. */
function makeRepo({ identity = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hct-'))
  git(root, 'init', '-q', '-b', 'main')
  if (identity) {
    git(root, 'config', 'user.name', 'Test')
    git(root, 'config', 'user.email', 't@example.test')
  } else git(root, 'config', 'user.useConfigOnly', 'true')
  put(root, AGENT_FILE, '---\nname: pro-review\nmodel: sonnet\n---\n\nBody of the agent.\n')
  put(root, REF, 'method\n')
  put(root, `plugins/stage-pipeline/skills/${AGENT}/SKILL.md`, 'skill\n')
  put(root, 'README.md', 'readme\n')
  git(root, 'add', '-A')
  execFileSync('git', ['-c', 'user.name=Init', '-c', 'user.email=i@example.test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: root, stdio: 'ignore' })
  return root
}

/** A scripted evaluator: the score of a case comes from markers in the references file of the worktree it is asked about ("T+" raises train, "H-" lowers holdout, "t~" is a gain under noise). */
function scripted(log) {
  return {
    async evaluate(worktree, cases, ctx = {}) {
      const text = readFileSync(join(worktree, REF), 'utf8')
      log.trees.push(text)
      const count = (token) => text.split(token).length - 1
      const perCase = {}
      for (const name of cases) {
        const score = name.startsWith('t') ? (log.trainBase ?? 0.4) + 0.3 * count('T+') + 0.05 * count('t~') : Math.max(0, 0.5 - 0.4 * count('H-'))
        perCase[name] = { score, scores: [score, score, score], marks: ['N1+'], invocation: `${INV}-${name}` }
      }
      log.calls.push(cases.join('+'))
      // The loop's spend is the ledger's: the evaluator writes its rows the way eval.mjs does (labelled with the run).
      if (ctx.ledgerPath) appendLedger({ ts: new Date().toISOString(), invocation: `scripted-${log.calls.length}`, case: cases.join('+'), plugin_ref: `working-tree+${climbLabel(ctx.run)}`, marks: 'N1+', pass: 1, cost_usd: String(log.evalCost ?? 1) }, ctx.ledgerPath)
      const failed = cases.filter((name) => name === log.failCase).map((name) => `${name}: 1 of 3 runs graded (2 harness failure or ungraded, 0 not run) (exit 1)`)
      for (const name of failed.length ? [log.failCase] : []) delete perCase[name]
      return { perCase, mean: failed.length ? null : splitMean(perCase), cost: log.evalCost ?? 1, failed }
    },
  }
}

const editorWith = (steps, log) => ({
  model: 'opus',
  budget: 0.5,
  async edit({ worktree, attempt, run, ledgerPath, context }) {
    log.edits.push(attempt)
    ;(log.contexts ??= []).push(context)
    const step = steps.shift()
    if (step && ledgerPath) appendLedger({ ts: new Date().toISOString(), invocation: `hillclimb-${run}`, case: 'hillclimb-editor', plugin_ref: climbLabel(run), marks: 'edit', pass: 1, cost_usd: String(step.cost ?? 0.5) }, ledgerPath)
    return step ? { ok: true, cost: step.cost ?? 0.5, summary: step.summary, ...(step.run(worktree), {}) } : { ok: false, cost: 0, summary: 'no more steps' }
  },
})
const append = (file, text) => (worktree) => put(worktree, file, readFileSync(join(worktree, file), 'utf8') + text)
const step = (summary, run, cost) => ({ summary, run, cost })

function cfgFor(repo, run, extra = {}) {
  return { repo, run, agent: AGENT, train: TRAIN, holdout: HOLD, runs: 3, maxIterations: 5, minAttempts: 1, target: 2, capUsd: 100, ledgerPath: join(repo, 'evals/ledger.tsv'), editorModel: 'opus', editorBudget: 0.5, ...extra }
}
/**
 * Removes the temp dirs of the self-test. `repos` are dirs this test made with `git init` (they carry their own `.git`): their worktree registrations are pruned with `--git-dir` of
 * their own, never from a cwd that could resolve to an enclosing repo. `scratch` dirs (not repos) are only removed: a `git worktree prune` run from one, with TMPDIR inside a git work tree,
 * would prune that enclosing repo's registrations.
 */
export function cleanupTemp({ repos = [], scratch = [] }) {
  for (const dir of repos) {
    if (existsSync(join(dir, '.git'))) {
      try {
        execFileSync('git', ['--git-dir', join(dir, '.git'), 'worktree', 'prune'], { stdio: 'ignore' })
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
}
const decisions = (repo, run) => parseDecision(readFileSync(decisionPath(repo, run), 'utf8')).rows

export async function selfTest() {
  const problems = []
  let checks = 0
  const check = (ok, message) => {
    checks++
    if (!ok) problems.push(message)
  }
  const cleanups = []
  const scratch = []
  const repoFor = () => {
    const repo = makeRepo()
    cleanups.push(repo)
    return repo
  }
  try {
    // metric
    check(Math.abs(runScore('N1+ N2- F1+ S1- M1+') - (0.5 - 1 / 3)) < 1e-9, 'metric: positive hit share minus violated negative share')
    check(runScore('E1+ F1+') === 1 && runScore('E1- F1-') === -1, 'metric: a full run is 1, a worst run is -1')
    check(runScore('N1+ W-') === null && runScore('D1+') === null, 'metric: a harness failure and a run without graders have no score')
    check(median([1, 0.2, 0.6]) === 0.6 && median([0, 1]) === 0.5, 'metric: median of an odd and an even count')

    // 1. a kept edit is committed with its row; the starting checkout is untouched; the temp worktree is gone, the branch stays
    {
      const repo = repoFor()
      const head = git(repo, 'rev-parse', 'HEAD').trim()
      const log = { trees: [], calls: [], edits: [] }
      const result = await climb(cfgFor(repo, 'kept', { maxIterations: 1 }), { evaluator: scripted(log), editor: editorWith([step('add a lens', append(REF, 'T+\n'))], log) })
      const rows = decisions(repo, 'kept')
      check(rows[0]?.kind === 'baseline' && rows[1]?.decision === 'kept' && rows[2]?.decision === 'stopped-max-iterations', `kept: rows should be baseline, kept, stop; got ${rows.map((row) => row.decision)}`)
      const branchHead = git(repo, 'rev-parse', 'hillclimb/kept').trim()
      check(rows[1]?.commit === branchHead && branchHead !== head, 'kept: the commit sha of the row is the branch tip, past the base')
      const message = git(repo, 'log', '-1', '--format=%B', 'hillclimb/kept')
      check(message.includes('\tkept\t') && message.includes('add a lens'), 'kept: the commit message carries the decision.tsv row')
      check(git(repo, 'rev-parse', 'HEAD').trim() === head && readFileSync(join(repo, REF), 'utf8') === 'method\n' && !git(repo, 'status', '--porcelain', '--untracked-files=all').split('\n').filter((line) => line && !/ evals\//.test(line)).length, 'kept: the starting checkout was not edited')
      check(!git(repo, 'worktree', 'list').includes('hc-'), 'kept: the temp worktree is removed')
      check(/^# metric:/m.test(readFileSync(decisionPath(repo, 'kept'), 'utf8')) && /^# keep: train mean/m.test(readFileSync(decisionPath(repo, 'kept'), 'utf8')), 'kept: the header carries the metric and thresholds')
      check(result.stopped === 'stopped-max-iterations', 'kept: the stop reason is returned')
    }

    // 2. train not past noise → rejected and undone (the next attempt sees the original file)
    {
      const repo = repoFor()
      const log = { trees: [], calls: [], edits: [] }
      await climb(cfgFor(repo, 'noise', { maxIterations: 2 }), { evaluator: scripted(log), editor: editorWith([step('tiny gain', append(REF, 't~\n')), step('second', append(REF, 'x\n'))], log) })
      const rows = decisions(repo, 'noise')
      check(rows[1]?.decision === 'rejected-train' && rows[1].holdout_mean === '', `noise: a gain under 0.1 should be rejected-train with no holdout run; got ${rows[1]?.decision}`)
      check(!log.trees.slice(3).some((text) => text.includes('t~')), 'noise: the rejected edit was still in the tree of the next evaluation')
      check(git(repo, 'rev-parse', 'hillclimb/noise').trim() === git(repo, 'rev-parse', 'HEAD').trim(), 'noise: nothing was committed')
    }

    // 3. holdout drop → rejected and undone
    {
      const repo = repoFor()
      const log = { trees: [], calls: [], edits: [] }
      await climb(cfgFor(repo, 'drop', { maxIterations: 2 }), { evaluator: scripted(log), editor: editorWith([step('overfit', append(REF, 'T+\nH-\n')), step('second', append(REF, 'x\n'))], log) })
      const rows = decisions(repo, 'drop')
      check(rows[1]?.decision === 'rejected-holdout', `holdout: a holdout drop should be rejected-holdout; got ${rows[1]?.decision}`)
      check(rows[1]?.train_mean !== '' && rows[1]?.holdout_mean !== '', 'holdout: the row carries both scores')
      check(!log.trees.slice(4).some((text) => text.includes('H-')), 'holdout: the rejected edit was still in the tree afterwards')
    }

    // 4. out of bounds: a file outside, a frontmatter change, a created file; a body edit of the agent file passes the bounds
    {
      const repo = repoFor()
      const log = { trees: [], calls: [], edits: [] }
      const steps = [
        step('touch readme', (worktree) => put(worktree, 'README.md', 'changed\n')),
        step('frontmatter', (worktree) => put(worktree, AGENT_FILE, readFileSync(join(worktree, AGENT_FILE), 'utf8').replace('model: sonnet', 'model: opus'))),
        step('new file', (worktree) => put(worktree, 'plugins/stage-pipeline/skills/pro-review/NEW.md', 'new\n')),
        step('body only', (worktree) => put(worktree, AGENT_FILE, readFileSync(join(worktree, AGENT_FILE), 'utf8').replace('Body of the agent.', 'Body of the agent, sharper.'))),
      ]
      await climb(cfgFor(repo, 'bounds', { maxIterations: 4 }), { evaluator: scripted(log), editor: editorWith(steps, log) })
      const rows = decisions(repo, 'bounds')
      check(rows.slice(1, 4).every((row) => row.decision === 'rejected-bounds'), `bounds: outside file, frontmatter and created file should all be rejected-bounds; got ${rows.slice(1, 4).map((row) => row.decision)}`)
      check(rows[1]?.summary.includes('README.md') && rows[2]?.summary.includes('frontmatter') && rows[3]?.summary.includes('NEW.md'), 'bounds: the row names what was out of bounds')
      check(log.calls.length === 2 + 1, `bounds: only the baseline (2 calls) and the in-bounds edit's train should have run an evaluation, got ${log.calls.length}`)
      check(rows[4]?.decision === 'rejected-train', 'bounds: the body-only edit passes the bounds and goes on to the train eval')
      // undone by path: the starting HEAD of the branch has the original files
      const tip = git(repo, 'rev-parse', 'hillclimb/bounds').trim()
      check(git(repo, 'show', `${tip}:README.md`) === 'readme\n' && !/NEW\.md/.test(git(repo, 'ls-tree', '-r', '--name-only', tip)), 'bounds: the branch carries none of the rejected edits')
    }

    // 5. the cap stops before passing: the estimate of the next call counts, not only the money already spent. m-6: the editor is not paid when the train and holdout evals that would judge its edit cannot fit
    {
      const repo = repoFor()
      const log = { trees: [], calls: [], edits: [], evalCost: 1 }
      // baseline: estimates 0.5 per case-run (no ledger) x 3 runs x 3 cases = 4.5; spent 2 (scripted). Editor 0.5 + train 3.0 + holdout 1.5 = 5.0 on top of 2 would pass 5.0 → stop BEFORE the editor call.
      const result = await climb(cfgFor(repo, 'cap', { capUsd: 5, maxIterations: 5 }), { evaluator: scripted(log), editor: editorWith([step('lens', append(REF, 'T+\n')), step('second', append(REF, 'T+\n'))], log) })
      const rows = decisions(repo, 'cap')
      const last = rows.at(-1)
      check(result.stopped === 'stopped-cap' && last.decision === 'stopped-cap', `cap: the last row should be stopped-cap; got ${last?.decision}`)
      check(Number(last.cumulative_usd) <= 5 && log.calls.length === 2, `cap: the spend ${last?.cumulative_usd} must stay under the cap and no evaluation may start past it (calls ${log.calls.length})`)
      check(log.edits.length === 0 && Number(last.cumulative_usd) === 2, `m-6 incident: the editor must not be called when its train and holdout evals cannot fit under the cap; editor calls ${log.edits.length}, spent ${last?.cumulative_usd}`)
      check(!readFileSync(join(repo, REF), 'utf8').includes('T+') && git(repo, 'rev-parse', 'hillclimb/cap').trim() === git(repo, 'rev-parse', 'HEAD').trim(), 'cap: nothing was edited or committed')
      // legitimate: with room for editor + train + holdout (2 + 6.5 <= 12) the editor is called and its edit is judged
      const roomy = repoFor()
      const log2 = { trees: [], calls: [], edits: [], evalCost: 1 }
      await climb(cfgFor(roomy, 'roomy', { capUsd: 12, maxIterations: 1 }), { evaluator: scripted(log2), editor: editorWith([step('lens', append(REF, 'T+\n'))], log2) })
      check(log2.edits.length === 1 && decisions(roomy, 'roomy').some((row) => row.decision === 'kept'), `m-6 legitimate: with room for editor, train and holdout the edit runs and is kept; edits ${log2.edits.length}`)
    }

    // 6. the stop predicate: the target AND the minimum of attempts
    {
      const repo = repoFor()
      const log = { trees: [], calls: [], edits: [] }
      // baseline train mean 0.4 >= target 0.3 from the start, but 2 attempts must run first
      const result = await climb(cfgFor(repo, 'pred', { target: 0.3, minAttempts: 2, maxIterations: 6 }), { evaluator: scripted(log), editor: editorWith([step('a', append(REF, 'x\n')), step('b', append(REF, 'x\n')), step('c', append(REF, 'x\n'))], log) })
      const rows = decisions(repo, 'pred')
      check(result.stopped === 'stopped-target' && rows.filter((row) => row.kind === 'attempt').length === 2, `predicate: target met at the baseline must still run 2 attempts, then stop; got ${rows.filter((row) => row.kind === 'attempt').length} attempts, ${result.stopped}`)
      const repo2 = repoFor()
      const result2 = await climb(cfgFor(repo2, 'pred2', { target: 5, minAttempts: 1, maxIterations: 2 }), { evaluator: scripted({ trees: [], calls: [], edits: [] }), editor: editorWith([step('a', append(REF, 'x\n')), step('b', append(REF, 'x\n'))], { edits: [] }) })
      check(result2.stopped === 'stopped-max-iterations', `predicate: an unmet target stops at the maximum of iterations; got ${result2.stopped}`)
    }

    // 7. resume: numbering continues, no second baseline, the branch continues from the kept commit
    {
      const repo = repoFor()
      const log = { trees: [], calls: [], edits: [] }
      await climb(cfgFor(repo, 'res', { maxIterations: 1 }), { evaluator: scripted(log), editor: editorWith([step('first', append(REF, 'T+\n'))], log) })
      const callsBefore = log.calls.length
      await climb(cfgFor(repo, 'res', { maxIterations: 2, resume: true }), { evaluator: scripted(log), editor: editorWith([step('second', append(REF, 'T+\n'))], log) })
      const rows = decisions(repo, 'res')
      check(rows.filter((row) => row.kind === 'baseline').length === 1, 'resume: a second baseline row was written')
      check(rows.filter((row) => row.kind === 'attempt').map((row) => row.attempt).join() === '1,2', `resume: attempts should continue 1,2; got ${rows.filter((row) => row.kind === 'attempt').map((row) => row.attempt)}`)
      check(log.calls.length === callsBefore + 2, `resume: the second part should run only the train and holdout of its attempt (no baseline); ran ${log.calls.length - callsBefore} evaluations`)
      const count = (text) => text.split('T+').length - 1
      check(count(log.trees[callsBefore] ?? '') === 2, 'resume: the evaluation after the first kept edit should see exactly the kept edit plus the new one')
    }

    // 8. the real editor path with a stub executable: argv, cwd, the JSON read, the ledger row
    {
      const repo = repoFor()
      const stub = join(repo, 'stub-claude.mjs')
      writeFileSync(stub, `import { writeFileSync, appendFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(join(repo, 'argv.json'))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }))
appendFileSync('${REF}', 'T+\\n')
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.42, result: 'I edited the lens.\\nEDIT: lens for stale state' }))
`)
      chmodSync(stub, 0o755)
      writeFileSync(join(repo, 'stub-claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stub)} "$@"\n`)
      chmodSync(join(repo, 'stub-claude'), 0o755)
      const editor = makeEditor({ repo, run: 'ed', model: 'opus', budget: 0.9, ledgerPath: join(repo, 'evals/ledger.tsv'), resultsDir: join(repo, 'evals/.results'), claudeBin: join(repo, 'stub-claude') })
      const log = { trees: [], calls: [], edits: [] }
      await climb(cfgFor(repo, 'ed', { maxIterations: 1 }), { evaluator: scripted(log), editor })
      const seen = JSON.parse(readFileSync(join(repo, 'argv.json'), 'utf8'))
      const has = (...tokens) => tokens.every((token) => seen.argv.includes(token))
      check(has('--model', 'opus', '--max-budget-usd', '0.9', '--output-format', 'json', '--restricted', '--strict-mcp-config', '--no-session-persistence', 'dontAsk'), `editor: argv misses an isolation flag: ${seen.argv.filter((x) => x.startsWith('--')).join(' ')}`)
      const tools = seen.argv[seen.argv.indexOf('--tools') + 1]
      const allowed = seen.argv.slice(seen.argv.indexOf('--allowedTools') + 1, seen.argv.indexOf('--disallowedTools'))
      check(tools === 'Read,Edit,Write,Glob,Grep', `S-1: the toolset (--tools) should be exactly Read,Edit,Write,Glob,Grep; got ${tools}`)
      check(allowed.join() === `Read(./**),Glob(./**),Grep(./**),Edit(./plugins/stage-pipeline/skills/${AGENT}/references/**),Write(./plugins/stage-pipeline/skills/${AGENT}/references/**),Edit(./plugins/stage-pipeline/agents/${AGENT}.md)`, `S-1: path-scoped allow rules expected; got ${allowed}`)
      check(/hc-/.test(seen.cwd) && !seen.cwd.startsWith(repo), 'editor: the call must run in the temp worktree, not in the starting checkout')
      const ledger = readFileSync(join(repo, 'evals/ledger.tsv'), 'utf8')
      check(ledger.includes('hillclimb-editor') && ledger.includes('0.4200'), 'editor: its call was not appended to the ledger with its cost')
      const rows = decisions(repo, 'ed')
      check(rows[1]?.summary === 'lens for stale state' && Number(rows[1].cost_usd) >= 0.42, `editor: the EDIT line and the cost should reach the row; got ${rows[1]?.summary} ${rows[1]?.cost_usd}`)
      check(editorArgs({ prompt: 'p', model: 'opus', budget: 1 }).includes('--no-session-persistence'), 'editor: editorArgs')
      // S-1 (VT-13): --restricted ends the auto-memory exemption of the working-directory blocks; project settings are not read under it, so nothing may depend on --setting-sources; the env switches auto-memory off
      check(seen.argv.includes('--restricted') && !seen.argv.includes('--setting-sources'), `S-1: the editor argv needs --restricted and no --setting-sources; got ${seen.argv.filter((x) => x.startsWith('--')).join(' ')}`)
      check(seen.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1' && seen.env?.PATH === process.env.PATH, `S-1: the editor process must get CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 on top of the driver's env; got ${seen.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY} PATH ${seen.env?.PATH === process.env.PATH}`)
      check(editorEnv({ A: 'b', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }).CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1' && editorEnv({ A: 'b' }).A === 'b', 'S-1: editorEnv forces the switch on and keeps the rest')
    }

    // 10. a failed baseline: the row names the case, no editor call is made, and --resume refuses it (its empty scores would read as 0)
    {
      const repo = repoFor()
      const log = { trees: [], calls: [], edits: [], failCase: 't1' }
      const result = await climb(cfgFor(repo, 'bad'), { evaluator: scripted(log), editor: editorWith([step('a', append(REF, 'T+\n'))], log) })
      const rows = decisions(repo, 'bad')
      check(result.stopped === 'stopped-eval-failed' && rows.length === 1 && rows[0].kind === 'baseline' && rows[0].decision === 'stopped-eval-failed' && rows[0].summary.includes('t1:'), `failed baseline: one baseline row, stopped-eval-failed, naming t1; got ${rows.map((row) => `${row.decision} ${row.summary}`)}`)
      check(log.edits.length === 0 && !log.calls.some((call) => call.includes('h1')), 'failed baseline: no editor call, and no holdout runs paid for after a failed train split')
      let message = ''
      try {
        await climb(cfgFor(repo, 'bad', { resume: true }), { evaluator: scripted(log), editor: editorWith([step('a', append(REF, 'T+\n'))], log) })
      } catch (error) {
        message = error.message
      }
      check(/baseline failed/.test(message) && /start a new run/.test(message) && log.edits.length === 0, `failed baseline: --resume must refuse with «baseline failed … start a new run»; got «${message}»`)
    }

    // 11. no headroom: the train mean is so high that best + 0.1 passes 1 — stop right after the baseline, before any editor call
    {
      const repo = repoFor()
      const log = { trees: [], calls: [], edits: [], trainBase: 0.95 }
      const result = await climb(cfgFor(repo, 'sat', { minAttempts: 3, target: 5 }), { evaluator: scripted(log), editor: editorWith([step('a', append(REF, 'x\n'))], log) })
      const rows = decisions(repo, 'sat')
      check(result.stopped === 'stopped-no-headroom' && rows.length === 2 && rows[1].decision === 'stopped-no-headroom' && log.edits.length === 0, `no headroom: baseline row then a stopped-no-headroom row, no editor call; got ${rows.map((row) => row.decision)} edits ${log.edits.length}`)
      const log2 = { trees: [], calls: [], edits: [], trainBase: 0.9 }
      const result2 = await climb(cfgFor(repoFor(), 'edge', { maxIterations: 1, target: 5 }), { evaluator: scripted(log2), editor: editorWith([step('a', append(REF, 'x\n'))], log2) })
      check(result2.stopped === 'stopped-max-iterations' && log2.edits.length === 1, `no headroom: a baseline of 0.9 still has room for exactly +0.1; got ${result2.stopped}`)
    }

    // 12. the spend is the ledger's: an editor that times out or reports no cost is charged its --max-budget-usd, and a resumed run re-reads what the first part spent
    {
      const repo = repoFor()
      const hang = join(repo, 'hang-claude')
      writeFileSync(hang, '#!/bin/sh\nexec sleep 5\n')
      chmodSync(hang, 0o755)
      const nocost = join(repo, 'nocost-claude')
      writeFileSync(nocost, `#!/bin/sh\necho '{"type":"result","is_error":false,"result":"EDIT: nothing"}'\n`)
      chmodSync(nocost, 0o755)
      const ledgerPath = join(repo, 'evals/ledger.tsv')
      const log = { trees: [], calls: [], edits: [], evalCost: 0.2 }
      const editorOf = (bin, timeoutSec) => makeEditor({ repo, run: 'sp', model: 'opus', budget: 0.9, ledgerPath, resultsDir: join(repo, 'evals/.results'), claudeBin: bin, timeoutSec })
      await climb(cfgFor(repo, 'sp', { maxIterations: 1 }), { evaluator: scripted(log), editor: editorOf(hang, 1) })
      const editorRows = readLedger(ledgerPath).filter((row) => row.case === 'hillclimb-editor')
      check(editorRows.length === 1 && editorRows[0].cost_usd === '0.9000', `spend: a timed-out editor call must be charged its budget in the ledger; got ${editorRows.map((row) => row.cost_usd)}`)
      const first = decisions(repo, 'sp')
      check(Math.abs(Number(first.at(-1).cumulative_usd) - (0.4 + 0.9)) < 1e-6, `spend: the stop row's cumulative is the ledger sum of the run (0.4 evals + 0.9 editor); got ${first.at(-1).cumulative_usd}`)
      await climb(cfgFor(repo, 'sp', { maxIterations: 2, resume: true }), { evaluator: scripted(log), editor: editorOf(nocost, 5) })
      const all = readLedger(ledgerPath).filter((row) => row.case === 'hillclimb-editor').map((row) => row.cost_usd)
      check(all.length === 2 && all[1] === '0.9000', `spend: an editor that reports no cost is charged its budget; got ${all}`)
      const after = decisions(repo, 'sp')
      check(Math.abs(Number(after.at(-1).cumulative_usd) - spentByRun(readLedger(ledgerPath), 'sp')) < 1e-6 && Number(after.at(-1).cumulative_usd) >= 0.4 + 0.9 + 0.9, `spend: a resumed run re-reads its spend from the ledger (first part included); got ${after.at(-1).cumulative_usd}`)
    }

    // 13. no git identity anywhere (no global config, user.useConfigOnly): the kept-edit commit still works, under a neutral identity; with an identity of its own the checkout's wins
    {
      const saved = Object.fromEntries(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL'].map((key) => [key, process.env[key]]))
      try {
        Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
        for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[key]
        const bare = makeRepo({ identity: false })
        cleanups.push(bare)
        const log = { trees: [], calls: [], edits: [] }
        await climb(cfgFor(bare, 'noid', { maxIterations: 1 }), { evaluator: scripted(log), editor: editorWith([step('lens', append(REF, 'T+\n'))], log) })
        const rows = decisions(bare, 'noid')
        check(rows[1]?.decision === 'kept' && git(bare, 'log', '-1', '--format=%an <%ae> / %cn', 'hillclimb/noid').trim() === 'hillclimb <hillclimb@localhost> / hillclimb', `identity: with no git identity the kept edit is committed as hillclimb; got ${rows[1]?.decision} ${git(bare, 'log', '-1', '--format=%an <%ae>', 'hillclimb/noid').trim()}`)
        const own = repoFor()
        await climb(cfgFor(own, 'ownid', { maxIterations: 1 }), { evaluator: scripted({ trees: [], calls: [], edits: [] }), editor: editorWith([step('lens', append(REF, 'T+\n'))], { edits: [] }) })
        check(git(own, 'log', '-1', '--format=%an <%ae>', 'hillclimb/ownid').trim() === 'Test <t@example.test>', 'identity: the checkout\'s own user.name/email is used when it has one')
        check(identityArgs(own).join(' ') === '-c user.name=Test -c user.email=t@example.test' && identityArgs(bare).join(' ') === '-c user.name=hillclimb -c user.email=hillclimb@localhost', 'identity: identityArgs reads the checkout, else the neutral identity')
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    }

    // 14. the default split, and what the dry run reads from the ledger
    {
      check(DEFAULT_TRAIN.join() === 'pro-review-recall-logic,pro-review-recall-parity,pro-review-language-en' && DEFAULT_HOLDOUT.join() === 'pro-review-clean-ac,pro-review-language-ru', `defaults: the train drops cross-stage-dup; got ${DEFAULT_TRAIN} / ${DEFAULT_HOLDOUT}`)
      const row = (fields) => ({ ts: '2026-10-30T10:00:00Z', invocation: 'i', case: 'c', marks: 'E1+ N1+', plugin_ref: 'working-tree', plugin_version: '0.23.0', plugin_sha: 'aaa1111', ...fields })
      const summary = caseLedgerSummary([row({ invocation: 'old', marks: 'E1-' }), row({ ts: '2026-10-31T10:00:00Z', invocation: 'new', marks: 'E1+ N1-' }), row({ ts: '2026-10-31T10:00:00Z', invocation: 'new', marks: 'W-' }), row({ case: 'other' })], 'c')
      check(summary.runs === 3 && summary.failures === 1 && summary.score === 0.5 && summary.marks === 'E1+ N1- | W-', `dry run: per case the runs, the W- count and the last invocation's score and marks; got ${JSON.stringify(summary)}`)
      const allW = caseLedgerSummary([row({ marks: 'W-' }), row({ marks: 'W-' })], 'c')
      check(allW.runs === 2 && allW.failures === 2 && allW.score === null, 'dry run: a case whose runs are all W- shows no score')
      // M-4 incident: the only rows are an older plugin's, a hill-climb candidate's, an effort run's and a dirty sha's, all scoring 1.0: none of them is the current agent's score
      const stale = [row({ plugin_version: '0.18.1', marks: 'E1+ N1+ F1+' }), row({ plugin_ref: 'working-tree+hillclimb:x', marks: 'E1+ N1+ F1+' }), row({ plugin_ref: 'working-tree+effort:pro-review=low', marks: 'E1+ N1+ F1+' }), row({ plugin_ref: 'v0.22.0', marks: 'E1+ N1+ F1+' }), row({ plugin_sha: 'aaa1111+dirty', marks: 'E1+ N1+ F1+' })]
      const treeOf = (sha) => (sha === 'aaa1111' ? 'T1' : 'T0')
      const none = caseLedgerSummary(stale, 'c', { version: '0.23.0', treeOf, agentTree: 'T1' })
      check(none.runs === 0 && none.score === null && none.excluded === 5, `M-4 incident: rows of another plugin, label, ref or a dirty sha must not give a score; got ${JSON.stringify(none)}`)
      // legitimate: a clean working-tree row at the current version whose agent bytes are HEAD's counts, one whose agent bytes differ does not
      const good = caseLedgerSummary([...stale, row({ ts: '2026-10-29T10:00:00Z', marks: 'E1+ N1-' }), row({ ts: '2026-10-30T11:00:00Z', plugin_sha: 'bbb2222', marks: 'E1+ N1+' })], 'c', { version: '0.23.0', treeOf, agentTree: 'T1' })
      check(good.runs === 1 && good.score === 0.5 && good.marks === 'E1+ N1-', `M-4 legitimate: the row of the current agent counts, a changed agent tree does not; got ${JSON.stringify(good)}`)
      check(good.sha === 'aaa1111' && good.version === '0.23.0' && good.excluded === 6, `M-4 legitimate: the summary names the row used (sha, version); got ${JSON.stringify(good)}`)
    }

    // 15. a run killed by SIGKILL leaves its temp worktree on hillclimb/<run>: --resume clears it (ours only); SIGHUP is handled like SIGTERM
    {
      const repo = repoFor()
      const child = join(repo, 'child.mjs')
      writeFileSync(child, `import { climb } from ${JSON.stringify(new URL('./hillclimb-lib.mjs', import.meta.url).href)}
const [repo, run] = process.argv.slice(2)
const evaluator = { async evaluate(wt, cases) { return { perCase: Object.fromEntries(cases.map((name) => [name, { score: 0.4, scores: [0.4], marks: [], invocation: '20261030T000000-' + name }])), mean: 0.4, cost: 0, failed: [] } } }
const editor = { model: 'opus', budget: 0.5, edit: async () => { console.log('ready'); setInterval(() => {}, 1000); await new Promise(() => {}) } }
await climb({ repo, run, agent: 'pro-review', train: ['t1', 't2'], holdout: ['h1'], runs: 1, maxIterations: 1, minAttempts: 1, target: 2, capUsd: 100, ledgerPath: repo + '/evals/ledger.tsv', editorModel: 'opus', editorBudget: 0.5 }, { evaluator, editor })
`)
      const start = (run, signal) => new Promise((resolveStart) => {
        const proc = spawn(process.execPath, [child, repo, run], { stdio: ['ignore', 'pipe', 'inherit'] })
        const timer = setTimeout(() => proc.kill('SIGKILL'), 30000)
        proc.stdout.on('data', (chunk) => {
          if (String(chunk).includes('ready')) proc.kill(signal)
        })
        proc.on('close', (code, sig) => {
          clearTimeout(timer)
          resolveStart({ code, sig })
        })
      })
      const hup = await start('hup', 'SIGHUP')
      check(hup.code === 130 && !git(repo, 'worktree', 'list').includes('hc-'), `signals: SIGHUP removes the temp worktree and exits 130; got ${JSON.stringify(hup)} ${git(repo, 'worktree', 'list')}`)
      const killed = await start('kill', 'SIGKILL')
      check(killed.sig === 'SIGKILL' && git(repo, 'worktree', 'list').includes('hc-'), `signals: a SIGKILL leaves the temp worktree registered (the case --resume must handle); got ${JSON.stringify(killed)}`)
      const stale = git(repo, 'worktree', 'list', '--porcelain').split('\n').find((line) => line.startsWith('worktree ') && line.includes('hc-'))?.slice(9)
      const log = { trees: [], calls: [], edits: [] }
      let message = ''
      try {
        await climb(cfgFor(repo, 'kill', { maxIterations: 1, resume: true }), { evaluator: scripted(log), editor: editorWith([step('lens', append(REF, 'T+\n'))], log) })
      } catch (error) {
        message = error.message
      }
      check(!message && stale && !existsSync(stale) && !git(repo, 'worktree', 'list').includes('hc-') && decisions(repo, 'kill').at(-1).decision.startsWith('stopped-'), `resume: the worktree a killed run left is removed and the resume goes on; got «${message}» ${stale}`)
      // a worktree on the branch that is not ours is never removed
      git(repo, 'branch', 'hillclimb/foreign', 'HEAD')
      const foreign = join(mkdtempSync(join(tmpdir(), 'other-')), 'wt')
      git(repo, 'worktree', 'add', foreign, 'hillclimb/foreign')
      writeFileSync(join(repo, 'evals/hillclimb/kill/decision.tsv'), readFileSync(join(repo, 'evals/hillclimb/kill/decision.tsv'), 'utf8'))
      mkdirSync(join(repo, 'evals/hillclimb/foreign'), { recursive: true })
      writeFileSync(join(repo, 'evals/hillclimb/foreign/decision.tsv'), readFileSync(join(repo, 'evals/hillclimb/kill/decision.tsv'), 'utf8'))
      message = ''
      try {
        await climb(cfgFor(repo, 'foreign', { maxIterations: 1, resume: true }), { evaluator: scripted(log), editor: editorWith([], log) })
      } catch (error) {
        message = error.message
      }
      check(/not a hill-climb temp worktree/.test(message) && existsSync(foreign), `resume: a worktree on the branch outside the temp dir is not removed; got «${message}»`)
      rmSync(dirname(foreign), { recursive: true, force: true })
      git(repo, 'worktree', 'prune')
    }

    // 16. after a resume the editor still sees the misses of the train cases, rebuilt from evals/.results/<invocation>/ (ids stored in the decision row); no files → «details unavailable after resume»
    {
      const repo = repoFor()
      const log = { trees: [], calls: [], edits: [] }
      await climb(cfgFor(repo, 'det', { maxIterations: 1 }), { evaluator: scripted(log), editor: editorWith([step('lens', append(REF, 'T+\n'))], log) })
      const kept = decisions(repo, 'det')[1]
      check(kept.train_invocations === `t1=${INV}-t1;t2=${INV}-t2`, `resume details: the kept row stores the invocation ids; got ${kept.train_invocations}`)
      mkdirSync(join(repo, `evals/.results/${INV}-t1`), { recursive: true })
      writeFileSync(join(repo, `evals/.results/${INV}-t1/t1--1.md`), '# t1\n\n## Failures\n\n- expected the stale-state finding\n\n## Final message of the subagent\n\nreported nothing\n')
      await climb(cfgFor(repo, 'det', { maxIterations: 2, resume: true }), { evaluator: scripted(log), editor: editorWith([step('second', append(REF, 'x\n'))], log) })
      const context = log.contexts.at(-1)
      const text = missExcerpts(context.train, join(repo, 'evals/.results'))
      check(/### t1 — score 0\.700/.test(text) && text.includes('expected the stale-state finding') && !/t1[\s\S]*every run passed every grader[\s\S]*### t2/.test(text), `resume details: the failure text of t1 is rebuilt from evals/.results; got\n${text}`)
      check(/### t2 [\s\S]*\(details unavailable after resume\)/.test(text) && !/every run passed every grader/.test(text), `resume details: a case with no results on disk says so instead of «every run passed»; got\n${text}`)
    }

    // 9. the real evaluator path with a stub eval.mjs: args, env, parallel jobs, scores from the ledger marks
    {
      const repo = repoFor()
      put(repo, 'scripts/eval.mjs', `import { appendFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const name = args.at(-1)
const runs = Number(args[args.indexOf('--runs') + 1])
const inv = args[args.indexOf('--invocation') + 1]
const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : ''
for (let i = 1; i <= (name === 'f1' ? runs - 1 : runs); i++) appendFileSync(process.env.EVAL_LEDGER, ['ts', inv, name, i, label ? 'working-tree+' + label : 'working-tree', '0', 'sha', 'v', 'm', name === 'w1' && i === 2 ? 'W-' : i === 3 ? 'E1- N1+ F1+' : 'E1+ N1+ F1+', '1', '0.1000', '1'].join('\\t') + '\\n')
writeFileSync(process.env.EVAL_LEDGER + '.args-' + name, JSON.stringify({ args, results: process.env.EVAL_RESULTS }))
console.log('## working-tree (plugin 0 @ sha, v), runs per case: ' + runs + ', invocation ' + inv)
`)
      const ledgerPath = join(repo, 'evals/ledger.tsv')
      appendLedger({ ts: 't', invocation: 'x', case: 'seed' }, ledgerPath)
      put(repo, 'evals/pending/pp/case.json', '{}')
      put(repo, 'evals/cases/c1/case.json', '{}')
      put(repo, 'evals/pending/c1/case.json', '{}')
      const evaluator = makeEvaluator({ repo, run: 't9', runs: 3, jobs: 2, budgetUsd: 40, budgetSince: '2026-10-30T07:42:03Z', ledgerPath, resultsDir: join(repo, 'evals/.results') })
      const outcome = await evaluator.evaluate(repo, ['c1', 'c2', 'c3'])
      check(Object.keys(outcome.perCase).length === 3 && outcome.failed.length === 0, `evaluator: three cases should be scored; failed ${outcome.failed}`)
      check(outcome.perCase.c1.score === 1 && outcome.perCase.c1.scores.length === 3, 'evaluator: the median of runs scoring 1, 1, 0.5 is 1')
      check(Math.abs(outcome.cost - 0.9) < 1e-9, `evaluator: the cost of the invocation's ledger rows should be 0.9; got ${outcome.cost}`)
      const sent = JSON.parse(readFileSync(`${ledgerPath}.args-c2`, 'utf8'))
      check(sent.args.includes('--budget-usd') && sent.args.includes('--budget-since') && sent.args.includes('2026-10-30T07:42:03Z'), 'evaluator: --budget-usd/--budget-since were not passed through')
      const budgetOf = (name) => Number(JSON.parse(readFileSync(`${ledgerPath}.args-${name}`, 'utf8')).args.at(JSON.parse(readFileSync(`${ledgerPath}.args-${name}`, 'utf8')).args.indexOf('--budget-usd') + 1))
      check(budgetOf('c1') === 40 && budgetOf('c2') === 40, `evaluator: a case started while another runs gets the whole lane budget, the reserve is not taken off twice (c1 ${budgetOf('c1')}, c2 ${budgetOf('c2')})`)
      check(sent.args.includes('--label') && sent.args.includes('hillclimb:t9') && readLedger(ledgerPath).filter((row) => row.case === 'c2').every((row) => row.plugin_ref === 'working-tree+hillclimb:t9'), 'evaluator: its eval runs must carry the label hillclimb:<run> in the ledger')
      check(Math.abs(spentByRun(readLedger(ledgerPath), 't9') - 0.9) < 1e-9, 'evaluator: the spend of the run is the sum of its labelled rows')
      // --pending: only for a name that is under evals/pending/ and not under evals/cases/
      await evaluator.evaluate(repo, ['pp', 'c1'])
      const argsOf = (name) => JSON.parse(readFileSync(`${ledgerPath}.args-${name}`, 'utf8')).args
      check(argsOf('pp').includes('--pending') && !argsOf('c1').includes('--pending'), 'evaluator: a pending-only case is run with --pending, one that is also under evals/cases/ is not')
      // a harness failure in one run, and a case that came back with fewer runs than --runs: failed and named, never scored on what is left
      const partial = await evaluator.evaluate(repo, ['w1', 'f1', 'c3'])
      check(partial.failed.length === 2 && /^w1:/.test(partial.failed[0]) && /^f1:/.test(partial.failed[1]) && partial.mean === null && Object.keys(partial.perCase).join() === 'c3', `evaluator: w1 (a W- run) and f1 (2 of 3 runs) must be failed by name; got ${JSON.stringify(partial.failed)} ${Object.keys(partial.perCase)}`)
      check(sent.results === join(repo, 'evals/.results'), 'evaluator: EVAL_RESULTS did not point at the starting checkout')
      check(runScore('E1- N1+ F1+') === 0.5, 'evaluator: marks of the third run')
      // the cap with --jobs: the estimates of the cases already running are reserved, so the second one does not start
      const repo2 = repoFor()
      put(repo2, 'scripts/eval.mjs', readFileSync(join(repo, 'scripts/eval.mjs'), 'utf8'))
      const ledger2 = join(repo2, 'evals/ledger.tsv')
      appendLedger({ ts: 't', invocation: 'x', case: 'seed' }, ledger2)
      const capped = await makeEvaluator({ repo: repo2, run: 'cap', runs: 3, jobs: 3, capUsd: 2, ledgerPath: ledger2, resultsDir: join(repo2, 'evals/.results') }).evaluate(repo2, ['c1', 'c2', 'c3'])
      check(Boolean(capped.capped) && /c2 not started/.test(capped.capped) && Object.keys(capped.perCase).join() === 'c1' && readLedger(ledger2).filter((row) => row.case !== 'seed').every((row) => row.case === 'c1'), `evaluator: with a cap of $2 and $1.50 reserved by the first case the second must not start; got ${capped.capped} ${Object.keys(capped.perCase)}`)
    }

    // M-1 (VT-13 8a): cases in parallel under a cap with headroom all make every run (the child sees the others' spend in the ledger, the driver must not subtract their reserve too);
    // a child that skips by its own budget is `capped`, not `failed`
    {
      const budgetStub = `import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const name = args.at(-1)
const at = (flag) => args[args.indexOf(flag) + 1]
const runs = Number(at('--runs'))
const budget = Number(at('--budget-usd'))
const since = args.includes('--budget-since') ? at('--budget-since') : ''
let skipped = 0
for (let i = 1; i <= runs; i++) {
  const rows = readFileSync(process.env.EVAL_LEDGER, 'utf8').split('\\n').slice(1).filter(Boolean).map((line) => line.split('\\t'))
  const spent = rows.filter((row) => row[0] >= since).reduce((sum, row) => sum + Number(row[11] || 0), 0)
  if (spent + 2 > budget) {
    console.log('⏭ ' + name + ' #' + i + ' — skipped: $' + spent.toFixed(2) + ' spent + ~$2.00 would pass $' + budget)
    skipped++
    continue
  }
  await new Promise((done) => setTimeout(done, 250))
  appendFileSync(process.env.EVAL_LEDGER, [new Date().toISOString(), at('--invocation'), name, i, 'working-tree+' + at('--label'), '0', 'sha', 'v', 'm', 'E1+ N1+ F1+', '1', '2.0000', '1'].join('\\t') + '\\n')
}
process.exit(skipped ? 3 : 0)
`
      const setup = (capUsd, pastCost = '2.0000') => {
        const repo = repoFor()
        put(repo, 'scripts/eval.mjs', budgetStub)
        const ledgerPath = join(repo, 'evals/ledger.tsv')
        appendLedger({ ts: '2020-01-01T00:00:00Z', invocation: 'x', case: 'seed' }, ledgerPath)
        for (const name of ['c1', 'c2', 'c3']) appendLedger({ ts: '2020-01-01T00:00:00Z', invocation: 'x', case: name, cost_usd: pastCost }, ledgerPath)
        return { repo, ledgerPath, evaluator: makeEvaluator({ repo, run: 'm1', runs: 3, jobs: 3, capUsd, ledgerPath, resultsDir: join(repo, 'evals/.results') }) }
      }
      // estimate $6 per case (3 runs x the $2 past mean), actual $2 per run: $18 in all under the $20 cap. The old limit of the third case was 20 − 12 reserved = 8: its third run was skipped.
      const roomy = setup(20)
      const done = await roomy.evaluator.evaluate(roomy.repo, ['c1', 'c2', 'c3'])
      check(!done.capped && done.failed.length === 0 && Object.keys(done.perCase).length === 3 && readLedger(roomy.ledgerPath).filter((row) => row.plugin_ref === 'working-tree+hillclimb:m1').length === 9, `M-1: three parallel cases with cap headroom must make all 9 runs; got capped ${done.capped}, failed ${JSON.stringify(done.failed)}, ${readLedger(roomy.ledgerPath).filter((row) => row.plugin_ref === 'working-tree+hillclimb:m1').length} rows`)
      // a child that skips by its own budget (a past mean of $1 estimates $3, the runs cost $2 each: the start fits the $5 cap, the third run does not): capped with the reason, not failed
      const tight = setup(5, '1.0000')
      const stopped = await tight.evaluator.evaluate(tight.repo, ['c1'])
      check(Boolean(stopped.capped) && /c1: \d of 3 runs made/.test(stopped.capped) && stopped.failed.length === 0 && stopped.mean === null && !stopped.perCase.c1, `M-1: a child that exits 3 on its budget skip must be capped, not failed; got capped ${stopped.capped}, failed ${JSON.stringify(stopped.failed)}`)
      // m-1 (round 2): run 1 fails a grader, the rest are skipped by the budget, the child exits 1 (as eval.mjs does): still capped, not failed
      const gradeFail = setup(5, '1.0000')
      put(gradeFail.repo, 'scripts/eval.mjs', budgetStub.replace("'E1+ N1+ F1+'", "'E1- N1+ F1+'").replace('process.exit(skipped ? 3 : 0)', 'process.exit(1)'))
      const failedThenSkipped = await gradeFail.evaluator.evaluate(gradeFail.repo, ['c1'])
      check(Boolean(failedThenSkipped.capped) && /c1: \d of 3 runs made/.test(failedThenSkipped.capped) && failedThenSkipped.failed.length === 0, `m-1: a child that exits 1 (a grader failed) and skipped the rest by the budget must be capped, not failed; got capped ${failedThenSkipped.capped}, failed ${JSON.stringify(failedThenSkipped.failed)}`)
    }
    // ── the 14b fixes: each with an incident form (fails without the fix) and a legitimate form ────────────────────────────────────────────────────────────────────────────

    // M-5: a run that fails a grader outside the metric (D1 report saved) is the worst run; an edit that makes runs drop their report is never kept
    {
      check(runScore('D1- F1+ N1+ N2+') === -1 && runScore('D1+ F1- N1+ N2+') === 0 && runScore('L1- E1+') === -1 && runScore('D1+ F1+ N1+ N2+') === 1, 'M-5: a failed grader outside E/N/F/S/M makes the run −1; passing ones do not change the score')
      const marksEvaluator = () => ({
        async evaluate(worktree, cases) {
          const text = readFileSync(join(worktree, REF), 'utf8')
          const marksOf = (name) => (name.startsWith('t') ? (text.includes('DROP') ? 'D1- F1+ N1+ N2+' : text.includes('FIX') ? 'D1+ F1+ N1+ N2+' : 'D1+ F1- N1+ N2+') : 'D1+ E1+ F1+')
          const perCase = Object.fromEntries(cases.map((name) => [name, { scores: [1, 2, 3].map(() => runScore(marksOf(name))), marks: [marksOf(name)], invocation: `${INV}-${name}` }]))
          for (const entry of Object.values(perCase)) entry.score = median(entry.scores)
          return { perCase, mean: splitMean(perCase), cost: 0, failed: [] }
        },
      })
      const repo = repoFor()
      await climb(cfgFor(repo, 'm5', { maxIterations: 2 }), { evaluator: marksEvaluator(), editor: editorWith([step('drop the report', append(REF, 'DROP\n')), step('fix the false finding', append(REF, 'FIX\n'))], { edits: [] }) })
      const rows = decisions(repo, 'm5')
      check(rows[1]?.decision === 'rejected-train' && Number(rows[1].train_mean) === -1, `M-5 incident: an edit whose runs lose D1 must be rejected-train at −1, not kept; got ${rows[1]?.decision} ${rows[1]?.train_mean}`)
      check(rows[2]?.decision === 'kept' && Number(rows[2].train_mean) === 1, `M-5 legitimate: an edit that removes the false finding and keeps the report is kept; got ${rows[2]?.decision} ${rows[2]?.train_mean}`)
      check(/^# metric:.*worst run, -1/m.test(readFileSync(decisionPath(repo, 'm5'), 'utf8')), 'M-5: the decision.tsv header names the rule')
    }

    // M-6: the median of a case outvotes one failed run in three, so the keep rule counts the runs that fail a grader outside the metric apart: an edit that adds one is rejected, whatever the medians do
    {
      const GOOD = 'D1+ F1+ N1+ N2+'
      const BAD = 'D1+ F1- N1+ N2+'
      const DROP = 'D1- F1+ N1+ N2+'
      const marksEvaluator = (marksOf) => ({
        async evaluate(worktree, cases) {
          const text = readFileSync(join(worktree, REF), 'utf8')
          const perCase = Object.fromEntries(cases.map((name) => {
            const marks = marksOf(text, name)
            return [name, { scores: marks.map(runScore), score: median(marks.map(runScore)), marks, invocation: `${INV}-${name}` }]
          }))
          return { perCase, mean: splitMean(perCase), cost: 0, failed: [] }
        },
      })
      const climbWith = async (run, marksOf, edit) => {
        const repo = repoFor()
        await climb(cfgFor(repo, run, { maxIterations: 1 }), { evaluator: marksEvaluator(marksOf), editor: editorWith([step('the edit', append(REF, edit))], { edits: [] }) })
        return { repo, rows: decisions(repo, run) }
      }
      const holdMarks = (text) => ['D1+ E1+ F1+', 'D1+ E1+ F1+', text.includes('HDROP') ? 'D1- E1+ F1+' : 'D1+ E1+ F1+']
      // incident (train): runs [GOOD, GOOD, DROP] against 3 × BAD: the median rises 0 → 1, a run loses its report
      const incident = await climbWith('m6a', (text, name) => (name.startsWith('t') ? (text.includes('TDROP') ? [GOOD, GOOD, DROP] : [BAD, BAD, BAD]) : holdMarks(text)), 'TDROP\n')
      check(incident.rows[1]?.decision === 'rejected-failures' && Number(incident.rows[1].train_mean) === 1 && /t1 0 → 1/.test(incident.rows[1].summary), `M-6 incident: runs [good, good, D1-] over a baseline of 3 × F1- must be rejected-failures naming the case, not kept on the median; got ${incident.rows[1]?.decision} ${incident.rows[1]?.summary}`)
      check(git(incident.repo, 'rev-parse', 'hillclimb/m6a').trim() === git(incident.repo, 'rev-parse', 'HEAD').trim(), 'M-6 incident: nothing is committed')
      // incident (holdout): the train gain is clean, one holdout run drops its report while the holdout median stays
      const holdout = await climbWith('m6b', (text, name) => (name.startsWith('t') ? (text.includes('HDROP') ? [GOOD, GOOD, GOOD] : [BAD, BAD, BAD]) : holdMarks(text)), 'HDROP\n')
      check(holdout.rows[1]?.decision === 'rejected-failures' && /holdout: h1 0 → 1/.test(holdout.rows[1].summary), `M-6 incident: a holdout case that gains a run failing D1 must be rejected-failures; got ${holdout.rows[1]?.decision} ${holdout.rows[1]?.summary}`)
      // legitimate: the baseline already has one D1- run in each train case, the candidate has the same count and fixes the false finding → kept
      const same = await climbWith('m6c', (text, name) => (name.startsWith('t') ? (text.includes('FIXF') ? [DROP, GOOD, GOOD] : [DROP, BAD, BAD]) : holdMarks(text)), 'FIXF\n')
      check(same.rows[1]?.decision === 'kept', `M-6 legitimate: an edit whose failure counts do not grow is kept; got ${same.rows[1]?.decision} ${same.rows[1]?.summary}`)
      // legitimate: no case has such a run before or after → kept
      const none = await climbWith('m6d', (text, name) => (name.startsWith('t') ? (text.includes('FIXF') ? [GOOD, GOOD, GOOD] : [BAD, BAD, BAD]) : holdMarks(text)), 'FIXF\n')
      check(none.rows[1]?.decision === 'kept', `M-6 legitimate: an edit with no failed run before or after is kept; got ${none.rows[1]?.decision}`)
      check(/^# no new failures:.*rejected \(rejected-failures\)/m.test(readFileSync(decisionPath(incident.repo, 'm6a'), 'utf8')), 'M-6: the decision.tsv header names the rule')
    }

    // M-1 (VT-13): after --resume the failure counts of BOTH splits come back from the decision row's invocation ids (the ledger rows of those invocations), so an edit that adds a holdout (or train) run without its report
    // is rejected-failures as without a resume; a log written before the holdout_invocations column cannot restore the holdout's failure counts: --resume refuses it
    {
      const GOOD = 'D1+ F1+ N1+ N2+'
      const BAD = 'D1+ F1- N1+ N2+'
      const DROP = 'D1- F1+ N1+ N2+'
      const HGOOD = 'D1+ E1+ F1+'
      const HDROP = 'D1- E1+ F1+'
      const makeEvaluator = () => {
        let n = 0
        return {
          async evaluate(worktree, cases, ctx = {}) {
            const text = readFileSync(join(worktree, REF), 'utf8')
            n++
            const perCase = {}
            for (const name of cases) {
              const marks = name.startsWith('t')
                ? (text.includes('TFIX') ? [GOOD, GOOD, GOOD] : text.includes('TDROP') ? [GOOD, GOOD, DROP] : [BAD, BAD, BAD])
                : (text.includes('HDROP') ? [HGOOD, HGOOD, HDROP] : [HGOOD, HGOOD, HGOOD])
              const invocation = `${INV}-x${n}${name}`
              for (const mark of marks) appendLedger({ ts: new Date().toISOString(), invocation, case: name, marks: mark, pass: 1, cost_usd: '0' }, ctx.ledgerPath)
              perCase[name] = { scores: marks.map(runScore), score: median(marks.map(runScore)), marks, invocation }
            }
            return { perCase, mean: splitMean(perCase), cost: 0, failed: [] }
          },
        }
      }
      const resumeWith = async (run, edit, { oldLog = false } = {}) => {
        const repo = repoFor()
        const evaluator = makeEvaluator()
        await climb(cfgFor(repo, run, { maxIterations: 0 }), { evaluator, editor: editorWith([], { edits: [] }) })
        const path = decisionPath(repo, run)
        if (oldLog) {
          const lines = readFileSync(path, 'utf8').split('\n')
          const header = lines.findIndex((line) => line.startsWith('attempt\t'))
          const drop = lines[header].split('\t').indexOf('holdout_invocations')
          writeFileSync(path, lines.map((line, i) => (i >= header && line ? line.split('\t').filter((_, col) => col !== drop).join('\t') : line)).join('\n'))
        }
        await climb(cfgFor(repo, run, { maxIterations: 1, resume: true }), { evaluator, editor: editorWith([step('the edit', append(REF, edit))], { edits: [] }) })
        return { repo, rows: decisions(repo, run).filter((row) => row.kind !== 'stop') }
      }
      const base = await resumeWith('m1base', 'TFIX\n')
      check(base.rows[0].kind === 'baseline' && /^h1=/.test(base.rows[0].holdout_invocations) && base.rows[0].holdout_invocations.split(';').length === HOLD.length, `M-1: the baseline row stores the holdout invocation ids; got «${base.rows[0].holdout_invocations}»`)
      check(base.rows[1]?.decision === 'kept' && /^h1=/.test(base.rows[1].holdout_invocations), `M-1: a clean edit after a resume is kept and its row stores the holdout ids; got ${base.rows[1]?.decision} «${base.rows[1]?.holdout_invocations}»`)
      const hold = await resumeWith('m1hold', 'TFIX\nHDROP\n')
      check(hold.rows[1]?.decision === 'rejected-failures' && /holdout: h1 0 → 1/.test(hold.rows[1].summary), `M-1 incident (AC-2.1): after --resume an edit that makes one holdout run drop its report must be rejected-failures; got ${hold.rows[1]?.decision} ${hold.rows[1]?.summary}`)
      const train = await resumeWith('m1train', 'TDROP\n')
      check(train.rows[1]?.decision === 'rejected-failures' && /t1 0 → 1/.test(train.rows[1].summary), `M-1 (train after resume): got ${train.rows[1]?.decision} ${train.rows[1]?.summary}`)
      const oldError = await resumeWith('m1old', 'TFIX\nHDROP\n', { oldLog: true }).then(() => '', (error) => error.message)
      check(/m1old.*holdout_invocations.*start a new run/.test(oldError), `M-1 compat: --resume of a log without holdout_invocations is refused with a clear message; got «${oldError}»`)
      const split = resumedHoldout([{ invocation: `${INV}-a`, case: 'h1', marks: 'D1- E1+ F1+' }], { holdout_cases: 'h1=0.500', holdout_invocations: `h1=${INV}-a` })
      check(split.h1.marks[0] === 'D1- E1+ F1+' && split.h1.resumed === true, `M-1: resumedHoldout rebuilds marks from the ledger; got ${JSON.stringify(split)}`)
    }

    // m-16: the cleanup never prunes the registrations of a repo that encloses a scratch dir (TMPDIR inside a git work tree); a repo's own are pruned through its own .git
    {
      const outer = mkdtempSync(join(tmpdir(), 'hco-'))
      try {
        git(outer, 'init', '-q', '-b', 'main')
        git(outer, 'config', 'user.name', 'Test')
        git(outer, 'config', 'user.email', 't@example.test')
        put(outer, 'a.txt', 'a\n')
        git(outer, 'add', '-A')
        git(outer, 'commit', '-q', '-m', 'init')
        const gone = join(outer, 'gone-wt')
        git(outer, 'worktree', 'add', '-b', 'gone-branch', gone)
        rmSync(gone, { recursive: true, force: true }) // a prunable registration of the enclosing repo
        const inner = mkdtempSync(join(outer, 'hcx-')) // a non-repo scratch dir inside that work tree
        const innerRepo = mkdtempSync(join(outer, 'hcr-'))
        git(innerRepo, 'init', '-q', '-b', 'main')
        git(innerRepo, 'config', 'user.name', 'Test')
        git(innerRepo, 'config', 'user.email', 't@example.test')
        put(innerRepo, 'b.txt', 'b\n')
        git(innerRepo, 'add', '-A')
        git(innerRepo, 'commit', '-q', '-m', 'init')
        const innerGone = join(tmpdir(), `hcw-${process.pid}-${Date.now()}`)
        git(innerRepo, 'worktree', 'add', '-b', 'own-branch', innerGone)
        rmSync(innerGone, { recursive: true, force: true })
        cleanupTemp({ scratch: [inner] })
        check(git(outer, 'worktree', 'list', '--porcelain').includes('gone-wt') && !existsSync(inner), 'm-16 incident: removing a scratch dir inside a git work tree must leave that repo\'s prunable registration alone')
        const innerGit = join(innerRepo, '.git')
        check(git(innerRepo, 'worktree', 'list', '--porcelain').includes('hcw-'), 'm-16: the inner repo has its own registration before the cleanup')
        const listBefore = git(outer, 'worktree', 'list', '--porcelain')
        cleanupTemp({ repos: [innerRepo] })
        check(!existsSync(innerRepo) && existsSync(innerGit) === false && git(outer, 'worktree', 'list', '--porcelain') === listBefore, 'm-16 legitimate: a repo made by the test is removed (pruned through its own .git) and the enclosing repo\'s registrations are as they were')
      } finally {
        rmSync(outer, { recursive: true, force: true })
      }
    }

    // m-18 / m-19: the charge for an interrupted case covers the run in flight; one shared pid helper
    {
      const repo = repoFor()
      const ledgerPath = join(repo, 'evals/ledger.tsv')
      const rowOf = (invocation, cost) => ({ ts: 't', invocation, case: 'c1', plugin_ref: `working-tree+${climbLabel('m18')}`, marks: 'E1+', pass: 1, cost_usd: String(cost) })
      const mark = (invocation, estimate) => ({ kind: 'eval', case: 'c1', estimate, before: 0, perRun: 1, runs: 3, invocation })
      // incident: estimate 3 × 0.30, runs 1–2 recorded at 0.45 each (the estimate is already spent), run 3 in flight → at least one run's bound
      for (const cost of [0.45, 0.45]) appendLedger(rowOf(`${INV}-a`, cost), ledgerPath)
      markInflight(repo, 'm18', 'eval-c1', mark(`${INV}-a`, 0.9))
      const charged = chargeInflight({ repo, run: 'm18', ledgerPath })
      check(Math.abs(charged - 1) < 1e-9, `m-18 incident: runs 1–2 recorded, run 3 in flight, the estimate spent: the charge must be at least perRun (1); got ${charged}`)
      // legitimate: all 3 runs recorded → only the remaining reserve (2.0 − 1.35), no extra run
      for (const cost of [0.45, 0.45, 0.45]) appendLedger(rowOf(`${INV}-b`, cost), ledgerPath)
      markInflight(repo, 'm18', 'eval-c1', { ...mark(`${INV}-b`, 2), before: 0.9 })
      const rest = chargeInflight({ repo, run: 'm18', ledgerPath })
      check(Math.abs(rest - 0.65) < 1e-9, `m-18 legitimate: with every run recorded the charge is the remaining reserve (0.65); got ${rest}`)
      const lib = readFileSync(new URL('./hillclimb-lib.mjs', import.meta.url), 'utf8')
      check(/import \{ alive \} from '\.\.\/plugins\/stage-pipeline\/scripts\/processes\.mjs'/.test(lib) && !/pidAlive/.test(lib) && alive(process.pid) && !alive(2 ** 22 + 12345), 'm-19: the driver imports the shared alive helper and has no copy of its own')
    }

    // S-1 / S-2: the editor's toolset, its path-scoped allow rules, the settings that confine it to the worktree, and the denies on the measurement
    {
      const argv = editorArgs({ prompt: 'p', model: 'opus', budget: 1, agent: AGENT, repo: '/r/start', resultsDir: '/r/start/evals/.results' })
      const after = (flag) => argv.slice(argv.indexOf(flag) + 1, argv.findIndex((token, i) => i > argv.indexOf(flag) && token.startsWith('--')))
      check(after('--tools').join() === 'Read,Edit,Write,Glob,Grep', `S-1: --tools names exactly the five tools; got ${after('--tools')}`)
      check(!after('--allowedTools').some((rule) => !rule.includes('(')) && after('--allowedTools').length === 6, `S-1: no bare tool name is pre-approved; got ${after('--allowedTools')}`)
      check(after('--allowedTools').filter((rule) => /^(Edit|Write)\(/.test(rule)).every((rule) => rule.includes(`skills/${AGENT}/references/**`) || rule === `Edit(./plugins/stage-pipeline/agents/${AGENT}.md)`), 'S-1: Edit and Write are scoped to references/ and the one agent file')
      const settings = JSON.parse(after('--settings')[0])
      check(settings.permissions.blockWritesOutsideWorkingDirectories === true && settings.permissions.blockReadsOutsideWorkingDirectories === true, `S-1: --settings blocks reads and writes outside the working directory; got ${JSON.stringify(settings)}`)
      const denied = after('--disallowedTools')
      check(['Read(//r/start/evals/**)', 'Grep(//r/start/evals/**)', 'Read(//r/start/evals/.results/**)', 'Glob(//r/start/evals/.results/**)', 'Read(./evals/**)', 'Write(//r/start/evals/**)'].every((rule) => denied.includes(rule)), `S-2: the starting checkout's evals/ and the results dir are denied by absolute path; got ${denied}`)
      // S-2 on the eval side: the agent's session gets neither EVAL_LEDGER nor EVAL_RESULTS (legitimate: the rest of the environment and the data dir stay)
      const env = sessionEnv({ PATH: '/usr/bin', KEEP: '1', EVAL_LEDGER: '/r/start/evals/ledger.tsv', EVAL_RESULTS: '/r/start/evals/.results', CLAUDE_PLUGIN_DATA: '/z' }, '/data')
      check(!('EVAL_LEDGER' in env) && !('EVAL_RESULTS' in env) && !('CLAUDE_PLUGIN_DATA' in env), `S-2 incident: EVAL_LEDGER/EVAL_RESULTS must not reach the agent's session; got ${Object.keys(env)}`)
      check(env.PATH === '/usr/bin' && env.KEEP === '1' && env.STAGE_PIPELINE_DATA_DIR === '/data' && env.MCP_CONNECTION_NONBLOCKING === 'false', 'S-2 legitimate: the other variables and the data dir are kept')
      check(readFileSync(fileURLToPath(new URL('./eval.mjs', import.meta.url)), 'utf8').includes('const env = sessionEnv(process.env, dataDir)'), 'S-2: eval.mjs runClaude builds the session environment through sessionEnv')
    }

    // S-3: the invocation id is made by the hill-climb and handed to eval.mjs; text the child printed never chooses the scored run, and an id is checked by format before any path join
    {
      const repo = repoFor()
      put(repo, 'scripts/eval.mjs', `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
const name = args.at(-1)
const inv = args[args.indexOf('--invocation') + 1]
for (let i = 1; i <= 2; i++) appendFileSync(process.env.EVAL_LEDGER, ['ts', inv, name, i, 'working-tree+hillclimb:s3', '0', 'sha', 'v', 'm', 'E1+ N1+', '1', '0.1000', '1'].join('\\t') + '\\n')
console.log('- F1: the agent wrote «each invocation 20261029T000000-fake re-reads the config» and invocation ../../../../etc')
console.log('## working-tree (plugin 0 @ sha, v), runs per case: 2, invocation 20261029T000000-fake')
console.log('## working-tree (plugin 0 @ sha, v), runs per case: 2, invocation ' + inv)
`)
      const ledgerPath = join(repo, 'evals/ledger.tsv')
      appendLedger({ ts: 't', invocation: 'x', case: 'seed' }, ledgerPath)
      for (let i = 1; i <= 2; i++) appendLedger({ ts: '2026-10-29T00:00:00Z', invocation: '20261029T000000-fake', case: 'c1', attempt: i, plugin_ref: 'working-tree+hillclimb:s3', marks: 'E1- N1-', pass: 0, cost_usd: '0.1000' }, ledgerPath)
      const out = await makeEvaluator({ repo, run: 's3', runs: 2, jobs: 1, ledgerPath, resultsDir: join(repo, 'evals/.results') }).evaluate(repo, ['c1'])
      check(out.failed.length === 0 && INVOCATION_RE.test(out.perCase.c1?.invocation ?? '') && out.perCase.c1.invocation !== '20261029T000000-fake' && out.perCase.c1.score === 1, `S-3 incident: the scored run is the id the hill-climb passed, not a line the child printed; got ${JSON.stringify(out.perCase)} ${out.failed}`)
      // an id outside the format never becomes a path: missExcerpts and resumedTrain
      const results = join(repo, 'evals/.results')
      mkdirSync(join(repo, 'evals/outside'), { recursive: true })
      writeFileSync(join(repo, 'evals/outside/c1--1.md'), '# c1\n\n## Failures\n\n- SECRET outside text\n\n## Final message of the subagent\n\nx\n')
      const bad = missExcerpts({ perCase: { c1: { score: 0, scores: [0], marks: ['E1-'], invocation: '../outside' } } }, results)
      check(!bad.includes('SECRET') && /details unavailable/.test(bad), `S-3 incident: an invocation id outside the format must not be joined into a path; got ${bad}`)
      mkdirSync(join(results, `${INV}-c1`), { recursive: true })
      writeFileSync(join(results, `${INV}-c1/c1--1.md`), '# c1\n\n## Failures\n\n- expected the stale finding\n\n## Final message of the subagent\n\nx\n')
      check(missExcerpts({ perCase: { c1: { score: 0, scores: [0], marks: ['E1-'], invocation: `${INV}-c1` } } }, results).includes('expected the stale finding'), 'S-3 legitimate: a well-formed id reads its results directory')
      const resumed = resumedTrain([], { train_cases: 'c1=0.500;c2=0.500', train_invocations: `c1=${INV}-c1;c2=../../etc` })
      check(resumed.c1.invocation === `${INV}-c1` && resumed.c2.invocation === undefined, `S-3: resumedTrain keeps only well-formed ids; got ${JSON.stringify(resumed)}`)
      // eval.mjs itself refuses a malformed id (free: it fails while parsing flags) and takes a well-formed one
      const evalPath = fileURLToPath(new URL('./eval.mjs', import.meta.url))
      const refused = spawnSync(process.execPath, [evalPath, '--invocation', '../x', '--list'], { encoding: 'utf8' })
      const accepted = spawnSync(process.execPath, [evalPath, '--invocation', '20261030T102038-02dd', '--list'], { encoding: 'utf8' })
      check(refused.status === 2 && /--invocation expects an id/.test(refused.stderr) && accepted.status === 0, `S-3: eval.mjs --invocation checks the format; got ${refused.status} ${refused.stderr.trim()} / ${accepted.status}`)
    }

    // m-7: the child gets the tighter of the lane budget and what is left under the run's cap, so its runs 2 and 3 are checked too
    {
      const repo = repoFor()
      put(repo, 'scripts/eval.mjs', "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.EVAL_LEDGER + '.args-' + process.argv.at(-1), JSON.stringify(process.argv.slice(2)))\n")
      const ledgerPath = join(repo, 'evals/ledger.tsv')
      appendLedger({ ts: '2026-10-30T09:00:00Z', invocation: 'old', case: 'c1', plugin_ref: 'working-tree', marks: 'E1+', pass: 1, cost_usd: '0.1000' }, ledgerPath)
      appendLedger({ ts: '2026-10-30T09:00:00Z', invocation: `${INV}-z`, case: 'z', plugin_ref: `working-tree+${climbLabel('m7')}`, marks: 'E1+', pass: 1, cost_usd: '0.2000' }, ledgerPath)
      const argsOf = () => JSON.parse(readFileSync(`${ledgerPath}.args-c1`, 'utf8'))
      const valueOf = (args, flag) => args[args.indexOf(flag) + 1]
      const make = (extra) => makeEvaluator({ repo, run: 'm7', runs: 2, jobs: 1, ledgerPath, resultsDir: join(repo, 'evals/.results'), ...extra })
      // cap only: $1 − $0.2 spent = $0.8 left for this child, counted from now
      await make({ capUsd: 1 }).evaluate(repo, ['c1'])
      check(Math.abs(Number(valueOf(argsOf(), '--budget-usd')) - 0.8) < 1e-9 && /^\d{4}-\d\d-\d\dT/.test(valueOf(argsOf(), '--budget-since') ?? ''), `m-7 incident: with only a cap the child still needs --budget-usd (what is left under it) and --budget-since; got ${argsOf()}`)
      // lane $40 and cap $1: the cap is tighter (lane spend so far $0.3 + $0.8 left)
      await make({ capUsd: 1, budgetUsd: 40, budgetSince: '2026-10-30T00:00:00Z' }).evaluate(repo, ['c1'])
      check(Math.abs(Number(valueOf(argsOf(), '--budget-usd')) - 1.1) < 1e-9 && valueOf(argsOf(), '--budget-since') === '2026-10-30T00:00:00Z', `m-7 incident: a lane of $40 must not hide the cap; expected 1.1; got ${valueOf(argsOf(), '--budget-usd')}`)
      // legitimate: the lane is the tighter one → its own value; no cap, no lane → no budget flag at all
      await make({ capUsd: 1, budgetUsd: 0.9, budgetSince: '2026-10-30T00:00:00Z' }).evaluate(repo, ['c1'])
      check(Math.abs(Number(valueOf(argsOf(), '--budget-usd')) - 0.9) < 1e-9, `m-7 legitimate: the tighter lane budget is handed on; got ${valueOf(argsOf(), '--budget-usd')}`)
      await make({}).evaluate(repo, ['c1'])
      check(!argsOf().includes('--budget-usd'), 'm-7 legitimate: with neither a cap nor a lane no budget flag is passed')
    }

    // the signal, SIGKILL and live-owner cases run the driver as a child: real makeEditor on a stub `claude`, or real makeEvaluator on a stub eval.mjs
    {
      const aux = mkdtempSync(join(tmpdir(), 'hcx-'))
      scratch.push(aux)
      const pids = []
      const libUrl = new URL('./hillclimb-lib.mjs', import.meta.url).href
      const driver = join(aux, 'driver.mjs')
      writeFileSync(driver, `import { climb, makeEditor, makeEvaluator } from ${JSON.stringify(libUrl)}
const o = JSON.parse(process.argv[2])
const ledgerPath = o.repo + '/evals/ledger.tsv'
const resultsDir = o.repo + '/evals/.results'
const quick = { async evaluate(wt, cases) { return { perCase: Object.fromEntries(cases.map((n) => [n, { score: 0.4, scores: [0.4], marks: [], invocation: '${INV}-' + n }])), mean: 0.4, cost: 0, failed: [] } } }
const evaluator = o.mode === 'eval' ? makeEvaluator({ repo: o.repo, run: o.run, runs: 2, jobs: 2, capUsd: 100, ledgerPath, resultsDir }) : quick
const editor = o.mode === 'editor' ? makeEditor({ repo: o.repo, run: o.run, model: 'opus', budget: 0.5, ledgerPath, resultsDir, claudeBin: o.claude, timeoutSec: 60 }) : { model: 'opus', budget: 0.5, edit: async () => ({ ok: false, summary: 'none' }) }
await climb({ repo: o.repo, run: o.run, agent: 'pro-review', train: ['t1', 't2'], holdout: ['h1'], runs: 2, maxIterations: 1, minAttempts: 1, target: 2, capUsd: 100, ledgerPath, editorModel: 'opus', editorBudget: 0.5 }, { evaluator, editor })
`)
      const hangingClaude = (name) => {
        const path = join(aux, name)
        writeFileSync(path, `#!/bin/sh\necho $$ > ${JSON.stringify(`${path}.pid`)}\nexec sleep 30\n`)
        chmodSync(path, 0o755)
        pids.push(`${path}.pid`)
        return path
      }
      const waitFor = async (check_, ms = 20000) => {
        const until = Date.now() + ms
        while (Date.now() < until) {
          if (check_()) return true
          await new Promise((r) => setTimeout(r, 50))
        }
        return false
      }
      const pidOf = (file) => (existsSync(file) ? Number(readFileSync(file, 'utf8').trim()) : 0)
      const dead = (pid) => !alive(pid)
      const start = (repo, options) => {
        const proc = spawn(process.execPath, [driver, JSON.stringify({ repo, ...options })], { stdio: 'ignore' })
        const closed = new Promise((resolveClose) => proc.on('close', (code, sig) => resolveClose({ code, sig })))
        return { proc, closed }
      }
      const inflightRows = (repo) => readLedger(join(repo, 'evals/ledger.tsv')).filter((row) => row.case === 'hillclimb-inflight')
      const markers = (repo, run) => (existsSync(inflightDir(repo, run)) ? readdirSync(inflightDir(repo, run)) : [])
      const makeStubEval = (repo) => {
        put(repo, 'scripts/eval.mjs', `import { appendFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const name = args.at(-1)
const inv = args[args.indexOf('--invocation') + 1]
appendFileSync(process.env.EVAL_LEDGER, ['ts', inv, name, 1, 'working-tree+' + args[args.indexOf('--label') + 1], '0', 'sha', 'v', 'm', 'E1+ N1+', '1', '0.3000', '1'].join('\\t') + '\\n')
writeFileSync(process.env.EVAL_LEDGER + '.pid-' + name, String(process.pid))
setTimeout(() => {}, 30000)
`)
        appendLedger({ ts: 't', invocation: 'x', case: 'seed' }, join(repo, 'evals/ledger.tsv'))
        git(repo, 'add', '-A')
        git(repo, 'commit', '-q', '-m', 'stub eval')
      }
      try {
        // M-1 incident: SIGTERM while the editor call runs → the call's whole budget is in the ledger before the exit, the claude process is gone, the temp worktree is removed
        {
          const repo = repoFor()
          const claude = hangingClaude('claude-m1')
          const { proc, closed } = start(repo, { mode: 'editor', run: 'm1', claude })
          await waitFor(() => pidOf(`${claude}.pid`) > 0)
          const claudePid = pidOf(`${claude}.pid`)
          proc.kill('SIGTERM')
          const exit = await closed
          const rows = inflightRows(repo)
          check(exit.code === 130 && rows.length === 1 && rows[0].cost_usd === '0.5000' && spentByRun(readLedger(join(repo, 'evals/ledger.tsv')), 'm1') === 0.5, `M-1 incident: a signal during the editor call must charge its budget (0.5) to the ledger before exit 130; got ${JSON.stringify(exit)} rows ${rows.map((row) => row.cost_usd)}`)
          check(await waitFor(() => dead(claudePid), 3000) && !markers(repo, 'm1').length && !git(repo, 'worktree', 'list').includes('hc-'), 'M-1: the editor process is gone, the mark is cleared, the temp worktree is removed')
        }
        // M-1 / m-8 / M-3: SIGKILL leaves the mark; a resume while the owner lives refuses and charges nothing; after the owner is dead it charges the mark and goes on; a foreign prunable registration survives both
        {
          const repo = repoFor()
          const foreign = join(aux, 'foreign-wt')
          git(repo, 'worktree', 'add', '-b', 'foreign-branch', foreign)
          rmSync(foreign, { recursive: true, force: true }) // its directory is gone: `git worktree prune` would drop the registration
          const claude = hangingClaude('claude-m1k')
          const { proc, closed } = start(repo, { mode: 'editor', run: 'm1k', claude })
          await waitFor(() => pidOf(`${claude}.pid`) > 0)
          const resumeCfg = () => cfgFor(repo, 'm1k', { maxIterations: 1, resume: true })
          let message = ''
          try {
            await climb(resumeCfg(), { evaluator: scripted({ trees: [], calls: [], edits: [] }), editor: editorWith([], { edits: [] }) })
          } catch (error) {
            message = error.message
          }
          check(new RegExp(`run m1k is still running as pid ${proc.pid}\\b`).test(message), `m-8 incident: a resume while the previous process lives must refuse naming its pid; got «${message}»`)
          check(git(repo, 'worktree', 'list').includes('hc-') && !inflightRows(repo).length && markers(repo, 'm1k').includes('editor.json'), 'm-8: the live run keeps its worktree and its mark, and nothing is charged')
          proc.kill('SIGKILL')
          await closed
          process.kill(pidOf(`${claude}.pid`), 'SIGKILL')
          check(markers(repo, 'm1k').includes('editor.json') && !inflightRows(repo).length, 'M-1: a SIGKILL leaves the mark uncharged for the resume')
          const log = { trees: [], calls: [], edits: [] }
          message = ''
          try {
            await climb(resumeCfg(), { evaluator: scripted(log), editor: editorWith([], log) })
          } catch (error) {
            message = error.message
          }
          check(!message && inflightRows(repo).length === 1 && inflightRows(repo)[0].cost_usd === '0.5000' && !markers(repo, 'm1k').length, `M-1 incident: a resume charges the editor call a SIGKILL left in flight; got «${message}» rows ${inflightRows(repo).map((row) => row.cost_usd)}`)
          check(Number(decisions(repo, 'm1k').at(-1).cumulative_usd) >= 0.5, 'M-1: the spend of the interrupted call is in the resumed run\'s cumulative')
          const listing = git(repo, 'worktree', 'list', '--porcelain')
          check(listing.includes('foreign-wt') && /prunable/.test(listing) && !listing.includes('hc-'), `M-3 incident: a resume must not prune another checkout's registration; got\n${listing}`)
          // M-3 legitimate: the run's own entry whose directory is gone is dropped by itself; the foreign one still stays
          const claude2 = hangingClaude('claude-m3b')
          const second = start(repo, { mode: 'editor', run: 'm3b', claude: claude2 })
          await waitFor(() => pidOf(`${claude2}.pid`) > 0)
          second.proc.kill('SIGKILL')
          await second.closed
          process.kill(pidOf(`${claude2}.pid`), 'SIGKILL')
          const own = git(repo, 'worktree', 'list', '--porcelain').split('\n').find((line) => line.startsWith('worktree ') && line.includes('hc-'))?.slice(9)
          rmSync(dirname(own), { recursive: true, force: true })
          message = ''
          try {
            await climb(cfgFor(repo, 'm3b', { maxIterations: 1, resume: true }), { evaluator: scripted(log), editor: editorWith([], log) })
          } catch (error) {
            message = error.message
          }
          const after = git(repo, 'worktree', 'list', '--porcelain')
          check(!message && own && !after.includes('hc-') && after.includes('foreign-wt'), `M-3 legitimate: the run's own entry with a missing directory is dropped and the foreign one stays; got «${message}»\n${after}`)
        }
        // M-1 / m-8 legitimate: a finished editor call leaves no mark and no charge row; after a SIGTERMed owner a resume goes on
        {
          const repo = repoFor()
          const stub = join(aux, 'done-claude')
          writeFileSync(stub, `#!/bin/sh\necho '{"type":"result","is_error":false,"total_cost_usd":0.2,"result":"EDIT: x"}'\n`)
          chmodSync(stub, 0o755)
          const editor = makeEditor({ repo, run: 'done', model: 'opus', budget: 0.5, ledgerPath: join(repo, 'evals/ledger.tsv'), resultsDir: join(repo, 'evals/.results'), claudeBin: stub })
          await climb(cfgFor(repo, 'done', { maxIterations: 1 }), { evaluator: scripted({ trees: [], calls: [], edits: [] }), editor })
          check(!inflightRows(repo).length && !markers(repo, 'done').length, 'M-1 legitimate: a finished editor call clears its mark and charges nothing extra')
          check(chargeInflight({ repo, run: 'done', ledgerPath: join(repo, 'evals/ledger.tsv') }) === 0, 'M-1 legitimate: nothing in flight, nothing to charge')
        }
        // M-2 incident: SIGTERM during an evaluation → no eval child outlives the run, and what each had not yet spent is charged: the 0.7 left of the estimate, raised to one run's bound (1.0) because run 2 of 2 was in flight
        {
          const repo = repoFor()
          makeStubEval(repo)
          const { proc, closed } = start(repo, { mode: 'eval', run: 'm2' })
          const pidFiles = ['t1', 't2'].map((name) => join(repo, `evals/ledger.tsv.pid-${name}`))
          check(await waitFor(() => pidFiles.every((file) => pidOf(file) > 0)), 'M-2: both eval children started')
          const children = pidFiles.map(pidOf)
          pids.push(...pidFiles)
          proc.kill('SIGTERM')
          const exit = await closed
          check(exit.code === 130 && (await waitFor(() => children.every(dead), 3000)), `M-2 incident: no eval child may outlive a signalled run; got ${JSON.stringify(exit)} dead ${children.map(dead)}`)
          const total = inflightRows(repo).reduce((sum, row) => sum + Number(row.cost_usd), 0)
          check(inflightRows(repo).length === 2 && Math.abs(total - 2) < 1e-9 && !markers(repo, 'm2').length, `M-2 incident: each case in flight is charged one run's bound (1.0; the unspent estimate is only 0.7, run 2 of 2 not recorded), 2.0 in all; got ${inflightRows(repo).map((row) => row.cost_usd)}`)
          // SIGKILL: the children survive in their own groups, the marks stay, and chargeInflight (what a resume runs) charges the same amounts once
          const killed = start(repo, { mode: 'eval', run: 'm2k' })
          const files2 = ['t1', 't2'].map((name) => join(repo, `evals/ledger.tsv.pid-${name}`))
          for (const file of files2) rmSync(file, { force: true })
          check(await waitFor(() => files2.every((file) => pidOf(file) > 0)), 'M-2: the children of the second run started')
          killed.proc.kill('SIGKILL')
          await killed.closed
          // m-17 incident: the marks carry the children's pids, and a resume refuses while one still answers, naming the pid and the run; nothing is charged or cleared
          const childPids = files2.map(pidOf)
          const markedPids = markers(repo, 'm2k').map((file) => JSON.parse(readFileSync(join(inflightDir(repo, 'm2k'), file), 'utf8')).pid).sort()
          check(markedPids.join() === [...childPids].sort().join(), `m-17: each eval mark must carry its child's pid; marks ${markedPids} children ${childPids}`)
          let refusal = ''
          try {
            assertNoLiveEvalChildren({ repo, run: 'm2k' })
          } catch (error) {
            refusal = error.message
          }
          check(childPids.some((pid) => new RegExp(`eval child pid ${pid} of run m2k is still running`).test(refusal)) && markers(repo, 'm2k').length === 2 && !inflightRows(repo).some((row) => row.plugin_ref?.includes('m2k')), `m-17 incident: a live eval child must stop a resume, naming pid and run; got «${refusal}»`)
          for (const file of files2) process.kill(pidOf(file), 'SIGKILL')
          check(await waitFor(() => childPids.every(dead), 3000), 'm-17: the children are gone after the kill')
          assertNoLiveEvalChildren({ repo, run: 'm2k' }) // legitimate: dead pids do not stop a resume
          const leftover = git(repo, 'worktree', 'list', '--porcelain').split('\n').find((line) => line.startsWith('worktree ') && line.includes('hc-'))?.slice(9)
          if (leftover) rmSync(dirname(leftover), { recursive: true, force: true }) // the SIGKILLed driver's temp worktree: no resume of this run follows
          const charged = chargeInflight({ repo, run: 'm2k', ledgerPath: join(repo, 'evals/ledger.tsv') })
          check(Math.abs(charged - 2) < 1e-9 && !markers(repo, 'm2k').length && chargeInflight({ repo, run: 'm2k', ledgerPath: join(repo, 'evals/ledger.tsv') }) === 0, `M-2 incident: a resume charges the marks a SIGKILL left (one run's bound, 1.0 each, while run 2 of 2 is in flight), once; got ${charged}`)
        }
        // m-17 through climb: a live pid in an eval mark refuses the resume (nothing charged or cleared, the temp worktree removed); once it is dead the resume goes on and charges the case
        {
          const repo = repoFor()
          await climb(cfgFor(repo, 'm17', { maxIterations: 1 }), { evaluator: scripted({ trees: [], calls: [], edits: [] }), editor: editorWith([], { edits: [] }) })
          const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
          const closed = new Promise((resolveClose) => sleeper.on('close', resolveClose))
          markInflight(repo, 'm17', 'eval-t1', { kind: 'eval', case: 't1', estimate: 1, before: 0, perRun: 1, runs: 3, invocation: `${INV}-m17`, pid: sleeper.pid })
          let message = ''
          try {
            await climb(cfgFor(repo, 'm17', { maxIterations: 1, resume: true }), { evaluator: scripted({ trees: [], calls: [], edits: [] }), editor: editorWith([], { edits: [] }) })
          } catch (error) {
            message = error.message
          }
          check(new RegExp(`eval child pid ${sleeper.pid} of run m17 is still running`).test(message) && markers(repo, 'm17').length === 1 && !inflightRows(repo).length && !git(repo, 'worktree', 'list').includes('hc-'), `m-17 incident: a resume while an eval child lives must refuse (pid, run), charge nothing and keep the mark; got «${message}»`)
          sleeper.kill('SIGKILL')
          await closed
          message = ''
          try {
            await climb(cfgFor(repo, 'm17', { maxIterations: 1, resume: true }), { evaluator: scripted({ trees: [], calls: [], edits: [] }), editor: editorWith([], { edits: [] }) })
          } catch (error) {
            message = error.message
          }
          check(!message && inflightRows(repo).length === 1 && Math.abs(Number(inflightRows(repo)[0].cost_usd) - 1) < 1e-9 && !markers(repo, 'm17').length, `m-17 legitimate: with the child dead the resume proceeds and charges the case; got «${message}» rows ${inflightRows(repo).map((row) => row.cost_usd)}`)
        }
        // M-2 legitimate: an evaluation that finishes leaves no mark (test 9 and its stub: the rows are the cost)
        {
          const repo = repoFor()
          put(repo, 'scripts/eval.mjs', "import { appendFileSync } from 'node:fs'\nconst a = process.argv.slice(2)\nappendFileSync(process.env.EVAL_LEDGER, ['ts', a[a.indexOf('--invocation') + 1], a.at(-1), 1, 'working-tree+hillclimb:m2l', '0', 's', 'v', 'm', 'E1+', '1', '0.1000', '1'].join('\\t') + '\\n')\n")
          appendLedger({ ts: 't', invocation: 'x', case: 'seed' }, join(repo, 'evals/ledger.tsv'))
          await makeEvaluator({ repo, run: 'm2l', runs: 1, jobs: 2, ledgerPath: join(repo, 'evals/ledger.tsv'), resultsDir: join(repo, 'evals/.results') }).evaluate(repo, ['c1', 'c2'])
          check(!markers(repo, 'm2l').length && !inflightRows(repo).length, 'M-2 legitimate: finished eval children leave no mark and no charge row')
        }
        // S-1: after an editor call the starting checkout's tracked tree and ledger are checked; a stub editor that writes into the checkout stops the run with its own decision
        {
          const stubFor = (repo, name, body) => {
            const js = join(aux, `${name}.mjs`)
            writeFileSync(js, `import { appendFileSync, writeFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(REF)}, 'T+\\n')\n${body}\nprocess.stdout.write(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.1, result: 'EDIT: lens' }))\n`)
            const sh = join(aux, name)
            writeFileSync(sh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)} "$@"\n`)
            chmodSync(sh, 0o755)
            return makeEditor({ repo, run: name, model: 'opus', budget: 0.5, ledgerPath: join(repo, 'evals/ledger.tsv'), resultsDir: join(repo, 'evals/.results'), claudeBin: sh })
          }
          const run = async (name, body) => {
            const repo = repoFor()
            const result = await climb(cfgFor(repo, name, { maxIterations: 1 }), { evaluator: scripted({ trees: [], calls: [], edits: [] }), editor: stubFor(repo, name, body(repo)) })
            return { repo, result, last: decisions(repo, name).at(-1), rows: decisions(repo, name) }
          }
          const tracked = await run('s1a', (repo) => `writeFileSync(${JSON.stringify(join(repo, 'README.md'))}, 'edited by the editor\\n')`)
          check(tracked.result.stopped === 'stopped-checkout-touched' && tracked.rows.at(-1).decision === 'stopped-checkout-touched' && /tracked files/.test(tracked.last.summary), `S-1 incident: an editor that edits a tracked file of the starting checkout stops the run; got ${tracked.result.stopped} ${tracked.last.summary}`)
          check(git(tracked.repo, 'rev-parse', 'hillclimb/s1a').trim() === git(tracked.repo, 'rev-parse', 'HEAD').trim() && !tracked.rows.some((row) => row.decision === 'kept'), 'S-1: nothing is committed on the branch after such a stop')
          const ledger = await run('s1b', (repo) => `writeFileSync(${JSON.stringify(join(repo, 'evals/ledger.tsv'))}, '')`)
          check(ledger.result.stopped === 'stopped-checkout-touched' && /ledger/.test(ledger.last.summary), `S-1 incident: an editor that rewrites the ledger stops the run; got ${ledger.result.stopped} ${ledger.last.summary}`)
          const fine = await run('s1c', () => '')
          check(fine.result.stopped !== 'stopped-checkout-touched' && fine.rows.some((row) => row.decision === 'kept'), `S-1 legitimate: an editor that only edits the worktree (its own ledger row only appended) is judged normally; got ${fine.result.stopped}`)
        }
      } finally {
        for (const file of pids) {
          const pid = pidOf(file)
          if (pid && !dead(pid)) {
            try {
              process.kill(pid, 'SIGKILL')
            } catch {
              // gone
            }
          }
        }
      }
    }
  } finally {
    cleanupTemp({ repos: cleanups, scratch })
  }
  if (problems.length) {
    console.error(`✘ hillclimb self-test: ${problems.length} problem(s)\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
    return false
  }
  console.log(`✔ hillclimb self-test (${checks} checks): metric, kept edit and its commit, train noise, holdout drop, bounds (outside, frontmatter, created file), cap, stop predicate, resume, failed-baseline resume refusal, no headroom, ledger spend (timed-out editor, resume, --jobs reserve), pending passthrough, short runs, editor argv, evaluator passthrough, no git identity, default split, killed-run worktree on resume (SIGKILL, SIGHUP), resume details, 14b: in-flight charge on signal and resume (M-1, M-2), room before the editor (m-6), cap handed to the child (m-7), no prune and a live-owner refusal (M-3, m-8), current-agent dry run (M-4), report-drop is the worst run (M-5), failed runs counted per case (M-6), enclosing-repo prune (m-16), live eval child on resume (m-17), in-flight run charge (m-18), shared pid helper (m-19), editor confinement and checkout check (S-1, S-2), invocation id (S-3)`)
  return true
}
