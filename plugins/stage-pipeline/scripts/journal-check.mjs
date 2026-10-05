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
 * - PASS в отчёте чекера без замера («4.5 PASS») — неотличим от «не посмотрел» (stage-check, Шаг 1);
 * - «как у X» в критерии или решении без пути к X — замысел теряется на открытии этапа (stage-plan, Шаг 3).
 *
 *   node journal-check.mjs <task_dir>/<TICKET>     # все нарушения в STAGES.md, архиве и checks/
 *
 * Хук journal-gate применяет те же правила только к строкам, которые появились после первого
 * взгляда на задачу: старые задачи и закрытые этапы никто не обязан переписывать.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
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

// ✅ с оговоркой внутри — «✅ (тёмная тема не снята)», «✅ только по cookie, вид не проверен»: критерий закрыт наполовину.
const CAVEAT = /не\s+снят|не\s+проверен|не\s+проверял|не\s+смотрел|не\s+открывал|только\s+по\s+коду|частично|не\s+удалось\s+(?:проверить|снять|открыть|посмотреть)/i
// «Нет данных» вместо подстановки состояния: 46 «[live: user-side]» в одной задаче, шесть дефектов из них нашёл пользователь.
const NO_DATA = /нет\s+(?:подходящ[а-яё]*\s+|живых\s+|тестов[а-яё]*\s+)?(?:данных|брон[а-яё]*|лид[а-яё]*|записей|объявлен[а-яё]*|заказ[а-яё]*)(?![а-яё])|нет\s+на\s+аккаунте|no\s+(?:test\s+)?data/i
const STUBBED = /подмен|подстав|заглушк|фикстур|stub|mock|override|перехват|intercept/i

export function caveatViolation(line) {
  if (!AC_ID.test(line) || !line.includes('✅')) return null
  const outcome = line.slice(line.indexOf('✅') + 1).replace(/\[verify:[^\]]*\]/gi, '')
  if (/⏳|\[live:|\[blocked/i.test(outcome) || !CAVEAT.test(outcome)) return null
  const id = line.match(/AC-[\w.]+/)[0]
  return {
    rule: 'ac-caveat',
    id,
    message:
      `${id}: ✅ с оговоркой «${outcome.match(CAVEAT)[0]}» — критерий закрыт наполовину. Непроверенная часть — это ⏳ с тем, кто её проверит, ` +
      'или разбей критерий на два (references/checker-report.md).',
  }
}

export function noDataViolation(line) {
  if (!AC_ID.test(line) || !/⏳|\[live:|не\s+провер/i.test(line) || !NO_DATA.test(line) || STUBBED.test(line)) return null
  // В длинной строке журнала критериев несколько: причина относится к ближайшему перед ней.
  const reason = line.search(NO_DATA)
  const before = [...line.slice(0, reason).matchAll(/AC-[\w.]+/g)].at(-1)
  const id = (before ?? line.match(/AC-[\w.]+/))[0].replace(/[.,]+$/, '')
  return {
    rule: 'live-no-data',
    id,
    message:
      `${id}: не проверен из-за «${line.match(NO_DATA)[0]}». Нет данных — не причина: состояние подставляется фикстурой или заглушкой API ` +
      '(skill devtools-verify, «Состояния без данных»). Подставить нельзя — назови почему.',
  }
}

// «Как у X» без пути к X. «так как в …» — причина, а не ссылка; «как в ТЗ» — ссылка на сам тикет.
const LIKE = /(?<![а-яё])(?<!так\s+)как\s+(?:у|в|на|сейчас|раньше|было|прежде)(?![а-яё])|\b(?:same\s+as|like\s+in)\b/i
const REF = /[\w@./-]+\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|scss|less|html?|md|py|go|rb|kt|swift|java|php|rs|cs)\b|https?:\/\/|node-?id|\b\d+[:-]\d+\b|`[^`\s]*\/[^`\s]*`/i
const DECISION = /^\s*(?:[-*]|\d+\.|\|)?\s*\**(?:D\d+\b|Решени[ея]|Решено|Решили)/i

/**
 * Критерий или решение ссылается на образец словами — «как у эксперта», «как сейчас в шторке», «как было» —
 * без пути к нему. В одной задаче решение «как у эксперта» (там сохранение активно и без смены статуса)
 * на открытии этапа стало «как сейчас в шторке», и анкету нельзя было сохранить, не меняя статус.
 * Ссылка на макет у критерия с дизайн-чекером проходит: узлы этапа у чекера есть.
 */
export function likeViolation(line) {
  if (!AC_ID.test(line) && !DECISION.test(line)) return null
  const match = line.match(LIKE)
  if (!match) return null
  const after = line.slice(match.index + match[0].length)
  if (REF.test(line) || /^\s*(?:AC-\d|этап[а-яё]*\s+\d|B\d|тз|тикет|задач[а-яё]*\s|описани|contract|spec\b|ci\b)/i.test(after)) return null
  if (/^\s*(?:макет|дизайн|figma|фигм|прототип)/i.test(after) && /\[verify:\s*(?:figma|proto)-compare/i.test(line)) return null
  const id = line.match(/AC-[\w.]+/)?.[0]?.replace(/[.,]+$/, '') ?? line.match(/\bD\d+\b/)?.[0] ?? 'решение'
  return {
    rule: 'ac-like-ref',
    id,
    message:
      `${id}: «${`${match[0]}${after}`.trim().slice(0, 40)}…» без ссылки на образец — впиши \`путь:строка\` (или node-id макета) того, на что ссылаешься. ` +
      'Для действия с условиями — ещё таблица «состояние × действие → что уходит на сервер, что видит пользователь» (stage-plan, Шаг 3).',
  }
}

/**
 * Отметка чекера в журнале — `- [x] pro-review (checks/stage-8-pro-review.md — …)` — закрывает его находки.
 * У этого отчёта должен быть полный «Итог находок»: в одной задаче такая строка закрыла Request changes словами
 * «M-1 — принят как компромисс», и дубль лида пользователь чинил на следующий день.
 */
export function checkerLineViolation(line, taskDir) {
  if (!taskDir) return null
  const match = line.match(/\[x\]\s*\**([\w-]+)\**[^\n]*?checks\/([\w.-]+\.md)/i)
  if (!match || !reportChecker(match[2])) return null
  let text
  try {
    text = readFileSync(join(taskDir, 'checks', match[2]), 'utf8')
  } catch {
    return null
  }
  const [violation] = ledgerViolations(text, match[2], { complete: true })
  return violation ?? null
}

export function journalViolations(text, reports = null, taskDir = null) {
  return text
    .split('\n')
    .map((line) => {
      const violation =
        acViolation(line, reports) ?? skipViolation(line) ?? caveatViolation(line) ?? noDataViolation(line) ?? likeViolation(line) ?? checkerLineViolation(line, taskDir)
      return violation && { ...violation, line: line.trim() }
    })
    .filter(Boolean)
}

// Строки журнала, из которых состоит базовый снимок задачи: все — правило смотрит только на новые и переписанные.
export function journalCandidates(text) {
  return text.split('\n').filter((line) => line.trim())
}

// Правила до 0.14 — по ним старый снимок отличает «уже было» от «появилось и ещё не исправлено».
const legacyViolation = (line) => acViolation(line) ?? skipViolation(line)

// ── отчёты чекеров: сводка, итог находок ─────────────────────────────────────

const CHECKERS = ['pro-review', 'figma-compare', 'proto-compare', 'devtools-verify', 'dead-code', 'i18n-sweep', 'deps-audit', 'ds-parity', 'task-converge', 'security-review', 'kit-overrides']
export const reportChecker = (name) => CHECKERS.find((checker) => name.includes(checker)) ?? null

// Сводка в живых отчётах: «Находки: critical 0 · major 2 · minor 1», «0 critical / 2 major», «🔴0 · 🟠2»,
// «🔴 Critical: 1», «- Major: 0», «critical 0, major 0», «Request changes (2 major)», у dead-code — «1 удалить».
const SUMMARY_LINE = /вердикт|итог|сводка|находк|findings|verdict|severity|🔴|🟠|^\s*[-*]?\s*\**(?:critical|major)\**\s*:\s*\d|(?:critical|major|minor)[^\n]*(?:critical|major|minor)/i
const severityWord = (words) => words.map((word) => `(?<![\\w-])${word}(?![\\w-])`).join('|')
const severityPatterns = (words) => [new RegExp(`(\\d+)\\s*\\**\\s*(?:${severityWord(words)})`, 'i'), new RegExp(`(?:${severityWord(words)})\\**\\s*:?\\s*(\\d+)`, 'i')]

/**
 * Сколько в отчёте critical и major. Сначала сводка из первых строк (стандартная или любая живая форма),
 * без неё — строки таблиц и списков с severity. `high`/`medium` — severity только у security-review:
 * у dead-code это уверенность, у Tailwind — `font-medium 500`. `null` — посчитать нечем.
 */
export function findingCounts(text, name = '') {
  const security = name.includes('security')
  const lines = text.split('\n')
  const patterns = {
    critical: [/🔴\s*\**\s*(?:critical)?\s*\**\s*:?\s*(\d+)/i, ...severityPatterns(security ? ['critical', 'high'] : ['critical'])],
    major: [/🟠\s*\**\s*(?:major)?\s*\**\s*:?\s*(\d+)/i, ...severityPatterns(security ? ['major', 'medium'] : ['major']), /(\d+)\s*удалить(?![а-яё])/i],
    minor: [/🟡\s*\**\s*(?:minor)?\s*\**\s*:?\s*(\d+)/i, /(\d+)\s*\**\s*minor/i, /(?<![\w-])minor\**\s*:?\s*(\d+)/i, ...(security ? severityPatterns(['low']) : [])],
  }
  const summary = { critical: null, major: null, minor: null }
  for (const line of lines.slice(0, 30)) {
    if (!SUMMARY_LINE.test(line) || !/\d/.test(line)) continue
    for (const key of ['critical', 'major', 'minor']) {
      const found = patterns[key].map((pattern) => line.match(pattern)).find(Boolean)
      if (found) summary[key] = Math.max(summary[key] ?? 0, Number(found[1]))
    }
  }
  if (summary.critical !== null || summary.major !== null) return { critical: summary.critical ?? 0, major: summary.major ?? 0, minor: summary.minor ?? 0, summary: true }
  const cell = new RegExp(`\\|\\s*\\**(${security ? 'critical|high|major|medium' : 'critical|major'})\\**\\s*\\|`, 'i')
  const rows = { critical: 0, major: 0, minor: 0, summary: false }
  for (const line of lines) {
    const severity = line.match(cell)?.[1]
    if (severity) rows[/critical|high/i.test(severity) ? 'critical' : 'major']++
    if (/\|\s*\**minor\**\s*\|/i.test(line)) rows.minor++
    const item = line.match(/^\s*(?:[-*]\s*|#{2,4}\s*|\d+\.\s*)\**(🔴|🟠|critical\b|major\b)/i)
    // Заголовок группы «## 🟠 Major» — не находка.
    if (item && !/^\s*#{1,4}\s*(?:🔴|🟠)?\s*\**(?:critical|major)\**\s*(?:\(\d+\))?\s*$/i.test(line)) rows[/🔴|critical/i.test(item[1]) ? 'critical' : 'major']++
  }
  return rows
}

// Критерии с FAIL — тоже находки, даже без строки в таблице. «было FAIL» после фикса — не в счёт.
export function failedCriteria(text) {
  const ids = new Set()
  for (const line of text.split('\n')) {
    if (!/\bFAIL\b/.test(line) || /(?:было|was|до\s+фикса)\s*:?\s*FAIL/i.test(line)) continue
    for (const [id] of line.matchAll(/AC-\d+[a-z]?(?:\.\d+[a-z]?)*/g)) ids.add(id)
  }
  return [...ids]
}

const PARKED =
  /оставля|оставлен|компромисс|ожида[а-яё]*\s+подтвержд|не\s+чин|в\s+кит(?![а-яё])|findings|отдельн[а-яё]*\s+задач|позже|потом(?![а-яё])|принят[а-яё]*\s+как|вопрос[а-яё]*\s+(?:к\s+)?(?:продукт|дизайн|бэкенд|backend|ревьюер|qa)|вне\s+(?:скоуп|границ)|не\s+в\s+скоуп/i
const PRE_EXISTING = /давн|не\s+регресс|pre-?existing|было\s+до|до\s+задачи/i
const BASE_EVIDENCE = /\b[0-9a-f]{7,40}\b|https?:\/\/|(?<![а-яё])прод(?![а-яё])|\bprod\b|на\s+базе/i

/** Итог одной строки «Итог находок»: fixed | false | blocker | user — итог; parked | unproven | unknown — нет. */
export function disposition(entry) {
  const proven = PRE_EXISTING.test(entry) && BASE_EVIDENCE.test(entry)
  if (PRE_EXISTING.test(entry) && !proven) return 'unproven'
  if (PARKED.test(entry) && !proven) return 'parked'
  if (/исправлен|починен|удал[её]н|\bfixed\b|\bremoved\b/i.test(entry)) return 'fixed'
  if (proven || /ложн|false\s+positive|не\s+подтвердил|не\s+воспроизв/i.test(entry)) return 'false'
  if (/\bB\d+\b/.test(entry)) return 'blocker'
  if (/решени[а-яё]*\s+пользователя[^\n]*(?:«|"|\d{2}\.\d{2}|\d{4}-\d{2})/i.test(entry)) return 'user'
  return 'unknown'
}

export function ledgerEntries(text) {
  const start = text.search(/^#{2,3}\s*Итог находок/im)
  if (start === -1) return null
  const body = text.slice(start).split('\n').slice(1)
  const end = body.findIndex((line) => /^#{1,3}\s/.test(line))
  return (end === -1 ? body : body.slice(0, end)).filter((line) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line)).map((line) => line.trim())
}

const ACCEPTED = new Set(['fixed', 'false', 'blocker', 'user'])
const LEDGER_DOC = 'references/checker-report.md'

/**
 * Нарушения итога находок в отчёте: запрещённый итог («оставляю», «в Ожидают»), «давний» без доказательства
 * на базе, нераспознанный итог; с `complete` — ещё и итогов меньше, чем critical + major (или FAIL, если их больше).
 */
export function ledgerViolations(text, name, { complete = false } = {}) {
  const entries = ledgerEntries(text) ?? []
  const shown = (entry) => entry.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').slice(0, 90)
  const found = []
  for (const entry of entries) {
    const kind = disposition(entry)
    if (kind === 'parked') {
      found.push({
        rule: 'ledger-parked',
        id: name,
        message: `checks/${name}: «${shown(entry)}» — это решение не исправлять, его принимает пользователь. Итог — исправлено, ложная (с доказательством) или блокер B<n> (${LEDGER_DOC}).`,
      })
    } else if (kind === 'unproven') {
      found.push({
        rule: 'ledger-unproven',
        id: name,
        message: `checks/${name}: «${shown(entry)}» — «давнее» без доказательства на базе. Проверь на sha базы или на проде и впиши замер, иначе это находка задачи.`,
      })
    } else if (kind === 'unknown') {
      found.push({
        rule: 'ledger-unknown',
        id: name,
        message: `checks/${name}: итог «${shown(entry)}» не распознан — допустимы «исправлено: …», «ложная: …», «B<n>», «решение пользователя <дата>» (${LEDGER_DOC}).`,
      })
    }
  }
  if (!complete) return found
  const counts = findingCounts(text, name)
  const fails = failedCriteria(text.slice(0, Math.max(0, text.search(/^#{2,3}\s*Итог находок/im)) || text.length))
  const required = Math.max(counts.critical + counts.major, fails.length)
  const accepted = entries.filter((entry) => ACCEPTED.has(disposition(entry))).length
  if (accepted < required) {
    const what = [counts.critical && `critical ${counts.critical}`, counts.major && `major ${counts.major}`, fails.length && `FAIL ${fails.join(', ')}`].filter(Boolean).join(' · ')
    found.push({
      rule: 'ledger-missing',
      id: name,
      message:
        `checks/${name}: ${what}, а итогов в «## Итог находок» — ${accepted}. Каждая находка закрывается строкой: исправлено / ложная / B<n> ` +
        `(${LEDGER_DOC}). Находку, которую fix-loop не исправил, не откладывают — это блокер.`,
    })
  }
  return found
}

/** Отчёт чекера без сводки, по которой можно сосчитать находки. */
export function summaryViolation(text, name) {
  if (!reportChecker(name)) return null
  const counts = findingCounts(text, name)
  const standard = /Находки:\s*critical\s*\d+\s*·\s*major\s*\d+/i.test(text)
  if (standard || counts.summary || /\bskip\b/i.test(text.split('\n').slice(0, 5).join(' '))) return null
  return {
    rule: 'report-summary',
    id: name,
    message: `checks/${name}: нет строки сводки — второй строкой отчёта «Находки: critical N · major N · minor N» (${LEDGER_DOC}). Без неё находки не сосчитать.`,
  }
}

/**
 * Рантайм-отчёт: замер геометрии новых узлов на каждой ширине и честная причина «не проверено».
 * Прецеденты: плашка схлопнулась на дне меню (`m-4` в контейнере без отступа), а чекер мерил ширину и вложенность;
 * название страны в три строки вылезало из карточки на скриншотах самого чекера.
 */
export function runtimeViolations(text, name, taskDir = null) {
  if (reportChecker(name) !== 'devtools-verify' || /\bskip\b/i.test(text.split('\n').slice(0, 5).join(' '))) return []
  const found = []
  // Этап с «Эталоном вида» — сверка типографики с соседней секцией: прототип совпадал с кодом, а «жирно» и «разные кнопки»
  // пользователь увидел рядом с остальным дашбордом.
  const reference = taskDir && stageReference(taskDir, name)
  if (reference && !/^\s*[-*]?\s*`?style-diff\b/im.test(text)) {
    found.push({
      rule: 'no-style-diff',
      id: name,
      message:
        `checks/${name}: у этапа «Эталон вида» (${reference.slice(0, 60)}), а строк \`style-diff <ширина>: roles N · differ N\` нет — сверь типографику, кнопки и таблицы ` +
        'новой секции с эталонной (skill devtools-verify, шаг «Эталон вида»). Расхождение без решения пользователя — находка major.',
    })
  }
  if (!/^\s*[-*]?\s*`?geometry\b/im.test(text)) {
    found.push({
      rule: 'no-geometry',
      id: name,
      message:
        `checks/${name}: нет строк \`geometry <ширина>: overflow N · zero-gap N · clipped N\` — замер геометрии новых узлов на каждой ширине ` +
        '(skill devtools-verify, шаг «Геометрия»). Переполнение и нулевой зазор до края контейнера скриншот не показывает, пока на него не смотрят.',
    })
  }
  const unverified = text.slice(Math.max(0, text.search(/^#{2,3}\s*Не удалось проверить/im)))
  const line = unverified.split('\n').find((candidate) => NO_DATA.test(candidate) && !STUBBED.test(candidate))
  if (/^#{2,3}\s*Не удалось проверить/im.test(text) && line) {
    found.push({
      rule: 'live-no-data',
      id: name,
      message: `checks/${name}: «${line.trim().slice(0, 80)}» — нет данных не причина: подставь состояние фикстурой или заглушкой API без записи на стенд (skill devtools-verify, «Состояния без данных»).`,
    })
  }
  return found
}

/** Все нарушения отчёта при его записи: голые PASS, сводка, итоги (без полноты — она нужна к коммиту), рантайм. */
export function reportViolations(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const name = basename(path)
  return [reportViolation(path), summaryViolation(text, name), ...ledgerViolations(text, name), ...runtimeViolations(text, name, dirname(dirname(path)))].filter(Boolean)
}

/** «Эталон вида» этапа, к которому относится отчёт (`stage-3-devtools-verify.md`, `devtools-verify-3.md`), или null. */
export function stageReference(taskDir, name) {
  const stage = name.match(/(?:stage|этап)-?(\d+[a-z]?)\b/i)?.[1] ?? name.match(/devtools-verify-(\d+[a-z]?)\b/i)?.[1]
  if (!stage) return null
  const text = journalText(taskDir)
  const heading = text.match(new RegExp(`^###\\s+Этап\\s+${stage}(?![\\w.])[^\\n]*$`, 'm'))
  if (!heading) return null
  const rest = text.slice(heading.index + heading[0].length)
  const end = rest.search(/^#{2,3}\s/m)
  const value = (end === -1 ? rest : rest.slice(0, end)).match(/эталон\s+вида\**\s*:\s*(.+)$/im)?.[1]?.trim()
  return value && !/^(?:—|-|нет|n\/a|не\s+нужен)/i.test(value) ? value : null
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
export const fingerprint = (line) => createHash('sha1').update(line.trim()).digest('hex').slice(0, 16)

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

const BASELINE_VERSION = 2

function readBaseline(dataDir, taskDir) {
  try {
    return JSON.parse(readFileSync(baselinePath(dataDir, taskDir), 'utf8'))
  } catch {
    return null
  }
}

function writeBaseline(dataDir, taskDir, data) {
  try {
    mkdirSync(join(dataDir, 'journal-baseline'), { recursive: true })
    writeFileSync(baselinePath(dataDir, taskDir), JSON.stringify(data))
  } catch {
    // снимок не записался — следующий взгляд создаст его заново
  }
}

export function loadBaseline(dataDir, taskDir) {
  const data = readBaseline(dataDir, taskDir)
  return data ? new Set(data.lines) : null
}

/**
 * Снимок v2 — все строки журнала и момент, с которого отчёты проверяются на итог находок (`ledgerSince`).
 * Снимок v1 (0.12–0.13) хранил только строки с ✅ и skip: при первом взгляде новой версии в него
 * дописываются все текущие строки, кроме нарушений 0.12, появившихся после снимка, — те и дальше
 * напоминают о себе. Отчёты, записанные до этого момента, итога не требуют: идущая задача
 * не обязана переписывать закрытые этапы.
 */
export function baselineInfo(dataDir, taskDir) {
  const data = readBaseline(dataDir, taskDir)
  if (data?.version === BASELINE_VERSION) return { lines: new Set(data.lines), ledgerSince: data.ledgerSince }
  const now = Date.now()
  const current = journalCandidates(journalText(taskDir))
  const old = new Set(data?.lines ?? [])
  const lines = data
    ? [...old, ...current.filter((line) => old.has(fingerprint(line)) || !legacyViolation(line)).map(fingerprint)]
    : current.map(fingerprint)
  const next = { taskDir, created: data?.created ?? new Date(now).toISOString(), version: BASELINE_VERSION, ledgerSince: now, lines: [...new Set(lines)] }
  writeBaseline(dataDir, taskDir, next)
  return { lines: new Set(next.lines), ledgerSince: now }
}

export function ensureBaseline(dataDir, taskDir) {
  return baselineInfo(dataDir, taskDir).lines
}

// Отчёты чекеров, записанные после снимка v2: только у них проверяется итог находок.
export function newReports(taskDir, since) {
  return reportNames(taskDir).filter((name) => {
    try {
      return reportChecker(name) && statSync(join(taskDir, 'checks', name)).mtimeMs >= since
    } catch {
      return false
    }
  })
}

/** Новые отчёты без полного итога находок — то, с чем не коммитят force-этап и не закрывают прогон. */
export function openLedgers(dataDir, taskDir) {
  const { ledgerSince } = baselineInfo(dataDir, taskDir)
  return newReports(taskDir, ledgerSince).flatMap((name) =>
    ledgerViolations(readFileSync(join(taskDir, 'checks', name), 'utf8'), name, { complete: true }),
  )
}

/** Последний блок «Force-прогон»: заголовок и текст до следующего раздела. */
export function lastForceBlock(stages) {
  const heading = [...stages.matchAll(/^## Force-прогон.*$/gm)].at(-1)
  if (!heading) return null
  const rest = stages.slice(heading.index + heading[0].length)
  const end = rest.search(/^## /m)
  return { heading: heading[0], body: end === -1 ? rest : rest.slice(0, end) }
}

// Блокер `B<n> — …` без пометки, что он снят пользователем.
export const openBlockers = (body) =>
  body
    .split('\n')
    .filter((line) => /^\s*[-*]?\s*\**B\d+\**\s*[—–:-]/.test(line) && !/снят|реш[её]н|закрыт|отвечен|ответ\s+пользователя|решение\s+пользователя/i.test(line))
    .map((line) => line.trim())

/**
 * Закрытие force-прогона «завершён» (без «с блокерами») при открытых блокерах или отчётах без итога.
 * Только когда заголовок переписан после снимка: старые закрытые прогоны не трогаются.
 */
export function forceCloseViolations(dataDir, taskDir) {
  const stagesPath = join(taskDir, 'STAGES.md')
  if (!existsSync(stagesPath)) return []
  const block = lastForceBlock(readFileSync(stagesPath, 'utf8'))
  if (!block || !/заверш/i.test(block.heading)) return []
  const { lines } = baselineInfo(dataDir, taskDir)
  if (lines.has(fingerprint(block.heading))) return []
  if (/с\s+блокер/i.test(block.heading)) return []
  const found = []
  const blockers = openBlockers(block.body)
  if (blockers.length) {
    found.push({
      rule: 'force-blockers',
      id: 'force',
      message: `Блок «${block.heading.replace(/^## /, '')}»: открытых блокеров ${blockers.length} (${blockers[0].slice(0, 60)}…) — закрывай как «завершён с блокерами», в сводке они первыми.`,
    })
  }
  return [...found, ...openLedgers(dataDir, taskDir)]
}

export function newJournalViolations(dataDir, taskDir) {
  const baseline = ensureBaseline(dataDir, taskDir)
  return journalViolations(journalText(taskDir), reportNames(taskDir), taskDir).filter((violation) => !baseline.has(fingerprint(violation.line)))
}

function main(args) {
  const target = args.find((arg) => !arg.startsWith('--'))
  if (!target || !existsSync(target)) {
    console.error('Использование: node journal-check.mjs <task_dir>/<TICKET> [--ledger]   # --ledger — ещё и полнота «Итога находок» во всех отчётах')
    process.exit(2)
  }
  const taskDir = resolve(target.endsWith('.md') ? join(target, '..') : target)
  const found = journalViolations(journalText(taskDir), reportNames(taskDir), taskDir)
  const reports = reportNames(taskDir).flatMap((name) => {
    const path = join(taskDir, 'checks', name)
    // Сводка и геометрия — правила новых отчётов: в старых их нет по построению, без --ledger это шум.
    const all = reportViolations(path).filter((violation) => args.includes('--ledger') || !['report-summary', 'no-geometry'].includes(violation.rule))
    return args.includes('--ledger') && reportChecker(name)
      ? [...all.filter((violation) => !violation.rule.startsWith('ledger-')), ...ledgerViolations(readFileSync(path, 'utf8'), name, { complete: true })]
      : all
  })
  const messages = [...new Set([...found, ...reports].map((violation) => violation.message))]
  for (const message of messages) console.log(`- ${message}`)
  if (!found.length && !reports.length) console.log('Нарушений правил закрытия критериев нет.')
  process.exit(found.length || reports.length ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
