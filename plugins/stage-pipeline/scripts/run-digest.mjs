#!/usr/bin/env node
/**
 * Сводка прогона для итогового сообщения — из журнала и отчётов, а не из памяти оркестратора.
 *
 * В одной задаче итоговое сообщение назвало «тексты kk/en, заголовок вкладки, подписи и мелкие отступления»,
 * а под этим ярлыком лежали два дефекта, которые пользователь нашёл в работе с продуктом; три решения
 * из «Решил сам» он отменил на следующее утро. В другой «[live: user-side]» стоит 46 раз, и шесть
 * дефектов нашёл пользователь именно там. Сводка показывает всё, что не закрыто проверкой, —
 * порядок разбора выбирает пользователь.
 *
 *   node run-digest.mjs <task_dir>/<TICKET>
 *
 * Охват — то, что записано после снимка задачи (session-start делает его при первом взгляде плагина):
 * новые отчёты чекеров и новые строки журнала. Зовётся из /stage-force («Выход») и хуком journal-gate
 * при закрытии блока «Force-прогон».
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  baselineInfo,
  disposition,
  findingCounts,
  fingerprint,
  journalText,
  lastForceBlock,
  ledgerEntries,
  ledgerViolations,
  newReports,
  openBlockers,
} from './journal-check.mjs'
import { pluginDataDir } from './hooks/pipeline-state.mjs'

const ACCEPTED = new Set(['fixed', 'false', 'blocker', 'user'])
const bullet = (line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim()

export function runDigest(taskDir, dataDir = pluginDataDir()) {
  const { lines, ledgerSince } = baselineInfo(dataDir, taskDir)
  const stages = existsSync(join(taskDir, 'STAGES.md')) ? readFileSync(join(taskDir, 'STAGES.md'), 'utf8') : ''
  const fresh = (line) => line.trim() && !lines.has(fingerprint(line))
  const reports = newReports(taskDir, ledgerSince).map((name) => ({ name, text: readFileSync(join(taskDir, 'checks', name), 'utf8') }))
  const out = []

  const block = lastForceBlock(stages)
  const blockers = block ? openBlockers(block.body) : []
  out.push(`### Блокеры — нужен твой ответ (${blockers.length})`, ...(blockers.length ? blockers.map((line) => `- ${bullet(line)}`) : ['- нет']))

  const open = reports.flatMap(({ name, text }) => ledgerViolations(text, name, { complete: true }).map((violation) => `- ${violation.message}`))
  if (open.length) out.push('', `### Находки без итога (${open.length}) — исправить или вынести блокером`, ...open)

  const unverified = []
  for (const { name, text } of reports) {
    const start = text.search(/^#{2,3}\s*Не удалось проверить/im)
    if (start === -1) continue
    const body = text.slice(start).split('\n').slice(1)
    const end = body.findIndex((line) => /^#{1,3}\s/.test(line))
    for (const line of end === -1 ? body : body.slice(0, end)) {
      if (/^\s*(?:[-*]|\d+\.)\s+\S/.test(line) && !/^(?:нет|ничего|всё .*проверено)\.?$/i.test(bullet(line))) unverified.push(`- ${name}: ${bullet(line)}`)
    }
  }
  const journal = journalText(taskDir)
    .split('\n')
    .filter((line) => fresh(line) && /AC-\d/.test(line) && /⏳|\[live:|\[blocked/i.test(line))
    .map((line) => `- ${bullet(line).slice(0, 220)}`)
    // Закрытый этап лежит и в архиве, и свёрнутой строкой в STAGES.md — критерий один.
    .filter((line, index, all) => all.indexOf(line) === index)
  out.push('', `### Не проверено (${unverified.length + journal.length})`, ...(unverified.length + journal.length ? [...journal, ...unverified] : ['- нет']))

  const minors = reports
    .map(({ name, text }) => {
      const counts = findingCounts(text, name)
      const accepted = (ledgerEntries(text) ?? []).filter((entry) => ACCEPTED.has(disposition(entry))).length
      return { name, left: Math.max(0, counts.minor - Math.max(0, accepted - counts.critical - counts.major)) }
    })
    .filter(({ left }) => left)
  if (minors.length) {
    out.push('', `### Minor без итога (${minors.reduce((sum, { left }) => sum + left, 0)})`, `- ${minors.map(({ name, left }) => `${name}: ${left}`).join(' · ')}`)
  }

  const pending = section(stages, /^## ⚠?\s*Ожидают подтверждения/m).filter(fresh).filter((line) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line))
  out.push('', `### Принято само — проверь, дорогие откаты первыми (${pending.length})`, ...(pending.length ? pending.map((line) => `- ${bullet(line).slice(0, 220)}`) : ['- нет']))
  return out.join('\n')
}

function section(text, heading) {
  const start = text.search(heading)
  if (start === -1) return []
  const body = text.slice(start).split('\n').slice(1)
  const end = body.findIndex((line) => /^## /.test(line))
  return end === -1 ? body : body.slice(0, end)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv[2]
  if (!target || !existsSync(target)) {
    console.error('Использование: node run-digest.mjs <task_dir>/<TICKET>')
    process.exit(2)
  }
  console.log(runDigest(resolve(target)))
}
