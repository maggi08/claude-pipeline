/**
 * The loop of scripts/hillclimb.mjs: an opus editor makes ONE edit to an agent's method, the eval cases decide whether it stays. Split from the CLI so that the self-test
 * (scripts/hillclimb-test.mjs, free, in CI through validate.mjs) drives the same code with a stub editor and a scripted evaluator.
 *
 * Never edits the checkout it is started from (D5): the work happens in a temp git worktree on a new local branch `hillclimb/<run>`; the only things written in the starting
 * checkout are evals/hillclimb/<run>/decision.tsv, its ledger rows and its eval results.
 */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { appendLedger, meanCost, readLedger, spentSince } from './eval-lib.mjs'

// pro-review-cross-stage-dup is out of the default train: every recorded run of it is W- («Task was denied although the harness allows it»), a harness failure that says nothing about the agent.
export const DEFAULT_TRAIN = ['pro-review-recall-logic', 'pro-review-recall-parity', 'pro-review-language-en']
export const DEFAULT_HOLDOUT = ['pro-review-clean-ac', 'pro-review-language-ru']
export const MIN_GAIN = 0.1
const EPS = 1e-9
const EDITOR_CASE = 'hillclimb-editor'

/**
 * The ledger rows of one run: the eval runs carry `--label hillclimb:<run>` (plugin_ref `working-tree+hillclimb:<run>`), the editor rows `hillclimb:<run>`. The spend of a run is
 * the sum of these rows, whatever the loop saw: a crashed eval, a timed-out editor and an earlier part of a resumed run are all in it.
 */
export const climbLabel = (run) => `hillclimb:${run}`
const ofRun = (row, run) => row.plugin_ref === climbLabel(run) || String(row.plugin_ref ?? '').endsWith(`+${climbLabel(run)}`)
export const spentByRun = (ledger, run, name = null) => ledger.filter((row) => ofRun(row, run) && (name === null || row.case === name)).reduce((sum, row) => sum + Number(row.cost_usd || 0), 0)

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 26 })

/**
 * `-c user.name=… -c user.email=…` for a commit the loop makes: the checkout's own identity (git config, local then global) when it has one, else a neutral `hillclimb`
 * identity. A runner with no global identity, or `user.useConfigOnly=true`, would otherwise make the kept-edit commit crash after the paid evals that earned it.
 */
export const FALLBACK_IDENTITY = { name: 'hillclimb', email: 'hillclimb@localhost' }
export function identityArgs(cwd) {
  const read = (key) => {
    try {
      return git(cwd, 'config', '--get', key).trim()
    } catch {
      return ''
    }
  }
  return ['user.name', 'user.email'].flatMap((key) => ['-c', `${key}=${read(key) || FALLBACK_IDENTITY[key.slice(5)]}`])
}

// ── the metric (14c) ────────────────────────────────────────────────────────────────────────────────────────────────

const POSITIVE = 'EN' // expect, findings
const NEGATIVE = 'FSM' // forbid, forbidSummary, findingsForbid

/**
 * One run from its ledger marks: hit positive graders / their count − violated negative graders / their count. Null for a harness failure (`W-`): that run says nothing
 * about the agent. A side with no graders contributes 0.
 */
export function runScore(marks) {
  const tokens = String(marks ?? '').split(/\s+/).filter(Boolean)
  if (tokens.some((token) => token.startsWith('W'))) return null
  let [pos, hit, neg, violated] = [0, 0, 0, 0]
  for (const token of tokens) {
    const [, letter, ok] = /^([A-Z])\d+([+-])$/.exec(token) ?? []
    if (!letter) continue
    if (POSITIVE.includes(letter)) {
      pos++
      if (ok === '+') hit++
    } else if (NEGATIVE.includes(letter)) {
      neg++
      if (ok === '-') violated++
    }
  }
  if (!pos && !neg) return null
  return (pos ? hit / pos : 0) - (neg ? violated / neg : 0)
}

export const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
export const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null)

/** A case scores the median of its runs, a split the mean of its cases. `perCase`: { name: { score } }. */
export const splitMean = (perCase) => mean(Object.values(perCase).map((entry) => entry.score))

// ── decision.tsv ────────────────────────────────────────────────────────────────────────────────────────────────────

export const DECISION_COLUMNS = ['attempt', 'ts', 'kind', 'files', 'summary', 'train_cases', 'train_invocations', 'train_mean', 'holdout_cases', 'holdout_mean', 'decision', 'cost_usd', 'cumulative_usd', 'commit']
const cell = (value) => String(value ?? '').replace(/[\t\r\n]+/g, ' ')
const num = (value) => (value === null || value === undefined ? '' : Number(value).toFixed(3))
export const casesCell = (perCase) => Object.entries(perCase ?? {}).map(([name, entry]) => `${name}=${num(entry.score)}`).join(';')
/** `name=<eval invocation id>;…` — the id names the evals/.results/<id>/ directory the editor's miss excerpts are rebuilt from after a resume. */
export const invocationsCell = (perCase) => Object.entries(perCase ?? {}).filter(([, entry]) => entry.invocation).map(([name, entry]) => `${name}=${entry.invocation}`).join(';')
const trainCells = (perCase) => ({ train_cases: casesCell(perCase), train_invocations: invocationsCell(perCase) })

export const decisionPath = (repo, run) => join(repo, 'evals/hillclimb', run, 'decision.tsv')

export function decisionHeader({ run, agent, base, train, holdout, runs, target, minAttempts, maxIterations, capUsd, editorModel, editorBudget }) {
  return [
    `# hillclimb decision log — run ${run}, agent ${agent}`,
    `# base: ${base} (branch hillclimb/${run})`,
    `# train: ${train.join(', ')}`,
    `# holdout: ${holdout.join(', ')}`,
    `# runs per case: ${runs}`,
    '# metric: per run = hit positive graders (expect, findings) / their count − violated negative graders (forbid, findingsForbid, forbidSummary) / their count; case = median of its runs; split = mean of its cases',
    `# keep: train mean >= best train mean so far + ${MIN_GAIN} (one grader flip in one case's median) AND holdout mean >= the baseline holdout mean; otherwise the edit is undone by path`,
    `# stop: (train mean >= ${target} AND attempts >= ${minAttempts}) OR attempts >= ${maxIterations} OR no headroom (best train mean + ${MIN_GAIN} > 1: no edit could be kept, stopped-no-headroom) OR the cap: no eval or editor call starts whose estimate, on top of the ledger spend of this run, passes $${capUsd}; the reason is the last row`,
    `# editor: ${editorModel}, at most $${editorBudget} per call; one edit in skills/${agent}/references/ or the body of agents/${agent}.md`,
    DECISION_COLUMNS.join('\t'),
  ].join('\n')
}

export const formatRow = (row) => DECISION_COLUMNS.map((column) => cell(row[column])).join('\t')

export function parseDecision(text) {
  const meta = {}
  const rows = []
  let columns = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (line.startsWith('#')) {
      const [, key, value] = /^#\s*([\w ]+?):\s*(.*)$/.exec(line) ?? []
      if (key) meta[key] = value
      continue
    }
    if (!columns) {
      columns = line.split('\t')
      continue
    }
    rows.push(Object.fromEntries(line.split('\t').map((value, i) => [columns[i], value])))
  }
  return { meta, rows }
}

export function appendDecision(path, row, headerText) {
  mkdirSync(dirname(path), { recursive: true })
  if (!existsSync(path)) writeFileSync(path, `${headerText}\n`)
  appendFileSync(path, `${formatRow(row)}\n`)
}

// ── the bounds of an edit and its undo ──────────────────────────────────────────────────────────────────────────────

const FRONTMATTER = /^---\n[\s\S]*?\n---\n/

/** Paths changed in the worktree against HEAD: tracked edits and deletions, staged or not, and untracked files (each file, not the directory). */
export function changedPaths(worktree) {
  const out = git(worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
  const entries = out.split('\0').filter(Boolean)
  const result = []
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2)
    result.push({ path: entries[i].slice(3), status })
    if (/[RC]/.test(status)) i++ // a rename lists its source next
  }
  return result
}

/** The violations of the edit's bounds: only `skills/<agent>/references/**` and the BODY of `agents/<agent>.md` (frontmatter byte-identical) may change. */
export function boundsViolations({ worktree, agent, changed }) {
  const references = `plugins/stage-pipeline/skills/${agent}/references/`
  const agentFile = `plugins/stage-pipeline/agents/${agent}.md`
  const violations = []
  for (const { path, status } of changed) {
    if (path.startsWith(references) && !path.slice(references.length).split('/').includes('..')) continue
    if (path === agentFile) {
      if (status.includes('D') || !existsSync(join(worktree, path))) {
        violations.push(`${path}: the agent file was deleted`)
        continue
      }
      const before = FRONTMATTER.exec(git(worktree, 'show', `HEAD:${path}`))?.[0]
      const after = FRONTMATTER.exec(readFileSync(join(worktree, path), 'utf8'))?.[0]
      if (before !== after) violations.push(`${path}: the frontmatter changed`)
      continue
    }
    violations.push(`${path}: outside skills/${agent}/references/ and the body of agents/${agent}.md`)
  }
  return violations
}

/**
 * Undo an attempt by path, never `reset --hard` / `clean`: a path that exists at HEAD is restored with `git checkout HEAD -- <paths>`, a file the editor created is
 * deleted (and its emptied directories). Throws when the worktree is not clean afterwards.
 */
export function undoChanges(worktree, changed) {
  const restore = []
  for (const { path } of changed) {
    let tracked = true
    try {
      git(worktree, 'cat-file', '-e', `HEAD:${path}`)
    } catch {
      tracked = false
    }
    if (tracked) restore.push(path)
    else {
      git(worktree, 'rm', '--cached', '--ignore-unmatch', '-q', '--', path)
      rmSync(join(worktree, path), { force: true })
      for (let dir = dirname(join(worktree, path)); dir.startsWith(worktree + sep) && dir !== worktree; dir = dirname(dir)) {
        try {
          rmdirSync(dir)
        } catch {
          break
        }
      }
    }
  }
  if (restore.length) git(worktree, 'checkout', 'HEAD', '--', ...restore)
  const left = changedPaths(worktree)
  if (left.length) throw new Error(`the worktree is not clean after the undo: ${left.map((entry) => entry.path).join(', ')}`)
}

// ── the temp worktree ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A run killed by SIGKILL (or by a signal during the editor call, or SIGHUP before the handler) leaves its temp worktree registered on `hillclimb/<run>`, and `git worktree add`
 * then refuses the branch. On resume: prune, and remove a worktree still registered on the branch only when it is one of ours — `<os.tmpdir()>/hc-*\/wt`. Any other path is not touched
 * (the error names it).
 */
export function clearStaleWorktree(repo, branch) {
  git(repo, 'worktree', 'prune')
  const real = (path) => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
  let current = null
  for (const line of git(repo, 'worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice(9)
    else if (line === `branch refs/heads/${branch}` && current) {
      const holder = dirname(current)
      if (basename(current) !== 'wt' || !/^hc-/.test(basename(holder)) || real(dirname(holder)) !== real(tmpdir())) throw new Error(`branch ${branch} is checked out at ${current}, which is not a hill-climb temp worktree: remove it yourself, then resume`)
      git(repo, 'worktree', 'remove', '--force', current)
      git(repo, 'worktree', 'prune')
      rmSync(holder, { recursive: true, force: true })
    }
  }
}

/** A temp worktree under os.tmpdir() on `hillclimb/<run>` (new from HEAD, or the existing branch when `resume`). `remove()` deletes the worktree and keeps the branch. */
export function makeWorktree(repo, run, { resume = false } = {}) {
  const holder = mkdtempSync(join(tmpdir(), 'hc-'))
  const dir = join(holder, 'wt')
  const branch = `hillclimb/${run}`
  if (resume) {
    clearStaleWorktree(repo, branch)
    git(repo, 'worktree', 'add', dir, branch)
  } else git(repo, 'worktree', 'add', '-b', branch, dir, 'HEAD')
  return {
    dir, branch, holder,
    remove() {
      try {
        git(repo, 'worktree', 'remove', '--force', dir)
      } catch {
        rmSync(dir, { recursive: true, force: true })
        try {
          git(repo, 'worktree', 'prune')
        } catch {
          // nothing to prune
        }
      }
      rmSync(holder, { recursive: true, force: true })
    },
  }
}

// ── the real evaluator: the worktree's own scripts/eval.mjs ─────────────────────────────────────────────────────────

/**
 * Runs each case through `<worktree>/scripts/eval.mjs` (so the plugin copy it tests is the edited one), `jobs` cases at a time, with EVAL_LEDGER / EVAL_RESULTS pointing at
 * the starting checkout, `--label hillclimb:<run>` on every call (the ledger rows tell the run's spend and are never a release row), and `--budget-usd/--budget-since` passed
 * through. A case that is not under evals/cases/ but under evals/pending/ of the worktree is run with `--pending`. Before each case starts, the estimates of the cases already
 * running (what they have not spent yet) are reserved: the run's cap `capUsd` and the lane budget are checked against the ledger spend + that reserve + this case's estimate, and
 * the lane budget handed to the child is what the others leave. A case that does not fit is not started (`capped` names it). Scores come from the ledger rows of the invocation;
 * a case with fewer graded runs than `runs` (a harness failure, a budget exit, a crash) is `failed`, never scored on what is left.
 */
export function makeEvaluator({ repo, run, runs, jobs = 1, budgetUsd, budgetSince, capUsd, ledgerPath, resultsDir, nodeBin = process.execPath }) {
  const isPending = (worktree, name) => !existsSync(join(worktree, 'evals/cases', name, 'case.json')) && existsSync(join(worktree, 'evals/pending', name, 'case.json'))
  const runOne = (worktree, name, budget) =>
    new Promise((resolve) => {
      const args = [join(worktree, 'scripts/eval.mjs'), '--runs', String(runs), ...(run ? ['--label', climbLabel(run)] : []), ...(isPending(worktree, name) ? ['--pending'] : []), ...(budget ? ['--budget-usd', String(budget)] : []), ...(budgetUsd && budgetSince ? ['--budget-since', budgetSince] : []), name]
      const child = spawn(nodeBin, args, { cwd: worktree, env: { ...process.env, EVAL_LEDGER: ledgerPath, EVAL_RESULTS: resultsDir }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (chunk) => (out += chunk))
      child.stderr.on('data', (chunk) => (out += chunk))
      child.on('error', (error) => resolve({ name, status: -1, out: String(error) }))
      child.on('close', (status) => resolve({ name, status, out }))
    })
  return {
    async evaluate(worktree, cases) {
      const results = []
      const queue = [...cases]
      const inflight = new Map()
      let capped = null
      await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
        while (queue.length && !capped) {
          const name = queue.shift()
          const ledger = readLedger(ledgerPath)
          const estimate = estimateEval(ledger, [name], runs)
          const reserved = [...inflight].reduce((sum, [other, entry]) => sum + Math.max(0, entry.estimate - (spentByRun(ledger, run, other) - entry.before)), 0)
          const spent = spentByRun(ledger, run)
          const lane = budgetUsd ? spentSince(ledger, budgetSince ?? '') : 0
          if (capUsd && spent + reserved + estimate > capUsd + EPS) capped = `${name} not started: spent $${spent.toFixed(2)} + $${reserved.toFixed(2)} reserved for the cases running + ~$${estimate.toFixed(2)} would pass the cap $${capUsd}`
          else if (budgetUsd && lane + reserved + estimate > budgetUsd + EPS) capped = `${name} not started: lane spend $${lane.toFixed(2)} + $${reserved.toFixed(2)} reserved + ~$${estimate.toFixed(2)} would pass the lane budget $${budgetUsd}`
          if (capped) break
          inflight.set(name, { estimate, before: spentByRun(ledger, run, name) })
          results.push(await runOne(worktree, name, budgetUsd ? Math.max(0.01, budgetUsd - reserved) : undefined))
          inflight.delete(name)
        }
      }))
      const ledger = readLedger(ledgerPath)
      const perCase = {}
      let cost = 0
      const failed = []
      for (const name of cases) {
        const result = results.find((entry) => entry.name === name)
        if (!result) continue // not started: `capped` says why
        const invocation = /invocation (\S+)/.exec(result.out)?.[1]
        const rows = invocation ? ledger.filter((row) => row.invocation === invocation && row.case === name) : []
        cost += rows.reduce((sum, row) => sum + Number(row.cost_usd || 0), 0)
        const scores = rows.map((row) => runScore(row.marks)).filter((score) => score !== null)
        if (!rows.length || scores.length < runs || result.status === 2 || result.status === -1) {
          const what = !rows.length ? 'no run recorded' : `${scores.length} of ${runs} runs graded (${rows.length - scores.length} harness failure or ungraded, ${runs - rows.length} not run)`
          failed.push(`${name}: ${what} (exit ${result.status}) ${result.out.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}`)
          continue
        }
        perCase[name] = { score: median(scores), scores, invocation, marks: rows.map((row) => row.marks) }
      }
      return { perCase, mean: failed.length || capped ? null : splitMean(perCase), cost, failed, capped }
    },
  }
}

// ── the editor ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The `claude -p` argv of the editor, settings isolated the way scripts/eval.mjs isolates a run: only project settings, no MCP, no session, dontAsk, six tools. */
export function editorArgs({ prompt, model, budget }) {
  return [
    '-p', prompt, '--model', model,
    '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk',
    '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
    // The cases and their graders are the measurement: the editor sees the misses of the train cases in its prompt and nothing of the holdout.
    '--disallowedTools', 'Read(./evals/**)', 'Grep(./evals/**)', 'Glob(./evals/**)', 'Edit(./evals/**)', 'Write(./evals/**)',
    '--max-budget-usd', String(budget), '--output-format', 'json',
  ]
}

const excerpt = (text, max) => (text.length > max ? `${text.slice(0, max)}\n… (cut)` : text)

/** What went wrong in the train runs: the Failures section and the head of the final message of up to two failing runs per case, from evals/.results. */
export function missExcerpts(train, resultsDir, perCaseChars = 2400) {
  const parts = []
  for (const [name, entry] of Object.entries(train?.perCase ?? {})) {
    const dir = entry.invocation ? join(resultsDir, entry.invocation) : null
    const available = Boolean(dir && existsSync(dir))
    const files = available ? readdirSync(dir).filter((file) => file.startsWith(`${name}--`) && file.endsWith('.md')).sort() : []
    const bad = files.map((file) => readFileSync(join(dir, file), 'utf8')).filter((text) => !/## Failures\n\n—/.test(text))
    const shown = bad.slice(0, 2).map((text) => {
      const failures = /## Failures\n\n([\s\S]*?)\n\n## /.exec(text)?.[1] ?? ''
      const final = /## Final message of the subagent\n\n([\s\S]*)$/.exec(text)?.[1] ?? ''
      return `Failures:\n${failures}\nFinal message (head):\n${excerpt(final.trim(), 700)}`
    })
    parts.push(`### ${name} — score ${num(entry.score)} (runs: ${entry.scores.map(num).join(', ')}; marks: ${(entry.marks ?? []).join(' | ')})\n${available ? shown.join('\n---\n') || '(every run passed every grader)' : entry.resumed ? '(details unavailable after resume)' : '(details unavailable: no results of this evaluation on disk)'}`)
  }
  return excerpt(parts.join('\n\n'), perCaseChars * Math.max(1, Object.keys(train?.perCase ?? {}).length))
}

export function editorPrompt({ agent, run, attempt, baseline, best, train, history, resultsDir, holdoutNames }) {
  const lines = history.filter((row) => row.kind === 'attempt').map((row) => `- #${row.attempt} ${row.decision}: ${row.summary || '(no summary)'} [files: ${row.files || '-'}; train ${row.train_mean || '-'}, holdout ${row.holdout_mean || '-'}]`)
  return [
    `You are improving how the \`${agent}\` agent of a code-review plugin finds problems. Its method lives in two places: the reference files under plugins/stage-pipeline/skills/${agent}/references/ and the body (everything after the frontmatter) of plugins/stage-pipeline/agents/${agent}.md. Its main skill file plugins/stage-pipeline/skills/${agent}/SKILL.md is context: read it, do not edit it.`,
    '',
    `Make exactly ONE focused edit (attempt ${attempt} of run ${run}) that you expect to make the agent catch more of the real problems it misses, or raise fewer false findings, on the cases below. Prefer a general rule or lens over a rule that names the code in an example: an edit that only memorises one case is thrown away by a held-out check you cannot see.`,
    '',
    'Rules:',
    `- Allowed: edit or create files under plugins/stage-pipeline/skills/${agent}/references/, or edit the body of plugins/stage-pipeline/agents/${agent}.md. The frontmatter (the lines between the first two ---) must stay byte-identical.`,
    '- Anything else you change is rejected and undone. Do not read or edit anything under evals/: the measurement is not yours to see; everything you need is below.',
    '- Keep the edit small and in the file where the reader of that method looks for it. Do not make the agent longer-winded; its report is read by people.',
    `- Finish with one line \`EDIT: <what you changed and why, under 200 characters>\`.`,
    '',
    `Scores (metric: hit positive graders / their count − violated negative graders / their count; case = median of its runs; split = mean of cases). Baseline train ${num(baseline.train)}, best so far ${num(best)}, held-out split baseline ${num(baseline.holdout)} (cases ${holdoutNames.length}; their details are hidden on purpose).`,
    '',
    'Train cases of the last evaluation of the kept state:',
    missExcerpts(train, resultsDir),
    '',
    history.some((row) => row.kind === 'attempt') ? `Attempts so far (do not repeat a rejected idea):\n${lines.join('\n')}` : 'No attempt yet.',
  ].join('\n')
}

function parseEditorOutput(stdout) {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return {}
  }
  return Array.isArray(parsed) ? parsed.filter((event) => event.type === 'result').pop() ?? {} : parsed
}

function runEditor(bin, args, cwd, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const killChild = () => child.kill('SIGKILL')
    process.once('exit', killChild)
    const timer = setTimeout(killChild, timeoutMs)
    const done = (result) => {
      clearTimeout(timer)
      process.removeListener('exit', killChild)
      resolveRun({ stdout, stderr, ...result })
    }
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => done({ status: null, signal: null, error }))
    child.on('close', (status, signal) => done({ status, signal, error: null }))
  })
}

/**
 * One `claude -p` call by the editor model in the worktree. Appends a ledger row (case `hillclimb-editor`) so the budget counts it. Returns { ok, cost, summary }.
 */
export function makeEditor({ repo, run, model = 'opus', budget = 1.5, ledgerPath, resultsDir, claudeBin = 'claude', timeoutSec = 900 }) {
  return {
    model,
    budget,
    async edit({ worktree, attempt, context }) {
      const prompt = editorPrompt({ ...context, run, attempt, resultsDir })
      const started = Date.now()
      // Async, not spawnSync: a SIGTERM/SIGHUP to this process is handled at once (the temp worktree removed, the child killed) and not after a 15-minute call.
      const ran = await runEditor(claudeBin, editorArgs({ prompt, model, budget }), worktree, timeoutSec * 1000)
      const final = parseEditorOutput(ran.stdout)
      // A call that timed out (killed, no output) or reported no cost may have spent up to its --max-budget-usd: the ledger is charged that.
      const unknownCost = ran.error || ran.signal || typeof final.total_cost_usd !== 'number'
      const cost = unknownCost ? budget : Number(final.total_cost_usd)
      const sha = git(worktree, 'rev-parse', 'HEAD').trim()
      appendLedger({
        ts: new Date().toISOString(), invocation: `hillclimb-${run}`, case: EDITOR_CASE, attempt, plugin_ref: climbLabel(run), plugin_version: '', plugin_sha: sha,
        claude_version: '', models: model, marks: 'edit', pass: final.is_error || ran.status !== 0 ? 0 : 1, cost_usd: cost.toFixed(4), seconds: Math.round((Date.now() - started) / 1000),
      }, ledgerPath)
      const ok = ran.status === 0 && !final.is_error && typeof final.result === 'string'
      const text = String(final.result ?? '')
      const summary = (/^EDIT:\s*(.+)$/m.exec(text)?.[1] ?? text.split('\n').find((line) => line.trim()) ?? String(ran.stderr ?? '').trim().split('\n')[0] ?? '').slice(0, 200)
      return { ok, cost, summary: ok ? summary : `editor failed: ${final.subtype ?? ''} ${summary}`.trim() }
    },
  }
}

/**
 * The last kept train evaluation from its decision row after a resume: scores from `train_cases`, and, for each case whose invocation id is in `train_invocations`, its runs' scores and
 * marks from that invocation's ledger rows, so the editor's miss excerpts can be rebuilt from evals/.results/<id>/. A row without the ids (an older log) has no details: the prompt says so.
 */
export function resumedTrain(ledger, row) {
  const invocations = Object.fromEntries(String(row.train_invocations ?? '').split(';').filter(Boolean).map((part) => [part.split('=')[0], part.slice(part.indexOf('=') + 1)]))
  return Object.fromEntries(String(row.train_cases ?? '').split(';').filter(Boolean).map((part) => {
    const name = part.split('=')[0]
    const invocation = invocations[name]
    const rows = invocation ? ledger.filter((entry) => entry.invocation === invocation && entry.case === name) : []
    return [name, { score: Number(part.split('=')[1]), scores: rows.map((entry) => runScore(entry.marks)).filter((score) => score !== null), marks: rows.map((entry) => entry.marks), invocation, resumed: true }]
  }))
}

/** Per case, what the ledger says (the dry run prints it): runs, harness failures (`W-`), and the last invocation's median score and marks. */
export function caseLedgerSummary(ledger, name) {
  const rows = ledger.filter((row) => row.case === name).sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  const failures = rows.filter((row) => /(^|\s)W-/.test(row.marks ?? '')).length
  const last = rows.filter((row) => row.invocation === rows.at(-1)?.invocation)
  const scores = last.map((row) => runScore(row.marks)).filter((score) => score !== null)
  return { runs: rows.length, failures, score: median(scores), marks: last.map((row) => row.marks).join(' | ') }
}

// ── estimates ───────────────────────────────────────────────────────────────────────────────────────────────────────

const FALLBACK_RUN_COST = 0.5
export const estimateEval = (ledger, cases, runs) => cases.reduce((sum, name) => sum + (meanCost(ledger, name) ?? FALLBACK_RUN_COST) * runs, 0)
export const estimateEdit = (ledger, budget) => meanCost(ledger, EDITOR_CASE) ?? budget

// ── the loop ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Runs the climb. `cfg`: { repo, run, agent, train, holdout, runs, maxIterations, minAttempts, target, capUsd, budgetUsd, budgetSince, ledgerPath, resume, editorModel, editorBudget }.
 * `deps`: { evaluator: { evaluate(worktree, cases) → { perCase, mean, cost, failed } }, editor: { edit({ worktree, attempt, context }) → { ok, cost, summary }, model, budget },
 * log }. Returns { rows, branch, stopped }.
 */
export async function climb(cfg, deps) {
  const { repo, run, agent, runs } = cfg
  const log = deps.log ?? (() => {})
  const path = decisionPath(repo, run)
  let { train, holdout } = cfg
  let prior = { meta: {}, rows: [] }
  if (cfg.resume) {
    if (!existsSync(path)) throw new Error(`--resume ${run}: no ${relative(repo, path)}`)
    prior = parseDecision(readFileSync(path, 'utf8'))
    const baselineRow = prior.rows.find((row) => row.kind === 'baseline')
    if (!baselineRow) throw new Error(`--resume ${run}: ${relative(repo, path)} has no baseline row: start the run again`)
    if (baselineRow.decision !== 'baseline') throw new Error(`--resume ${run}: the baseline failed (${baselineRow.decision}: ${baselineRow.summary}): start a new run, a resume would take its empty scores for 0`)
    train = prior.meta.train.split(', ')
    holdout = prior.meta.holdout.split(', ')
  } else if (existsSync(path)) {
    throw new Error(`${relative(repo, path)} exists: pick another --run or continue it with --resume ${run}`)
  }

  const ledgerNow = () => readLedger(cfg.ledgerPath)
  const wt = makeWorktree(repo, run, { resume: cfg.resume })
  const onSignal = () => {
    wt.remove()
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  process.once('SIGHUP', onSignal)
  try {
    const startSha = git(wt.dir, 'rev-parse', 'HEAD').trim()
    const header = decisionHeader({ ...cfg, train, holdout, base: cfg.resume ? prior.meta.base?.split(' ')[0] ?? startSha : startSha, editorModel: deps.editor.model ?? cfg.editorModel, editorBudget: deps.editor.budget ?? cfg.editorBudget })
    const rows = [...prior.rows]
    // The spend is the ledger's: every row this run wrote (its evals and its editor calls, an earlier part of a resumed run included), not what the loop saw.
    const spent = () => spentByRun(ledgerNow(), run)
    const write = (row) => {
      appendDecision(path, row, header)
      rows.push(row)
      log(`#${row.attempt} ${row.kind} ${row.decision}${row.summary ? ` — ${row.summary}` : ''}${row.train_mean ? ` · train ${row.train_mean}` : ''}${row.holdout_mean ? ` · holdout ${row.holdout_mean}` : ''} · $${Number(row.cumulative_usd).toFixed(2)}`)
    }
    const stamp = () => new Date().toISOString()
    const stop = (decision, summary, extra = {}) => {
      write({ attempt: rows.filter((row) => row.kind === 'attempt').length, ts: stamp(), kind: 'stop', summary, decision, cost_usd: '0.0000', cumulative_usd: spent().toFixed(4), commit: git(wt.dir, 'rev-parse', 'HEAD').trim(), ...extra })
    }
    // Would the next call pass the cap or the lane budget? The estimate counts, the money is not spent yet.
    const room = (estimate) => {
      const now = spent()
      if (now + estimate > cfg.capUsd + EPS) return `a call estimated at $${estimate.toFixed(2)} would pass the cap $${cfg.capUsd} (spent $${now.toFixed(2)})`
      if (cfg.budgetUsd && spentSince(ledgerNow(), cfg.budgetSince ?? '') + estimate > cfg.budgetUsd + EPS) return `a call estimated at $${estimate.toFixed(2)} would pass the lane budget $${cfg.budgetUsd}`
      return null
    }
    if (cfg.resume) {
      const keptTip = [...rows].reverse().find((row) => row.kind === 'baseline' || row.decision === 'kept')?.commit
      if (keptTip && startSha !== keptTip) throw new Error(`--resume ${run}: branch ${wt.branch} is at ${startSha.slice(0, 9)}, the last kept commit in decision.tsv is ${keptTip.slice(0, 9)}: look at the branch before continuing`)
      writeFileSync(path, `${readFileSync(path, 'utf8')}# resumed ${stamp()}: target ${cfg.target}, min attempts ${cfg.minAttempts}, max iterations ${cfg.maxIterations}, cap $${cfg.capUsd}\n`)
    }

    const ctx = { run, ledgerPath: cfg.ledgerPath }
    // The baseline: the unedited HEAD on both splits.
    let baseline
    let best
    let lastTrain
    if (!cfg.resume) {
      const estimate = estimateEval(ledgerNow(), [...train, ...holdout], runs)
      const blocked = room(estimate)
      if (blocked) {
        stop('stopped-cap', `baseline not started: ${blocked}`)
        return { rows, branch: wt.branch, stopped: 'stopped-cap' }
      }
      const before = spent()
      const base = await evalSplit(deps, wt.dir, train, holdout, ctx)
      const baseCost = () => (spent() - before).toFixed(4)
      if (base.capped) {
        write({ attempt: 0, ts: stamp(), kind: 'baseline', summary: `baseline stopped: ${base.capped}`.slice(0, 300), decision: 'stopped-cap', cost_usd: baseCost(), cumulative_usd: spent().toFixed(4), commit: startSha })
        return { rows, branch: wt.branch, stopped: 'stopped-cap' }
      }
      if (base.failed.length) {
        // A case whose baseline runs are harness failures, or fewer than --runs, is named here: scoring it on what is left would put a made-up number under every later comparison.
        write({ attempt: 0, ts: stamp(), kind: 'baseline', summary: `eval failed: ${base.failed.join('; ').slice(0, 300)}`, decision: 'stopped-eval-failed', cost_usd: baseCost(), cumulative_usd: spent().toFixed(4), commit: startSha })
        return { rows, branch: wt.branch, stopped: 'stopped-eval-failed' }
      }
      write({ attempt: 0, ts: stamp(), kind: 'baseline', summary: 'unedited HEAD', ...trainCells(base.train.perCase), train_mean: num(base.train.mean), holdout_cases: casesCell(base.holdout.perCase), holdout_mean: num(base.holdout.mean), decision: 'baseline', cost_usd: baseCost(), cumulative_usd: spent().toFixed(4), commit: startSha })
      baseline = { train: base.train.mean, holdout: base.holdout.mean }
      best = base.train.mean
      lastTrain = base.train
    } else {
      const baseRow = rows.find((row) => row.kind === 'baseline')
      baseline = { train: Number(baseRow.train_mean), holdout: Number(baseRow.holdout_mean) }
      best = Math.max(baseline.train, ...rows.filter((row) => row.decision === 'kept').map((row) => Number(row.train_mean)))
      lastTrain = { perCase: resumedTrain(ledgerNow(), (rows.filter((row) => row.decision === 'kept').at(-1) ?? baseRow)), mean: best }
    }

    for (;;) {
      const numbered = rows.filter((row) => row.kind === 'attempt').length
      // The keep rule is best + MIN_GAIN on a mean that cannot pass 1: with no headroom no edit can be kept, and every editor + eval round would be money for nothing.
      if (best + MIN_GAIN > 1 + EPS) {
        stop('stopped-no-headroom', `train mean ${num(best)} + ${MIN_GAIN} > 1: no edit can be kept; train on cases with headroom (a pending case: --train pending/<name>)`)
        return { rows, branch: wt.branch, stopped: 'stopped-no-headroom' }
      }
      const ran = rows.filter((row) => row.kind === 'attempt' && !row.decision.startsWith('stopped-')).length
      if (numbered >= cfg.maxIterations) {
        stop('stopped-max-iterations', `${numbered} attempts, the maximum`)
        return { rows, branch: wt.branch, stopped: 'stopped-max-iterations' }
      }
      if (best >= cfg.target - EPS && ran >= cfg.minAttempts) {
        stop('stopped-target', `train mean ${num(best)} >= target ${cfg.target} after ${ran} attempts`)
        return { rows, branch: wt.branch, stopped: 'stopped-target' }
      }
      const attempt = numbered + 1
      const blocked = room(estimateEdit(ledgerNow(), deps.editor.budget ?? cfg.editorBudget))
      if (blocked) {
        stop('stopped-cap', blocked)
        return { rows, branch: wt.branch, stopped: 'stopped-cap' }
      }

      const before = spent()
      const edit = await deps.editor.edit({ worktree: wt.dir, attempt, context: { agent, attempt, baseline, best, train: lastTrain, history: rows, holdoutNames: holdout }, run, ledgerPath: cfg.ledgerPath })
      const changed = changedPaths(wt.dir)
      const files = changed.map((entry) => entry.path).join(', ')
      const row = (fields) => ({ attempt, ts: stamp(), kind: 'attempt', files, summary: edit.summary ?? '', cost_usd: (spent() - before).toFixed(4), cumulative_usd: spent().toFixed(4), commit: '', ...fields })
      const undoAndWrite = (fields) => {
        undoChanges(wt.dir, changed)
        write(row(fields))
      }
      if (!edit.ok) {
        undoAndWrite({ decision: 'editor-failed' })
        continue
      }
      if (!changed.length) {
        write(row({ decision: 'editor-failed', summary: `no edit made: ${edit.summary ?? ''}`.slice(0, 200) }))
        continue
      }
      const violations = boundsViolations({ worktree: wt.dir, agent, changed })
      if (violations.length) {
        undoAndWrite({ decision: 'rejected-bounds', summary: `${edit.summary ?? ''} [${violations.join('; ')}]`.slice(0, 400) })
        continue
      }

      const stopMid = (what, estimate) => {
        const why = room(estimate)
        if (!why) return false
        undoAndWrite({ decision: 'stopped-cap', summary: `${edit.summary ?? ''} [before the ${what}: ${why}]`.slice(0, 400) })
        return true
      }
      if (stopMid('train eval', estimateEval(ledgerNow(), train, runs))) return { rows, branch: wt.branch, stopped: 'stopped-cap' }
      const trainResult = await deps.evaluator.evaluate(wt.dir, train, ctx)
      if (trainResult.capped) {
        undoAndWrite({ decision: 'stopped-cap', summary: `${edit.summary ?? ''} [during the train eval: ${trainResult.capped}]`.slice(0, 400) })
        return { rows, branch: wt.branch, stopped: 'stopped-cap' }
      }
      if (trainResult.failed?.length) {
        undoAndWrite({ decision: 'stopped-eval-failed', summary: `${edit.summary ?? ''} [${trainResult.failed.join('; ')}]`.slice(0, 400) })
        return { rows, branch: wt.branch, stopped: 'stopped-eval-failed' }
      }
      const trainMean = splitMean(trainResult.perCase)
      if (!(trainMean >= best + MIN_GAIN - EPS)) {
        undoAndWrite({ decision: 'rejected-train', ...trainCells(trainResult.perCase), train_mean: num(trainMean) })
        continue
      }
      if (stopMid('holdout eval', estimateEval(ledgerNow(), holdout, runs))) return { rows, branch: wt.branch, stopped: 'stopped-cap' }
      const holdoutResult = await deps.evaluator.evaluate(wt.dir, holdout, ctx)
      if (holdoutResult.capped) {
        undoAndWrite({ decision: 'stopped-cap', ...trainCells(trainResult.perCase), train_mean: num(trainMean), summary: `${edit.summary ?? ''} [during the holdout eval: ${holdoutResult.capped}]`.slice(0, 400) })
        return { rows, branch: wt.branch, stopped: 'stopped-cap' }
      }
      if (holdoutResult.failed?.length) {
        undoAndWrite({ decision: 'stopped-eval-failed', ...trainCells(trainResult.perCase), train_mean: num(trainMean), summary: `${edit.summary ?? ''} [${holdoutResult.failed.join('; ')}]`.slice(0, 400) })
        return { rows, branch: wt.branch, stopped: 'stopped-eval-failed' }
      }
      const holdoutMean = splitMean(holdoutResult.perCase)
      const scored = { ...trainCells(trainResult.perCase), train_mean: num(trainMean), holdout_cases: casesCell(holdoutResult.perCase), holdout_mean: num(holdoutMean) }
      if (holdoutMean < baseline.holdout - EPS) {
        undoAndWrite({ decision: 'rejected-holdout', ...scored })
        continue
      }
      // Kept: its own commit on hillclimb/<run>, the decision.tsv row (without the sha it does not have yet) in the message.
      const kept = row({ decision: 'kept', ...scored })
      git(wt.dir, 'add', '--', ...changed.map((entry) => entry.path))
      git(wt.dir, ...identityArgs(wt.dir), '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `hillclimb(${run}) #${attempt}: ${(edit.summary ?? '').slice(0, 100) || 'edit'}\n\n${DECISION_COLUMNS.join('\t')}\n${formatRow(kept)}`)
      kept.commit = git(wt.dir, 'rev-parse', 'HEAD').trim()
      write(kept)
      best = trainMean
      lastTrain = trainResult
    }
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    process.removeListener('SIGHUP', onSignal)
    wt.remove()
  }
}

async function evalSplit(deps, worktree, train, holdout, ctx) {
  const t = await deps.evaluator.evaluate(worktree, train, ctx)
  // A capped or failed train split has no use for the holdout runs: stop before paying for them.
  const h = t.capped || t.failed?.length ? { perCase: {}, mean: null, failed: [], capped: null } : await deps.evaluator.evaluate(worktree, holdout, ctx)
  return { train: { perCase: t.perCase, mean: t.mean }, holdout: { perCase: h.perCase, mean: h.mean }, capped: t.capped ?? h.capped ?? null, failed: [...(t.failed ?? []), ...(h.failed ?? [])] }
}
