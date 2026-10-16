/**
 * Структурные маркеры, которые скрипты и хуки читают из STAGES.md, STAGES-ARCHIVE.md, checks/,
 * блока Force и pipeline.config.md, — каждый в форме RU|EN. Задача пишется на одном из двух языков,
 * парсер принимает оба: живые задачи никто не переписывает под новую версию плагина.
 *
 * Английские формы — из .claude/tasks/EN-1/GLOSSARY.md (ядро и раздел A). Фразовые эвристики
 * journal-check (итоги, оговорки, «нет данных») сюда не входят. Тексты, которые скрипты ПИШУТ,
 * остаются у скриптов.
 */

const re = (source, flags = '') => new RegExp(source, flags)

// --- STAGES.md: заголовки и поля ---

/** `## Этап 3: …` / `### Stage A0 …` — группа 1 уровень заголовка, группа 2 номер. */
export const STAGE_HEADING = /^(#{2,3}) (?:Этап|Stage) ([\w.]+)/
/** Тот же заголовок, но с номером из `number` (строка, не регэксп). */
export const stageHeadingOf = (number) => re(`^###\\s+(?:Этап|Stage)\\s+${number}(?![\\w.])[^\\n]*$`, 'm')
/** «этап 3» / «stage 3» в строке журнала и коммита — группа 1 номер. */
export const STAGE_MENTION = /(?:этап[а-я]*|(?<![\w-])stage)\s+([\w.]+)/i
/** Имя файла отчёта: `stage-3-…`, `этап-3-…` — группа 1 номер. */
export const STAGE_FILE = /(?:stage|этап)-?(\d+[a-z]?)\b/i

export const STATUS_LINE = /^## (?:Статус|Status):\s*(.+)$/m
/** Закрытый этап в заголовке `[status: …]`; `отмен` — русская форма «отменён». */
export const CLOSED_STAGE = /\[status:\s*(done|cancelled|отмен)/i

export const JOURNAL_HEADING = /^## (?:Журнал|Journal)(?:\s|$)/i
/** Разделы, внутри которых заголовки этапов — не этапы. */
export const PROTECTED_SECTION = /^#{1,2} (Force-прогон|Force run|Журнал|Journal)/i
/** Строки закрытого этапа, которые сворачивание оставляет (коммит, решения, metrics, незакрытое). */
export const KEEP_LINE =
  /^(\s*[-*]\s*)?(\*\*)?(Коммит|Commit|Решени|Decision|metrics:)|^\s*[-*]\s*\[x\]\s*commit:|^\s*[-*]\s*\[ \](?!.*\bskip\b)|\[live:|⏳/i
/** Заглушка в STAGES.md на месте свёрнутого этапа (читается; пишет скрипт). */
export const ARCHIVED_STUB = /^(?:Полная запись|Full record): STAGES-ARCHIVE\.md/
/** Строка-счётчик в преамбуле журнала: `Старые записи (N)` / `Older entries (N)` — группа 1 число. */
export const OLDER_ENTRIES = /^(?:Старые записи|Older entries) \((\d+)\)/

/** Раздел «Ожидают подтверждения (пользователя)». */
export const AWAITING_SECTION = /^## ⚠?\s*(?:Ожидают подтверждения|Awaiting user confirmation)/m

/** Поле этапа «Эталон вида: …» — группа 1 значение. */
export const VISUAL_REFERENCE_FIELD = /(?:эталон\s+вида|visual\s+reference)\**\s*:\s*(.+)$/im
/** Значение поля, которое значит «эталона нет». */
export const NO_VISUAL_REFERENCE = /^(?:—|-|нет|n\/a|не\s+нужен|none(?![\wа-яё])|not\s+needed)/i
/** Таблица «Паритет» в журнале (в `ds-parity` и т. п. слово — имя скилла, не таблица). */
export const PARITY_TABLE = /паритет|^[ \t>*-]*\**parity\**[ \t]*:|^#{1,6}[ \t]+parity(?![\w-])|\|[ \t]*parity(?![\w-])/im

// --- Шапка: язык и ветка ---

/** `Язык: ru` / `Language: en` в шапке — группа 1 значение. */
export const LANGUAGE_LINE = /(?:^[ \t>*-]*|\s{2,}|[·|]\s*)\**(?:Язык|Language)\**[ \t]*:\**[ \t]*`?(ru|en)\b/im
/** Заголовки, по которым язык задачи определяется без строки `Язык:`. */
export const RU_HEADINGS = /^(?:##\s+Журнал|###?\s+Этап\s+[\w.]+)/m
export const EN_HEADINGS = /^(?:##\s+Journal|###?\s+Stage\s+[\w.]+)/m

/** Слова-метки ветки в шапке (источник регэкспа taskBranches). */
export const BRANCH_LABEL = 'Ветк[аи](?:\\s+задачи)?|Branch(?:es)?'
/** Слова, после которых в значении ветки идёт «откуда отведена / куда влита». */
export const BRANCH_BOUNDARY =
  'от|из|from|off|cut\\s+from|branched|rebased|срезана|отведена|пересажена|база|base|влита|merged|→|PR\\b'
/** Значение «ветки нет». */
export const NO_BRANCH = /^(TBD|нет|none|n\/a|—)$/i

// --- Блок Force-прогона ---

/** Заголовки `## Force-прогон …` / `## Force run …`. Каждый вызов — свежий регэксп (флаг g). */
export const forceHeadings = (text) => [...text.matchAll(/^## (?:Force-прогон|Force run).*$/gm)]
export const FORCE_BLOCK_PRESENT = /^## (?:Force-прогон|Force run)/m
/** «завершён» / «completed» — закрытие прогона. */
export const CLOSED_WORD = /заверш|completed/i
/** «завершён с блокерами» / «completed with blockers». */
export const WITH_BLOCKERS = /с\s+блокер|with\s+blockers/i
/** В строке статуса: «force-прогон … завершён» / «force run … completed» (без «не»). */
const FORCE_CLOSED_RU = 'force-прогон[^.;\\n]{0,40}?завершён'
const FORCE_CLOSED_EN = 'force run[^.;\\n]{0,40}?completed'
export const STATUS_FORCE_CLOSED = re(`${FORCE_CLOSED_RU}|${FORCE_CLOSED_EN}`, 'i')
/** То же плюс хвост со срезом даты (до 20 символов). */
export const STATUS_FORCE_CLOSED_WITH_DATE = re(`${FORCE_CLOSED_RU}[^.;\\n]{0,20}|${FORCE_CLOSED_EN}[^.;\\n]{0,20}`, 'i')
export const NOT_CLOSED = /не\s+завершён|not\s+completed/i

/** Строка `Подтверждено:` / `Confirmed:` в блоке Force. */
export const CONFIRMED_LINE = /^\s*[-*]?\s*\**(?:Подтвержд[её]н[оа]?|Confirmed)\**\s*:/im
/** Слово «режим» в промпте субагента: `Режим: whole-branch` / `Mode: whole-branch`. */
export const MODE_WORD = 'режим|mode'

/** Блокер `B<n> — …`. */
export const BLOCKER_LINE = /^\s*[-*]?\s*\**B\d+\**\s*[—–:-]/
/** Блокер снят: `снят / решён / закрыт / отвечен / ответ|решение пользователя` и английские формы. */
export const BLOCKER_LIFTED =
  /снят|реш[её]н|закрыт|отвечен|ответ\s+пользователя|решение\s+пользователя|lifted\s+by|resolved\s+by|resolved:|closed\s+by|answered\s+by|user\s+answer|user\s+decision/i

// --- Отчёты checks/ ---

/** Структурная форма сводки dead-code: `1 удалить` / `1 to remove` / `1 remove` — группа 1 число. */
export const DEAD_CODE_REMOVE = /(\d+)\s*(?:удалить(?![а-яё])|(?:to\s+)?remove(?![\w-]))/i

/** Заголовок «Итог находок» / «Findings outcome» (`##` или `###`). */
export const LEDGER_HEADING = /^#{2,3}\s*(?:Итог находок|Findings outcome)/im
/** Заголовок «Не удалось проверить» / «Could not verify». */
export const UNVERIFIED_HEADING = /^#{2,3}\s*(?:Не удалось проверить|Could not verify)/im
/** Строка сводки второй строкой отчёта: `Находки: critical N · major N` / `Findings: …`. */
export const SUMMARY_STANDARD = /(?:Находки|Findings):\s*critical\s*\d+\s*·\s*major\s*\d+/i

// --- pipeline.config.md ---

/** Заголовок таблицы гейтов CI. */
export const CI_GATES_HEADING = /^(#{2,4})\s*(?:Гейты\s+CI|CI\s+gates)\b.*$/im
/** Команда гейта «нет». */
export const NO_GATE_COMMAND = /^(?:нет|—|-|none|no|n\/a)(?![а-яёa-z])/i
/** `kit_overrides: off|false|no|нет|disabled`. */
export const KIT_OVERRIDES_OFF = /^\s*-\s*kit_overrides\s*:\s*`?(?:off|false|no|нет|disabled)(?![\wа-яё])/im
