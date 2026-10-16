import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIRMED_LINE, MODE_WORD } from '../markers.mjs'
import { openForceBlock, readHookInput, readPipelineState, reviewModel } from './pipeline-state.mjs'

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
      `stage-pipeline: whole-branch pro-review runs on review_model — \`${want}\` (pipeline.config.md, opus by default), but the call goes to \`${got}\`. ` +
        `Repeat the same call with model: "${want}" (stage-check, Step 3.3).`,
    )
  }
}

if (agent === 'stage-implement') {
  const task = state.tasks.find((candidate) => candidate.current)
  const block = task && openForceBlock(task.stages)
  if (block && block.date && block.date >= CONFIRM_SINCE && !CONFIRMED_LINE.test(block.body)) {
    deny(
      `stage-pipeline: block "${block.heading.replace(/^## /, '')}" of task ${task.ticket} has no \`Confirmed:\` line (stage-force, Step 0). ` +
        'The interview is done — add `Confirmed: <date> — interview answers` to the block (if there were no questions, `— no questions`) and launch again. ' +
        'Do not ask the user for a separate confirmation: the answers to the batch are the start of the run.',
    )
  }
}
process.exit(0)

function agentModel(name) {
  try {
    const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../agents', `${name}.md`), 'utf8')
    return file.match(/^model:\s*(\S+)/m)?.[1] ?? 'inherit'
  } catch {
    return 'inherit'
  }
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  )
  process.exit(0)
}
