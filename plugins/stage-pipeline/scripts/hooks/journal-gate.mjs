import { realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { newJournalViolations, reportViolation, reportNames } from '../journal-check.mjs'
import { pluginDataDir, readHookInput, readPipelineState } from './pipeline-state.mjs'

/**
 * /stage-check требует, чтобы исход критерия называл того, кто его проверил, PASS чекера нёс замер,
 * а дизайн-чекер пропускался только на logic-only. На живых прогонах это держалось через раз:
 * «✅ pro-review по коду» у критериев devtools-verify, «4.5 PASS» без значения, proto-compare
 * «skip: MCP-Chrome занят». Хук смотрит на правку журнала или отчёта чекера сразу после неё
 * и возвращает нарушения агенту — тем же ходом, пока этап ещё открыт.
 *
 * Только новые строки: всё, что было в журнале, когда плагин впервые увидел задачу (снимок
 * в каталоге данных плагина, его делает session-start), не проверяется — закрытые задачи и
 * старые этапы никто не обязан переписывать. Новое нарушение напоминает о себе на каждой
 * следующей правке, пока его не исправят.
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
  const reports = written.map(reportViolation).filter(Boolean)
  for (const violation of [...journal, ...reports]) messages.push(`- ${task.ticket}: ${violation.message}`)
}
if (!messages.length) process.exit(0)

process.stdout.write(
  JSON.stringify({
    decision: 'block',
    reason:
      `stage-pipeline: правка журнала задачи нарушает правила закрытия критериев:\n${messages.join('\n')}\n` +
      'Исправь исход в STAGES.md или прогони чекер, прежде чем идти дальше. Сама правка уже записана, хук её не отменял.',
  }),
)
process.exit(0)
