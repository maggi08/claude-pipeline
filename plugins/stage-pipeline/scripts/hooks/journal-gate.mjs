import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { baselineInfo, fingerprint, forceCloseViolations, lastForceBlock, newJournalViolations, reportNames, reportViolations } from '../journal-check.mjs'
import { gateCloseViolations } from '../ci-gates.mjs'
import { CLOSED_WORD } from '../markers.mjs'
import { runDigest } from '../run-digest.mjs'
import { pluginDataDir, readHookInput, readPipelineState } from './pipeline-state.mjs'

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
 * and when a force run is closed. When a run closes, a summary of what was not verified goes into the context — it goes
 * into the final message as a whole, not at the orchestrator's choice.
 *
 * 0.15 — the project's CI gates (smoke, e2e from the config): "completed" only when each one is green on the current HEAD,
 * "completed with blockers" — each non-green one is named as a blocker. In one task smoke failed only at the PR.
 *
 * Only what is new: journal lines that were not in the snapshot, and reports written after it
 * (the snapshot is in the plugin data directory, session-start makes it). Old stages and closed tasks
 * do not have to be rewritten. A new violation reminds about itself until it is fixed.
 */
const input = await readHookInput()
const tool = input.tool_name ?? ''
const toolInput = input.tool_input ?? {}
const target = tool === 'Bash' ? (toolInput.command ?? '') : (toolInput.file_path ?? '')
if (!/STAGES|checks[/\\]/.test(target)) process.exit(0)

const cwd = input.cwd ?? process.cwd()
const state = readPipelineState(cwd)
if (!state) process.exit(0)

// The task directory can sit behind a symlink (`.claude/tasks` → `~/.claude/team-tasks`): real paths are compared.
const real = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
const inside = (dir, path) => path === dir || path.startsWith(dir + sep)
const filePath = tool === 'Bash' ? null : real(resolve(cwd, target))
const tasks = state.tasks
  .map((task) => ({ ...task, dir: real(task.dir) }))
  .filter((task) => (filePath ? inside(task.dir, filePath) : task.current || target.includes(task.dir) || target.includes(`/${task.ticket}/`)))
if (!tasks.length) process.exit(0)

const messages = []
const context = []
for (const task of tasks) {
  const journal = newJournalViolations(pluginDataDir(), task.dir)
  // The report is the one written by this edit: for Write/Edit its path, for Bash the reports changed just now.
  const checks = join(task.dir, 'checks')
  const written = filePath
    ? inside(checks, filePath) && filePath.endsWith('.md')
      ? [filePath]
      : []
    : reportNames(task.dir)
        .map((name) => join(checks, name))
        .filter((path) => Date.now() - statSync(path).mtimeMs < 60_000)
  // The language is checked only for a report that did not exist when the task was first seen: an old report is not rewritten, however it is edited.
  const { reports: known } = baselineInfo(pluginDataDir(), task.dir)
  const reports = written.flatMap((path) => reportViolations(path, known.has(basename(path)) ? null : task.language))
  const closing = [...forceCloseViolations(pluginDataDir(), task.dir), ...gateCloseViolations(pluginDataDir(), state.worktree, state.config, task.dir)]
  for (const violation of [...journal, ...reports, ...closing]) messages.push(`- ${task.ticket}: ${violation.message}`)
  if (!closing.length) {
    const digest = closedDigest(task)
    if (digest) context.push(digest)
  }
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
function closedDigest(task) {
  const stagesPath = join(task.dir, 'STAGES.md')
  if (!existsSync(stagesPath)) return null
  const block = lastForceBlock(readFileSync(stagesPath, 'utf8'))
  if (!block || !CLOSED_WORD.test(block.heading)) return null
  const { lines } = baselineInfo(pluginDataDir(), task.dir)
  const shown = join(pluginDataDir(), 'digest-shown.json')
  let seen = {}
  try {
    seen = JSON.parse(readFileSync(shown, 'utf8'))
  } catch {
    // first showing
  }
  const key = `${real(task.dir)}::${block.heading}`
  // A block closed before the snapshot is an old run: its summary was already seen.
  if (seen[key] || lines.has(fingerprint(block.heading))) return null
  const digest = runDigest(task.dir, pluginDataDir(), state)
  try {
    mkdirSync(pluginDataDir(), { recursive: true })
    writeFileSync(shown, JSON.stringify({ ...seen, [key]: new Date().toISOString() }))
  } catch {
    // not written — the summary will come once more, which is safe
  }
  return (
    `stage-pipeline: force run ${task.ticket} is closed. Below is the summary from the journal and reports. Put it into the final message as a whole, ` +
    `without retelling or picking: what to check first is the user's decision.\n\n${digest}`
  )
}
