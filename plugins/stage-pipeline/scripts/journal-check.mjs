#!/usr/bin/env node
/**
 * Rules for closing criteria in the task journal — what /stage-check demands in text and what did not hold on
 * live runs:
 *
 * - a criterion tagged with a runtime or design checker (`[verify: devtools-verify]`, `figma-compare`,
 *   `proto-compare`) is closed ✅, but the outcome names another verifier ("✅ pro-review by code") or
 *   nobody — 24 such criteria in one task, and the user later found two of them broken;
 * - a design checker skipped for a browser reason ("staging does not accept the token", "MCP busy"), although
 *   a code ↔ mockup comparison is static — in one task it did not run at any UI stage;
 * - PASS in a checker report without a measurement ("4.5 PASS") — indistinguishable from "did not look" (stage-check, Step 1);
 * - "like X" in a criterion or decision without a path to X — the intent is lost when the stage opens (stage-plan, Step 3).
 *
 *   node journal-check.mjs <task_dir>/<TICKET>     # all violations in STAGES.md, the archive and checks/
 *
 * The journal-gate hook applies the same rules only to lines that appeared after the first
 * look at the task: old tasks and closed stages do not have to be rewritten.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BLOCKER_LIFTED,
  BLOCKER_LINE,
  CLOSED_WORD,
  DEAD_CODE_REMOVE,
  LEDGER_HEADING,
  NO_VISUAL_REFERENCE,
  STAGE_FILE,
  SUMMARY_STANDARD,
  UNVERIFIED_HEADING,
  VISUAL_REFERENCE_FIELD,
  WITH_BLOCKERS,
  forceHeadings,
  stageHeadingOf,
} from './markers.mjs'
import { taskLanguage } from './hooks/pipeline-state.mjs'
import { languageMismatch } from './report-language.mjs'

const LIVE_CHECKERS = ['devtools-verify', 'figma-compare', 'proto-compare']
const AC_ID = /AC-\d/

/** Code in backticks and quoted text ("…", «…», “…”) are identifiers or copy, not the wording of an outcome ("the untested import is removed"). */
export const stripQuoted = (text) => text.replace(/`[^`\n]{0,200}`|"[^"\n]{0,200}"|«[^»\n]{0,200}»|“[^”\n]{0,200}”/g, ' ')

export function requiredCheckers(line) {
  const tags = [...line.matchAll(/\[verify:\s*([^\]]+)\]/gi)].map((match) => match[1])
  return LIVE_CHECKERS.filter((checker) => tags.some((tag) => tag.includes(checker)))
}

/**
 * A violation in a criterion line, or null. The outcome is the text after the first ✅ without the `[verify: …]` tags themselves:
 * in some tasks the outcome stands before the criterion wording, and a tag in the tail of the line would otherwise "name" itself.
 * Honest forms pass: the verifier is named, the runtime part is deferred (`⏳ devtools-verify`, `[live: …]`),
 * devtools is replaced by a smoke run, or there is an explicit user decision.
 */
export function acViolation(line, reports = null) {
  if (!AC_ID.test(line) || !line.includes('✅')) return null
  const required = requiredCheckers(line)
  if (!required.length) return null
  const outcome = line.slice(line.indexOf('✅') + 1).replace(/\[verify:[^\]]*\]/gi, '')
  const prose = stripQuoted(outcome)
  const id = line.match(/AC-[\w.]+/)[0]
  // `[live: user-side]` is a marker, written in backticks too: it is read from the whole outcome; the words of a decision and "⏳ checker" — from the prose.
  const deferred = /\[live:/.test(outcome) || /решени[а-яё]* пользователя|user\s+decision/i.test(prose) || required.some((checker) => new RegExp(`⏳[^·;]*${checker}`).test(prose))
  if (deferred) return null
  const named = required.filter((checker) => outcome.includes(checker))
  // A runtime criterion is also closed by a live check without a subagent (a smoke run, "checked live"); a design criterion only by a checker comparison.
  const live = required.includes('devtools-verify') && /\bsmoke\b|живь[её]м|вживую|в браузере|(?<!\bnot\s)(?<!n['’]t\s)\b(?:checked|tested|verified|confirmed|ran|run|done)\s+live\b|\blive\s+(?:check|run|smoke|test|session)\b|in\s+(?:the|a)\s+(?:live\s+)?browser/i.test(prose)
  if (!named.length && !live) {
    const shown = outcome.replace(/\s+/g, ' ').trim().slice(0, 60)
    return {
      rule: 'ac-checker',
      id,
      message:
        `${id}: tag [verify: ${required.join(', ')}], but the outcome is ${shown ? `"✅ ${shown}"` : 'a bare ✅'}: this checker did not check the criterion. ` +
        `Run ${required[0]} or set "⏳ ${required[0]}" — the outcome names who checked (stage-check, Step 4.1).`,
    }
  }
  if (reports && named.length && !named.some((checker) => reports.some((name) => name.includes(checker)))) {
    return {
      rule: 'ac-report',
      id,
      message: `${id}: the outcome is "✅ ${named[0]}", but there is no ${named[0]} report in checks/ — save it (\`${named[0]}-<stage>.md\`, stage-check, Step 4.3) or set ⏳.`,
    }
  }
  return null
}

const BROWSER_REASON = /браузер|browser|chrome|\bmcp\b|devtools|токен|token|staging|стенд|\bstand\b(?!-)|\blive\b|dev-?сервер|dev[- ]?server|занят|\bbusy\b|логин|login|sign-?in|\bauth/i
const LEGIT_REASON =
  /logic-only|нет\s+(дизайн|макет|figma|прототип)|дизайн-источник|источник|без визуал|визуал не меня|макет[а-яё]*\s+нет|figma\s+нет|\bno\s+(?:design|mockup|figma|prototype)|design\s+source|no\s+visual|visuals?\s+(?:are\s+)?unchanged/i

// A design checker skipped for a browser reason: live forms are `[skip: …]`, `(skip — …)`, `— skip (…)`, `skip: …`,
// including one shared by two checkers: "proto-compare and devtools-verify — skip: MCP-Chrome busy". After " · " the skip is someone else's.
export function skipViolation(line) {
  for (const match of line.matchAll(/(figma-compare|proto-compare)/g)) {
    const near = line.slice(match.index + match[0].length, match.index + match[0].length + 200)
    const skip = near.match(/^((?:(?!\s·\s)[^.;(\n]){0,50}?)[[(]?\s*skip(?:ped)?\b(?!=)\s*[:—–-]?\s*\(?\s*([^\])·;\n]*)/i)
    if (!skip) continue
    const reason = skip[2].trim()
    if (BROWSER_REASON.test(reason) && !LEGIT_REASON.test(reason)) {
      return {
        rule: 'design-skip',
        id: match[1],
        message:
          `${match[1]} skipped for the reason "${reason.slice(0, 60)}" — this is a static code ↔ mockup comparison, it needs no browser, stand or token. ` +
          `Run the checker; skip is only for logic-only or no design source (stage-check, Steps 0–1).`,
      }
    }
  }
  return null
}

// ✅ with a caveat inside — "✅ (dark theme not captured)", "✅ only by cookie, look not checked": the criterion is half-closed.
const CAVEAT_RU = 'не\\s+снят|не\\s+проверен|не\\s+проверял|не\\s+смотрел|не\\s+открывал|только\\s+по\\s+коду|частично|не\\s+удалось\\s+(?:проверить|снять|открыть|посмотреть)'
// "checkbox is not checked by default", "drawer not opened on load" describe the interface, not what was verified: a control word before "not checked/opened" is not a caveat.
const UI_STATE =
  "(?<!\\b(?:checkbox|box|toggle|radio|radio\\s+button|switch|option|row|item|drawer|modal|menu|dropdown|accordion|popover|sidebar|dialog|sheet|tab|window|page|link|panel|terms|consent|agreement)\\s+(?:(?:is|are|was|stays|remains)\\s+)?)"
const CAVEAT_EN =
  `\\bnot\\s+(?:captured|verified|tested)\\b|\\b(?:is|are|was|were|left|stays?|remains?)\\s+(?:unverified|untested)\\b|\\b(?:unverified|untested)\\s*(?=[;,.)—–:]|$)|\\b(?:unverified|untested)\\s+(?:at|on|in|for|under)\\s+\\d|${UI_STATE}\\bnot\\s+(?:checked|opened)\\b(?!\\s+(?:by\\s+default|on\\s+load|initially|at\\s+first|twice|again|repeatedly|more\\s+than\\s+once)\\b)|\\b(?:did\\s+not|didn['’]t)\\s+(?:check|look|verify|open|capture)|\\b(?:from|by)\\s+code[- ]only\\b|\\(\\s*code[- ]only\\s*\\)|\\bonly\\s+(?:from|by|in)\\s+(?:the\\s+)?code\\b|\\bpart(?:ly|ially)\\b(?!\\s+(?:hidden|visible|covered|obscured|overlapped|collapsed|clipped|shown|open|expanded|loaded|filled|transparent))|\\b(?:could\\s+not|couldn['’]t|unable\\s+to)\\s+(?:verify|capture|open|view|check)`
const CAVEAT = new RegExp(`${CAVEAT_RU}|${CAVEAT_EN}`, 'i')
// "No data" instead of putting a state in place: 46 "[live: user-side]" in one task, the user found six defects among them.
const NO_DATA = /нет\s+(?:подходящ[а-яё]*\s+|живых\s+|тестов[а-яё]*\s+)?(?:данных|брон[а-яё]*|лид[а-яё]*|записей|объявлен[а-яё]*|заказ[а-яё]*)(?![а-яё])|нет\s+на\s+аккаунте|\bno\s+(?:suitable\s+|matching\s+|live\s+|test\s+)?(?:data|bookings|leads|records|listings|orders)\b(?!\s+(?:loss|lost|was\s+lost|were\s+lost|changed?)\b)|\bnot\s+on\s+the\s+account|\bno\s+such\s+data/i
const STUBBED = /подмен|подстав|заглушк|фикстур|stub|mock|override|перехват|intercept|fixture|substitut|\bfak(?:e|ed|ing)\b|replaced\s+the\s+API\s+response/i

export function caveatViolation(line) {
  if (!AC_ID.test(line) || !line.includes('✅')) return null
  const outcome = line.slice(line.indexOf('✅') + 1).replace(/\[verify:[^\]]*\]/gi, '')
  const prose = stripQuoted(outcome)
  if (/⏳|\[live:|\[blocked/i.test(outcome) || !CAVEAT.test(prose)) return null
  const id = line.match(/AC-[\w.]+/)[0]
  return {
    rule: 'ac-caveat',
    id,
    message:
      `${id}: ✅ with a caveat "${prose.match(CAVEAT)[0]}" — the criterion is half-closed. The unverified part is a ⏳ naming who will check it, ` +
      'or split the criterion in two (references/checker-report.md).',
  }
}

export function noDataViolation(line) {
  if (!AC_ID.test(line) || !/⏳|\[live:|не\s+провер|\bnot\s+(?:verified|checked)\b|\bcould\s+not\s+verify/i.test(line) || !NO_DATA.test(line) || STUBBED.test(line)) return null
  // A long journal line holds several criteria: the reason belongs to the nearest one before it.
  const reason = line.search(NO_DATA)
  const before = [...line.slice(0, reason).matchAll(/AC-[\w.]+/g)].at(-1)
  const id = (before ?? line.match(/AC-[\w.]+/))[0].replace(/[.,]+$/, '')
  return {
    rule: 'live-no-data',
    id,
    message:
      `${id}: not verified because of "${line.match(NO_DATA)[0]}". No data is not a reason: the state is put in place with a fixture or an API stub ` +
      '(skill devtools-verify, "States without data"). If it cannot be put in place — say why.',
  }
}

// "Like X" without a path to X. "because in …" is a reason, not a reference; "as in the ticket" refers to the ticket itself.
const LIKE =
  /(?<![а-яё])(?<!так\s+)как\s+(?:у|в|на|сейчас|раньше|было|прежде)(?![а-яё])|\b(?:same\s+as|like\s+in)\b|(?<![\w-])(?<!such\s)(?<!well\s)as\s+(?:in\s+the|on\s+the|before\b|it\s+was\b|it\s+is\s+now\b|now\b|currently\b)|(?<!\b(?:looks?|feels?|seems?|sounds?)\s)\blike\s+the\s+(?:old|expert|existing|current|original|previous|rest\s+of)\b|\b(?:as|like)\s+on\s+(?:prod|production|staging|dev)\b/i
const REF = /[\w@./-]+\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|scss|less|html?|md|py|go|rb|kt|swift|java|php|rs|cs)\b|https?:\/\/|node-?id|\b\d+[:-]\d+\b|`[^`\s]*\/[^`\s]*`/i
const DECISION = /^\s*(?:[-*]|\d+\.|\|)?\s*\**(?:D\d+\b|Решени[ея]|Решено|Решили|Decisions?\b|Decided\b|We\s+decided\b)/i

/**
 * A criterion or decision refers to an example in words — "like the expert", "as it is now in the drawer", "as it was" —
 * without a path to it. In one task the decision "like the expert" (where saving is active even without a status change)
 * became "as it is now in the drawer" when the stage opened, and the form could not be saved without changing the status.
 * A link to a mockup passes for a criterion with a design checker: the checker has the stage's nodes.
 */
export function likeViolation(line) {
  if (!AC_ID.test(line) && !DECISION.test(line)) return null
  const match = line.match(LIKE)
  if (!match) return null
  const after = line.slice(match.index + match[0].length)
  if (REF.test(line) || /^\s*(?:in\s+)?(?:the\s+)?(?:AC-\d|этап[а-яё]*\s+\d|stage\s+\d|B\d|тз|тикет|ticket\b|задач[а-яё]*\s|task\b|описани|description\b|contract|spec\b|ci\b)/i.test(after)) return null
  if (/^\s*(?:in\s+)?(?:the\s+)?(?:макет|дизайн|figma|фигм|прототип|design\b|mockup\b|prototype\b)/i.test(after) && /\[verify:\s*(?:figma|proto)-compare/i.test(line)) return null
  const id = line.match(/AC-[\w.]+/)?.[0]?.replace(/[.,]+$/, '') ?? line.match(/\bD\d+\b/)?.[0] ?? 'decision'
  return {
    rule: 'ac-like-ref',
    id,
    message:
      `${id}: "${`${match[0]}${after}`.trim().slice(0, 40)}…" without a reference to the example — write the \`path:line\` (or the mockup node-id) of what you refer to. ` +
      'For an action with conditions — also a "state × action → what goes to the server, what the user sees" table (stage-plan, Step 3).',
  }
}

/**
 * A checker mark in the journal — `- [x] pro-review (checks/stage-8-pro-review.md — …)` — closes its findings.
 * This report must have a full "Findings outcome": in one task such a line closed Request changes with the words
 * "M-1 — accepted as a compromise", and the user fixed a duplicate of the lead the next day.
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

// Journal lines that make up the task's base snapshot: all of them — the rule looks only at new and rewritten ones.
export function journalCandidates(text) {
  return text.split('\n').filter((line) => line.trim())
}

// Rules before 0.14 — by them an old snapshot tells "already there" from "appeared and not yet fixed".
const legacyViolation = (line) => acViolation(line) ?? skipViolation(line)

// ── checker reports: summary, findings outcome ───────────────────────────────

const CHECKERS = ['pro-review', 'figma-compare', 'proto-compare', 'devtools-verify', 'dead-code', 'i18n-sweep', 'deps-audit', 'ds-parity', 'task-converge', 'security-review', 'kit-overrides']
export const reportChecker = (name) => CHECKERS.find((checker) => name.includes(checker)) ?? null

// The summary in live reports: "Findings: critical 0 · major 2 · minor 1", "0 critical / 2 major", "🔴0 · 🟠2",
// "🔴 Critical: 1", "- Major: 0", "critical 0, major 0", "Request changes (2 major)", for dead-code — "1 remove".
const SUMMARY_LINE = /вердикт|итог|сводка|находк|findings|verdict|severity|🔴|🟠|^[^\S\n]*(?:[-*][^\S\n]*)?\**(?:critical|major)\**\s*:\s*\d|(?:critical|major|minor)[^\n]*(?:critical|major|minor)/i
const severityWord = (words) => words.map((word) => `(?<![\\w-])${word}(?![\\w-])`).join('|')
const severityPatterns = (words) => [new RegExp(`(\\d+)\\s*\\**\\s*(?:${severityWord(words)})`, 'i'), new RegExp(`(?:${severityWord(words)})\\**\\s*:?\\s*(\\d+)`, 'i')]

/**
 * How many critical and major findings are in a report. First the summary from the first lines (standard or any live form),
 * without it — table and list rows with a severity. `high`/`medium` are a severity only in security-review:
 * in dead-code it is confidence, in Tailwind it is `font-medium 500`. `null` — nothing to count with.
 */
export function findingCounts(text, name = '') {
  const security = name.includes('security')
  const lines = text.split('\n')
  const patterns = {
    critical: [/🔴\s*\**\s*(?:critical)?\s*\**\s*:?\s*(\d+)/i, ...severityPatterns(security ? ['critical', 'high'] : ['critical'])],
    major: [/🟠\s*\**\s*(?:major)?\s*\**\s*:?\s*(\d+)/i, ...severityPatterns(security ? ['major', 'medium'] : ['major']), DEAD_CODE_REMOVE],
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
    // The group heading "## 🟠 Major" is not a finding.
    if (item && !/^\s*#{1,4}\s*(?:🔴|🟠)?\s*\**(?:critical|major)\**\s*(?:\(\d+\))?\s*$/i.test(line)) rows[/🔴|critical/i.test(item[1]) ? 'critical' : 'major']++
  }
  return rows
}

// Criteria with FAIL are findings too, even without a row in the table. "was FAIL" after a fix does not count.
export function failedCriteria(text) {
  const ids = new Set()
  for (const line of text.split('\n')) {
    if (!/\bFAIL\b/.test(line) || /(?:было|was(?:\s+previously)?|до\s+фикса|before\s+(?:the\s+)?fix)\s*:?\s*FAIL/i.test(line)) continue
    for (const [id] of line.matchAll(/AC-\d+[a-z]?(?:\.\d+[a-z]?)*/g)) ids.add(id)
  }
  return [...ids]
}

// A finding closed by a promise, not by a fix: "will be fixed in a follow-up", "not yet fixed", "hasn't been fixed", and their Russian forms.
const NOT_FIXED_YET =
  /(?:\bnot|n['’]t)\s+(?:(?:yet|fully|been|completely|properly)\s+)*(?:fix(?:ing|ed)|resolved)\b|\b(?:will|to)\s+be\s+(?:fixed|resolved|addressed)\b|(?<![а-яё])не\s+(?:(?:ещ[её]|полностью)\s+)*(?:исправлен|починен)|(?:исправим|починим|поправим)(?![а-яё])|будет\s+(?:исправлен|починен)/i
// "FINDINGS" (the file name) is case-sensitive: the plain word "findings" is the plugin's own vocabulary, and "to findings" — a forbidden outcome.
const PARKED_FILE = /\bFINDINGS(?:\.md)?\b/
const PARKED =
  /оставля|оставлен|компромисс|ожида[а-яё]*\s+подтвержд|не\s+чин|в\s+кит(?![а-яё])|(?:в|to|into)\s+findings\b|отдельн[а-яё]*\s+задач|позже|потом(?![а-яё])|принят[а-яё]*\s+как|вопрос[а-яё]*\s+(?:к\s+)?(?:продукт|дизайн|бэкенд|backend|ревьюер|qa)|вне\s+(?:скоуп|границ)|не\s+в\s+скоуп|\bleav(?:e|es|ing)\s+(?:it|this|that|them|as)\b|\bleft\s+as\b|\bkeep(?:ing)\b|\bkept\s+as\b|compromise|awaiting\s+(?:user\s+)?confirmation|\bwon['’]?t\s+fix|\b(?:to|into)\s+the\s+kit\b|separate\s+task|\blater\b|\bafterwards\b|\bdeferred\b|\bpostponed\b|accepted\s+as\b|question\s+(?:for|to)\s+(?:the\s+)?(?:product|design|backend|reviewer|qa)\b|out\s+of\s+scope|not\s+in\s+scope|outside\s+(?:the\s+)?(?:scope|boundaries)/i
const PRE_EXISTING = /давн|не\s+регресс|pre-?existing|было\s+до|до\s+задачи|long-?standing|not\s+a\s+regression|existed\s+before|(?:was|were)\s+(?:already\s+)?there\s+before|before\s+this\s+task|predat(?:es|ed)/i
const BASE_EVIDENCE = /\b[0-9a-f]{7,40}\b|https?:\/\/|(?<![а-яё])прод(?![а-яё])|\bprod\b|на\s+базе|\bproduction\b|\bon\s+(?:the\s+)?base\b/i

const FIXED_WORD = /исправлен|починен|удал[её]н|(?<!\bnot\s)(?<!n['’]t\s)\b(?:fixed|removed|resolved|repaired)\b/i
const refused = (text) => PARKED.test(text) || PARKED_FILE.test(text) || NOT_FIXED_YET.test(text)
/** The wording of an outcome: the clause up to the first ":" or dash after the outcome word ("fixed: a.ts:10 — the promise is not resolved twice" → "fixed"). The description of the fix is not the outcome. */
function outcomeHead(clause) {
  const word = FIXED_WORD.exec(clause)
  if (!word) return clause
  const end = word.index + word[0].length
  const cut = clause.slice(end).search(/:|\s[—–-]\s/)
  return cut === -1 ? clause : clause.slice(0, end + cut)
}

/** The outcome of one "Findings outcome" line: fixed | false | blocker | user — an outcome; parked | unproven | unknown — none. */
export function disposition(entry) {
  const proven = PRE_EXISTING.test(entry) && BASE_EVIDENCE.test(entry)
  if (PRE_EXISTING.test(entry) && !proven) return 'unproven'
  // Code and quotes are identifiers and copy; a refusal is looked for in the head of the outcome and in the clauses after ";" ("fixed: a.ts:1; fix the tests later"), not in the description of the fix.
  const [first, ...rest] = stripQuoted(entry).split(';')
  if ((refused(outcomeHead(first)) || rest.some(refused)) && !proven) return 'parked'
  if (/исправлен|починен|удал[её]н|(?<!\bnot\s)(?<!n['’]t\s)\b(?:fixed|removed|resolved|repaired)\b/i.test(entry)) return 'fixed'
  if (proven || /ложн|не\s+подтвердил|не\s+воспроизв|(?:^\s*(?:[-*]|\d+\.)?\s*|[—–]\s*|\s-\s+)false\s*[:(]|\bfalse\s+positive\b|\bnot\s+confirmed\b|\b(?:could\s+not|couldn['’]t|cannot|unable\s+to)\s+reproduce|\bnot\s+reproduc(?:ed|ible)/i.test(entry)) return 'false'
  if (/\bB\d+\b/.test(entry)) return 'blocker'
  if (/(?:решени[а-яё]*\s+пользователя|user\s+decision|user\s+decided)[^\n]{0,200}?(?:«|"|“|\d{2}\.\d{2}|\d{4}-\d{2})/i.test(entry)) return 'user'
  return 'unknown'
}

export function ledgerEntries(text) {
  const start = text.search(LEDGER_HEADING)
  if (start === -1) return null
  const body = text.slice(start).split('\n').slice(1)
  const end = body.findIndex((line) => /^#{1,3}\s/.test(line))
  return (end === -1 ? body : body.slice(0, end)).filter((line) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line)).map((line) => line.trim())
}

const ACCEPTED = new Set(['fixed', 'false', 'blocker', 'user'])
export const LEDGER_DOC = 'references/checker-report.md'

/**
 * Violations of the findings outcome in a report: a forbidden outcome ("leaving it", "to Awaiting"), a "pre-existing" claim without proof
 * on the base, an unrecognised outcome; with `complete` also fewer outcomes than critical + major (or FAIL, if there are more).
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
        shown: shown(entry),
        message: `checks/${name}: "${shown(entry)}" — this is a decision not to fix, and the user makes it. The outcome is fixed, false (with proof) or blocker B<n> (${LEDGER_DOC}).`,
      })
    } else if (kind === 'unproven') {
      found.push({
        rule: 'ledger-unproven',
        id: name,
        shown: shown(entry),
        message: `checks/${name}: "${shown(entry)}" — "pre-existing" without proof on the base. Check on the base sha or on prod and write down the measurement, otherwise it is a finding of the task.`,
      })
    } else if (kind === 'unknown') {
      found.push({
        rule: 'ledger-unknown',
        id: name,
        shown: shown(entry),
        message: `checks/${name}: the outcome "${shown(entry)}" is not recognised — allowed are "fixed: …", "false: …", "B<n>", "user decision <date>" (${LEDGER_DOC}).`,
      })
    }
  }
  if (!complete) return found
  const counts = findingCounts(text, name)
  const fails = failedCriteria(text.slice(0, Math.max(0, text.search(LEDGER_HEADING)) || text.length))
  const required = Math.max(counts.critical + counts.major, fails.length)
  const accepted = entries.filter((entry) => ACCEPTED.has(disposition(entry))).length
  if (accepted < required) {
    const what = [counts.critical && `critical ${counts.critical}`, counts.major && `major ${counts.major}`, fails.length && `FAIL ${fails.join(', ')}`].filter(Boolean).join(' · ')
    found.push({
      rule: 'ledger-missing',
      id: name,
      what,
      accepted,
      message:
        `checks/${name}: ${what}, and "## Findings outcome" has ${accepted}. Each finding is closed by a line: fixed / false / B<n> ` +
        `(${LEDGER_DOC}). A finding that the fix-loop did not fix is not put off — it is a blocker.`,
    })
  }
  return found
}

/** A checker report without a summary line from which findings can be counted. */
export function summaryViolation(text, name) {
  if (!reportChecker(name)) return null
  const counts = findingCounts(text, name)
  const standard = SUMMARY_STANDARD.test(text)
  if (standard || counts.summary || /\bskip\b/i.test(text.split('\n').slice(0, 5).join(' '))) return null
  return {
    rule: 'report-summary',
    id: name,
    message: `checks/${name}: no summary line — the second line of the report must be "Findings: critical N · major N · minor N" (${LEDGER_DOC}). Without it findings cannot be counted.`,
  }
}

/**
 * Runtime report: a geometry measurement of new nodes at every width and an honest "not verified" reason.
 * Precedents: a badge collapsed at the bottom of the menu (`m-4` in a container without padding) while the checker measured width and nesting;
 * a country name in three lines stuck out of the card on the checker's own screenshots.
 */
export function runtimeViolations(text, name, taskDir = null) {
  if (reportChecker(name) !== 'devtools-verify' || /\bskip\b/i.test(text.split('\n').slice(0, 5).join(' '))) return []
  const found = []
  // A stage with a "Visual reference" — a typography comparison with a neighbouring section: the prototype matched the code, and "too bold" and "different buttons"
  // the user saw next to the rest of the dashboard.
  const reference = taskDir && stageReference(taskDir, name)
  if (reference && !/^[ \t]*(?:[-*][ \t]*)?`?style-diff\b/im.test(text)) {
    found.push({
      rule: 'no-style-diff',
      id: name,
      message:
        `checks/${name}: the stage has a "Visual reference" (${reference.slice(0, 60)}), but there are no \`style-diff <width>: roles N · differ N\` lines — compare the typography, buttons and tables ` +
        'of the new section with the reference one (skill devtools-verify, step "Visual reference"). A difference without a user decision is a major finding.',
    })
  }
  if (!/^[ \t]*(?:[-*][ \t]*)?`?geometry\b/im.test(text)) {
    found.push({
      rule: 'no-geometry',
      id: name,
      message:
        `checks/${name}: no \`geometry <width>: overflow N · zero-gap N · clipped N\` lines — a geometry measurement of new nodes at each width ` +
        '(skill devtools-verify, step "Geometry"). Overflow and zero gap to the container edge are not shown by a screenshot until someone looks at them.',
    })
  }
  const unverified = text.slice(Math.max(0, text.search(UNVERIFIED_HEADING)))
  const line = unverified.split('\n').find((candidate) => NO_DATA.test(candidate) && !STUBBED.test(candidate))
  if (UNVERIFIED_HEADING.test(text) && line) {
    found.push({
      rule: 'live-no-data',
      id: name,
      message: `checks/${name}: "${line.trim().slice(0, 80)}" — no data is not a reason: put the state in place with a fixture or an API stub without writing to the stand (skill devtools-verify, "States without data").`,
    })
  }
  return found
}

/** A report is not written in the task language. `language` is `task.language`; `null` — a task without a language, not checked. */
export function languageViolation(text, name, language) {
  const mismatch = languageMismatch(text, language)
  if (!mismatch) return null
  return {
    rule: 'report-language',
    id: name,
    message: `checks/${name}: the report is not written in the task language (${language === 'ru' ? 'Russian' : 'English'}): the prose is in ${mismatch.wrote === 'en' ? 'English' : 'Russian'}. Rewrite the report in the task language — code, paths, id and UI quotes stay as they are.`,
  }
}

/** All violations of a report when it is written: language, bare PASS, summary, outcomes (without completeness — it is needed for the commit), runtime. */
export function reportViolations(path, language = null) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const name = basename(path)
  return [languageViolation(text, name, language), reportViolation(path), summaryViolation(text, name), ...ledgerViolations(text, name), ...runtimeViolations(text, name, dirname(dirname(path)))].filter(Boolean)
}

/** The "Visual reference" of the stage a report belongs to (`stage-3-devtools-verify.md`, `devtools-verify-3.md`), or null. */
export function stageReference(taskDir, name) {
  const stage = name.match(STAGE_FILE)?.[1] ?? name.match(/devtools-verify-(\d+[a-z]?)\b/i)?.[1]
  if (!stage) return null
  const text = journalText(taskDir)
  const heading = text.match(stageHeadingOf(stage))
  if (!heading) return null
  const rest = text.slice(heading.index + heading[0].length)
  const end = rest.search(/^#{2,3}\s/m)
  const value = (end === -1 ? rest : rest.slice(0, end)).match(VISUAL_REFERENCE_FIELD)?.[1]?.trim()
  return value && !NO_VISUAL_REFERENCE.test(value) ? value : null
}

const VALUE =
  /`[^`]+`|[\w-]+\.[a-z]{1,5}:\d+|\d+(?:[.,]\d+)?\s*(?:px|ms|s\b|%|kb|mb|rem|em|°)|#[0-9a-f]{3,8}\b|«[^»]{2,}»|"[^"]{2,}"|\d+\s*[x×]\s*\d+|\w\s*=\s*\S|→/i
// The evidence for a criterion is looked for in the next 300 characters of its segment: a tail to the end of a long line is a quadratic scan.
const TAIL_MAX = 300
// At most 80 ids in a list: an unbounded run makes the scan from every id quadratic on a long line of ids without PASS.
const PASS_RUN = /((?:`?(?:AC-)?\d+[a-z]?(?:\.\d+[a-z]?)+`?\s*(?:(?:,|и|and|\/)\s*)?){1,80})(?:[—–:|-]\s*)?\**PASS\b\**/g

/**
 * Criteria that have only bare PASS in a checker report: no mention of the criterion carries
 * a measurement (file:line, a value, a quote) or at least a phrase on the substance. A summary line
 * "AC-3.1 PASS, AC-3.2 PASS" at the top of a report is not a violation if the same criteria have details below.
 */
export function barePasses(text) {
  const passed = new Set()
  const evidence = new Set()
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    // A number without `AC-` ("4.5 PASS") — a criterion only in a list of several: a lone "§27.7 PASS" is a section number.
    const compact = (line.match(/\d+[a-z]?\.\d+[a-z]?`?\s*(?:[—–:-]\s*)?\**PASS/g) ?? []).length > 1
    // Details often come as sub-items under a line "`AC-8.1` — PASS on both bookings." — they continue
    // the last item of the line, not the whole list "4.1 PASS · 4.2 PASS · …" before it.
    const below = lines.slice(index + 1, index + 7)
    const stop = below.findIndex((next) => !next.trim() || /^#|AC-\d/.test(next))
    const details = (stop === -1 ? below : below.slice(0, stop)).join(' ')
    const segments = line.split(/(?<!\s)\s+·\s+|,\s+(?=`?(?:AC-)?\d+[a-z]?\.\d)/)
    for (const [position, segment] of segments.entries()) {
      // A segment without PASS has no run: skip the scan of a long line of ids.
      const runs = !segment.includes('PASS') ? [] : [...segment.matchAll(PASS_RUN)].filter((match) => compact || /AC-/.test(match[1]))
      for (const [order, match] of runs.entries()) {
        const tail = segment.slice(match.index + match[0].length, match.index + match[0].length + TAIL_MAX).replace(/^[\s.*|:—–-]+/, '')
        const last = position === segments.length - 1 && order === runs.length - 1
        const hasValue = VALUE.test(tail) || tail.replace(/[|*\s]+/g, ' ').trim().length >= 25 || (last && VALUE.test(details))
        for (const [id] of match[1].matchAll(/\d+[a-z]?(?:\.\d+[a-z]?)+/g)) {
          passed.add(id)
          if (hasValue) evidence.add(id)
        }
      }
      // A detail without the word PASS ("`AC-3.3` — columns 150/200 …") is also a measurement for the criterion.
      if (runs.length) continue
      for (const match of segment.matchAll(/AC-(\d+[a-z]?(?:\.\d+[a-z]?)+)/g)) {
        const tail = segment.slice(match.index + match[0].length, match.index + match[0].length + TAIL_MAX).replace(/^[`\s.*|:—–-]+/, '')
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
  const shown = ids.length > 6 ? `${ids.slice(0, 6).join(', ')} and ${ids.length - 6} more` : ids.join(', ')
  return {
    rule: 'bare-pass',
    id: basename(path),
    message:
      `checks/${basename(path)}: PASS without a measurement — ${shown}. A bare PASS is indistinguishable from "did not look" (stage-check, Step 1): ` +
      'ask the checker for a value with file:line or count the item as unverified (⏳ in the journal).',
  }
}

/**
 * The task base snapshot — journal lines that already existed when the plugin first looked at the task.
 * The hook checks only what is not in the snapshot: new and rewritten lines. The snapshot does not grow —
 * a violation that appears later reminds about itself until it is fixed.
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
    // the task directory is gone — snapshot by the original path
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
    // the snapshot was not written — the next look will create it again
  }
}

export function loadBaseline(dataDir, taskDir) {
  const data = readBaseline(dataDir, taskDir)
  return data ? new Set(data.lines) : null
}

/**
 * Snapshot v2 — all journal lines and the moment from which reports are checked for a findings outcome (`ledgerSince`).
 * Snapshot v1 (0.12–0.13) kept only lines with ✅ and skip: at the first look of a new version all current lines are
 * added to it, except 0.12 violations that appeared after the snapshot — those keep reminding about themselves. `reports` are the names of reports caught at the first look: the language is checked only for reports outside this set
 * (the file path and creation time are unreliable: Edit replaces a file through rename). Reports written before that moment do not need an outcome: a task in progress
 * does not have to rewrite closed stages.
 */
export function baselineInfo(dataDir, taskDir) {
  const data = readBaseline(dataDir, taskDir)
  if (data?.version === BASELINE_VERSION) {
    if (Array.isArray(data.reports)) return { lines: new Set(data.lines), ledgerSince: data.ledgerSince, reports: new Set(data.reports) }
    // snapshot v2 without report names: current reports are old (a lazy migration, the other fields do not change)
    const migrated = { ...data, reports: reportNames(taskDir) }
    writeBaseline(dataDir, taskDir, migrated)
    return { lines: new Set(data.lines), ledgerSince: data.ledgerSince, reports: new Set(migrated.reports) }
  }
  const now = Date.now()
  const current = journalCandidates(journalText(taskDir))
  const old = new Set(data?.lines ?? [])
  const lines = data
    ? [...old, ...current.filter((line) => old.has(fingerprint(line)) || !legacyViolation(line)).map(fingerprint)]
    : current.map(fingerprint)
  const next = { taskDir, created: data?.created ?? new Date(now).toISOString(), version: BASELINE_VERSION, ledgerSince: now, lines: [...new Set(lines)], reports: reportNames(taskDir) }
  writeBaseline(dataDir, taskDir, next)
  return { lines: new Set(next.lines), ledgerSince: now, reports: new Set(next.reports) }
}

export function ensureBaseline(dataDir, taskDir) {
  return baselineInfo(dataDir, taskDir).lines
}

// Checker reports written after snapshot v2: only they are checked for a findings outcome.
export function newReports(taskDir, since) {
  return reportNames(taskDir).filter((name) => {
    try {
      return reportChecker(name) && statSync(join(taskDir, 'checks', name)).mtimeMs >= since
    } catch {
      return false
    }
  })
}

/** New reports without a full findings outcome — what a force stage is not committed with and a run is not closed with. */
export function openLedgers(dataDir, taskDir) {
  const { ledgerSince } = baselineInfo(dataDir, taskDir)
  return newReports(taskDir, ledgerSince).flatMap((name) =>
    ledgerViolations(readFileSync(join(taskDir, 'checks', name), 'utf8'), name, { complete: true }),
  )
}

/** The last "Force run" block: the heading and the text up to the next section. */
export function lastForceBlock(stages) {
  const heading = forceHeadings(stages).at(-1)
  if (!heading) return null
  const rest = stages.slice(heading.index + heading[0].length)
  const end = rest.search(/^## /m)
  return { heading: heading[0], body: end === -1 ? rest : rest.slice(0, end) }
}

// A blocker `B<n> — …` without a mark that the user lifted it.
export const openBlockers = (body) =>
  body
    .split('\n')
    .filter((line) => BLOCKER_LINE.test(line) && !BLOCKER_LIFTED.test(line))
    .map((line) => line.trim())

/**
 * Closing a force run as "completed" (without "with blockers") with open blockers or reports without an outcome.
 * Only when the heading was rewritten after the snapshot: old closed runs are not touched.
 */
export function forceCloseViolations(dataDir, taskDir) {
  const stagesPath = join(taskDir, 'STAGES.md')
  if (!existsSync(stagesPath)) return []
  const block = lastForceBlock(readFileSync(stagesPath, 'utf8'))
  if (!block || !CLOSED_WORD.test(block.heading)) return []
  const { lines } = baselineInfo(dataDir, taskDir)
  if (lines.has(fingerprint(block.heading))) return []
  if (WITH_BLOCKERS.test(block.heading)) return []
  const found = []
  const blockers = openBlockers(block.body)
  if (blockers.length) {
    found.push({
      rule: 'force-blockers',
      id: 'force',
      message: `Block "${block.heading.replace(/^## /, '')}": ${blockers.length} open blockers (${blockers[0].slice(0, 60)}…) — close it as "completed with blockers", they come first in the summary.`,
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
    console.error('Usage: node journal-check.mjs <task_dir>/<TICKET> [--ledger]   # --ledger — also the completeness of "Findings outcome" in all reports')
    process.exit(2)
  }
  const taskDir = resolve(target.endsWith('.md') ? join(target, '..') : target)
  const found = journalViolations(journalText(taskDir), reportNames(taskDir), taskDir)
  const stagesPath = join(taskDir, 'STAGES.md')
  const language = existsSync(stagesPath) ? taskLanguage(readFileSync(stagesPath, 'utf8')) : null
  const reports = reportNames(taskDir).flatMap((name) => {
    const path = join(taskDir, 'checks', name)
    // Summary and geometry are rules for new reports: old ones lack them by construction, without --ledger it is noise.
    const all = reportViolations(path, language).filter((violation) => args.includes('--ledger') || !['report-summary', 'no-geometry'].includes(violation.rule))
    return args.includes('--ledger') && reportChecker(name)
      ? [...all.filter((violation) => !violation.rule.startsWith('ledger-')), ...ledgerViolations(readFileSync(path, 'utf8'), name, { complete: true })]
      : all
  })
  const messages = [...new Set([...found, ...reports].map((violation) => violation.message))]
  for (const message of messages) console.log(`- ${message}`)
  if (!found.length && !reports.length) console.log('No violations of the criteria closing rules.')
  process.exit(found.length || reports.length ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
