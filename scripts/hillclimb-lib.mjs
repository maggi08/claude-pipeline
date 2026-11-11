/**
 * The loop of scripts/hillclimb.mjs: an opus editor makes ONE edit to an agent's method, the eval cases decide whether it stays. Split from the CLI so that the self-test
 * (scripts/hillclimb-test.mjs, free, in CI through validate.mjs) drives the same code with a stub editor and a scripted evaluator.
 *
 * Never edits the checkout it is started from (D5): the work happens in a temp git worktree on a new local branch `hillclimb/<run>`; the only things written in the starting
 * checkout are evals/hillclimb/<run>/decision.tsv, its ledger rows and its eval results.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { alive } from '../plugins/stage-pipeline/scripts/processes.mjs'
import { INVOCATION_RE, appendLedger, meanCost, newInvocationId, readLedger, spentSince } from './eval-lib.mjs'

// pro-review-cross-stage-dup is out of the default train: every recorded run of it is W- («Task was denied although the harness allows it»), a harness failure that says nothing about the agent.
export const DEFAULT_TRAIN = ['pro-review-recall-logic', 'pro-review-recall-parity', 'pro-review-language-en']
export const DEFAULT_HOLDOUT = ['pro-review-clean-ac', 'pro-review-language-ru']
export const MIN_GAIN = 0.1
const EPS = 1e-9
const EDITOR_CASE = 'hillclimb-editor'
const INFLIGHT_CASE = 'hillclimb-inflight'

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
 * about the agent. A side with no graders contributes 0. A run that fails a grader outside the metric (`D1-` report saved, `L1-`, `T-`, `V-`, … any token other than E/N/F/S/M
 * with `-`) is the WORST run, −1: otherwise an edit that makes the agent drop its report would score as perfect (every F grader passes on a missing report) and be kept.
 */
export function runScore(marks) {
  const tokens = String(marks ?? '').split(/\s+/).filter(Boolean)
  if (tokens.some((token) => token.startsWith('W'))) return null
  let [pos, hit, neg, violated] = [0, 0, 0, 0]
  for (const token of tokens) {
    const [, letter, ok] = /^([A-Z])\d+([+-])$/.exec(token) ?? []
    if (!letter) continue
    if (!POSITIVE.includes(letter) && !NEGATIVE.includes(letter)) {
      if (ok === '-') return -1
      continue
    }
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

/**
 * A run that fails a grader outside the metric (a `-` mark on any token other than E/N/F/S/M; a harness failure `W` is no run at all). The median of a case outvotes one such run in three,
 * so the keep rule counts them apart: see `failureCounts` and `grewFailures`.
 */
export const runFailed = (marks) => {
  const tokens = String(marks ?? '').split(/\s+/).filter(Boolean)
  if (tokens.some((token) => token.startsWith('W'))) return false
  return tokens.some((token) => {
    const [, letter, ok] = /^([A-Z])\d+([+-])$/.exec(token) ?? []
    return ok === '-' && !POSITIVE.includes(letter) && !NEGATIVE.includes(letter)
  })
}
/** `{ case: number of runs that fail a grader outside the metric }`; null for a case whose marks are not known (a resumed case without its invocation's rows). */
export const failureCounts = (perCase) =>
  Object.fromEntries(Object.entries(perCase ?? {}).map(([name, entry]) => [name, Array.isArray(entry.marks) && entry.marks.length ? entry.marks.filter(runFailed).length : null]))
/** The cases whose count of such runs is higher than in `reference` (a case without a known reference count is not compared). */
export const grewFailures = (candidate, reference) => Object.entries(candidate).filter(([name, count]) => count !== null && reference?.[name] != null && count > reference[name]).map(([name]) => `${name} ${reference[name]} → ${candidate[name]}`)

/** A case scores the median of its runs, a split the mean of its cases. `perCase`: { name: { score } }. */
export const splitMean = (perCase) => mean(Object.values(perCase).map((entry) => entry.score))

// ── decision.tsv ────────────────────────────────────────────────────────────────────────────────────────────────────

export const DECISION_COLUMNS = ['attempt', 'ts', 'kind', 'files', 'summary', 'train_cases', 'train_invocations', 'train_mean', 'holdout_cases', 'holdout_invocations', 'holdout_mean', 'decision', 'cost_usd', 'cumulative_usd', 'commit']
const cell = (value) => String(value ?? '').replace(/[\t\r\n]+/g, ' ')
const num = (value) => (value === null || value === undefined ? '' : Number(value).toFixed(3))
export const casesCell = (perCase) => Object.entries(perCase ?? {}).map(([name, entry]) => `${name}=${num(entry.score)}`).join(';')
/** `name=<eval invocation id>;…` — the id names the evals/.results/<id>/ directory the editor's miss excerpts are rebuilt from after a resume. */
export const invocationsCell = (perCase) => Object.entries(perCase ?? {}).filter(([, entry]) => entry.invocation).map(([name, entry]) => `${name}=${entry.invocation}`).join(';')
const trainCells = (perCase) => ({ train_cases: casesCell(perCase), train_invocations: invocationsCell(perCase) })
const holdoutCells = (perCase) => ({ holdout_cases: casesCell(perCase), holdout_invocations: invocationsCell(perCase) })

export const decisionPath = (repo, run) => join(repo, 'evals/hillclimb', run, 'decision.tsv')

export function decisionHeader({ run, agent, base, train, holdout, runs, target, minAttempts, maxIterations, capUsd, editorModel, editorBudget }) {
  return [
    `# hillclimb decision log — run ${run}, agent ${agent}`,
    `# base: ${base} (branch hillclimb/${run})`,
    `# train: ${train.join(', ')}`,
    `# holdout: ${holdout.join(', ')}`,
    `# runs per case: ${runs}`,
    '# metric: per run = hit positive graders (expect, findings) / their count − violated negative graders (forbid, findingsForbid, forbidSummary) / their count; case = median of its runs; split = mean of its cases; a run that fails any other grader (D1 report saved, L, T, V, …) is the worst run, -1, so an edit that makes runs drop their report is never kept',
    '# no new failures: an edit is rejected (rejected-failures) when any train or holdout case has more runs that fail such a grader (a - mark outside E/N/F/S/M) than that case had at the baseline or the last kept state, even when the medians tie or rise',
    `# keep: train mean >= best train mean so far + ${MIN_GAIN} (one grader flip in one case's median) AND holdout mean >= the baseline holdout mean; otherwise the edit is undone by path`,
    `# stop: (train mean >= ${target} AND attempts >= ${minAttempts}) OR attempts >= ${maxIterations} OR no headroom (best train mean + ${MIN_GAIN} > 1: no edit could be kept, stopped-no-headroom) OR the cap: no eval or editor call starts whose estimate, on top of the ledger spend of this run, passes $${capUsd}; the reason is the last row`,
    `# editor: ${editorModel}, at most $${editorBudget} per call; one edit in skills/${agent}/references/ or the body of agents/${agent}.md`,
    DECISION_COLUMNS.join('\t'),
  ].join('\n')
}

export const formatRow = (row, columns = DECISION_COLUMNS) => columns.map((column) => cell(row[column])).join('\t')

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
  // A log started before a column existed keeps its own header: rows are appended in the columns the file has (the plugin adapts to existing state).
  const header = readFileSync(path, 'utf8').split('\n').find((line) => line.trim() && !line.startsWith('#'))
  appendFileSync(path, `${formatRow(row, header ? header.split('\t') : DECISION_COLUMNS)}\n`)
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

/** The real path of `path`, also when it (and some of its parents) no longer exists: the nearest existing ancestor is resolved, the rest is appended. */
const realPath = (path) => {
  const rest = []
  let dir = resolve(path)
  for (;;) {
    try {
      return join(realpathSync(dir), ...rest)
    } catch {
      if (dirname(dir) === dir) return resolve(path)
      rest.unshift(basename(dir))
      dir = dirname(dir)
    }
  }
}
const LOCK_REASON = /^hillclimb pid (\d+)$/

/**
 * Deletes the admin entry of ONE worktree (`<git-common-dir>/worktrees/<id>`, the one whose `gitdir` file names `<path>/.git`) and nothing else. Used when the directory is gone and
 * `git worktree remove` has nothing to work on: never a repo-wide `git worktree prune`, which would also drop the registrations of other checkouts that merely sit on an unmounted disk.
 */
export function dropAdminEntry(repo, path) {
  const common = resolve(repo, git(repo, 'rev-parse', '--git-common-dir').trim())
  const root = join(common, 'worktrees')
  if (!existsSync(root)) return false
  for (const id of readdirSync(root)) {
    let target = ''
    try {
      target = readFileSync(join(root, id, 'gitdir'), 'utf8').trim()
    } catch {
      continue
    }
    if (realPath(dirname(target)) === realPath(path)) {
      rmSync(join(root, id), { recursive: true, force: true })
      return true
    }
  }
  return false
}

/** Removes the worktree at `path` (ours only): unlock, `worktree remove --force`, and when that fails or the directory was already gone, our own admin entry by hand. */
function removeOwnWorktree(repo, path) {
  try {
    git(repo, 'worktree', 'unlock', path)
  } catch {
    // not locked, or not registered
  }
  try {
    git(repo, 'worktree', 'remove', '--force', path)
  } catch {
    rmSync(path, { recursive: true, force: true })
    dropAdminEntry(repo, path)
  }
}

/**
 * A run killed by SIGKILL (or by a signal during the editor call, or SIGHUP before the handler) leaves its temp worktree registered on `hillclimb/<run>`, and `git worktree add`
 * then refuses the branch. On resume: the one worktree registered on the branch is removed only when it is one of ours — `<os.tmpdir()>/hc-*\/wt` — and its owner is gone: the lock reason
 * `hillclimb pid <pid>` names the process, and while it answers the resume stops. Any other path is not touched (the error names it). No other registration is ever pruned or removed.
 */
export function clearStaleWorktree(repo, branch) {
  let current = null
  const entries = []
  for (const line of [...git(repo, 'worktree', 'list', '--porcelain').split('\n'), '']) {
    if (line.startsWith('worktree ')) current = { path: line.slice(9), branch: null, locked: null }
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7)
    else if (current && (line === 'locked' || line.startsWith('locked '))) current.locked = line.slice(7)
    else if (!line && current) {
      entries.push(current)
      current = null
    }
  }
  for (const entry of entries.filter((item) => item.branch === `refs/heads/${branch}`)) {
    const holder = dirname(entry.path)
    if (basename(entry.path) !== 'wt' || !/^hc-/.test(basename(holder)) || realPath(dirname(holder)) !== realPath(tmpdir())) throw new Error(`branch ${branch} is checked out at ${entry.path}, which is not a hill-climb temp worktree: remove it yourself, then resume`)
    const pid = Number(LOCK_REASON.exec(entry.locked ?? '')?.[1])
    if (pid && pid !== process.pid && alive(pid)) throw new Error(`run ${branch.replace(/^hillclimb\//, '')} is still running as pid ${pid} (worktree ${entry.path}): stop it first, then resume`)
    removeOwnWorktree(repo, entry.path)
    rmSync(holder, { recursive: true, force: true })
  }
}

/**
 * A temp worktree under os.tmpdir() on `hillclimb/<run>` (new from HEAD, or the existing branch when `resume`), locked with the owner's pid so that a resume can tell a live run from a
 * dead one. `remove()` deletes the worktree and keeps the branch.
 */
export function makeWorktree(repo, run, { resume = false } = {}) {
  const holder = mkdtempSync(join(tmpdir(), 'hc-'))
  const dir = join(holder, 'wt')
  const branch = `hillclimb/${run}`
  const lock = ['--lock', '--reason', `hillclimb pid ${process.pid}`]
  try {
    if (resume) {
      clearStaleWorktree(repo, branch)
      git(repo, 'worktree', 'add', ...lock, dir, branch)
    } else git(repo, 'worktree', 'add', ...lock, '-b', branch, dir, 'HEAD')
  } catch (error) {
    rmSync(holder, { recursive: true, force: true })
    throw error
  }
  return {
    dir, branch, holder,
    remove() {
      removeOwnWorktree(repo, dir)
      rmSync(holder, { recursive: true, force: true })
    },
  }
}

// ── in-flight marks: charge before spending ─────────────────────────────────────────────────────────────────────────

/**
 * Before a paid call starts (the editor, one eval child) a mark `evals/hillclimb/<run>/inflight/<key>.json` is written: what the call may still spend. A signal charges the marks of the
 * calls it interrupts into the ledger before the process exits, and a resume charges what a SIGKILL left behind; a mark is cleared only after the call's own rows are written. So the
 * spend of an interrupted call is in the ledger — the cap and the lane budget read it from there — even when no row of its own ever came.
 */
export const inflightDir = (repo, run) => join(repo, 'evals/hillclimb', run, 'inflight')
export function markInflight(repo, run, key, data) {
  const dir = inflightDir(repo, run)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${key.replace(/[^\w.-]/g, '_')}.json`)
  writeFileSync(path, JSON.stringify({ ...data, ts: new Date().toISOString() }))
  return path
}
export const clearInflight = (path) => rmSync(path, { force: true })

/**
 * A resume while an eval child of the previous process still answers (its pid is in its mark) would charge the case and then run beside it: it refuses, naming the pid and the run, and
 * kills nothing — the user ends the child, then resumes.
 */
export function assertNoLiveEvalChildren({ repo, run }) {
  const dir = inflightDir(repo, run)
  if (!existsSync(dir)) return
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    let mark = null
    try {
      mark = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch {
      continue
    }
    const pid = Number(mark?.pid)
    if (mark?.kind === 'eval' && pid > 0 && alive(pid)) throw new Error(`eval child pid ${pid} of run ${run} is still running (case ${mark.case}, mark ${join(dir, file)}): stop it first, then resume`)
  }
}

/**
 * What an interrupted eval case has not yet spent: the estimate less the case's spend since the mark, but at least one run's cost bound (`perRun`) while the invocation has recorded fewer
 * runs than `runs` — a run in flight has no row yet, and the estimate may already be covered by its earlier, dearer runs. Marks without those fields (an older log) charge the estimate rule only.
 */
function evalCharge(ledger, run, mark) {
  const remaining = Math.max(0, Number(mark.estimate) - (spentByRun(ledger, run, mark.case) - Number(mark.before || 0)))
  if (!mark.invocation || !(Number(mark.runs) > 0)) return remaining
  const recorded = ledger.filter((row) => row.invocation === mark.invocation && row.case === mark.case).length
  return Math.max(remaining, recorded < Number(mark.runs) ? Number(mark.perRun) || 0 : 0)
}

/** Charges every mark of the run into the ledger (an editor call its whole budget, an eval case what its estimate has not yet spent) and removes it. Returns the dollars charged. */
export function chargeInflight({ repo, run, ledgerPath }) {
  const dir = inflightDir(repo, run)
  if (!existsSync(dir)) return 0
  const ledger = readLedger(ledgerPath)
  let total = 0
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    let mark = null
    try {
      mark = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch {
      // a half-written mark names no amount
    }
    if (mark) {
      const charge = mark.kind === 'editor' ? Number(mark.charge) : evalCharge(ledger, run, mark)
      if (charge > 0) {
        appendLedger({
          ts: new Date().toISOString(), invocation: `hillclimb-${run}`, case: INFLIGHT_CASE, attempt: mark.attempt ?? '', plugin_ref: climbLabel(run), marks: `interrupted ${mark.kind}${mark.case ? ` ${mark.case}` : ''}`,
          pass: 0, cost_usd: charge.toFixed(4),
        }, ledgerPath)
        total += charge
      }
    }
    rmSync(join(dir, file), { force: true })
  }
  return total
}

// ── the real evaluator: the worktree's own scripts/eval.mjs ─────────────────────────────────────────────────────────

// The eval children of this process, each in its own process group (`detached`): a signal to the driver stops them through these, and the exit hook is the net under an uncaught error.
const evalChildren = new Set()
const killEvalChildren = (signal = 'SIGTERM') => {
  for (const child of evalChildren) {
    try {
      process.kill(-child.pid, signal)
    } catch {
      // already gone
    }
  }
}
let exitHookInstalled = false

/**
 * Runs each case through `<worktree>/scripts/eval.mjs` (so the plugin copy it tests is the edited one), `jobs` cases at a time, with EVAL_LEDGER / EVAL_RESULTS pointing at
 * the starting checkout, `--label hillclimb:<run>` on every call (the ledger rows tell the run's spend and are never a release row), and `--invocation <id>` made here: the rows of a
 * case are read back by that id, never by text the child printed (the agent's own words reach its output). A case that is not under evals/cases/ but under evals/pending/ of the worktree
 * is run with `--pending`. Before each case starts, the estimates of the cases already running (what they have not spent yet) are reserved: the run's cap `capUsd` and the lane budget are
 * checked against the ledger spend + that reserve + this case's estimate, and the child gets the tighter of the lane budget and what remains under the cap, so its runs 2 and 3 are
 * checked too. A case that does not fit is not started (`capped` names it). Every child has an in-flight mark (see markInflight) from before its spawn to after its rows. Scores come from the
 * ledger rows of the invocation; a case with fewer graded runs than `runs` (a harness failure, a budget exit, a crash) is `failed`, never scored on what is left.
 * `killAll()` sends SIGTERM to the process group of every child that runs.
 */
export function makeEvaluator({ repo, run, runs, jobs = 1, budgetUsd, budgetSince, capUsd, ledgerPath, resultsDir, nodeBin = process.execPath }) {
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.on('exit', () => killEvalChildren('SIGKILL'))
  }
  const isPending = (worktree, name) => !existsSync(join(worktree, 'evals/cases', name, 'case.json')) && existsSync(join(worktree, 'evals/pending', name, 'case.json'))
  // The cost bound of one run of a case: its `budgetUsd` (the `--max-budget-usd` scripts/eval.mjs gives the agent), 1 when the case names none.
  const perRunBound = (worktree, name) => {
    for (const dir of ['evals/cases', 'evals/pending']) {
      try {
        const spec = JSON.parse(readFileSync(join(worktree, dir, name, 'case.json'), 'utf8'))
        return Number(spec.budgetUsd) > 0 ? Number(spec.budgetUsd) : 1
      } catch {
        // not there, or not readable: the next place, then the default
      }
    }
    return 1
  }
  const runOne = (worktree, name, { budget, since }, invocation, onSpawn) =>
    new Promise((resolve) => {
      const args = [join(worktree, 'scripts/eval.mjs'), '--runs', String(runs), '--invocation', invocation, ...(run ? ['--label', climbLabel(run)] : []), ...(isPending(worktree, name) ? ['--pending'] : []), ...(budget ? ['--budget-usd', String(budget)] : []), ...(budget && since ? ['--budget-since', since] : []), name]
      const child = spawn(nodeBin, args, { cwd: worktree, env: { ...process.env, EVAL_LEDGER: ledgerPath, EVAL_RESULTS: resultsDir }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      evalChildren.add(child)
      if (child.pid) onSpawn?.(child.pid)
      let out = ''
      child.stdout.on('data', (chunk) => (out += chunk))
      child.stderr.on('data', (chunk) => (out += chunk))
      child.on('error', (error) => {
        evalChildren.delete(child)
        resolve({ name, invocation, status: -1, out: String(error) })
      })
      child.on('close', (status) => {
        evalChildren.delete(child)
        resolve({ name, invocation, status, out })
      })
    })
  return {
    killAll: () => killEvalChildren('SIGTERM'),
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
          // The child's own budget check (before each of its runs) gets the tighter limit: the lane's, or what is left under the run's cap, in the lane's terms (spent since its start).
          const capLeft = capUsd ? capUsd - spent - reserved : null
          let limit = { budget: undefined, since: undefined }
          if (budgetUsd) limit = { budget: Math.max(0.01, Math.min(budgetUsd - reserved, capLeft === null ? Infinity : lane + capLeft)), since: budgetSince }
          else if (capLeft !== null) limit = { budget: Math.max(0.01, capLeft), since: new Date().toISOString() }
          const before = spentByRun(ledger, run, name)
          inflight.set(name, { estimate, before })
          // The mark is written before the spawn (a crash between the two still leaves it) and rewritten with the child's pid once it exists: a resume refuses while that pid answers.
          const invocation = newInvocationId()
          const markData = { kind: 'eval', case: name, estimate, before, perRun: perRunBound(worktree, name), runs, invocation }
          const mark = run && repo ? markInflight(repo, run, `eval-${name}`, markData) : null
          results.push(await runOne(worktree, name, limit, invocation, (pid) => mark && markInflight(repo, run, `eval-${name}`, { ...markData, pid })))
          if (mark) clearInflight(mark)
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
        const { invocation } = result
        const rows = ledger.filter((row) => row.invocation === invocation && row.case === name)
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

/** `//<abs path>` : the absolute-path form of a permission rule (`//` + the path without its leading slash). */
const absRule = (path) => `//${resolve(path).replace(/^\//, '')}`
export const EDITOR_TOOLS = 'Read,Edit,Write,Glob,Grep'

/**
 * The `claude -p` argv of the editor, `--restricted` (no settings files are read, the file tools stay in the working directory, and the auto-memory exemption of the blocks below is closed), no MCP, no session, dontAsk. The repo has no project settings file the editor needs.
 * - `--tools` names the toolset: exactly Read Edit Write Glob Grep, no Bash, no Agent, no WebFetch (`--allowedTools` only pre-approves, it removes nothing).
 * - the allow rules are path-scoped: reads anywhere in the worktree, writes only in `skills/<agent>/references/` and the one `agents/<agent>.md`; under dontAsk anything else is denied.
 * - `--settings` sets `blockWritesOutsideWorkingDirectories` and `blockReadsOutsideWorkingDirectories`: no allow rule lifts them, so nothing outside the temp worktree (the starting checkout,
 *   its ledger, the user's home) is read or written.
 * - the deny rules keep the measurement away: the cases and graders of the worktree's `evals/`, and, by absolute path, the starting checkout's `evals/` and the results dir.
 */
export function editorArgs({ prompt, model, budget, agent = '<agent>', repo = null, resultsDir = null }) {
  const references = `./plugins/stage-pipeline/skills/${agent}/references/**`
  const agentFile = `./plugins/stage-pipeline/agents/${agent}.md`
  const evals = ['./evals/**', ...(repo ? [`${absRule(repo)}/evals/**`] : []), ...(resultsDir ? [`${absRule(resultsDir)}/**`] : [])]
  return [
    '-p', prompt, '--model', model,
    '--restricted', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk',
    '--settings', JSON.stringify({ permissions: { blockWritesOutsideWorkingDirectories: true, blockReadsOutsideWorkingDirectories: true } }),
    '--tools', EDITOR_TOOLS,
    '--allowedTools', 'Read(./**)', 'Glob(./**)', 'Grep(./**)', `Edit(${references})`, `Write(${references})`, `Edit(${agentFile})`,
    // The cases and their graders are the measurement: the editor sees the misses of the train cases in its prompt and nothing of the holdout.
    '--disallowedTools', ...evals.flatMap((path) => ['Read', 'Grep', 'Glob', 'Edit', 'Write'].map((tool) => `${tool}(${path})`)),
    '--max-budget-usd', String(budget), '--output-format', 'json',
  ]
}

/** The editor's environment: the driver's, and Claude Code's auto-memory off (its folder is keyed by the repo, outside every working-directory block; --restricted closes the exemption too). */
export const editorEnv = (base = process.env) => ({ ...base, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })

const excerpt = (text, max) => (text.length > max ? `${text.slice(0, max)}\n… (cut)` : text)

/** What went wrong in the train runs: the Failures section and the head of the final message of up to two failing runs per case, from evals/.results. */
export function missExcerpts(train, resultsDir, perCaseChars = 2400) {
  const parts = []
  for (const [name, entry] of Object.entries(train?.perCase ?? {})) {
    const dir = INVOCATION_RE.test(entry.invocation ?? '') ? join(resultsDir, entry.invocation) : null
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

function runEditor(bin, args, cwd, timeoutMs, live) {
  return new Promise((resolveRun) => {
    const child = spawn(bin, args, { cwd, env: editorEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    live.add(child)
    let stdout = ''
    let stderr = ''
    const killChild = () => child.kill('SIGKILL')
    process.once('exit', killChild)
    const timer = setTimeout(killChild, timeoutMs)
    const done = (result) => {
      live.delete(child)
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
  const live = new Set()
  return {
    model,
    budget,
    /** SIGKILL to the editor call that runs (the signal handler of the driver calls it, then charges the in-flight mark). */
    kill() {
      for (const child of live) child.kill('SIGKILL')
    },
    async edit({ worktree, attempt, context }) {
      const prompt = editorPrompt({ ...context, run, attempt, resultsDir })
      const started = Date.now()
      // Charge before spending: the mark says the call may cost its whole budget; it is cleared only after the call's own ledger row is written.
      const mark = markInflight(repo, run, 'editor', { kind: 'editor', attempt, charge: budget })
      // Async, not spawnSync: a SIGTERM/SIGHUP to this process is handled at once (the call killed and charged, the temp worktree removed) and not after a 15-minute call.
      const ran = await runEditor(claudeBin, editorArgs({ prompt, model, budget, agent: context.agent, repo, resultsDir }), worktree, timeoutSec * 1000, live)
      const final = parseEditorOutput(ran.stdout)
      // A call that timed out (killed, no output) or reported no cost may have spent up to its --max-budget-usd: the ledger is charged that.
      const unknownCost = ran.error || ran.signal || typeof final.total_cost_usd !== 'number'
      const cost = unknownCost ? budget : Number(final.total_cost_usd)
      let sha = ''
      try {
        sha = git(worktree, 'rev-parse', 'HEAD').trim()
      } catch {
        // the row is written without it: the spend must reach the ledger
      }
      appendLedger({
        ts: new Date().toISOString(), invocation: `hillclimb-${run}`, case: EDITOR_CASE, attempt, plugin_ref: climbLabel(run), plugin_version: '', plugin_sha: sha,
        claude_version: '', models: model, marks: 'edit', pass: final.is_error || ran.status !== 0 ? 0 : 1, cost_usd: cost.toFixed(4), seconds: Math.round((Date.now() - started) / 1000),
      }, ledgerPath)
      clearInflight(mark)
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
export function resumedSplit(ledger, casesText, invocationsText) {
  const invocations = Object.fromEntries(String(invocationsText ?? '').split(';').filter(Boolean).map((part) => [part.split('=')[0], part.slice(part.indexOf('=') + 1)]))
  return Object.fromEntries(String(casesText ?? '').split(';').filter(Boolean).map((part) => {
    const name = part.split('=')[0]
    const invocation = INVOCATION_RE.test(invocations[name] ?? '') ? invocations[name] : undefined
    const rows = invocation ? ledger.filter((entry) => entry.invocation === invocation && entry.case === name) : []
    return [name, { score: Number(part.split('=')[1]), scores: rows.map((entry) => runScore(entry.marks)).filter((score) => score !== null), marks: rows.map((entry) => entry.marks), invocation, resumed: true }]
  }))
}
/** `resumedSplit` for the train columns of a decision row. */
export const resumedTrain = (ledger, row) => resumedSplit(ledger, row.train_cases, row.train_invocations)
/** … and for the holdout columns (a log written before `holdout_invocations` has the scores only: those cases have no marks and are not compared). */
export const resumedHoldout = (ledger, row) => resumedSplit(ledger, row.holdout_cases, row.holdout_invocations)

/**
 * Per case, what the ledger says about the CURRENT agent (the dry run prints it): runs, harness failures (`W-`), and the last invocation's median score and marks. Only rows of the
 * working tree itself count — `plugin_ref` exactly `working-tree` (the filter buildReleaseRows and seedModels use: no `+hillclimb:<run>` candidate, no `--ref`, effort or ablation run) —
 * at the starting checkout's plugin `version`, and, with `treeOf`, only rows measured on a clean sha whose agent bytes (`agentTree`) are the checkout's. `excluded` counts the rows left out.
 */
export function caseLedgerSummary(ledger, name, { version = null, treeOf = null, agentTree = null } = {}) {
  const ofCase = ledger.filter((row) => row.case === name)
  const rows = ofCase
    .filter((row) => row.plugin_ref === 'working-tree' && (version === null || row.plugin_version === version))
    .filter((row) => !treeOf || (!/\+dirty$/.test(row.plugin_sha ?? '') && treeOf(row.plugin_sha) === agentTree))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  const failures = rows.filter((row) => /(^|\s)W-/.test(row.marks ?? '')).length
  const last = rows.filter((row) => row.invocation === rows.at(-1)?.invocation)
  const scores = last.map((row) => runScore(row.marks)).filter((score) => score !== null)
  return { runs: rows.length, failures, score: median(scores), marks: last.map((row) => row.marks).join(' | '), sha: last[0]?.plugin_sha ?? '', version: last[0]?.plugin_version ?? '', excluded: ofCase.length - rows.length }
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
    if (!('holdout_invocations' in baselineRow)) throw new Error(`--resume ${run}: ${relative(repo, path)} was written before the holdout_invocations column, the failure counts of its holdout cannot be restored: start a new run (this log stays as it is)`)
    train = prior.meta.train.split(', ')
    holdout = prior.meta.holdout.split(', ')
  } else if (existsSync(path)) {
    throw new Error(`${relative(repo, path)} exists: pick another --run or continue it with --resume ${run}`)
  }

  const ledgerNow = () => readLedger(cfg.ledgerPath)
  const wt = makeWorktree(repo, run, { resume: cfg.resume })
  // A resume got past the owner-pid check of makeWorktree. An eval child of the previous process that still answers stops it (nothing is charged or cleared, nothing is killed); otherwise what a
  // SIGKILLed earlier part left in flight (an editor call, eval children) is charged now.
  if (cfg.resume) {
    try {
      assertNoLiveEvalChildren({ repo, run })
    } catch (error) {
      wt.remove()
      throw error
    }
    const charged = chargeInflight({ repo, run, ledgerPath: cfg.ledgerPath })
    if (charged > 0) log(`charged $${charged.toFixed(2)} for the calls the previous process left in flight`)
  }
  // A signal: stop what runs (eval children by process group, the editor call), charge what they may have spent into the ledger before exiting, then drop the temp worktree.
  const onSignal = () => {
    for (const stopIt of [() => deps.evaluator.killAll?.(), () => deps.editor.kill?.(), () => chargeInflight({ repo, run, ledgerPath: cfg.ledgerPath }), () => wt.remove()]) {
      try {
        stopIt()
      } catch {
        // the next step still runs: the charge must not depend on the kill
      }
    }
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
    let failRef // per case, the runs that fail a grader outside the metric at the baseline / last kept state
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
      write({ attempt: 0, ts: stamp(), kind: 'baseline', summary: 'unedited HEAD', ...trainCells(base.train.perCase), train_mean: num(base.train.mean), ...holdoutCells(base.holdout.perCase), holdout_mean: num(base.holdout.mean), decision: 'baseline', cost_usd: baseCost(), cumulative_usd: spent().toFixed(4), commit: startSha })
      baseline = { train: base.train.mean, holdout: base.holdout.mean }
      best = base.train.mean
      lastTrain = base.train
      failRef = { train: failureCounts(base.train.perCase), holdout: failureCounts(base.holdout.perCase) }
    } else {
      const baseRow = rows.find((row) => row.kind === 'baseline')
      baseline = { train: Number(baseRow.train_mean), holdout: Number(baseRow.holdout_mean) }
      best = Math.max(baseline.train, ...rows.filter((row) => row.decision === 'kept').map((row) => Number(row.train_mean)))
      const lastKept = rows.filter((row) => row.decision === 'kept').at(-1) ?? baseRow
      lastTrain = { perCase: resumedTrain(ledgerNow(), lastKept), mean: best }
      // Both splits' invocation ids are in the row: the failure counts of the last kept state come back from the ledger (a log without the holdout column is refused above).
      failRef = { train: failureCounts(lastTrain.perCase), holdout: failureCounts(resumedHoldout(ledgerNow(), lastKept)) }
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
      // A kept edit needs the editor, the train eval and the holdout eval: when they cannot all fit under the cap, the editor is not paid for an edit nobody could measure.
      const blocked = room(estimateEdit(ledgerNow(), deps.editor.budget ?? cfg.editorBudget) + estimateEval(ledgerNow(), train, runs) + estimateEval(ledgerNow(), holdout, runs))
      if (blocked) {
        stop('stopped-cap', blocked)
        return { rows, branch: wt.branch, stopped: 'stopped-cap' }
      }

      const before = spent()
      const outside = checkoutState(repo, cfg.ledgerPath)
      const edit = await deps.editor.edit({ worktree: wt.dir, attempt, context: { agent, attempt, baseline, best, train: lastTrain, history: rows, holdoutNames: holdout }, run, ledgerPath: cfg.ledgerPath })
      const changed = changedPaths(wt.dir)
      const files = changed.map((entry) => entry.path).join(', ')
      const row = (fields) => ({ attempt, ts: stamp(), kind: 'attempt', files, summary: edit.summary ?? '', cost_usd: (spent() - before).toFixed(4), cumulative_usd: spent().toFixed(4), commit: '', ...fields })
      const undoAndWrite = (fields) => {
        undoChanges(wt.dir, changed)
        write(row(fields))
      }
      // The editor works in the temp worktree: the starting checkout's tracked tree must be as it was and its ledger only longer. Otherwise the run stops, with a row of its own.
      const touched = checkoutProblems(outside, checkoutState(repo, cfg.ledgerPath))
      if (touched.length) {
        undoAndWrite({ decision: 'stopped-checkout-touched', summary: `the editor call changed the starting checkout: ${touched.join('; ')}; look at ${repo} before continuing`.slice(0, 400) })
        return { rows, branch: wt.branch, stopped: 'stopped-checkout-touched' }
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
      const trainFailures = failureCounts(trainResult.perCase)
      const trainGrew = grewFailures(trainFailures, failRef.train)
      if (trainGrew.length) {
        undoAndWrite({ decision: 'rejected-failures', ...trainCells(trainResult.perCase), train_mean: num(trainMean), summary: `${edit.summary ?? ''} [more runs fail a grader outside the metric, train: ${trainGrew.join('; ')}]`.slice(0, 400) })
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
      const scored = { ...trainCells(trainResult.perCase), train_mean: num(trainMean), ...holdoutCells(holdoutResult.perCase), holdout_mean: num(holdoutMean) }
      const holdoutFailures = failureCounts(holdoutResult.perCase)
      const holdoutGrew = grewFailures(holdoutFailures, failRef.holdout)
      if (holdoutGrew.length) {
        undoAndWrite({ decision: 'rejected-failures', ...scored, summary: `${edit.summary ?? ''} [more runs fail a grader outside the metric, holdout: ${holdoutGrew.join('; ')}]`.slice(0, 400) })
        continue
      }
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
      failRef = { train: trainFailures, holdout: holdoutFailures }
    }
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    process.removeListener('SIGHUP', onSignal)
    wt.remove()
  }
}

/** The starting checkout as the editor call must leave it: its HEAD and tracked diff (a fingerprint) and the ledger text. */
function checkoutState(repo, ledgerPath) {
  let tracked
  try {
    tracked = `${git(repo, 'rev-parse', 'HEAD').trim()} ${createHash('sha1').update(git(repo, 'diff', 'HEAD', '--binary', '--no-ext-diff')).digest('hex')}`
  } catch (error) {
    tracked = `unreadable: ${error.message}`
  }
  return { tracked, ledger: existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '' }
}
export function checkoutProblems(before, after) {
  const problems = []
  if (before.tracked !== after.tracked) problems.push('its tracked files or HEAD changed')
  if (!after.ledger.startsWith(before.ledger)) problems.push('its ledger was rewritten, not only appended to')
  return problems
}

async function evalSplit(deps, worktree, train, holdout, ctx) {
  const t = await deps.evaluator.evaluate(worktree, train, ctx)
  // A capped or failed train split has no use for the holdout runs: stop before paying for them.
  const h = t.capped || t.failed?.length ? { perCase: {}, mean: null, failed: [], capped: null } : await deps.evaluator.evaluate(worktree, holdout, ctx)
  return { train: { perCase: t.perCase, mean: t.mean }, holdout: { perCase: h.perCase, mean: h.mean }, capped: t.capped ?? h.capped ?? null, failed: [...(t.failed ?? []), ...(h.failed ?? [])] }
}
