#!/usr/bin/env node
/**
 * Ретро пайплайна по фактам из файлов задач, а не по памяти.
 *
 *   node retro.mjs <repo | task_dir | STAGES.md> [...]
 *
 * Источники: строки `metrics:` из журналов STAGES.md / STAGES-ARCHIVE.md (формат —
 * /stage-check, Шаг 4.1), чеклисты пайплайна этапов и отчёты в checks/. Задачи до
 * появления строки `metrics:` дают только чеклисты и отчёты — это тоже видно в выводе.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const targets = process.argv.slice(2)
if (!targets.length || targets.includes('--help')) {
  console.log('Использование: node retro.mjs <repo | task_dir | STAGES.md> [...]')
  process.exit(targets.length ? 0 : 2)
}

const taskDirs = new Set()
for (const target of targets.map((t) => resolve(t))) collectTaskDirs(target)

if (!taskDirs.size) {
  console.error('Не найдено ни одного STAGES.md')
  process.exit(1)
}

const CHECKERS = ['figma-compare', 'proto-compare', 'devtools-verify', 'pro-review', 'dead-code', 'i18n-sweep', 'deps-audit', 'ds-parity', 'task-converge', 'figma-spec', 'proto-spec']
const STAGES_BUDGET_KB = 40
const stagesSizes = []
const perChecker = new Map()
const checker = (name) => {
  if (!perChecker.has(name)) perChecker.set(name, { ran: 0, skipped: 0, reports: 0 })
  return perChecker.get(name)
}
const totals = { tasks: 0, stages: 0, withMetrics: 0, findings: 0, dropped: 0, iterations: 0, fresh: 0, escalations: 0 }
const acOutcomes = { done: 0, userReview: 0, live: 0 }
const iterationHistogram = new Map()
// Размер этапа (поле diff=) против находок и раундов: подтверждает или опровергает ориентир «~300 / >1000 строк».
const SIZE_BUCKETS = [
  { label: '≤300', max: 300 },
  { label: '301–1000', max: 1000 },
  { label: '>1000', max: Infinity },
]
const bySize = SIZE_BUCKETS.map((bucket) => ({ ...bucket, stages: 0, findings: 0, iterations: 0, fresh: 0 }))
let floorViolations = 0
let stagesWithFloor = 0

for (const dir of taskDirs) {
  totals.tasks++
  const text = ['STAGES.md', 'STAGES-ARCHIVE.md']
    .map((name) => join(dir, name))
    .filter(existsSync)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')

  // Этап из STAGES.md и его полная запись из архива — один этап: берём блок со строкой metrics:, если он есть.
  const stageBlocks = new Map()
  for (const block of text.split(/^(?=### Этап \d+)/m).slice(1)) {
    const number = block.match(/^### Этап (\d+)/)[1]
    const previous = stageBlocks.get(number)
    if (!previous || (!/metrics:/.test(previous) && /metrics:/.test(block)) || block.length > previous.length) {
      stageBlocks.set(number, block)
    }
  }
  totals.stages += stageBlocks.size

  for (const block of stageBlocks.values()) {
    const line = block.match(/^.*metrics:.*$/m)?.[0]
    if (line) {
      const fields = Object.fromEntries([...line.matchAll(/(\w+)=([^\s`]+)/g)].map((m) => [m[1], m[2]]))
      totals.withMetrics++
      totals.findings += Number(fields.findings) || 0
      totals.dropped += Number(fields.dropped) || 0
      totals.escalations += Number(fields.escalations) || 0
      const iterations = Number(fields.iterations) || 0
      totals.iterations += iterations
      iterationHistogram.set(iterations, (iterationHistogram.get(iterations) ?? 0) + 1)
      if (fields.fresh === 'yes') totals.fresh++
      if (fields.floor !== undefined) {
        stagesWithFloor++
        floorViolations += Number(fields.floor) || 0
      }
      if (fields.diff !== undefined) {
        const bucket = bySize.find((b) => Number(fields.diff) <= b.max)
        bucket.stages++
        bucket.findings += Number(fields.findings) || 0
        bucket.iterations += iterations
        if (fields.fresh === 'yes') bucket.fresh++
      }
      for (const name of listField(fields.checkers)) checker(name).ran++
      for (const name of listField(fields.skipped)) checker(name).skipped++
      continue
    }
    // Этап закрыт до формата metrics: — остаётся только его чеклист пайплайна.
    for (const [, mark, name, rest] of block.matchAll(/^- \[([ xX])\] ([a-z0-9-]+)(.*)$/gm)) {
      if (!isChecker(name)) continue
      if (/\(skip|\[skip/.test(rest)) checker(name).skipped++
      else if (mark !== ' ') checker(name).ran++
    }
  }

  acOutcomes.done += (text.match(/AC-\d+\.\d+ ✅/g) ?? []).length
  acOutcomes.userReview += (text.match(/AC-\d+\.\d+ ⏳/g) ?? []).length
  acOutcomes.live += (text.match(/AC-\d+\.\d+ \[live: user-side\]/g) ?? []).length

  // Имена отчётов в живых задачах разъехались (pro-review-2.md, stage2-pro-review.md, stage-2/pro-review.md),
  // поэтому чекер ищется в имени файла где угодно, а не по точному шаблону.
  for (const file of walkMarkdown(join(dir, 'checks'))) {
    const name = CHECKERS.find((candidate) => file.includes(candidate))
    if (name) checker(name).reports++
  }

  stagesSizes.push({ ticket: basename(dir), kb: Math.round(statSync(join(dir, 'STAGES.md')).size / 1024) })
}

function walkMarkdown(root) {
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    if (statSync(path).isDirectory()) return walkMarkdown(path).map((child) => `${name}/${child}`)
    return name.endsWith('.md') ? [name] : []
  })
}

function listField(value) {
  return value && value !== '-' ? value.split(',').filter(Boolean) : []
}

function isChecker(name) {
  return CHECKERS.includes(name)
}

function collectTaskDirs(path) {
  if (!existsSync(path)) return
  if (statSync(path).isFile()) {
    if (basename(path) === 'STAGES.md') taskDirs.add(dirname(path))
    return
  }
  if (existsSync(join(path, 'STAGES.md'))) {
    taskDirs.add(path)
    return
  }
  const configured = join(path, '.claude/pipeline.config.md')
  if (existsSync(configured)) {
    const taskPath = readFileSync(configured, 'utf8').match(/^\s*-\s*task_path:\s*([^\s#]+)/m)?.[1]
    if (taskPath) return collectTaskDirs(resolve(path, taskPath))
  }
  for (const name of readdirSync(path)) {
    if (name === 'node_modules' || name === '.git') continue
    const child = join(path, name)
    if (statSync(child).isDirectory() && existsSync(join(child, 'STAGES.md'))) taskDirs.add(child)
  }
}

const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '—')

console.log(`# Ретро пайплайна\n`)
console.log(`Задач: ${totals.tasks}, этапов: ${totals.stages}, этапов со строкой metrics: ${totals.withMetrics}`)
if (totals.withMetrics < totals.stages) {
  console.log(`(у ${totals.stages - totals.withMetrics} этапов метрик нет — закрыты до формата metrics: или без /stage-check)`)
}
console.log('')
console.log('## Fix-loop')
console.log(`- находок всего: ${totals.findings}, отброшено как ложные: ${totals.dropped} (${pct(totals.dropped, totals.findings)})`)
console.log(`- раундов fix-loop: ${totals.iterations}, в среднем на этап: ${totals.withMetrics ? (totals.iterations / totals.withMetrics).toFixed(1) : '—'}`)
console.log(`- этапов со свежим прогоном чекера: ${totals.fresh} (${pct(totals.fresh, totals.withMetrics)})`)
console.log(`- эскалаций: ${totals.escalations}`)
if (iterationHistogram.size) {
  const hist = [...iterationHistogram.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}→${c}`)
  console.log(`- распределение раундов (раундов→этапов): ${hist.join(', ')}`)
}
if (stagesWithFloor) console.log(`- floor-guard: нарушений на первом прогоне ${floorViolations} на ${stagesWithFloor} этапах`)

const sized = bySize.filter((bucket) => bucket.stages)
if (sized.length) {
  console.log('')
  console.log('## Размер этапа (строк дифа) против fix-loop')
  console.log('| Размер | Этапов | Находок на этап | Раундов на этап | Свежий прогон |')
  console.log('|---|---|---|---|---|')
  for (const b of sized) {
    console.log(`| ${b.label} | ${b.stages} | ${(b.findings / b.stages).toFixed(1)} | ${(b.iterations / b.stages).toFixed(1)} | ${pct(b.fresh, b.stages)} |`)
  }
}
console.log('')
console.log('## Чекеры')
console.log('| Чекер | Запусков | Skip | Отчётов в checks/ | Доля skip |')
console.log('|---|---|---|---|---|')
for (const [name, c] of [...perChecker.entries()].sort()) {
  console.log(`| ${name} | ${c.ran} | ${c.skipped} | ${c.reports} | ${pct(c.skipped, c.ran + c.skipped)} |`)
}
console.log('')
console.log('## Критерии приёмки')
console.log(`- закрыто чекером (✅): ${acOutcomes.done}, ушло в user-review (⏳): ${acOutcomes.userReview}, live user-side: ${acOutcomes.live}`)

const oversized = stagesSizes.filter((task) => task.kb > STAGES_BUDGET_KB).sort((a, b) => b.kb - a.kb)
console.log('')
console.log(`## STAGES.md больше ${STAGES_BUDGET_KB} KB (читается каждой сессией — архивировать done-этапы, /stage-check Шаг 4.2)`)
console.log(oversized.length ? oversized.map((task) => `- ${task.ticket}: ${task.kb} KB`).join('\n') : '- нет')
