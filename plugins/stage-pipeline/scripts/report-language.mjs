/**
 * The language of a checker report's prose: journal-gate sends back to its author a `checks/` report not written in the task language (see plugins/stage-pipeline/references/language.md).
 *
 * Prose words are counted: Cyrillic against Latin. Not counted: code blocks, inline backticks, quotes «…» and "…",
 * links, paths, identifiers (`AC-3.1`, `M-1`, `B1`, `devtools-verify`, camelCase), severity words and PASS/FAIL.
 * A short report and a report with a share outside the "grey zone" is not judged: a false return is worse than a miss.
 */

/** Fewer prose words — the language is not determined. */
const MIN_WORDS = 40
/** A ru task: the report is sent back if the Cyrillic share of the prose is below this. */
const RU_SHARE_MAX = 0.2
/** An en task: the report is sent back if the Cyrillic share of the prose is above this. */
const EN_SHARE_MAX = 0.5

const STOP = new Set(['critical', 'major', 'minor', 'high', 'medium', 'low', 'severity', 'pass', 'fail', 'skip', 'todo', 'ok', 'etc'])

/** The report text without what is not prose. */
function stripNonProse(text) {
  // An unclosed "<!--" is not a comment: without "-->" in the text the pattern is not run (a lazy scan from each "<!--" is quadratic).
  const source = text.includes('-->') ? text.replace(/<!--[\s\S]*?-->/g, ' ') : text
  return source
    .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/«[^«»\n]*»/g, ' ')
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/“[^“”\n]*”/g, ' ')
    .replace(/\]\([^()\n]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
}

/** The token without leading and trailing non-letters and non-digits (a scan from both ends: a `[^…]+$` regexp is quadratic on "a!!!…!a"). */
function trimNonWord(raw) {
  const chars = Array.from(raw)
  const word = (char) => /[\p{L}\d]/u.test(char)
  let start = 0
  let end = chars.length
  while (start < end && !word(chars[start])) start++
  while (end > start && !word(chars[end - 1])) end--
  return chars.slice(start, end).join('')
}

/** Prose words: `{ ru, en }`. */
function proseWords(text) {
  let ru = 0
  let en = 0
  for (const raw of stripNonProse(text).split(/\s+/)) {
    const token = trimNonWord(raw)
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
function reportLanguage(text) {
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
