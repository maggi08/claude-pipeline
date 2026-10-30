import { isBrowserMain } from '../../../scripts/browser-cleanup.mjs'
import { alive, descendants, identityOf, processTable } from '../../../scripts/processes.mjs'

/**
 * The browser of the playwright fallback (devtools-verify, "Preconditions") is the script's own, and it must be gone when the script ends,
 * however the script ends: a step that throws midway, a `close()` that hangs, a SIGTERM from a Bash timeout.
 *
 *   import { createRequire } from 'node:module'
 *   import { withBrowser } from '<plugin root>/skills/devtools-verify/references/journey.mjs'
 *   const { chromium } = createRequire('<repo>/package.json')('playwright-core')
 *   await withBrowser(() => chromium.launch({ channel: 'chrome', headless: true }), async (browser) => {
 *     const page = await browser.newPage()
 *     …
 *   })
 *
 * At launch it prints `journey: browser pid <N>`: frames-guard reads that line from the agent's transcript and does not let the agent stop while
 * the PID still runs. At the end it prints `journey: browser closed (pid N)` or `journey: browser killed (pid N)`.
 * The PID comes from `browser.process()` (puppeteer) or, for a playwright `Browser`, which has none, from the browser main process that appeared below this script.
 * `close()` runs in a `finally`; when it throws or does not finish within `closeTimeoutMs`, that PID gets SIGKILL. On SIGTERM / SIGINT and at any exit
 * the PID is killed synchronously. Only this PID is ever signalled: never a browser by name, never one the script did not launch, and SIGKILL only while
 * the PID is still that browser — its start time and command line, read at launch, read again right before the signal (a browser that crashed early
 * leaves its number free for minutes of a journey; S-6 of VT-1 5b).
 */
export async function withBrowser(launch, journey, { closeTimeoutMs = 10_000, log = (line) => console.log(line) } = {}) {
  const before = browsersBelow(new Set())
  const browser = await launch()
  const pid = browser?.process?.()?.pid ?? (await launchedPid(before))
  const identity = pid ? identityOf(pid) : null
  const ours = () => Boolean(pid && identity && alive(pid) && identityOf(pid) === identity)
  const killNow = () => {
    if (ours()) signal(pid, 'SIGKILL')
  }
  const onSignal = (name) => {
    killNow()
    process.exit(name === 'SIGINT' ? 130 : 143)
  }
  process.on('exit', killNow)
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  // printed once the handlers are in place: whoever reads the line and stops the script finds them
  log(`journey: browser pid ${pid ?? 'unknown'}`)
  try {
    return await journey(browser)
  } finally {
    await closeBrowser(browser, pid, ours, closeTimeoutMs, log)
    process.off('exit', killNow)
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
  }
}

async function closeBrowser(browser, pid, ours, timeoutMs, log) {
  let timer
  try {
    await Promise.race([
      Promise.resolve().then(() => browser?.close?.()),
      new Promise((_, fail) => {
        timer = setTimeout(() => fail(new Error(`close() did not finish in ${timeoutMs} ms`)), timeoutMs)
      }),
    ])
    await gone(pid, 2000)
  } catch (error) {
    log(`journey: browser close failed — ${String(error?.message ?? error).split('\n')[0]}`)
  } finally {
    clearTimeout(timer)
  }
  if (ours()) {
    signal(pid, 'SIGKILL')
    await gone(pid, 2000)
    log(`journey: browser killed (pid ${pid})`)
    return
  }
  if (pid && alive(pid)) {
    log(`journey: pid ${pid} is not the browser launched here any more (or its start could not be read) — not signalled`)
    return
  }
  log(`journey: browser closed (pid ${pid ?? 'unknown'})`)
}

function signal(pid, name) {
  try {
    process.kill(pid, name)
  } catch {
    // already gone
  }
}

async function gone(pid, ms) {
  const deadline = Date.now() + ms
  while (pid && alive(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50))
}

/** Browser main processes below this script now (a playwright launch spawns it as a child, sometimes through a wrapper). */
function browsersBelow(exclude) {
  const table = processTable({ timeout: 2000 })
  if (!table) return new Set()
  return new Set(descendants(table, process.pid, { depth: 3 }).filter((entry) => isBrowserMain(entry.args) && !exclude.has(entry.pid)).map((entry) => entry.pid))
}

/** The browser main process that appeared after the launch; a process just spawned may still carry its parent's command line, so it is looked for up to 2 s. */
async function launchedPid(before) {
  const deadline = Date.now() + 2000
  for (;;) {
    const [pid] = browsersBelow(before)
    if (pid || Date.now() > deadline) return pid ?? null
    await new Promise((done) => setTimeout(done, 100))
  }
}
