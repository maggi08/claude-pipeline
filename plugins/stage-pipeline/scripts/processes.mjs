import { execFileSync } from 'node:child_process'
import { readlinkSync } from 'node:fs'

/**
 * Read-only process helpers, shared by verify-doctor (who listens on the dev port, with what cwd) and browser-cleanup / frames-guard
 * (which browsers a session's MCP server or an agent launched). Every external call has a time limit and gives an empty answer on failure:
 * a hook that calls them must not hang or crash on a machine without `ps` or `lsof`. Nothing here sends a signal except `alive` (signal 0).
 * The `ps` row parse is anchored and linear: a command line is any process's text, of any length.
 */
const run = (command, args, timeout) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout, maxBuffer: 64 * 1024 * 1024 })

/** `[[dd-]hh:]mm:ss` of `ps -o etime` in seconds; null when the field does not parse. */
function elapsedSeconds(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text).trim())
  if (!match) return null
  const [, days = 0, hours = 0, minutes, seconds] = match
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)
}

/** `ps -o time=` (cumulative CPU time) in seconds: `[dd-][hh:]mm:ss` on Linux, `[h]:mm.ss` / `mm:ss.ss` on macOS; null when the field does not parse. */
export function cpuSecondsOf(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/.exec(String(text).trim())
  if (!match) return null
  const [, days = 0, hours = 0, minutes, seconds] = match
  return Math.round((((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds.replace(',', '.'))) * 100) / 100
}

// One parser for every `ps` shape: a column is a regex group and a reader; the row regex is anchored and linear. `args` is always the last column.
const num = (text) => Number(text.replace(',', '.'))
const optional = (text) => (text === '-' ? null : Number(text))
const COLUMNS = {
  pid: ['(\\d+)', 'pid=', 'pid', Number],
  ppid: ['(\\d+)', 'ppid=', 'ppid', Number],
  uid: ['(\\d+)', 'uid=', 'uid', Number],
  cpu: ['(\\d+(?:[.,]\\d+)?)', '%cpu=', 'cpu', num],
  rss: ['(\\d+)', 'rss=', 'rssKb', Number],
  nice: ['(-?\\d+|-)', 'nice=', 'nice', optional],
  pri: ['(-?\\d+|-)', 'pri=', 'pri', optional],
  stat: ['(\\S+)', 'stat=', 'stat', String],
  etime: ['(\\S+)', 'etime=', 'age', elapsedSeconds],
  time: ['(\\S+)', 'time=', 'cpuSeconds', cpuSecondsOf],
  args: ['(.*)', 'args=', 'args', (text) => text.trim()],
}
const BASE = ['pid', 'ppid', 'uid', 'etime', 'args']
const STATS = ['pid', 'ppid', 'uid', 'cpu', 'rss', 'nice', 'pri', 'stat', 'etime', 'time', 'args']

function psRun(names, timeout) {
  try {
    return run('ps', ['-A', '-ww', '-o', names.map((name) => COLUMNS[name][1]).join(',')], timeout)
  } catch {
    return null
  }
}

/** The rows of any `ps` output with the columns `names` (keys of the column table above), as pid → row; a row that does not fit is skipped. */
function parsePsRows(out, names) {
  const row = new RegExp(`^\\s*${names.map((name) => COLUMNS[name][0]).join('\\s+')}$`)
  const table = new Map()
  for (const line of String(out).split('\n')) {
    const match = row.exec(line)
    if (!match) continue
    const entry = {}
    names.forEach((name, index) => {
      entry[COLUMNS[name][2]] = COLUMNS[name][3](match[index + 1])
    })
    table.set(entry.pid, entry)
  }
  return table
}

/** Every process as pid → `{ pid, ppid, uid, age, args }` (`age` in seconds, `args` the full command line); null when `ps` is missing, refused or slower than `timeout`. */
export function processTable({ timeout = 3000 } = {}) {
  const out = psRun(BASE, timeout)
  return out === null ? null : parsePsRows(out, BASE)
}

/**
 * One row of `ps` per process as pid → `{ pid, ppid, uid, cpu, rssKb, nice, pri, stat, age, cpuSeconds, args }`. `cpu` is the %CPU `ps` reports: on macOS a decaying recent value, on Linux (procps)
 * the average over the process's life — neither is "now", so a live load is the delta of `cpuSeconds` (`ps` `time=`, cumulative CPU time) between two samples of the same pid (same or growing `age`).
 * `rssKb` is the resident set, `pri` the scheduler priority (on macOS 4 is the background band). Read-only, one call for the whole table; null when `ps` is missing, refused or slower than `timeout`.
 */
export function processStats({ timeout = 3000 } = {}) {
  const out = psRun(STATS, timeout)
  return out === null ? null : parseStatRows(out)
}

/** The rows of `ps -o pid=,ppid=,uid=,%cpu=,rss=,nice=,pri=,stat=,etime=,time=,args=` — anchored, linear. A row that does not fit is skipped. */
export const parseStatRows = (out) => parsePsRows(out, STATS)

/** The command line of one process right now (`ps -p`); null when it is gone or `ps` fails. Read again right before a kill: a PID can be reused. */
export function commandOf(pid, { timeout = 1500 } = {}) {
  try {
    return run('ps', ['-ww', '-o', 'args=', '-p', String(pid)], timeout).trim() || null
  } catch {
    return null
  }
}

/**
 * Who a PID is right now: its start time and command line as one string (`ps -o lstart=,args=`); null when it is gone or `ps` fails.
 * Read before the first signal and again before SIGKILL: two reads that differ mean the PID now belongs to another process.
 */
export function identityOf(pid, { timeout = 1500 } = {}) {
  try {
    return run('ps', ['-ww', '-o', 'lstart=,args=', '-p', String(pid)], timeout).trim() || null
  } catch {
    return null
  }
}

/**
 * Who each of `pids` is right now (`ps -p a,b,c`, one process for all): pid → start time and command line, the same string `identityOf` gives; a PID that is gone is missing;
 * null when `ps` fails. `ps -p` exits 1 when some PIDs are gone and still prints the others.
 */
export function identitiesOf(pids, { timeout = 1500 } = {}) {
  if (!pids.length) return new Map()
  let out
  try {
    out = run('ps', ['-ww', '-o', 'pid=,lstart=,args=', '-p', pids.join(',')], timeout)
  } catch (error) {
    out = error?.status === 1 && typeof error.stdout === 'string' ? error.stdout : null
    if (out === null) return null
  }
  return new Map(String(out).split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    return match ? [[Number(match[1]), match[2].trim()]] : []
  }))
}

/** The parents of `pid` from the nearest up, without pid 0 and 1; a loop in a stale table ends the walk. */
export function ancestors(table, pid) {
  const chain = []
  const seen = new Set([pid])
  let entry = table.get(table.get(pid)?.ppid)
  while (entry && entry.pid > 1 && !seen.has(entry.pid)) {
    chain.push(entry)
    seen.add(entry.pid)
    entry = table.get(entry.ppid)
  }
  return chain
}

/** The descendants of `pid`, breadth first, at most `depth` levels down; `stop(entry)` keeps the walk from going below an entry (a browser's helpers). */
export function descendants(table, pid, { depth = 4, stop = () => false } = {}) {
  const children = new Map()
  for (const entry of table.values()) {
    if (!children.has(entry.ppid)) children.set(entry.ppid, [])
    children.get(entry.ppid).push(entry)
  }
  const found = []
  let level = [pid]
  for (let step = 0; step < depth && level.length; step++) {
    const next = []
    for (const parent of level) {
      for (const child of children.get(parent) ?? []) {
        found.push(child)
        if (!stop(child)) next.push(child.pid)
      }
    }
    level = next
  }
  return found
}

/** The process exists (a process of another user counts: EPERM). Signal 0 checks, it delivers nothing. */
export function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** The working directory of a process: `/proc/<pid>/cwd` on Linux, `lsof` elsewhere; undefined when it cannot be read (another user's process, no lsof). */
export function cwdOf(pid, { timeout = 3000 } = {}) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    // not Linux, or not readable — lsof below
  }
  try {
    return run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], timeout).split('\n').find((line) => line.startsWith('n'))?.slice(1)
  } catch {
    return undefined
  }
}

/** Every pid listening on the TCP port, with its cwd (through lsof); empty where lsof is not there. */
export function listeners(port, { timeout = 3000 } = {}) {
  try {
    const out = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], timeout)
    const pids = [...new Set(out.split('\n').filter((line) => line.startsWith('p')).map((line) => line.slice(1)))]
    return pids.map((pid) => {
      const cwd = cwdOf(pid, { timeout })
      return cwd === undefined ? { pid } : { pid, cwd }
    })
  } catch {
    return []
  }
}
