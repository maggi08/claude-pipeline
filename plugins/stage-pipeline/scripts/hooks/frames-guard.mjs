import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { ruleAppliesToBlock } from '../markers.mjs'
import { openForceBlock, pluginDataDir, readHookInput, readPipelineState } from './pipeline-state.mjs'

/**
 * The runtime checker does not finish until it has looked at every frame it took.
 *
 * Precedent: the final run took 12 frames, the agent opened 2, the orchestrator none, and the user was told
 * "12 frames". A clipped badge — the only real defect of the task — was on an unviewed frame.
 * At stage 2 of the same task the agent opened 5 frames out of 13. In another task a country name in three
 * lines stuck out of the card on the checker's own screenshots — nobody opened those either.
 *
 * SubagentStop of the devtools-verify agent: frames are `take_screenshot` calls with `filePath` in its
 * transcript and images in `checks/` of the current branch's task written while it worked (fallback
 * puppeteer/playwright scripts write them themselves). Viewed means opened with Read. Unviewed frames are
 * a reason to continue. Claude Code itself breaks the Stop-hook loop (no more than 8 continuations in a row).
 *
 * Stage 4 of VT-1 — the same agent must not drive a page before it knows which app answers: no `verify-doctor.mjs` call before the first
 * `new_page` / `navigate_page` is a reason to continue, and so is a navigation after a doctor result other than `ok` / `no dev url` (`wrong app`, `down`,
 * `no config`, `error`, or no `doctor:` line at all — a doctor that gave no verdict cleared nothing). core, new-cor and mycar-webview all serve on :3000,
 * and a server of another worktree answers 200 too. A run with no navigation (a static target through the playwright fallback, a skip) is not judged;
 * a `doctor: no dev url` result clears the navigation before it and after it (a static target has no dev URL to drive blind); "navigate, doctor, navigate again"
 * passes — that is the redo the message asks for. A transcript record of an unexpected shape is skipped, it does not stop the checks.
 *
 * Stage 5b of VT-1 — the agent leaves nothing running of what it opened. Each session's MCP server keeps one Chrome for the life of the session, and three of them
 * were still open 18–23 h after their sessions went idle, the app polling in their tabs. A stop is a reason to continue while:
 * - a page this agent opened with `new_page` (the `[selected]` id of the `## Pages` list in its answer; for a `new_page` that answered with an error, a new id at its
 *   URL in a later list — the fresh `[selected]` one, else the newest: ids only grow and `new_page` selects its tab, so an older page at the same URL is the
 *   orchestrator's) is still in the freshest `## Pages` list its MCP calls returned — unless it is the only page left and shows `about:blank`
 *   (MCP 1.6.0 refuses to close the last page: "The last open page cannot be closed");
 * - a browser it launched still runs (S-1 of VT-1 5b: a PID counts only from the agent's own Bash call): the `journey: browser pid N` line of references/journey.mjs
 *   in a Bash result, or the single number a Bash call printed for `<a browser or a node/npx script> … & echo $!` when that echo's output is printed (f-2);
 *   alive now, a browser executable (itself or below it), and started after the agent's first transcript record. A transcript with no timestamps attributes no PID.
 *   Never a number from an MCP answer, a page's console text or a `pgrep` listing.
 * The page list is read only from the answers of the page tools (`new_page`, `list_pages`, `select_page`, `close_page`, `navigate_page`, `handle_dialog`) and only
 * from their own `## Pages` section — a console message the page logged is the page's text, not the MCP's (S-2), and an answer with an open dialog gives no list
 * (f-1) — with a linear parse.
 * Pages the orchestrator or another checker opened, and the session's MCP browser itself, are not the agent's. A force run already open when this plugin
 * version first saw the task keeps the rules it started with (`ruleAppliesToBlock`, D7 of VT-1).
 */
const IMAGE = /\.(png|jpe?g|webp)$/i
const input = await readHookInput()
if (!/devtools-verify$/.test(String(input.agent_type ?? ''))) process.exit(0)
const transcript = input.agent_transcript_path
if (typeof transcript !== 'string' || !transcript || !existsSync(transcript)) process.exit(0)

const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd()
let started = Infinity
let ended = -Infinity
const viewed = new Set()
const shot = new Set()
const NAVIGATE = /(?:^|__)(?:new_page|navigate_page)$/
const doctorCalls = new Set()
const RUNS_DOCTOR = /(?:^|[\s;&|(])node\s+(?:--\S+\s+)*\S*verify-doctor\.mjs\b/
const VERDICT = /doctor:\s*(ok|no dev url|wrong app|down|no config|error)\b/i
const CLEARS = new Set(['ok', 'no dev url'])
let doctored = false
let verdict = null // the last doctor result: `ok`, `no dev url`, `wrong app`, `down`, `no config`, `error`; 'none' — a call with no verdict (yet)
let navigation = null // null — fine; 'blind' — navigated before any verify-doctor call; otherwise the verdict the navigation came after
const NEW_PAGE = /(?:^|__)new_page$/
const PAGE_TOOL = /^mcp__.*__(?:new_page|list_pages|select_page|close_page|navigate_page|handle_dialog)$/
// `<a browser or a script runner> … & echo $!`: the background start the skills prescribe for a process the agent stops itself
const LAUNCHER = /(?:^|[\s"'\/])(?:google chrome|chrome|chromium|chrome-headless-shell|headless_shell|msedge|firefox|node|npx|bun|deno|tsx)(?=[\s"']|$)/i
// The `echo $!` right after a background `&`, as a command of its own: only a separator or the end follows it, so its number is printed, not redirected or piped
// (f-2: in `… & echo $! > /tmp/s.pid; pgrep -n -f "Google Chrome"` the one printed number is pgrep's).
const ECHO_PID = /(?<![&>])&\s*echo[ \t]+(["']?)\$!\1(?=[ \t]*(?:[;\n]|&&|\|\||$))/g
const calls = new Map() // tool_use id → { name, input }
let pageList = null // the freshest `## Pages` list an MCP call returned: id → { url, selected }
const seenPages = new Set() // every page id any list showed
const opened = new Set() // page ids this agent opened with new_page
const unlisted = [] // URLs of new_page calls that answered without a list (the tab was made, then the load failed)
const launched = new Set() // PIDs of browsers (or of the scripts that launched them) the agent started
for (const line of readFileSync(transcript, 'utf8').split('\n')) {
  if (!line.trim()) continue
  try {
    readRecord(JSON.parse(line))
  } catch {
    // not JSON or an unexpected shape — the next record
  }
}

function readRecord(record) {
  const time = Date.parse(record?.timestamp ?? '')
  if (Number.isFinite(time)) {
    started = Math.min(started, time)
    ended = Math.max(ended, time)
  }
  const content = record?.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'tool_result') {
      const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n') : ''
      if (doctorCalls.has(block.tool_use_id)) verdict = text.match(VERDICT)?.[1].toLowerCase() ?? 'none'
      const call = calls.get(block.tool_use_id)
      if (call && PAGE_TOOL.test(call.name)) readPages(call, block, text)
      if (call?.name === 'Bash') readLaunches(call, text)
      continue
    }
    if (block.type !== 'tool_use') continue
    const name = String(block.name ?? '')
    if (block.id) calls.set(block.id, { name, input: block.input ?? {} })
    if (name === 'Bash' && RUNS_DOCTOR.test(String(block.input?.command ?? ''))) {
      doctored = true
      verdict = 'none'
      if (block.id) doctorCalls.add(block.id)
    } else if (NAVIGATE.test(name)) navigation = !doctored ? 'blind' : CLEARS.has(verdict) ? null : verdict
    const file = block.input?.file_path ?? block.input?.filePath
    if (typeof file !== 'string' || !file) continue
    const path = real(isAbsolute(file) ? file : resolve(cwd, file))
    if (name === 'Read') viewed.add(path)
    else if (/take_screenshot$/.test(name) && IMAGE.test(path)) shot.add(path)
  }
}

/**
 * The `## Pages` section of a page tool's answer: `2: Orders (http://localhost:3000/orders) [selected]`, `1: about:blank`. The MCP writes it before the console,
 * network and snapshot sections, so the first one at a line start is its own; it ends at the next `## ` line. Each line is cut by string ops, no backtracking.
 * Only the `# Open dialog` block comes before it, and that block carries the dialog's message: the page's own text, newlines included (f-1, an
 * `alert("…\n## Pages\n1: about:blank")`). An answer with an open dialog gives no list: its `new_page` goes to `unlisted`, and the next clean list decides
 * (`handle_dialog` returns one).
 */
function readPageList(text) {
  const head = /^## Pages[ \t]*$/m.exec(text)
  if (!head || /^# Open dialog\b/m.test(text.slice(0, head.index))) return null
  const pages = new Map()
  for (const raw of text.slice(head.index + head[0].length).split('\n').slice(1)) {
    if (raw.startsWith('## ')) break
    const line = raw.trimEnd()
    const colon = line.indexOf(': ')
    if (colon < 1 || !/^\d+$/.test(line.slice(0, colon))) break
    let label = line.slice(colon + 2)
    const isolated = label.lastIndexOf(' isolatedContext=')
    if (isolated !== -1 && !/\s/.test(label.slice(isolated + 1))) label = label.slice(0, isolated)
    const selected = label.endsWith(' [selected]')
    if (selected) label = label.slice(0, -' [selected]'.length)
    pages.set(Number(line.slice(0, colon)), { url: pageUrl(label), selected })
  }
  return pages
}

// A titled page is `<title> (<url>)`, an untitled one is the URL itself.
function pageUrl(label) {
  return normalUrl(/\(([a-z][a-z0-9+.-]*:[^\s()]*)\)$/i.exec(label)?.[1] ?? label)
}

function normalUrl(url) {
  try {
    return new URL(String(url)).href
  } catch {
    return String(url ?? '')
  }
}

function readPages(call, block, text) {
  const pages = readPageList(text)
  if (!pages) {
    if (NEW_PAGE.test(call.name)) unlisted.push(normalUrl(call.input.url))
    return
  }
  const fresh = [...pages.keys()].filter((id) => !seenPages.has(id))
  for (const id of pages.keys()) seenPages.add(id)
  const selected = [...pages].find(([, page]) => page.selected)?.[0]
  if (NEW_PAGE.test(call.name) && !block.is_error && selected !== undefined) opened.add(selected)
  // An errored new_page's tab: the fresh selected id first (new_page selects its tab), then the newest — an older unseen page at that URL is someone else's (m-1).
  const candidates = fresh.sort((a, b) => b - a)
  if (fresh.includes(selected)) candidates.unshift(...candidates.splice(candidates.indexOf(selected), 1))
  for (const id of candidates) {
    const at = unlisted.indexOf(pages.get(id).url)
    if (at === -1 || opened.has(id)) continue
    opened.add(id)
    unlisted.splice(at, 1)
  }
  pageList = pages
}

/**
 * PIDs the agent launched, from its own Bash results only (S-1): the `journey: browser pid N` line of journey.mjs, and the one number a `… & echo $!` call printed
 * when what it put in the background is a browser or a script runner. An output with more than that number (a `pgrep` after it) attributes nothing.
 * The number counts only as that echo's own output (f-2): an echo whose output reaches the result — not redirected, not piped (`ECHO_PID`), and not inside
 * a group, a subshell or a substitution, whose output can go elsewhere as a whole (`(… & echo $!) > /tmp/s.pid`). Such an echo always prints, so a single
 * number in the result is its number.
 */
function readLaunches(call, text) {
  for (const match of text.matchAll(/^journey: browser pid (\d+)\b/gm)) launched.add(Number(match[1]))
  const single = /^\s*(\d+)\s*$/.exec(text)
  if (!single) return
  const command = String(call.input.command ?? '')
  const echo = [...command.matchAll(ECHO_PID)].find((match) => topLevel(command.slice(0, match.index)))
  if (!echo) return
  const before = command.slice(0, echo.index)
  const start = Math.max(0, ...[';', '&&', '||', '|', '\n', '('].map((separator) => (before.includes(separator) ? before.lastIndexOf(separator) + separator.length : 0)))
  if (LAUNCHER.test(before.slice(start))) launched.add(Number(single[1]))
}

// No `(`, `$(`, `{` or backtick left open in the text before a point of the command.
function topLevel(text) {
  const count = (char) => text.split(char).length - 1
  return count('(') <= count(')') && count('{') <= count('}') && count('`') % 2 === 0
}

const frames = new Set([...shot].filter((path) => existsSync(path)))
const task = readPipelineState(cwd)?.tasks.find((candidate) => candidate.current)
// The window is the agent's working time: frames of a neighbouring run or of the user are not its own.
const during = (path) => statSync(path).mtimeMs >= started && statSync(path).mtimeMs <= ended + 60_000
if (task && Number.isFinite(started)) for (const path of images(join(task.dir, 'checks'))) if (during(path)) frames.add(real(path))

// "no dev url" (a static file, a non-web target): the doctor has nothing to probe, the navigation before it (to the file) is not a blind drive of a dev URL
if (verdict === 'no dev url' && navigation === 'blind') navigation = null
const missed = [...frames].filter((path) => !viewed.has(path)).sort()
const AFTER = {
  blind:
    'stage-pipeline: you opened a page before running verify-doctor. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/verify-doctor.mjs` now, put its `doctor:` line into the report, and open the pages again after it: ' +
    'the frames you took may be of another worktree\'s server on the same port (core, new-cor and mycar-webview all serve on :3000). ' +
    'If the doctor answers `no dev url` (a static file, a non-web target), the navigation was fine — name the reason in the report and go on.',
  refused:
    'stage-pipeline: verify-doctor said `wrong app` / `down` and you opened a page afterwards. Do not drive that instance: drop its frames, report the `doctor:` line as the single finding ' +
    '(the orchestrator starts this worktree\'s server on a free port), and finish. If the situation changed, run verify-doctor again and navigate only after an `ok`.',
  'no config':
    'stage-pipeline: verify-doctor found no pipeline config (`.claude/pipeline.config.md` here or in the main tree), so it did not check which app answers, and you opened a page afterwards. ' +
    'Run it again with `--url <the dev url you open>` (and `--cwd <the repo>`), put its `doctor:` line into the report and open the pages again after an `ok`; if you cannot, report the frames as unchecked.',
  none:
    'stage-pipeline: verify-doctor gave no verdict (it failed, or its output has no `doctor:` line) and you opened a page afterwards — which app answered is unknown. ' +
    'Run it again and navigate only after an `ok` (or `no dev url` for a static file); if it keeps failing, report its output as the single finding and finish.',
}
if (navigation) {
  const reason = navigation === 'blind' ? AFTER.blind : navigation === 'wrong app' || navigation === 'down' ? AFTER.refused : navigation === 'no config' ? AFTER['no config'] : AFTER.none
  process.stdout.write(JSON.stringify({ decision: 'block', reason }))
  process.exit(0)
}
const left = await leftovers()
if (!missed.length && !left.length) process.exit(0)

const reasons = []
if (missed.length) {
  const shown = missed.slice(0, 15).map((path) => `- ${path}`)
  reasons.push(
    `stage-pipeline: you took ${frames.size} frame(s) but did not open all of them — ${missed.length} not viewed:\n${shown.join('\n')}${missed.length > 15 ? `\n- … ${missed.length - 15} more` : ''}\n` +
      'Open each one with Read and look at it: clipping, overlaps, extra borders, text past the edge, empty spaces. Add a defect found on a frame to the report as a finding; ' +
      'a capture artifact (a focus ring from a synthetic click, clipping by the window) — retake the frame, do not skip it. ' +
      'In one task the only real defect of the task was on a frame that nobody opened.',
  )
}
if (left.length) {
  reasons.push(
    `stage-pipeline: you leave running what you opened:\n${left.join('\n')}\n` +
      'Close each page you opened with `close_page` (its id is the `[selected]` one in the list `new_page` returned). If `close_page` answers "The last open page cannot be closed", ' +
      'navigate that page to `about:blank` with `navigate_page` instead, so the app stops running in it. Stop a browser you launched by its PID: `kill <pid>` ' +
      '(a journey script closes its own in a `finally` — `${CLAUDE_PLUGIN_ROOT}/skills/devtools-verify/references/journey.mjs`). ' +
      'Leave alone what you did not open: the orchestrator\'s login page, another checker\'s page, the session\'s MCP browser itself (the orchestrator closes it with `browser-cleanup.mjs`). ' +
      'On one machine three MCP browsers stayed open 18–23 h after their sessions went idle, the app still running in their tabs.',
  )
}
process.stdout.write(JSON.stringify({ decision: 'block', reason: reasons.join('\n\n') }))
process.exit(0)

/** What the agent opened and left running: its pages in the freshest MCP list, the browsers it launched that still run (see the header). */
async function leftovers() {
  if (!opened.size && !launched.size) return []
  if (!(await leftoverRulesApply())) return []
  const out = []
  if (pageList) {
    const mine = [...opened].filter((id) => pageList.has(id))
    const blankLast = mine.length === 1 && pageList.size === 1 && pageList.get(mine[0]).url === 'about:blank'
    // the URL is the page's text: cut, so a page cannot flood the message (a stop reason past 64 KB is cut mid-JSON on its way out)
    const shown = (url) => (url.length > 200 ? `${url.slice(0, 200)}…` : url)
    if (!blankLast) for (const id of mine) out.push(`- page ${id} — ${shown(pageList.get(id).url)} (opened by your new_page)`)
  }
  // No timestamps in the transcript: the agent's run has no start, so no PID can be shown to be its own — none is named (S-1, fail open).
  if (launched.size && Number.isFinite(started)) {
    const { processTable, descendants } = await import('../processes.mjs')
    const { executableName, isBrowserLike } = await import('../browser-cleanup.mjs')
    const table = processTable({ timeout: 2000 })
    // Started after the agent's first transcript record (`etime` is whole seconds, so a process started then never reads as older): an older one is not its launch.
    const runSeconds = (Date.now() - started) / 1000
    const young = (entry) => entry.age !== null && entry.age <= runSeconds
    for (const pid of table ? launched : []) {
      const entry = table.get(pid)
      if (!entry || !young(entry)) continue
      const browser = [entry, ...descendants(table, pid, { depth: 3 })].find((item) => young(item) && isBrowserLike(item.args))
      // The PID and the executable's name only: the command line can be another process's, and its text is not the agent's to read.
      if (browser) out.push(`- pid ${pid} — ${browser.pid === pid ? 'a browser you launched' : `launched browser pid ${browser.pid}`} (${executableName(browser.args)}), still running`)
    }
  }
  return out
}

/** D7 of VT-1: a force run that was already open when this plugin version first saw the task keeps the rules it started with; any other run, or no run, gets them. */
async function leftoverRulesApply() {
  const block = task ? openForceBlock(task.stages) : null
  if (!block) return true
  try {
    const { releaseGate } = await import('../journal-check.mjs')
    return ruleAppliesToBlock(releaseGate(pluginDataDir(), task.dir), block.heading)
  } catch {
    return true
  }
}

// The task directory can sit behind a symlink (`/var` → `/private/var`, `~/.claude/<team>-tasks`): real paths are compared.
function real(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function images(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return images(path)
    return IMAGE.test(entry.name) ? [path] : []
  })
}
