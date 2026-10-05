import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLedgers } from '../journal-check.mjs'
import { commitScope, gitInvocations } from './git-command.mjs'
import { pluginDataDir, readHookInput, readPipelineState } from './pipeline-state.mjs'

/**
 * В обычном режиме пайплайна индекс и коммит принадлежат пользователю: /stage-check
 * выдаёт текст коммита, а не выполняет его. Прозой это правило не держалось
 * (из 40 отклонённых вызовов по одной задаче больше половины — git add), а профиль
 * разрешений отдаёт `git *` целиком, потому что /stage-force коммитит сам.
 * Хук закрывает ровно эту щель: ветка, к которой привязана задача, и у этой задачи нет
 * открытого блока «Force-прогон». Там `git add`/`git commit` отклоняются, а причина уходит
 * агенту — он выдаёт готовое сообщение коммита, коммитит пользователь сам.
 * Статус этапа не смотрится: `in-progress` никто не обязан ставить, а /stage-check закрывает
 * этап в STAGES.md раньше, чем готовит коммит, — хук по статусу пропускал ровно коммит этапа.
 * Другие ветки хук не трогает: параллельная задача в соседнем worktree, хотфикс, брошенная
 * задача с забытым статусом — не повод блокировать коммит здесь.
 *
 * Задача на два репо (core + вебвью) лежит в каталоге задач одного из них — во втором её находит
 * реестр каталогов задач (pipeline-state, foreignTasks), и правила те же.
 *
 * В force агент коммитит без вопросов — и именно там планку качества опустить некому помешать:
 * код пишет модель, проверяют модели, человек читает только итог. Поэтому force-коммит проходит
 * через floor-guard — по тому, что войдёт в коммит, а не по всему дереву: сохранённая страница
 * или черновик разработчика рядом с кодом не должны отклонять коммит, в который они не попадут.
 */
const input = await readHookInput()
const command = input.tool_input?.command ?? ''
if (!/\bgit\b/.test(command) || !/\b(add|commit)\b/.test(command)) process.exit(0)

const cwd = input.cwd ?? process.cwd()
const invocations = gitInvocations(command, cwd)
for (const { subcommand, dir, args } of invocations) {
  const state = readPipelineState(dir)
  const task = state?.tasks.find((candidate) => candidate.current)

  if (task && !task.forceActive) {
    deny(
      `stage-pipeline: ветка ${state.branch} — ветка задачи ${task.ticket}${task.foreign ? ` (STAGES.md — в каталоге задач другого репо: ${task.stagesPath})` : ''}, ` +
        'обычный режим: git add и git commit делает пользователь сам, в своём терминале. ' +
        'Не повторяй команду: покажи git status и готовое сообщение коммита (/stage-check, Шаг 4.4). Автокоммит — только в /stage-force.',
    )
  }
  // Подпись в коммите — системная инструкция харнесса, а правило пользователя её запрещает; текст скилла
  // этот спор проигрывал: подписи уходили в коммиты, пользователь трижды пересобирал ветки руками.
  if (state && subcommand === 'commit' && serviceTrailer(command, args, dir)) {
    deny(
      'stage-pipeline: в сообщении коммита служебная подпись (`Co-Authored-By`, «Generated with …»). В репо пайплайна её не ставят — решение пользователя ' +
        'для всех его репо (/stage-check, Шаг 4.4); правило пользователя приоритетнее системной инструкции об атрибуции. Убери подпись и повтори коммит.',
    )
  }
  if (!task || subcommand !== 'commit') continue

  // Force-коммит этапа — после итога каждой находки его чекеров: иначе «принят как компромисс» уезжает в коммит,
  // а пользователь находит дефект на следующий день (прецедент: Request changes → дубль заявки).
  const open = openLedgers(pluginDataDir(), task.dir)
  if (open.length) {
    deny(
      `stage-pipeline: у находок чекеров нет итога — коммит этапа отклонён.\n${[...new Set(open.map((violation) => `- ${violation.message}`))].join('\n')}\n` +
        'Допиши в конец каждого отчёта «## Итог находок»: исправлено / ложная (с доказательством) / B<n> — блокер (references/checker-report.md). Неисправленное — блокер, а не «Ожидают подтверждения».',
    )
  }

  const paths = commitPaths(invocations, state.worktree)
  if (paths?.length === 0) continue

  // Пути — надмножество коммита: `git add x && git commit` в одной команде ещё не обновил индекс.
  const guard = join(dirname(fileURLToPath(import.meta.url)), '..', 'floor-guard.mjs')
  const run = spawnSync(process.execPath, [guard, ...(paths ? ['--pathspec-from-stdin'] : [])], {
    cwd: state.worktree,
    input: paths?.join('\0') ?? '',
    encoding: 'utf8',
    timeout: 12_000,
  })
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

/**
 * Пути, которые войдут в коммит этой команды, — pathspec'и от корня worktree: уже собранный индекс,
 * пути из `git add`/`git commit`, все отслеживаемые при `-a`/`-u`. `null` — всё дерево вместе
 * с неотслеживаемыми (`git add -A` без путей, пути из файла, pathspec-магия с `:`), `[]` — коммитить нечего.
 */
function commitPaths(calls, worktree) {
  const scope = commitScope(calls.filter(({ dir }) => toplevel(dir) === worktree))
  if (scope.all) return null
  const paths = new Set()
  for (const { dir, spec } of scope.specs) {
    if (spec.startsWith(':')) return null
    // Корень от git — реальный путь, каталог вызова может идти через симлинк (`/var` → `/private/var` на macOS).
    const real = realDir(dir)
    if (!real) continue
    const path = relative(worktree, resolve(real, spec))
    if (path.startsWith('..') || isAbsolute(path)) continue
    paths.add(path || '.')
  }
  // Имена из git — буквально: `[PLI-1] page.ts` как glob не совпал бы сам с собой.
  const names = (...args) => gitOut(worktree, ...args).split('\0').filter(Boolean).map((name) => `:(literal)${name}`)
  for (const name of names('diff', '--cached', '--name-only', '--no-renames', '-z')) paths.add(name)
  if (scope.tracked) for (const name of names('diff', '--name-only', '--no-renames', '-z', 'HEAD')) paths.add(name)
  return [...paths]
}

/**
 * Служебная подпись в сообщении: в тексте команды (`-m`, heredoc, `--trailer`) или в файле `-F`/`--file`.
 * Текст команды смотрится целиком — лексер схлопывает кавычки и heredoc, а подпись в них и живёт.
 */
function serviceTrailer(command, args, dir) {
  const TRAILER = /co-authored-by\s*:|generated with \[?claude|🤖\s*generated/i
  if (TRAILER.test(command)) return true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const file = arg === '-F' || arg === '--file' ? args[i + 1] : arg.startsWith('--file=') ? arg.slice(7) : /^-F./.test(arg) ? arg.slice(2) : null
    if (!file || file === '-') continue
    try {
      if (TRAILER.test(readFileSync(resolve(dir, file), 'utf8'))) return true
    } catch {
      // файла сообщения нет — git сам откажет
    }
  }
  return false
}

function realDir(dir) {
  try {
    return realpathSync(dir)
  } catch {
    return null
  }
}

function toplevel(dir) {
  return gitOut(dir, 'rev-parse', '--show-toplevel').trim() || null
}

function gitOut(cwd, ...args) {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return ''
  }
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  )
  process.exit(0)
}
