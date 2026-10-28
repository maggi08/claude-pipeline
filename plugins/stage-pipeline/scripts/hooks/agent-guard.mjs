import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIRMED_LINE, MODE_WORD, NO_GATE_COMMAND } from '../markers.mjs'
import { denyTool } from './firing.mjs'
import { openForceBlock, pluginDataDir, readHookInput, readPipelineState, reviewModel } from './pipeline-state.mjs'

/**
 * Two rules for launching subagents that the orchestrator keeps only in memory — and loses
 * on a long run:
 *
 * - whole-branch pro-review runs on `review_model` (stage-check, Step 3.3). The model is passed
 *   as a parameter on the call, and of 13 live whole-branch reviews 5 went to sonnet from the
 *   agent's frontmatter: the first review of a run ran on opus, the second one, on a neighbouring
 *   branch or after a catch-up, did not.
 * - `stage-implement` starts only after the run interview (stage-force, Step 0): the orchestrator
 *   clarifies ambiguous free-form answers in the batch itself and writes a `Confirmed:` line into the
 *   "Force run" block. Without the interview a free-form answer "current branch" quietly turned into a
 *   branch off release instead of dev, and "return it to the webview" into "do not touch master".
 *   The hook does not require a separate "yes" after the answers: the answers to the batch are the
 *   start, and a second question is an extra stop.
 *   Blocks opened before 0.12 (a date in the heading earlier than CONFIRM_SINCE) are left alone: a run
 *   in progress does not have to rewrite its block, even one opened on the release day on 0.11.
 */
const CONFIRM_SINCE = '2026-10-03'
const WHOLE_BRANCH = new RegExp(`whole[-\\s]branch\\s+mode|(?:${MODE_WORD})\\s*:?\\s*\\**whole[-\\s]branch`, 'i')

const input = await readHookInput()
const toolInput = input.tool_input ?? {}
const type = String(toolInput.subagent_type ?? '')
const agent = type.split(':').at(-1)
if (agent !== 'pro-review' && agent !== 'stage-implement') process.exit(0)

const state = readPipelineState(input.cwd ?? process.cwd())
if (!state) process.exit(0)

if (agent === 'pro-review' && WHOLE_BRANCH.test(toolInput.prompt ?? '')) {
  const want = reviewModel(state.config)
  const got = String(toolInput.model || agentModel('pro-review')).toLowerCase()
  if (!got.includes(want) && !want.includes(got)) {
    deny(
      'agent-guard/review-model',
      `stage-pipeline: whole-branch pro-review runs on review_model — \`${want}\` (pipeline.config.md, opus by default), but the call goes to \`${got}\`. ` +
        `Repeat the same call with model: "${want}" (stage-check, Step 3.3).`,
    )
  }
}

if (agent === 'stage-implement') {
  const task = state.tasks.find((candidate) => candidate.current)
  const block = task && openForceBlock(task.stages)
  if (block && (block.date ? block.date >= CONFIRM_SINCE : block.unreadDate) && !CONFIRMED_LINE.test(block.body)) {
    deny(
      'agent-guard/no-confirmed',
      `stage-pipeline: block "${block.heading.replace(/^## /, '')}" of task ${task.ticket} has no \`Confirmed:\` line (stage-force, Step 0). ` +
        'The interview is done — add `Confirmed: <date> — interview answers` to the block (if there were no questions, `— no questions`) and launch again. ' +
        'Do not ask the user for a separate confirmation: the answers to the batch are the start of the run.',
    )
  }
}
if (agent === 'stage-implement') {
  const task = state.tasks.find((candidate) => candidate.current)
  const verdict = task && !task.unreadable ? await planVerdict(state, task, toolInput.prompt ?? '') : null
  if (verdict) deny(verdict)
}
// K11.1 (VT-1 stage 11): the spawn is allowed — the tree is recorded for the stop hook to compare the hand-back with. A denied spawn records nothing.
if (agent === 'stage-implement' && typeof input.session_id === 'string' && input.session_id) await recordSpawn(state, toolInput.prompt ?? '', input.session_id, input.cwd ?? process.cwd())
process.exit(0)

/** The spawn snapshot (maker.mjs, `takeSnapshot`): never throws and never denies. The import is lazy, like plan-check's. */
async function recordSpawn(state, prompt, session, cwd) {
  try {
    const { stageOf, takeSnapshot } = await import('../maker.mjs')
    const task = state.tasks.find((candidate) => candidate.current)
    // the config's own words for "no command" (markers.mjs `NO_GATE_COMMAND`, the Russian one included), a trailing comment after them too; `off` is the old spelling
    const command = (/^[ \t]*-[ \t]*type_check:[ \t]*[`*]*([^\n]*)$/im.exec(state.config ?? '')?.[1] ?? '').trim()
    const typeCheck = Boolean(command) && !NO_GATE_COMMAND.test(command) && !/^off(?![a-z])/i.test(command)
    takeSnapshot(pluginDataDir(), { session, cwd, ticket: task?.ticket ?? null, stage: stageOf(prompt), taskDir: task?.dir ?? null, typeCheck, config: state.config ?? null })
  } catch {
    // no snapshot: the stop hook does not judge this maker
  }
}

/**
 * plan-check at the spawn of `stage-implement` in implement mode (VT-5 stage 10, K10.3): the stage's problems plus the Force block items.
 * The stage comes from the prompt (`Stage N`, `stage number: N`), else the first stage that is not done. Fix-mode spawns are not checked,
 * and a crash or an unreadable file never denies. The import is lazy: pro-review spawns do not pay for it.
 */
async function planVerdict(state, task, prompt) {
  try {
    if (/(?:\bmode|режим)\s*:?\s*\**fix\b|\bfix\s+mode\b/i.test(prompt)) return null
    const { checkPlan, format, stageForSpawn } = await import('../plan-check.mjs')
    const stage = stageForSpawn(task.stages, prompt)
    if (stage === null) return null
    const result = checkPlan(task.stages, { taskDir: task.dir, dataDir: pluginDataDir(), roots: [state.root], config: state.config, stage })
    if (!result.problems.length) return null
    const lines = result.problems.map(format)
    return (
      `stage-pipeline: plan-check finds ${result.problems.length} problem(s) for stage ${stage} of task ${task.ticket} (stage-force, Step 0):\n${lines.join('\n')}\n` +
      'Fix the lines in STAGES.md and log what you decided alone under "⚠ Awaiting user confirmation", or mark the criteria `[blocked: B<n>]`, then launch again. ' +
      `Check it yourself: node \${CLAUDE_PLUGIN_ROOT}/scripts/plan-check.mjs <STAGES.md> --stage ${stage}.`
    )
  } catch {
    return null
  }
}

function agentModel(name) {
  try {
    const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../agents', `${name}.md`), 'utf8')
    return file.match(/^model:\s*(\S+)/m)?.[1] ?? 'inherit'
  } catch {
    return 'inherit'
  }
}

function deny(rule, reason) {
  const task = state.tasks.find((candidate) => candidate.current)
  denyTool(rule, reason, { input, task: task?.ticket, repo: state.worktree })
}
