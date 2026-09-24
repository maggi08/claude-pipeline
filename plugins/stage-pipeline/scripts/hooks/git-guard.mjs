import { readHookInput, readPipelineState } from './pipeline-state.mjs'

/**
 * В обычном режиме пайплайна индекс и коммит принадлежат пользователю: /stage-check
 * выдаёт текст коммита, а не выполняет его. Прозой это правило не держалось
 * (из 40 отклонённых вызовов по одной задаче больше половины — git add), а профиль
 * разрешений отдаёт `git *` целиком, потому что /stage-force коммитит сам.
 * Хук возвращает вопрос пользователю ровно в этой щели: репо с пайплайном, этап
 * в работе, и у задачи этого этапа нет блока «Force-прогон» — в force агент коммитит сам.
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
      permissionDecision: 'ask',
      permissionDecisionReason:
        `stage-pipeline: этап ${active[0].ticket} в работе, обычный режим — коммит этапа делает пользователь. ` +
        'Если он не просил закоммитить явно, покажи git status и готовое сообщение коммита вместо команды.',
    },
  }),
)
