import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { readHookInput, readPipelineState } from './pipeline-state.mjs'

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
    if (block.type === 'tool_result' && doctorCalls.has(block.tool_use_id)) {
      const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n') : ''
      verdict = text.match(VERDICT)?.[1].toLowerCase() ?? 'none'
      continue
    }
    if (block.type !== 'tool_use') continue
    const name = String(block.name ?? '')
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
if (!missed.length) process.exit(0)

const shown = missed.slice(0, 15).map((path) => `- ${path}`)
process.stdout.write(
  JSON.stringify({
    decision: 'block',
    reason:
      `stage-pipeline: you took ${frames.size} frame(s) but did not open all of them — ${missed.length} not viewed:\n${shown.join('\n')}${missed.length > 15 ? `\n- … ${missed.length - 15} more` : ''}\n` +
      'Open each one with Read and look at it: clipping, overlaps, extra borders, text past the edge, empty spaces. Add a defect found on a frame to the report as a finding; ' +
      'a capture artifact (a focus ring from a synthetic click, clipping by the window) — retake the frame, do not skip it. ' +
      'In one task the only real defect of the task was on a frame that nobody opened.',
  }),
)
process.exit(0)

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
