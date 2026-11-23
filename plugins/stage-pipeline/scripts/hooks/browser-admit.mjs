#!/usr/bin/env node
import { survey } from '../browser-cleanup.mjs'
import { BROWSER_COMMAND, BROWSER_REPO, admit, dropEntries, limits, readPriorities, readRunning, readSessionTasks, registerBrowser, resourceMode, taskInfo } from '../heavy-queue.mjs'
import { processStats } from '../processes.mjs'
import { isMain } from '../main-guard.mjs'
import { readHookInput } from './hook-input.mjs'

/**
 * Admission of a new DevTools browser by memory (VT-17 stage 6, D13, D15). PreToolUse on the DevTools MCP tools (the plugin's `chrome-devtools`, the opt-in `stage-pipeline-chrome`,
 * a project's own `chrome-devtools`): the first call of a session starts its browser, so that call waits here until the machine has the memory for it.
 *
 * - The session already has a browser under its MCP server (`survey`), or a browser of its own was admitted a moment ago: pass at once, no output (AC-6.2). The check runs on every DevTools call, not only the first.
 * - `normal` mode passes without looking at memory. In `low` mode the browser goes through the balancer's admission with kind `browser` and the expected memory of the recorded browser peak
 *   of this machine, 0.8 GB without a history: enough memory → pass at once however many browsers are open; not enough → wait, the higher effective priority first, a minute of waiting is
 *   a place up (AC-6.1). A task on pause holds the call until the resume, in either mode, even when the session already has a browser (that browser is stopped). The task is the one the session's last `run-check` recorded, else the one of the hook's folder.
 * - The wait is capped (the host hook timeout forbids an uncapped one) at `STAGE_PIPELINE_BROWSER_WAIT_S` (240 s by default, used when non-empty; under the hook's 300 s timeout): pass with `browser: waited <s> s for memory, starting anyway`, or `browser: waited <s> s for the resume, starting anyway` for a paused task (AC-6.3). The "already has a browser" check repeats on every poll.
 * - An admitted browser is recorded in the running registry as kind `browser` under its Claude session (heavy-queue.mjs `registerBrowser`), live while the session's tree holds a browser main process.
 *
 * Never blocks: any failure is an exit 0, and the hook prints nothing but the cap line.
 */
export const waitFromEnv = (raw = process.env.STAGE_PIPELINE_BROWSER_WAIT_S) => {
  const text = (raw ?? '').trim()
  return text !== '' && Number(text) >= 0 ? Number(text) : 240
}
const WAIT_SECONDS = waitFromEnv()

/** The hook's decision, apart from the input: returns the lines to print (none on the fast path). Exported for the tests. `table`: a fixed process table (tests); otherwise `ps` is read when needed. */
export async function admitBrowser({ cwd, table = null, say = () => {}, waitSeconds = WAIT_SECONDS } = {}) {
  const info = taskInfo(cwd)
  const mode = resourceMode(info.root)
  const win = process.platform === 'win32'
  // Nothing is paused and the machine is in `normal` mode: nothing to look at, no process read on this path.
  if (mode.name !== 'low' && (win || readPriorities().paused.length === 0)) return
  const read = () => table ?? processStats()
  const rows = read()
  const session = rows ? survey(rows).session : null
  if (!session) return // not a Claude session (or no table): no browser of a session to hold
  // The session's task is the one its last `run-check` recorded (its commands may run in a linked worktree of the task), else the one of this folder.
  const key = readSessionTasks(rows).get(session.pid)?.key ?? info.key
  const pausedNow = () => !win && readPriorities().paused.includes(key)
  /** `done`: the session already has a browser (or one admitted a moment ago): nothing to wait for. */
  const look = () => {
    const now = read()
    if (!now) return true
    const mine = survey(now)
    if (!mine.session) return true
    return mine.mine.length > 0 || readRunning().some((entry) => entry.pid === mine.session.pid && entry.kind === 'browser')
  }
  const paused = pausedNow()
  if (!paused && look()) return
  const slot = await admit({
    cwd, key, repo: BROWSER_REPO, command: BROWSER_COMMAND, kind: 'browser', mode, say: () => {},
    capSeconds: Math.min(waitSeconds, limits().waitCapSeconds), capPaused: true,
    // a task on pause holds the call even when the session has its browser (it is stopped: the call would go into a stopped Chrome); after the resume that browser passes without a memory wait
    passWhen: () => !pausedNow() && look(),
    capMessage: (waited, reason) => {
      say(`browser: waited ${Math.round(waited)} s ${String(reason).startsWith('paused') ? 'for the resume' : 'for memory'}, starting anyway`)
      return ''
    },
  })
  if (mode.name === 'low' && !slot.passed) registerBrowser({ pid: session.pid, key: slot.key })
  slot.finish({ record: false })
}

if (isMain(import.meta.url)) {
  const cleanup = () => {
    dropEntries()
    process.exit(0)
  }
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)
  try {
    const input = await readHookInput()
    await admitBrowser({ cwd: input.cwd ?? process.cwd(), say: (line) => console.log(line) })
  } catch {
    // fail open: an error of the registry or the data files lets the call through
    try {
      dropEntries()
    } catch {
      // nothing left to drop
    }
  }
  process.exit(0)
}
