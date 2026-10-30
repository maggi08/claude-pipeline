/**
 * Free self-test of scripts/hillclimb.mjs (`node scripts/hillclimb.mjs --self-test`, run by validate.mjs): the real loop in a temp git repo with a stub editor and a scripted
 * evaluator; the real editor and evaluator code paths against stub executables. No `claude`, no model.
 */
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendLedger } from './eval-lib.mjs'
import { caseLedgerSummary, climb, climbLabel, DEFAULT_HOLDOUT, DEFAULT_TRAIN, identityArgs, decisionPath, editorArgs, makeEditor, makeEvaluator, median, missExcerpts, parseDecision, runScore, spentByRun, splitMean } from './hillclimb-lib.mjs'
import { readLedger } from './eval-lib.mjs'

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
        perCase[name] = { score, scores: [score, score, score], marks: ['N1+'], invocation: `inv-${name}` }
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
const decisions = (repo, run) => parseDecision(readFileSync(decisionPath(repo, run), 'utf8')).rows

export async function selfTest() {
  const problems = []
  const check = (ok, message) => {
    if (!ok) problems.push(message)
  }
  const cleanups = []
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

    // 5. the cap stops before passing: the estimate of the next call counts, not only the money already spent
    {
      const repo = repoFor()
      const log = { trees: [], calls: [], edits: [], evalCost: 1 }
      // baseline: estimates 0.5 per case-run (no ledger) x 3 runs x 3 cases = 4.5; spent 2 (scripted). Editor 0.5 → 2.5. The train estimate 3.0 would pass 5.0 → stop before the evaluation.
      const result = await climb(cfgFor(repo, 'cap', { capUsd: 5, maxIterations: 5 }), { evaluator: scripted(log), editor: editorWith([step('lens', append(REF, 'T+\n')), step('second', append(REF, 'T+\n'))], log) })
      const rows = decisions(repo, 'cap')
      const last = rows.at(-1)
      check(result.stopped === 'stopped-cap' && last.decision === 'stopped-cap', `cap: the last row should be stopped-cap; got ${last?.decision}`)
      check(Number(last.cumulative_usd) <= 5 && log.calls.length === 2, `cap: the spend ${last?.cumulative_usd} must stay under the cap and no evaluation may start past it (calls ${log.calls.length})`)
      check(!readFileSync(join(repo, REF), 'utf8').includes('T+') && git(repo, 'rev-parse', 'hillclimb/cap').trim() === git(repo, 'rev-parse', 'HEAD').trim(), 'cap: the edit made before the stop was undone, nothing committed')
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
writeFileSync(${JSON.stringify(join(repo, 'argv.json'))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))
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
      check(has('--model', 'opus', '--max-budget-usd', '0.9', '--output-format', 'json', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', 'dontAsk'), `editor: argv misses an isolation flag: ${seen.argv.filter((x) => x.startsWith('--')).join(' ')}`)
      const allowed = seen.argv.slice(seen.argv.indexOf('--allowedTools') + 1, seen.argv.indexOf('--disallowedTools'))
      check(allowed.join() === 'Read,Edit,Write,Glob,Grep', `editor: allowed tools should be exactly Read Edit Write Glob Grep; got ${allowed}`)
      check(/hc-/.test(seen.cwd) && !seen.cwd.startsWith(repo), 'editor: the call must run in the temp worktree, not in the starting checkout')
      const ledger = readFileSync(join(repo, 'evals/ledger.tsv'), 'utf8')
      check(ledger.includes('hillclimb-editor') && ledger.includes('0.4200'), 'editor: its call was not appended to the ledger with its cost')
      const rows = decisions(repo, 'ed')
      check(rows[1]?.summary === 'lens for stale state' && Number(rows[1].cost_usd) >= 0.42, `editor: the EDIT line and the cost should reach the row; got ${rows[1]?.summary} ${rows[1]?.cost_usd}`)
      check(editorArgs({ prompt: 'p', model: 'opus', budget: 1 }).includes('--no-session-persistence'), 'editor: editorArgs')
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
      const row = (fields) => ({ ts: '2026-10-30T10:00:00Z', invocation: 'i', case: 'c', marks: 'E1+ N1+', ...fields })
      const summary = caseLedgerSummary([row({ invocation: 'old', marks: 'E1-' }), row({ ts: '2026-10-31T10:00:00Z', invocation: 'new', marks: 'E1+ N1-' }), row({ ts: '2026-10-31T10:00:00Z', invocation: 'new', marks: 'W-' }), row({ case: 'other' })], 'c')
      check(summary.runs === 3 && summary.failures === 1 && summary.score === 0.5 && summary.marks === 'E1+ N1- | W-', `dry run: per case the runs, the W- count and the last invocation's score and marks; got ${JSON.stringify(summary)}`)
      const allW = caseLedgerSummary([row({ marks: 'W-' }), row({ marks: 'W-' })], 'c')
      check(allW.runs === 2 && allW.failures === 2 && allW.score === null, 'dry run: a case whose runs are all W- shows no score')
    }

    // 15. a run killed by SIGKILL leaves its temp worktree on hillclimb/<run>: --resume clears it (ours only); SIGHUP is handled like SIGTERM
    {
      const repo = repoFor()
      const child = join(repo, 'child.mjs')
      writeFileSync(child, `import { climb } from ${JSON.stringify(new URL('./hillclimb-lib.mjs', import.meta.url).href)}
const [repo, run] = process.argv.slice(2)
const evaluator = { async evaluate(wt, cases) { return { perCase: Object.fromEntries(cases.map((name) => [name, { score: 0.4, scores: [0.4], marks: [], invocation: 'inv-' + name }])), mean: 0.4, cost: 0, failed: [] } } }
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
      check(kept.train_invocations === 'inv-t1=inv-t1;inv-t2=inv-t2'.replace('inv-t1=inv-t1', 't1=inv-t1').replace('inv-t2=inv-t2', 't2=inv-t2'), `resume details: the kept row stores the invocation ids; got ${kept.train_invocations}`)
      mkdirSync(join(repo, 'evals/.results/inv-t1'), { recursive: true })
      writeFileSync(join(repo, 'evals/.results/inv-t1/t1--1.md'), '# t1\n\n## Failures\n\n- expected the stale-state finding\n\n## Final message of the subagent\n\nreported nothing\n')
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
const inv = 'inv-' + name
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
      check(budgetOf('c1') === 40 && budgetOf('c2') < 40, `evaluator: a case started while another runs gets a lane budget less its reserve (c1 ${budgetOf('c1')}, c2 ${budgetOf('c2')})`)
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
  } finally {
    for (const dir of cleanups) {
      try {
        execFileSync('git', ['worktree', 'prune'], { cwd: dir, stdio: 'ignore' })
      } catch {
        // already gone
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
  if (problems.length) {
    console.error(`✘ hillclimb self-test: ${problems.length} problem(s)\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
    return false
  }
  console.log('✔ hillclimb self-test: metric, kept edit and its commit, train noise, holdout drop, bounds (outside, frontmatter, created file), cap, stop predicate, resume, failed-baseline resume refusal, no headroom, ledger spend (timed-out editor, resume, --jobs reserve), pending passthrough, short runs, editor argv, evaluator passthrough, no git identity, default split, killed-run worktree on resume (SIGKILL, SIGHUP), resume details')
  return true
}
