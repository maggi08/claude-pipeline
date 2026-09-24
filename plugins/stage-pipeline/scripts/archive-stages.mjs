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
 * «Решения»/`metrics:`, всё незакрытое (`- [ ]`, `[live: …]`, `⏳`) и ссылка на архив.
 * Уже свёрнутые этапы и этапы внутри «Force-прогона» и «Журнала» не трогаются.
 * Журнал: записи (строки `- …` с датой и их продолжение) сверх N самых свежих по дате
 * уезжают в архив — порядок записей в живых файлах бывает и прямым, и обратным, даты —
 * и `2026-08-22`, и `22.08.2026`, а подзаголовки `###` внутри журнала остаются на месте.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const KEEP = /^(\s*[-*]\s*)?(\*\*)?(Коммит|Commit|Решени|metrics:)|^\s*[-*]\s*\[x\]\s*commit:|^\s*[-*]\s*\[ \](?!.*\bskip\b)|\[live:|⏳/i
const STAGE_HEADING = /^(#{2,3}) Этап [\w.]+/
const CLOSED = /\[status:\s*(done|cancelled|отмен)/i
const PROTECTED_SECTION = /^#{1,2} (Force-прогон|Журнал)/i
const ARCHIVED = 'Полная запись: STAGES-ARCHIVE.md'
const bytes = (text) => Buffer.byteLength(text, 'utf8')

export function planArchive(source, { journalKeep = 8 } = {}) {
  const lines = source.split('\n')
  const moved = []

  // Блок этапа — от его заголовка до следующего заголовка того же или более высокого уровня.
  const blocks = []
  let section = ''
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^(#{1,6}) /)
    if (!heading) continue
    const stage = lines[i].match(STAGE_HEADING)
    if (!stage) {
      if (heading[1].length <= 2) section = lines[i]
      continue
    }
    const level = stage[1].length
    let end = i + 1
    while (end < lines.length && !(lines[end].match(/^(#{1,6}) /)?.[1].length <= level)) end++
    const enclosing = level === 3 ? section : ''
    if (!PROTECTED_SECTION.test(enclosing)) blocks.push({ start: i, end, heading: lines[i] })
  }

  for (const block of blocks.reverse()) {
    if (!CLOSED.test(block.heading)) continue
    const body = lines.slice(block.start + 1, block.end)
    if (body.some((line) => line.startsWith(ARCHIVED))) continue
    const kept = body.filter((line) => KEEP.test(line))
    const collapsed = [block.heading, ...kept, `${ARCHIVED} — «${block.heading.replace(/^#+ /, '')}»`, '']
    if (bytes(body.join('\n').trim()) <= bytes(collapsed.slice(1).join('\n')) + 200) continue
    moved.unshift({ heading: block.heading, text: lines.slice(block.start, block.end).join('\n').trimEnd() })
    lines.splice(block.start, block.end - block.start, ...collapsed)
  }

  // Журнал — после этапов, чтобы индексы блоков этапов выше уже не сдвигались.
  let movedJournal = []
  const journalStart = lines.findIndex((line) => /^## Журнал(?:\s|$)/i.test(line))
  if (journalStart !== -1) {
    let journalEnd = journalStart + 1
    while (journalEnd < lines.length && !/^#{1,2} /.test(lines[journalEnd])) journalEnd++
    const journal = parseJournal(lines.slice(journalStart + 1, journalEnd))
    if (journal.entries.length > journalKeep) {
      const keep = freshest(journal.entries, journalKeep)
      movedJournal = journal.entries.filter((entry) => !keep.has(entry))
      lines.splice(journalStart + 1, journalEnd - journalStart - 1, ...rebuildJournal(journal, keep, movedJournal.length))
    }
  }

  const result = lines.join('\n')
  return { result, moved, movedJournal, sourceBytes: bytes(source), resultBytes: bytes(result) }
}

// Записи журнала сгруппированы по подзаголовкам `###` (у многих задач — «Этап N — ход»), подзаголовок — не запись.
function parseJournal(journalLines) {
  const preamble = []
  const groups = [{ heading: null, preamble: [], entries: [] }]
  let entry = null
  for (const line of journalLines) {
    if (/^#{3,6} /.test(line)) {
      groups.push({ heading: line, preamble: [], entries: [] })
      entry = null
    } else if (/^[-*] /.test(line)) {
      entry = { lines: [line], date: entryDate(line), group: groups.at(-1) }
      groups.at(-1).entries.push(entry)
    } else if (entry) entry.lines.push(line)
    else if (groups.length === 1) preamble.push(line)
    else groups.at(-1).preamble.push(line)
  }
  return { preamble, groups, entries: groups.flatMap((group) => group.entries) }
}

function entryDate(line) {
  const iso = line.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return iso[0]
  const ru = line.match(/(\d{2})\.(\d{2})\.(\d{4})/)
  return ru ? `${ru[3]}-${ru[2]}-${ru[1]}` : ''
}

// N самых свежих: по дате, при равной — по положению в файле с учётом того, сверху новые записи или снизу.
function freshest(entries, count) {
  const dated = entries.filter((entry) => entry.date)
  let down = 0
  for (let i = 1; i < dated.length; i++) down += dated[i].date < dated[i - 1].date ? 1 : dated[i].date > dated[i - 1].date ? -1 : 0
  const newestFirst = down > 0
  let inherited = ''
  const ranked = entries.map((entry, index) => {
    inherited = entry.date || inherited
    return { entry, date: entry.date || inherited, rank: newestFirst ? -index : index }
  })
  ranked.sort((a, b) => b.date.localeCompare(a.date) || b.rank - a.rank)
  return new Set(ranked.slice(0, count).map(({ entry }) => entry))
}

function rebuildJournal(journal, keep, movedCount) {
  const previous = journal.preamble.map((line) => Number(line.match(/^Старые записи \((\d+)\)/)?.[1] ?? 0)).reduce((a, b) => a + b, 0)
  const preamble = journal.preamble.filter((line) => !line.startsWith('Старые записи (')).join('\n').trim()
  const out = [...(preamble ? ['', preamble] : []), '', `Старые записи (${previous + movedCount}): STAGES-ARCHIVE.md — «Журнал».`, '']
  for (const group of journal.groups) {
    const kept = group.entries.filter((entry) => keep.has(entry))
    // Группа, из которой уехали все записи, уезжает вместе с подзаголовком.
    if (group.entries.length && !kept.length) continue
    if (group.heading) out.push(group.heading, ...group.preamble)
    out.push(...kept.flatMap((entry) => entry.lines))
  }
  return out
}

function archiveJournal(movedJournal) {
  const moved = new Set(movedJournal)
  const out = []
  let group = undefined
  for (const entry of movedJournal) {
    if (entry.group !== group) {
      group = entry.group
      // Группа уехала целиком — с ней уезжает и текст под подзаголовком, иначе он остаётся в STAGES.md.
      const whole = group.entries.every((candidate) => moved.has(candidate))
      if (group.heading) out.push(group.heading, ...(whole ? group.preamble : []))
    }
    out.push(entry.lines.join('\n').trimEnd())
  }
  return out.join('\n')
}

function main([stagesPath, ...flags]) {
  if (!stagesPath || !existsSync(stagesPath)) {
    console.error('Использование: node archive-stages.mjs <STAGES.md> [--apply] [--journal-keep N]')
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
  const { result, moved, movedJournal, sourceBytes, resultBytes } = planArchive(source, { journalKeep })
  const kb = (n) => (n / 1024).toFixed(0)

  if (!moved.length && !movedJournal.length) {
    console.log(`Нечего архивировать: закрытые этапы свёрнуты, в журнале ≤ ${journalKeep} записей (${kb(sourceBytes)} KB).`)
    process.exit(0)
  }

  console.log(
    `${apply ? 'Перенесено' : 'Будет перенесено'} этапов: ${moved.length}, записей журнала: ${movedJournal.length}, ` +
      `STAGES.md: ${kb(sourceBytes)} KB → ${kb(resultBytes)} KB (−${((sourceBytes - resultBytes) / 1024).toFixed(1)} KB)`,
  )
  for (const stage of moved) console.log(`  ${stage.heading}`)

  if (!apply) {
    console.log('\nОстальные разделы (Force-прогон, подтверждения, вопросы) не трогаются. Применить: --apply')
    process.exit(0)
  }

  const date = new Date().toISOString().slice(0, 10)
  const header = existsSync(archivePath)
    ? readFileSync(archivePath, 'utf8').trimEnd() + '\n\n'
    : `# Архив этапов\n\nПолные записи закрытых этапов, перенесённые из STAGES.md.\n\n`
  const archivedStages = moved.map((stage) => `<!-- перенесено ${date} -->\n${stage.text}`)
  const archivedJournal = movedJournal.length ? [`## Журнал\n<!-- перенесено ${date} -->\n${archiveJournal(movedJournal)}`] : []

  copyFileSync(stagesPath, `${stagesPath}.bak`)
  writeFileSync(archivePath, `${header}${[...archivedStages, ...archivedJournal].join('\n\n')}\n`)
  writeFileSync(stagesPath, result)
  console.log(`\nАрхив: ${archivePath}\nБэкап: ${stagesPath}.bak`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
