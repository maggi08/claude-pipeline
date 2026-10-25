#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { alive, ancestors, commandOf, cwdOf, descendants, identityOf, processTable } from './processes.mjs'

/**
 * browser-cleanup — the Chrome windows the pipeline's DevTools MCP servers launched, by Claude Code session.
 *
 * Precedent (VT-1 stage 5b, measured 2026-10-20): every session starts its own `chrome-devtools-mcp --isolated` server, the server launches one Chrome
 * on first use and keeps it for the life of the session. Seven servers were running, and three Chromes were still open 18–23 h after their sessions went idle.
 *
 *   node browser-cleanup.mjs                          lists this session's MCP browsers (PID, the close command), those of other sessions (age, folder),
 *                                                     orphans and a stage-pipeline-chrome browser whose server is gone; kills none
 *   node browser-cleanup.mjs --session                closes this session's MCP browsers by PID; the next MCP call opens a fresh one
 *   node browser-cleanup.mjs --session --persistent   closes only the `stage-pipeline-chrome` browser (its profile keeps the login on disk)
 *   node browser-cleanup.mjs --orphans                closes temp-profile browsers whose MCP parent is gone (a browser executable of this user, its profile in the OS temp dir)
 *   --under <dir>                                     looks only at browsers whose profile lies under <dir> (the self-test's throwaway processes)
 *
 * The session is the nearest `claude` process above this one. Its MCP servers are the `chrome-devtools-mcp` processes whose nearest `claude` ancestor
 * it is: there can be more than one (the plugin's, a second one after a reconnect, the opt-in `stage-pipeline-chrome`). A browser is the Chrome main process
 * below a server (a child or a grandchild: `npm exec` → `chrome-devtools-mcp` → Chrome), the one with `--user-data-dir=` and no `--type=`; its helpers go with it.
 * `--session` closes the temp-profile browsers (`puppeteer_dev_chrome_profile`, the plugin's `--isolated` server) and the `stage-pipeline-chrome` one; a browser
 * on any other profile (a project's own `chrome-devtools` server on its shared default profile) is the user's and is only listed; a project server started with
 * `--isolated` also runs on a puppeteer temp profile and cannot be told from the plugin's, so `--session` closes this session's browser of it too.
 * Another session's browser is never closed: it may hold a running force run's login.
 *
 * Processes are killed by PID only: the command line is read again right before the signal (a PID can be reused), then SIGTERM, then SIGKILL
 * after a bounded wait, sent only while the PID's start time and command line are still the ones read before SIGTERM. Fail safe: no `ps`, no session above, a timeout — nothing is killed, one line says why, exit 0. No shell is involved.
 */
export const OFF_SWITCH = 'STAGE_PIPELINE_BROWSER_CLEANUP' // `off` — the journal-gate hook does not close the session's browser at a force close

const SCRIPT = fileURLToPath(import.meta.url)
/** The command that closes the caller's session browsers: what the run digest names when the force close left them open. */
export const CLOSE_COMMAND = `node ${SCRIPT} --session`
const flagOf = (args, name) => new RegExp(`(?:^|\\s)--${name}=`).test(String(args))

/** A Claude Code process: the native binary (`…/claude --output-format …`) or the npm CLI run by node (`node …/bin/claude`, `node …/@anthropic-ai/claude-code/cli.js`). */
export function isClaude(args) {
  const [first = '', second = ''] = String(args).trim().split(/\s+/)
  const name = (token) => token.split('/').pop()
  if (name(first) === 'claude') return true
  return /^(?:node|bun)$/.test(name(first)) && (name(second) === 'claude' || /@anthropic-ai\/claude-code\/cli\.m?js$/.test(second))
}

/** A Chrome process of any kind: the main one has `--user-data-dir=`, the helpers `--type=`. */
const isChromeProcess = (args) => flagOf(args, 'type') || flagOf(args, 'user-data-dir')

/** The browser main process: a profile directory and no `--type=` (renderer, GPU, utility helpers carry one). */
export function isBrowserMain(args) {
  return flagOf(args, 'user-data-dir') && !flagOf(args, 'type')
}

/** The executable at the head of a command line: everything before the first switch (a macOS app path holds spaces: `/Applications/Google Chrome.app/…/Google Chrome --…`). */
const executableOf = (args) => String(args).split(/\s-/)[0].trim()
// The Linux packages' launchers (`/usr/bin/google-chrome`, `microsoft-edge`) exec the binary under their own name, so `ps` shows that name.
const BROWSER_NAME = /^(?:google[ -]chrome(?:[ -](?:stable|beta|dev|unstable|canary|for testing))?|chrome|chromium(?:-browser)?|chrome-headless-shell|headless_shell|msedge|microsoft[ -]edge(?:[ -](?:stable|beta|dev|canary))?|firefox)(?:\.exe)?$/i

/**
 * A browser executable, by its path or name (`…/MacOS/Google Chrome`, `/usr/bin/google-chrome-stable`, `chromium-browser`): the one list of browser names, for a row of
 * the process table and for the program a command put in the background (frames-guard; m-1 of the 5b whole-branch review: its own list missed the Linux names).
 */
export function isBrowserName(executable) {
  return BROWSER_NAME.test(String(executable).split(/[\\/]/).pop())
}

/** The executable itself is a browser (`Google Chrome`, `Chromium`, `chrome-headless-shell`): a `--user-data-dir=` word in a shell's or a script's arguments does not make one (S-4 of VT-1 5b). */
function isBrowserExecutable(args) {
  return isBrowserName(executableOf(args))
}

/** The executable's name, for a message: never the rest of the command line (another process's arguments are not the agent's to read). */
export const executableName = (args) => executableOf(args).split(/[\\/]/).pop()

/** A browser launched by hand or by a script: a browser executable that is not a helper (`--type=`). */
export function isBrowserLike(args) {
  return !flagOf(args, 'type') && isBrowserExecutable(args)
}

/**
 * A DevTools MCP server process (`npm exec chrome-devtools-mcp@1.6.0 --isolated`, the `chrome-devtools-mcp` it runs) — not its telemetry watchdog, not a Chrome
 * on the MCP's default profile, and not a `claude` whose own arguments name the server (`--mcp-config '{… chrome-devtools-mcp …}'`): its other children are not the server's.
 */
export function isMcpServer(args) {
  return /chrome-devtools-mcp/.test(args) && !/telemetry[\\/]watchdog/.test(args) && !isChromeProcess(args) && !isClaude(args)
}

/**
 * The `--user-data-dir=` value: up to the next ` --` switch (a profile path may hold a space). A string scan, not a lazy regexp: the value is any process's text,
 * and `(.+?)(?=\s--|\s*$)` went quadratic on a whitespace run (110 000 spaces in one process held the force close past journal-gate's 5 s; S-3 of VT-1 5b).
 */
function userDataDir(args) {
  const text = String(args)
  const flag = /(?:^|\s)--user-data-dir=/.exec(text)
  if (!flag) return null
  const from = flag.index + flag[0].length
  const next = /\s--/g
  next.lastIndex = from
  const end = next.exec(text)?.index ?? text.length
  return text.slice(from, end).trimEnd() || null
}

/** `temp` — a puppeteer temp profile (the plugin's `--isolated` server), `persistent` — the opt-in `stage-pipeline-chrome` profile, `other` — any other profile. */
function profileKind(args) {
  const dir = userDataDir(args) ?? ''
  if (/[\\/]stage-pipeline[\\/]chrome[\\/]/.test(dir)) return 'persistent'
  if (/puppeteer_dev_chrome_profile/.test(dir)) return 'temp'
  return 'other'
}

const KIND = {
  temp: 'temp profile, chrome-devtools --isolated',
  persistent: 'stage-pipeline-chrome profile',
  other: "another profile — a project's own chrome-devtools server, not the pipeline's",
}

const REAPER = /^(?:\S*\/)?(?:launchd|init|systemd)(?:\s|$)/
/** The parent is gone: the process was handed to init / launchd / a subreaper, or its parent is not in the table. */
const parentGone = (table, entry) => entry.ppid <= 1 || !table.has(entry.ppid) || REAPER.test(table.get(entry.ppid).args)

const inside = (root, path) => {
  if (!root) return true
  if (!path) return false
  let real = path
  try {
    real = realpathSync(path)
  } catch {
    // a profile directory that is gone — compared as written
  }
  return real === root || real.startsWith(root + sep)
}

const realOr = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
const TEMP_ROOT = realOr(tmpdir())
/** A puppeteer temp profile where puppeteer makes one: `<os temp dir>/puppeteer_dev_chrome_profile-XXXXXX`. */
const isTempProfile = (dir) => Boolean(dir) && basename(dir).startsWith('puppeteer_dev_chrome_profile-') && inside(TEMP_ROOT, dir)
/** The caller's own process: an orphan of another user is never ours to name or close. */
const sameUser = (entry) => typeof process.getuid === 'function' && entry.uid === process.getuid()

/**
 * Who holds which MCP browser. `from` — the process whose session is "this one" (default: this process). `under` — only profiles under this directory.
 * `mine` — browsers of this session's MCP servers, `others` — of other sessions' (or of servers with no session above).
 * A browser below no MCP server whose parent is gone, of this user, with a browser executable (not a shell or a script that names a profile, S-4 of VT-1 5b):
 * `orphans` — on a puppeteer temp profile in the OS temp dir (`--orphans` closes them); `held` — on the `stage-pipeline-chrome` profile, the process that keeps
 * that profile busy after its server died (listed only: m-4 of VT-1 5b).
 */
export function survey(table, { from = process.pid, under = null } = {}) {
  const root = under ? realOr(under) : null
  const session = ancestors(table, from).find((entry) => isClaude(entry.args)) ?? null
  const servers = [...table.values()].filter((entry) => isMcpServer(entry.args) && !isMcpServer(table.get(entry.ppid)?.args ?? ''))
  const browsers = []
  const owned = new Set()
  for (const server of servers) {
    const owner = ancestors(table, server.pid).find((entry) => isClaude(entry.args)) ?? null
    for (const entry of descendants(table, server.pid, { depth: 4, stop: (child) => isChromeProcess(child.args) })) {
      if (!isBrowserMain(entry.args)) continue
      owned.add(entry.pid)
      browsers.push({ pid: entry.pid, args: entry.args, age: entry.age, kind: profileKind(entry.args), server: server.pid, session: owner })
    }
  }
  const scoped = (list) => list.filter((browser) => inside(root, userDataDir(browser.args)))
  const unowned = [...table.values()].filter((entry) => isBrowserMain(entry.args) && !owned.has(entry.pid) && parentGone(table, entry) && sameUser(entry) && isBrowserExecutable(entry.args))
  const lone = (entry, kind) => ({ pid: entry.pid, args: entry.args, age: entry.age, kind, server: null, session: null })
  const orphans = unowned.filter((entry) => isTempProfile(userDataDir(entry.args))).map((entry) => lone(entry, 'temp'))
  const held = unowned.filter((entry) => profileKind(entry.args) === 'persistent').map((entry) => lone(entry, 'persistent'))
  const ours = (browser) => session !== null && browser.session?.pid === session.pid
  return { session, mine: scoped(browsers.filter(ours)), others: scoped(browsers.filter((browser) => !ours(browser))), orphans: scoped(orphans), held: scoped(held) }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * SIGTERM to each target whose command line is still the same, a bounded wait, SIGKILL to what is left — only while the PID is still that process
 * (its start time and command line read again: S-6 of VT-1 5b). Each target gets an `outcome`.
 */
async function terminate(targets, { waitMs = 3000, psTimeout = 1500 } = {}) {
  const results = []
  for (const target of targets) {
    const now = commandOf(target.pid, { timeout: psTimeout })
    const identity = now === target.args ? identityOf(target.pid, { timeout: psTimeout }) : null
    if (now === null || (now === target.args && identity === null)) {
      results.push({ ...target, outcome: 'gone' })
      continue
    }
    if (now !== target.args) {
      results.push({ ...target, outcome: 'changed' }) // the PID now belongs to another process: not touched
      continue
    }
    try {
      process.kill(target.pid, 'SIGTERM')
      results.push({ ...target, identity, outcome: 'pending' })
    } catch (error) {
      results.push({ ...target, outcome: error.code === 'ESRCH' ? 'gone' : `failed: ${error.code ?? error.message}` })
    }
  }
  const deadline = Date.now() + waitMs
  while (results.some((result) => result.outcome === 'pending' && alive(result.pid)) && Date.now() < deadline) await sleep(50)
  for (const result of results.filter((item) => item.outcome === 'pending')) {
    // Gone, or the PID is another process now (the browser exited and its number was reused): either way the browser is closed and nothing is signalled.
    if (!alive(result.pid) || identityOf(result.pid, { timeout: psTimeout }) !== result.identity) {
      result.outcome = 'closed'
      continue
    }
    try {
      process.kill(result.pid, 'SIGKILL')
      result.outcome = 'killed'
    } catch (error) {
      result.outcome = error.code === 'ESRCH' ? 'closed' : `failed: ${error.code ?? error.message}`
    }
  }
  return results
}

const brief = ({ pid, kind }) => ({ pid, kind })
const done = (result) => result.outcome === 'closed' || result.outcome === 'killed'

/**
 * Closes this session's MCP browsers (`persistentOnly` — only the `stage-pipeline-chrome` one). Returns the line to print and the facts for the run digest:
 * `{ line, session, closed, failed, left, skipped }` (`skipped`: `ps` — no process table, `session` — no `claude` above; nothing was killed then).
 */
export async function closeSession({ from = process.pid, persistentOnly = false, under = null, waitMs = 3000, psTimeout = 3000 } = {}) {
  const table = processTable({ timeout: psTimeout })
  if (!table) return { line: 'browser-cleanup: skipped — `ps` is unavailable, nothing closed', session: null, closed: [], failed: [], left: [], skipped: 'ps' }
  const found = survey(table, { from, under })
  if (!found.session) return { line: 'browser-cleanup: skipped — no claude process above this one, so no session to close; nothing closed', session: null, closed: [], failed: [], left: [], skipped: 'session' }
  const wanted = (browser) => (persistentOnly ? browser.kind === 'persistent' : browser.kind !== 'other')
  const results = await terminate(found.mine.filter(wanted), { waitMs, psTimeout: Math.min(psTimeout, 1500) })
  const closed = results.filter(done).map(brief)
  const failed = results.filter((result) => result.outcome.startsWith('failed')).map((result) => ({ pid: result.pid, kind: result.kind, error: result.outcome.replace(/^failed: /, '') }))
  const left = found.mine.filter((browser) => !wanted(browser)).map(brief)
  const session = found.session.pid
  const which = persistentOnly ? 'stage-pipeline-chrome browser' : 'browser'
  const listed = (items) => items.map(({ pid, kind }) => `${pid} (${KIND[kind]})`).join(', ')
  let line = closed.length
    ? `browser-cleanup: closed ${closed.length} ${which}(s) of this session (claude ${session}) by PID: ${listed(closed)} — the next MCP call opens a fresh one`
    : `browser-cleanup: no ${which} of this session is open (claude ${session})`
  if (failed.length) line += `; not closed: ${failed.map(({ pid, error }) => `${pid} (${error})`).join(', ')}`
  if (left.length) line += `; left open: ${listed(left)}`
  return { line, session, closed, failed, left, skipped: null }
}

/** Closes temp-profile browsers whose MCP parent is gone. */
async function closeOrphans({ under = null, waitMs = 3000, psTimeout = 3000 } = {}) {
  const table = processTable({ timeout: psTimeout })
  if (!table) return { line: 'browser-cleanup: skipped — `ps` is unavailable, nothing closed', closed: [], failed: [], skipped: 'ps' }
  const results = await terminate(survey(table, { under }).orphans, { waitMs, psTimeout: Math.min(psTimeout, 1500) })
  const closed = results.filter(done).map(brief)
  const failed = results.filter((result) => result.outcome.startsWith('failed')).map((result) => ({ pid: result.pid, error: result.outcome.replace(/^failed: /, '') }))
  let line = closed.length ? `browser-cleanup: closed ${closed.length} orphaned temp-profile browser(s) by PID: ${closed.map(({ pid }) => pid).join(', ')}` : 'browser-cleanup: no orphaned temp-profile browser'
  if (failed.length) line += `; not closed: ${failed.map(({ pid, error }) => `${pid} (${error})`).join(', ')}`
  return { line, closed, failed, skipped: null }
}

/** `23 h 40 min`, `5 min`, `2 d 3 h`. */
function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return 'age unknown'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ${minutes % 60} min`
  return `${Math.floor(hours / 24)} d ${hours % 24} h`
}

/** The read-only listing: this session's browsers with the close command, the other sessions' with age and folder, the orphans and the browsers holding the persistent profile. */
function listing({ from = process.pid, under = null, psTimeout = 3000 } = {}) {
  const table = processTable({ timeout: psTimeout })
  if (!table) return 'browser-cleanup: `ps` is unavailable, nothing listed'
  const found = survey(table, { from, under })
  const folders = new Map()
  const folder = (pid) => {
    if (!folders.has(pid)) folders.set(pid, cwdOf(pid) ?? 'folder not readable')
    return folders.get(pid)
  }
  const out = []
  if (found.session) {
    out.push(`browser-cleanup: this session — claude ${found.session.pid} in ${folder(found.session.pid)}: ${found.mine.length} MCP browser(s)`)
    for (const browser of found.mine) {
      const close = browser.kind === 'other' ? 'not the pipeline\'s, left to its owner' : browser.kind === 'persistent' ? `close: node ${SCRIPT} --session --persistent` : `close: node ${SCRIPT} --session`
      out.push(`- pid ${browser.pid} — ${KIND[browser.kind]}, MCP pid ${browser.server}, age ${formatAge(browser.age)} — ${close}`)
    }
  } else {
    out.push('browser-cleanup: no claude process above this one — every MCP browser below is another session\'s')
  }
  out.push(`browser-cleanup: other sessions — ${found.others.length} MCP browser(s), none closed (one may hold a running force run's login)`)
  for (const browser of found.others) {
    const where = browser.session ? `session claude ${browser.session.pid} in ${folder(browser.session.pid)}` : 'no claude session above its MCP server'
    out.push(`- pid ${browser.pid} — ${KIND[browser.kind]}, MCP pid ${browser.server}, age ${formatAge(browser.age)} — ${where}`)
  }
  out.push(`browser-cleanup: orphaned temp-profile browsers (MCP parent gone) — ${found.orphans.length}${found.orphans.length ? ` (close: node ${SCRIPT} --orphans)` : ''}`)
  for (const browser of found.orphans) out.push(`- pid ${browser.pid} — age ${formatAge(browser.age)}, profile ${userDataDir(browser.args)}`)
  // m-4 of VT-1 5b: the browser that keeps the `stage-pipeline-chrome` profile busy after its MCP server died. Never closed here: the line names it for whoever decides.
  out.push(`browser-cleanup: stage-pipeline-chrome browsers with no MCP server above (they hold the persistent profile) — ${found.held.length}`)
  for (const browser of found.held) out.push(`- pid ${browser.pid} — age ${formatAge(browser.age)}, profile ${userDataDir(browser.args)} — if no session of this repo uses it: kill ${browser.pid}`)
  return out.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--under')
  const under = at === -1 ? null : args[at + 1]
  const rest = at === -1 ? args : args.filter((_, index) => index !== at && index !== at + 1)
  const unknown = rest.filter((arg) => !['--session', '--orphans', '--persistent'].includes(arg))
  if (unknown.length || (at !== -1 && (!under || under.startsWith('--'))) || (rest.includes('--session') && rest.includes('--orphans')) || (rest.includes('--persistent') && !rest.includes('--session'))) {
    console.error('Usage: node browser-cleanup.mjs [--session [--persistent] | --orphans] [--under <dir>]')
    process.exit(2)
  }
  if (rest.includes('--session')) {
    const result = await closeSession({ persistentOnly: rest.includes('--persistent'), under })
    console.log(result.line)
    process.exit(result.failed.length ? 1 : 0)
  }
  if (rest.includes('--orphans')) {
    const result = await closeOrphans({ under })
    console.log(result.line)
    process.exit(result.failed.length ? 1 : 0)
  }
  console.log(listing({ under }))
}
