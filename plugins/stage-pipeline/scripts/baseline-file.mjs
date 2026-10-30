import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The journal snapshot's name and its "is current" test, kept apart from journal-check.mjs so that a hook can ask whether the snapshot exists
 * (journal-gate before an Edit of a task file) without loading the rule modules.
 */
export const BASELINE_VERSION = 2

/** The snapshot file name relative to a data directory (not a slice of the full path: `CLAUDE_PLUGIN_DATA` may end with a slash). */
export function baselineName(taskDir) {
  let real = taskDir
  try {
    real = realpathSync(taskDir)
  } catch {
    // the task directory is gone — snapshot by the original path
  }
  return join('journal-baseline', `${createHash('sha1').update(real).digest('hex').slice(0, 16)}.json`)
}

/** A snapshot of this version that has every field the rules read (an older one is migrated lazily by `baselineInfo`). */
export const snapshotCurrent = (data) =>
  data?.version === BASELINE_VERSION &&
  Array.isArray(data.reports) &&
  Boolean(data.closedSeen && data.liveSeen && data.dismissSeen) &&
  Array.isArray(data.ledgerOld) &&
  Array.isArray(data.runtimeOld) &&
  typeof data.since018 === 'string' &&
  Array.isArray(data.forceSeen) &&
  typeof data.since0182 === 'string' &&
  Array.isArray(data.blockerSeen)
