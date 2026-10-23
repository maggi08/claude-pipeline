import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { CONFIRMED_LINE, headingDate, ruleAppliesToBlock } from '../markers.mjs'
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
 *   (MCP 1.6.0 refuses to close the last page: "The last open page cannot be closed"), and unless a later page tool of that list's server answered with the
 *   transport's disconnect error (m-2: no call can close the page any more; the agent names it under "Could not verify");
 * - a browser it launched still runs (S-1 of VT-1 5b: a PID counts only from the agent's own Bash call): the `journey: browser pid N` line of references/journey.mjs
 *   in a Bash result, or the single number a Bash call printed for `<a browser or a node/npx script> … & echo $!` when that echo's output is printed (f-2) — a word
 *   of the backgrounded command, or of a `bash -c "…"` string in it, is a browser by browser-cleanup's list of names (m-1) or a script runner (m-5: `timeout 600 node …`);
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
// The error a page tool gets once its MCP server is gone (m-2), in the transport's own words at the start of the answer: Claude Code's `MCP server "…" is not
// connected`, the MCP SDK's `MCP error -32000: Connection closed`. Anywhere else in an error answer the words can be the page's or the agent's (m-4): MCP 1.6.0
// writes the page's open dialog into it (`# Open dialog\nalert: Not connected…`), and a failed `new_page` the URL it was given (`… at http://…?amount=-32000`).
const DISCONNECT = /^(?:<tool_use_error>)?(?:Error: )?(?:MCP error -32000: Connection closed|MCP server "[^"\n]*" is not connected)\b/
const FALLBACK_NOTE = /^Note: the previously selected page (?:was closed|is no longer listed)/m
const OPEN_DIALOG = /^# Open dialog\b/m
// `<a browser or a script runner> … & echo $!`: the background start the skills prescribe for a process the agent stops itself. Any word of the backgrounded
// command counts, not only its first (m-5: a wrapper runs the program — `timeout 600 node …`, `/usr/bin/env node …`, `nice -n 10 …`, `caffeinate -i …`); a browser
// is told by browser-cleanup's list of names (m-1: a list of its own here missed `google-chrome`, `chromium-browser`), a runner by this.
const RUNNER = /^(?:node|npx|npm|pnpm|yarn|bun|deno|tsx|ts-node|playwright)$/i
const { executableName, isBrowserLike, isBrowserName } = await import('../browser-cleanup.mjs')
// The `echo $!` right after a background `&`, as a command of its own: only a separator or the end follows it, so its number is printed, not redirected or piped
// (f-2: in `… & echo $! > /tmp/s.pid; pgrep -n -f "Google Chrome"` the one printed number is pgrep's).
const ECHO_PID = /(?<![&>])&\s*echo[ \t]+(["']?)\$!\1(?=[ \t]*(?:[;\n]|&&|\|\||$))/g
const calls = new Map() // tool_use id → { name, input }
let pageList = null // the freshest `## Pages` list an MCP call returned: id → { url, selected }
let listServer = null // the MCP server whose page tool returned that list (`mcp__<server>__<tool>`)
let serverGone = false // a page tool of that server answered with a disconnect error after the list: no call can close a page there any more (m-2)
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
  if (!head || OPEN_DIALOG.test(text.slice(0, head.index))) return null
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

// A titled page is `<title> (<url>)`, an untitled one is the URL itself. The space before the parenthesis tells them apart (m-3: an untitled `http://x/#(about:blank)` is no blank page).
function pageUrl(label) {
  return normalUrl(/ \(([a-z][a-z0-9+.-]*:[^\s()]*)\)$/i.exec(label)?.[1] ?? label)
}

function normalUrl(url) {
  try {
    return new URL(String(url)).href
  } catch {
    return String(url ?? '')
  }
}

/**
 * The server is gone (m-2): an error answer of a page tool of the server whose list is the freshest, with no list, that starts with the transport's disconnect
 * error. After a disconnect no `close_page` can be answered, so a page rule that waited for a fresh list could never be met: every stop would be blocked until
 * Claude Code ends the loop. Only that start of a page tool's error answer counts. A console message is the page's text (S-2); an error answer can carry the page's
 * text too — MCP 1.6.0 writes the open dialog into it (f-1, m-4) — so an answer with a `# Open dialog` block never counts, and neither does a disconnect word
 * later in the answer (a failed `new_page` repeats its URL). The next good list clears the mark.
 */
function readPages(call, block, text) {
  const pages = readPageList(text)
  const server = call.name.slice(0, call.name.lastIndexOf('__'))
  if (!pages) {
    if (block.is_error === true && server === listServer && !OPEN_DIALOG.test(text) && DISCONNECT.test(text.trimStart())) serverGone = true
    if (NEW_PAGE.test(call.name)) unlisted.push(normalUrl(call.input.url))
    return
  }
  listServer = server
  serverGone = false
  const fresh = [...pages.keys()].filter((id) => !seenPages.has(id))
  for (const id of pages.keys()) seenPages.add(id)
  const selected = [...pages].find(([, page]) => page.selected)?.[0]
  // m-1: when the selected page was closed, the answer re-selects page 1 under a note before `## Pages`: that page is not new_page's. Only a fresh selected id counts.
  const fallback = FALLBACK_NOTE.test(text.slice(0, Math.max(0, text.search(/^## Pages\b/m))))
  if (NEW_PAGE.test(call.name) && !block.is_error && selected !== undefined && fresh.includes(selected) && !fallback) opened.add(selected)
  // m-1 (final check, run 4): the note says the tab an errored new_page made closed itself, so its pending URL is gone and page 1 is not its tab.
  // m-1 (branch 7): not on a successful new_page's own answer, whose note is about its own tab; the pending URL of an earlier errored one stays.
  const own = NEW_PAGE.test(call.name) && !block.is_error
  if (fallback && !own && unlisted.length > 0) unlisted.pop()
  // m-2 (branch 7): the note re-selects the oldest page, the orchestrator's, so it never matches a pending URL (a retried errored new_page).
  const reselected = fallback ? selected : undefined
  // An errored new_page's tab: the fresh selected id first (new_page selects its tab), then the newest — an older unseen page at that URL is someone else's (m-1).
  const candidates = fresh.sort((a, b) => b - a)
  if (fresh.includes(selected)) candidates.unshift(...candidates.splice(candidates.indexOf(selected), 1))
  for (const id of candidates) {
    const at = unlisted.indexOf(pages.get(id).url)
    if (at === -1 || opened.has(id) || id === reselected) continue
    opened.add(id)
    unlisted.splice(at, 1)
  }
  pageList = pages
}

/**
 * PIDs the agent launched, from its own Bash results only (S-1): the `journey: browser pid N` line of journey.mjs, and the one number a `… & echo $!` call printed
 * when a word of what it put in the background is a browser or a script runner (m-5: under a wrapper too; a `bash -c "node …"` string is read word by word).
 * This only names a candidate: `leftovers()` counts the PID only with a young browser executable at or below it, so `chromedriver …` or
 * `tail -f /tmp/google-chrome.log` launches nothing. An output with more than that number (a `pgrep` after it) attributes nothing.
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
  if (shellWords(command.slice(0, echo.index), { last: true }).some((word) => launches(word, 0))) launched.add(Number(single[1]))
}

// A browser or a script runner, or a string with one among its words (`bash -c "node …"`, `sh -c '… && node …'`; nested up to three strings deep).
function launches(word, depth) {
  if (isBrowserName(word) || RUNNER.test(word.split(/[\\/]/).pop())) return true
  return depth < 3 && /\s/.test(word) && shellWords(word).some((inner) => launches(inner, depth + 1))
}

/**
 * The shell words of a text, with quotes and backslash escapes resolved (`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`, `Google\ Chrome`). With
 * `last`, only the words of its last command: an unquoted `;`, `&&`, `||`, `|`, `(`, newline or lone `&` (m-5: `yarn dev … & chromium … & echo $!` backgrounds
 * `chromium`) starts the list again, while the `&` of `2>&1`, `>&` and `&>` is part of a redirection. One pass over the text.
 */
function shellWords(text, { last = false } = {}) {
  let words = []
  let word = null
  let quote = null
  const cut = (separator) => {
    if (word !== null) words.push(word)
    word = null
    if (separator && last) words = []
  }
  for (let at = 0; at < text.length; at++) {
    const char = text[at]
    if (quote) {
      if (char === quote) quote = null
      else if (quote === '"' && char === '\\' && /["\\$`]/.test(text[at + 1] ?? '')) word += text[++at]
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      word ??= ''
    } else if (char === '\\' && at + 1 < text.length) word = (word ?? '') + text[++at]
    else if (char === '&' && (text[at - 1] === '>' || text[at + 1] === '>')) word = (word ?? '') + char
    else if (char === '&' || char === '|' || char === ';' || char === '(' || char === '\n') {
      cut(true)
      if ((char === '&' || char === '|') && text[at + 1] === char) at++
    } else if (char === ')' || /\s/.test(char)) cut(false)
    else word = (word ?? '') + char
  }
  cut(false)
  return words
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
  // The server is gone (m-2): its pages cannot be closed — the agent names them under "Could not verify" (the skill, "Closing"), the stop goes through.
  if (pageList && !serverGone) {
    const mine = [...opened].filter((id) => pageList.has(id))
    const blankLast = mine.length === 1 && pageList.size === 1 && pageList.get(mine[0]).url === 'about:blank'
    // the URL is the page's text: cut, so a page cannot flood the message (a stop reason past 64 KB is cut mid-JSON on its way out)
    const shown = (url) => (url.length > 200 ? `${url.slice(0, 200)}…` : url)
    if (!blankLast) for (const id of mine) out.push(`- page ${id} — ${shown(pageList.get(id).url)} (opened by your new_page)`)
  }
  // No timestamps in the transcript: the agent's run has no start, so no PID can be shown to be its own — none is named (S-1, fail open).
  if (launched.size && Number.isFinite(started)) {
    const { processTable, descendants } = await import('../processes.mjs')
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
    // a heading with no date counts from its `Confirmed:` line, as the receipts and final-review rules count it (receipts.mjs)
    const confirmed = headingDate(block.body.split('\n').find((line) => CONFIRMED_LINE.test(line)) ?? '')
    return ruleAppliesToBlock(releaseGate(pluginDataDir(), task.dir), block.heading, confirmed)
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
