import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planArchive } from '../archive-stages.mjs'
import { readHookInput, readPipelineState, STALE_DAYS } from './pipeline-state.mjs'

/**
 * Каждая сессия пайплайна начинается с «прочитай STAGES.md» — и каждый раз с вопроса,
 * какой именно. Хук кладёт в контекст строку статуса: задача текущей ветки первой, затем
 * до двух открытых задач, которые трогали недавно, а не сам файл — читать этап точечно
 * по-прежнему работа скилла. Старые задачи в выводе не появляются и ничего не требуют.
 */
const input = await readHookInput()
const state = readPipelineState(input.cwd ?? process.cwd())
if (!state) process.exit(0)

const recent = (task) => Date.now() - task.mtime < STALE_DAYS * 24 * 60 * 60 * 1000
const current = state.tasks.filter((task) => task.current)
const others = state.tasks.filter((task) => !task.current && task.open && recent(task)).slice(0, 2)
if (!current.length && !others.length) process.exit(0)

// Порог — тот же, что в retro.mjs: выше него чтение файла заметно в расходе каждой сессии.
// Напоминание — только для задачи этой ветки и только если архивация реально уменьшит файл.
const STAGES_BUDGET_KB = 40
const archiveScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'archive-stages.mjs')

const line = (task, mark) => {
  const mode = task.forceActive ? ' [force-прогон]' : ''
  const path = relative(state.root, task.stagesPath)
  let size = ''
  if (mark && task.sizeKb > STAGES_BUDGET_KB) {
    const { sourceBytes, resultBytes } = planArchive(readFileSync(task.stagesPath, 'utf8'))
    if (sourceBytes - resultBytes > 5 * 1024) {
      size = ` — ${task.sizeKb} KB, свернуть закрытые этапы: node "${archiveScript}" ${path} --apply`
    }
  }
  return `- ${task.ticket}${mark}${mode}: ${task.status ?? 'статус не указан'} — ${path}${size}`
}

const lines = [...current.map((task) => line(task, ` (ветка ${state.branch})`)), ...others.map((task) => line(task, ''))]
process.stdout.write(
  `stage-pipeline — задачи в этом репо:\n${lines.join('\n')}\n` +
    'Продолжая задачу, читай её STAGES.md точечно (текущий этап), а не целиком.\n',
)
