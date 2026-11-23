#!/usr/bin/env node
import { survey } from '../browser-cleanup.mjs'
import { BROWSER_COMMAND, BROWSER_REPO, admit, dropEntries, limits, readPriorities, readRunning, registerBrowser, resourceMode, taskInfo } from '../heavy-queue.mjs'
import { processStats } from '../processes.mjs'
import { isMain } from '../main-guard.mjs'
import { readHookInput } from './hook-input.mjs'

/**
 * Admission of a new DevTools browser by memory (VT-17 stage 6, D13, D15). PreToolUse on the DevTools MCP tools (the plugin's `chrome-devtools`, the opt-in `stage-pipeline-chrome`,
 * a project's own `chrome-devtools`): the first call of a session starts its browser, so that call waits here until the machine has the memory for it.
 *
 * - The session already has a browser under its MCP server (`survey`), or a browser of its own was admitted a moment ago: pass at once, no output (AC-6.2).
 * - `normal` mode passes without looking at memory. In `low` mode the browser goes through the balancer's admission with kind `browser` and the expected memory of the recorded browser peak
 *   of this machine, 0.8 GB without a history: enough memory → pass at once however many browsers are open; not enough → wait, the higher effective priority first, a minute of waiting is
 *   a place up (AC-6.1). A task on pause holds its new browser until the resume, in either mode.
 * - The wait is capped (the host hook timeout forbids an uncapped one) at `STAGE_PIPELINE_BROWSER_WAIT_S` (240 s by default, used when non-empty; under the hook's 300 s timeout): pass with `browser: waited <s> s — for memory, starting anyway`, or `— task paused, starting anyway` for a paused task (AC-6.3). The "already has a browser" check repeats on every poll.
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
  const paused = process.platform !== 'win32' && readPriorities().paused.includes(info.key)
  if (mode.name !== 'low' && !paused) return // no process read on this path
  const read = () => table ?? processStats()
  /** The session's pid when it already has a browser (or one admitted a moment ago): nothing to wait for. `null` session — not a Claude session, no table. */
  const look = () => {
    const rows = read()
    if (!rows) return { session: null, done: true }
    const mine = survey(rows)
    if (!mine.session) return { session: null, done: true }
    return { session: mine.session, done: mine.mine.length > 0 || readRunning().some((entry) => entry.pid === mine.session.pid && entry.kind === 'browser') }
  }
  const first = look()
  if (first.done) return
  const slot = await admit({
    cwd, repo: BROWSER_REPO, command: BROWSER_COMMAND, kind: 'browser', mode, say: () => {},
    capSeconds: Math.min(waitSeconds, limits().waitCapSeconds), capPaused: true,
    passWhen: () => look().done,
    capMessage: (waited, reason) => {
      say(`browser: waited ${Math.round(waited)} s — ${String(reason).startsWith('paused') ? 'task paused, starting anyway' : 'for memory, starting anyway'}`)
      return ''
    },
  })
  if (mode.name === 'low' && !slot.passed) registerBrowser({ pid: first.session.pid, key: slot.key })
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
    // fail open
  }
  process.exit(0)
}
