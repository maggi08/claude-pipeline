import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitInvocations } from './git-command.mjs'
import { readHookInput, readPipelineState } from './pipeline-state.mjs'

/**
 * В обычном режиме пайплайна индекс и коммит принадлежат пользователю: /stage-check
 * выдаёт текст коммита, а не выполняет его. Прозой это правило не держалось
 * (из 40 отклонённых вызовов по одной задаче больше половины — git add), а профиль
 * разрешений отдаёт `git *` целиком, потому что /stage-force коммитит сам.
 * Хук закрывает ровно эту щель: ветка, к которой привязана задача с этапом в работе, и у этой
 * задачи нет открытого блока «Force-прогон». Там `git add`/`git commit` отклоняются, а причина
 * уходит агенту — он выдаёт готовое сообщение коммита, коммитит пользователь сам.
 * Другие ветки хук не трогает: параллельная задача в соседнем worktree, хотфикс, брошенная
 * задача с забытым статусом — не повод блокировать коммит здесь.
 *
 * В force агент коммитит без вопросов — и именно там планку качества опустить некому помешать:
 * код пишет модель, проверяют модели, человек читает только итог. Поэтому force-коммит проходит
 * через floor-guard: заглушённый чекер, ослабленный тест или заглушка в дифе отклоняют коммит.
 */
const input = await readHookInput()
const command = input.tool_input?.command ?? ''
if (!/\bgit\b/.test(command) || !/\b(add|commit)\b/.test(command)) process.exit(0)

const cwd = input.cwd ?? process.cwd()
for (const { subcommand, dir } of gitInvocations(command, cwd)) {
  const state = readPipelineState(dir)
  const task = state?.tasks.find((candidate) => candidate.current && candidate.inProgress)
  if (!task) continue

  if (!task.forceActive) {
    deny(
      `stage-pipeline: на ветке ${state.branch} этап задачи ${task.ticket} в работе, обычный режим — git add и git commit делает пользователь сам, в своём терминале. ` +
        'Не повторяй команду: покажи git status и готовое сообщение коммита (/stage-check, Шаг 4.4). Автокоммит — только в /stage-force.',
    )
  }
  if (subcommand !== 'commit') continue

  // Диф против HEAD — надмножество коммита: `git add x && git commit` в одной команде ещё не обновил индекс.
  const guard = join(dirname(fileURLToPath(import.meta.url)), '..', 'floor-guard.mjs')
  const run = spawnSync(process.execPath, [guard], { cwd: state.worktree, encoding: 'utf8', timeout: 12_000 })
  if (run.status === 1) {
    deny(
      `stage-pipeline: floor-guard нашёл в дифе этапа ходы, которые опускают планку качества — коммит отклонён.\n${run.stdout.trim()}\n` +
        'Почини как находку fix-loop (не подавлением). Если исключение действительно оправдано — строка `floor-ok: <причина>` ' +
        'на месте нарушения и пункт в «⚠ Ожидают подтверждения пользователя» STAGES.md; @ts-ignore и секреты исключением не бывают.',
    )
  }
  // «Не смог посмотреть» коммит не блокирует — то же прогонит /stage-check, Шаг 1, — но и не проходит молча.
  if (run.status !== 0) {
    const why = run.error?.message ?? (run.stderr.trim() || `код ${run.status}`)
    process.stdout.write(JSON.stringify({ systemMessage: `stage-pipeline: floor-guard не смог проверить force-коммит (${why}) — коммит пропущен без проверки.` }))
    process.exit(0)
  }
}
process.exit(0)

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  )
  process.exit(0)
}
