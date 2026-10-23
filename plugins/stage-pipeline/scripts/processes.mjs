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

/** Every process as pid → `{ pid, ppid, uid, age, args }` (`age` in seconds, `args` the full command line); null when `ps` is missing, refused or slower than `timeout`. */
export function processTable({ timeout = 3000 } = {}) {
  let out
  try {
    out = run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,uid=,etime=,args='], timeout)
  } catch {
    return null
  }
  const table = new Map()
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    table.set(pid, { pid, ppid: Number(match[2]), uid: Number(match[3]), age: elapsedSeconds(match[4]), args: match[5].trim() })
  }
  return table
}

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
