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
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BASELINE_VERSION, baselineName, snapshotCurrent } from './baseline-file.mjs'
import {
  AUTH_LINE,
  BLOCKER_LIFTED,
  BLOCKER_LINE,
  CLOSED_WORD,
  DEAD_CODE_REMOVE,
  DOCTOR_LINE,
  LEDGER_HEADING,
  NO_VISUAL_REFERENCE,
  STAGE_FILE,
  SUMMARY_STANDARD,
  UNVERIFIED_HEADING,
  VISUAL_REFERENCE_FIELD,
  WITH_BLOCKERS,
  forceBlockBody,
  forceHeadings,
  forceKey,
  freshestForceHeading,
  headingDate,
  stageHeadingOf,
  stripQuoted,
} from './markers.mjs'
import { TASK_FILE_MAX, pluginDataDir, readDataFiles, reportNames, taskLanguage } from './hooks/pipeline-state.mjs'
import { NOT_A_FAIL, entryHead, entrySeverity, weakForm } from './dismissals.mjs'
import { decisionViolations } from './decisions.mjs'
import { languageMismatch } from './report-language.mjs'

const LIVE_CHECKERS = ['devtools-verify', 'figma-compare', 'proto-compare']
const AC_ID = /AC-\d/

/**
 * The text of a task file, or null: only a regular file (a symlink only when it resolves inside the task directory) of at most `TASK_FILE_MAX` bytes.
 * A committed `STAGES-ARCHIVE.md -> /dev/random` made every hook read until it was killed, and a symlink out of the task directory would put another file into the hook messages.
 */
export function readTaskFile(taskDir, ...segments) {
  const path = join(taskDir, ...segments)
  try {
    let target = path
    if (lstatSync(path).isSymbolicLink()) {
      target = realpathSync(path)
      const base = realpathSync(taskDir)
      if (!target.startsWith(base + sep)) return null
    }
    const stat = statSync(target)
    if (!stat.isFile() || stat.size > TASK_FILE_MAX) return null
    return readFileSync(target, 'utf8')
  } catch {
    return null
  }
}

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
  // `[live: user-side]` and "⏳ checker" are markers, written in backticks too: they are read from the whole outcome; the words of a decision — from the prose.
  const deferred = /\[live:/.test(outcome) || /решени[а-яё]* пользователя|user\s+decision/i.test(prose) || required.some((checker) => new RegExp(`⏳[^·;]*${checker}`).test(outcome))
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
export const LEGIT_REASON =
  /logic-only|нет\s+(дизайн|макет|figma|прототип)|дизайн-источник|источник|без визуал|визуал не меня|макет[а-яё]*\s+нет|figma\s+нет|\bno\s+(?:design|mockup|figma|prototype)|design\s+source|no\s+visual|visuals?\s+(?:are\s+)?unchanged/i

// A design checker skipped for a browser reason: live forms are `[skip: …]`, `(skip — …)`, `— skip (…)`, `skip: …`,
// including one shared by two checkers: "proto-compare and devtools-verify — skip: MCP-Chrome busy". After " · " the skip is someone else's.
/** The reason of a skip written after a checker name that ends at `from` in the line, or null when no skip stands there. */
export function skipReasonAfter(line, from) {
  const near = line.slice(from, from + 200)
  const skip = near.match(/^((?:(?!\s·\s)[^.;(\n]){0,50}?)[[(]?\s*skip(?:ped)?\b(?!=)\s*[:—–-]?\s*\(?\s*([^\])·;\n]*)/i)
  return skip ? skip[2].trim() : null
}

export function skipViolation(line) {
  for (const match of line.matchAll(/(figma-compare|proto-compare)/g)) {
    const reason = skipReasonAfter(line, match.index + match[0].length)
    if (reason === null) continue
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
// Words that also name what a checker opens ("page", "tab", "link") describe the interface only with a verb: "the tab is not opened again" is the interface, "settings page not checked" is a caveat.
const CONTROL = 'checkbox|box|toggle|radio|radio\\s+button|switch|option|row|item|drawer|modal|menu|dropdown|accordion|popover|sidebar'
const SURFACE = 'dialog|sheet|tab|window|page|link|panel|terms|consent|agreement'
const COPULA = '(?:is|are|was|were|stays|remains)\\s+'
// Placed after "not": on Node 22 (V8 12.4) a positive lookbehind at the head of an alternative turns off the start-position skip for the whole regexp,
// and every \s+ lookbehind in it then runs at every position — quadratic on long whitespace.
const UI_STATE = `(?<!\\b(?:${CONTROL})\\s+(?:${COPULA})?not)(?<!\\b(?:${SURFACE})\\s+${COPULA}not)`
// "Twice" after a verb describes the interface too ("the button is not opened twice"); "again" does not: "1024 was not checked again after the fix" is a caveat,
// and "the tab is not opened again" is already excluded by UI_STATE. Without a verb ("1024 not checked twice") both are caveats.
const NOT_OPENED =
  `\\bnot${UI_STATE}(?<!\\b${COPULA}not)\\s+(?:checked|opened)\\b(?!\\s+(?:by\\s+default|on\\s+load|initially|at\\s+first)\\b)|` +
  `\\bnot${UI_STATE}(?<=\\b${COPULA}not)\\s+(?:checked|opened)\\b(?!\\s+(?:by\\s+default|on\\s+load|initially|at\\s+first|twice|repeatedly|more\\s+than\\s+once)\\b)`
const CAVEAT_EN =
  `\\bnot\\s+(?:captured|verified|tested)\\b|\\b(?:is|are|was|were|left|stays?|remains?)\\s+(?:unverified|untested)\\b|\\b(?:unverified|untested)\\s*(?=[;,.)—–:]|$)|\\b(?:unverified|untested)\\s+(?:at|on|in|for|under|with|yet|so\\s+far)\\b|${NOT_OPENED}|\\b(?:did\\s+not|didn['’]t)\\s+(?:check|look|verify|open|capture)|\\b(?:from|by)\\s+code[- ]only\\b|\\(\\s*code[- ]only\\s*\\)|\\bonly\\s+(?:from|by|in)\\s+(?:the\\s+)?code\\b|\\bpart(?:ly|ially)\\b(?!\\s+(?:hidden|visible|covered|obscured|overlapped|collapsed|clipped|shown|open|expanded|loaded|filled|transparent))|\\b(?:could\\s+not|couldn['’]t|unable\\s+to)\\s+(?:verify|capture|open|view|check)`
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
const REF = /(?<![\w@./-])[\w@./-]+\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|scss|less|html?|md|py|go|rb|kt|swift|java|php|rs|cs)\b|https?:\/\/|node-?id|\b\d+[:-]\d+\b|`[^`\s]*\/[^`\s]*`/i
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
  const text = readTaskFile(taskDir, 'checks', match[2])
  if (text === null) return null
  const [violation] = ledgerViolations(text, match[2], { complete: true })
  return violation ?? null
}

/**
 * `[live: user-side]` without a reason. The plan used to pre-tag criteria this way, and the tag closed them: 46 such tags in one task, six defects among them
 * found by the user. A line that defers a criterion to the user must say what blocked the check and what the checker saw.
 * Honest form: `[live: user-side — <prerequisite>; <route> → <observed>]`, each of the three parts with content (`n/a`, `-`, `tbd`, `?` are not content).
 * EVERY line is read, with or without an `AC-*` id (a "Could not verify" line is `- /orders redirect — [live: user-side]`); a mention inside backticks is a quote, not a closure.
 */
const LIVE_PARTS = /^\[live:\s*user-side\s*[—–-]\s*([^;\]\n]*);([^→\]\n]*)→([^\]\n]*)\]/i
const EMPTY_PART = /^(?:n\/?a|tbd|todo|none|nil|unknown|-+|—+|–+|\?+)$/i
// The trailing dots are cut by an anchored run (a bare `[.\s]+$` backtracks from every dot of a long part).
const hasContent = (part) => (/[\p{L}\p{N}]/u.test(part) || /^\s*\//.test(part)) && !EMPTY_PART.test(part.trim().replace(/(?<![.\s])[.\s]+$/, ''))
export function liveViolation(line) {
  const open = line.replace(/`[^`\n]*`/g, (quote) => ' '.repeat(quote.length))
  if (!LIVE_TAG.test(open)) return null
  const bare = [...open.matchAll(new RegExp(LIVE_TAG.source, 'gi'))].some((match) => {
    const parts = open.slice(match.index, match.index + 2000).match(LIVE_PARTS)
    return !parts || !parts.slice(1).every(hasContent)
  })
  if (!bare) return null
  const id = line.match(/AC-[\w.]+/)?.[0]
  return {
    rule: 'live-bare',
    id: id ?? 'live',
    message:
      `${id ? `${id}: ` : ''}\`[live: user-side]\` without a reason (or with an empty part) defers the criterion and says nothing about what stopped the check. ` +
      'Write what was missing and what the checker saw: `[live: user-side — <prerequisite>; <route> → <observed>]`, for example ' +
      '`[live: user-side — the profile is not logged in; /orders → redirected to /login]`. Without evidence the criterion stays ⏳ devtools-verify.',
  }
}
const LIVE_TAG = /\[live:\s*user-side\b/i

export function journalViolations(text, reports = null, taskDir = null) {
  const lines = text
    .split('\n')
    .map((line) => {
      const violation =
        liveViolation(line) ?? acViolation(line, reports) ?? skipViolation(line) ?? caveatViolation(line) ?? noDataViolation(line) ?? likeViolation(line) ?? checkerLineViolation(line, taskDir)
      return violation && { ...violation, line: line.trim() }
    })
    .filter(Boolean)
  // VT-1 stage 5: an "Awaiting" line or a Force assumption without a rollback cost or a basis (decisions.mjs).
  return [...lines, ...decisionViolations(text)]
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
export const SUMMARY_LINE = /вердикт|итог|сводка|находк|findings|verdict|severity|🔴|🟠|^[^\S\n]*(?:[-*][^\S\n]*)?\**(?:critical|major)\**\s*:\s*\d|(?:critical|major|minor)[^\n]*(?:critical|major|minor)/i
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
// "can't be fixed", "cannot be fixed", "not yet fixed" and the Russian "cannot be fixed" — the word names what did not happen; it is not an outcome of fixing.
const NEGATED_FIXED = /(?:\bnot|n['’]t|\bcannot|\bcan\s+not)\s+(?:(?:be|been|yet|fully|completely|properly)\s+)*(?:fixed|removed|resolved|repaired)\b|(?<![а-яё])не\s+(?:(?:может|могут|будет|было)\s+(?:быть\s+)?)?(?:исправлен|починен|удал[её]н)/gi
// An outcome that opens with `false` or its Russian form (at the start of the line, after a dash, or the id): decided before any fixed word that follows it.
const FALSE_OUTCOME = /(?:^\s*(?:[-*]|\d+\.)?\s*|[—–]\s*|\s-\s+)(?:false|ложн[\wа-яё]*)\s*[:(—–-]/i
const refused = (text) => PARKED.test(text) || PARKED_FILE.test(text) || NOT_FIXED_YET.test(text)
// The description of a fix may say "later" or "keeping" about the code; only an explicit deferral of a remainder makes the outcome parked:
// "fixed: a.ts:1, fix the tests later", "fixed: a.ts:1 — the rest is out of scope", and the Russian forms.
const DEFERRED_REST =
  /\bwill\s+be\s+(?:fixed|resolved|addressed|done)\b|(?<!\bused\s)\bto\s+be\s+(?:fixed|resolved|addressed|done)\b|\b(?:fix(?:es|ing)?|do(?:ing)?|handle|handling|address(?:ing)?|cover(?:ing)?)\s+(?:\S+\s+){0,3}later\b|\brest\b[^.;]{0,40}\b(?:later|as\s+is)\b|separate\s+task|\bfollow-?up\s+(?:PR|MR|task|ticket|issue|commit|stage)\b|\b(?:in|into|to)\s+a\s+follow-?up\b|out\s+of\s+scope|\bleav(?:e|es|ing)\s+(?:it|this|that|them|as)\b|(?:исправим|починим|поправим)(?![а-яё])|будет\s+(?:исправлен|починен)|отдельн[а-яё]{0,4}\s+задач|вне\s+(?:скоуп|границ)|остальн[а-яё]{0,4}[^.;]{0,40}(?:позже|потом)(?![а-яё])|оставля[а-яё]{0,4}\s+как\s+есть/i
// The forbidden outcomes of references/checker-report.md that cannot describe code, and a short "<one or two words> later" closing the clause ("— tests later").
const REFUSED_REST =
  /компромисс|\bcompromise\b|\bwon['’]?t\s+fix|не\s+чин|(?:в|to|into)\s+findings\b|вопрос[а-яё]*\s+(?:к\s+)?(?:продукт|дизайн|бэкенд|backend|ревьюер|qa)|question\s+(?:for|to)\s+(?:the\s+)?(?:product|design|backend|reviewer|qa)\b|принят[а-яё]*\s+как|accepted\s+as\b|ожида[а-яё]*\s+подтвержд|awaiting\s+(?:user\s+)?confirmation|не\s+в\s+скоуп|not\s+in\s+scope|outside\s+(?:the\s+)?(?:scope|boundaries)|в\s+кит(?![а-яё])|(?:to|into)\s+the\s+kit\b|(?:^|[—–,]\s*)(?:[^\s.;,—–]+\s+){0,2}(?:later|afterwards|позже|потом)\s*$/i
const deferredRest = (text) => DEFERRED_REST.test(text) || REFUSED_REST.test(text) || PARKED_FILE.test(text)
/** The wording of an outcome: the clause up to the first ":" or dash after the outcome word ("fixed: a.ts:10 — the promise is not resolved twice" → "fixed"). The description of the fix is not the outcome. */
function outcomeHead(clause) {
  const word = FIXED_WORD.exec(clause)
  if (!word) return clause
  const end = word.index + word[0].length
  const cut = clause.slice(end).search(/:|\s[—–-]\s/)
  return cut === -1 ? clause : clause.slice(0, end + cut)
}

/**
 * The outcome of one "Findings outcome" line: fixed | false | blocker | user — an outcome; parked | unproven | unknown — none.
 * With `strict` (VT-1 stage 5, reports new on this version) a `false` whose reason is a weak form (dismissals.mjs: "the fix is impossible", "not reproduced" without
 * two attempts and the route, a plan line instead of code, ...) is `weak` — none either.
 */
export function disposition(entry, { strict = false } = {}) {
  const proven = PRE_EXISTING.test(entry) && BASE_EVIDENCE.test(entry)
  if (PRE_EXISTING.test(entry) && !proven) return 'unproven'
  // Code and quotes are identifiers and copy; a refusal is looked for in the head of the outcome and in the clauses after ";" ("fixed: a.ts:1; fix the tests later"),
  // in the description of the fix — only an explicit deferral of a remainder ("fixed: a.ts:1, fix the tests later").
  const [first, ...rest] = stripQuoted(entry).split(';')
  const head = outcomeHead(first)
  if ((refused(head) || deferredRest(first.slice(head.length)) || rest.some(refused)) && !proven) return 'parked'
  const fixedAt = entry.replace(NEGATED_FIXED, (found) => ' '.repeat(found.length)).search(FIXED_WORD)
  const falseAt = entry.search(FALSE_OUTCOME)
  if (fixedAt !== -1 && !(falseAt !== -1 && falseAt < fixedAt)) return 'fixed'
  if (proven || /ложн|не\s+подтвердил|не\s+воспроизв|(?:^\s*(?:[-*]|\d+\.)?\s*|[—–]\s*|\s-\s+)false\s*[:(]|\bfalse\s+positive\b|\bnot\s+confirmed\b|\b(?:could\s+not|couldn['’]t|cannot|unable\s+to)\s+reproduce|\bnot\s+reproduc(?:ed|ible)/i.test(entry)) return strict && weakForm(entry) ? 'weak' : 'false'
  if (/\bB\d+\b/.test(entry)) return 'blocker'
  if (/(?:решени[а-яё]*\s+пользователя|user\s+decision|user\s+decided)[^\n]{0,200}?(?:«|"|“|\d{2}\.\d{2}|\d{4}-\d{2})/i.test(entry)) return 'user'
  return 'unknown'
}

export function ledgerEntries(text) {
  const start = text.search(LEDGER_HEADING)
  if (start === -1) return null
  const body = text.slice(start).split('\n').slice(1)
  const end = body.findIndex((line) => /^#{1,3}\s/.test(line))
  // An entry is a line of prose with its proof: past LEDGER_ENTRY_MAX characters the phrase heuristics are not run on the rest (a pasted blob cannot stall a hook).
  return (end === -1 ? body : body.slice(0, end)).filter((line) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line)).map((line) => line.trim().slice(0, LEDGER_ENTRY_MAX))
}
const LEDGER_ENTRY_MAX = 4000

const ACCEPTED = new Set(['fixed', 'false', 'blocker', 'user'])
export const LEDGER_DOC = 'references/checker-report.md'

// A critical dismissed as false goes through a fresh pass on `review_model` (stage-check Step 3.3), and its line cites that report. The name is found among the
// words of the line, not by a regexp over it: `[\w.-]*fresh[\w.-]*` backtracked cubically on a long token and stalled the hooks past their timeouts.
// A word is a run of `[\w.-]` (`checks/pro-review-3-fresh.md.` gives `pro-review-3-fresh.md`), the alphabet the old capture group had.
const citedFresh = (entry) =>
  entry
    .split(/[^\w.-]+/)
    .map((word) => word.replace(/(?<!\.)\.+$/, ''))
    .find((word) => word.length <= 120 && word.endsWith('.md') && /fresh/i.test(word))
/** Why a `false` line on a critical finding does not stand: no fresh report is cited, or the cited one is not in `checks/`. `null` — it stands (or the finding is not a critical). */
function criticalWithoutFresh(entry, text, name, taskDir) {
  if (entrySeverity(entry, text) !== 'critical') return null
  const cited = citedFresh(entry)
  // The fresh report belongs to the dismissed finding's checker and stage: `pro-review-3.md` is confirmed by `pro-review-3-fresh*.md`, not by any `*-fresh*.md` of the task.
  const checker = reportChecker(name)
  const token = checker ? name.slice(name.indexOf(checker) + checker.length).match(/^-([\w]+?)(?=[-.]|$)/)?.[1] : null
  const expected = checker ? `${checker}${token ? `-${token}` : ''}` : null
  const ownFresh = cited && (!expected || cited.startsWith(`${expected}-`))
  const shown = entry.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').slice(0, 90)
  if (ownFresh && cited !== name && (!taskDir || existsSync(join(taskDir, 'checks', cited)))) return null
  return (
    `checks/${name}: "${shown}" — a critical dismissed as false must go through a fresh pass on review_model (stage-check, Step 3.3) and the line must cite that report ` +
    `("false: … — fresh report checks/<checker>-<stage>-fresh.md")${cited && !ownFresh ? `; checks/${cited} is not the fresh report of ${name} (expected ${expected}-fresh*.md)` : cited ? `; checks/${cited} does not exist` : ''}.`
  )
}

/**
 * Dismissals for the full digest: every `false` line on a critical or major finding or on a FAIL (an `AC-*` line or one that names FAIL), verbatim, with its checker.
 * `reports` is `[{ name, text }]`. A line that uses `false` for a criterion that did not fail ("not a FAIL" and its Russian form) is marked `notFinding`.
 */
export function collectDismissals(reports) {
  return reports.flatMap(({ name, text }) => {
    const checker = reportChecker(name)
    if (!checker) return []
    return (ledgerEntries(text) ?? []).flatMap((entry) => {
      if (disposition(entry) !== 'false') return []
      const severity = entrySeverity(entry, text)
      const fail = /^\**AC-\d/.test(entryHead(entry).trim()) || /\bFAIL\b/.test(entry)
      if (severity !== 'critical' && severity !== 'major' && !fail) return []
      return [{ name, checker, severity, fail, notFinding: fail && NOT_A_FAIL.test(entry), line: entry.replace(/^\s*(?:[-*]|\d+\.)\s+/, '') }]
    })
  })
}

/**
 * Violations of the findings outcome in a report: a forbidden outcome ("leaving it", "to Awaiting"), a "pre-existing" claim without proof
 * on the base, an unrecognised outcome; with `complete` also fewer outcomes than critical + major (or FAIL, if there are more).
 */
export function ledgerViolations(text, name, { complete = false, strict = false, taskDir = null } = {}) {
  const entries = ledgerEntries(text) ?? []
  const shown = (entry) => entry.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').slice(0, 90)
  const found = []
  for (const entry of entries) {
    const kind = disposition(entry, { strict })
    if (strict && kind === 'false') {
      const critical = criticalWithoutFresh(entry, text, name, taskDir)
      if (critical) {
        found.push({
          rule: 'ledger-critical-fresh',
          id: name,
          shown: shown(entry),
          message: critical,
        })
      }
    }
    if (kind === 'weak') {
      const { form, need } = weakForm(entry)
      found.push({
        rule: 'ledger-weak',
        id: name,
        form,
        shown: shown(entry),
        message: `checks/${name}: "${shown(entry)}" — a dismissal without a proof (${form}). It needs ${need}. Otherwise the finding stands: fix it, raise it as a blocker B<n> or take a user decision (${LEDGER_DOC}).`,
      })
    } else if (kind === 'parked') {
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
  const accepted = entries.filter((entry) => ACCEPTED.has(disposition(entry, { strict }))).length
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
export function runtimeViolations(text, name, taskDir = null, fresh = false) {
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
  // New reports (not in the snapshot) carry the environment line and the login line: which app answered and whether the browser was logged in.
  if (fresh) {
    for (const [pattern, line, what] of [
      [DOCTOR_LINE, 'doctor: <the line verify-doctor printed>', 'which app answered on the dev URL (`node ${CLAUDE_PLUGIN_ROOT}/scripts/verify-doctor.mjs`)'],
      [AUTH_LINE, 'auth: ok | not logged in — <route> → <observed> | not needed', 'whether the managed browser was logged in'],
    ]) {
      if (!pattern.test(text))
        found.push({
          rule: 'no-doctor',
          id: name,
          message: `checks/${name}: no \`${line.split(':')[0]}:\` line — ${what}. A runtime check that does not say which app it looked at can be green about another worktree's server (skill devtools-verify, "Preconditions" and "Auth gate"). The task language form is in references/language.md.`,
        })
    }
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
export function reportViolations(path, language = null, { fresh = false, strict = false } = {}) {
  const text = readTaskFile(dirname(path), basename(path))
  if (text === null) return []
  const name = basename(path)
  // The honest live form is a rule for reports written after it came in: `fresh` is set by the hook for a report that is not in the snapshot.
  const bare = fresh ? text.split('\n').map(liveViolation).find(Boolean) : null
  return [bare && { ...bare, message: `checks/${name}: ${bare.message}` }, languageViolation(text, name, language), reportViolation(path, text), summaryViolation(text, name), ...ledgerViolations(text, name, { strict, taskDir: dirname(dirname(path)) }), ...runtimeViolations(text, name, dirname(dirname(path)), fresh)].filter(Boolean)
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

export { reportNames }

export function reportViolation(path, text = readTaskFile(dirname(path), basename(path))) {
  if (text === null) return null
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
    .map((name) => readTaskFile(taskDir, name))
    .filter((text) => text !== null)
    .join('\n')
}

const baselinePath = (dataDir, taskDir) => join(dataDir, baselineName(taskDir))

function readBaseline(dataDir, taskDir) {
  // The main data directory first, then the bare `stage-pipeline` one (where scripts from Bash used to write).
  for (const text of readDataFiles(dataDir, baselineName(taskDir))) {
    try {
      return JSON.parse(text)
    } catch {
      // a broken snapshot — try the next one
    }
  }
  return null
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

/** Fingerprints of the Force headings that are already closed: a run closed before the snapshot is an old one — its gates and its summary are not checked after the fact. */
const closedForceFingerprints = (taskDir) =>
  forceHeadings(journalText(taskDir))
    .filter(([heading]) => CLOSED_WORD.test(heading))
    .map(([heading]) => fingerprint(heading))

/**
 * Snapshot v2 — all journal lines and the moment from which reports are checked for a findings outcome (`ledgerSince`).
 * Snapshot v1 (0.12–0.13) kept only lines with ✅ and skip: at the first look of a new version all current lines are
 * added to it, except 0.12 violations that appeared after the snapshot — those keep reminding about themselves. `reports` are the names of reports caught at the first look: the language is checked only for reports outside this set
 * (the file path and creation time are unreliable: Edit replaces a file through rename). Reports written before that moment do not need an outcome: a task in progress
 * does not have to rewrite closed stages. `ledgerOld` are the reports there at the 0.18 migration (the 0.18 report rules, stages 4 and 5 of VT-1), `since018` and `forceSeen` —
 * the day of that migration and the Force headings there then, dated before that day (`releaseGate`).
 */
export function baselineInfo(dataDir, taskDir) {
  const data = readBaseline(dataDir, taskDir)
  const info = (snapshot) => ({
    lines: new Set(snapshot.lines),
    ledgerSince: snapshot.ledgerSince,
    reports: new Set(snapshot.reports),
    ledgerOld: new Set(snapshot.ledgerOld),
    since: snapshot.since018,
    forceSeen: new Set(snapshot.forceSeen),
  })
  if (data?.version === BASELINE_VERSION) {
    if (snapshotCurrent(data)) {
      return info(data)
    }
    // A snapshot v2 from an earlier version: what is there now is old for each rule that came after it (a lazy migration, once per rule — a rule whose mark
    // is already there keeps its set, so a line written after that earlier migration is not made old by this one).
    const text = journalText(taskDir)
    const since018 = typeof data.since018 === 'string' ? data.since018 : localDate()
    const migrated = {
      ...data,
      reports: Array.isArray(data.reports) ? data.reports : reportNames(taskDir),
      closedSeen: true,
      liveSeen: true,
      dismissSeen: true,
      // VT-1 0.18 (D7): the reports already there are old for the 0.18 report rules — the stage 4 ones (a bare `[live: user-side]`, the `doctor:` / `auth:` lines)
      // and the stage 5 ones (weak dismissals, a critical needs a fresh report); only a report written after this migration is judged by them.
      ledgerOld: Array.isArray(data.ledgerOld) ? data.ledgerOld : reportNames(taskDir),
      // The day of this migration and the Force runs already open or closed, dated before it: the receipts rules and the ticket-titled rule apply only to a run
      // opened after them (`releaseGate`).
      since018,
      forceSeen: Array.isArray(data.forceSeen) ? data.forceSeen : forceKeysBefore(text, since018),
      lines: [
        ...new Set([
          ...data.lines,
          ...(data.closedSeen ? [] : closedForceFingerprints(taskDir)),
          // bare `[live: user-side]` lines written under 0.16 before the live-bare rule are old: only those, so any other new line still goes through all the rules
          ...(data.liveSeen ? [] : journalCandidates(text).filter((line) => liveViolation(line)).map(fingerprint)),
          // the Awaiting and assumption lines without a rollback cost or a basis that are already there are old
          ...(data.dismissSeen ? [] : decisionViolations(text).map(({ line }) => fingerprint(line))),
        ]),
      ],
    }
    writeBaseline(dataDir, taskDir, migrated)
    return info(migrated)
  }
  const now = Date.now()
  const text = journalText(taskDir)
  const current = journalCandidates(text)
  const old = new Set(data?.lines ?? [])
  const lines = data
    ? [...old, ...current.filter((line) => old.has(fingerprint(line)) || !legacyViolation(line)).map(fingerprint)]
    : current.map(fingerprint)
  const next = {
    taskDir,
    created: data?.created ?? new Date(now).toISOString(),
    version: BASELINE_VERSION,
    ledgerSince: now,
    lines: [...new Set([...lines, ...closedForceFingerprints(taskDir)])],
    reports: reportNames(taskDir),
    closedSeen: true,
    liveSeen: true,
    dismissSeen: true,
    ledgerOld: reportNames(taskDir),
    since018: localDate(new Date(now)),
    forceSeen: forceKeysBefore(text, localDate(new Date(now))),
  }
  writeBaseline(dataDir, taskDir, next)
  return info(next)
}

/** The day in the local calendar (`2026-10-19`): Force headings carry local dates. */
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
/**
 * The Force runs a first look records as already there: only the headings dated before that day. The look is lazy (the first hook that reads the task),
 * so it can be the very edit that writes `## Force run <today>` — that block, an undated one and a second run opened on the migration day are new runs (fail closed).
 */
const forceKeysBefore = (text, day) => [...new Set(forceHeadings(text).map(([heading]) => forceKey(heading)))].filter((key) => (headingDate(key) ?? '9999') < day)

/**
 * The per-task release gate of the 0.18 rules that are keyed on a Force block (stage receipts, the close needing fresh final reviews, the ticket-titled commits after a close):
 * `{ since, seen }` for `ruleAppliesToBlock` (markers.mjs) — the day this version first saw the task and the Force headings already there and dated before that day.
 * A run that was open or closed then keeps the rules it started with (D7), whatever the release date; a run opened later, on that day or undated, gets them.
 */
export function releaseGate(dataDir, taskDir) {
  const { since, forceSeen } = baselineInfo(dataDir, taskDir)
  return { since, seen: forceSeen }
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
  const { ledgerSince, ledgerOld } = baselineInfo(dataDir, taskDir)
  return newReports(taskDir, ledgerSince).flatMap((name) =>
    ledgerViolations(readTaskFile(taskDir, 'checks', name) ?? '', name, { complete: true, strict: !ledgerOld.has(name), taskDir }),
  )
}

/** The freshest "Force run" block (the latest date, not the last in the file — `freshestForceHeading`): the heading and the text up to the next section. */
export function lastForceBlock(stages) {
  const heading = freshestForceHeading(stages)
  if (!heading) return null
  return { heading: heading[0], body: forceBlockBody(stages, heading) }
}

// A blocker `B<n> — …` without a mark that the user lifted it. A blocker also stands on the `Blockers:` field line itself (the Russian field name too),
// and several of them can follow each other there ("Blockers: B1 — … B7 — …"): each one is an item of its own, and the lift mark is looked for in its own text.
const BLOCKERS_FIELD = /^[^\S\n]*(?:[-*][^\S\n]*)?\**(?:Блокеры|Blockers)\**\s*:\s*(\S.*)$/i
// One mark for the whole field: "both lifted", "all lifted" (the Russian plural forms too), or "lifted …". It counts only in the head of the field, before the first
// `B<n>` ("Blockers: lifted on 2026-10-14. B1 — …"), or as the closing phrase of the line ("B1 — …; B2 — … — both lifted by the user 2026-10-14."). A mark in the middle of an item
// ("B1 — CI red, all closed issues reopened") is that item's own words. A negation anywhere in the head ("not all", the Russian "not all" and "none of them") takes the mark back.
const FIELD_LIFTED =
  /(?<![а-яё])(?:(?:оба|обе|все)\s+)?(?:сняты|закрыты|решены)(?![а-яё])|\b(?:both|all)(?:\s+of\s+them)?\s+(?:are\s+|were\s+)?(?:lifted|closed|resolved|answered)\b|^(?:all\s+)?(?:lifted|closed|resolved)\b/i
const FIELD_NEGATED =
  /(?<![а-яё])(?:не|ни|частичн[а-яё]*)(?![а-яё])|\b(?:not|none|no|never|neither|partly|partially|in\s+part)\b/i
const FIELD_ITEM = /(?<![\w*])\**B\d+/
// The tail after the closing mark: the same words and answers as the user-answer markers of `markers.mjs` ("by the user", "in chat", "user decision <date>", a date
// in both formats, a quote), each token behind its own separator, so it stays linear on long runs of spaces.
const CLOSING_TAIL_WORD = '(?:by|on|in|the|user|users|answers?|decision|interview|chat|пользователем|пользователя|пользователю|ответом|ответами|решением|решение|интервью|в|по|от|чате)'
const CLOSING_TAIL_TOKEN = `(?:${CLOSING_TAIL_WORD}(?![\\wа-яё])|\\d{4}-\\d{2}-\\d{2}|\\d{2}\\.\\d{2}\\.\\d{2,4}|«[^»\\n]{0,80}»|"[^"\\n]{0,80}"|“[^”\\n]{0,80}”)`
const FIELD_CLOSING_MARK = '(?:оба|обе|все|both|all)(?:\\s+of\\s+them)?\\s+(?:are\\s+|were\\s+)?(?:сняты|закрыты|решены|lifted|closed|resolved|answered)(?![\\wа-яё])'
const FIELD_CLOSING = new RegExp(`^${FIELD_CLOSING_MARK}(?:,?\\s+${CLOSING_TAIL_TOKEN})*$`, 'i')
// "Not all closed", "closed not all": a lift word under a negation of the whole group lifts nothing, in the field head and in an item alike.
const GROUP_NEGATION =
  /(?:(?<![а-яё])не\s+(?:все|оба|обе)|(?:сняты|закрыты|решены)\s+не\s+все|(?<![а-яё])ни\s+один[а-яё]*|\bnot\s+(?:all|both)\b)(?![а-яё])(?:\s+(?:сняты|закрыты|решены|lifted|closed|resolved|answered)(?![а-яё\w]))?/gi
const fieldLifted = (field) => {
  const item = field.search(FIELD_ITEM)
  const head = item < 0 ? field : field.slice(0, item)
  // A mark in the head is one for the whole field only as a finished phrase ("lifted on 2026-10-14. B1 — …"): "lifted B1, B3; B2 — …" lists the lifted ones, it is not a mark for B2.
  if (FIELD_LIFTED.test(head) && !FIELD_NEGATED.test(head) && (item < 0 || /[.;]$/.test(head.trimEnd()))) return true
  if (item < 0) return false
  // A loop, not `/[\s.;]+$/`: that one is quadratic on a long run of spaces in the middle of the line.
  let end = field.length
  while (end > 0 && /[\s.;]/.test(field[end - 1])) end--
  // The last piece: after a dash or after a sentence end ("; ", ". "), not after the dots of a date ("14.10.2026").
  const last = field.slice(0, end).split(/[.;](?=\s)|[—–]/).pop().trim()
  return FIELD_CLOSING.test(last)
}
/** Every blocker line of a block body, whether lifted or open (a field the whole of which is lifted is left out). */
export const blockerLines = (body) =>
  body
    .split('\n')
    .flatMap((line) => {
      const field = line.match(BLOCKERS_FIELD)
      if (field && fieldLifted(field[1])) return []
      return field ? field[1].replace(/([.;])\s+(?=B\d+\s*[—–:-])/g, '$1\n').split('\n') : [line]
    })
    .filter((line) => BLOCKER_LINE.test(line))
    .map((line) => line.trim())
export const openBlockers = (body) => blockerLines(body).filter((line) => !BLOCKER_LIFTED.test(line.replace(GROUP_NEGATION, ' ')))

/**
 * Closing a force run as "completed" (without "with blockers") with open blockers or reports without an outcome.
 * Only when the heading was rewritten after the snapshot: old closed runs are not touched.
 */
export function forceCloseViolations(dataDir, taskDir) {
  const stages = readTaskFile(taskDir, 'STAGES.md')
  if (stages === null) return []
  const block = lastForceBlock(stages)
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
  const stages = readTaskFile(taskDir, 'STAGES.md')
  const language = stages === null ? null : taskLanguage(stages)
  // The stage 5 rules (weak dismissals, a critical needs a fresh report) apply to reports that were not there at the first look: the same `ledgerOld` as the hook reads.
  // Read-only (a manual run writes no snapshot); with no snapshot yet every report counts as new.
  const ledgerOld = new Set(readBaseline(pluginDataDir(), taskDir)?.ledgerOld ?? [])
  const reports = reportNames(taskDir).flatMap((name) => {
    const path = join(taskDir, 'checks', name)
    const strict = !ledgerOld.has(name)
    // Summary and geometry are rules for new reports: old ones lack them by construction, without --ledger it is noise.
    const all = reportViolations(path, language, { strict }).filter((violation) => args.includes('--ledger') || !['report-summary', 'no-geometry'].includes(violation.rule))
    return args.includes('--ledger') && reportChecker(name)
      ? [...all.filter((violation) => !violation.rule.startsWith('ledger-')), ...ledgerViolations(readTaskFile(taskDir, 'checks', name) ?? '', name, { complete: true, strict, taskDir })]
      : all
  })
  const messages = [...new Set([...found, ...reports].map((violation) => violation.message))]
  for (const message of messages) console.log(`- ${message}`)
  if (!found.length && !reports.length) console.log('No violations of the criteria closing rules.')
  process.exit(found.length || reports.length ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
