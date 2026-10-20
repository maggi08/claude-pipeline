/**
 * Weak dismissals — VT-1 stage 5. A "Findings outcome" line `false: …` closes a finding without a fix, so it needs a proof;
 * on the ledgers of this machine (163 such lines, 5 task roots) 17 rested on something that is not one. The seven forms below come from
 * the stage 1 corpus (`analysis/dismissals.md`: the live lines are the incident fixtures in `scripts/hooks-test.mjs`, the proof-backed ones the legitimate fixtures):
 *
 *   not-ours       the fix is "forced", belongs to the kit or the backend, or cannot be done — with no `path:line` in the kit, the contract or the tool
 *   not-reproduced "not reproduced" without two attempts and the route taken (the root-cause skill, a URL or a `/route`)
 *   downgrade      "demoted to minor" given as the reason — a severity is set by the checker, not by the orchestrator
 *   untouched      "this stage did not change it" / "before the stage" without a base sha, a diff range or a `git` command
 *   deferred       a later stage owns it — proved by a plan line only, not by code that already covers it
 *   self-sourced   the basis is the same report, an acceptance criterion written by the same run or a force-run assumption
 *   data-seen      "false for the data" — a bounded sample stated as a universal claim
 *   unrelated      "not related to the task" with no diff command or range tying the symptom to the code
 *
 * The check is a phrase heuristic: it recognises the wording of the weak form and then asks for the proof the form lacks. Wording that is not in the list is not caught
 * (a `path:line` of the task's own code that only shows the current behaviour passes `not-ours`; a clause-by-clause reading of a mixed line is not attempted).
 * Applied to reports that did not exist when the plugin first saw the task on this version (D7: the baseline snapshot, `ledgerOld`).
 *
 * The token patterns start only at a token start (`(?<![\w@./-])`) and the free runs are bounded: a 50 KB unbroken token (a data blob, a JWT, a class list) in a
 * dismissal line otherwise cost seconds per pattern and pushed the hooks past their timeouts.
 */
import { QUOTED, stripQuoted } from './markers.mjs'

// A proof: `path/to/file.ext:12` or "file.ext line 12" — the line of a file, not just its name.
const PATH_LINE = /(?<![\w@./-])[\w@./-]+\.[A-Za-z]{1,5}(?::\d+|\s+(?:строк[аи]?|line)\s+\d+)/
// A code file named without a line (a spec that covers the case, a component).
const CODE_FILE = /(?<![\w@./-])[\w@./-]+\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|scss|py|go|rb|kt|swift|java|php|rs)\b/
// Base proof: a sha, a diff range, a git command, a named base.
const BASE_PROOF = /\b[0-9a-f]{7,40}\b|\bgit\s+(?:show|diff|log|grep|blame)\b|\borigin\/|\bна\s+баз[еы]|\bon\s+(?:the\s+)?base\b|\b(?:base|базов[\wа-яё]*)\s+(?:sha|ref|коммит|commit|branch|ветк)/i

// Proof for "not ours": a line in the kit, the installed package or the backend contract — the task's own code showing the current behaviour is not.
const KIT_PROOF = /(?:node_modules|\/dist\/|ui-lib|ui-kit|openapi|swagger|\bkit\/)[\w@./-]{0,300}[\w-]\.[A-Za-z]{1,5}(?::\d+)?/i
// Wording that says the fix is not ours. HARD forms (kit/backend ownership, "cannot be fixed") need a line in the kit, the contract or the tool. The OWN forms ("can't be done / avoided",
// "no such prop") and the SOFT words below also occur in ordinary proofs about the task's own code ("impossible state — store.ts:40", "no such prop — Button.vue:12 declares only `size`"),
// so a task-code `path:line` in a clause that is not about the kit or the backend settles them.
const NOT_OURS_HARD = new RegExp(
  [
    'не\\s+исправим|не\\s+(?:может|могут)\\s+быть\\s+исправлен|нельзя\\s+исправить|исправить\\s+нельзя',
    "(?:can(?:'|’)?t|cannot|can\\s+not)\\s+(?:be\\s+)?(?:fix(?:ed)?|changed)",
    'not\\s+possible\\s+to\\s+(?:fix|change)',
    'infeasible|unfixable|not\\s+feasible',
    'не\\s+наш|работа\\s+кита|задач[аеи]\\s+бэкенд|в\\s+ките\\s+нет|нет\\s+(?:точной\\s+)?замены',
    "(?:kit|backend)\\s+(?:(?:does\\s+not|doesn(?:'|’)t)\\s+(?:have|support|provide)|has\\s+no)\\b",
    "(?:belongs|up)\\s+to\\s+the\\s+(?:kit|backend)",
    "\\b(?:the\\s+)?(?:kit|backend)\\s+owns\\b",
    "\\b(?:the\\s+)?(?:kit|backend)(?:'|’)s\\s+(?:job|problem|responsibility|work|concern)\\b",
    '\\b(?:kit|backend|library)\\s+(?:limitation|limit|issue|bug|constraint)s?\\b|(?:кит|бэкенд)[\\wа-яё]*\\s+(?:ограничени|баг)',
    "\\b(?:kit|backend)\\s+(?:returns?|sends?|gives?|renders?|emits?|responds?)\\s+(?:it|this|that|them)\\b|\\b(?:returns?|sends?|gives?)\\s+(?:it|this)\\s+(?:that|this)\\s+way\\b",
    "\\bnot\\s+our\\s+(?:code|problem|job|responsibility|concern|issue)\\b",
  ].join('|'),
  'i',
)
const NOT_OURS_OWN = new RegExp(
  [
    "(?:can(?:'|’)?t|cannot|can\\s+not)\\s+(?:be\\s+)?(?:done|avoided)",
    "(?:can(?:'|’)?t|cannot|can\\s+not)\\s+do\\s+(?:anything|much|more|something|nothing)\\b",
    'not\\s+possible\\s+to\\s+(?:do|avoid)',
    'no\\s+such\\s+(?:slot|prop|field|api|option|hook)\\b',
  ].join('|'),
  'i',
)
const NOT_OURS_SOFT = /вынужден|невозможн|impossible|(?:forced|unavoidable)\b/i
const KIT_WORDS = /\b(?:kit|backend|ui-lib|ui-kit|api)\b|кит|бэкенд/i
// "by design" is a claim about intent; it needs a source: a code line, a URL or a quoted spec.
const BY_DESIGN = /\bby\s+design\b|так\s+задумано/i
const HAS_QUOTE = new RegExp(QUOTED.source)
const NOT_REPRODUCED = /не\s+воспроизв|воспроизвести\s+не\s+удалось|not\s+reproduc|(?:could\s*n(?:'|’)?t|cannot|can(?:'|’)t|unable\s+to|failed\s+to)\s+reproduce/i
const COUNT_NOUN = '(?:attempts?|tries|runs?|loads?|times|reloads?|passes|попыт[\\wа-яё]*|прогон[\\wа-яё]*|загрузк[\\wа-яё]*|запуск[\\wа-яё]*|раз(?:а|ов)?|замер[\\wа-яё]*)'
const ATTEMPTS = new RegExp(`(?<![\\w.])(?:[2-9]|[1-9]\\d+)\\s+(?:[\\wа-яё-]+\\s+){0,2}${COUNT_NOUN}|\\b(?:twice|thrice|two\\s+(?:attempts|runs|times)|дважды|трижды|два\\s+раза)\\b`, 'i')
const ROUTE = /root-?cause|root\s+cause|https?:\/\/|(?<![\w./-])[\w./-]+\.(?:spec|test)\.[cm]?[jt]sx?\b|(?:^|[\s(`'"])\/[a-z][\w./-]*/i
const DOWNGRADE = /\bdemot(?:ed|ion)\b|\bdowngrad(?:ed|e)\b|понижен[\wа-яё]*|\breclassif[\wа-яё]*/i
const UNTOUCHED = /не\s+меня(?:л|лся|лась|лось|ли)(?![а-яё])|(?:этап|stage|раунд|round)\s*\d*\s+(?:[а-яё]+\s+){0,2}не\s+(?:трогал|касал)|\b(?:this|the)\s+(?:stage|change|task|round|diff|PR)\s+(?:did\s+not|didn(?:'|’)t)\s+(?:change|touch|modify)|правило\s+до\s+этапа|\bbefore\s+(?:this|the)\s+stage\b|\bnot\s+introduced\s+by\s+(?:this|the)\s+(?:change|stage|task|diff|round|PR)|\b(?:not|never)\s+(?:changed|touched|modified)\s+(?:by|in)\s+(?:this|the)\s+(?:stage|task|round|diff|change|PR)|\b(?:unchanged|untouched)\s+(?:by|in)\s+(?:this|the)\s+(?:stage|task|round)/i
const UNTOUCHED_CONTEXT = /change|этап|раунд|stage|round|задач|task|diff|диф/i
const DEFERRED = /(?:потребител[\wа-яё]*|владел[\wа-яё]*|скоуп[\wа-яё]*|заложен[\wа-яё]*\s+под)[^.;]{0,80}этап[\wа-яё]*\s+\d+|этап[\wа-яё]*\s+\d+[^.;]{0,20}(?:потребител|владел|скоуп)|(?:owner|consumer|scope|owns|consumes)[^.;]{0,60}stage\s+\d+|stage\s+\d+[^.;]{0,20}(?:owns|consumes|scope)|\b(?:later|next)\s+stage\b/i
const SELF_SOURCED = /сам(?:ого|ом|им|ому)?\s+отч[её]т|the\s+report\s+itself|\bthis\s+same\s+report\b|допущени[\wа-яё]*\s+(?:force|форс)|force[- ]?run\s+assumption|\bassumption\s+A\d|по\s+критерию\s+AC-|\bper\s+AC-\d/i
const USER_DECISION = /решени[\wа-яё]*\s+пользователя|user\s+decision|user\s+decided/i
const DATA_SEEN = /ни\s+разу|\bnever\s+(?:more|above|seen)|из\s+~?\d+\s*(?:раз|публикац)|of\s+~?\d+\s+(?:times|samples)|ложн[\wа-яё]*\s+для\s+(?:данных|выборки|стенда|окружения)|false\s+for\s+(?:the\s+)?(?:data|sample|environment)/i
const UNRELATED = /ложн[\wа-яё]*\s+для\s+задачи|не\s+относится|не\s+связан[\wа-яё]*\s+с\s+(?:задачей|этапом|диф)|\bunrelated\s+to\b|\bnot\s+related\s+to\b|\boutside\s+the\s+task\b/i

/**
 * The weak form of a `false` outcome line, or null. `form` is the name above, `need` says what the line lacks (for the hook message).
 * Quoted text and code spans are identifiers and copy: the wording is looked for outside them, the proof — in the whole line.
 */
export function weakForm(entry) {
  const prose = stripQuoted(entry)
  if (NOT_REPRODUCED.test(prose)) {
    if (!ATTEMPTS.test(entry) || !ROUTE.test(entry)) return { form: 'not-reproduced', need: 'two attempts and the route taken: "not reproduced (2 attempts, /root-cause)", "(3 cold loads on /orders)"' }
  }
  if (DOWNGRADE.test(prose) && !PATH_LINE.test(entry)) return { form: 'downgrade', need: 'the code proof (`file:line`) that the finding is not a defect — the severity is set by the checker, a downgrade is not an outcome' }
  if (UNTOUCHED.test(prose) && UNTOUCHED_CONTEXT.test(prose) && !BASE_PROOF.test(entry)) return { form: 'untouched', need: 'a base sha or a diff range, or a `git show` / `git diff` on the base — a precedent `path:line` elsewhere does not prove that this code was not touched' }
  if (DEFERRED.test(prose) && !PATH_LINE.test(entry) && !CODE_FILE.test(entry) && !/\bpassed\b|\bпрошл[\wа-яё]*/i.test(prose)) return { form: 'deferred', need: 'the code that already covers the case (`file:line` or a spec and its run) — a plan line saying a later stage owns it is not a proof; a deferral is a blocker or a user decision' }
  if (SELF_SOURCED.test(prose) && !USER_DECISION.test(prose) && !PATH_LINE.test(entry) && !/\bcurl\b|замер|measur/i.test(prose)) return { form: 'self-sourced', need: 'a code line, a measurement, a frame or a user quote — the same report, an acceptance criterion of this run or a force-run assumption is not a proof' }
  if (DATA_SEEN.test(prose) && !PATH_LINE.test(entry)) return { form: 'data-seen', need: 'the code path (`file:line`) that makes the claim hold for all data — a sample of the stand is not the whole' }
  if (UNRELATED.test(prose) && !BASE_PROOF.test(entry) && !PATH_LINE.test(entry)) return { form: 'unrelated', need: 'a diff command or range, a base run, or a code path outside the diff — naming the failing endpoint does not tie the symptom to the task' }
  if (BY_DESIGN.test(prose) && !PATH_LINE.test(entry) && !/https?:\/\//.test(entry) && !HAS_QUOTE.test(entry)) return { form: 'by-design', need: 'the source of the intent: a `file:line`, a URL or a quote of the spec — "by design" alone is the finding restated' }
  const hard = NOT_OURS_HARD.test(prose)
  const soft = !hard && (NOT_OURS_OWN.test(prose) || NOT_OURS_SOFT.test(prose))
  const taskCodeProof = soft && PATH_LINE.test(entry) && !KIT_WORDS.test(prose)
  if ((hard || soft) && !taskCodeProof && !KIT_PROOF.test(entry)) return { form: 'not-ours', need: 'a `file:line` in the kit, the contract or the tool that proves it; "the fix is impossible" alone is not an outcome — the finding stands as a fix, a blocker `B<n>` or a user decision' }
  return null
}

// ── severity of a ledger line ────────────────────────────────────────────────

const SEVERITY = /(?<![\w-])(critical|major|minor|nit)(?![\w-])|(🔴)|(🟠)|(🟡)/i
const severityOf = (text) => {
  const found = text.match(SEVERITY)
  if (!found) return null
  if (found[2]) return 'critical'
  if (found[3]) return 'major'
  if (found[4]) return 'minor'
  return found[1].toLowerCase()
}

/** The finding's id part of a ledger line: the text before the first dash that starts the outcome, else before the first colon. */
export function entryHead(entry) {
  const body = entry.replace(/^\s*(?:[-*]|\d+\.)\s+/, '')
  const dash = body.search(/\s[—–]\s|\s-\s/)
  if (dash !== -1) return body.slice(0, dash)
  const colon = body.indexOf(':')
  return colon === -1 ? body : body.slice(0, colon)
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The severity of the finding a ledger line closes: a word in the head of the line ("minor 2 (…) — false: …"), else the row of the same report that starts with the id
 * (`K-1`, `M-2`, `F10`, `#4`, `| #4 |`) — the word on the row, or in the group heading above it. A bare number (`1`, `3`) matches only a row anchored as `1.`, `| 1 |`, `#1`.
 */
export function entrySeverity(entry, report) {
  const head = entryHead(entry)
  const direct = severityOf(head)
  if (direct) return direct
  const id = head.trim().match(/^\**((?:[A-Za-z]{1,3}-?\d+(?:\.\d+)*[a-z]?)|#\d+|\d{1,3})(?![\w.])/)?.[1]
  if (!id) return null
  const before = report.slice(0, Math.max(0, report.search(/^#{2,3}\s*(?:Итог находок|Findings outcome)/im)) || report.length)
  const lines = before.split('\n')
  // A bare number is anchored to the finding row: `1.`, `| 1 |`, `#1`, `### 1.` — a stray line starting with a digit is not the row.
  const row = /^\d+$/.test(id)
    ? new RegExp(`^\\s*(?:(?:[-*]\\s+|#{2,4}\\s+)?\\**${id}\\**\\.\\s|#${id}(?!\\d)|\\|\\s*\\**#?${id}\\**\\s*\\|)`)
    : new RegExp(`^\\s*(?:[-*]\\s+|\\d+\\.\\s+|#{2,4}\\s+|\\|\\s*)?\\**${escapeRe(id)}\\**(?![\\w.-])`)
  const at = lines.findIndex((line) => row.test(line))
  if (at === -1) return null
  const own = severityOf(lines[at])
  if (own) return own
  for (let i = at - 1; i >= 0; i--) {
    if (/^#{1,4}\s/.test(lines[i])) return severityOf(lines[i])
  }
  return null
}

/** "The criterion was not a FAIL" — a line that uses `false` for a passed criterion, not for a dismissed finding. */
export const NOT_A_FAIL = /FAIL\s+не\s+было|не\s+FAIL|\bnot\s+a\s+FAIL\b|\bno\s+FAIL\b|\bwas\s+not\s+a\s+FAIL\b/i
