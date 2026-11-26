#!/usr/bin/env node
/**
 * The balancer of the machine's heavy commands (VT-17 stage 1) — what `run-check` goes through instead of the one-slot `heavy.lock`.
 *
 *   node heavy-queue.mjs status [--json]       # running commands, waiting ones with the reason, paused tasks, the order
 *   node heavy-queue.mjs pause <key>           # a task's heavy command and the next ones stop (by hand only: nothing pauses by itself)
 *   node heavy-queue.mjs resume <key>
 *   node heavy-queue.mjs order <key>…          # the priority list: the first key is place 1
 *
 * A key is `<repo root>#<TICKET>` (a session without a task: `<repo root>`).
 *
 * The principle (D13): while resources suffice nobody waits and priority orders nothing. The bottleneck of the machine is memory, so a new heavy
 * command is admitted by memory; under shortage the one with the higher effective priority (its place plus one place up per minute of waiting) starts first;
 * the wait is capped. CPU is shared by `nice` weights; the background class (`taskpolicy -b`) goes on only while the cores are busy. At least one
 * heavy command always runs (D15). A running command is never stopped by the machine's state (D14) — only by the user's pause.
 *
 * State: `<lockdir>/running/<pid>.json` (the commands that run), `<lockdir>/queue/<pid>.json` (the waiting ones) — `lockdir` is
 * `STAGE_PIPELINE_LOCK_DIR` or `~/.claude/stage-pipeline`; `priorities.json` and `heavy-peaks.json` lie in the plugin data directory.
 * Every constant below is overridable by an environment variable; tests also substitute the machine's readings with `STAGE_PIPELINE_PROBE`
 * (a JSON string, or the path of a JSON file that may change during the run): `{"pressure":"warn","availableGB":2,"load":3.5,"cores":10}`,
 * `{"memory":null}` for a machine without readings.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { cpus, homedir, loadavg, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { writeJsonAtomic, withFileLock } from './file-state.mjs'
import { fileURLToPath } from 'node:url'
import { isMain } from './main-guard.mjs'
import { claudeOf, survey } from './browser-cleanup.mjs'
import { alive, descendants, identitiesOf, identityOf, processStats, processTable } from './processes.mjs'
import { findConfigRoot, pluginDataDir, readConfig, readPipelineState } from './hooks/pipeline-state.mjs'

const GB = 1024 ** 3
const number = (name, fallback) => {
  const value = Number(process.env[`STAGE_PIPELINE_BALANCE_${name}`])
  return process.env[`STAGE_PIPELINE_BALANCE_${name}`] !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback
}
/** All thresholds in one place (assumption A5). Read at each call, so a test may change the environment between calls. */
export const limits = () => ({
  reserveBytes: number('RESERVE_GB', 1.5) * GB, // memory kept free for the machine itself
  defaultBytes: number('DEFAULT_GB', 1.5) * GB, // expected memory of a check without history
  browserBytes: number('BROWSER_GB', 0.8) * GB, // of a browser (stage 6)
  agingSeconds: number('AGING_S', 60), // one place up per this many seconds of waiting
  waitCapSeconds: number('WAIT_CAP_S', 300), // then the command starts without admission (D7)
  pollMs: number('POLL_MS', 1000), // how often a waiting command looks again
  tickMs: number('TICK_MS', 1000), // the running command's pause / peak look
  announceSeconds: number('ANNOUNCE_S', 60), // the waiting line
  busySeconds: number('BUSY_S', 30), // the cores are busy this long before the background class
  rampSeconds: number('RAMP_S', 30), // a command admitted this recently has not reached its memory yet: what it still lacks is held back
  browserGraceSeconds: number('BROWSER_GRACE_S', 60), // an admitted browser has this long to start before its registry entry may go (stage 6)
  loadSamples: number('LOAD_EVERY_S', 5), // `vm.loadavg` look
  lowLoadFactor: number('LOW_LOAD', 0.8), // the background goes off below this × cores
})
const NICE_BASE = 10
const NICE_MAX = 19

// ── the machine's readings ───────────────────────────────────────────────────

function probeOverride() {
  const raw = process.env.STAGE_PIPELINE_PROBE
  if (!raw) return null
  try {
    return JSON.parse(raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8'))
  } catch {
    return null
  }
}

function sh(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 })
}

/** `{ pressure: 'normal'|'warn'|'critical', availableBytes }`, or null where the machine gives no readings (no admission then). */
export function readMemory() {
  const probe = probeOverride()
  if (probe && 'memory' in probe && probe.memory === null) return null
  if (probe && (probe.pressure || probe.availableGB !== undefined)) {
    return { pressure: probe.pressure ?? 'normal', availableBytes: Number(probe.availableGB ?? 8) * GB }
  }
  try {
    if (process.platform === 'darwin') {
      const level = Number(sh('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim())
      const text = sh('vm_stat', [])
      const page = Number(/page size of (\d+) bytes/.exec(text)?.[1])
      const pages = (name) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0)
      if (!page) return null
      const available = (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * page
      return { pressure: level >= 4 ? 'critical' : level >= 2 ? 'warn' : 'normal', availableBytes: available }
    }
    if (process.platform === 'linux') {
      const kb = Number(/^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1])
      return Number.isFinite(kb) ? { pressure: 'normal', availableBytes: kb * 1024 } : null
    }
  } catch {
    // no readings
  }
  return null
}

/** `{ load, cores }` — the 1-minute load average and the core count (substitutable). */
export function readLoad() {
  const probe = probeOverride()
  return { load: Number(probe?.load ?? loadavg()[0]), cores: Number(probe?.cores ?? cpus().length) }
}

// ── files ────────────────────────────────────────────────────────────────────

export const lockDir = () => process.env.STAGE_PIPELINE_LOCK_DIR ?? join(homedir(), '.claude', 'stage-pipeline')
const runningDir = () => join(lockDir(), 'running')
const queueDir = () => join(lockDir(), 'queue')
const prioritiesFile = (data = pluginDataDir()) => join(data, 'priorities.json')
const peaksFile = (data = pluginDataDir()) => join(data, 'heavy-peaks.json')

const writeJson = writeJsonAtomic

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// ── priorities.json (D4): order and paused tasks (an old file's `boundary` is read past and dropped) ──

export function readPriorities(data = pluginDataDir()) {
  const parsed = readJson(prioritiesFile(data), {})
  const order = Array.isArray(parsed.order) ? [...new Set(parsed.order.filter((key) => typeof key === 'string'))] : []
  const paused = Array.isArray(parsed.paused) ? [...new Set(parsed.paused.filter((key) => typeof key === 'string'))] : []
  return { version: 1, order, paused }
}

/** Read-modify-write of priorities.json under the short lock; `change(state)` returns the new state or mutates it. */
export function updatePriorities(change, data = pluginDataDir()) {
  return withFileLock(prioritiesFile(data), () => {
    const next = change(readPriorities(data)) ?? null
    const state = next ?? readPriorities(data)
    writeJson(prioritiesFile(data), state)
    return state
  })
}

/** A new task (or a task-less session's root) stands last. */
export function ensureTask(key, data = pluginDataDir()) {
  if (readPriorities(data).order.includes(key)) return
  updatePriorities((state) => {
    if (!state.order.includes(key)) {
      state.order.push(key)
    }
    return state
  }, data)
}

export const setOrder = (keys, data = pluginDataDir()) =>
  updatePriorities((state) => {
    const order = [...new Set(keys)]
    return { ...state, order }
  }, data)

export const setPaused = (key, paused, data = pluginDataDir()) =>
  updatePriorities((state) => ({ ...state, paused: paused ? [...new Set([...state.paused, key])] : state.paused.filter((item) => item !== key) }), data)

/** 1-based place of a key; a key without a place stands after the last one (and runs with `nice` 19). */
export const placeOf = (order, key) => (order.includes(key) ? order.indexOf(key) + 1 : order.length + 1)
/** `nice` by place: 10 for place 1, +1 per place, at most 19; a key without a place — 19. Null where `nice` does not exist. */
export function niceFor(order, key) {
  if (process.platform === 'win32') return null
  return order.includes(key) ? Math.min(NICE_BASE + order.indexOf(key), NICE_MAX) : NICE_MAX
}

/**
 * The key of the task a command in `cwd` belongs to is `.key`: `<repo root>#<TICKET>` of the current task, else the repo root.
 * `{ key, task, root, ticket, taskDir }`: `task` is true when the key has a ticket; `root` is the repo root, `ticket` the current task's ticket and `taskDir` the task directory of the config
 * (null off a pipeline repo). A structured answer, never split from `key`: a repo path may contain `#`. Stage 3 of VT-17 reads all of it, keep it.
 */
export function taskInfo(cwd) {
  // no config in reach (no repo, or one without the pipeline): no task, and the file system alone says so — `readPipelineState` would spawn git for nothing
  if (!findConfigRoot(cwd)) return { key: cwd, task: false, root: cwd, ticket: null, taskDir: null }
  let state = null
  try {
    state = readPipelineState(cwd)
  } catch {
    // not a pipeline repo
  }
  const root = state?.root ?? cwd
  const task = state?.tasks?.find((item) => item.current)
  return { key: task ? `${root}#${task.ticket}` : root, task: Boolean(task), root, ticket: task?.ticket ?? null, taskDir: state?.taskDir ?? null }
}

/**
 * The task a Claude session works on, one rule for the tracker's snapshot, the pause of a task's browsers and the browser hook (VT-19). Three sources:
 * `folders` — the folders of the session's transcript, newest first (`{ cwd, at }`, `at` in epoch ms; the tracker reads them from the transcript's tail), the first that `taskOf` resolves to a task counts, so a session
 * that came back to a folder with no task for one command stays with its task; `pair` — the `run-check` pair (`readSessionTasks`) with its `at`; `own` — `taskInfo` of the session process's folder (in VS Code always the window's).
 * Of the two sources that carry a task the newer wins; a source with no task never covers one with a task (AC-8.3 of VT-17); with neither, the pair of a folder with no task, then the process folder.
 * Returns `{ info, source }`: `info` has the shape of `taskInfo` (null when there is no source at all), `source` is `transcript`, `pair` or `process`.
 */
export function pickSessionTask({ folders = [], pair = null, own = null, taskOf = taskInfo } = {}) {
  let fromFolder = null
  for (const folder of folders) {
    let info = null
    try {
      info = taskOf(folder.cwd)
    } catch {
      // a folder that is not a repo: no task
    }
    if (info?.task) {
      fromFolder = { info, at: Number.isFinite(folder.at) ? folder.at : 0 }
      break
    }
  }
  const fromPair = pair?.task ? { info: pair, at: Number.isFinite(pair.at) ? pair.at : 0 } : null
  if (fromFolder && (!fromPair || fromFolder.at >= fromPair.at)) return { info: fromFolder.info, source: 'transcript' }
  if (fromPair) return { info: fromPair.info, source: 'pair' }
  if (pair && !own?.task) return { info: pair, source: 'pair' }
  return { info: own, source: 'process' }
}

// ── the session ↔ task pairs ─────────────────────────────────────────────────

/**
 * A Claude session may sit in one folder (the main tree) while its commands run in another (a linked worktree of the task): `taskInfo` of the two folders gives two keys. `run-check` therefore
 * writes a pair — the session's `claude` process, its identity, and the task key of the folder the command runs in — into `<data dir>/session-tasks.json`; the pair is one source of `pickSessionTask`, which the
 * tracker (a session's card, the pause of its browsers) and the browser hook use for the session's key. The last run overwrites the old pair; a pair whose process is gone
 * or no longer the same (a reused PID) is dropped.
 */
const sessionTasksFile = (data = pluginDataDir()) => join(data, 'session-tasks.json')

/** A pair is live while its process is in `table`, did not start after the pair was written, and still has the command line it had (the identity string is `<start time> <command line>`). */
const pairLive = (table, pid, item, now) => sameProcessIn(table, { pid, since: item?.at }, now) && (!item?.identity || !table.get(pid).args || String(item.identity).endsWith(table.get(pid).args))

/** Writes the pair of the `claude` process above this one with `info` (`taskInfo` of the command's folder); returns it, or null when there is no such process or no table. Never throws. */
export function recordSessionTask(info, { table = processTable({ timeout: 1500 }), from = process.pid, data = pluginDataDir(), identity = identityOf, now = Date.now() } = {}) {
  try {
    const session = claudeOf(table, from)
    if (!session) return null
    const pair = { pid: session.pid, identity: identity(session.pid), key: info.key, root: info.root, ticket: info.ticket, taskDir: info.taskDir, task: Boolean(info.task), at: now }
    withFileLock(sessionTasksFile(data), () => {
      const kept = Object.fromEntries(Object.entries(readJson(sessionTasksFile(data), {})).filter(([pid, item]) => Number(pid) !== pair.pid && pairLive(table, Number(pid), item, now)))
      writeJson(sessionTasksFile(data), { ...kept, [pair.pid]: pair })
    })
    return pair
  } catch {
    return null
  }
}

/** pid → `{ key, root, ticket, taskDir, task }` of the sessions with a pair that is still valid in `table` (null table: none). */
export function readSessionTasks(table, data = pluginDataDir(), now = Date.now()) {
  const pairs = new Map()
  if (!table) return pairs
  for (const [pid, item] of Object.entries(readJson(sessionTasksFile(data), {}))) {
    if (typeof item?.key === 'string' && pairLive(table, Number(pid), item, now)) pairs.set(Number(pid), item)
  }
  return pairs
}

// ── the registry: running commands and waiters ───────────────────────────────

function sameProcess(entry) {
  if (!alive(entry.pid)) return false
  const now = identityOf(entry.pid)
  return now === null || !entry.identity || now === entry.identity
}

/**
 * The same question answered from a process table already read (no `ps` call): the PID is in the table and the process did not start after the entry was written (a reused PID is
 * a younger process). `since`: when the entry was made, epoch ms; a row with no `age` (or an entry with no `since`) is taken as the same process.
 */
export function sameProcessIn(table, { pid, since }, now = Date.now()) {
  const row = table.get(pid)
  if (!row) return false
  return !(Number.isFinite(since) && Number.isFinite(row.age) && now - row.age * 1000 > since + 5000)
}

/**
 * The live entries of a directory. Without `given` each entry is looked at by its own `ps -p`, and a dead process's or a reused PID's entry is removed on the way (AC-1.11). `given`: a process
 * table the caller has read at `readAt` (the tracker's snapshot makes one `ps` call for everything): the entries are only filtered by it and never removed, because a command that started after
 * the table was read has no row in it yet (AC-8.1). A PID with no row is asked with signal 0 (no `ps`), a PID with a row is the same process while it did not start after the entry was written.
 */
function liveEntries(dir, given = null, readAt = Date.now()) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const entries = []
  let table = given ?? undefined // the process table, read once per call and only when a browser entry needs it
  const tableOnce = () => (table === undefined ? (table = tableSource.read()) : table)
  const judged = (entry) => {
    if (!given) return sameProcess(entry)
    return given.has(entry.pid) ? sameProcessIn(given, { ...entry, since: entry.since ?? entry.started }, readAt) : alive(entry.pid)
  }
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    const file = join(dir, name)
    const entry = readJson(file, null)
    if (!entry || !Number.isInteger(entry.pid)) continue
    if (!judged(entry)) {
      if (!given) rmSync(file, { force: true })
    } else if (entry.watch && !browserEntryLive(entry, file, tableOnce(), Date.now(), Boolean(given))) {
      if (!given) rmSync(file, { force: true })
    } else entries.push(entry)
  }
  return entries
}

// ── the browser's entry (VT-17 stage 6) ──────────────────────────────────────

/** A browser's entries carry no command of a repo: the peak is the machine's, under this pair of the peaks file. */
export const BROWSER_REPO = '(machine)'
export const BROWSER_COMMAND = 'browser'
/** Where the browser entries read the process table from: the real `ps`, a fake table in the tests. */
export const tableSource = { read: () => processStats() }

/**
 * Whether a browser's registry entry (`watch: true`, its `pid` is the Claude session's) is still live: the session's tree holds a browser main process, or the grace after admission
 * has not run out (the browser is starting). While it lives its peak RSS is kept in the entry; when it goes the peak is recorded for the machine and the entry is dropped by the caller.
 * Without a process table the entry stays (fail open).
 */
function browserEntryLive(entry, file, table, now = Date.now(), readOnly = false) {
  if (!table) return true
  const mains = survey(table, { session: entry.pid }).mine.map((browser) => browser.pid)
  if (mains.length) {
    const rss = mains.reduce((sum, pid) => sum + [table.get(pid), ...descendants(table, pid, { depth: 12 })].filter(Boolean).reduce((inner, row) => inner + (row.rssKb ?? 0) * 1024, 0), 0)
    if (rss > (entry.peak ?? 0) || entry.childPid !== mains[0]) {
      entry.peak = Math.max(rss, entry.peak ?? 0)
      entry.childPid = mains[0]
      writeJson(file, entry)
    }
    return true
  }
  if (now < (entry.graceUntil ?? 0)) return true
  if (readOnly) return false // the snapshot only filters: the peak is recorded when the entry is removed by a reader that owns the registry
  recordPeak(BROWSER_REPO, BROWSER_COMMAND, entry.peak ?? 0, pluginDataDir(), true)
  return false
}

/** Registers an admitted browser as a running command of its session (`pid` — the Claude process): it stays while the session holds a browser main process. */
export function registerBrowser({ pid, key, now = Date.now(), cfg = limits() }) {
  const entry = {
    pid, identity: identityOf(pid), key, repo: BROWSER_REPO, command: BROWSER_COMMAND, kind: 'browser', started: now, expectedBytes: expectedBytes(BROWSER_REPO, BROWSER_COMMAND, 'browser', cfg),
    background: false, paused: false, childPid: -1, watch: true, graceUntil: now + cfg.browserGraceSeconds * 1000, peak: 0,
  }
  writeJson(entryFile(runningDir(), pid), entry)
  return entry
}

export const readRunning = (table = null, readAt = Date.now()) => liveEntries(runningDir(), table, readAt)
export const readWaiting = (table = null, readAt = Date.now()) => liveEntries(queueDir(), table, readAt)
const entryFile = (dir, pid) => join(dir, `${pid}.json`)

// ── admission (pure) ─────────────────────────────────────────────────────────

/** Effective priority of a waiter: its place minus the minutes waited (the smaller, the earlier). */
export function effectivePriority(waiter, order, now, cfg = limits()) {
  const waited = Math.max(0, now - waiter.since) / 1000
  return placeOf(order, waiter.key) - (cfg.agingSeconds > 0 ? waited / cfg.agingSeconds : 0)
}

const gbText = (bytes) => `${(bytes / GB).toFixed(1)} GB`
/** Nothing runs for `kind`: an open browser does not hold a heavy command back (its memory still counts in the headroom); a browser waiter looks at every entry. */
const idle = (running, kind = 'check') => running.filter((entry) => !entry.paused && (kind === 'browser' || entry.kind !== 'browser')).length === 0

/**
 * May `waiter` start, and who is ahead of it. The waiters are taken in the order of effective priority; each one that fits starts (and takes its
 * memory from the next ones), one that does not fit does not hold the others back (no stagnation). Rules: nothing runs → the first starts at any
 * pressure (D15); `critical` — one at a time; otherwise the expected memory must fit in available minus the reserve. A paused task's waiter never starts.
 * `rampBytes` — what the commands admitted moments ago still lack to reach their expected memory (`rampOf`); `available` does not show it yet.
 * `memory` null: no readings, no admission. A paused running command does not count as running: it must not hold the machine idle.
 */
export function decide({ self, waiters, running, memory, order, paused: pausedKeys = [], rampBytes = 0, now = Date.now(), cfg = limits() }) {
  const paused = process.platform === 'win32' ? [] : pausedKeys // D16: no pause on Windows, a paused key holds nothing there
  if (paused.includes(self.key)) return { admit: false, reason: 'paused: the task is on pause', ahead: [] }
  const others = running.filter((entry) => entry.pid !== self.pid)
  if (!memory) return { admit: true, reason: '', ahead: [] }
  // An entry that is already in `running/` (written before its waiting one is removed) is counted there, not a second time as a waiter.
  const candidates = [...waiters.filter((entry) => entry.pid !== self.pid && !paused.includes(entry.key) && !running.some((item) => item.pid === entry.pid)), self]
    .map((entry) => ({ entry, eff: effectivePriority(entry, order, now, cfg) }))
    .sort((a, b) => a.eff - b.eff || a.entry.since - b.entry.since || a.entry.pid - b.entry.pid)
  const virtual = [...others]
  let granted = 0
  for (let index = 0; index < candidates.length; index += 1) {
    const { entry } = candidates[index]
    let verdict = { ok: true, reason: '' }
    if (!idle(virtual, entry.kind)) {
      const headroom = memory.availableBytes - cfg.reserveBytes - rampBytes - granted
      const need = entry.expectedBytes
      const text = rampBytes > 0 && need <= headroom + rampBytes
        ? `ramp: ~${gbText(rampBytes)} still expected; needs ~${gbText(need)}, ${gbText(Math.max(0, headroom + rampBytes))} available before it`
        : `memory: needs ~${gbText(need)}, ${gbText(Math.max(0, headroom))} available`
      if (memory.pressure === 'critical') verdict = { ok: false, reason: 'pressure: critical' }
      else if (need > headroom) verdict = { ok: false, reason: memory.pressure === 'warn' ? `pressure: warn; ${text}` : text }
    }
    if (verdict.ok) {
      virtual.push(entry)
      granted += entry.expectedBytes
    }
    if (entry.pid === self.pid) return { admit: verdict.ok, reason: verdict.reason, ahead: candidates.slice(0, index).map((item) => item.entry.key) }
  }
  return { admit: true, reason: '', ahead: [] }
}

/**
 * The background class by load: busy (load ≥ cores) for `busySeconds` → on, for a task in the lower half of the running ones;
 * load below `lowLoadFactor` × cores → off. Returns the new `{ busySince, background }`.
 */
export function nextBackground(state, { load, cores, now, lowerHalf, cfg = limits() }) {
  const busy = load >= cores
  const busySince = busy ? (state.busySince ?? now) : null
  if (state.background) return load < cfg.lowLoadFactor * cores ? { busySince, background: false } : { busySince, background: true }
  return { busySince, background: busy && now - busySince >= cfg.busySeconds * 1000 && lowerHalf }
}

/** Whether `pid` is in the lower half of the running commands by priority (a lone command is in the upper one). */
export function inLowerHalf(running, pid, order) {
  // An open browser is not a heavy command: it is no one's rival for the cores, as in `idle`.
  const ranked = running.filter((entry) => entry.kind !== 'browser').sort((a, b) => placeOf(order, a.key) - placeOf(order, b.key) || a.started - b.started || a.pid - b.pid)
  const rank = ranked.findIndex((entry) => entry.pid === pid)
  return rank >= Math.ceil(ranked.length / 2)
}

// ── the memory of a command ──────────────────────────────────────────────────

const peakKey = (repo, command) => `${repo}\n${command}`
export const recordedPeak = (repo, command, data = pluginDataDir()) => Number(readJson(peaksFile(data), {})[peakKey(repo, command)]) || 0
/**
 * `smooth`: a browser's peak (the highest sample within the life of one browser entry) is averaged with the stored value,
 * so one spike decays over the next browsers instead of making every later one wait the full cap.
 */
function recordPeak(repo, command, bytes, data = pluginDataDir(), smooth = false) {
  if (!bytes) return
  withFileLock(peaksFile(data), () => {
    const peaks = readJson(peaksFile(data), {})
    const key = peakKey(repo, command)
    writeJson(peaksFile(data), { ...peaks, [key]: smooth && Number(peaks[key]) ? Math.round(0.5 * Number(peaks[key]) + 0.5 * bytes) : bytes })
  })
}
export function expectedBytes(repo, command, kind = 'check', cfg = limits()) {
  return recordedPeak(repo, command) || (kind === 'browser' ? cfg.browserBytes : cfg.defaultBytes)
}

/** The tree of `pid` (itself and its descendants) with the summed RSS in bytes; `table` is a process table of `processStats` (one `ps` call when not given). */
function treeOf(pid, table = processStats()) {
  if (!table) return { pids: [pid], rss: 0 }
  const pids = [pid, ...descendants(table, pid, { depth: 12 }).map((row) => row.pid)].filter((item) => table.has(item))
  return { pids, rss: pids.reduce((sum, item) => sum + (table.get(item).rssKb ?? 0) * 1024, 0) }
}

/**
 * The memory the running commands younger than `rampSeconds` have yet to take: max(0, expected − the tree's current RSS) per command, scaled by the window left.
 * Without it three commands started a second apart would all see the same `available` (AC-1.1).
 */
export function rampOf(running, now = Date.now(), cfg = limits(), rows = null) {
  const young = running.filter((entry) => now - entry.started < cfg.rampSeconds * 1000)
  if (!young.length) return 0
  const table = rows ?? processStats()
  // The held-back share falls linearly to 0 over the window: a command that never reaches its expected memory does not hold the shortfall for good.
  return young.reduce((sum, entry) => {
    const left = 1 - (now - entry.started) / (cfg.rampSeconds * 1000)
    return sum + Math.max(0, entry.expectedBytes - treeOf(entry.childPid ?? entry.pid, table).rss) * left
  }, 0)
}

// ── the background class ─────────────────────────────────────────────────────

export const taskpolicyBin = () => process.env.STAGE_PIPELINE_TASKPOLICY ?? (process.platform === 'darwin' ? '/usr/sbin/taskpolicy' : null)
function taskpolicy(flag, pids) {
  const bin = taskpolicyBin()
  if (!bin) return
  for (const pid of pids) {
    try {
      execFileSync(bin, [flag, '-p', String(pid)], { stdio: 'ignore', timeout: 2000 })
    } catch {
      // the process is gone or the call is refused: the background is only a courtesy
    }
  }
}

/** The PIDs of `recorded` (pid → identity at the time) that are still the same process in `now` (pid → identity); a gone or reused PID, or no reading at all, is left out. */
export function sameProcesses(recorded, now) {
  return [...recorded].filter(([pid, identity]) => now?.has(pid) && (!identity || now.get(pid) === identity)).map(([pid]) => pid)
}

const signalAll = (pids, signal) => {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // gone
    }
  }
}

// ── the admission of one command ─────────────────────────────────────────────

/** Removes this process's entries (a wait or a run cut short by a signal before `admit` returned). */
export function dropEntries(pid = process.pid) {
  rmSync(entryFile(runningDir(), pid), { force: true })
  rmSync(entryFile(queueDir(), pid), { force: true })
}

/**
 * Takes `run-check`'s place in the machine's queue: waits for admission in `low` mode, registers the command as running, and returns
 * `{ key, place, nice, watch(child), unstop(child), terminate(child, signal), finish({ record }) }`. In `normal` memory is not looked at (AC-1.8), but a paused task's
 * command still waits for the resume (D3). `watch` starts the command's own look (pause, the peak, the background class); `finish` removes
 * the entry and records the peak. `passWhen` (polled on each round) lets a caller through without admission, `passed` in the result says so; `capSeconds`/`capMessage`/`capPaused` change the wait cap for a caller with its own (the browser hook: 240 s, its own line, a paused task's wait ends too).
 */
export async function admit({ cwd, repo, command, kind = 'check', mode, say = console.log, capSeconds = null, capMessage = null, capPaused = false, passWhen = null, key: given = null }) {
  const cfg = limits()
  const data = pluginDataDir()
  const key = given ?? taskInfo(cwd).key
  ensureTask(key, data)
  const order = readPriorities(data).order
  const self = { pid: process.pid, identity: identityOf(process.pid), key, repo, command, kind, started: Date.now(), expectedBytes: expectedBytes(repo, command, kind, cfg), background: false, paused: false, childPid: null }
  const nice = niceFor(order, key)
  const useMemory = mode?.name === 'low'

  /** Waits until the command may go. `first`: the entry in `running/` is written BEFORE the waiting one is removed, so nobody sees an empty machine in between. */
  let passed = false
  async function waitForAdmission(first) {
    const waiter = { ...self, since: Date.now() }
    writeJson(entryFile(queueDir(), self.pid), waiter)
    let lastAnnounce = -Infinity
    let verdict = { admit: false, reason: '', ahead: [] }
    const go = () => {
      if (first) {
        self.started = Date.now()
        writeJson(entryFile(runningDir(), self.pid), self)
      }
    }
    try {
      for (;;) {
        if (passWhen?.()) {
          passed = true
          return
        }
        const now = Date.now()
        const state = readPriorities(data)
        // The queue is read BEFORE `running/`: an admitted command writes its running entry before it removes its waiting one,
        // so in this order it is seen in at least one of them. Read the other way round, a neighbour admitted between the two reads is in neither, and both start.
        const waiters = readWaiting()
        const running = readRunning()
        const memory = useMemory ? readMemory() : null
        const ramp = memory ? rampOf(running.filter((entry) => entry.pid !== self.pid), now, cfg) : 0
        verdict = decide({ self: waiter, waiters, running, memory, order: state.order, paused: state.paused, rampBytes: ramp, now, cfg })
        const waited = (now - waiter.since) / 1000
        if (verdict.admit) return go()
        if (verdict.reason !== waiter.reason) {
          waiter.reason = verdict.reason
          writeJson(entryFile(queueDir(), self.pid), waiter)
        }
        if ((capPaused || process.platform === 'win32' || !state.paused.includes(key)) && waited >= (capSeconds ?? cfg.waitCapSeconds)) {
          say(capMessage ? capMessage(waited, verdict.reason) : `balance: waited ${Math.round(waited)} s, starting without admission (${verdict.reason})`)
          return go()
        }
        if (waited - lastAnnounce >= cfg.announceSeconds) {
          say(`balance: waiting ${Math.round(waited)} s — ${verdict.reason}; ahead: ${verdict.ahead.length ? verdict.ahead.join(', ') : 'none'}`)
          lastAnnounce = waited
        }
        await new Promise((done) => setTimeout(done, cfg.pollMs))
      }
    } finally {
      rmSync(entryFile(queueDir(), self.pid), { force: true })
    }
  }

  await waitForAdmission(true)
  // a registry that cannot be written (read-only or full disk) must not stop the command: the entry is only the balancer's view of it
  const save = () => {
    try {
      writeJson(entryFile(runningDir(), self.pid), self)
    } catch {
      // not recorded
    }
  }

  let peak = 0
  let timer = null
  let stopped = false
  const stoppedIds = new Map() // PID → identity of what the pause stopped: a PID is signalled again only while it is still that process
  let warnedPause = false
  let busy = false
  let loadState = { busySince: null, background: false }
  let lastLoadLook = 0
  const switched = new Map() // PID → identity of what was put into the background class: each is switched once; a dead or reused PID is pruned on the tick

  /**
   * Brings `switched` in line with `pids` (the PIDs it is to cover now: the tree of this tick, already read) and returns the ones not yet in it, with their identity noted.
   * Gone, outside the tree or reused (a different identity) is dropped. One `ps -p` for all of them, never one per PID; when `ps` fails nothing is dropped and nothing noted.
   */
  function syncSwitched(pids) {
    for (const pid of switched.keys()) if (!pids.includes(pid)) switched.delete(pid)
    const ids = identitiesOf(pids)
    if (ids) for (const [pid, identity] of switched) if (!ids.has(pid) || (identity && ids.get(pid) !== identity)) switched.delete(pid)
    const fresh = pids.filter((pid) => !switched.has(pid) && (!ids || ids.has(pid)))
    for (const pid of fresh) switched.set(pid, ids?.get(pid) ?? null)
    return fresh
  }

  /** The stopped PIDs that are still the processes that were stopped (a gone or reused PID is left alone) and the tree's own. */
  function stoppedNow(child) {
    const ids = stoppedIds.size ? identitiesOf([...stoppedIds.keys()]) : new Map()
    return [...new Set([...sameProcesses(stoppedIds, ids), ...treeOf(child.pid).pids])]
  }

  /** SIGSTOP to the tree, then again to what it forked in the meantime, until nothing new shows up. */
  function stopTree(rootPid) {
    const seen = new Set()
    for (let round = 0; round < 5; round += 1) {
      const fresh = treeOf(rootPid).pids.filter((pid) => !seen.has(pid))
      if (!fresh.length) break
      signalAll(fresh, 'SIGSTOP')
      for (const pid of fresh) seen.add(pid)
    }
    return [...seen]
  }

  function watch(child) {
    self.childPid = child.pid
    save()
    timer = setInterval(async () => {
      if (busy) return
      busy = true
      try {
        const paused = readPriorities(data).paused.includes(key)
        const tree = treeOf(child.pid)
        if (paused && !stopped && process.platform === 'win32') {
          if (!warnedPause) say('balance: pause is not supported on Windows — the command goes on')
          warnedPause = true
        } else if (paused && !stopped) {
          const pids = stopTree(child.pid)
          const ids = identitiesOf(pids)
          stoppedIds.clear()
          for (const pid of pids) stoppedIds.set(pid, ids?.get(pid) ?? null)
          stopped = true
          self.paused = true
          save()
        } else if (!paused && stopped) {
          // After the pause a `low` command goes through admission again (a `normal` one does not look at memory); its own entry stays in the registry (a stopped command's memory is still taken).
          try {
            await waitForAdmission(false)
          } catch {
            // a registry that cannot be written: the tree is continued without admission (AC-8.2), the entry is only the balancer's view
          }
          signalAll(stoppedNow(child), 'SIGCONT')
          stoppedIds.clear()
          stopped = false
          self.paused = false
          save()
        } else if (!stopped) {
          peak = Math.max(peak, tree.rss)
          const now = Date.now()
          if (now - lastLoadLook >= cfg.loadSamples * 1000) {
            lastLoadLook = now
            const { load, cores } = readLoad()
            const lowerHalf = inLowerHalf(readRunning(), self.pid, readPriorities(data).order)
            // no `taskpolicy` here (Linux): nothing is put into the background and nothing is shown as throttled
            loadState = nextBackground(loadState, { load, cores, now, lowerHalf: lowerHalf && Boolean(taskpolicyBin()), cfg })
          }
          if (loadState.background) taskpolicy('-b', syncSwitched(tree.pids))
          if (loadState.background !== self.background) {
            if (!loadState.background) {
              taskpolicy('-B', [...switched.keys()])
              switched.clear()
            }
            self.background = loadState.background
            save()
          }
        }
      } catch {
        // a look that failed is repeated at the next tick
      } finally {
        busy = false
      }
    }, cfg.tickMs)
    return () => clearInterval(timer)
  }

  /** The command's own signals while it is stopped: continue it, otherwise a SIGTERM stays pending. */
  function unstop(child) {
    if (stopped && child?.pid) signalAll(stoppedNow(child), 'SIGCONT')
  }

  /** A signal to the command: the paused tree is continued first, then the signal goes to every process of the tree (grandchildren too), not only the `sh` wrapper. */
  function terminate(child, signal) {
    if (!child?.pid) return
    const pids = stoppedNow(child)
    if (stopped) signalAll(pids, 'SIGCONT')
    signalAll(pids, signal)
  }

  /** `record: false` — a run cut short by a signal has not reached its peak: the recorded one stays. */
  function finish({ record = true } = {}) {
    if (timer) clearInterval(timer)
    if (switched.size) {
      const ids = identitiesOf([...switched.keys()])
      taskpolicy('-B', [...switched].filter(([pid, identity]) => !ids || (ids.has(pid) && (!identity || ids.get(pid) === identity))).map(([pid]) => pid))
    }
    // the command's own result does not depend on the machine's files: a registry or a peak that cannot be written changes nothing
    try {
      dropEntries(self.pid)
    } catch {
      // the entry of a dead pid is removed by the next reader
    }
    if (record) {
      try {
        recordPeak(repo, command, peak)
      } catch {
        // the old peak stays
      }
    }
  }

  return { key, place: placeOf(order, key), nice, watch, unstop, terminate, finish, passed }
}

// ── the resource mode ────────────────────────────────────────────────────────

/**
 * `resources:` from pipeline.config.local.md / pipeline.config.md (the machine's layout goes in local), otherwise by memory:
 * at 16 GB and less the dev server, browser, IDE and Claude Code already share memory, and a second heavy check is swap.
 */
export function resourceMode(root) {
  const override = process.env.STAGE_PIPELINE_RESOURCES
  if (override === 'low' || override === 'normal') return { name: override, why: 'STAGE_PIPELINE_RESOURCES' }
  const configured = readConfig(root).match(/^\s*-\s*resources:\s*`?(low|normal)\b/m)?.[1]
  if (configured) return { name: configured, why: 'resources in pipeline.config' }
  const gb = Math.round(totalmem() / 1024 ** 3)
  return gb <= 16 ? { name: 'low', why: `${gb} GB RAM (≤ 16) — admission by memory` } : { name: 'normal', why: `${gb} GB RAM` }
}

// ── the snapshot and the CLI ─────────────────────────────────────────────────

/** Everything `status` shows (also what the tracker's snapshot reads): running, waiting with the reason, paused, order, the machine's readings. */
export function snapshot(now = Date.now()) {
  const priorities = readPriorities()
  return {
    memory: readMemory(),
    ...readLoad(),
    order: priorities.order,
    paused: priorities.paused,
    running: readRunning(),
    waiting: readWaiting().map((entry) => ({ ...entry, waitedSeconds: Math.round((now - entry.since) / 1000) })),
  }
}

function printStatus(json) {
  const info = snapshot()
  if (json) {
    console.log(JSON.stringify(info, null, 2))
    return
  }
  const memory = info.memory ? `pressure ${info.memory.pressure}, available ${gbText(info.memory.availableBytes)}` : 'no memory readings'
  console.log(`heavy-queue: ${memory}; load ${info.load.toFixed(1)} on ${info.cores} cores`)
  console.log(`running (${info.running.length}):`)
  for (const entry of info.running) {
    console.log(`  ${entry.key}  ${entry.command}  ~${gbText(entry.expectedBytes)}  pid ${entry.pid}${entry.background ? '  [background]' : ''}${entry.paused ? '  [paused]' : ''}`)
  }
  console.log(`waiting (${info.waiting.length}):`)
  for (const entry of info.waiting) console.log(`  ${entry.key}  ${entry.command}  ${entry.waitedSeconds} s — ${entry.reason || 'looking'}`)
  console.log(process.platform === 'win32' ? 'paused: not supported on Windows (pause is ignored)' : `paused: ${info.paused.length ? info.paused.join(', ') : 'none'}`)
  console.log(`order: ${info.order.length ? info.order.map((key, index) => `${index + 1}. ${key}`).join('  ') : 'empty'}`)
}

if (isMain(import.meta.url)) {
  const [verb, ...rest] = process.argv.slice(2)
  const keys = rest.filter((item) => !item.startsWith('--'))
  if (verb === 'status') printStatus(rest.includes('--json'))
  else if ((verb === 'pause' || verb === 'resume') && keys.length === 1) {
    setPaused(keys[0], verb === 'pause')
    let stopped = 0
    try {
      // The task's browsers (main process and helpers) stop and continue with it (D3). monitor.mjs finds their PIDs in the process table (never from the arguments); it imports this
      // script, so it runs as a child, not as an import.
      stopped = Number(execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'monitor.mjs'), 'browsers', verb, keys[0]], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim()) || 0
    } catch {
      // the pause itself is written; the browsers are a courtesy
    }
    console.log(`heavy-queue: ${verb === 'pause' ? 'paused' : 'resumed'} ${keys[0]}${stopped ? ` (${stopped} browser process${stopped === 1 ? '' : 'es'} ${verb === 'pause' ? 'stopped' : 'continued'})` : ''}`)
  } else if (verb === 'order' && keys.length) {
    setOrder(keys)
    console.log(`heavy-queue: order — ${keys.map((key, index) => `${index + 1}. ${key}`).join('  ')}`)
  } else {
    console.error('usage: node heavy-queue.mjs status [--json] | pause <key> | resume <key> | order <key>…')
    process.exit(2)
  }
}
