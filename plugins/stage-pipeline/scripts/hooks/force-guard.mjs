import { askMatch, askRules, nameKill } from './permission-rules.mjs'
import { readHookInput, readPipelineState } from './pipeline-state.mjs'

/**
 * В force-прогоне пользователя у экрана нет, и вызов, который ждёт подтверждения, стоит прогону столько,
 * сколько пользователь не смотрит в терминал. В z8wrft82eq (03.10.2026) два `pkill` в субагентах простояли
 * 22 и 37 минут: `Bash(pkill *)` стоит в ask профиля разрешений, а ask сильнее allow — даже в auto mode.
 * Весь прогон ждал, хотя оба процесса агенты подняли сами и могли погасить по PID.
 *
 * Хук превращает такую остановку в отказ с объяснением тем же ходом:
 * - `pkill`/`killall` — всегда: снимают по имени, в том числе чужое. Свой процесс гасится по PID;
 * - подкоманда под `ask` в settings пользователя или проекта (`git push`, `reset --hard`, `gh`…) — force её
 *   либо не делает вовсе (stage-force, Шаг 3), либо её делает пользователь: команда уходит в блокеры прогона.
 * Вне force и вне репо с пайплайном хук молчит: там пользователь рядом, и вопрос — нормальная часть работы.
 * Задача — только текущей ветки, как у git-guard.
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
    `stage-pipeline: force-прогон ${task.ticket} — \`${killer}\` снимает процессы по имени, в том числе чужие (dev-сервер пользователя, соседняя сессия), ` +
      'и стоит в ask: прогон ждал бы подтверждения, пока пользователь не вернётся. Гаси только то, что запустил сам, и по PID: ' +
      'при запуске `<команда> > <лог> 2>&1 & echo $!`, в конце `kill <PID>`; фоновую задачу Bash — по её id. PID не сохранил — ' +
      '`lsof -ti :<порт>` только для порта, который ты сам занял, и `kill` по номеру. Процесс, который запустил не ты, не трогай — назови его в сводке.',
  )
}
deny(
  `stage-pipeline: force-прогон ${task.ticket} — \`${asked.command}\` попадает под ask-правило \`${asked.rule}\` (${asked.source}): ` +
    'вызов ждал бы подтверждения, а пользователь в force у экрана не сидит. Не ищи обход тем же действием другой командой. ' +
    'Действие, которого force не делает (push, PR, reset --hard, clean — /stage-force, Шаг 3), пропусти. Без него не закрыть критерий — ' +
    'запиши блокером: оркестратор — строкой в «Блокеры:» блока Force-прогона, субагент — в `Блокер:` сводки (команда и зачем), ' +
    'и продолжай то, что от него не зависит (/stage-force, Шаг 2).',
)

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  )
  process.exit(0)
}
