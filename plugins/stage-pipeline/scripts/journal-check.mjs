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
import { existsSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BASELINE_VERSION, baselineName, snapshotCurrent } from './baseline-file.mjs'
import {
  AUTH_LINE,
  MAP_LINE,
  blockerFieldApplies,
  BLOCKER_LIFTED,
  blockerLiftField,
  subItemLiftField,
  withoutRefusedLiftFields,
  BLOCKER_LINE,
  INTERVIEW_FIELD,
  PLAIN_BLOCKER_LINE,
  CLOSED_WORD,
  DEAD_CODE_REMOVE,
  DOCTOR_LINE,
  EFFECT_NEXT_TO_VERIFY,
  LEDGER_HEADING,
  NO_VISUAL_REFERENCE,
  READBACK_PROOF,
  REQUEST_PROOF,
  PARTIAL_RUN,
  RERUN_SCREEN,
  RERUN_SUFFIX,
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
import { pluginDataDir, readDataFiles, readTaskFile, reportNames, taskFile, taskLanguage, unreadableMessage } from './hooks/pipeline-state.mjs'
import { NOT_A_FAIL, entryHead, entrySeverity, findingRows, weakForm } from './dismissals.mjs'
import { decisionViolations } from './decisions.mjs'
import { languageMismatch } from './report-language.mjs'

const LIVE_CHECKERS = ['devtools-verify', 'figma-compare', 'proto-compare']
const AC_ID = /AC-\d/

/**
 * Task files go through one bounded reader (pipeline-state `readBounded`): a regular file of at most `TASK_FILE_MAX` bytes whose real path lies inside the real task directory.
 * A file that is there but refused (too large, a link out of the task, not a regular file) is not "empty": the rules that need it count it as open (`unreadableViolation`).
 */
export { readTaskFile, taskFile }

/** The violation of a task file that is there but cannot be read: the gates refuse with it (S-2 of the 5c review: a 4 MB log pasted into a report turned an open critical into an all-clear). */
export const unreadableViolation = (file, read) => ({ rule: 'file-unreadable', id: file, problem: read.problem, message: unreadableMessage(file, read) })

/** A report path as the task sees it: `<task>/checks/<name>` is read inside the task directory (a `checks/` directory linked out of it is refused), any other path inside its own directory. */
const reportRead = (path) => (basename(dirname(path)) === 'checks' ? taskFile(dirname(dirname(path)), 'checks', basename(path)) : taskFile(dirname(path), basename(path)))

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
  const read = taskFile(taskDir, 'checks', match[2])
  if (read.problem === 'missing') return null
  if (read.problem) return unreadableViolation(`checks/${match[2]}`, read)
  const [violation] = ledgerViolations(read.text, match[2], { complete: true })
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
// A count starts where its digit run starts (`(?<!\d)`): from inside a long run the same match fails again, and every start in it made the scan quadratic.
const severityPatterns = (words) => [new RegExp(`(?<!\\d)(\\d+)\\s*\\**\\s*(?:${severityWord(words)})`, 'i'), new RegExp(`(?:${severityWord(words)})\\**\\s*:?\\s*(\\d+)`, 'i')]
const DEAD_CODE_COUNT = new RegExp(`(?<!\\d)${DEAD_CODE_REMOVE.source}`, DEAD_CODE_REMOVE.flags)
// The count patterns put optional `\s*` and `\**` side by side, which backtracked polynomially on a long run: `| 🔴` + 250 spaces in a table row took 80 s,
// past the timeout of every hook, and the force commit went through unchecked. So a line is read flat: a run of spaces and asterisks is one character
// (`*` when it holds one), and only its first COUNT_LINE_MAX characters count. The summary forms read the same (checked on 1 182 live reports).
const COUNT_LINE_MAX = 2000
const countLine = (line) => line.replace(/[\s*]+/g, (run) => (run.includes('*') ? '*' : ' ')).slice(0, COUNT_LINE_MAX)

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
    major: [/🟠\s*\**\s*(?:major)?\s*\**\s*:?\s*(\d+)/i, ...severityPatterns(security ? ['major', 'medium'] : ['major']), DEAD_CODE_COUNT],
    minor: [/🟡\s*\**\s*(?:minor)?\s*\**\s*:?\s*(\d+)/i, /(?<!\d)(\d+)\s*\**\s*minor/i, /(?<![\w-])minor\**\s*:?\s*(\d+)/i, ...(security ? severityPatterns(['low']) : [])],
  }
  const summary = { critical: null, major: null, minor: null }
  for (const line of lines.slice(0, 30).map(countLine)) {
    if (!SUMMARY_LINE.test(line) || !/\d/.test(line)) continue
    for (const key of ['critical', 'major', 'minor']) {
      const found = patterns[key].map((pattern) => line.match(pattern)).find(Boolean)
      if (found) summary[key] = Math.max(summary[key] ?? 0, Number(found[1]))
    }
  }
  if (summary.critical !== null || summary.major !== null) return { critical: summary.critical ?? 0, major: summary.major ?? 0, minor: summary.minor ?? 0, summary: true }
  const cell = new RegExp(`\\|\\s*\\**(${security ? 'critical|high|major|medium' : 'critical|major'})\\**\\s*\\|`, 'i')
  const rows = { critical: 0, major: 0, minor: 0, summary: false }
  for (const line of lines.map(countLine)) {
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
  for (const raw of text.split('\n')) {
    // A line with FAIL is read with its whitespace runs flat: `was(?:\s+previously)?\s*` is quadratic on a long run of spaces (1.3 s at 50 000).
    const line = /\bFAIL\b/.test(raw) ? raw.replace(/\s+/g, ' ') : ''
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
function criticalWithoutFresh(entry, severity, name, taskDir) {
  if (severity !== 'critical') return null
  const cited = citedFresh(entry)
  // The fresh report belongs to the dismissed finding's checker and stage: `pro-review-3.md` is confirmed by `pro-review-3-fresh*.md`, not by any `*-fresh*.md` of the task.
  const expected = ownReport(name)
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
    const rows = findingRows(text)
    return (ledgerEntries(text) ?? []).flatMap((entry) => {
      if (disposition(entry) !== 'false') return []
      const severity = entrySeverity(entry, rows)
      const fail = onFail(entry)
      if (severity !== 'critical' && severity !== 'major' && !fail) return []
      return [{ name, checker, severity, fail, notFinding: fail && NOT_A_FAIL.test(entry), line: entry.replace(/^\s*(?:[-*]|\d+\.)\s+/, '') }]
    })
  })
}

/** A ledger line on a failed criterion: an `AC-*` id in its head or the word FAIL ("not a FAIL" is a criterion that passed). */
const onFail = (entry) => /^\**AC-\d/.test(entryHead(entry).trim()) || /\bFAIL\b/.test(entry)

/**
 * Violations of the findings outcome in a report: a forbidden outcome ("leaving it", "to Awaiting"), a "pre-existing" claim without proof
 * on the base, an unrecognised outcome; with `complete` also fewer outcomes than critical + major (or FAIL, if there are more).
 * A violation of one line carries the `severity` of the finding it closes (`entrySeverity`, null when unknown) and `fail` (the line is on a failed criterion):
 * the digest counts a report not ready for PR by them, not by the number of outcome lines — a fixed minor does not stand in for a dismissed critical.
 */
export function ledgerViolations(text, name, { complete = false, strict = false, taskDir = null } = {}) {
  const entries = ledgerEntries(text) ?? []
  const shown = (entry) => entry.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').slice(0, 90)
  let rows = null
  const severityOf = (entry) => entrySeverity(entry, (rows ??= findingRows(text)))
  const lineOf = (entry) => ({ shown: shown(entry), severity: severityOf(entry), fail: onFail(entry) && !NOT_A_FAIL.test(entry) })
  const found = []
  for (const entry of entries) {
    const kind = disposition(entry, { strict })
    if (strict && kind === 'false') {
      const critical = criticalWithoutFresh(entry, severityOf(entry), name, taskDir)
      if (critical) {
        found.push({
          rule: 'ledger-critical-fresh',
          id: name,
          ...lineOf(entry),
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
        ...lineOf(entry),
        message: `checks/${name}: "${shown(entry)}" — a dismissal without a proof (${form}). It needs ${need}. Otherwise the finding stands: fix it, raise it as a blocker B<n> or take a user decision (${LEDGER_DOC}).`,
      })
    } else if (kind === 'parked') {
      found.push({
        rule: 'ledger-parked',
        id: name,
        ...lineOf(entry),
        message: `checks/${name}: "${shown(entry)}" — this is a decision not to fix, and the user makes it. The outcome is fixed, false (with proof) or blocker B<n> (${LEDGER_DOC}).`,
      })
    } else if (kind === 'unproven') {
      found.push({
        rule: 'ledger-unproven',
        id: name,
        ...lineOf(entry),
        message: `checks/${name}: "${shown(entry)}" — "pre-existing" without proof on the base. Check on the base sha or on prod and write down the measurement, otherwise it is a finding of the task.`,
      })
    } else if (kind === 'unknown') {
      found.push({
        rule: 'ledger-unknown',
        id: name,
        ...lineOf(entry),
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
export function runtimeViolations(text, name, taskDir = null, fresh = false, map = false) {
  if (reportChecker(name) !== 'devtools-verify' || /\bskip\b/i.test(text.split('\n').slice(0, 5).join(' '))) return []
  const found = []
  // A stage with a "Visual reference" — a typography comparison with a neighbouring section: the prototype matched the code, and "too bold" and "different buttons"
  // the user saw next to the rest of the dashboard.
  const partial = PARTIAL_RUN.test(name)
  const reference = !partial && taskDir && stageReference(taskDir, name)
  if (reference && !/^[ \t]*(?:[-*][ \t]*)?`?style-diff\b/im.test(text)) {
    found.push({
      rule: 'no-style-diff',
      id: name,
      message:
        `checks/${name}: the stage has a "Visual reference" (${reference.slice(0, 60)}), but there are no \`style-diff <width>: roles N · differ N\` lines — compare the typography, buttons and tables ` +
        'of the new section with the reference one (skill devtools-verify, step "Visual reference"). A difference without a user decision is a major finding.',
    })
  }
  // a recheck (`-r<k>`) and a repro report look at the findings they were asked about: the geometry rules stay with the full runs; `doctor:` and `auth:` below apply to both
  if (!partial && !/^[ \t]*(?:[-*][ \t]*)?`?geometry\b/im.test(text)) {
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
  // VT-4 0.20 (stage 8): a repo with the verify map README (`map`, set by the hook) gets the `map:` line in a new full report (a recheck/repro keeps only `doctor:` and `auth:`); a repo without one is untouched.
  if (fresh && map && !partial && !MAP_LINE.test(text))
    found.push({
      rule: 'no-map',
      id: name,
      message:
        `checks/${name}: no \`map:\` line — this repo has a verify map (\`verify_map:\` README), so the report says \`map: <ids> · entries a/b · drift N\` or, for a stage whose routes have no map entry, ` +
        '`map: none — <route> unmapped` (skill devtools-verify, "Verify map"; the task language form is in references/language.md).',
    })
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
export function reportViolations(path, language = null, { fresh = false, strict = false, map = false, v020 = false } = {}) {
  const read = reportRead(path)
  const name = basename(path)
  if (read.problem === 'missing') return []
  if (read.problem) return [unreadableViolation(`checks/${name}`, read)]
  const { text } = read
  // The honest live form is a rule for reports written after it came in: `fresh` is set by the hook for a report that is not in the snapshot.
  const bare = fresh ? text.split('\n').map(liveViolation).find(Boolean) : null
  return [bare && { ...bare, message: `checks/${name}: ${bare.message}` }, languageViolation(text, name, language), reportViolation(path, text), summaryViolation(text, name), ...ledgerViolations(text, name, { strict, taskDir: dirname(dirname(path)) }), ...runtimeViolations(text, name, dirname(dirname(path)), fresh, map), ...(v020 ? [...effectViolations(text, name, dirname(dirname(path))), ...rerunViolations(text, name, dirname(dirname(path)))] : [])].filter(Boolean)
}

/** The AC ids the task's STAGES.md and STAGES-ARCHIVE.md tag `[effect]` (stage 9: a criterion whose action sends something to the server). */
export function effectCriteria(taskDir) {
  const ids = new Set()
  for (const whole of journalText(taskDir).split(/\r?\n/)) {
    const line = whole.slice(0, RULE_LINE_MAX)
    // Only a criterion definition line (`- AC-x.y …` / `- \`AC-x.y\` …`) is tagged; the tag stands outside backticks, next to the verifier tag.
    const head = line.match(/^\s*[-*]\s+`?AC-(\d+[a-z]?(?:\.\d+[a-z]?)+)`?(.*)$/)
    if (!head) continue
    const rest = head[2].replace(/`[^`]*`/g, '')
    if (EFFECT_NEXT_TO_VERIFY.test(rest)) ids.add(head[1])
  }
  return ids
}

/** The criteria a report passes, for the `[effect]` rule: the verdict stands right after the id (`AC-x.y — PASS`, `AC-x.y: PASS`, a compact `4.5 PASS` run). The word elsewhere on the line and a line under "Could not verify" are not a PASS. */
function passedIds(text, wanted) {
  const passed = new Set()
  let unverified = false
  for (const whole of text.split(/\r?\n/)) {
    const line = whole.slice(0, RULE_LINE_MAX)
    if (/^#/.test(line)) unverified = UNVERIFIED_HEADING.test(line)
    if (unverified || !line.includes('PASS')) continue
    // one pass per line: the dotted-id run of PASS_RUN (a table row `| AC-x | PASS |` has none), then the id-named form with one separator class
    for (const match of line.matchAll(PASS_RUN)) for (const [id] of match[1].matchAll(/\d+[a-z]?(?:\.\d+[a-z]?)+/g)) if (wanted.has(id)) passed.add(id)
    if (/\bFAIL\b/.test(line)) continue
    for (const id of wanted) if (new RegExp(`AC-${id.replace(/\./g, '\\.')}(?![\\w.]*\\d)[\\s\x60*|:—–-]*PASS\\b`).test(line)) passed.add(id)
  }
  return passed
}

// a line is read up to this many characters by the rules of the hook: a pasted wall of text must not cost the hook its 5 s
const RULE_LINE_MAX = 2000

/** Every line that names `AC-<id>`, each with the detail lines under it (up to 6, to a blank line, a heading or another criterion). */
function mentionsOf(text, id) {
  const lines = text.split(/\r?\n/).map((line) => line.slice(0, RULE_LINE_MAX))
  const own = new RegExp(`AC-${id.replace(/\./g, '\\.')}(?![\\w.]*\\d)`)
  const found = []
  for (const [index, line] of lines.entries()) {
    if (!own.test(line)) continue
    found.push(line)
    for (const next of lines.slice(index + 1, index + 7)) {
      if (!next.trim() || /^#/.test(next) || /AC-\d/.test(next)) break
      found.push(next)
    }
  }
  return found.join('\n')
}

/**
 * VT-4 0.20 (stage 9): a PASS on an `[effect]` criterion names the request (`METHOD /path … status`) and a read-back (a reload or a second view).
 * Precedents: a contract that did not persist, a status and a questionnaire that were not saved — the screen showed the new state, the server never got it.
 * FAIL, not checked and deferred criteria are not touched.
 */
export function effectViolations(text, name, taskDir = null) {
  if (reportChecker(name) !== 'devtools-verify' || !taskDir || /\bskip\b/i.test(text.split('\n').slice(0, 5).join(' '))) return []
  const effects = effectCriteria(taskDir)
  if (!effects.size) return []
  const found = []
  for (const id of passedIds(text, effects)) {
    const evidence = mentionsOf(text, id)
    const missing = [!REQUEST_PROOF.test(evidence) && 'the request (`METHOD /path … status`, from list_network_requests / get_network_request)', !READBACK_PROOF.test(evidence) && 'the read-back (after a reload or from a second view)'].filter(Boolean)
    if (missing.length)
      found.push({
        rule: 'no-effect-proof',
        id: name,
        message:
          `checks/${name}: AC-${id} is tagged [effect] and gets a PASS, but the report does not name ${missing.join(' and ')}. A screen that shows the new state does not prove the server got it ` +
          '(skill devtools-verify, "Effects"; the Russian forms are in references/language.md). A criterion you could not prove is `not checked` or goes to "Could not verify", not PASS.',
      })
  }
  return found
}

/** The checker and stage token of a report name: `devtools-verify-5-r1.md` → `devtools-verify-5`, `pro-review-3.md` → `pro-review-3`; `null` — not a checker report. */
function ownReport(name) {
  const checker = reportChecker(name)
  if (!checker) return null
  const token = name.slice(name.indexOf(checker) + checker.length).match(/^-([\w]+?)(?=[-.]|$)/)?.[1]
  return `${checker}${token ? `-${token}` : ''}`
}

/**
 * The prefixes a re-run of this report starts with: `devtools-verify-5-r1.md` and `stage-5-devtools-verify.md` both give `devtools-verify-5-` and `stage-5-devtools-verify-`;
 * a report with no stage in its name takes `<checker>-`. `null` — not a checker report.
 */
function ownPrefixes(name) {
  const checker = reportChecker(name)
  if (!checker) return null
  const stage = name.match(STAGE_FILE)?.[1] ?? name.slice(name.indexOf(checker) + checker.length).match(/^-(\d+[a-z]?)(?=[-.]|$)/i)?.[1]
  return stage ? [`${checker}-${stage}-`, `stage-${stage}-${checker}-`] : [`${checker}-`]
}

/**
 * The re-run artifact a `fixed` line cites, or null: a recheck report of the SAME checker and stage that exists in this task's `checks/` (`-r<k>`, `-fresh`, `-recheck[-<k>]`; not the report itself;
 * a bare name or `checks/<name>`, any other directory part rejects it), or a screenshot `checks/screens/<file>` / `screens/<file>` that exists inside this task's `checks/screens/`
 * (no absolute path, no `..`, no symlink out of it).
 */
function citedRerun(entry, name, taskDir) {
  const own = ownPrefixes(name)
  for (const word of entry.split(/[^\w./-]+/).map((part) => part.replace(/(?<!\.)\.+$/, ''))) {
    if (word.length > 200) continue
    const base = word.split('/').pop()
    const prefix = own?.find((candidate) => base.startsWith(candidate))
    if (prefix && (word === base || word === `checks/${base}`) && RERUN_SUFFIX.test(base.slice(prefix.length)) && base !== name && (!taskDir || existsSync(join(taskDir, 'checks', base)))) return word
    if (RERUN_SCREEN.test(word) && (!taskDir || screenExists(taskDir, base))) return word
  }
  return null
}

function screenExists(taskDir, file) {
  try {
    const dir = realpathSync(join(taskDir, 'checks', 'screens'))
    return realpathSync(join(dir, file)).startsWith(`${dir}${sep}`)
  } catch {
    return false
  }
}

/**
 * VT-4 0.20 (stage 9): a `fixed` outcome in a devtools-verify report cites a re-run artifact — the recheck report (`devtools-verify-<stage>-r<k>.md`, `…-fresh.md`)
 * or a `checks/screens/` path. `fixed: file:line` alone says the code changed, not that the page now behaves (the fix recheck went by `file:line` only).
 */
export function rerunViolations(text, name, taskDir = null) {
  if (reportChecker(name) !== 'devtools-verify') return []
  const found = []
  for (const entry of ledgerEntries(text) ?? []) {
    if (disposition(entry) !== 'fixed' || citedRerun(entry, name, taskDir)) continue
    const shown = entry.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').slice(0, 90)
    found.push({
      rule: 'no-rerun',
      id: name,
      message:
        `checks/${name}: "${shown}" — a runtime finding is closed as fixed only with a re-run artifact: the recheck report \`checks/devtools-verify-<stage>-r<k>.md\` (or \`-fresh.md\`) that exists, ` +
        'or a `checks/screens/` path (stage-check, Step 3.2). `fixed: file:line` shows the code changed, not that the page behaves.',
    })
  }
  return found
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
// An id ends where its digit run ends (`(?!\d|\.\d)`): without it "01.10.2026" split as "01.1" + "0.2026" and a line of k dates backtracked over 2^k partitions (22 dates: seconds).
const PASS_RUN = /((?:`?(?:AC-)?\d+[a-z]?(?:\.\d+[a-z]?)+(?!\d|\.\d)`?\s*(?:(?:,|и|and|\/)\s*)?){1,80})(?:[—–:|-]\s*)?\**PASS\b\**/g

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

export function reportViolation(path, text = reportRead(path).text ?? null) {
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
    // Atomic (S4): a temp file in the same directory, then a rename. A plain write truncates the snapshot first, and a second hook that reads it in that moment
    // sees a torn file, rebuilds it from the current journal (closed heading included) and waves a close through.
    const target = baselinePath(dataDir, taskDir)
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(data))
      renameSync(temp, target)
    } catch (error) {
      try {
        unlinkSync(temp)
      } catch {
        // no temp file left to remove
      }
      throw error
    }
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
 * does not have to rewrite closed stages. `ledgerOld` are the reports there at the 0.18 migration (the 0.18 report rules, stages 4 and 5 of VT-1), `runtimeOld` — those there at the 0.20 one (stages 8 and 9 of VT-1), `since018` and `forceSeen` —
 * the day of that migration and the Force headings there then, dated before that day (`releaseGate`).
 */
export function baselineInfo(dataDir, taskDir) {
  const data = readBaseline(dataDir, taskDir)
  const info = (snapshot) => ({
    lines: new Set(snapshot.lines),
    ledgerSince: snapshot.ledgerSince,
    reports: new Set(snapshot.reports),
    ledgerOld: new Set(snapshot.ledgerOld),
    runtimeOld: new Set(snapshot.runtimeOld),
    since: snapshot.since018,
    forceSeen: new Set(snapshot.forceSeen),
    since0182: snapshot.since0182,
    blockerSeen: new Set(snapshot.blockerSeen),
  })
  if (data?.version === BASELINE_VERSION) {
    if (snapshotCurrent(data)) {
      return info(data)
    }
    // A snapshot v2 from an earlier version: what is there now is old for each rule that came after it (a lazy migration, once per rule — a rule whose mark
    // is already there keeps its set, so a line written after that earlier migration is not made old by this one).
    const text = journalText(taskDir)
    const since018 = typeof data.since018 === 'string' ? data.since018 : localDate()
    const since0182 = typeof data.since0182 === 'string' ? data.since0182 : localDate()
    const migrated = {
      ...data,
      reports: Array.isArray(data.reports) ? data.reports : reportNames(taskDir),
      closedSeen: true,
      liveSeen: true,
      dismissSeen: true,
      // VT-1 0.18 (D7): the reports already there are old for the 0.18 report rules — the stage 4 ones (a bare `[live: user-side]`, the `doctor:` / `auth:` lines)
      // and the stage 5 ones (weak dismissals, a critical needs a fresh report); only a report written after this migration is judged by them.
      ledgerOld: Array.isArray(data.ledgerOld) ? data.ledgerOld : reportNames(taskDir),
      // VT-4 0.20 (stage 9): the reports already there are old for the three 0.20 report rules (the `map:` line, the `[effect]` proof, the re-run artifact of `fixed`).
      runtimeOld: Array.isArray(data.runtimeOld) && Array.isArray(data.ledgerOld) ? data.runtimeOld : reportNames(taskDir),
      // The day of this migration and the Force runs already open or closed, dated before it: the receipts rules and the ticket-titled rule apply only to a run
      // opened after them (`releaseGate`).
      since018,
      forceSeen: Array.isArray(data.forceSeen) ? data.forceSeen : forceKeysBefore(text, since018),
      // 0.18.2 (K9, stage 5h): the day this version first read the task and every Force heading already there, open or closed, whatever its date — they keep the word matcher for blockers (`blockerGate`).
      since0182,
      blockerSeen: Array.isArray(data.blockerSeen) ? data.blockerSeen : presentKeys(text),
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
    runtimeOld: reportNames(taskDir),
    since018: localDate(new Date(now)),
    forceSeen: forceKeysBefore(text, localDate(new Date(now))),
    since0182: localDate(new Date(now)),
    blockerSeen: presentKeys(text),
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
 * Every Force heading present at the first look of 0.18.2 (stage 5h), whatever its state and date: each of them was written by an older plugin, because 0.18.2 has not read the task before,
 * so each keeps the word matcher (the 0.18.1 orchestrator that is still writing an open run lifts blockers in prose). A block written after the first look is not in the set and is read by the field.
 * The first look is taken before the edit that writes a heading (Edit / Write and the named-task Bash PreToolUse), so a heading is in the set only if it was already in the file.
 * The cost: a second data dir that first reads the task later holds the blocks 0.18.2 itself wrote, and reads them by words.
 */
const presentKeys = (text) => [...new Set(forceHeadings(text).map(([heading]) => forceKey(heading)))]

/**
 * The per-task release gate of the 0.18 rules that are keyed on a Force block (stage receipts, the close needing fresh final reviews, the ticket-titled commits after a close):
 * `{ since, seen }` for `ruleAppliesToBlock` (markers.mjs) — the day this version first saw the task and the Force headings already there and dated before that day.
 * A run that was open or closed then keeps the rules it started with (D7), whatever the release date; a run opened later, on that day or undated, gets them.
 */
export function releaseGate(dataDir, taskDir) {
  const { since, forceSeen } = baselineInfo(dataDir, taskDir)
  return { since, seen: forceSeen }
}

/**
 * The per-task gate of the fixed blocker field (stage 5e, K9), the same shape as `releaseGate`: the day 0.18.2 first read the task and every Force heading already there (stage 5h: open or closed, any date — an older plugin wrote them all).
 * Every caller passes it with the block to `openBlockers` / `blockerLines`; only a block written after the first look is read by the field.
 */
export function blockerGate(dataDir, taskDir) {
  const { since0182, blockerSeen } = baselineInfo(dataDir, taskDir)
  return { since: since0182, seen: blockerSeen }
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

/** The ledger violations of a report in `checks/`; a report that is there but cannot be read gives its `file-unreadable` violation instead: nothing in it can be counted as closed. */
export function reportLedgerViolations(taskDir, name, options = {}) {
  const read = taskFile(taskDir, 'checks', name)
  if (read.problem === 'missing') return []
  if (read.problem) return [unreadableViolation(`checks/${name}`, read)]
  return ledgerViolations(read.text, name, { ...options, taskDir })
}

/** New reports without a full findings outcome — what a force stage is not committed with and a run is not closed with. */
export function openLedgers(dataDir, taskDir) {
  const { ledgerSince, ledgerOld } = baselineInfo(dataDir, taskDir)
  return newReports(taskDir, ledgerSince).flatMap((name) => reportLedgerViolations(taskDir, name, { complete: true, strict: !ledgerOld.has(name) }))
}

/** The freshest "Force run" block (the latest date, not the last in the file — `freshestForceHeading`): the heading and the text up to the next section. */
export function lastForceBlock(stages) {
  const heading = freshestForceHeading(stages)
  if (!heading) return null
  return { heading: heading[0], body: forceBlockBody(stages, heading) }
}

// A blocker `B<n> — …` without a mark that the user lifted it. A blocker also stands on the `Blockers:` field line itself (the Russian field name too),
// and several of them can follow each other there ("Blockers: B1 — … B7 — …"): each one is an item of its own, and the lift mark is looked for in its own text.
// The start of the next item of a one-line field: `B<n> —`, `**B<n>** —`, `B<n> (<run>) —` or `B<n> (<run>) text`.
const NEXT_ITEM = String.raw`\**B\d+\**(?:[^\S\n]*[—–:-]|[^\S\n]*\(\d{1,3}\)\**(?:[^\S\n]*[—–:-]|[^\S\n]+\S))`
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
const asBlock = (input) => (typeof input === 'string' ? { heading: '', body: input } : input)
const isBullet = (line) => /^[^\S\n]*[-*][^\S\n]/.test(line)
const indentOf = (line) => line.length - line.trimStart().length
/** Whether an indented sub-item under `lines[index]` carries the lift field (the scan stops at the next line that is not indented deeper, or at the next blocker line). */
function subItemLifts(lines, index) {
  for (let next = index + 1; next < lines.length; next++) {
    if (!lines[next].trim()) continue
    if (indentOf(lines[next]) <= indentOf(lines[index]) || BLOCKER_LINE.test(lines[next]) || BLOCKERS_FIELD.test(lines[next])) break
    if (subItemLiftField(lines[next])) return true
  }
  return false
}
/**
 * The one reader of blocker state (stage 5e, K5): every caller passes the Force block (`lastForceBlock`), and the date comes from the block.
 * A block dated on or after `BLOCKER_FIELD_SINCE` and not held by the task snapshot at the first look of 0.18.2 (`gate`, K9) is read by the fixed field alone: a blocker is lifted by the lift field (`Lifted:`, or its Russian form) in its own text or on an indented sub-item,
 * and no word of the description and no field-wide mark lifts anything. An older, held or undated block (or a bare body text) keeps the word matcher and the field-wide marks, and the lift field on the blocker's own line lifts there too (K11; an indented sub-item is not read).
 * A carried blocker `B<n> (<run>) …` is a blocker line in every field except the interview answers, where it answers one.
 */
function blockerEntries(input, gate) {
  const { heading, body } = asBlock(input)
  const fixed = blockerFieldApplies(gate, heading, body)
  const lines = body.split('\n')
  const found = []
  let interview = null
  lines.forEach((line, index) => {
    if (interview && line.trim() && indentOf(line) <= interview.indent && (interview.bullet || !isBullet(line))) interview = null
    if (!interview && INTERVIEW_FIELD.test(line)) interview = { indent: indentOf(line), bullet: isBullet(line) }
    const field = line.match(BLOCKERS_FIELD)
    if (field) {
      if (!fixed && fieldLifted(field[1])) return
      // Items split at `. ` or `; ` before a `B<n> —` / `**B<n>** —`; a piece that itself opens as a blocker line is split again at `, ` before the next one (S3): one item's lift field must not lift the item next to it.
      // A comma inside prose that does not open as a blocker ("— (B1–B3 lifted: B1 — done, B2 — stage 7)") splits nothing: it is not a list of blockers.
      const pieces = field[1]
        .replace(new RegExp(`([.;])\\s+(?=${NEXT_ITEM})`, 'g'), '$1\n')
        .split('\n')
        .flatMap((piece) => (BLOCKER_LINE.test(piece) ? piece.split(new RegExp(`,\\s+(?=${NEXT_ITEM})`)) : [piece]))
        .filter((piece) => BLOCKER_LINE.test(piece))
      // A field that holds exactly one blocker may continue on an indented line (the live journals do): that sub-item is read, as under a plain blocker line (m-3).
      const sub = fixed && pieces.length === 1 && subItemLifts(lines, index)
      for (const piece of pieces) found.push({ line: piece.trim(), sub })
      return
    }
    if (!(interview ? PLAIN_BLOCKER_LINE : BLOCKER_LINE).test(line)) return
    found.push({ line: line.trim(), sub: fixed && subItemLifts(lines, index) })
  })
  return { fixed, found }
}
/** Every blocker line of a Force block (or of a bare body text), whether lifted or open (a field the whole of which is lifted is left out in a block read by words). */
export const blockerLines = (input, gate) => blockerEntries(input, gate).found.map(({ line }) => line)
export const openBlockers = (input, gate) => {
  const { fixed, found } = blockerEntries(input, gate)
  return found
    .filter(({ line, sub }) => !(fixed ? sub || blockerLiftField(line) : blockerLiftField(line) || BLOCKER_LIFTED.test(withoutRefusedLiftFields(line).replace(GROUP_NEGATION, ' '))))
    .map(({ line }) => line)
}

/**
 * Closing a force run as "completed" (without "with blockers") with open blockers or reports without an outcome.
 * Only when the heading was rewritten after the snapshot: old closed runs are not touched.
 */
export function forceCloseViolations(dataDir, taskDir) {
  const read = taskFile(taskDir, 'STAGES.md')
  // A journal that is there but cannot be read: no closing, blocker or report rule can run — every edit of the task is told so, never waved through.
  if (read.problem && read.problem !== 'missing') return [unreadableViolation('STAGES.md', read)]
  const stages = read.text
  if (stages === undefined) return []
  const block = lastForceBlock(stages)
  if (!block || !CLOSED_WORD.test(block.heading)) return []
  const { lines } = baselineInfo(dataDir, taskDir)
  if (lines.has(fingerprint(block.heading))) return []
  if (WITH_BLOCKERS.test(block.heading)) return []
  const found = []
  const gate = blockerGate(dataDir, taskDir)
  const blockers = openBlockers(block, gate)
  if (blockers.length) {
    const rule = blockerFieldApplies(gate, block.heading, block.body)
      ? ' In this block a blocker is lifted only by `Lifted: <who> <date> — <answer>` (the who is at most 4 words, the answer comes after the date; the Russian form is in the marker table of language.md) on its line or an indented sub-item; words in the description do not lift, and a value that says no / pending / not yet, or holds a request or condition word (needs, once, after, when, will…) outside quotes, lifts nothing.'
      : ''
    found.push({
      rule: 'force-blockers',
      id: 'force',
      message: `Block "${block.heading.replace(/^## /, '')}": ${blockers.length} open blockers (${blockers[0].slice(0, 60)}…) — close it as "completed with blockers", they come first in the summary.${rule}`,
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
  const journal = taskFile(taskDir, 'STAGES.md')
  if (journal.problem && journal.problem !== 'missing') found.push(unreadableViolation('STAGES.md', journal))
  const language = journal.text === undefined ? null : taskLanguage(journal.text)
  // The stage 5 rules (weak dismissals, a critical needs a fresh report) apply to reports that were not there at the first look: the same `ledgerOld` as the hook reads.
  // Read-only (a manual run writes no snapshot); with no snapshot yet every report counts as new.
  const snapshot = readBaseline(pluginDataDir(), taskDir)
  const ledgerOld = new Set(snapshot?.ledgerOld ?? [])
  const runtimeOld = new Set(snapshot?.runtimeOld ?? [])
  const reports = reportNames(taskDir).flatMap((name) => {
    const path = join(taskDir, 'checks', name)
    const strict = !ledgerOld.has(name)
    // Summary and geometry are rules for new reports: old ones lack them by construction, without --ledger it is noise.
    const all = reportViolations(path, language, { strict, v020: !runtimeOld.has(name) }).filter((violation) => args.includes('--ledger') || !['report-summary', 'no-geometry'].includes(violation.rule))
    return args.includes('--ledger') && reportChecker(name)
      ? [...all.filter((violation) => !violation.rule.startsWith('ledger-')), ...reportLedgerViolations(taskDir, name, { complete: true, strict })]
      : all
  })
  const messages = [...new Set([...found, ...reports].map((violation) => violation.message))]
  for (const message of messages) console.log(`- ${message}`)
  if (!found.length && !reports.length) console.log('No violations of the criteria closing rules.')
  process.exit(found.length || reports.length ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
