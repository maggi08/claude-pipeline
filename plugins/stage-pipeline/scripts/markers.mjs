/**
 * Structural markers that scripts and hooks read from STAGES.md, STAGES-ARCHIVE.md, checks/,
 * the Force block and pipeline.config.md — each in an RU|EN form. A task is written in one of two languages,
 * and the parser accepts both (Russian is the second supported language): live tasks are not rewritten for a new plugin version.
 *
 * English forms come from the marker table in plugins/stage-pipeline/references/language.md. The phrase heuristics of
 * journal-check (outcomes, caveats, "no data") are not here. The texts that scripts WRITE
 * stay with the scripts.
 */

const re = (source, flags = '') => new RegExp(source, flags)

/** Code in backticks and quoted text ("…", «…», “…”): identifiers or copy, not the wording of an outcome ("the untested import is removed"). */
export const QUOTED = /`[^`\n]{0,200}`|"[^"\n]{0,200}"|«[^«»\n]{0,200}»|“[^“”\n]{0,200}”/g
export const stripQuoted = (text) => text.replace(QUOTED, ' ')

// --- STAGES.md: headings and fields ---

/** `### Stage A0 …` heading (or its Russian form) — group 1 is the heading level, group 2 the number. */
export const STAGE_HEADING = /^(#{2,3}) (?:Этап|Stage) ([\w.]+)/
/**
 * Stage blocks: `### Stage 3 …` / `## Stage A0 …` (or the Russian form) up to the next heading of the same or a higher level.
 * If the file has stage headings with `[status: …]`, only they count as stages — otherwise
 * journal subheadings "### Stage 6 — progress" would count as a second stage 6.
 */
export function stageBlocksOf(text) {
  const lines = text.split('\n')
  const headings = lines.map((line, index) => ({ index, match: line.match(STAGE_HEADING) })).filter(({ match }) => match)
  const withStatus = headings.filter(({ index }) => /\[status:/i.test(lines[index]))
  return (withStatus.length ? withStatus : headings).map(({ index, match }) => {
    let end = index + 1
    while (end < lines.length && !(lines[end].match(/^(#{1,6}) /)?.[1].length <= match[1].length)) end++
    return { number: match[2], block: lines.slice(index, end).join('\n'), start: index, end }
  })
}

// The `logic-only` tag of a stage heading, in the forms live journals write (none is rewritten, D7). A tag: in brackets or backticks anywhere
// (`[logic-only]`, `` `logic-only` ``); a parenthesised qualifier (`(logic-only)`, `(catch-up, logic-only)`); a bare word right after the status
// bracket, as the last word before it, or after a dash with only a comma list behind it (`— logic-only  [status: …]`, `— logic-only, refactor  [status: …]`).
// A title word ("logic-only helpers and the card") is not a tag, and neither is a negated one ("not logic-only" and the Russian form).
const LOGIC_ONLY_NEGATED = /(?:^|[^\wа-яё'’-])(?:not|non|never|(?:is|are|was|were)n['’]t|no\s+longer|не|без)(?:\s+(?:a|an|the|really|just|only|yet))?[\s`[(-]*$/i
// What may follow the comma of "— logic-only, …" before the status bracket: a short tag list ("refactor"), not a clause ("then the visual layer").
const LOGIC_ONLY_TAIL = /^\s*(?:,\s*(?!(?:then|and|but|so|which|while|потом|затем|и|но|а)(?![\wа-яё]))[\wа-яё.-]+(?:\s+[\wа-яё.-]+)?\s*)+$/i
const logicOnlyWrapped = (before, after) => (/\[$/.test(before) && /^\]/.test(after)) || (/`$/.test(before) && /^`/.test(after)) || (/(?:\(|,\s*)$/.test(before) && /^\)/.test(after))

/** Where the `[status: …]` bracket of a heading starts and ends (brackets nested in it, such as a quoted `[live: …]`, are skipped): `{ start, end }` or null. */
function statusBracket(heading) {
  const start = heading.search(/\[status:/i)
  if (start === -1) return null
  let depth = 0
  for (let at = start; at < heading.length; at++) {
    if (heading[at] === '[') depth++
    else if (heading[at] === ']' && --depth === 0) return { start, end: at + 1 }
  }
  return { start, end: heading.length }
}

/** Whether a stage heading carries the `logic-only` tag (the forms above). */
export function logicOnlyTag(heading) {
  const status = statusBracket(heading)
  for (const found of heading.matchAll(/logic-only/gi)) {
    const end = found.index + found[0].length
    if (status && found.index >= status.start && found.index < status.end) continue
    const before = heading.slice(Math.max(0, found.index - 28), found.index)
    const after = heading.slice(end, end + 16)
    if (LOGIC_ONLY_NEGATED.test(before)) continue
    if (logicOnlyWrapped(before, after)) return true
    if (!status) continue
    if (found.index >= status.end && /^\s*(?:[—–-]\s*)?$/.test(heading.slice(status.end, found.index))) return true
    if (found.index < status.start && /^[\s,;.:]*$/.test(heading.slice(end, status.start))) return true
    if (found.index < status.start && /(?:^|\s)[—–-]\s*$/.test(before) && status.start - end <= 80 && LOGIC_ONLY_TAIL.test(heading.slice(end, status.start))) return true
  }
  return false
}

/** The same heading, but with the number from `number` (a string, not a regexp). */
export const stageHeadingOf = (number) => re(`^###\\s+(?:Этап|Stage)\\s+${number}(?![\\w.])[^\\n]*$`, 'm')
/** "stage 3" (or its Russian form) in a journal or commit line — group 1 is the number. */
export const STAGE_MENTION = /(?:этап[а-я]*|(?<![\w-])stage)\s+([\w.]+)/i
/** A report file name: `stage-3-…` (or the Russian form) — group 1 is the number. */
export const STAGE_FILE = /(?:stage|этап)-?(\d+[a-z]?)\b/i

export const STATUS_LINE = /^## (?:Статус|Status):\s*(.+)$/m
/** A closed stage in a `[status: …]` heading; the last alternative is the Russian form of "cancelled". */
export const CLOSED_STAGE = /\[status:\s*(done|cancelled|отмен)/i

export const JOURNAL_HEADING = /^## (?:Журнал|Journal)(?:\s|$)/i
/** Sections inside which stage headings are not stages. */
export const PROTECTED_SECTION = /^#{1,2} (Force-прогон|Force run|Журнал|Journal)/i
/** Lines of a closed stage that folding keeps (commit, decisions, metrics, anything unclosed). */
export const KEEP_LINE =
  /^(\s*[-*]\s*)?(\*\*)?(Коммит|Commit|Решени|Decision|metrics:)|^\s*[-*]\s*\[x\]\s*commit:|^\s*[-*]\s*\[ \](?!.*\bskip\b)|\[live:|⏳/i
/** The stub in STAGES.md in place of a folded stage (read; the script writes it). */
export const ARCHIVED_STUB = /^(?:Полная запись|Full record): STAGES-ARCHIVE\.md/
/** The counter line in the journal preamble: `Older entries (N)` (or its Russian form) — group 1 is the number. */
export const OLDER_ENTRIES = /^(?:Старые записи|Older entries) \((\d+)\)/

/** The "Awaiting user confirmation" section. */
export const AWAITING_SECTION = /^## ⚠?\s*(?:Ожидают подтверждения|Awaiting user confirmation)/m

/** The stage field "Visual reference: …" — group 1 is the value. */
export const VISUAL_REFERENCE_FIELD = /(?:эталон\s+вида|visual\s+reference)\**\s*:\s*(.+)$/im
/** A field value that means "no visual reference". */
export const NO_VISUAL_REFERENCE = /^(?:—|-|нет|n\/a|не\s+нужен|none(?![\wа-яё])|not\s+needed)/i
/** The "Parity" table in the journal (in `ds-parity` and the like the word is a skill name, not a table). */
export const PARITY_TABLE = /паритет|^[ \t>*-]*parity\**[ \t]*:|^#{1,6}[ \t]+parity(?![\w-])|\|[ \t]*parity(?![\w-])/im

// --- Header: language and branch ---

/** `Language: en` (or `ru`) in the header — group 1 is the value. */
export const LANGUAGE_LINE = /(?:^[ \t>*-]*|(?<![ \t])[ \t]{2,}\**|[·|][ \t]*\**)(?:Язык|Language)\**[ \t]*:\**[ \t]*`?(ru|en)\b/im
/** Headings by which the task language is determined when there is no language line. */
export const RU_HEADINGS = /^(?:##\s+Журнал|###?\s+Этап\s+[\w.]+)/m
export const EN_HEADINGS = /^(?:##\s+Journal|###?\s+Stage\s+[\w.]+)/m

/** Branch label words in the header (the source of the taskBranches regexp). */
export const BRANCH_LABEL = 'Ветк[аи](?:\\s+задачи)?|Branch(?:es)?'
/** Words after which a branch value goes on with "where it was cut from / where it was merged". */
export const BRANCH_BOUNDARY =
  'от|из|from|off|cut\\s+from|branched|rebased|срезана|отведена|пересажена|база|base|влита|merged|→|PR\\b'
/** The value "no branch". */
export const NO_BRANCH = /^(TBD|нет|none|n\/a|—)$/i

// --- Force run block ---

/** `## Force run …` headings (or the Russian form). Each call is a fresh regexp (the g flag). */
export const forceHeadings = (text) => [...text.matchAll(/^## (?:Force-прогон|Force run).*$/gm)]
/** The date of a heading (or any line): ISO `2026-10-13` or `13.10.2026`, normalised to ISO; the first one found. */
export function headingDate(heading) {
  const iso = heading.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return iso[0]
  const ru = heading.match(/(\d{2})\.(\d{2})\.(\d{4})/)
  return ru ? `${ru[3]}-${ru[2]}-${ru[1]}` : null
}

const ORDINAL_WORDS = [
  [2, /(?<![а-яёa-z])(?:второй|вторая|second|2nd)(?![а-яёa-z])/i],
  [3, /(?<![а-яёa-z])(?:третий|третья|third|3rd)(?![а-яёa-z])/i],
  [4, /(?<![а-яёa-z])(?:четв[её]ртый|четв[её]ртая|fourth|4th)(?![а-яёa-z])/i],
  [5, /(?<![а-яёa-z])(?:пятый|пятая|fifth|5th)(?![а-яёa-z])/i],
]
/**
 * The ordinal of a run in its heading: "(2)", a letter right after the date (`2026-09-30b`), "second run" in Russian or English.
 * No sign — 1. Used only to tell apart blocks of the same date.
 */
export function runOrdinal(heading) {
  const paren = heading.match(/\(\s*(\d{1,2})\s*\)/)
  if (paren) return Number(paren[1])
  const letter = heading.match(/(?:\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})([a-z])(?![a-z])/i)
  if (letter) return letter[1].toLowerCase().charCodeAt(0) - 96
  for (const [number, word] of ORDINAL_WORDS) if (word.test(heading)) return number
  return 1
}

/**
 * The freshest "Force run" heading: the latest date in the heading, not the last heading in the file — some journals
 * keep new blocks on top. Equal dates go by the ordinal in the heading ("(2)", "second run"), then by the direction the file keeps its
 * blocks in (more descending steps than ascending — the newest is the first of them, otherwise the last). A heading without a readable date
 * makes the dates useless for choosing: the last heading of the file wins, as before.
 */
export function freshestForceHeading(stages) {
  const all = forceHeadings(stages)
  if (!all.length) return undefined
  const dated = all.map((heading) => ({ heading, date: headingDate(heading[0]) }))
  if (dated.some(({ date }) => !date)) return all.at(-1)
  const top = dated.reduce((max, { date }) => (date > max ? date : max), '')
  let ties = dated.filter(({ date }) => date === top)
  const ordinals = ties.map(({ heading }) => runOrdinal(heading[0]))
  const best = Math.max(...ordinals)
  if (new Set(ordinals).size > 1) ties = ties.filter((_, index) => ordinals[index] === best)
  let down = 0
  let up = 0
  for (let i = 1; i < dated.length; i++) {
    if (dated[i].date < dated[i - 1].date) down++
    else if (dated[i].date > dated[i - 1].date) up++
  }
  return (down > up ? ties[0] : ties.at(-1)).heading
}

/** A Force heading without its closing tail: `## Force run 2026-10-22 — completed with blockers` → `## Force run 2026-10-22`. The block is the same block before and after its close. */
export function forceKey(heading) {
  const at = heading.search(CLOSED_WORD)
  return (at === -1 ? heading : heading.slice(0, at)).trimEnd().replace(/[—–:,;(-]+$/, '').trim()
}

/**
 * Whether a rule released with a per-task date applies to a Force block (D7: the plugin adapts to existing projects). `gate` is what the task snapshot recorded
 * when this plugin version first saw the task (`releaseGate` in journal-check): `since` — that day (ISO), `seen` — the keys (`forceKey`) of the Force headings already there
 * and dated before that day. A block in `seen` is an old run. A new block counts from its date (`fallbackDate` when the heading has none, e.g. the `Confirmed:` line):
 * opened on or after `since` — the rules apply. No readable date, no readable `since`, no gate at all — the rules apply too (fail closed, like CONFIRM_SINCE in agent-guard).
 */
export function ruleAppliesToBlock(gate, heading, fallbackDate = null) {
  if (gate?.seen?.has(forceKey(heading))) return false
  const date = headingDate(heading) ?? fallbackDate
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(gate?.since ?? '')) return true
  return date >= gate.since
}

/** The text of a Force block: from the end of its heading up to the next `## ` section. `heading` is a match of `forceHeadings`. */
export function forceBlockBody(stages, heading) {
  const rest = stages.slice(heading.index + heading[0].length)
  const end = rest.search(/^## /m)
  return end === -1 ? rest : rest.slice(0, end)
}

export const FORCE_BLOCK_PRESENT = /^## (?:Force-прогон|Force run)/m
/** "completed" or "complete" (or the Russian form) — the run is closed. "complete" is accepted on purpose: a heading that closes the run in
 * neither form would leave it both open (forceActive) and not checked on close (forceCloseViolations).
 * "completed" right after a dash or a colon closes with any tail ("— completed on 2026-10-18", "— completed (B1 open)", "— completed, with blockers").
 * "complete" closes only before a date, "with blockers" or at the end of the heading after a dash ("— complete"; "stage 3 complete" is progress): "— complete the migration" is an ordinary title word.
 * The lookbehinds stand after the word: on Node 22 (V8 12.4) a positive lookbehind at the head of an alternative turns off the start-position skip,
 * and the regexp goes quadratic on long whitespace. */
export const CLOSED_WORD = /заверш|\bcomplete(?:d)?\b(?=\s*(?:with\s+blockers\b|\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}))|\bcompleted\b(?<=(?:\s[—–-]|[—–:])\s*completed)|\bcomplete(?<=(?:\s[—–-]|[—–:])\s*complete)\s*$/im
/** "completed with blockers" (or the Russian form). */
export const WITH_BLOCKERS = /с\s+блокер|with\s+blockers/i
/** In a status line: "force run … completed" (or the Russian form), without "not". */
const FORCE_CLOSED_RU = 'force-прогон[^.;\\n]{0,40}?завершён'
// English: only "force run" + an optional date + "completed" — "force run 2026-10-17, stage 3 completed" is progress, not a close.
const FORCE_CLOSED_EN = 'force run(?:[ \\t]+(?:is|was))?(?:[ \\t]+(?:\\d{4}-\\d{2}-\\d{2}\\w?|\\d{1,2}\\.\\d{1,2}(?:\\.\\d{2,4})?))?(?:[ \\t]*[—–:,-])?[ \\t]*completed'
export const STATUS_FORCE_CLOSED = re(`${FORCE_CLOSED_RU}|${FORCE_CLOSED_EN}`, 'i')
/** The same plus a tail that cuts the date (up to 20 characters). */
export const STATUS_FORCE_CLOSED_WITH_DATE = re(`${FORCE_CLOSED_RU}[^.;\\n]{0,20}|${FORCE_CLOSED_EN}[^.;\\n]{0,20}`, 'i')
export const NOT_CLOSED = /не\s+завершён|not\s+completed/i

/** The `Confirmed:` line (or the Russian form) in the Force block. */
export const CONFIRMED_LINE = /^[ \t]*(?:[-*][ \t]*)?\**(?:Подтвержд[её]н[оа]?|Confirmed)\**\s*:/im
/** The word "mode" in a subagent prompt: `Mode: whole-branch` (or the Russian form). */
export const MODE_WORD = 'режим|mode'

/** A blocker `B<n> — …`. */
export const BLOCKER_LINE = /^[^\S\n]*(?:[-*][^\S\n]*)?\**B\d+\**\s*[—–:-]/
// A request for the user's answer ("needs a user decision", "awaiting a user answer", and the Russian forms): it lifts nothing, even if the line also says "closed by" or quotes the options.
// One list for both languages: `\b` is ASCII, so in the branches that put it before the list only the English words take part.
const REQUEST_WORDS =
  '(?:needs?|needed|waiting\\s+for|waits?\\s+for|awaiting|pending|requires?|required|нужно|нужен|нужна|нужны|необходим[а-яё]*|жд[её]т|жд[её]м|жду|ожида[а-яё]*|требуется)'
const USER_REQUEST = `\\b${REQUEST_WORDS}\\s+(?:an?\\s+|the\\s+)?user\\s+(?:answer|decision)\\b`
const NO_REQUEST_AFTER = `(?![^\\n]{0,200}${USER_REQUEST})`
const NO_REQUEST_BEFORE = `(?<!${USER_REQUEST}[^\\n]{0,200})`
const NOT_BEFORE = "(?<!\\b(?:not|never)\\s)(?<!n['’]t\\s)(?<!\\bun-)"
// The Russian negation before a lift word ("not lifted", "was not closed", "unclosed" as one word); bounded: a few spaces, a short "was" form.
const NOT_RU = '(?<!не)(?<!(?<![а-яё])не\\s{1,3})(?<!(?<![а-яё])не\\s{1,3}был[аио]?\\s{1,3})'
const DATE_OR_QUOTE = '(?:«|"|“|\\d{4}-\\d{2}-\\d{2}|\\d{2}\\.\\d{2}\\.\\d{2,4})'
// A quote followed by a second option ("v1" or "v2", and the Russian form) lists what is asked, it is not the answer.
const NOT_OPTIONS = '(?![^»"”\\n]{0,80}[»"”]\\s*(?:или|or|vs\\.?|/)\\s*[«"“])'
// The answer: a date or a quote right after the words, with at most a short "on", "dated", "(", "in chat" (and the Russian forms) or a ":" / dash between them.
// One optional separator and no adjacent "\s*" pairs: the tail stays linear on long runs of spaces.
const ANSWER_EN = `(?:\\s*(?:on|dated|in\\s+(?:the\\s+)?chat|\\())?\\s*(?:[:—–-]\\s*)?${DATE_OR_QUOTE}${NOT_OPTIONS}`
const ANSWER_RU = `(?:\\s*(?:от|в\\s+чате|\\())?\\s*(?:[:—–-]\\s*)?${DATE_OR_QUOTE}${NOT_OPTIONS}`
/** A blocker is lifted: `lifted by`, `resolved by`, `user decision` … and their Russian forms. */
export const BLOCKER_LIFTED = new RegExp(
  [
    `${NOT_RU}(?:снят|закрыт|отвечен)`,
    // The Russian "resolved" (masculine, neuter, feminine) as a word of its own, without a negation before it: the noun "decision" and "not resolved" do not lift.
    `(?<![а-яё])${NOT_RU}реш[её]н[оа]?(?![а-яё])`,
    // "Needs the user's decision/answer …" is a request, not a lift: the answer (ANSWER_*) must follow the words, and a request word must not stand before them (the Russian forms too).
    `(?<!${REQUEST_WORDS}\\s+)(?:ответ|решение)\\s+пользователя${ANSWER_RU}`,
    `${NO_REQUEST_BEFORE}${NOT_BEFORE}\\b(?:lifted|closed|answered)\\s+by${NO_REQUEST_AFTER}|${NO_REQUEST_BEFORE}${NOT_BEFORE}\\bresolved\\s+by${NO_REQUEST_AFTER}|(?<![\\w-])${NOT_BEFORE}resolved:`,
    // "waiting for a user answer", "needs a user decision — I recommend "v2"" are requests; the answer after the words (ANSWER_*) makes it a lift.
    `(?<!\\b${REQUEST_WORDS}\\s+(?:an?\\s+|the\\s+)?)\\buser\\s+(?:answer|decision)${ANSWER_EN}`,
  ].join('|'),
  'i',
)

// The marker an open blocker carries when a final whole-task report is missing or stale and the run closes "completed with blockers" (VT-1 B1):
// `[final: pro-review — not run]`, `[final: task-converge — stale]`, the Russian state words in a ru task. The brackets, `final:`, the report name and the dash
// are the same in both languages. Prose is not read: "pro-review found a critical; report missing a recheck" names a finding, not a review that did not run.
const FINAL_MARKER = /\[final:\s*(pro-review|task-converge)\s*[—–-]\s*(?:not\s+run|stale|не\s+запускался|устарел)\s*\]/gi
const FINAL_STATE = { en: { missing: 'not run', stale: 'stale' }, ru: { missing: 'не запускался', stale: 'устарел' } }
/** The final reports a line names by the marker: a Set of `pro-review` / `task-converge`. */
export const finalMarkerReports = (line) => new Set([...line.matchAll(FINAL_MARKER)].map((found) => found[1].toLowerCase()))
/** The marker to write: `state` is `missing` or `stale`, `language` is `en` or `ru` (anything else — `en`). */
export const finalMarker = (report, state, language) => `[final: ${report} — ${(FINAL_STATE[language] ?? FINAL_STATE.en)[state]}]`

// --- checks/ reports ---

/** The structural form of the dead-code summary: `1 to remove` / `1 remove` (or the Russian form) — group 1 is the number. */
export const DEAD_CODE_REMOVE = /(\d+)\s*(?:удалить(?![а-яё])|(?:to\s+)?remove(?![\w-]))/i

/** The "Findings outcome" heading (`##` or `###`). */
export const LEDGER_HEADING = /^#{2,3}\s*(?:Итог находок|Findings outcome)/im
/** The environment line of a devtools-verify report: `doctor: <verdict>` (or its Russian form). */
export const DOCTOR_LINE = /^[ \t]*(?:[-*][ \t]*)?`?(?:doctor|окружение)\s*:/im
/** The login line of a devtools-verify report: `auth: ok | not logged in — …` (or its Russian form). */
export const AUTH_LINE = /^[ \t]*(?:[-*][ \t]*)?`?(?:auth|вход)\s*:/im
/** The "Could not verify" heading. */
export const UNVERIFIED_HEADING = /^#{2,3}\s*(?:Не удалось проверить|Could not verify)/im
/** The summary line, second line of a report: `Findings: critical N · major N` (or the Russian form). */
export const SUMMARY_STANDARD = /(?:Находки|Findings):\s*critical\s*\d+\s*·\s*major\s*\d+/i

// --- pipeline.config.md ---

/** The heading of the CI gates table. */
export const CI_GATES_HEADING = /^(#{2,4})[ \t]*(?:Гейты\s+CI|CI\s+gates)\b.*$/im
/** A gate command meaning "none". */
export const NO_GATE_COMMAND = /^(?:нет|—|-|none|no|n\/a)(?![а-яёa-z])/i
/** `kit_overrides: off|false|no|disabled` (and the Russian "none"). */
export const KIT_OVERRIDES_OFF = /^[ \t]*-[ \t]*kit_overrides[ \t]*:[ \t]*`?(?:off|false|no|нет|disabled)(?![\wа-яё])/im
