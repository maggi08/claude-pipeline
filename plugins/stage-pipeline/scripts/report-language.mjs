/**
 * Язык прозы отчёта чекера (D9): journal-gate возвращает автору отчёт `checks/`, написанный не на языке задачи.
 *
 * Считаются слова прозы: кириллические против латинских. Не считаются код-блоки, инлайн-бэктики, цитаты «…» и "…",
 * ссылки, пути, идентификаторы (`AC-3.1`, `M-1`, `B1`, `devtools-verify`, camelCase), слова severity и PASS/FAIL.
 * Короткий отчёт и отчёт с долей вне «серой зоны» не оценивается: ложный возврат хуже пропуска.
 */

/** Меньше слов прозы — язык не определяется. */
export const MIN_WORDS = 40
/** Русская задача: отчёт возвращается, если доля кириллицы в прозе ниже. */
export const RU_SHARE_MAX = 0.2
/** Английская задача: отчёт возвращается, если доля кириллицы в прозе выше. */
export const EN_SHARE_MAX = 0.5

const STOP = new Set(['critical', 'major', 'minor', 'high', 'medium', 'low', 'severity', 'pass', 'fail', 'skip', 'todo', 'ok', 'etc'])

/** Текст отчёта без того, что не является прозой. */
export function stripNonProse(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/«[^»\n]*»/g, ' ')
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/“[^”\n]*”/g, ' ')
    .replace(/\]\([^)\n]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
}

/** Слова прозы: `{ ru, en }`. */
export function proseWords(text) {
  let ru = 0
  let en = 0
  for (const raw of stripNonProse(text).split(/\s+/)) {
    const token = raw.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, '')
    if (!token || /[/\\@_\d]/.test(token)) continue
    const cyrillic = token.match(/[а-яёА-ЯЁ]/g)?.length ?? 0
    if (cyrillic) {
      if (cyrillic >= 3) ru++
      continue
    }
    if (!/^[A-Za-z]{3,}(?:['’][a-z]+)?$/.test(token) || /[a-z][A-Z]/.test(token) || token === token.toUpperCase() || STOP.has(token.toLowerCase())) continue
    en++
  }
  return { ru, en }
}

/** `{ ru, en, share }`, где share — доля кириллицы в прозе; `share: null` — прозы слишком мало. */
export function reportLanguage(text) {
  const { ru, en } = proseWords(text)
  return { ru, en, share: ru + en < MIN_WORDS ? null : ru / (ru + en) }
}

/** Язык отчёта не совпадает с языком задачи (`ru` | `en`); `null`/неизвестный язык задачи — не проверяется. */
export function languageMismatch(text, language) {
  if (language !== 'ru' && language !== 'en') return null
  const { share, ru, en } = reportLanguage(text)
  if (share === null) return null
  if (language === 'ru' && share < RU_SHARE_MAX) return { share, ru, en, wrote: 'en' }
  if (language === 'en' && share > EN_SHARE_MAX) return { share, ru, en, wrote: 'ru' }
  return null
}
