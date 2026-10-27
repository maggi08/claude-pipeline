import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { readHookInput } from './hook-input.mjs'

/**
 * /stage-check requires that a criterion's result names who checked it, a checker's PASS carries a measurement,
 * and a design checker is skipped only on logic-only. On live runs this held only every other time:
 * "✅ pro-review by code" on devtools-verify criteria, "4.5 PASS" with no value, proto-compare
 * "skip: MCP-Chrome busy". The hook looks at an edit of the journal or of a checker report right after it
 * and returns the violations to the agent — in the same turn, while the stage is still open.
 *
 * 0.14 — findings outcome (references/checker-report.md). A checker finding is closed by a fix,
 * a proven false finding or a blocker, not by a line "leaving it" or "to Awaiting user confirmation": in three
 * reviewed tasks most of what the user later fixed by hand went away this way. A report is checked
 * when written (summary, forbidden outcomes, geometry for devtools-verify), the journal — when a checker is marked
 * and when a force run is closed. When a run closes, the short summary goes into the context (the full one is written to RUN-DIGEST.md) — it goes
 * into the final message as a whole, not at the orchestrator's choice.
 *
 * 0.15 — the project's CI gates (smoke, e2e from the config): "completed" only when each one is green on the current HEAD,
 * "completed with blockers" — each non-green one is named as a blocker. In one task smoke failed only at the PR.
 *
 * 0.18.0 — Bash is judged by what the call did, not by what its text says. A `ls .claude/tasks/EN-1/checks` or a `cat STAGES.md` from another task's
 * session used to return EN-1's force-close demands (about a third of the firings in the 2026-10-16 audit were reads). A PreToolUse run of this hook
 * stamps the mtime and size of STAGES.md and `checks/*.md` of the current tasks and of the tasks the command names by path; the PostToolUse run acts only on the tasks where one of them changed
 * during the call. No stamp (the pre-hook did not run) — nothing to compare, so the hook stays silent.
 *
 * Stage 5 of VT-1 — a `false` outcome needs a proof of its own kind: "the fix is impossible", "not reproduced" without two attempts and the route, a plan line instead of code are returned
 * (dismissals.mjs); a critical dismissed as false must cite the fresh report that confirmed it; a new "Awaiting" line or Force assumption needs a rollback cost and a basis (decisions.mjs).
 * Reports and lines that were there when the task was first seen on this version are not touched.
 *
 * Stage 3 of VT-1 — "completed" also needs the whole-branch pro-review and task-converge reports newer than the last commit that changed the tree
 * (receipts.mjs); the force commit itself is judged by git-guard against the stage's checker reports.
 *
 * Stage 5b of VT-1 — the close of a Force block also closes the session's MCP browser (`browser-cleanup.mjs --session`: only this session's
 * pipeline browsers, by PID; `ps` gets 1.5 s, the browser 0.8 s to exit before SIGKILL), and the run digest records what it did. Three browsers of idle sessions stayed open 18–23 h.
 * Only the call that turned the heading from open to closed closes it (m-2, S-5): an Edit / MultiEdit whose `old_string` holds the open heading and `new_string`
 * the closed one, a Write whose file held the open heading before the call (stamped by the PreToolUse run), a Bash call that names the task and whose PreToolUse
 * stamp held the open heading — or a later call of the same session after that close was rejected and then fixed, unless the block was open again in between
 * (f-3) or 7 days passed. A heading closed by hand, by another session,
 * during an unrelated Bash call or by an older plugin leaves the browser open: the digest says so with the close command (`skipped: not this call`), and so it does
 * with `STAGE_PIPELINE_BROWSER_CLEANUP=off` (`skipped: off`). Nothing about it can hold the close up: no `ps`, no session, an error — the digest says "not checked" or nothing.
 *
 * The hook runs twice on every Bash call of every repo, so the common case is cheap: outside a pipeline repo the PreToolUse run leaves on a file-system check
 * (no git, no task reads), and the PostToolUse run reads its stamp first and stats only the stamped paths — the task state is read only when one of them changed.
 * The rule modules are loaded only then. Before an Edit / Write / MultiEdit of a task file the PreToolUse run only makes sure the task snapshot exists
 * (the first look reads the journal before the edit, not after it) and says nothing.
 *
 * Only what is new: journal lines that were not in the snapshot, and reports written after it
 * (the snapshot is in the plugin data directory, session-start makes it). Old stages and closed tasks
 * do not have to be rewritten. A new violation reminds about itself until it is fixed.
 */
const input = await readHookInput()
const tool = input.tool_name ?? ''
const toolInput = input.tool_input ?? {}
const target = tool === 'Bash' ? '' : String(toolInput.file_path ?? '')
if (tool !== 'Bash' && !/STAGES|checks[/\\]/.test(target)) process.exit(0)
const { recordFiring } = await import('./firing.mjs')
const { hasPipelineConfig, pluginDataDir, readBounded, readDataFiles, readPipelineState, reportNames } = await import('./pipeline-state.mjs')
const cwd = input.cwd ?? process.cwd()
const pre = input.hook_event_name === 'PreToolUse'

// The task directory can sit behind a symlink (`.claude/tasks` → `~/.claude/team-tasks`): real paths are compared.
const real = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
const inside = (dir, path) => path === dir || path.startsWith(dir + sep)
const statOf = (path) => {
  try {
    const { mtimeMs, size } = statSync(path)
    return `${mtimeMs}:${size}`
  } catch {
    return null // gone or unreadable
  }
}

// What a Bash call can change in the journal: STAGES.md and the reports of the tasks, by mtime and size; the directories that hold them, so a new file is seen too.
const callId = String(input.tool_use_id ?? input.session_id ?? 'call').replace(/[^\w.-]/g, '_')
const stampPath = join(pluginDataDir(), 'bash-start', `${callId}.json`)
// The freshest Force heading of STAGES.md before a Write: whether this Write is the one that closed the block (m-2).
const writeStampPath = join(pluginDataDir(), 'write-start', `${callId}.json`)
let writeStampRead // undefined — not read yet
// The closes the hook rejected, by task and block: the session that made each one (see `rememberRejectedClose`).
const REJECTED = join(pluginDataDir(), 'browser-close-rejected.json')
let before = null
let forceBefore = {} // task dir → the freshest Force heading before this Bash call (its PreToolUse stamp)
if (tool === 'Bash' && !pre) {
  // PostToolUse: the stamp first — no stamp (outside the pipeline, or the pre-hook did not run), nothing to compare; no stamped path moved, nothing changed.
  try {
    before = JSON.parse(readFileSync(stampPath, 'utf8'))
    rmSync(stampPath, { force: true })
  } catch {
    process.exit(0)
  }
  const files = before.files ?? before // a flat stamp of 0.16–0.18 before this change
  if (!Object.entries({ ...files, ...(before.dirs ?? {}) }).some(([path, stamp]) => statOf(path) !== stamp)) process.exit(0)
  forceBefore = before.force ?? {}
  before = files
}

/** Writes a PreToolUse stamp; stamps of calls that never came back (an interrupted call) do not pile up. A stamp not written leaves the post-hook without it. */
const saveStamp = (path, data) => {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(data))
    for (const name of readdirSync(dirname(path))) {
      const old = join(dirname(path), name)
      if (Date.now() - statSync(old).mtimeMs > 86_400_000) rmSync(old, { force: true })
    }
  } catch {
    // not stamped — the post-hook of this call goes without it
  }
}
if (pre && !hasPipelineConfig(cwd)) process.exit(0)

if (pre && tool !== 'Bash') {
  // Before an Edit / Write of a task file whose snapshot already exists there is nothing to do: no git, no task reads — except the Force heading a Write is about to replace.
  const file = real(resolve(cwd, target))
  if (tool === 'Write' && basename(file) === 'STAGES.md') {
    const { freshestForceHeading } = await import('../markers.mjs')
    // through the bounded reader, as every hook read of a journal (m-3): a new journal, or one over 4 MB that no rule can read, has no heading before
    const heading = freshestForceHeading(readBounded(file).text ?? '')?.[0] ?? null
    saveStamp(writeStampPath, { file, heading })
  }
  const dir = basename(dirname(file)) === 'checks' ? dirname(dirname(file)) : dirname(file)
  const { baselineName, snapshotCurrent } = await import('../baseline-file.mjs')
  for (const text of readDataFiles(pluginDataDir(), baselineName(dir))) {
    try {
      if (snapshotCurrent(JSON.parse(text))) process.exit(0)
    } catch {
      // a broken snapshot — the full path below takes it again
    }
  }
}

const state = readPipelineState(cwd)
if (!state) process.exit(0)
const filePath = tool === 'Bash' ? null : real(resolve(cwd, target))

if (pre && filePath) {
  // PreToolUse of Edit / Write / MultiEdit: the first look of this version at the task reads the journal before the edit. Taken after it, a `## Force run <date>` block
  // written by that very edit would be recorded as a run already there, and the receipts and the close rules would never apply to it. A snapshot that exists stays as it is.
  const touched = state.tasks.map((task) => real(task.dir)).filter((dir) => inside(dir, filePath))
  if (touched.length) {
    try {
      const { baselineInfo } = await import('../journal-check.mjs')
      for (const dir of touched) baselineInfo(pluginDataDir(), dir)
    } catch {
      // no snapshot now — the PostToolUse run takes it, as before
    }
  }
  process.exit(0)
}

const stampOf = (dir) => {
  const files = {}
  for (const path of [join(dir, 'STAGES.md'), ...reportNames(dir).map((name) => join(dir, 'checks', name))]) {
    const stamp = statOf(path)
    if (stamp) files[path] = stamp
  }
  return { files, dirs: { [dir]: statOf(dir), [join(dir, 'checks')]: statOf(join(dir, 'checks')) } }
}
// Only the tasks this call can be blamed for: the current ones of this worktree's branch (foreign current ones included), and any task whose
// directory or `/<TICKET>/` segment the command text names (a session may write another task's journal by path). A concurrent session's edit of
// an unrelated task is not this call's doing. The task root is stamped as a directory: a task created during the call is seen.
const command = String(toolInput.command ?? '')
const named = (task) => command.includes(task.dir) || command.includes(real(task.dir)) || command.includes(`/${task.ticket}/`)
const stampAll = () => {
  const stamps = state.tasks.filter((task) => task.current || named(task)).map((task) => stampOf(real(task.dir)))
  return { files: Object.assign({}, ...stamps.map(({ files }) => files)), dirs: Object.assign({ [real(state.taskDir)]: statOf(real(state.taskDir)) }, ...stamps.map(({ dirs }) => dirs)) }
}
let changed = null
if (tool === 'Bash') {
  if (pre) {
    // The first look of this version at a task the command names (5f, A11): the snapshot is taken before the call, as the Edit / Write PreToolUse does. Taken after a call that writes
    // a block, the block would be recorded as already there and read by words. A snapshot that exists stays as it is.
    try {
      const { baselineInfo } = await import('../journal-check.mjs')
      for (const task of state.tasks.filter((task) => named(task))) baselineInfo(pluginDataDir(), real(task.dir))
    } catch {
      // no snapshot now — the PostToolUse run takes it, as before
    }
    // with the freshest Force heading of each stamped task: the post-hook tells the call that closed the block from one that only ran while it closed
    try {
      const { freshestForceHeading } = await import('../markers.mjs')
      const force = Object.fromEntries(state.tasks.filter((task) => task.current || named(task)).map((task) => [real(task.dir), freshestForceHeading(task.stages ?? '')?.[0] ?? null]))
      saveStamp(stampPath, { ...stampAll(), force })
    } catch {
      // not stamped — the post-hook of this call stays silent
    }
    process.exit(0)
  }
  const after = stampAll().files
  changed = new Set(Object.keys(after).filter((path) => before[path] !== after[path]))
  if (!changed.size) process.exit(0)
}
const tasks = state.tasks
  .map((task) => ({ ...task, dir: real(task.dir) }))
  .filter((task) => (filePath ? inside(task.dir, filePath) : [...changed].some((path) => inside(task.dir, path))))
if (!tasks.length) process.exit(0)

const { baselineInfo, fingerprint, forceCloseViolations, lastForceBlock, newJournalViolations, readTaskFile, reportViolations } = await import('../journal-check.mjs')
const { gateCloseViolations } = await import('../ci-gates.mjs')
const { finalReviewViolations } = await import('../receipts.mjs')
const { CLOSED_WORD, forceHeadings, forceKey } = await import('../markers.mjs')
const { publishDigest, recordBrowserCleanup, taskRepo } = await import('../run-digest.mjs')

const messages = []
const context = []
for (const task of tasks) {
  const journal = newJournalViolations(pluginDataDir(), task.dir)
  // The report is the one written by this edit: for Write/Edit its path, for Bash the reports that changed during the call.
  const checks = join(task.dir, 'checks')
  const written = filePath
    ? inside(checks, filePath) && filePath.endsWith('.md')
      ? [filePath]
      : []
    : [...changed].filter((path) => inside(checks, path) && path.endsWith('.md'))
  // The language is checked only for a report that did not exist when the task was first seen: an old report is not rewritten, however it is edited.
  // The 0.18 report rules — the honest live form and the `doctor:` / `auth:` lines (stage 4), weak dismissals and a critical needing a fresh report (stage 5) — look only at
  // reports that were not there at the 0.18 migration (`ledgerOld`): a report written under 0.16 after the first look stays editable without a made-up `doctor:` line.
  const { reports: known, ledgerOld } = baselineInfo(pluginDataDir(), task.dir)
  const reports = written.flatMap((path) => {
    const after018 = !ledgerOld.has(basename(path))
    return reportViolations(path, known.has(basename(path)) ? null : task.language, { fresh: after018, strict: after018 })
  })
  const closing = [...forceCloseViolations(pluginDataDir(), task.dir), ...gateCloseViolations(pluginDataDir(), state.worktree, state.config, task.dir), ...(task.current ? finalReviewViolations(pluginDataDir(), state.worktree, task.dir) : [])]
  for (const violation of [...journal, ...reports, ...closing]) messages.push(`- ${task.ticket}: ${violation.message}`)
  // One firing per kind of violation the block carries (the violations' own rule names go along as `kinds`: names only, no message text).
  for (const [rule, found] of [['journal-gate/journal', journal], ['journal-gate/report', reports], ['journal-gate/close', closing]]) {
    if (found.length) recordFiring(rule, { input, task: task.ticket, repo: state.worktree, kinds: found.map((violation) => violation.rule).filter(Boolean) })
  }
  if (!closing.length) {
    const digest = await closedDigest(task)
    if (digest) context.push(digest)
  } else rememberRejectedClose(task)
}

if (messages.length) {
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason:
        `stage-pipeline: the edit of the task journal breaks the rules for closing criteria and findings:\n${[...new Set(messages)].join('\n')}\n` +
        'Fix the journal or the report, run the checker or add "## Findings outcome" (references/checker-report.md) before going on. The edit itself is already written, the hook did not undo it.',
    }),
  )
  process.exit(0)
}
if (context.length) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context.join('\n\n') } }))
}
process.exit(0)

/**
 * A summary of what was not verified — once for each closing of a "Force run" block written after the snapshot.
 * It goes into the final message as a whole: in one task the summary picked "kk/en texts, tab title",
 * and under that label lay two defects that the user found while using the product.
 */
async function closedDigest(task) {
  const stages = readTaskFile(task.dir, 'STAGES.md')
  if (stages === null) return null
  const block = lastForceBlock(stages)
  if (!block) return null
  // The block is open again (f-3): a close rejected before the reopen is not this session's close any more — the next close is judged on its own.
  if (!CLOSED_WORD.test(block.heading)) {
    forgetRejectedClose(task, block.heading)
    return null
  }
  const { lines } = baselineInfo(pluginDataDir(), task.dir)
  const shown = join(pluginDataDir(), 'digest-shown.json')
  let seen = {}
  // The hooks' directory over the bare one, where earlier showings from Bash may lie.
  for (const text of readDataFiles(pluginDataDir(), 'digest-shown.json').reverse()) {
    try {
      seen = { ...seen, ...JSON.parse(text) }
    } catch {
      // first showing
    }
  }
  const key = `${real(task.dir)}::${block.heading}`
  // A block closed before the snapshot is an old run: its summary was already seen.
  if (lines.has(fingerprint(block.heading))) return null
  const closer = closedByThisCall(task, block.heading) || closedEarlierBySession(task, block.heading)
  // Once per close. A showing by a call that did not close the block (`by: 'other'`) still lets the closing call show it and close its browser (S-5);
  // a showing of an earlier version (an ISO string) or by the closing call ends it.
  const prior = seen[key]
  if (prior && (prior?.by !== 'other' || !closer)) return null
  await closeSessionBrowser(task, block, closer)
  if (closer) forgetRejectedClose(task, block.heading)
  const { short, path } = publishDigest(task.dir, pluginDataDir(), taskRepo(task.dir, state))
  try {
    mkdirSync(pluginDataDir(), { recursive: true })
    writeFileSync(shown, JSON.stringify({ ...seen, [key]: { at: new Date().toISOString(), by: closer ? 'close' : 'other' } }))
  } catch {
    // not written — the summary will come once more, which is safe
  }
  return (
    `stage-pipeline: force run ${task.ticket} is closed. Below is the short summary, picked by the script from the journal and reports; ` +
    `the full one is in ${path ?? 'RUN-DIGEST.md (could not be written)'}. Put the short one into the final message as a whole, without retelling or picking, as plain markdown and never inside a code block (its headings must render); ` +
    `on "more" or "what about X" open that section from the file instead of repeating everything.\n\n${short}`
  )
}

/**
 * The force close closes this session's MCP browser (stage-force, "Output"); the line goes into the digest. It never fails the hook.
 * Only the call that closed the block closes it (`closer`); otherwise, and with the off switch, the digest says the browser was left open and how to close it.
 */
async function closeSessionBrowser(task, block, closer) {
  try {
    const { CLOSE_COMMAND, OFF_SWITCH, closeSession } = await import('../browser-cleanup.mjs')
    const skipped = process.env[OFF_SWITCH] === 'off' ? 'off' : closer ? null : 'not this call'
    const result = skipped ? { skipped } : await closeSession({ waitMs: 800, psTimeout: 1500 })
    recordBrowserCleanup(pluginDataDir(), task.dir, block.heading, { ...result, command: CLOSE_COMMAND })
  } catch {
    // the close of the run goes on; the digest just has no browser line
  }
}

/**
 * This call turned the block's heading from open to closed (m-2 / S-5 of VT-1 5b): an Edit / MultiEdit whose `old_string` holds the open heading and whose
 * `new_string` holds the closed one; a Write whose file held the open heading before the call (the PreToolUse stamp); a Bash call that names the task and whose
 * PreToolUse stamp held the open heading. A change made by someone else during an unrelated call is not this call's.
 */
function closedByThisCall(task, heading) {
  const key = forceKey(heading)
  const openIn = (text) => forceHeadings(String(text ?? '')).some(([line]) => !CLOSED_WORD.test(line) && forceKey(line) === key)
  if (tool === 'Bash') return named(task) && openIn(forceBefore[task.dir])
  if (filePath !== join(task.dir, 'STAGES.md')) return false
  if (tool === 'Write') {
    const stamp = writeStamp()
    return stamp?.file === filePath && openIn(stamp.heading) && String(toolInput.content ?? '').includes(heading)
  }
  const edits = tool === 'MultiEdit' ? (Array.isArray(toolInput.edits) ? toolInput.edits : []) : [toolInput]
  return edits.some((edit) => String(edit?.new_string ?? '').includes(heading) && openIn(edit?.old_string))
}

/** The Write stamp of this call, read once and removed. */
function writeStamp() {
  if (writeStampRead === undefined) {
    try {
      writeStampRead = JSON.parse(readFileSync(writeStampPath, 'utf8'))
      rmSync(writeStampPath, { force: true })
    } catch {
      writeStampRead = null
    }
  }
  return writeStampRead
}

/**
 * A close the hook rejected (open blockers, a missing report) is still that session's close: the heading stays written, and the call that fixes the journal
 * after it does not change the heading. The session that made the open → closed change is kept here, by task and block, until its close goes through, the block
 * is open again (f-3), or 7 days pass.
 */
function rejectedKey(task, heading) {
  return `${task.dir}::${forceKey(heading)}`
}
function recent(entry) {
  return Date.parse(entry?.at ?? '') > Date.now() - 7 * 86_400_000
}
function readRejected() {
  try {
    const entries = JSON.parse(readFileSync(REJECTED, 'utf8'))
    return entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {}
  } catch {
    return {}
  }
}
function writeRejected(entries) {
  try {
    mkdirSync(dirname(REJECTED), { recursive: true })
    writeFileSync(REJECTED, JSON.stringify(Object.fromEntries(Object.entries(entries).filter(([, entry]) => recent(entry)))))
  } catch {
    // not kept — that close leaves the browser open and says so
  }
}
function rememberRejectedClose(task) {
  const block = lastForceBlock(readTaskFile(task.dir, 'STAGES.md') ?? '')
  if (!input.session_id || !block || !CLOSED_WORD.test(block.heading) || !closedByThisCall(task, block.heading)) return
  writeRejected({ ...readRejected(), [rejectedKey(task, block.heading)]: { session: String(input.session_id), at: new Date().toISOString() } })
}
function closedEarlierBySession(task, heading) {
  const entry = readRejected()[rejectedKey(task, heading)]
  return Boolean(input.session_id) && entry?.session === String(input.session_id) && recent(entry)
}
function forgetRejectedClose(task, heading) {
  const entries = readRejected()
  if (!(rejectedKey(task, heading) in entries)) return
  delete entries[rejectedKey(task, heading)]
  writeRejected(entries)
}
