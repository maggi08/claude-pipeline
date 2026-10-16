#!/usr/bin/env node
/**
 * Archiving of closed STAGES.md stages → STAGES-ARCHIVE.md (/stage-check, Step 4.2).
 *
 *   node archive-stages.mjs <STAGES.md>            # what would be moved (writes nothing)
 *   node archive-stages.mjs <STAGES.md> --apply    # move it
 *   --journal-keep N                               # how many fresh journal entries to keep (8 by default)
 *
 * Prose did not hold this rule: in live tasks STAGES.md grew to 150 KB (~40k tokens
 * per read), and only five tasks out of thirty had archives. The script is deterministic:
 * a `[status: done…]`/`[status: cancelled…]` stage longer than its folded form goes to the archive
 * as a whole; STAGES.md keeps the heading (with the status and marks in it), the Commit/
 * Decisions/`metrics:` lines, everything unclosed (`- [ ]`, `[live: …]`, `⏳`) and a link to the archive.
 * Already folded stages and stages inside the "Force run" and "Journal" sections are left alone.
 * Journal: entries (`- …` lines with a date and their continuation) beyond the N freshest by date
 * go to the archive — the order of entries in live files is both direct and reversed, dates are
 * both `2026-08-22` and `22.08.2026`, and `###` subheadings inside the journal stay in place.
 *
 * The texts the script writes into task files (the archive header, stubs, the "Older entries" line) are in the
 * task language (taskLanguage; unknown → ru, as before). Both forms are read back. Console output is always English.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { taskLanguage } from './hooks/pipeline-state.mjs'
import {
  ARCHIVED_STUB,
  CLOSED_STAGE,
  JOURNAL_HEADING,
  KEEP_LINE,
  OLDER_ENTRIES,
  PROTECTED_SECTION,
  STAGE_HEADING,
} from './markers.mjs'

// Texts written into task files, by task language. In a ru task they stay as they were, byte for byte.
const WRITTEN = {
  ru: {
    stub: (title) => `Полная запись: STAGES-ARCHIVE.md — «${title}»`,
    older: (count) => `Старые записи (${count}): STAGES-ARCHIVE.md — «Журнал».`,
    header: '# Архив этапов\n\nПолные записи закрытых этапов, перенесённые из STAGES.md.\n\n',
    moved: (date) => `<!-- перенесено ${date} -->`,
    journal: '## Журнал',
  },
  en: {
    stub: (title) => `Full record: STAGES-ARCHIVE.md — "${title}"`,
    older: (count) => `Older entries (${count}): STAGES-ARCHIVE.md — "Journal".`,
    header: '# Stage archive\n\nFull records of closed stages, moved from STAGES.md.\n\n',
    moved: (date) => `<!-- moved ${date} -->`,
    journal: '## Journal',
  },
}
const writtenFor = (source) => WRITTEN[taskLanguage(source) ?? 'ru']
const bytes = (text) => Buffer.byteLength(text, 'utf8')

export function planArchive(source, { journalKeep = 8 } = {}) {
  const lines = source.split('\n')
  const moved = []
  const written = writtenFor(source)

  // A stage block runs from its heading to the next heading of the same or a higher level.
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
    if (!CLOSED_STAGE.test(block.heading)) continue
    const body = lines.slice(block.start + 1, block.end)
    if (body.some((line) => ARCHIVED_STUB.test(line))) continue
    const kept = body.filter((line) => KEEP_LINE.test(line))
    const collapsed = [block.heading, ...kept, written.stub(block.heading.replace(/^#+ /, '')), '']
    if (bytes(body.join('\n').trim()) <= bytes(collapsed.slice(1).join('\n')) + 200) continue
    moved.unshift({ heading: block.heading, text: lines.slice(block.start, block.end).join('\n').trimEnd() })
    lines.splice(block.start, block.end - block.start, ...collapsed)
  }

  // The journal goes after the stages, so the stage block indexes above no longer shift.
  let movedJournal = []
  const journalStart = lines.findIndex((line) => JOURNAL_HEADING.test(line))
  if (journalStart !== -1) {
    let journalEnd = journalStart + 1
    while (journalEnd < lines.length && !/^#{1,2} /.test(lines[journalEnd])) journalEnd++
    const journal = parseJournal(lines.slice(journalStart + 1, journalEnd))
    if (journal.entries.length > journalKeep) {
      const keep = freshest(journal.entries, journalKeep)
      movedJournal = journal.entries.filter((entry) => !keep.has(entry))
      lines.splice(journalStart + 1, journalEnd - journalStart - 1, ...rebuildJournal(journal, keep, movedJournal.length, written))
    }
  }

  const result = lines.join('\n')
  return { result, moved, movedJournal, sourceBytes: bytes(source), resultBytes: bytes(result) }
}

// Journal entries are grouped by `###` subheadings (in many tasks "Stage N — progress"); a subheading is not an entry.
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

// The N freshest: by date, on a tie by position in the file, taking into account whether new entries are on top or at the bottom.
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

function rebuildJournal(journal, keep, movedCount, written) {
  const previous = journal.preamble.map((line) => Number(line.match(OLDER_ENTRIES)?.[1] ?? 0)).reduce((a, b) => a + b, 0)
  const preamble = journal.preamble.filter((line) => !OLDER_ENTRIES.test(line)).join('\n').trim()
  const out = [...(preamble ? ['', preamble] : []), '', written.older(previous + movedCount), '']
  for (const group of journal.groups) {
    const kept = group.entries.filter((entry) => keep.has(entry))
    // A group all of whose entries moved goes away together with its subheading.
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
      // The group moved as a whole — the text under the subheading goes with it, otherwise it stays in STAGES.md.
      const whole = group.entries.every((candidate) => moved.has(candidate))
      if (group.heading) out.push(group.heading, ...(whole ? group.preamble : []))
    }
    out.push(entry.lines.join('\n').trimEnd())
  }
  return out.join('\n')
}

function main([stagesPath, ...flags]) {
  if (!stagesPath || !existsSync(stagesPath)) {
    console.error('Usage: node archive-stages.mjs <STAGES.md> [--apply] [--journal-keep N]')
    process.exit(2)
  }
  const apply = flags.includes('--apply')
  const keepIndex = flags.indexOf('--journal-keep')
  const journalKeep = keepIndex === -1 ? 8 : Number(flags[keepIndex + 1])
  if (!Number.isInteger(journalKeep) || journalKeep < 0) {
    console.error('--journal-keep expects an integer ≥ 0')
    process.exit(2)
  }
  const archivePath = join(dirname(stagesPath), 'STAGES-ARCHIVE.md')
  const source = readFileSync(stagesPath, 'utf8')
  const { result, moved, movedJournal, sourceBytes, resultBytes } = planArchive(source, { journalKeep })
  const kb = (n) => (n / 1024).toFixed(0)

  if (!moved.length && !movedJournal.length) {
    console.log(`Nothing to archive: closed stages are folded, the journal has ≤ ${journalKeep} entries (${kb(sourceBytes)} KB).`)
    process.exit(0)
  }

  console.log(
    `${apply ? 'Moved' : 'Would move'} stages: ${moved.length}, journal entries: ${movedJournal.length}, ` +
      `STAGES.md: ${kb(sourceBytes)} KB → ${kb(resultBytes)} KB (−${((sourceBytes - resultBytes) / 1024).toFixed(1)} KB)`,
  )
  for (const stage of moved) console.log(`  ${stage.heading}`)

  if (!apply) {
    console.log('\nOther sections (Force run, awaiting confirmation, questions) are not touched. To apply: --apply')
    process.exit(0)
  }

  const written = writtenFor(source)
  const date = new Date().toISOString().slice(0, 10)
  const header = existsSync(archivePath)
    ? readFileSync(archivePath, 'utf8').trimEnd() + '\n\n'
    : written.header
  const archivedStages = moved.map((stage) => `${written.moved(date)}\n${stage.text}`)
  const archivedJournal = movedJournal.length ? [`${written.journal}\n${written.moved(date)}\n${archiveJournal(movedJournal)}`] : []

  copyFileSync(stagesPath, `${stagesPath}.bak`)
  writeFileSync(archivePath, `${header}${[...archivedStages, ...archivedJournal].join('\n\n')}\n`)
  writeFileSync(stagesPath, result)
  console.log(`\nArchive: ${archivePath}\nBackup: ${stagesPath}.bak`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
