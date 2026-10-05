import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { baselineInfo, fingerprint, forceCloseViolations, lastForceBlock, newJournalViolations, reportNames, reportViolations } from '../journal-check.mjs'
import { runDigest } from '../run-digest.mjs'
import { pluginDataDir, readHookInput, readPipelineState } from './pipeline-state.mjs'

/**
 * /stage-check требует, чтобы исход критерия называл того, кто его проверил, PASS чекера нёс замер,
 * а дизайн-чекер пропускался только на logic-only. На живых прогонах это держалось через раз:
 * «✅ pro-review по коду» у критериев devtools-verify, «4.5 PASS» без значения, proto-compare
 * «skip: MCP-Chrome занят». Хук смотрит на правку журнала или отчёта чекера сразу после неё
 * и возвращает нарушения агенту — тем же ходом, пока этап ещё открыт.
 *
 * 0.14 — итог находок (references/checker-report.md). Находка чекера закрывается исправлением,
 * доказанной ложностью или блокером, а не строкой «оставляю» или «в Ожидают подтверждения»: в трёх
 * разобранных задачах так ушла большая часть того, что пользователь потом чинил сам. Отчёт проверяется
 * при записи (сводка, запрещённые итоги, геометрия у devtools-verify), журнал — при отметке чекера
 * и закрытии force-прогона. При закрытии прогона в контекст кладётся сводка непроверенного — она идёт
 * в итоговое сообщение целиком, а не на выбор оркестратора.
 *
 * Только новое: строки журнала, которых не было в снимке, и отчёты, записанные после него
 * (снимок — в каталоге данных плагина, его делает session-start). Старые этапы и закрытые задачи
 * никто не обязан переписывать. Новое нарушение напоминает о себе, пока его не исправят.
 */
const input = await readHookInput()
const tool = input.tool_name ?? ''
const toolInput = input.tool_input ?? {}
const target = tool === 'Bash' ? (toolInput.command ?? '') : (toolInput.file_path ?? '')
if (!/STAGES|checks[/\\]/.test(target)) process.exit(0)

const cwd = input.cwd ?? process.cwd()
const state = readPipelineState(cwd)
if (!state) process.exit(0)

// Каталог задач бывает за симлинком (`.claude/tasks` → `~/.claude/team-tasks`): сравниваются реальные пути.
const real = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
const inside = (dir, path) => path === dir || path.startsWith(dir + sep)
const filePath = tool === 'Bash' ? null : real(resolve(cwd, target))
const tasks = state.tasks
  .map((task) => ({ ...task, dir: real(task.dir) }))
  .filter((task) => (filePath ? inside(task.dir, filePath) : task.current || target.includes(task.dir) || target.includes(`/${task.ticket}/`)))
if (!tasks.length) process.exit(0)

const messages = []
const context = []
for (const task of tasks) {
  const journal = newJournalViolations(pluginDataDir(), task.dir)
  // Отчёт — тот, что записан этой правкой: Write/Edit — его путь, Bash — отчёты, изменённые только что.
  const checks = join(task.dir, 'checks')
  const written = filePath
    ? inside(checks, filePath) && filePath.endsWith('.md')
      ? [filePath]
      : []
    : reportNames(task.dir)
        .map((name) => join(checks, name))
        .filter((path) => Date.now() - statSync(path).mtimeMs < 60_000)
  const reports = written.flatMap(reportViolations)
  const closing = forceCloseViolations(pluginDataDir(), task.dir)
  for (const violation of [...journal, ...reports, ...closing]) messages.push(`- ${task.ticket}: ${violation.message}`)
  if (!closing.length) {
    const digest = closedDigest(task)
    if (digest) context.push(digest)
  }
}

if (messages.length) {
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason:
        `stage-pipeline: правка журнала задачи нарушает правила закрытия критериев и находок:\n${[...new Set(messages)].join('\n')}\n` +
        'Исправь журнал или отчёт, прогони чекер или допиши «## Итог находок» (references/checker-report.md), прежде чем идти дальше. Сама правка уже записана, хук её не отменял.',
    }),
  )
  process.exit(0)
}
if (context.length) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context.join('\n\n') } }))
}
process.exit(0)

/**
 * Сводка непроверенного — один раз на каждое закрытие блока «Force-прогон», записанное после снимка.
 * В итоговое сообщение она идёт целиком: в одной задаче сводка выбрала «тексты kk/en, заголовок вкладки»,
 * а под этим ярлыком лежали два дефекта, которые пользователь нашёл в работе с продуктом.
 */
function closedDigest(task) {
  const stagesPath = join(task.dir, 'STAGES.md')
  if (!existsSync(stagesPath)) return null
  const block = lastForceBlock(readFileSync(stagesPath, 'utf8'))
  if (!block || !/заверш/i.test(block.heading)) return null
  const { lines } = baselineInfo(pluginDataDir(), task.dir)
  const shown = join(pluginDataDir(), 'digest-shown.json')
  let seen = {}
  try {
    seen = JSON.parse(readFileSync(shown, 'utf8'))
  } catch {
    // первый показ
  }
  const key = `${real(task.dir)}::${block.heading}`
  // Блок, закрытый до снимка, — старый прогон: его сводку уже видели.
  if (seen[key] || lines.has(fingerprint(block.heading))) return null
  const digest = runDigest(task.dir, pluginDataDir())
  try {
    mkdirSync(pluginDataDir(), { recursive: true })
    writeFileSync(shown, JSON.stringify({ ...seen, [key]: new Date().toISOString() }))
  } catch {
    // не записался — сводка придёт ещё раз, это безопасно
  }
  return (
    `stage-pipeline: force-прогон ${task.ticket} закрыт. Ниже — сводка из журнала и отчётов. Вставь её в итоговое сообщение целиком, ` +
    `не пересказывая и не выбирая: что проверять первым, решает пользователь.\n\n${digest}`
  )
}
