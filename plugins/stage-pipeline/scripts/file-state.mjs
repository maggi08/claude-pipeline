import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { alive } from './processes.mjs'

/**
 * Two helpers for the small state files of the plugin (the balancer's registry and priorities, the session states, the force queue): an atomic JSON write and a short lock around
 * one read-modify-write. One copy for every module, so a fix to the lock or to the write reaches all of them.
 */

/** Writes `value` as JSON through a temp file and a rename. `compact`: one line instead of the indented form; `mode` / `dirMode`: the file and the directory it makes. */
export function writeJsonAtomic(file, value, { compact = false, mode = undefined, dirMode = undefined } = {}) {
  mkdirSync(dirname(file), { recursive: true, ...(dirMode === undefined ? {} : { mode: dirMode }) })
  const tmp = `${file}.${process.pid}.tmp`
  const text = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)
  writeFileSync(tmp, `${text}\n`, mode === undefined ? undefined : { mode })
  renameSync(tmp, file)
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

/**
 * A short lock around one read-modify-write of a state file (`<file>.lock` holds the pid of the owner; a dead owner's lock is taken over).
 * After `attempts` tries (30 ms apart) the lock is still not ours: `failOpen` (the default) runs `fn` without it, `failOpen: false` throws.
 */
export function withFileLock(file, fn, { failOpen = true, attempts = 100 } = {}) {
  const lock = `${file}.lock`
  mkdirSync(dirname(lock), { recursive: true })
  let held = false
  for (let attempt = 0; attempt < attempts && !held; attempt += 1) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
      held = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!takeOverStale(lock)) sleepSync(30)
    }
  }
  if (!held && !failOpen) throw new Error(`${file} is locked by another process — try again`)
  try {
    return fn()
  } finally {
    if (held) rmSync(lock, { force: true })
  }
}
