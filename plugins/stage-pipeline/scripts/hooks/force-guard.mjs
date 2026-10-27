import { denyTool } from './firing.mjs'
import { askMatch, askRules, nameKill } from './permission-rules.mjs'
import { readHookInput, readPipelineState } from './pipeline-state.mjs'

/**
 * In a force run the user is not at the screen, and a call that waits for confirmation costs the run as
 * long as the user is not looking at the terminal. In one run (2026-10-03) two `pkill` calls in subagents
 * stood for 22 and 37 minutes: `Bash(pkill *)` is in the ask list of the permission profile, and ask beats
 * allow — even in auto mode. The whole run waited, although the agents had started both processes
 * themselves and could have stopped them by PID.
 *
 * The hook turns such a stop into a denial with an explanation in the same turn:
 * - `pkill`/`killall` — always: they kill by name, including processes that are not yours. Your own
 *   process is stopped by PID;
 * - a subcommand under `ask` in the user's or project's settings (`git push`, `reset --hard`, `gh`…) — force
 *   either does not do it at all (stage-force, Step 3), or the user does it: the command goes into the run's blockers.
 * Outside force and outside a repo with the pipeline the hook stays silent: the user is nearby there, and a
 * question is a normal part of the work.
 * The task is only the current branch's, as in git-guard.
 */
const input = await readHookInput()
const command = input.tool_input?.command ?? ''
if (!command) process.exit(0)

const cwd = input.cwd ?? process.cwd()
const killer = nameKill(command)
const asked = killer ? null : askMatch(command, askRules(process.env.CLAUDE_PROJECT_DIR ?? cwd))
if (!killer && !asked) process.exit(0)

const state = readPipelineState(cwd)
const task = state?.tasks.find((candidate) => candidate.current)
if (!task?.forceActive) process.exit(0)

if (killer) {
  deny(
    'force-guard/kill-by-name',
    `stage-pipeline: force run ${task.ticket} — \`${killer}\` kills processes by name, including ones that are not yours (the user's dev server, a neighbouring session), ` +
      'and is in ask: the run would wait for confirmation until the user comes back. Stop only what you started yourself, and by PID: ' +
      'at launch `<command> > <log> 2>&1 & echo $!`, at the end `kill <PID>`; a background Bash task by its id. If you did not save the PID — ' +
      '`lsof -ti :<port>` only for a port you took yourself, and `kill` by number. Do not touch a process that you did not start — name it in the summary.',
  )
}
deny(
  'force-guard/ask-rule',
  `stage-pipeline: force run ${task.ticket} — \`${asked.command}\` falls under the ask rule \`${asked.rule}\` (${asked.source}): ` +
    'the call would wait for confirmation, and in force the user is not at the screen. Do not look for a way around it by doing the same action with another command. ' +
    'Skip an action that force does not do (push, PR, reset --hard, clean — /stage-force, Step 3). If a criterion cannot be closed without it — ' +
    'record it as a blocker: the orchestrator as a line in `Blockers:` of the Force run block, a subagent in the `Not done / blocker:` line of its summary (the command and why), ' +
    'and carry on with what does not depend on it (/stage-force, Step 2).',
)

function deny(rule, reason) {
  denyTool(rule, reason, { input, task: task.ticket, repo: state.worktree })
}
