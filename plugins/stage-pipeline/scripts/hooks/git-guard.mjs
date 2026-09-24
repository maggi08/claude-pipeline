import { readHookInput, readPipelineState } from './pipeline-state.mjs'

/**
 * В обычном режиме пайплайна индекс и коммит принадлежат пользователю: /stage-check
 * выдаёт текст коммита, а не выполняет его. Прозой это правило не держалось
 * (из 40 отклонённых вызовов по одной задаче больше половины — git add), а профиль
 * разрешений отдаёт `git *` целиком, потому что /stage-force коммитит сам.
 * Хук закрывает ровно эту щель: репо с пайплайном, этап в работе, у задачи нет блока
 * «Force-прогон». Там `git add`/`git commit` отклоняются, а причина уходит агенту — он выдаёт
 * готовое сообщение коммита, коммитит пользователь сам. В force агент коммитит без вопросов.
 */
const input = await readHookInput()
const command = input.tool_input?.command ?? ''

if (!/\bgit\s+(?:-C\s+\S+\s+)?(?:add|commit)\b/.test(command)) process.exit(0)

const state = readPipelineState(input.cwd ?? process.cwd())
if (!state) process.exit(0)

const active = state.tasks.filter((task) => task.inProgress)
if (!active.length || active.some((task) => task.forceActive)) process.exit(0)

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `stage-pipeline: этап ${active[0].ticket} в работе, обычный режим — git add и git commit делает пользователь сам. ` +
        'Не повторяй команду: покажи git status и готовое сообщение коммита (/stage-check, Шаг 4.4). Автокоммит — только в /stage-force.',
    },
  }),
)
