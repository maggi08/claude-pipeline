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

// --- STAGES.md: headings and fields ---

/** `### Stage A0 …` heading (or its Russian form) — group 1 is the heading level, group 2 the number. */
export const STAGE_HEADING = /^(#{2,3}) (?:Этап|Stage) ([\w.]+)/
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
export const FORCE_BLOCK_PRESENT = /^## (?:Force-прогон|Force run)/m
/** "completed" or "complete" (or the Russian form) — the run is closed. "complete" is accepted on purpose: a heading that closes the run in
 * neither form would leave it both open (forceActive) and not checked on close (forceCloseViolations).
 * "completed" right after a dash or a colon closes with any tail ("— completed on 2026-10-18", "— completed (B1 open)", "— completed, with blockers").
 * "complete" closes only before a date, "with blockers" or at the end of the heading after a dash ("— complete"; "stage 3 complete" is progress): "— complete the migration" is an ordinary title word. */
export const CLOSED_WORD = /заверш|\bcomplete(?:d)?\b(?=\s*(?:with\s+blockers\b|\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}))|(?<=(?:\s[—–-]|[—–:])\s*)\bcompleted\b|(?<=(?:\s[—–-]|[—–:])\s*)\bcomplete\s*$/im
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
const NOT_BEFORE = '(?<!\\bnot\\s)'
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
    'снят|закрыт|отвечен',
    // The Russian "resolved" (masculine, neuter, feminine) as a word of its own, without a negation before it: the noun "decision" and "not resolved" do not lift.
    '(?<![а-яё])(?<!не\\s)реш[её]н[оа]?(?![а-яё])',
    // "Needs the user's decision/answer …" is a request, not a lift: the answer (ANSWER_*) must follow the words, and a request word must not stand before them (the Russian forms too).
    `(?<!${REQUEST_WORDS}\\s+)(?:ответ|решение)\\s+пользователя${ANSWER_RU}`,
    `${NO_REQUEST_BEFORE}${NOT_BEFORE}\\b(?:lifted|closed|answered)\\s+by${NO_REQUEST_AFTER}|${NO_REQUEST_BEFORE}${NOT_BEFORE}\\bresolved\\s+by${NO_REQUEST_AFTER}|(?<![\\w-])${NOT_BEFORE}resolved:`,
    // "waiting for a user answer", "needs a user decision — I recommend "v2"" are requests; the answer after the words (ANSWER_*) makes it a lift.
    `(?<!\\b${REQUEST_WORDS}\\s+(?:an?\\s+|the\\s+)?)\\buser\\s+(?:answer|decision)${ANSWER_EN}`,
  ].join('|'),
  'i',
)

// --- checks/ reports ---

/** The structural form of the dead-code summary: `1 to remove` / `1 remove` (or the Russian form) — group 1 is the number. */
export const DEAD_CODE_REMOVE = /(\d+)\s*(?:удалить(?![а-яё])|(?:to\s+)?remove(?![\w-]))/i

/** The "Findings outcome" heading (`##` or `###`). */
export const LEDGER_HEADING = /^#{2,3}\s*(?:Итог находок|Findings outcome)/im
/** The "Could not verify" heading. */
export const UNVERIFIED_HEADING = /^#{2,3}\s*(?:Не удалось проверить|Could not verify)/im
/** The summary line, second line of a report: `Findings: critical N · major N` (or the Russian form). */
export const SUMMARY_STANDARD = /(?:Находки|Findings):\s*critical\s*\d+\s*·\s*major\s*\d+/i

// --- pipeline.config.md ---

/** The heading of the CI gates table. */
export const CI_GATES_HEADING = /^(#{2,4})\s*(?:Гейты\s+CI|CI\s+gates)\b.*$/im
/** A gate command meaning "none". */
export const NO_GATE_COMMAND = /^(?:нет|—|-|none|no|n\/a)(?![а-яёa-z])/i
/** `kit_overrides: off|false|no|disabled` (and the Russian "none"). */
export const KIT_OVERRIDES_OFF = /^\s*-\s*kit_overrides\s*:\s*`?(?:off|false|no|нет|disabled)(?![\wа-яё])/im
