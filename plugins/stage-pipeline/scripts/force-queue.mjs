#!/usr/bin/env node
/**
 * The queue of force runs of this machine — tasks may come from different repos, nobody is at the screen.
 *
 *   node force-queue.mjs add <repo> <TICKET>   only a task with a confirmed interview (/stage-force <TICKET> --interview-only); the reason is named otherwise. Makes the task's worktree (to prepare it before the night)
 *   node force-queue.mjs list                  the queue with the status of each task
 *   node force-queue.mjs remove <TICKET>       only a task that was not started
 *   node force-queue.mjs check                 before the night: for each task the repo, the task folder, the interview, the branch (after `git fetch origin <branch>`), the worktree (the hooks see the task in it; what the main copy has and it lacks: node_modules, .env*, the local config), `claude` — every "no" named; exit 1 on any
 *   node force-queue.mjs run [--threshold 90] [--margin-min 5] [--max-sessions 3] [--retries 1]
 *
 * The queue is `force-queue.json` in the plugin data directory. `run` holds a lock of this machine (a PID file: a second `run` is refused at once while the first is alive, the
 * file of a dead PID is taken over), runs the queued tasks one by one in the order they were added through `runLoop` of force-run.mjs, the next only after the outcome of the previous.
 * Before each task it reads `five_hour` of the latest `rate_limit_event` of all run records: at or above the threshold (percent) it waits for the reset (plus the margin) first;
 * a `seven_day` window that is `rejected` stops the queue. An outcome error / stopped / gave_up of one task does not stop the queue; a weekly limit, a spend limit, a limit with no known window or reset time (`limit_unknown`) and an interrupt do,
 * and the tasks not yet run stay queued (the task that hit the limit stays queued too and goes on with a new session at the next `run`).
 * The morning summary — a line per task: outcome, commits of the run, open blockers, the log of the last session, the path to RUN-DIGEST.md when this run wrote it (else the command that writes it) — goes to stdout and to `force-queue-summary.md`.
 *
 * Exit codes of `run`: 0 every task completed · 1 some task did not · 2 refused to start (a lock, nothing to run) · 3 limit of unknown window · 4 interrupted · 5 weekly limit · 6 spend limit.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EXIT, TICKET, acquirePidLock, findOnPath, gitOk, numberFlag, prepareRun, prepareWorktree, runLoop, taskReadiness, ticketLockFile, waitUntil } from './force-run.mjs'
import { blockerGate, lastForceBlock, openBlockers } from './journal-check.mjs'
import { digestFilePath } from './run-digest.mjs'
import { pluginDataDir, readDataJsonl, readPipelineState } from './hooks/pipeline-state.mjs'

const say = (text) => console.log(`force-queue: ${text}`)
const queueFile = (dataDir = pluginDataDir()) => join(dataDir, 'force-queue.json')
const summaryFile = (dataDir = pluginDataDir()) => join(dataDir, 'force-queue-summary.md')
const queueLockFile = (dataDir = pluginDataDir()) => join(dataDir, 'locks', 'queue.lock')
const fileLockFile = (dataDir = pluginDataDir()) => join(dataDir, 'locks', 'queue-file.lock')

/** A short lock around one read-modify-write of `force-queue.json` (an `add`/`remove` during a night `run` must not lose an update). */
function withQueueFile(dataDir, fn) {
  let lock = null
  for (let attempt = 0; attempt < 100 && !lock?.ok; attempt += 1) {
    lock = acquirePidLock(fileLockFile(dataDir), 'force-queue file')
    if (!lock.ok) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
  if (!lock.ok) throw new Error('force-queue.json is locked by another process — try again')
  try {
    return fn()
  } finally {
    lock.release()
  }
}

function readQueue(dataDir = pluginDataDir()) {
  try {
    const parsed = JSON.parse(readFileSync(queueFile(dataDir), 'utf8'))
    return { tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] }
  } catch (error) {
    if (error.code === 'ENOENT') return { tasks: [] }
    throw new Error(`${queueFile(dataDir)} cannot be read: ${error.message}`)
  }
}

function writeQueue(queue, dataDir = pluginDataDir()) {
  const file = queueFile(dataDir)
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(queue, null, 2)}\n`)
  renameSync(tmp, file)
}

/** Queued and not yet started, or started and waiting for another session (a limit stopped it): the tasks `run` takes. */
const runnable = (task) => task.status === 'queued'
/** No session of it ever ran: queued and never started, or refused before its first session (`not_ready`). */
const notStarted = (task) => !task.started && task.status !== 'running'

// ── add / list / remove ──────────────────────────────────────────────────────

function addTask(repo, ticket, dataDir = pluginDataDir()) {
  if (!TICKET.test(ticket ?? '')) return { ok: false, message: `not a ticket: ${ticket}` }
  const ready = taskReadiness(repo, ticket)
  if (!ready.ok) return { ok: false, message: ready.message }
  const queued = readQueue(dataDir).tasks.find((task) => task.ticket === ticket && (runnable(task) || task.status === 'running'))
  if (queued) return { ok: false, message: `${ticket} is already in the queue (${queued.status})` }
  // the worktree exists from the evening: it can be prepared (deps, .env) before the night, and a task the hooks cannot see in it is refused now
  const tree = prepareWorktree(ready.state.root, ready.task, ready.state.taskDir)
  if (tree.problem) return { ok: false, message: tree.problem }
  return withQueueFile(dataDir, () => {
    const queue = readQueue(dataDir)
    const same = queue.tasks.find((task) => task.ticket === ticket)
    if (same && (runnable(same) || same.status === 'running')) return { ok: false, message: `${ticket} is already in the queue (${same.status})` }
    const entry = { ticket, repo: ready.state.root, status: 'queued', started: false, addedAt: new Date().toISOString() }
    queue.tasks = [...queue.tasks.filter((task) => task.ticket !== ticket), entry]
    writeQueue(queue, dataDir)
    return { ok: true, entry, worktree: tree.path, lacks: missingInWorktree(ready.state.root, tree.path) }
  })
}

function removeTask(ticket, dataDir = pluginDataDir()) {
  return withQueueFile(dataDir, () => {
    const queue = readQueue(dataDir)
    const task = queue.tasks.find((item) => item.ticket === ticket)
    if (!task) return { ok: false, message: `${ticket} is not in the queue` }
    if (!notStarted(task)) return { ok: false, message: `${ticket} ${task.status === 'running' ? 'is marked running (a live `run` has it; after a crash the next `run` takes it again)' : `was started (${task.status})`} — only a task that was not started can be removed` }
    queue.tasks = queue.tasks.filter((item) => item !== task)
    writeQueue(queue, dataDir)
    return { ok: true }
  })
}

const listLines = (queue) => queue.tasks.map((task, at) => `${at + 1}. ${task.ticket}  ${task.status}${task.started && task.status === 'queued' ? ' (started, goes on at the next run)' : ''}  ${task.repo}`)

// ── check ────────────────────────────────────────────────────────────────────

/** What the main copy has that a fresh worktree does not: `node_modules`, the `.env*` files of its root, its `.claude/pipeline.config.local.md`. */
function missingInWorktree(main, worktree) {
  const missing = []
  const has = (dir, name) => existsSync(join(dir, name))
  if (has(main, 'node_modules') && !has(worktree, 'node_modules')) missing.push('node_modules')
  let names = []
  try {
    names = readdirSync(main).filter((name) => name.startsWith('.env'))
  } catch {
    // an unreadable main copy has other problems
  }
  for (const name of names) if (!has(worktree, name)) missing.push(name)
  const local = '.claude/pipeline.config.local.md'
  // a worktree without a config of its own reads the main copy's config, local one included
  if (has(main, local) && has(worktree, '.claude/pipeline.config.md') && !has(worktree, local)) missing.push(local)
  return missing
}

/** Every "no" of the queue as a line naming the task; an empty list means ready for the night. */
function checkQueue(dataDir = pluginDataDir(), pathEnv = process.env.PATH ?? '') {
  const problems = []
  const tasks = readQueue(dataDir).tasks.filter(runnable)
  if (!tasks.length) return { problems, tasks: 0 }
  if (!findOnPath('claude', pathEnv)) problems.push('`claude` is not on the PATH (needed for every task)')
  for (const task of tasks) {
    const no = (text) => problems.push(`${task.ticket}: ${text}`)
    if (!existsSync(task.repo)) {
      no(`repo ${task.repo} does not exist on this machine`)
      continue
    }
    const ready = taskReadiness(task.repo, task.ticket)
    if (!ready.ok) {
      no(/Confirmed:/.test(ready.message) ? `interview not confirmed — ${ready.message}` : /^no task /.test(ready.message) ? `task folder: ${ready.message}` : ready.message)
      continue
    }
    const branches = ready.task.branches ?? []
    if (!branches.length) no(`no branch in the header of ${ready.task.stagesPath}`)
    else {
      // the fetch is inside: "on origin" is judged after it
      const tree = prepareWorktree(task.repo, ready.task, ready.state.taskDir)
      if (tree.problem) no(tree.problem)
      else {
        const lacks = missingInWorktree(task.repo, tree.path)
        if (lacks.length) no(`worktree ${tree.path} lacks what the main copy has: ${lacks.join(', ')} — prepare it there (nothing is installed or copied for you)`)
      }
    }
  }
  return { problems, tasks: tasks.length }
}

// ── the rate limit between tasks ─────────────────────────────────────────────

/** The latest `rate_limit_event` over every run record of the data directory: `{ ts, five_hour, seven_day }` or null. */
function latestRateLimit(dataDir = pluginDataDir()) {
  let names = []
  try {
    names = readdirSync(join(dataDir, 'force-runs')).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return null
  }
  let latest = null
  for (const record of names.flatMap((name) => readDataJsonl(dataDir, 'force-runs', name))) {
    if (record.type === 'rate_limit' && (!latest || Date.parse(record.ts) >= Date.parse(latest.ts))) latest = record
  }
  return latest
}

// utilization comes as a fraction (0.92) or as percent (92)
const percent = (utilization) => (typeof utilization === 'number' ? (utilization <= 1 ? utilization * 100 : utilization) : null)

/**
 * What the latest event says before the next task: `{ stop: 'seven_day', resetsAt }`, `{ wait: true, resetsAt, percent }` or `{}`.
 * A window whose reset time already passed is a new window: nothing to wait for (an event of yesterday's night).
 */
function gate(event, threshold, nowS = Date.now() / 1000) {
  if (!event) return {}
  const week = event.seven_day
  if (week?.status === 'rejected' && (week.resetsAt == null || week.resetsAt > nowS)) return { stop: 'seven_day', resetsAt: week.resetsAt ?? null }
  const five = event.five_hour
  const used = percent(five?.utilization)
  if (used !== null && used >= threshold && typeof five.resetsAt === 'number' && five.resetsAt > nowS) return { wait: true, resetsAt: five.resetsAt, percent: Math.round(used) }
  return {}
}

// ── the summary ──────────────────────────────────────────────────────────────

const gitHead = (cwd) => gitOk(cwd, 'rev-parse', 'HEAD')
const gitCount = (cwd, from) => {
  const count = gitOk(cwd, 'rev-list', '--count', `${from}..HEAD`)
  return count === null ? null : Number(count)
}

/** The blockers of the last Force block of the task that are not lifted (the parser of the journal gates). */
function openBlockersOf(repo, ticket, dataDir = pluginDataDir()) {
  let task = null
  try {
    task = readPipelineState(resolve(repo))?.tasks.find((item) => item.ticket === ticket) ?? null
  } catch {
    // an unreadable repo: the blockers stay unknown
  }
  if (!task) return null
  const block = lastForceBlock(task.stages)
  if (!block) return []
  return openBlockers(block, blockerGate(dataDir, task.dir)).map((line) => line.replace(/\s+/g, ' ').trim())
}

const clip = (text, n = 160) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

function summaryText(rows, stop, notRun) {
  const lines = ['# Force queue — morning summary', '']
  for (const row of rows) {
    const blockers = row.blockers === null ? 'blockers unknown (journal unreadable)' : row.blockers.length ? `${row.blockers.length} open blocker(s): ${row.blockers.map((b) => clip(b)).join(' | ')}` : 'no open blockers'
    lines.push(`${row.ticket}: ${row.outcome}${row.detail ? ` (${row.detail})` : ''} — ${row.commits ?? '?'} commit(s) — ${blockers} — log: ${row.log ?? '—'} — digest: ${row.digest}`)
  }
  if (!rows.length) lines.push('No task ran.')
  if (stop) lines.push('', `Queue stopped: ${stop}`)
  if (notRun.length) lines.push(`Not started (still queued): ${notRun.join(', ')}`)
  return `${lines.join('\n')}\n`
}

// ── run ──────────────────────────────────────────────────────────────────────

const OUTCOME = { completed: 'completed', error: 'error', stopped: 'stopped', gave_up: 'gave_up', limit_unknown: 'limit_unknown', weekly_limit: 'weekly_limit', spend_limit: 'spend_limit' }
const QUEUE_STOPS = new Set(['weekly_limit', 'spend_limit', 'limit_unknown'])

/**
 * The queue to its end or its stop. `{ ok: false, code, message }` when it cannot start (a lock, nothing queued), else `{ ok: true, exit, rows, stop, summary }`.
 * `options`: `threshold` (percent, default 90), `marginMin`, `maxSessions`, `retries`, `dataDir`, `now`, `scale` (tests: a multiplier of the waits).
 */
async function runQueue(options = {}) {
  const { threshold = 90, marginMin = 5, dataDir = pluginDataDir(), now = Date.now } = options
  const scale = Number(options.scale ?? process.env.FORCE_RUN_WAIT_SCALE ?? 1)
  const lock = acquirePidLock(queueLockFile(dataDir), 'force-queue run')
  if (!lock.ok) return { ok: false, code: EXIT.notReady, message: `another queue run is alive (pid ${lock.owner.pid}, started ${lock.owner.started ?? '?'}) — a second run is refused` }
  try {
    // a task still `running` with no live queue (a crash, a killed machine) goes on at this run
    withQueueFile(dataDir, () => {
      const stale = readQueue(dataDir)
      if (stale.tasks.some((task) => task.status === 'running')) {
        for (const task of stale.tasks) if (task.status === 'running') task.status = 'queued'
        writeQueue(stale, dataDir)
      }
    })
    if (!readQueue(dataDir).tasks.some(runnable)) return { ok: false, code: EXIT.notReady, message: 'nothing queued' }
    const rows = []
    const tried = new Set()
    let stop = null
    let exit = EXIT.completed
    const update = (ticket, patch) => {
      withQueueFile(dataDir, () => {
        const queue = readQueue(dataDir)
        const task = queue.tasks.find((item) => item.ticket === ticket)
        if (task) Object.assign(task, patch)
        writeQueue(queue, dataDir)
      })
    }
    // the summary is rewritten after each task, so a crash or a kill keeps the rows done so far
    const writeSummary = () => {
      const notRun = readQueue(dataDir).tasks.filter((item) => runnable(item) && !rows.some((row) => row.ticket === item.ticket && row.outcome !== 'busy')).map((item) => item.ticket)
      const summary = summaryText(rows, stop, notRun)
      writeFileSync(summaryFile(dataDir), summary)
      return { summary, notRun }
    }
    for (;;) {
      const task = readQueue(dataDir).tasks.find((item) => runnable(item) && !tried.has(item.ticket))
      if (!task) break
      // D17: the five-hour share and the week from the latest event of any run
      const verdict = gate(latestRateLimit(dataDir), threshold, now() / 1000)
      if (verdict.stop) {
        stop = `the weekly window is rejected${verdict.resetsAt ? `, resets ${new Date(verdict.resetsAt * 1000).toISOString()}` : ''}`
        exit = EXIT.weekly
        break
      }
      if (verdict.wait) {
        const target = now() + Math.max(0, (verdict.resetsAt * 1000 + marginMin * 60_000 - now()) * scale)
        say(`${task.ticket}: five_hour is at ${verdict.percent}% (threshold ${threshold}%) — waiting until ${new Date(target).toISOString()} for the reset before starting it`)
        if (!(await waitUntil(target, process.env.PATH, now))) {
          stop = 'interrupted while waiting for the reset'
          exit = EXIT.stopped
          break
        }
      }
      // a `remove` during the wait above: the task is gone (or no longer queued), it does not run
      if (!readQueue(dataDir).tasks.some((item) => item.ticket === task.ticket && runnable(item))) {
        say(`${task.ticket}: removed from the queue while waiting — skipped`)
        tried.add(task.ticket)
        continue
      }
      tried.add(task.ticket)
      const tl = acquirePidLock(ticketLockFile(task.ticket, dataDir), 'force-queue run')
      if (!tl.ok) {
        say(`${task.ticket}: being run by another process (pid ${tl.owner.pid}) — left in the queue`)
        rows.push({ ticket: task.ticket, outcome: 'busy', detail: `another run holds it, pid ${tl.owner.pid}`, commits: null, blockers: openBlockersOf(task.repo, task.ticket, dataDir), digest: '—' })
        if (exit === EXIT.completed) exit = EXIT.error
        writeSummary()
        continue
      }
      let row
      try {
        row = await runTask(task, { ...options, dataDir, marginMin, update })
      } finally {
        tl.release()
      }
      rows.push(row)
      writeSummary()
      if (row.interrupted) {
        stop = `interrupted during ${task.ticket}`
        exit = EXIT.stopped
        break
      }
      if (QUEUE_STOPS.has(row.outcome)) {
        if (row.outcome === 'weekly_limit') {
          stop = `weekly limit hit by ${task.ticket}${row.resetsAt ? `, resets ${new Date(row.resetsAt * 1000).toISOString()}` : ''}`
          exit = EXIT.weekly
        } else if (row.outcome === 'spend_limit') {
          stop = `spend limit hit by ${task.ticket}`
          exit = EXIT.spend
        } else {
          stop = `a limit with no known window or reset time hit by ${task.ticket} — nothing says when to go on`
          exit = EXIT.limit
        }
        break
      }
      if (row.outcome !== 'completed' && exit === EXIT.completed) exit = EXIT.error
    }
    const { summary, notRun } = writeSummary()
    return { ok: true, exit, rows, stop, summary, notRun }
  } finally {
    lock.release()
  }
}

const SCRIPTS = dirname(fileURLToPath(import.meta.url))
/** The path of RUN-DIGEST.md when this run wrote it (its mtime is not before the start of the task), else the command that writes it. */
function digestOf(taskDir, startedMs) {
  const file = digestFilePath(taskDir)
  try {
    if (statSync(file).mtimeMs >= startedMs - 1000) return file
  } catch {
    // none yet
  }
  return `not written — node ${join(SCRIPTS, 'run-digest.mjs')} ${taskDir}`
}

async function runTask(task, options) {
  const { dataDir, update } = options
  const base = { ticket: task.ticket, commits: null, blockers: null, digest: '—' }
  const startedMs = Date.now()
  const ctx = prepareRun(task.repo, task.ticket)
  if (!ctx.ok) {
    update(task.ticket, { status: 'not_ready', finishedAt: new Date().toISOString(), note: ctx.message })
    say(`${task.ticket}: not ready — ${ctx.message}`)
    return { ...base, outcome: 'not_ready', detail: ctx.message, blockers: openBlockersOf(task.repo, task.ticket, dataDir) }
  }
  const head = gitHead(ctx.worktree)
  update(task.ticket, { status: 'running', started: true, startedAt: new Date().toISOString() })
  say(`${task.ticket}: starting`)
  let loop
  try {
    loop = await runLoop(task.repo, task.ticket, { ...options, fetch: false })
  } catch (error) {
    loop = { ok: true, status: 'error', text: `the loop failed: ${error.message}` }
  }
  const outcome = loop.ok ? (OUTCOME[loop.status] ?? 'error') : 'not_ready'
  const interrupted = Boolean(loop.interrupted || loop.last?.interrupted)
  // The limit that stops the queue leaves its task queued: the next `run` goes on with a new session of it. Only the end of a task closes it.
  const goesOn = QUEUE_STOPS.has(outcome) || interrupted
  update(task.ticket, goesOn ? { status: 'queued', lastOutcome: outcome } : { status: outcome, finishedAt: new Date().toISOString(), note: loop.text ?? loop.message ?? '' })
  const commits = head ? gitCount(ctx.worktree, head) : null
  return {
    ...base,
    outcome,
    detail: loop.text ?? loop.message ?? '',
    commits,
    blockers: openBlockersOf(task.repo, task.ticket, dataDir),
    log: loop.last?.log ?? null,
    digest: digestOf(ctx.task.dir, startedMs),
    resetsAt: loop.resetsAt ?? null,
    interrupted,
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────


async function main(argv) {
  const [command, ...rest] = argv
  const usage = () => {
    console.error('usage: force-queue.mjs add <repo> <TICKET> | list | remove <TICKET> | check | run [--threshold 90] [--margin-min 5] [--max-sessions 3] [--retries 1]')
    process.exit(EXIT.notReady)
  }
  try {
    if (command === 'add' && rest.length === 2) {
      const out = addTask(resolve(rest[0]), rest[1])
      say(out.ok ? `${rest[1]} added (${out.entry.repo}), worktree ${out.worktree}${out.lacks?.length ? ` — it lacks ${out.lacks.join(', ')}: put it there before the night` : ''}` : `${rest[1]} not added — ${out.message}`)
      process.exit(out.ok ? 0 : EXIT.notReady)
    }
    if (command === 'list' && !rest.length) {
      const queue = readQueue()
      for (const line of queue.tasks.length ? listLines(queue) : ['the queue is empty']) say(line)
      process.exit(0)
    }
    if (command === 'remove' && rest.length === 1) {
      const out = removeTask(rest[0])
      say(out.ok ? `${rest[0]} removed` : out.message)
      process.exit(out.ok ? 0 : 1)
    }
    if (command === 'check' && !rest.length) {
      const { problems, tasks } = checkQueue()
      if (!tasks) say('nothing queued')
      for (const problem of problems) say(`NO — ${problem}`)
      if (tasks && !problems.length) say(`ready: ${tasks} task(s) can run tonight`)
      process.exit(problems.length ? 1 : 0)
    }
    if (command === 'run') {
      const args = [...rest]
      const options = { threshold: numberFlag(args, '--threshold', 90), marginMin: numberFlag(args, '--margin-min', 5), maxSessions: numberFlag(args, '--max-sessions', 3), retries: numberFlag(args, '--retries', 1) }
      if (args.length) return usage()
      const out = await runQueue(options)
      if (!out.ok) {
        say(out.message)
        process.exit(out.code)
      }
      console.log(out.summary)
      say(`summary written to ${summaryFile()}`)
      process.exit(out.exit)
    }
  } catch (error) {
    say(`failed: ${error.message}`)
    process.exit(EXIT.error)
  }
  return usage()
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
