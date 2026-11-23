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
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus, homedir, loadavg, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { isMain } from './main-guard.mjs'
import { alive, descendants, identityOf } from './processes.mjs'
import { pluginDataDir, readConfig, readPipelineState } from './hooks/pipeline-state.mjs'

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

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, file)
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * A dead owner's lock is removed only under a second short lock, after the owner is read again there: two waiters that both saw the dead owner
 * cannot then remove the lock the first one has just taken. Returns true when the lock was removed (try again at once).
 */
function takeOverStale(lock) {
  const readOwner = () => {
    try {
      return Number(readFileSync(lock, 'utf8').trim() || 0)
    } catch {
      return -1 // gone
    }
  }
  const owner = readOwner()
  if (owner === -1) return true
  if (!owner || alive(owner)) return false
  const guard = `${lock}.takeover`
  try {
    writeFileSync(guard, String(process.pid), { flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    // A fresh guard belongs to a live taker and is not touched (renaming it would leave a gap in which a third waiter takes the lock too). Only a guard older
    // than the threshold is renamed to a unique name (atomic) and the renamed file is judged; a fresh one caught by the rename in that rare race is put back
    // with a no-clobber link.
    const staleAfter = 10_000
    try {
      if (Date.now() - statSync(guard).mtimeMs <= staleAfter) return false
    } catch {
      return false // gone
    }
    const moved = `${guard}.stale-${process.pid}-${Date.now()}`
    try {
      renameSync(guard, moved)
      if (Date.now() - statSync(moved).mtimeMs <= staleAfter) {
        try {
          linkSync(moved, guard)
        } catch {
          // another taker already made a new one
        }
      }
    } catch {
      // gone
    }
    rmSync(moved, { force: true })
    return false
  }
  try {
    const again = readOwner()
    if (again > 0 && !alive(again)) {
      rmSync(lock, { force: true })
      return true
    }
    return again === -1
  } finally {
    rmSync(guard, { force: true })
  }
}

/** A short lock around one read-modify-write of a state file (the pid of the owner; a dead owner's lock is taken over). */
function withFileLock(file, fn) {
  const lock = `${file}.lock`
  mkdirSync(dirname(lock), { recursive: true })
  let held = false
  for (let attempt = 0; attempt < 100 && !held; attempt += 1) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
      held = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!takeOverStale(lock)) sleepSync(30)
    }
  }
  try {
    return fn()
  } finally {
    if (held) rmSync(lock, { force: true })
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

/** The key of the task a command in `cwd` belongs to: `<repo root>#<TICKET>` of the current task, else the repo root. */
export function taskKey(cwd) {
  return taskInfo(cwd).key
}

/** `{ key, task }`: `task` is true when the key has a ticket (a structured answer: a repo path may contain `#`); stage 3 of VT-17 reads `.task`, keep it. */
export function taskInfo(cwd) {
  let state = null
  try {
    state = readPipelineState(cwd)
  } catch {
    // not a pipeline repo
  }
  const root = state?.root ?? cwd
  const task = state?.tasks?.find((item) => item.current)
  return { key: task ? `${root}#${task.ticket}` : root, task: Boolean(task) }
}

// ── the registry: running commands and waiters ───────────────────────────────

function sameProcess(entry) {
  if (!alive(entry.pid)) return false
  const now = identityOf(entry.pid)
  return now === null || !entry.identity || now === entry.identity
}

/** The live entries of a directory; a dead process's or a reused PID's entry is removed on the way (AC-1.11). */
function liveEntries(dir) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const entries = []
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    const file = join(dir, name)
    const entry = readJson(file, null)
    if (!entry || !Number.isInteger(entry.pid)) continue
    if (sameProcess(entry)) entries.push(entry)
    else rmSync(file, { force: true })
  }
  return entries
}

export const readRunning = () => liveEntries(runningDir())
export const readWaiting = () => liveEntries(queueDir())
const entryFile = (dir, pid) => join(dir, `${pid}.json`)

// ── admission (pure) ─────────────────────────────────────────────────────────

/** Effective priority of a waiter: its place minus the minutes waited (the smaller, the earlier). */
export function effectivePriority(waiter, order, now, cfg = limits()) {
  const waited = Math.max(0, now - waiter.since) / 1000
  return placeOf(order, waiter.key) - (cfg.agingSeconds > 0 ? waited / cfg.agingSeconds : 0)
}

const gbText = (bytes) => `${(bytes / GB).toFixed(1)} GB`
const idle = (running) => running.filter((entry) => !entry.paused).length === 0

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
    if (!idle(virtual)) {
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
  const ranked = [...running].sort((a, b) => placeOf(order, a.key) - placeOf(order, b.key) || a.started - b.started || a.pid - b.pid)
  const rank = ranked.findIndex((entry) => entry.pid === pid)
  return rank >= Math.ceil(ranked.length / 2)
}

// ── the memory of a command ──────────────────────────────────────────────────

const peakKey = (repo, command) => `${repo}\n${command}`
export const recordedPeak = (repo, command, data = pluginDataDir()) => Number(readJson(peaksFile(data), {})[peakKey(repo, command)]) || 0
function recordPeak(repo, command, bytes, data = pluginDataDir()) {
  if (!bytes) return
  withFileLock(peaksFile(data), () => writeJson(peaksFile(data), { ...readJson(peaksFile(data), {}), [peakKey(repo, command)]: bytes }))
}
export function expectedBytes(repo, command, kind = 'check', cfg = limits()) {
  return recordedPeak(repo, command) || (kind === 'browser' ? cfg.browserBytes : cfg.defaultBytes)
}

/** `[{ pid, ppid, rss }]` of every process (rss in bytes); null when `ps` fails. */
function psRows() {
  try {
    return sh('ps', ['-A', '-o', 'pid=,ppid=,rss=']).split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]) * 1024 }] : []
    })
  } catch {
    return null
  }
}

/** Who each of `pids` is right now (`ps -p a,b,c`, one process for all): pid → start time and command line; a PID that is gone is missing; null when `ps` fails. */
function identitiesOf(pids) {
  if (!pids.length) return new Map()
  let out
  try {
    out = sh('ps', ['-ww', '-o', 'pid=,lstart=,args=', '-p', pids.join(',')])
  } catch (error) {
    out = error?.status === 1 && typeof error.stdout === 'string' ? error.stdout : null // `ps -p` exits 1 when some PIDs are gone, and still prints the others
    if (out === null) return null
  }
  return new Map(out.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    return match ? [[Number(match[1]), match[2].trim()]] : []
  }))
}

/** The tree of `pid` (itself and its descendants) with the summed RSS. */
function treeOf(pid, rows = psRows()) {
  if (!rows) return { pids: [pid], rss: 0 }
  const table = new Map(rows.map((row) => [row.pid, row]))
  const pids = [pid, ...descendants(table, pid, { depth: 12 }).map((row) => row.pid)].filter((item) => table.has(item))
  return { pids, rss: pids.reduce((sum, item) => sum + table.get(item).rss, 0) }
}

/**
 * The memory the running commands younger than `rampSeconds` have yet to take: max(0, expected − the tree's current RSS) per command, scaled by the window left.
 * Without it three commands started a second apart would all see the same `available` (AC-1.1).
 */
export function rampOf(running, now = Date.now(), cfg = limits(), rows = null) {
  const young = running.filter((entry) => now - entry.started < cfg.rampSeconds * 1000)
  if (!young.length) return 0
  const table = rows ?? psRows()
  // The held-back share falls linearly to 0 over the window: a command that never reaches its expected memory does not hold the shortfall for good.
  return young.reduce((sum, entry) => {
    const left = 1 - (now - entry.started) / (cfg.rampSeconds * 1000)
    return sum + Math.max(0, entry.expectedBytes - treeOf(entry.childPid ?? entry.pid, table).rss) * left
  }, 0)
}

// ── the background class ─────────────────────────────────────────────────────

const taskpolicyBin = () => process.env.STAGE_PIPELINE_TASKPOLICY ?? (process.platform === 'darwin' ? '/usr/sbin/taskpolicy' : null)
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
 * the entry and records the peak.
 */
export async function admit({ cwd, repo, command, kind = 'check', mode, say = console.log }) {
  const cfg = limits()
  const data = pluginDataDir()
  const { key } = taskInfo(cwd)
  ensureTask(key, data)
  const order = readPriorities(data).order
  const self = { pid: process.pid, identity: identityOf(process.pid), key, repo, command, kind, started: Date.now(), expectedBytes: expectedBytes(repo, command, kind, cfg), background: false, paused: false, childPid: null }
  const nice = niceFor(order, key)
  const useMemory = mode?.name === 'low'

  /** Waits until the command may go. `first`: the entry in `running/` is written BEFORE the waiting one is removed, so nobody sees an empty machine in between. */
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
        const now = Date.now()
        const state = readPriorities(data)
        const running = readRunning()
        const memory = useMemory ? readMemory() : null
        const ramp = memory ? rampOf(running.filter((entry) => entry.pid !== self.pid), now, cfg) : 0
        verdict = decide({ self: waiter, waiters: readWaiting(), running, memory, order: state.order, paused: state.paused, rampBytes: ramp, now, cfg })
        const waited = (now - waiter.since) / 1000
        if (verdict.admit) return go()
        if (verdict.reason !== waiter.reason) {
          waiter.reason = verdict.reason
          writeJson(entryFile(queueDir(), self.pid), waiter)
        }
        if ((process.platform === 'win32' || !state.paused.includes(key)) && waited >= cfg.waitCapSeconds) {
          say(`balance: waited ${Math.round(waited)} s, starting without admission (${verdict.reason})`)
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
  const save = () => writeJson(entryFile(runningDir(), self.pid), self)

  let peak = 0
  let timer = null
  let stopped = false
  let stoppedPids = []
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
          stoppedPids = stopTree(child.pid)
          stopped = true
          self.paused = true
          save()
        } else if (!paused && stopped) {
          // After the pause a `low` command goes through admission again (a `normal` one does not look at memory); its own entry stays in the registry (a stopped command's memory is still taken).
          await waitForAdmission(false)
          signalAll([...new Set([...stoppedPids, ...treeOf(child.pid).pids])], 'SIGCONT')
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
            loadState = nextBackground(loadState, { load, cores, now, lowerHalf, cfg })
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
    if (stopped && child?.pid) signalAll([...new Set([...stoppedPids, ...treeOf(child.pid).pids])], 'SIGCONT')
  }

  /** A signal to the command: the paused tree is continued first, then the signal goes to every process of the tree (grandchildren too), not only the `sh` wrapper. */
  function terminate(child, signal) {
    if (!child?.pid) return
    unstop(child)
    signalAll([...new Set([...stoppedPids, ...treeOf(child.pid).pids])], signal)
  }

  /** `record: false` — a run cut short by a signal has not reached its peak: the recorded one stays. */
  function finish({ record = true } = {}) {
    if (timer) clearInterval(timer)
    if (switched.size) {
      const ids = identitiesOf([...switched.keys()])
      taskpolicy('-B', [...switched].filter(([pid, identity]) => !ids || (ids.has(pid) && (!identity || ids.get(pid) === identity))).map(([pid]) => pid))
    }
    dropEntries(self.pid)
    if (record) recordPeak(repo, command, peak)
  }

  return { key, place: placeOf(order, key), nice, watch, unstop, terminate, finish }
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
    console.log(`heavy-queue: ${verb === 'pause' ? 'paused' : 'resumed'} ${keys[0]}`)
  } else if (verb === 'order' && keys.length) {
    setOrder(keys)
    console.log(`heavy-queue: order — ${keys.map((key, index) => `${index + 1}. ${key}`).join('  ')}`)
  } else {
    console.error('usage: node heavy-queue.mjs status [--json] | pause <key> | resume <key> | order <key>…')
    process.exit(2)
  }
}
