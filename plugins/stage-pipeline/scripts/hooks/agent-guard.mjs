import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIRMED_LINE, MODE_WORD, NO_GATE_COMMAND } from '../markers.mjs'
import { denyTool } from './firing.mjs'
import { openForceBlock, pluginDataDir, readHookInput, readPipelineState, reviewModel } from './pipeline-state.mjs'

/**
 * Three rules for launching subagents that the orchestrator keeps only in memory — and loses
 * on a long run:
 *
 * - the security review and ds-parity run as their own agents, pinned to sonnet. A general-purpose
 *   agent inherits the session's model: of 173 general-purpose calls in the transcripts of
 *   2026-10-01…11-09, 52 were security reviews and 40 ds-parity passes, almost all on opus, a median
 *   of 9 min each, and the final rounds ran them again.
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
const WHOLE_BRANCH = new RegExp(`whole[-\\s]branch\\s+mode|(?:${MODE_WORD})\\s*(?::\\s*)?\\**whole[-\\s]branch`, 'i')
// The delta mode of pro-review (`--delta <full report>`, VT-7) reviews the whole-branch lenses over a fix round: held to review_model too.
// Also `Mode: delta`, `delta review`, the Russian forms, and a prompt naming a `-branch-delta-` report; a stage prompt that only mentions "the delta of the round" stays allowed.
const DELTA_MODE = new RegExp(`--delta\\b|\\bdelta[-\\s](?:mode|review)\\b|(?:${MODE_WORD})\\s*(?::\\s*)?\\**delta\\b|дельта[-\\s]?(?:режим|ревью)|(?:${MODE_WORD})\\s*:?\\s*\\**дельта|-branch-delta-`, 'i')
// No subagent_type is a general-purpose agent too; `claude` is the catch-all type of some hosts.
const GENERIC_AGENTS = new Set(['', 'general-purpose', 'claude'])
// Told by the call's description or, for ds-parity, by a prompt that points at its skill. In the transcripts since 2026-10-01 most calls named the check in the
// description; a combined sweep ("Delta sweep final 9": dead-code, i18n, security and ds-parity in one call) is caught by the ds-parity skill path only, so the message
// sends every other check of the prompt to its own agent. "security" alone is not enough: an interview probe of "the account security page" is not a review; it counts
// next to a review word (whole words: "password" is not "pass") or next to another checker's name ("ds-parity security i18n final 7").
const SECURITY_JOB = /\bsecurity\b[^\n]*\b(?:review|re-review|audit|check|pass|sweep)(?:s|es|ed|ing)?\b|\b(?:review|audit|check|pass|sweep)(?:s|es|ed|ing)?\b[^\n]*\bsecurity\b|\bsecurity\b[^\n]*\b(?:ds[-\s]?parity|i18n|dead[-\s]code|deps[-\s]audit)\b|\b(?:ds[-\s]?parity|i18n|dead[-\s]code|deps[-\s]audit)\b[^\n]*\bsecurity\b|(?:ревью|провер\S*|аудит)\s+безопасност|безопасност\S*\s+(?:ревью|провер|аудит)/i
const CHECKER_JOBS = [
  { agent: 'security-review', job: 'the security review', matches: (description) => SECURITY_JOB.test(description) },
  {
    agent: 'ds-parity',
    job: 'the ds-parity pass',
    matches: (description, prompt) => /\bds[-\s]?parity\b|design[-\s]system parity|дубл\S* с дизайн-систем/i.test(description) || /skills\/ds-parity\b/.test(prompt),
  },
]

// the spawn the pending line was written for (K11b.1); a deny closes it with a `denied` line
let spawned = null
const input = await readHookInput()
const toolInput = input.tool_input ?? {}
const type = String(toolInput.subagent_type ?? '')
const agent = type.split(':').at(-1)
const generic = GENERIC_AGENTS.has(agent)
if (!generic && agent !== 'pro-review' && agent !== 'stage-implement') process.exit(0)

const state = readPipelineState(input.cwd ?? process.cwd())
if (!state) process.exit(0)

if (generic) {
  const jobs = CHECKER_JOBS.filter((job) => job.matches(String(toolInput.description ?? ''), String(toolInput.prompt ?? '')))
  if (jobs.length) {
    const how =
      jobs.length === 1
        ? `Repeat the call with subagent_type: "stage-pipeline:${jobs[0].agent}" and the same prompt.`
        : `Split the call: one agent each, ${jobs.map((job) => `subagent_type: "stage-pipeline:${job.agent}"`).join(' and ')}, each with its own report.`
    const runsOn = toolInput.model ? `runs on ${toolInput.model} without the check's method` : "inherits the session's model (opus)"
    deny(
      'agent-guard/checker-agent',
      `stage-pipeline: ${jobs.map((job) => job.job).join(' and ')} ${jobs.length > 1 ? 'have their own agents' : 'has its own agent'} on sonnet; a general-purpose agent ${runsOn}. ${how} ` +
        'If the prompt also asks for other checks, give each its own agent: the security review stage-pipeline:security-review, dead-code, i18n-sweep, deps-audit their own. ' +
        `To keep opus on purpose, pass model: "opus" on the stage-pipeline:${jobs[0].agent} call. ` +
        'If this call is not that check, word its description without it ("security" with review/audit/check/pass, "ds-parity") and call again.',
    )
  }
  process.exit(0)
}

if (agent === 'pro-review' && (WHOLE_BRANCH.test(toolInput.prompt ?? '') || DELTA_MODE.test(toolInput.prompt ?? ''))) {
  const want = reviewModel(state.config)
  const got = String(toolInput.model || agentModel('pro-review')).toLowerCase()
  if (!got.includes(want) && !want.includes(got)) {
    const delta = WHOLE_BRANCH.test(toolInput.prompt ?? '') ? '' : ' (a delta review in `--delta` mode is held to it as well)'
    deny(
      'agent-guard/review-model',
      `stage-pipeline: whole-branch pro-review runs on review_model${delta} — \`${want}\` (pipeline.config.md, opus by default), but the call goes to \`${got}\`. ` +
        `Repeat the same call with model: "${want}" (stage-check, Step 3.3).`,
    )
  }
}

// One block for the maker spawn (K11a.8 m-3): the task and the stage are looked up once and passed down; the order is the code's — deny first, record only an allowed spawn.
if (agent === 'stage-implement') {
  const task = state.tasks.find((candidate) => candidate.current)
  const prompt = toolInput.prompt ?? ''
  const session = typeof input.session_id === 'string' && input.session_id ? input.session_id : null
  // K11b.1 (B2): the `pending` line of this spawn goes first, before any check: a hook killed from here on leaves a spawn with no `done` line, and the commit rule fails open
  spawned = session ? await startSpawn(state, task, session, input.cwd ?? process.cwd()) : null
  const block = task && openForceBlock(task.stages)
  if (block && (block.date ? block.date >= CONFIRM_SINCE : block.unreadDate) && !CONFIRMED_LINE.test(block.body)) {
    deny(
      'agent-guard/no-confirmed',
      `stage-pipeline: block "${block.heading.replace(/^## /, '')}" of task ${task.ticket} has no \`Confirmed:\` line (stage-force, Step 0). ` +
        'The interview is done — add `Confirmed: <date> — interview answers` to the block (if there were no questions, `— no questions`) and launch again. ' +
        'Do not ask the user for a separate confirmation: the answers to the batch are the start of the run.',
    )
  }
  // M-2: the one stage parser (plan-check's `stageForSpawn`, the Russian form included) is read once, for the plan check and for the snapshot alike
  const stage = task ? await stageOfSpawn(task, prompt) : null
  const verdict = task && !task.unreadable ? await planVerdict(state, task, stage, prompt) : null
  if (verdict) deny('agent-guard/plan-problems', verdict)
  // K11.1 (VT-1 stage 11): the spawn is allowed — the tree is recorded for the stop hook to compare the hand-back with. A denied spawn records nothing.
  if (session) await recordSpawn(state, task, stage, session, input.cwd ?? process.cwd())
}
process.exit(0)

/** The first line of the spawn (maker.mjs, `startSpawn`): `{ spawn, close }` — `close` writes the `denied` line, null when none was written. Never throws. */
async function startSpawn(state, task, session, cwd) {
  try {
    const { startSpawn: start } = await import('../maker.mjs')
    const dataDir = pluginDataDir()
    const spawn = start(dataDir, { session, cwd, ticket: task?.ticket ?? null, config: state.config ?? null })
    const { denySpawn } = await import('../maker.mjs')
    return spawn ? { spawn, close: () => denySpawn(dataDir, { spawn, session, ticket: task?.ticket ?? null }) } : null
  } catch {
    return null
  }
}

/** The spawn snapshot (maker.mjs, `takeSnapshot`): never throws and never denies. The import is lazy, like plan-check's. */
async function recordSpawn(state, task, stage, session, cwd) {
  try {
    const { takeSnapshot } = await import('../maker.mjs')
    // the config's own words for "no command" (markers.mjs `NO_GATE_COMMAND`, the Russian one included), a trailing comment after them too; `off` is the old spelling
    const command = (/^[ \t]*-[ \t]*type_check:[ \t]*[`*]*([^\n]*)$/im.exec(state.config ?? '')?.[1] ?? '').trim()
    const typeCheck = Boolean(command) && !NO_GATE_COMMAND.test(command) && !/^off(?![a-z])/i.test(command)
    takeSnapshot(pluginDataDir(), { session, cwd, ticket: task?.ticket ?? null, stage, taskDir: task?.dir ?? null, typeCheck, config: state.config ?? null, spawn: spawned?.spawn ?? null })
  } catch {
    // no snapshot: the stop hook does not judge this maker
  }
}

/** The stage of a spawn prompt, by the plan's own stage ids (plan-check's `stageForSpawn`); null when none, or when the plan cannot be read. */
async function stageOfSpawn(task, prompt) {
  try {
    const { stageForSpawn } = await import('../plan-check.mjs')
    return stageForSpawn(task.stages, prompt)
  } catch {
    return null
  }
}

/**
 * plan-check at the spawn of `stage-implement` in implement mode (VT-5 stage 10, K10.3): the stage's problems plus the Force block items.
 * The stage comes from the prompt (`Stage N`, `stage number: N`), else the first stage that is not done. Fix-mode spawns are not checked,
 * and a crash or an unreadable file never denies. The import is lazy: pro-review spawns do not pay for it.
 */
async function planVerdict(state, task, stage, prompt) {
  try {
    if (stage === null || /(?:\bmode|режим)\s*(?::\s*)?\**fix\b|\bfix\s+mode\b/i.test(prompt)) return null
    const { checkPlan, format } = await import('../plan-check.mjs')
    // M-1: the worktree where the code is first, then the repo that holds the config (a linked worktree usually has no config of its own)
    const result = checkPlan(task.stages, { taskDir: task.dir, dataDir: pluginDataDir(), roots: [...new Set([state.worktree, state.root].filter(Boolean))], config: state.config, stage })
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
  // K11b.1: a spawn that was denied never counts as an unfinished one
  if (spawned) spawned.close()
  const task = state.tasks.find((candidate) => candidate.current)
  denyTool(rule, reason, { input, task: task?.ticket, repo: state.worktree })
}
