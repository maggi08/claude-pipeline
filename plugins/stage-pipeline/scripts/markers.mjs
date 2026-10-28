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
export function statusBracket(heading) {
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
/** A closed stage in a `[status: …]` heading: done, cancelled (either spelling), or the Russian form of "cancelled". The one definition: plan-check, archive-stages and the resume point read it. */
export const CLOSED_STAGE = /\[status:\s*(done|cancel+ed|отмен)/i

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
  const head = (at === -1 ? heading : heading.slice(0, at)).trimEnd()
  // the trailing dash / colon run is cut by index: `[—–:,;(-]+$` is quadratic over a heading ending in a long run (S-4)
  let end = head.length
  while (end > 0 && '—–:,;(-'.includes(head[end - 1])) end--
  return head.slice(0, end).trim()
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
/** The field names of a Force block, for cutting a multi-line field (`Taxonomy:`) at the next field. */
const FORCE_FIELD_NAMES =
  'Mode|Режим|Interview answers|Ответы интервью|Assumptions|Допущения|Unresolved|Незакрытое|Boundaries|Границы|Confirmed|Подтверждено|Подтверждён|Blockers|Блокеры|Stage dependencies|Зависимости этапов|Taxonomy|Таксономия|Checked before start|Проверено до старта|Not proven|Не доказано|Blocker forecast|Прогноз блокеров'
export const FORCE_FIELD_LINE = new RegExp(`^[ \\t]*(?:[-*][ \\t]*)?\\**(?:${FORCE_FIELD_NAMES})\\**\\s*:`, 'i')
const forceField = (names) => new RegExp(`^[ \\t]*(?:[-*][ \\t]*)?\\**(?:${names})\\**\\s*:`, 'im')
/** The `Stage dependencies:` line of a Force block (VT-5 stage 10): which stage waits for which, written by the orchestrator at the interview. */
export const STAGE_DEPENDENCIES_LINE = forceField('Stage dependencies|Зависимости этапов')
/** The `Taxonomy:` line: the 12 interview categories, each with its status. */
export const TAXONOMY_LINE = forceField('Taxonomy|Таксономия')
/**
 * The 12 categories of the interview taxonomy (stage-force, Step 0), in both languages. `test` finds a category by either name in a `Taxonomy:` line;
 * the short Russian names are matched as whole words.
 */
const word = (source) => new RegExp(`(?<![\\wа-яё])(?:${source})(?![\\wа-яё])`, 'i')
export const TAXONOMY_CATEGORIES = [
  { en: 'Screens and states', ru: 'Экраны и состояния', test: word('screens\\s+and\\s+states|экраны\\s+и\\s+состояния') },
  { en: 'Copy and i18n', ru: 'Тексты и i18n', test: word('copy\\s+and\\s+i18n|тексты\\s+и\\s+i18n') },
  { en: 'Permissions and gating', ru: 'Доступы и гейтинг', test: word('permissions\\s+and\\s+gating|доступы\\s+и\\s+гейтинг') },
  { en: 'Breakpoints', ru: 'Брейкпоинты', test: word('breakpoints|брейкпоинты') },
  { en: 'Motion', ru: 'Анимация', test: word('motion|анимация') },
  { en: 'A11y', ru: 'A11y', test: word('a11y') },
  { en: 'Data', ru: 'Данные', test: word('data|данные') },
  { en: 'Platform parity', ru: 'Паритет платформ', test: word('platform\\s+parity|паритет\\s+платформ') },
  { en: 'Look', ru: 'Вид', test: word('look|вид') },
  { en: 'Terminology', ru: 'Терминология', test: word('terminology|терминология') },
  { en: 'Boundaries', ru: 'Границы', test: word('boundaries|границы') },
  { en: 'Environment and access', ru: 'Окружение и доступ', test: word('environment\\s+and\\s+access|окружение\\s+и\\s+доступ') },
]
/** `Pairs checked: N` (or the Russian form) under "Shared elements" — the overlap scan was done even when the table has no rows. Group 1 is the number. */
export const PAIRS_CHECKED = /(?:pairs\s+checked|проверено\s+пар)\s*(?::\s*)?\**(\d+)/i
/** A stage field line, by its names in the two languages (`State × action:`). */
export const STATE_ACTION_FIELD = /(?:^|\n)[ \t]*(?:[-*][ \t]*)?\**(?:State\s*[×x]\s*action|Состояние\s*[×x]\s*действие)\**\s*:/i
/** The "Design source coverage" and "Shared elements" sections. */
export const COVERAGE_SECTION = /^## (?:Design source coverage|Покрытие дизайн-источника)/m
export const SHARED_SECTION = /^## (?:Shared elements|Общие элементы)/m

/** The word "mode" in a subagent prompt: `Mode: whole-branch` (or the Russian form). */
export const MODE_WORD = 'режим|mode'

/** A blocker `B<n> — …`. */
export const PLAIN_BLOCKER_LINE = /^[^\S\n]*(?:[-*][^\S\n]*)?\**B\d+\**\s*[—–:-]/
/** A blocker `B<n> — …`, or the one carried from an earlier run: `B<n> (<run>) — …` / `B<n> (<run>) text` (stage 5e, K4). */
export const BLOCKER_LINE = /^[^\S\n]*(?:[-*][^\S\n]*)?\**B\d+\**(?:\s*[—–:-]|[^\S\n]*\(\d{1,3}\)\**(?:[^\S\n]*[—–:-]|[^\S\n]+\S))/
/** The `Interview answers` field (or the Russian form): `B<n> (<run>) — accept the recommendation` there answers a blocker, it is not one. */
export const INTERVIEW_FIELD = /^[^\S\n]*(?:[-*][^\S\n]*)?\**(?:Ответы\s+интервью|Interview\s+answers)[^:\n]{0,200}:/i
/**
 * The first day a Force block is read by the fixed lift field alone (VT-2 / stage 5e, K1). A block dated on or after it: a blocker is lifted only by
 * the lift field (`Lifted:`, or its Russian form). An older or undated block keeps the word matcher below (D7: no retrofitting).
 */
export const BLOCKER_FIELD_SINCE = '2026-10-26'
/**
 * Whether a Force block is read by the fixed lift field (K1 + K9 + stage 5h): dated on or after `BLOCKER_FIELD_SINCE`, and — when a `gate` is passed (`blockerGate` in journal-check) — not one the task
 * snapshot already held at the first look of 0.18.2 (`gate.seen`: every block there then, open or closed, whatever its date; they keep the word matcher, D7: the old plugin wrote them with prose lifts).
 * A block written after the first look is not held: the new plugin writes it. With no gate (a test, a bare body) the date alone decides.
 */
export function blockerFieldApplies(gate, heading, body) {
  const date = forceBlockDate(heading, body)
  if (!date || date < BLOCKER_FIELD_SINCE) return false
  return gate ? !gate.seen?.has(forceKey(heading)) : true
}
/** The date of a Force block: its heading, else its `Confirmed:` line (the Russian form too); null when neither has one. */
export const forceBlockDate = (heading, body) => headingDate(heading) ?? headingDate(body.split('\n').find((line) => CONFIRMED_LINE.test(line)) ?? '')
// A date within 120 characters on the same line: who and when.
const LIFT_DATED = /\**[^\S\n]*(?=[^\n]{0,120}(?:\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4}))/.source
const LIFT_TAIL = `\\**[^\\S\\n]*:${LIFT_DATED}`
// The English label in either case; the Russian one only capitalised (the lower-case Russian form in a description means "measured", K12).
const LIFT_LABEL = /(?:[Ll]ifted|Снят)/.source
const LIFT_ID = /^[^\S\n]*(?:[-*][^\S\n]*)?\**B\d+\**(?:[^\S\n]*\(\d{1,3}\)\**)?(?:[^\S\n]*:|[^\S\n]+-)?[^\S\n]+\**/.source
/**
 * The fixed lift field inside a blocker's own text: the lift field (`Lifted:` in either case, or the capitalised Russian form of it) (bold allowed) that opens a segment — right after the ID (and its run; `B1: `, `B1 - `
 * and `B1 (8) ` too), after `—`, `–`, a spaced ` - `, `;`, `.`, and, for the English label only, after `(` — and is followed, within 120 characters on the same line, by a date (`YYYY-MM-DD` or `DD.MM.YYYY`) — who and when.
 * "Lifted: no / none / not / never / pending / TBD / waiting / awaiting / a dash / <who>" (and the Russian forms of not / no / waiting / awaiting) lifts nothing, whatever date follows.
 * After the ID the gap needs a space: two star runs around an optional gap made the pattern quadratic on a run of `*` (S2).
 */
export const BLOCKER_LIFT_FIELD = new RegExp(
  `(?:${LIFT_ID}${LIFT_LABEL}|(?:[—–]|[;.](?=\\s)|[^\\S\\n]-(?=[^\\S\\n]))[^\\S\\n]*\\**${LIFT_LABEL}|\\([^\\S\\n]*\\**[Ll]ifted)${LIFT_TAIL}`,
)
/** The same field alone on an indented sub-item under a blocker (the form of VT-1 B7). */
export const BLOCKER_LIFT_SUBITEM = new RegExp(`^[^\\S\\n]*(?:[-*][^\\S\\n]*)?\\**${LIFT_LABEL}${LIFT_TAIL}`)
const LIFT_DATE = /\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4}/
// A value that says "not lifted" (K13): negation and pending words in either language, whole words, any case. `\b` is ASCII, so the edges are letters and digits.
const NOT_LIFTED_WORD = new RegExp(
  '(?<![\\p{L}\\p{N}_])(?:no|none|not|never|pending|tbd|waiting|awaiting|open|still|yet|false|нет|не|пока|ещё|еще|ждём|ждем|жду|ожида\\p{L}*|открыт\\p{L}*|n/a)(?![\\p{L}\\p{N}_])|[⏳?❌]',
  'iu',
)
// The lift field's segment runs from its value to the next ` — `, `– `, `; ` or the line end (5f, A9). Read in a window of at most LIFT_WINDOW characters, so no match scans to the line end: a line of many fields stays linear.
const LIFT_WINDOW = 300
// The cut also stops at the next lift label with its colon: a line of many fields never folds quotes in a long window (5g, M-3).
const SEGMENT_END = / — |– |; |(?:[Ll]ifted|Снят)\**[^\S\n]*:/
// Quoted text is an answer, not a status: «…», "…", “…” are replaced by one letter before any word test (backticks stay in the value, `no` was an S1 probe).
const LIFT_QUOTED = /«[^»\n]*»|"[^"\n]*"|“[^”\n]*”/g
/** The segment of a lift field that starts at `start` (the first character of its value): cut at the first separator or lift label, then the quotes folded to `Q`. */
function liftSegment(line, start) {
  const window = line.slice(start, start + LIFT_WINDOW)
  const end = SEGMENT_END.exec(window)
  return (end ? window.slice(0, end.index) : window).replace(LIFT_QUOTED, 'Q')
}
/**
 * Reads the field whose label ends at `index + length`: `lifted`, `refused` (a value that is not a lift) or `dateless` (no date in the segment).
 * The shape (5f, B1 answers): `<who> <date> <answer>`. The who is at most 4 words before the first date (or none: a date first), opens with a letter or a digit (the raw first character: a quote may follow a who word or the date, never open the value), and holds no negation or pending word (K13).
 * The request and condition words are refused anywhere in the segment, outside quotes. A `(` opener counts only when its first `)` is the last thing on the line (a `.` or `;` may follow) and no other blocker's ID stands right before it.
 * Done in code after the match, on a bounded window: linear.
 */
function readLiftField(line, index, label) {
  return readField(line, index, label).read
}
/** `readLiftField` with the segment it cut, so a caller that needs the segment too does not cut it twice (5g, M-3). */
function readField(line, index, label) {
  const start = index + label.length
  const segment = liftSegment(line, start)
  const read = classifyField(line, index, label, start, segment)
  return { read, segment }
}
function classifyField(line, index, label, start, segment) {
  const date = LIFT_DATE.exec(segment)
  if (!date) return 'dateless'
  const who = segment.slice(0, date.index)
  // The opener is tested on the raw value: a quote folded to `Q` must not pass for a letter (5g, M-1).
  if (!/^[\p{L}\p{N}]/u.test(line.slice(start, start + 1)) || NOT_LIFTED_WORD.test(who) || (who.match(LIFT_WHO_WORD) ?? []).length > 4) return 'refused'
  if (label[0] === '(') {
    // "waits for B1 (lifted: …)." names another blocker's field: a blocker ID right before the opener, which is not the line's own ID, is not this blocker's lift.
    const before = line.slice(Math.max(0, index - 16), index)
    if (/\bB\d+\**[^\S\n]*$/.test(before) && !/^[^\S\n]*(?:[-*][^\S\n]*)?\**B\d+\**[^\S\n]*$/.test(line.slice(0, index))) return 'refused'
    const raw = line.slice(start, start + LIFT_WINDOW)
    const rawDate = LIFT_DATE.exec(raw)
    const close = rawDate ? raw.indexOf(')', rawDate.index) : -1
    if (close < 0) return 'refused'
    LINE_END.lastIndex = start + close + 1
    if (!LINE_END.test(line)) return 'refused'
  }
  return SEGMENT_REFUSED.test(segment) ? 'refused' : 'lifted'
}
const LIFT_WHO_WORD = /[\p{L}\p{N}][\p{L}\p{N}'’._-]*/gu
const LINE_END = /[.;]?[^\S\n]*$/my
const liftValueOk = (line, match) => readLiftField(line, match.index, match[0]) === 'lifted'
const LIFT_FIELD_ALL = new RegExp(BLOCKER_LIFT_FIELD.source, 'g')
/** The lift field in a blocker's own text: a match whose value is real. One helper for the line form and the sub-item form, on the field path and on the word path (K11). */
export function blockerLiftField(line) {
  LIFT_FIELD_ALL.lastIndex = 0
  for (let match; (match = LIFT_FIELD_ALL.exec(line)); ) {
    if (liftValueOk(line, match)) return true
    if (match[0].length === 0) LIFT_FIELD_ALL.lastIndex++
  }
  return false
}
// The same openers without the date lookahead: the word path blanks a dateless "not yet" field as well (A10).
const LIFT_FIELD_ANY = new RegExp(BLOCKER_LIFT_FIELD.source.split(LIFT_DATED).join('\\**[^\\S\\n]*'), 'g')
/**
 * The line with every lift field that is not a real lift blanked out, so the word matcher of an old block cannot lift on its label (the Russian "not yet" after the Russian label, K13 on the K11 word path).
 * A field with a date is refused by its value; a field with no date is blanked when its segment holds a negation or pending word (A10). One pass, one `replace`: linear.
 */
export function withoutRefusedLiftFields(line) {
  return line.replace(LIFT_FIELD_ANY, (found, offset) => {
    const { read, segment } = readField(line, offset, found)
    const refused = read === 'dateless' ? NOT_LIFTED_WORD.test(segment) : read === 'refused'
    // Blanked with `#`, not spaces: the words before the field must never join its date in the base pattern (5g, M-2).
    return refused ? '#'.repeat(found.length) : found
  })
}
/** The lift field alone on an indented sub-item. */
export function subItemLiftField(line) {
  const match = BLOCKER_LIFT_SUBITEM.exec(line)
  return !!match && liftValueOk(line, match)
}
// A request for the user's answer ("needs a user decision", "awaiting a user answer", and the Russian forms): it lifts nothing, even if the line also says "closed by" or quotes the options.
// One list for both languages: `\b` is ASCII, so in the branches that put it before the list only the English words take part.
const REQUEST_WORDS =
  '(?:needs?|needed|waiting\\s+for|waits?\\s+for|awaiting|pending|requires?|required|нужно|нужен|нужна|нужны|необходим[а-яё]*|жд[её]т|жд[её]м|жду|ожида[а-яё]*|требуется)'
// The words refused anywhere in a lift field's segment, outside quotes (5f, B1): the request words above and the condition words (once, until, after, when, if, need…, require…, asked, blocked, unresolved, will; the Russian forms).
const SEGMENT_REFUSED = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${REQUEST_WORDS}|once|until|till|unless|after|when|whenever|if|need\\p{L}*|require\\p{L}*|asked|requested|blocked|unresolved|tbc|will|later|awaits?|waits?|to\\s+be\\s+(?:confirmed|decided|determined)|после|когда|если|нужн\\p{L}*|необходим\\p{L}*|требу\\p{L}*|спрос\\p{L}*|будет|будут|пока|ждать|ждут)(?![\\p{L}\\p{N}_])`,
  'iu',
)
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
    // Not the noun forms ("closing the flag" and "lifting", in Russian): they describe, they do not lift (stage 5e, K3).
    `${NOT_RU}(?:снят|закрыт|отвечен)(?!и[еяюи])`,
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
const FINAL_MARKER = /\[final:\s*([\w.-]+)\s*[—–-]\s*(?:not\s+run|stale|не\s+запускался|устарел)\s*\]/gi
const FINAL_STATE = { en: { missing: 'not run', stale: 'stale' }, ru: { missing: 'не запускался', stale: 'устарел' } }
/** The final reports a line names by the marker: a Set of `pro-review` / `task-converge` / a configured team review skill. */
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

/** `- team_review: cleanup-review, other-skill` — repo-local review skills the project asks to run as a final checker (stage 12, opt-in). */
const TEAM_REVIEW_LINE = /^[ \t]*-[ \t]*team_review[ \t]*:[ \t]*(.+)$/im
/** The team review skills a config names: skill names (`[\w.-]+`) from the `team_review:` line, `—`/`none`/a placeholder gives an empty list. */
export const teamReviewSkills = (configText) => {
  const value = TEAM_REVIEW_LINE.exec(configText ?? '')?.[1].split('#')[0].replace(/`/g, '') ?? ''
  return value.split(/[,\s]+/).filter((name) => /^[a-z][\w.-]*$/i.test(name) && !NO_GATE_COMMAND.test(name) && !/^(?:skill|name)$/i.test(name))
}

/** The heading of the CI gates table. */
export const CI_GATES_HEADING = /^(#{2,4})[ \t]*(?:Гейты\s+CI|CI\s+gates)\b.*$/im
/** A gate command meaning "none". */
export const NO_GATE_COMMAND = /^(?:нет|—|-|none|no|n\/a)(?![а-яёa-z])/i
/** `kit_overrides: off|false|no|disabled` (and the Russian "none"). */
export const KIT_OVERRIDES_OFF = /^[ \t]*-[ \t]*kit_overrides[ \t]*:[ \t]*`?(?:off|false|no|нет|disabled)(?![\wа-яё])/im

// --- verify map (`<repo>/.claude/verify/`, stage 8) ---

/** The map line of a devtools-verify report: `map: <ids> · entries a/b · drift N` or `map: none — <route> unmapped` (or its Russian form). */
export const MAP_LINE = /^[ \t]*(?:[-*][ \t]*)?`?(?:map|карта)\s*:/im
/** The header line of a feature file: `Routes: … · Auth: … · Platforms: … · Status: draft | verified <date> <sha>`. */
export const MAP_ROUTES_FIELD = /(?:^|[ \t·])(?:Routes|Маршруты)[ \t]*:[ \t]*/i
export const MAP_STATUS_FIELD = /(?:^|[ \t·])(?:Status|Статус)[ \t]*:[ \t]*(draft|verified|черновик|проверено)(?![\p{L}\d])/iu
/** The four sections of a feature file, in the order of the format; each is `[English heading, regexp of both languages]`. */
export const MAP_FEATURE_SECTIONS = [
  ['Sub-features', /^##[ \t]*(?:Sub-features|Подфункции)(?![\p{L}\d])/imu],
  ['How to get to it (user POV)', /^##[ \t]*(?:How to get to it|Как дойти)/im],
  ['Driving it with Chrome DevTools MCP', /^##[ \t]*(?:Driving it with Chrome DevTools MCP|Управление через Chrome DevTools MCP)/im],
  ['Gotchas', /^##[ \t]*(?:Gotchas|Подводные камни)(?![\p{L}\d])/imu],
]
/** The texts `verify-map.mjs --init` writes, per task language. Values come from the config; a missing one is the `notSet` slot, never a guess. */
export const MAP_TEXT = {
  en: {
    title: 'Verify map',
    base: 'Base',
    updated: 'Updated',
    notSet: 'not set',
    instance: 'Instance and doctor',
    preconditions: 'Baseline preconditions',
    conventions: 'Driving conventions',
    proof: 'Proof and skip reporting',
    features: 'Features (sweep order)',
    dev: 'Dev',
    marker: 'App marker',
    routes: 'Baseline routes',
    ready: 'Ready = the baseline routes answer 200 and the marker is on the page (`node ${CLAUDE_PLUGIN_ROOT}/scripts/verify-doctor.mjs`)',
    auth: 'Auth',
    e2e: 'E2E command',
    playwright: 'Playwright / storageState',
    data: 'Data',
    writes: 'Stand writes',
    surface: 'Surface',
    widths: 'desktop widths',
    webview: 'webview',
    theme: 'Theme',
    conv1: 'Handles as take_snapshot prints them (`button "Save"`), then data-testid, then aria-label; never CSS classes',
    conv2: 'click and fill by uid; no el.click() inside evaluate; evaluate only arranges preconditions or reads state after the user path',
    conv3: 'wait for an observable end state, no sleeps',
    proof1: 'action + resulting state; feature id + entry point on every artifact',
    proof2: 'mutation: request (method, path, status, key fields) + read-back after reload or a second view',
    proof3: 'a skipped entry point is not verified through another one; unreachable = prerequisite + route tried + closest path covered',
    none: 'none yet — feature-checker adds `- [<id>](features/<id>.md) — <route>`',
  },
  ru: {
    title: 'Карта проверки',
    base: 'База',
    updated: 'Обновлено',
    notSet: 'не задано',
    instance: 'Стенд и doctor',
    preconditions: 'Исходные условия',
    conventions: 'Правила управления',
    proof: 'Доказательства и пропуски',
    features: 'Фичи (порядок обхода)',
    dev: 'Dev',
    marker: 'Метка приложения',
    routes: 'Базовые маршруты',
    ready: 'Готово = базовые маршруты отвечают 200 и метка есть на странице (`node ${CLAUDE_PLUGIN_ROOT}/scripts/verify-doctor.mjs`)',
    auth: 'Вход',
    e2e: 'Команда E2E',
    playwright: 'Playwright / storageState',
    data: 'Данные',
    writes: 'Записи на стенд',
    surface: 'Поверхность',
    widths: 'ширины десктопа',
    webview: 'webview',
    theme: 'Тема',
    conv1: 'Ручки так, как их печатает take_snapshot (`button "Save"`), затем data-testid, затем aria-label; не CSS-классы',
    conv2: 'click и fill по uid; без el.click() внутри evaluate; evaluate только готовит условия или читает состояние после пользовательского пути',
    conv3: 'ждать наблюдаемого конечного состояния, без sleep',
    proof1: 'действие + получившееся состояние; id фичи + точка входа на каждом артефакте',
    proof2: 'мутация: запрос (метод, путь, статус, ключевые поля) + чтение после перезагрузки или в другом виде',
    proof3: 'пропущенная точка входа не проверяется через другую; недоступна = условие + пробованный маршрут + ближайший пройденный путь',
    none: 'пока нет — feature-checker добавит `- [<id>](features/<id>.md) — <маршрут>`',
  },
}
/** A config value meaning "none" (the same words as NO_GATE_COMMAND, whole value). */
export const NO_VALUE = /^(?:—|-|–|none|no|нет|n\/a)$/i
/** The FEATURE-MAP "Entry points" heading and the route / files columns of its table, both languages. */
export const ENTRY_POINTS_HEADING = /^##\s*(?:Entry points|Точки входа)\s*$/i
export const ENTRY_ROUTE_COLUMN = /^(?:Route|Маршрут|Роут)/i
export const ENTRY_FILES_COLUMN = /^(?:Files?|Файл)/i

// --- proof of effects and re-observation (stage 9) ---

/** The `[effect]` tag of an acceptance criterion, right beside the verifier tag, either order: `— [verify: devtools-verify] [effect]` (Russian form: language.md). `[^\][]` stops at the next bracket: a line of `[verify:` repeats is not quadratic. */
export const EFFECT_NEXT_TO_VERIFY = /\[verify:[^\][]*\]\s*\[(?:effect|эффект)\]|\[(?:effect|эффект)\]\s*\[verify:[^\][]*\]/i
/** A request line in a report: `POST /api/contracts → 201 …` — a method, a path (or a URL) and a status code within the same line; the status is read after the whole path token, a digit inside the path (`/orders/123`) is not one. */
export const REQUEST_PROOF = /\b(?:GET|POST|PUT|PATCH|DELETE)[ \t]+(?:https?:\/\/\S+|\/\S*)(?=\s|$)[^\n]{0,160}?(?<![\d.])[1-5]\d\d(?![\d.])/
/** The read-back of an effect: the state read again after a reload or from a second view (either language). */
export const READBACK_PROOF = /read[- ]?back|after\s+(?:a\s+|the\s+)?(?:page\s+)?(?:reload|refresh)|reload(?:ed)?|second\s+(?:view|tab|page|session)|another\s+(?:view|tab)|перезагруз|обновлени[ея]\s+страницы|прочита\w*\s+(?:обратно|заново|снова)|чтени[ея]\s+после|втор(?:ой|ом|ая)\s+(?:вкладк|вид|страниц|сесси)|друго[йм]\s+(?:вкладк|виде|вид)/i
/** A re-run artifact a runtime `fixed` cites: the recheck report of the SAME stage (`devtools-verify-<stage>-` + this suffix: `r<k>`, `fresh`, `recheck[-<k>]`) or a screenshot under this task's `checks/screens/`. */
export const RERUN_SUFFIX = /^(?:r\d+|fresh[\w-]*|recheck(?:-?\d+)?)\.md$/i
export const RERUN_SCREEN = /^(?:checks\/)?screens\/[\w.-]+\.(?:png|jpe?g|webp)$/i
/** A partial devtools-verify run: the recheck of named findings (`devtools-verify-<stage>-r<k>.md`) and the before-fix repro (`…-repro.md`). It measures what it was asked to, not the geometry of every width. */
export const PARTIAL_RUN = /^(?:devtools-verify(?:-\w+)*|(?:stage|этап)-?\d+[a-z]?-devtools-verify)-(?:r\d+|repro|recheck(?:-?\d+)?)\.md$/i
