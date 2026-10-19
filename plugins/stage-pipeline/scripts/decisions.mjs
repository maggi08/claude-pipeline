/**
 * Decisions taken alone — VT-1 stage 5. The lines of "Awaiting user confirmation" and the assumptions of a Force block are what a run decided without the user.
 * On PLI-3474 about 10 of 13 such lines were reworked, some after they reached prod; a line that says only "accepted X" cannot be weighed by the person reading it.
 * A new line carries a rollback cost (what it takes to undo the decision if it is wrong) and a basis (what the decision stands on):
 * `Basis: <path:line | node-id | URL | "a ticket quote" | a decision id (D2, A4, AC-3.1) | guess>`. Where it is visible stays in the skill text (stage-force, stage-check Step 4.1).
 * The digest sorts the rows by the cost, expensive first.
 *
 * Only new lines (D7): a line in the task's base snapshot is not touched, see `baselineInfo`.
 */
import { AWAITING_SECTION } from './markers.mjs'

const ITEM = /^\s*(?:[-*]|\d+\.)\s+\S/
const FIELD_LINE = /^\s*(?:[-*]\s*)?\**(?:Unresolved|Незакрытое|Boundaries|Границы|Confirmed|Подтверждено|Blockers|Блокеры|Interview answers|Ответы интервью|Mode|Режим)\**\s*:/i
const ASSUMPTIONS_LINE = /^\s*(?:[-*]\s*)?\**(?:Assumptions|Допущения)\**\s*:/i
const EMPTY_ITEM = /^\s*(?:[-*]|\d+\.)\s+(?:\**(?:none|нет|n\/a|—|-)\**\.?\s*$|\[x\]|~~|✅)/i

const COST = /\brollback\b|\breversible\s+(?:via|by|through)\b|\bundo\b|(?<![а-яё])откат|(?<![а-яё])обратим[\wа-яё]*\s+(?:через|по)\b/i
const BASIS_LABEL = /(?:^|[\s(;.,])(?:basis|основани[ея])\s*:\s*([^\n]*)/i
// path:line, a file with an extension, node-id, URL, a quote, a decision/criterion/blocker id, "guess"
const BASIS_VALUE =
  /[\w@./-]+\.[A-Za-z]{1,5}(?::\d+)?(?![\w-])|\b\d+[:-]\d+\b|https?:\/\/|«[^»]{4,}»|“[^”]{4,}”|"[^"]{4,}"|(?<![\w-])(?:AC|[DABMFK])-?\d+[\w.]*|\bguess\b|(?<![а-яё])догадк|\binterview\s+answer|(?<![а-яё])ответ\s+интервью|\bticket\b|(?<![а-яё])тикет/i

/** Top-level items of a section's lines: a bullet and everything indented under it (a nested bullet is part of its parent). */
function groupItems(lines) {
  const items = []
  for (const entry of lines) {
    // An inline `Assumptions: <text>` arrives as `{ line: '- <text>', raw }`: the item reads as a bullet, but its fingerprint key is the journal line itself.
    const { line, raw } = typeof entry === 'string' ? { line: entry, raw: entry.trim() } : entry
    const indent = line.match(/^\s*/)[0].length
    if (ITEM.test(line) && indent < 2) items.push({ first: line.trim(), raw, text: line.trim() })
    else if (items.length && line.trim()) items.at(-1).text += ` ${line.trim()}`
  }
  return items
}

const sectionLines = (text, heading) => {
  const start = text.search(heading)
  if (start === -1) return []
  const body = text.slice(start).split('\n').slice(1)
  const end = body.findIndex((line) => /^## /.test(line))
  return end === -1 ? body : body.slice(0, end)
}

/** Assumption lines of every Force block: the bullets under `Assumptions:` up to the next field. */
function assumptionLines(text) {
  const out = []
  let inForce = false
  let inAssumptions = false
  for (const line of text.split('\n')) {
    if (/^## /.test(line)) {
      inForce = /^## (?:Force-прогон|Force run)/.test(line)
      inAssumptions = false
      continue
    }
    if (!inForce) continue
    if (ASSUMPTIONS_LINE.test(line)) {
      inAssumptions = true
      // The stage-force template writes the assumption on the line itself: `Assumptions: <what — why — Rollback: … — Basis: …>`. (`Interview answers:` is not
      // an evidence field: it records what the user said, not what the run accepted, so only `Assumptions:` is read inline.)
      // `**Допущения:**` is a header: the closing `**` is not an item, so emphasis marks are cut from both ends and an empty rest pushes nothing.
      const inline = line.replace(ASSUMPTIONS_LINE, '').replace(/^[\s*_]+|[\s*_]+$/g, '')
      if (inline) out.push({ line: `- ${inline}`, raw: line.trim() })
      continue
    }
    if (FIELD_LINE.test(line)) inAssumptions = false
    else if (inAssumptions) out.push(line)
  }
  return out
}

/** Every decision item of the journal text: `{ kind: 'awaiting' | 'assumption', first, text }`. */
function decisionItems(text) {
  return [
    ...groupItems(sectionLines(text, AWAITING_SECTION)).map((item) => ({ ...item, kind: 'awaiting' })),
    ...groupItems(assumptionLines(text)).map((item) => ({ ...item, kind: 'assumption' })),
  ].filter((item) => !EMPTY_ITEM.test(item.first))
}

/** What a decision item lacks: a list of `rollback` / `basis`. */
function missingEvidence(item) {
  const missing = []
  if (!COST.test(item.text)) missing.push('rollback')
  const basis = item.text.match(BASIS_LABEL)?.[1] ?? ''
  if (!BASIS_VALUE.test(basis)) missing.push('basis')
  return missing
}

/** Violations of the journal text: one per item without a rollback cost or a basis. `line` is the first journal line of the item (what the baseline snapshot keys on). */
export function decisionViolations(text) {
  return decisionItems(text).flatMap((item) => {
    const missing = missingEvidence(item)
    if (!missing.length) return []
    const where = item.kind === 'awaiting' ? 'Awaiting line' : 'Assumption'
    return [
      {
        rule: 'decision-evidence',
        id: item.kind,
        line: item.raw ?? item.first,
        message:
          `${where} "${item.first.replace(/^(?:[-*]|\d+\.)\s+/, '').slice(0, 80)}" has no ${missing.map((what) => (what === 'rollback' ? 'rollback cost' : 'basis')).join(' and no ')}. ` +
          'A decision taken alone carries: where it is visible, "Rollback: <what undoing it costs — cheap, one constant / moderate, three skill texts / expensive, a migration>" ' +
          'and "Basis: <path:line | node-id | a ticket quote | a decision id | guess>" — an explicit "Basis: guess" is allowed, a missing basis is not.',
      },
    ]
  })
}

// ── the digest: rows sorted by rollback cost ─────────────────────────────────

const EXPENSIVE = /expensive|costly|irreversible|data\s+migration|дорог|необратим|миграци/i
const MODERATE = /moderate|medium|several|умеренн|средн|нескольк/i
const CHEAP = /cheap|trivial|one\s+(?:line|constant|string|key|commit|flag|file|row)|none\s+needed|nothing\s+to\s+(?:undo|roll)|д[её]шев|один\s+(?:коммит|параметр|констант|строк|файл|ключ)|ничего\s+откатывать/i

const COST_WORDS = new RegExp(`(${EXPENSIVE.source})|(${MODERATE.source})|(${CHEAP.source})`, 'gi')

/** 0 expensive, 1 no cost stated, 2 moderate, 3 cheap — the first non-negated cost word after "rollback", before the Basis clause. */
export function rollbackRank(text) {
  const at = text.search(/\brollback\b|(?<![а-яё])откат/i)
  const from = at === -1 ? text : text.slice(at)
  // The cost is what follows "rollback" up to the Basis clause; the first cost word wins unless it is negated ("not expensive", "no data migration", "без миграции").
  const tail = from.split(/(?:^|[\s(;.,])(?:basis|основани[ея])\s*:/i)[0]
  for (const found of tail.matchAll(COST_WORDS)) {
    if (/(?:\bnot|\bno|n['’]t|(?<![а-яё])не|(?<![а-яё])без)\s+$/i.test(tail.slice(Math.max(0, found.index - 8), found.index))) continue
    return found[1] ? 0 : found[2] ? 2 : 3
  }
  return 1
}

/** A bullet line of a section and the lines under it up to the next bullet — the text its rollback cost is read from. */
export function bulletText(lines, index) {
  let end = index + 1
  while (end < lines.length && !ITEM.test(lines[end])) end++
  return lines.slice(index, end).join(' ')
}
