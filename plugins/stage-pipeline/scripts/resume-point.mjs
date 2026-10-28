/**
 * The resume point (VT-1 stage 11, K11.7). After `/compact` or a resume the orchestrator of a force run has lost the thread: which stage was open, whether the
 * maker finished, which report waits for its outcome. session-start prints this block after the status line, from the state on disk (the journal, the maker
 * records, the reports of the commit window, the working tree), never from memory: the stage in progress, uncommitted code against the last maker snapshot, the
 * reports with their outcome state, the open blockers and ONE next action. The whole output stays within `OUTPUT_MAX` characters (A7): lists are cut with "+N more",
 * the next action never is.
 */
import { spawnSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { findingCounts, lastForceBlock, newReports, openBlockers, readTaskFile, reportChecker, reportLedgerViolations } from './journal-check.mjs'
import { dirtyBlobs, isCodeFile, lastMakerBlobs, readMakerRecords, recordBlobs } from './maker.mjs'
import { readReceipts } from './receipts.mjs'

export const OUTPUT_MAX = 10000
const LIST_MAX = 6
const BLOCKERS_MAX = 8
const LINE_MAX = 300

const real = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const cut = (text, max = LINE_MAX) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const listed = (items, max = LIST_MAX) => items.slice(0, max).join(', ') + (items.length > max ? `, +${items.length - max} more` : '')

function git(cwd, args) {
  const run = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
  return run.status === 0 ? run.stdout.trim() : null
}

/** The stages of the journal with the whole text of their status bracket (`in progress`, `todo — blocked: B2`): `[{ heading, status }]`. */
export function stageList(stages) {
  return [...stages.matchAll(/^###\s+(.+?)\s*\[status:\s*([^\]]*)\].*$/gim)].map((found) => ({ heading: found[1].trim(), status: found[2].trim().toLowerCase() }))
}

// `blocked` anywhere in the bracket is blocked (`todo — blocked: B2`): the stage stays without code and is not the next one. The rest is read by its first word, like OPEN_STATUS.
const BLOCKED = /\bblocked\b/
const DONE = /^(?:done|ready|completed|skipped|cancel+ed|dropped)\b/
const ACTIVE = /^in[-\s]?progress\b/
const closed = (stage) => BLOCKED.test(stage.status) || DONE.test(stage.status)
const active = (stage) => !BLOCKED.test(stage.status) && ACTIVE.test(stage.status)

/** The state the next action derives from. Pure over its inputs apart from the reads; `null` when there is nothing to say. */
export function resumeState({ dataDir, state, task }) {
  const taskDir = task.dir
  const block = lastForceBlock(task.stages)
  if (!block) return null
  const root = real(state.worktree)
  const list = stageList(task.stages)
  const running = list.filter(active)
  const next = list.find((stage) => !closed(stage) && !active(stage))
  const date = /(\d{4}-\d{2}-\d{2})/.exec(block.heading)?.[1] ?? null
  const blockStart = date ? new Date(`${date}T00:00:00`).getTime() || 0 : 0
  const lastReceipt = readReceipts(dataDir, task.ticket).filter((receipt) => receipt.branch === state.branch).at(-1)
  const commitMs = (Number(git(state.worktree, ['log', '-1', '--format=%ct'])) || 0) * 1000
  const since = Math.max(blockStart, lastReceipt ? Date.parse(lastReceipt.at) || 0 : commitMs)

  const taskRel = relative(root, real(taskDir)).split(sep).join('/')
  const inTask = (path) => !taskRel.startsWith('..') && (path === taskRel || path.startsWith(`${taskRel}/`))
  const dirty = dirtyBlobs(root)
  const recorded = lastMakerBlobs(dataDir, task.ticket, root)
  const code = dirty ? [...dirty].filter(([path]) => isCodeFile(path) && !inTask(path)) : []
  const asLeft = code.filter(([path, blob]) => recorded.has(path) && recorded.get(path) === blob).map(([path]) => path)
  const changed = code.filter(([path, blob]) => !(recorded.has(path) && recorded.get(path) === blob)).map(([path]) => path)
  const stops = readMakerRecords(dataDir, task.ticket).filter((record) => recordBlobs(record, root) !== null && (Date.parse(record.at) || 0) >= since)

  const names = newReports(taskDir, since + 1)
  const reports = names.map((name) => {
    const text = readTaskFile(taskDir, 'checks', name) ?? ''
    const counts = findingCounts(text, name)
    const open = reportLedgerViolations(taskDir, name, { complete: true, strict: true })
    let mtimeMs = 0
    try {
      mtimeMs = statSync(join(taskDir, 'checks', name)).mtimeMs
    } catch {
      // gone: older than any stop
    }
    return { name, mtimeMs, checker: reportChecker(name), counts, open: open.map((v) => v.what ?? v.rule).filter(Boolean), openCount: open.length }
  })
  const blockers = openBlockers(block.body)
  return { stage: running[0] ?? null, activeCount: running.length, next, list, since, asLeft, changed, dirtyUnknown: dirty === null, noSnapshot: recorded.size === 0, stops, reports, blockers }
}

/** The one next action, from the state. */
export function nextAction(s) {
  const stageNo = (stage) => stage.heading.replace(/:.*$/, '')
  if (!s.stage) {
    if (s.next) return `kickoff ${stageNo(s.next)} (/stage-kickoff — nothing is in progress)`
    return 'final checks: every stage is done or blocked — whole-branch pro-review and task-converge, then close the force run'
  }
  const label = stageNo(s.stage)
  const undone = s.reports.filter((report) => report.openCount)
  const heavy = (report) => report.counts.critical + report.counts.major > 0 || report.open.some((what) => /critical|major|FAIL/.test(String(what)))
  const fixRound = (report) => `fix round for the findings of checks/${report.name} (stage-implement, fix mode), then write its "Findings outcome"`
  if (!s.stops.length) {
    // No maker record in the window: a run from before the maker records, or a stop that failed open. With reports there, the maker is not to be spawned again blindly.
    if (!s.reports.length) return `spawn stage-implement for ${label} (no maker hand-back since the last commit${s.changed.length ? '; the uncommitted code has no maker record' : ''})`
    if (undone.length) {
      const report = undone[0]
      return heavy(report) ? `${fixRound(report)} (no maker record in the window: the run predates the records or a stop failed open)` : `write the "Findings outcome" of checks/${report.name}`
    }
    return `commit stage ${label.replace(/^Stage\s*/i, '')}: every report has its outcome (no maker record in the window, so the tree is not compared with a snapshot)`
  }
  if (!s.reports.length) return `run the checkers for ${label} (/stage-check): the maker stopped and no checker report is in the commit window`
  // By time: a report older than the last maker stop was written before the fix round that followed it.
  const lastStop = Math.max(...s.stops.map((record) => Date.parse(record.at) || 0))
  const waiting = undone.filter((report) => report.mtimeMs >= lastStop)
  const fixed = undone.filter((report) => report.mtimeMs < lastStop)
  if (waiting.length) return heavy(waiting[0]) ? fixRound(waiting[0]) : `write the "Findings outcome" of checks/${waiting[0].name}`
  if (fixed.length) return `the maker stopped after checks/${fixed[0].name}: recheck the fixed items, then write the "Findings outcome" of ${fixed[0].name}`
  if (s.changed.length) return `code changed since the maker's last snapshot (${s.changed.length} path${s.changed.length === 1 ? '' : 's'}): hand it to a fix round, then re-run the checkers`
  return `commit stage ${label.replace(/^Stage\s*/i, '')}: the tree matches the maker snapshot and every report has its outcome`
}

/**
 * The block, within `budget` characters; `null` when there is nothing to print. The next action and the stage line are always whole; the lists give way.
 */
export function resumePoint({ dataDir, state, task, budget = OUTPUT_MAX }) {
  const s = resumeState({ dataDir, state, task })
  if (!s) return null
  const head = [`Resume point (force run, ${task.ticket}) — the state on disk, not memory:`]
  const stage = s.stage ? `${s.stage.heading}${s.activeCount > 1 ? ` (+${s.activeCount - 1} more in progress)` : ''}` : s.next ? `none in progress; next ${s.next.heading}` : 'none — every stage is done or blocked'
  const action = `  Next action: ${nextAction(s)}`
  const lines = [`  Stage in progress: ${cut(stage)}`]
  const tree = s.dirtyUnknown
    ? 'too many uncommitted paths to compare'
    : s.noSnapshot
      ? `no maker snapshot in this run — ${s.changed.length} uncommitted code path${s.changed.length === 1 ? '' : 's'}${s.changed.length ? `: ${listed(s.changed)}` : ''}`
      : `${s.asLeft.length} path${s.asLeft.length === 1 ? '' : 's'} as the maker left them, ${s.changed.length} changed since${s.changed.length ? `: ${listed(s.changed)}` : ''}`
  lines.push(`  Uncommitted code vs the last maker snapshot: ${cut(tree, 600)}`)
  lines.push(`  Maker stops in the commit window: ${s.stops.length}`)
  if (!s.reports.length) lines.push('  Reports in the commit window: none')
  else {
    lines.push(`  Reports in the commit window (${s.reports.length}):`)
    for (const report of s.reports.slice(0, LIST_MAX)) {
      const { critical, major } = report.counts
      lines.push(`    - checks/${report.name}: critical ${critical}, major ${major} — ${report.openCount ? `no complete Findings outcome (${cut(report.open.join(' · ') || 'open', 120)})` : 'outcome complete'}`)
    }
    if (s.reports.length > LIST_MAX) lines.push(`    +${s.reports.length - LIST_MAX} more`)
  }
  if (!s.blockers.length) lines.push('  Open blockers: none')
  else {
    lines.push(`  Open blockers (${s.blockers.length}):`)
    for (const blocker of s.blockers.slice(0, BLOCKERS_MAX)) lines.push(`    - ${cut(blocker.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))}`)
    if (s.blockers.length > BLOCKERS_MAX) lines.push(`    +${s.blockers.length - BLOCKERS_MAX} more`)
  }
  // The lists give way first: drop trailing list lines until the block fits, the next action is added last and stays.
  const fixed = head.join('\n').length + action.length + 2
  let body = lines
  while (body.length > 1 && fixed + body.join('\n').length + 1 > budget) body = body.slice(0, -1)
  let out = [...head, ...body, action].join('\n')
  if (out.length > budget) out = `${out.slice(0, Math.max(0, budget - action.length - 2))}…\n${action}`.slice(0, budget)
  return out
}
