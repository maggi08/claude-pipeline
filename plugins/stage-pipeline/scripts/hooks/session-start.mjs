import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planArchive } from '../archive-stages.mjs'
import { ensureBaseline } from '../journal-check.mjs'
import { pluginDataDir, readHookInput, readPipelineState, registerTaskDir, STALE_DAYS, unjournaledCommits } from './pipeline-state.mjs'

/**
 * Каждая сессия пайплайна начинается с «прочитай STAGES.md» — и каждый раз с вопроса,
 * какой именно. Хук кладёт в контекст строку статуса: задача текущей ветки первой, затем
 * до двух открытых задач, которые трогали недавно, а не сам файл — читать этап точечно
 * по-прежнему работа скилла. Старые задачи в выводе не появляются и ничего не требуют.
 *
 * Попутно: каталог задач этого репо попадает в реестр (по нему соседний репо находит задачу
 * на два репо), для задачи текущей ветки снимается базовый снимок журнала (journal-gate
 * проверяет только то, что появится после него), а коммиты ветки, которых журнал не знает, —
 * работа после закрытия force мимо чекеров — называются строкой.
 */
const input = await readHookInput()
const state = readPipelineState(input.cwd ?? process.cwd())
if (!state) process.exit(0)
registerTaskDir(state.taskDir)

const recent = (task) => Date.now() - task.mtime < STALE_DAYS * 24 * 60 * 60 * 1000
const current = state.tasks.filter((task) => task.current)
const others = state.tasks.filter((task) => !task.current && task.open && recent(task)).slice(0, 2)
for (const task of current) ensureBaseline(pluginDataDir(), task.dir)
if (!current.length && !others.length) process.exit(0)

// Порог — тот же, что в retro.mjs: выше него чтение файла заметно в расходе каждой сессии.
// Напоминание — только для задачи этой ветки и только если архивация реально уменьшит файл.
const STAGES_BUDGET_KB = 40
const archiveScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'archive-stages.mjs')

const line = (task, mark) => {
  const mode = task.forceActive ? ' [force-прогон]' : ''
  const path = task.foreign ? task.stagesPath : relative(state.root, task.stagesPath)
  let size = ''
  if (mark && task.sizeKb > STAGES_BUDGET_KB) {
    const { sourceBytes, resultBytes } = planArchive(readFileSync(task.stagesPath, 'utf8'))
    if (sourceBytes - resultBytes > 5 * 1024) {
      size = ` — ${task.sizeKb} KB, свернуть закрытые этапы: node "${archiveScript}" ${path} --apply`
    }
  }
  return `- ${task.ticket}${mark}${mode}: ${task.status ?? 'статус не указан'} — ${path}${size}`
}

// Журнал отстаёт от ветки, когда этапы кончились: в force каждый коммит этапа попадает в журнал тем же ходом.
const outside = (task) => {
  if (task.forceActive || !/^## Force-прогон/m.test(task.stages)) return null
  const commits = unjournaledCommits(state, task)
  if (!commits.length) return null
  const shown = commits
    .slice(0, 3)
    .map(({ sha, subject }) => `\`${sha.slice(0, 8)}\` ${subject}`)
    .join('; ')
  return (
    `  ⚠ на ветке ${commits.length} коммит(ов), которых нет ни в STAGES.md, ни в PR.md: ${shown}${commits.length > 3 ? '; …' : ''}. ` +
    'Это работа после закрытия force — мимо чекеров. Прогони её догоняющим этапом (/stage-kickoff → /stage-check) или запиши в журнал, что проверено.'
  )
}

const lines = [
  ...current.flatMap((task) => [line(task, ` (ветка ${state.branch})`), outside(task)].filter(Boolean)),
  ...others.map((task) => line(task, '')),
]
process.stdout.write(
  `stage-pipeline — задачи в этом репо:\n${lines.join('\n')}\n` +
    'Продолжая задачу, читай её STAGES.md точечно (текущий этап), а не целиком.\n',
)
