#!/usr/bin/env node
/**
 * Правила закрытия критериев в журнале задачи — то, что /stage-check требует текстом и что на живых
 * прогонах не держалось:
 *
 * - критерий с тегом рантайм- или дизайн-чекера (`[verify: devtools-verify]`, `figma-compare`,
 *   `proto-compare`) закрыт ✅, а исход называет другого проверяющего («✅ pro-review по коду») или
 *   никого — 24 таких критерия в одной задаче, и два из них пользователь потом нашёл сломанными;
 * - дизайн-чекер пропущен по причине браузера («staging не принимает токен», «MCP занят»), хотя
 *   сверка код ↔ макет статическая — так в одной задаче он не прошёл ни на одном UI-этапе;
 * - PASS в отчёте чекера без замера («4.5 PASS») — неотличим от «не посмотрел» (stage-check, Шаг 1).
 *
 *   node journal-check.mjs <task_dir>/<TICKET>     # все нарушения в STAGES.md, архиве и checks/
 *
 * Хук journal-gate применяет те же правила только к строкам, которые появились после первого
 * взгляда на задачу: старые задачи и закрытые этапы никто не обязан переписывать.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const LIVE_CHECKERS = ['devtools-verify', 'figma-compare', 'proto-compare']
const AC_ID = /AC-\d/

export function requiredCheckers(line) {
  const tags = [...line.matchAll(/\[verify:\s*([^\]]+)\]/gi)].map((match) => match[1])
  return LIVE_CHECKERS.filter((checker) => tags.some((tag) => tag.includes(checker)))
}

/**
 * Нарушение в строке критерия или null. Исход — текст после первой ✅ без самих тегов `[verify: …]`:
 * у части задач исход стоит перед формулировкой критерия, и тег в хвосте строки иначе «называл» бы себя сам.
 * Честные формы проходят: проверяющий назван, рантайм-часть отложена (`⏳ devtools-verify`, `[live: …]`),
 * devtools заменён smoke-прогоном, или явное решение пользователя.
 */
export function acViolation(line, reports = null) {
  if (!AC_ID.test(line) || !line.includes('✅')) return null
  const required = requiredCheckers(line)
  if (!required.length) return null
  const outcome = line.slice(line.indexOf('✅') + 1).replace(/\[verify:[^\]]*\]/gi, '')
  const id = line.match(/AC-[\w.]+/)[0]
  const deferred = /\[live:|решени[а-яё]* пользователя/i.test(outcome) || required.some((checker) => new RegExp(`⏳[^·;]*${checker}`).test(outcome))
  if (deferred) return null
  const named = required.filter((checker) => outcome.includes(checker))
  // Рантайм-критерий закрывает и живая проверка без субагента (smoke-прогон, «проверено живьём»); дизайн-критерий — только сверка чекером.
  const live = required.includes('devtools-verify') && /\bsmoke\b|живь[её]м|вживую|в браузере/i.test(outcome)
  if (!named.length && !live) {
    const shown = outcome.replace(/\s+/g, ' ').trim().slice(0, 60)
    return {
      rule: 'ac-checker',
      id,
      message:
        `${id}: тег [verify: ${required.join(', ')}], а исход ${shown ? `«✅ ${shown}»` : '— голая ✅'}: этот чекер критерий не проверял. ` +
        `Прогони ${required[0]} или поставь «⏳ ${required[0]}» — исход называет того, кто проверял (stage-check, Шаг 4.1).`,
    }
  }
  if (reports && named.length && !named.some((checker) => reports.some((name) => name.includes(checker)))) {
    return {
      rule: 'ac-report',
      id,
      message: `${id}: исход «✅ ${named[0]}», а отчёта ${named[0]} в checks/ нет — сохрани его (\`${named[0]}-<этап>.md\`, stage-check, Шаг 4.3) или поставь ⏳.`,
    }
  }
  return null
}

const BROWSER_REASON = /браузер|chrome|\bmcp\b|devtools|токен|token|staging|стенд|\blive\b|dev-?сервер|занят|логин|login|\bauth/i
const LEGIT_REASON = /logic-only|нет\s+(дизайн|макет|figma|прототип)|дизайн-источник|источник|без визуал|визуал не меня|макет[а-яё]*\s+нет|figma\s+нет/i

// Пропуск дизайн-чекера по причине браузера: живые формы — `[skip: …]`, `(skip — …)`, `— skip (…)`, `skip: …`,
// в том числе общий на два чекера: «proto-compare и devtools-verify — skip: MCP-Chrome занят». Через « · » skip уже чужой.
export function skipViolation(line) {
  for (const match of line.matchAll(/(figma-compare|proto-compare)/g)) {
    const near = line.slice(match.index + match[0].length, match.index + match[0].length + 200)
    const skip = near.match(/^((?:(?!\s·\s)[^.;(\n]){0,50}?)[[(]?\s*skip\b\s*[:—–-]?\s*\(?\s*([^\])·;\n]*)/i)
    if (!skip) continue
    const reason = skip[2].trim()
    if (BROWSER_REASON.test(reason) && !LEGIT_REASON.test(reason)) {
      return {
        rule: 'design-skip',
        id: match[1],
        message:
          `${match[1]} пропущен по причине «${reason.slice(0, 60)}» — это статическая сверка код ↔ макет, браузер, стенд и токен ей не нужны. ` +
          `Запусти чекер; skip — только logic-only или нет дизайн-источника (stage-check, Шаги 0–1).`,
      }
    }
  }
  return null
}

export function journalViolations(text, reports = null) {
  return text
    .split('\n')
    .map((line) => {
      const violation = acViolation(line, reports) ?? skipViolation(line)
      return violation && { ...violation, line: line.trim() }
    })
    .filter(Boolean)
}

// Строки, на которые смотрят правила журнала: из них состоит базовый снимок задачи.
export function journalCandidates(text) {
  return text.split('\n').filter((line) => (AC_ID.test(line) && line.includes('✅')) || /(figma|proto)-compare[^\n]{0,40}skip/i.test(line))
}

const VALUE =
  /`[^`]+`|[\w-]+\.[a-z]{1,5}:\d+|\d+(?:[.,]\d+)?\s*(?:px|ms|s\b|%|kb|mb|rem|em|°)|#[0-9a-f]{3,8}\b|«[^»]{2,}»|"[^"]{2,}"|\d+\s*[x×]\s*\d+|\w\s*=\s*\S|→/i
const PASS_RUN = /((?:`?(?:AC-)?\d+[a-z]?(?:\.\d+[a-z]?)+`?\s*(?:,|и|and|\/)?\s*)+)(?:[—–:|-]\s*)?\**PASS\b\**/g

/**
 * Критерии, у которых в отчёте чекера есть только голые PASS: ни одно упоминание критерия не несёт
 * замера (file:line, значение, цитату) или хотя бы фразы по существу. Сводная строка
 * «AC-3.1 PASS, AC-3.2 PASS» вверху отчёта — не нарушение, если ниже у тех же критериев есть подробности.
 */
export function barePasses(text) {
  const passed = new Set()
  const evidence = new Set()
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    // Номер без `AC-` («4.5 PASS») — критерий только в списке из нескольких: одиночное «§27.7 PASS» — номер раздела.
    const compact = (line.match(/\d+[a-z]?\.\d+[a-z]?`?\s*(?:[—–:-]\s*)?\**PASS/g) ?? []).length > 1
    // Подробности часто идут подпунктами под строкой «`AC-8.1` — PASS на обеих бронях.» — они продолжают
    // последний пункт строки, а не весь список «4.1 PASS · 4.2 PASS · …» перед ним.
    const below = lines.slice(index + 1, index + 7)
    const stop = below.findIndex((next) => !next.trim() || /^#|AC-\d/.test(next))
    const details = (stop === -1 ? below : below.slice(0, stop)).join(' ')
    const segments = line.split(/\s+·\s+|,\s+(?=`?(?:AC-)?\d+[a-z]?\.\d)/)
    for (const [position, segment] of segments.entries()) {
      const runs = [...segment.matchAll(PASS_RUN)].filter((match) => compact || /AC-/.test(match[1]))
      for (const [order, match] of runs.entries()) {
        const tail = segment.slice(match.index + match[0].length).replace(/^[\s.*|:—–-]+/, '')
        const last = position === segments.length - 1 && order === runs.length - 1
        const hasValue = VALUE.test(tail) || tail.replace(/[|*\s]+/g, ' ').trim().length >= 25 || (last && VALUE.test(details))
        for (const [id] of match[1].matchAll(/\d+[a-z]?(?:\.\d+[a-z]?)+/g)) {
          passed.add(id)
          if (hasValue) evidence.add(id)
        }
      }
      // Подробность без слова PASS («`AC-3.3` — колонки 150/200 …») — тоже замер по критерию.
      if (runs.length) continue
      for (const match of segment.matchAll(/AC-(\d+[a-z]?(?:\.\d+[a-z]?)+)/g)) {
        const tail = segment.slice(match.index + match[0].length).replace(/^[`\s.*|:—–-]+/, '')
        if (VALUE.test(tail) || tail.trim().length >= 25) evidence.add(match[1])
      }
    }
  }
  return [...passed].filter((id) => !evidence.has(id)).map((id) => `AC-${id}`)
}

export function reportNames(taskDir) {
  const dir = join(taskDir, 'checks')
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.md'))
  } catch {
    return []
  }
}

export function reportViolation(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const ids = barePasses(text)
  if (!ids.length) return null
  const shown = ids.length > 6 ? `${ids.slice(0, 6).join(', ')} и ещё ${ids.length - 6}` : ids.join(', ')
  return {
    rule: 'bare-pass',
    id: basename(path),
    message:
      `checks/${basename(path)}: PASS без замера — ${shown}. Голый PASS неотличим от «не посмотрел» (stage-check, Шаг 1): ` +
      'запроси у чекера значение с file:line или считай пункт непроверенным (⏳ в журнале).',
  }
}

/**
 * Базовый снимок задачи — строки журнала, которые уже были, когда плагин впервые посмотрел на задачу.
 * Хук проверяет только то, чего в снимке нет: новые и переписанные строки. Снимок не растёт —
 * нарушение, появившееся позже, напоминает о себе, пока его не исправят.
 */
const fingerprint = (line) => createHash('sha1').update(line.trim()).digest('hex').slice(0, 16)

export function journalText(taskDir) {
  return ['STAGES.md', 'STAGES-ARCHIVE.md']
    .map((name) => join(taskDir, name))
    .filter(existsSync)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
}

function baselinePath(dataDir, taskDir) {
  let real = taskDir
  try {
    real = realpathSync(taskDir)
  } catch {
    // каталог задачи пропал — снимок по исходному пути
  }
  return join(dataDir, 'journal-baseline', `${createHash('sha1').update(real).digest('hex').slice(0, 16)}.json`)
}

export function loadBaseline(dataDir, taskDir) {
  try {
    return new Set(JSON.parse(readFileSync(baselinePath(dataDir, taskDir), 'utf8')).lines)
  } catch {
    return null
  }
}

export function ensureBaseline(dataDir, taskDir) {
  const existing = loadBaseline(dataDir, taskDir)
  if (existing) return existing
  const lines = journalCandidates(journalText(taskDir)).map(fingerprint)
  try {
    const path = baselinePath(dataDir, taskDir)
    mkdirSync(join(dataDir, 'journal-baseline'), { recursive: true })
    writeFileSync(path, JSON.stringify({ taskDir, created: new Date().toISOString(), lines }))
  } catch {
    // снимок не записался — следующий взгляд создаст его заново
  }
  return new Set(lines)
}

export function newJournalViolations(dataDir, taskDir) {
  const baseline = ensureBaseline(dataDir, taskDir)
  return journalViolations(journalText(taskDir), reportNames(taskDir)).filter((violation) => !baseline.has(fingerprint(violation.line)))
}

function main([target]) {
  if (!target || !existsSync(target)) {
    console.error('Использование: node journal-check.mjs <task_dir>/<TICKET>')
    process.exit(2)
  }
  const taskDir = resolve(target.endsWith('.md') ? join(target, '..') : target)
  const found = journalViolations(journalText(taskDir), reportNames(taskDir))
  const reports = reportNames(taskDir)
    .map((name) => reportViolation(join(taskDir, 'checks', name)))
    .filter(Boolean)
  for (const violation of [...found, ...reports]) console.log(`- ${violation.message}`)
  if (!found.length && !reports.length) console.log('Нарушений правил закрытия критериев нет.')
  process.exit(found.length || reports.length ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
