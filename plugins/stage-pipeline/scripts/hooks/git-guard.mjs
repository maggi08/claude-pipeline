import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readHookInput, readPipelineState } from './pipeline-state.mjs'

/**
 * В обычном режиме пайплайна индекс и коммит принадлежат пользователю: /stage-check
 * выдаёт текст коммита, а не выполняет его. Прозой это правило не держалось
 * (из 40 отклонённых вызовов по одной задаче больше половины — git add), а профиль
 * разрешений отдаёт `git *` целиком, потому что /stage-force коммитит сам.
 * Хук закрывает ровно эту щель: репо с пайплайном, этап в работе, у задачи нет блока
 * «Force-прогон». Там `git add`/`git commit` отклоняются, а причина уходит агенту — он выдаёт
 * готовое сообщение коммита, коммитит пользователь сам.
 *
 * В force агент коммитит без вопросов — и именно там планку качества опустить некому помешать:
 * код пишет модель, проверяют модели, человек читает только итог. Поэтому force-коммит проходит
 * через floor-guard: заглушённый чекер, ослабленный тест или заглушка в дифе отклоняют коммит.
 */
const input = await readHookInput()
const command = input.tool_input?.command ?? ''

if (!/\bgit\s+(?:-C\s+\S+\s+)?(?:add|commit)\b/.test(command)) process.exit(0)

const cwd = input.cwd ?? process.cwd()
const state = readPipelineState(cwd)
if (!state) process.exit(0)

const active = state.tasks.filter((task) => task.inProgress)
if (!active.length) process.exit(0)

if (!active.some((task) => task.forceActive)) {
  deny(
    `stage-pipeline: этап ${active[0].ticket} в работе, обычный режим — git add и git commit делает пользователь сам. ` +
      'Не повторяй команду: покажи git status и готовое сообщение коммита (/stage-check, Шаг 4.4). Автокоммит — только в /stage-force.',
  )
}

if (!/\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(command)) process.exit(0)

// Диф против HEAD — надмножество коммита: `git add x && git commit` в одной команде ещё не обновил индекс.
const guard = join(dirname(fileURLToPath(import.meta.url)), '..', 'floor-guard.mjs')
const run = spawnSync('node', [guard], { cwd: state.root, encoding: 'utf8', timeout: 12_000 })
// Код 2 (guard не смог посмотреть) коммит не блокирует: то же самое прогонит /stage-check, Шаг 1, с выводом в отчёт.
if (run.status === 1) {
  deny(
    `stage-pipeline: floor-guard нашёл в дифе этапа ходы, которые опускают планку качества — коммит отклонён.\n${run.stdout.trim()}\n` +
      'Почини как находку fix-loop (не подавлением). Если исключение действительно оправдано — строка `floor-ok: <причина>` ' +
      'на месте нарушения и пункт в «⚠ Ожидают подтверждения пользователя» STAGES.md; @ts-ignore и секреты исключением не бывают.',
  )
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  )
  process.exit(0)
}
