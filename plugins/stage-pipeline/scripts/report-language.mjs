/**
 * The language of a checker report's prose (D9): journal-gate sends back to its author a `checks/` report not written in the task language.
 *
 * Prose words are counted: Cyrillic against Latin. Not counted: code blocks, inline backticks, quotes «…» and "…",
 * links, paths, identifiers (`AC-3.1`, `M-1`, `B1`, `devtools-verify`, camelCase), severity words and PASS/FAIL.
 * A short report and a report with a share outside the "grey zone" is not judged: a false return is worse than a miss.
 */

/** Fewer prose words — the language is not determined. */
export const MIN_WORDS = 40
/** A ru task: the report is sent back if the Cyrillic share of the prose is below this. */
export const RU_SHARE_MAX = 0.2
/** An en task: the report is sent back if the Cyrillic share of the prose is above this. */
export const EN_SHARE_MAX = 0.5

const STOP = new Set(['critical', 'major', 'minor', 'high', 'medium', 'low', 'severity', 'pass', 'fail', 'skip', 'todo', 'ok', 'etc'])

/** The report text without what is not prose. */
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

/** Prose words: `{ ru, en }`. */
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

/** `{ ru, en, share }`, where share is the Cyrillic share of the prose; `share: null` — too little prose. */
export function reportLanguage(text) {
  const { ru, en } = proseWords(text)
  return { ru, en, share: ru + en < MIN_WORDS ? null : ru / (ru + en) }
}

/** The report language does not match the task language (`ru` | `en`); `null`/an unknown task language — not checked. */
export function languageMismatch(text, language) {
  if (language !== 'ru' && language !== 'en') return null
  const { share, ru, en } = reportLanguage(text)
  if (share === null) return null
  if (language === 'ru' && share < RU_SHARE_MAX) return { share, ru, en, wrote: 'en' }
  if (language === 'en' && share > EN_SHARE_MAX) return { share, ru, en, wrote: 'ru' }
  return null
}
