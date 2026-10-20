import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planArchive } from '../archive-stages.mjs'
import { ensureBaseline, releaseGate } from '../journal-check.mjs'
import { FORCE_BLOCK_PRESENT } from '../markers.mjs'
import { AFTER_CLOSE_DAYS, closedForceDate, pluginDataDir, readHookInput, readPipelineState, registerTaskDir, STALE_DAYS, unjournaledCommits } from './pipeline-state.mjs'

/**
 * Every pipeline session starts with "read STAGES.md" — and every time with the question
 * of which one. The hook puts a status line into the context: the current branch's task first, then
 * up to two open tasks touched recently, instead of the file itself — reading a stage selectively
 * is still the skill's job. Old tasks do not appear in the output and require nothing.
 *
 * Along the way: this repo's task directory goes into the registry (a neighbouring repo finds a
 * two-repo task by it), a base snapshot of the journal is taken for the current branch's task (journal-gate
 * checks only what appears after it), and branch commits the journal does not know — work done
 * after a force run closed, bypassing the checkers — are named in a line. Commits in the files of a recently
 * closed task that went to dev from another branch (a fix under someone else's ticket) are named once — a session may run
 * on any branch, and the task journal would never learn of this work.
 */
const input = await readHookInput()
const state = readPipelineState(input.cwd ?? process.cwd())
if (!state) process.exit(0)
registerTaskDir(state.taskDir)

const recent = (task) => Date.now() - task.mtime < STALE_DAYS * 24 * 60 * 60 * 1000
const current = state.tasks.filter((task) => task.current)
const others = state.tasks.filter((task) => !task.current && task.open && recent(task)).slice(0, 2)
for (const task of current) ensureBaseline(pluginDataDir(), task.dir)

// The threshold is the same as in retro.mjs: above it, reading the file shows in the cost of every session.
// The reminder is only for this branch's task and only if archiving would really make the file smaller.
const STAGES_BUDGET_KB = 40
const archiveScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'archive-stages.mjs')

const line = (task, mark) => {
  const mode = task.forceActive ? ' [force run]' : ''
  const path = task.foreign ? task.stagesPath : relative(state.root, task.stagesPath)
  let size = ''
  if (mark && task.sizeKb > STAGES_BUDGET_KB) {
    const { sourceBytes, resultBytes } = planArchive(readFileSync(task.stagesPath, 'utf8'))
    if (sourceBytes - resultBytes > 5 * 1024) {
      size = ` — ${task.sizeKb} KB, fold the closed stages: node "${archiveScript}" ${path} --apply`
    }
  }
  return `- ${task.ticket}${mark}${mode}: ${task.status ?? 'status not set'} — ${path}${size}`
}

const listed = (commits) =>
  commits
    .slice(0, 3)
    .map(({ sha, subject }) => `\`${sha.slice(0, 8)}\` ${subject}`)
    .join('; ') + (commits.length > 3 ? '; …' : '')

// The journal lags behind the branch when the stages are over: in force each stage commit goes into the journal in the same turn.
const outside = (task) => {
  if (task.forceActive || !FORCE_BLOCK_PRESENT.test(task.stages)) return null
  const commits = unjournaledCommits(state, task, { gate: releaseGate(pluginDataDir(), task.dir) })
  if (!commits.length) return null
  const onBranch = commits.filter(({ where }) => where === 'branch')
  const merged = commits.filter(({ where }) => where !== 'branch')
  return [
    onBranch.length && `  ⚠ commits on the task's branches that are in neither STAGES.md nor PR.md (${onBranch.length}): ${listed(onBranch)}.`,
    merged.length && `  ⚠ in ${merged[0].where} after the force run closed — your commits in the task's files that bypass the journal (${merged.length}): ${listed(merged)}.`,
    '    This is work after the force run closed — it bypassed the checkers. Run it through a catch-up stage (/stage-kickoff → /stage-check) or record in the journal what was verified.',
  ]
    .filter(Boolean)
    .join('\n')
}

// A recently closed task of another branch: its follow-up work went to dev — name it once for each new set of commits.
const shownPath = join(pluginDataDir(), 'after-close-shown.json')
let shownBefore = {}
try {
  shownBefore = JSON.parse(readFileSync(shownPath, 'utf8'))
} catch {
  // first showing
}
const shownNow = { ...shownBefore }
const afterClose = state.tasks
  .filter((task) => !task.current && !task.forceActive)
  .filter((task) => {
    const closed = closedForceDate(task.stages)
    return closed && Date.now() - Date.parse(`${closed}T00:00:00`) < AFTER_CLOSE_DAYS * 24 * 60 * 60 * 1000
  })
  .slice(0, 3)
  .flatMap((task) => {
    // The snapshot of a closed task of another branch is taken here if there is none: its runs keep the rules they were closed under (D7).
    const commits = unjournaledCommits(state, task, { gate: releaseGate(pluginDataDir(), task.dir) }).filter(({ where }) => where !== 'branch')
    if (!commits.length) return []
    const key = createHash('sha1').update(commits.map(({ sha }) => sha).sort().join()).digest('hex').slice(0, 16)
    if (shownBefore[task.dir] === key) return []
    shownNow[task.dir] = key
    return [
      `- ${task.ticket} (closed ${closedForceDate(task.stages)}): in ${commits[0].where} after the close — your commits in its files that bypass the journal (${commits.length}): ${listed(commits)}. ` +
        'This is follow-up work after "done" without checkers: record it in the task journal or run it through a catch-up stage on its branch.',
    ]
  })
if (afterClose.length) {
  try {
    mkdirSync(pluginDataDir(), { recursive: true })
    writeFileSync(shownPath, JSON.stringify(shownNow))
  } catch {
    // not written — the line will come once more
  }
}

const lines = [
  ...current.flatMap((task) => [line(task, ` (branch ${state.branch})`), outside(task)].filter(Boolean)),
  ...others.map((task) => line(task, '')),
  ...afterClose,
]
if (!lines.length) process.exit(0)
process.stdout.write(
  `stage-pipeline — tasks in this repo:\n${lines.join('\n')}\n` +
    'When continuing a task, read its STAGES.md selectively (the current stage), not as a whole.\n',
)
