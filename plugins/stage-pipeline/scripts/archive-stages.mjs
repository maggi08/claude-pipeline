#!/usr/bin/env node
/**
 * Архивация закрытых этапов STAGES.md → STAGES-ARCHIVE.md (/stage-check, Шаг 4.2).
 *
 *   node archive-stages.mjs <STAGES.md>            # что будет перенесено (ничего не пишет)
 *   node archive-stages.mjs <STAGES.md> --apply    # перенести
 *   --journal-keep N                               # сколько свежих записей журнала оставить (по умолчанию 8)
 *
 * Прозой правило не держалось: по живым задачам STAGES.md дорастали до 150 KB (~40k токенов
 * на каждое чтение), архивы были у пяти задач из тридцати. Скрипт детерминированный:
 * этап `[status: done…]`/`[status: cancelled…]` длиннее свёрнутого вида уезжает в архив
 * целиком, в STAGES.md остаются заголовок (статус и пометки в нём), строки «Коммит»/
 * «Решения»/`metrics:` и ссылка на архив. Уже свёрнутые этапы не трогаются.
 * Журнал: записи (строки `- …` с датой и их продолжение) сверх N самых свежих по дате
 * уезжают в архив — порядок записей в живых файлах бывает и прямым, и обратным.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [stagesPath, ...flags] = process.argv.slice(2)
if (!stagesPath || !existsSync(stagesPath)) {
  console.error('Использование: node archive-stages.mjs <STAGES.md> [--apply]')
  process.exit(2)
}
const apply = flags.includes('--apply')
const keepIndex = flags.indexOf('--journal-keep')
const journalKeep = keepIndex === -1 ? 8 : Number(flags[keepIndex + 1])
if (!Number.isInteger(journalKeep) || journalKeep < 0) {
  console.error('--journal-keep ждёт целое число ≥ 0')
  process.exit(2)
}
const archivePath = join(dirname(stagesPath), 'STAGES-ARCHIVE.md')

const source = readFileSync(stagesPath, 'utf8')
const lines = source.split('\n')

// Блок этапа — от «### Этап N» до следующего заголовка уровня ### или ##.
const blocks = []
for (let i = 0; i < lines.length; i++) {
  if (!/^### Этап \d+/.test(lines[i])) continue
  let end = i + 1
  while (end < lines.length && !/^#{2,3} /.test(lines[end])) end++
  blocks.push({ start: i, end, heading: lines[i] })
}

const KEEP = /^(\s*[-*]\s*)?(\*\*)?(Коммит|Решени|metrics:)/
const moved = []
for (const block of blocks.reverse()) {
  if (!/\[status:\s*(done|cancelled)/.test(block.heading)) continue
  const body = lines.slice(block.start + 1, block.end)
  const kept = body.filter((line) => KEEP.test(line))
  const collapsed = [block.heading, ...kept, `Полная запись: STAGES-ARCHIVE.md — «${block.heading.replace(/^### /, '')}»`, '']
  if (body.some((line) => line.startsWith('Полная запись: STAGES-ARCHIVE.md'))) continue
  if (body.join('\n').trim().length <= collapsed.slice(1).join('\n').length + 200) continue

  moved.unshift({ heading: block.heading, text: lines.slice(block.start, block.end).join('\n').trimEnd(), before: body.join('\n').length })
  lines.splice(block.start, block.end - block.start, ...collapsed)
}

// Журнал — после этапов, чтобы индексы блоков этапов выше уже не сдвигались.
const journalStart = lines.findIndex((line) => /^## Журнал\s*$/.test(line))
let movedJournal = []
if (journalStart !== -1) {
  let journalEnd = journalStart + 1
  while (journalEnd < lines.length && !/^## /.test(lines[journalEnd])) journalEnd++
  const entries = []
  const preamble = []
  for (const line of lines.slice(journalStart + 1, journalEnd)) {
    if (/^- /.test(line)) entries.push({ lines: [line], date: line.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '' })
    else if (entries.length) entries.at(-1).lines.push(line)
    else preamble.push(line)
  }
  if (entries.length > journalKeep) {
    const byDate = entries.map((entry, index) => ({ ...entry, index })).sort((a, b) => b.date.localeCompare(a.date) || b.index - a.index)
    const keep = new Set(byDate.slice(0, journalKeep).map((entry) => entry.index))
    movedJournal = entries.filter((_, index) => !keep.has(index))
    const kept = entries.filter((_, index) => keep.has(index))
    const note = `Старые записи (${movedJournal.length}): STAGES-ARCHIVE.md — «Журнал».`
    const body = [...preamble.filter((line) => !line.startsWith('Старые записи (')), note, '', ...kept.flatMap((entry) => entry.lines)]
    lines.splice(journalStart + 1, journalEnd - journalStart - 1, ...body)
  }
}

const result = lines.join('\n')
const savedKb = ((source.length - result.length) / 1024).toFixed(1)

if (!moved.length && !movedJournal.length) {
  console.log(`Нечего архивировать: закрытые этапы свёрнуты, в журнале ≤ ${journalKeep} записей (${(source.length / 1024).toFixed(0)} KB).`)
  process.exit(0)
}

console.log(`${apply ? 'Перенесено' : 'Будет перенесено'} этапов: ${moved.length}, записей журнала: ${movedJournal.length}, STAGES.md: ${(source.length / 1024).toFixed(0)} KB → ${(result.length / 1024).toFixed(0)} KB (−${savedKb} KB)`)
for (const stage of moved) console.log(`  ${stage.heading}`)

if (!apply) {
  console.log('\nОстальные разделы (Force-прогон, подтверждения, вопросы) не трогаются. Применить: --apply')
  process.exit(0)
}

const date = new Date().toISOString().slice(0, 10)
const header = existsSync(archivePath) ? readFileSync(archivePath, 'utf8').trimEnd() + '\n\n' : `# Архив этапов\n\nПолные записи закрытых этапов, перенесённые из STAGES.md.\n\n`
const archivedStages = moved.map((stage) => `<!-- перенесено ${date} -->\n${stage.text}`)
const archivedJournal = movedJournal.length
  ? [`## Журнал\n<!-- перенесено ${date} -->\n${movedJournal.map((entry) => entry.lines.join('\n').trimEnd()).join('\n')}`]
  : []
const archived = [...archivedStages, ...archivedJournal].join('\n\n')

copyFileSync(stagesPath, `${stagesPath}.bak`)
writeFileSync(archivePath, `${header}${archived}\n`)
writeFileSync(stagesPath, result)
console.log(`\nАрхив: ${archivePath}\nБэкап: ${stagesPath}.bak`)
