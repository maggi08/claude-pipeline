import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readHookInput, readPipelineState } from './pipeline-state.mjs'

/**
 * Каждая сессия пайплайна начинается с «прочитай STAGES.md» — и каждый раз с вопроса,
 * какой именно. Хук кладёт в контекст строку статуса открытых задач (до трёх свежих),
 * а не сам файл: читать этап точечно по-прежнему работа скилла.
 */
const input = await readHookInput()
const state = readPipelineState(input.cwd ?? process.cwd())
if (!state) process.exit(0)

const open = state.tasks.filter((task) => task.open).slice(0, 3)
if (!open.length) process.exit(0)

// Порог — тот же, что в retro.mjs: выше него чтение файла заметно в расходе каждой сессии.
const STAGES_BUDGET_KB = 40
const archiveScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'archive-stages.mjs')

const lines = open.map((task) => {
  const mode = task.forceActive ? ' [force-прогон]' : ''
  const path = relative(state.root, task.stagesPath)
  const size =
    task.sizeKb > STAGES_BUDGET_KB
      ? ` — ${task.sizeKb} KB, сначала свернуть закрытые этапы: node "${archiveScript}" ${path} --apply`
      : ''
  return `- ${task.ticket}${mode}: ${task.status ?? 'статус не указан'} — ${path}${size}`
})

process.stdout.write(
  `stage-pipeline — открытые задачи в этом репо:\n${lines.join('\n')}\n` +
    'Продолжая задачу, читай её STAGES.md точечно (текущий этап), а не целиком.\n',
)
