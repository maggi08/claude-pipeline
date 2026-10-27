#!/usr/bin/env node
/**
 * Rule -> enforcer table of the skills (VT-3 stage 7, K7.4). Dev repo only, not part of the plugin.
 *
 * The skills are prose; prose rules decay and hooks hold (audit 0.11). This keeps a count of how many rules of the skills only exist as prose,
 * so that the number can only go down on purpose:
 *
 *   1. `extractImperatives(text)` finds the imperatives of one SKILL.md deterministically (heuristic below).
 *   2. Each one is keyed `<skill>#<hash of the normalised sentence>` and mapped in `scripts/rule-enforcers.json` to
 *      `hook:<rule ID>` (an ID of scripts/hook-rules.json) | `script:<path in the repo>` | `prose`.
 *   3. `checkEnforcers` (run by validate.mjs) fails on an imperative that is not in the table, on a `hook:` / `script:` target that does not exist,
 *      and when the number of prose-only imperatives passes the recorded baseline - naming the skill and the line.
 *
 * Heuristic (stable rather than exhaustive - a rule written without these words is not seen, and that is accepted):
 *   - the text is taken without the frontmatter, fenced code blocks and HTML comments;
 *   - a unit is one sentence (a line is cut at `. ` / `! ` / `? ` followed by a capital letter, a backtick, a bold mark or a bracket); table rows are cells-joined, one unit each;
 *   - a unit is an imperative when it has one of: must, never, always, do not / don't / do NOT, forbidden, mandatory, required, prohibited, is/are rejected,
 *     is/are not allowed, "is a ban" / "ban on", "not a ... : " no. Plain `only` and `should` are NOT triggers: they mark scope and advice far more often than a rule;
 *   - or when it is led by a bold phrase that is a rule head: a list item or paragraph starting with `**...**` that is an instruction (contains one of the words above
 *     in the bold part or in the first sentence) - covered by the first trigger, so a bold head alone is not a trigger;
 *   - the key hashes the sentence after normalisation (markdown marks and backticks dropped, lower case, runs of whitespace collapsed) - editing another sentence
 *     of the same line does not change the key, rewording this one does (then the table needs a look, which is the point).
 *
 * `node scripts/rule-enforcers.mjs` prints the counts; `--update` adds new imperatives as `prose` (without raising the baseline), drops entries of
 * sentences that are gone, and lowers the baseline when the prose count fell; `--update --raise-baseline` also accepts the prose count as the new baseline.
 * validate.mjs passes the same flags through as `--update-enforcers` / `--raise-enforcer-baseline`.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..')
export const SKILLS_DIR = join(ROOT, 'plugins/stage-pipeline/skills')
export const TABLE_PATH = join(HERE, 'rule-enforcers.json')

const TRIGGER = /\b(?:must|never|always|do not|don't|forbidden|mandatory|required|prohibited|(?:is|are) rejected|(?:is|are) not allowed|ban on)\b/i

/** The key text of a sentence: markdown marks and backticks dropped, lower case, single spaces. */
export const normalise = (text) =>
  text
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

export const hashOf = (text) => createHash('sha1').update(normalise(text)).digest('hex').slice(0, 10)

/** Sentences of one line. A table row is one unit. */
function sentences(line) {
  if (/^\s*\|/.test(line)) return [line]
  return line.split(/(?<=[.!?])\s+(?=[A-Z`*(\[])/)
}

/** `[{ line, text, key-hash }]` for the imperatives of a SKILL.md text, in file order. Identical sentences collapse to the first. */
export function extractImperatives(markdown) {
  const out = []
  const seen = new Set()
  let fenced = false
  let comment = false
  let frontmatter = false
  const lines = markdown.split('\n')
  lines.forEach((raw, index) => {
    if (index === 0 && raw.trim() === '---') {
      frontmatter = true
      return
    }
    if (frontmatter) {
      if (raw.trim() === '---') frontmatter = false
      return
    }
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced
      return
    }
    if (fenced) return
    let line = raw
    if (comment) {
      if (!line.includes('-->')) return
      line = line.slice(line.indexOf('-->') + 3)
      comment = false
    }
    line = line.replace(/<!--.*?-->/g, '')
    if (line.includes('<!--')) {
      line = line.slice(0, line.indexOf('<!--'))
      comment = true
    }
    if (!line.trim() || /^\s*#/.test(line)) return
    for (const sentence of sentences(line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').replace(/^>\s*/, ''))) {
      if (!TRIGGER.test(sentence)) continue
      const hash = hashOf(sentence)
      if (seen.has(hash)) continue
      seen.add(hash)
      out.push({ line: index + 1, text: normalise(sentence), hash })
    }
  })
  return out
}

/** `{ skill: [imperatives] }` for every skills/<name>/SKILL.md under `dir`. */
export function extractAll(dir = SKILLS_DIR) {
  const result = {}
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, 'SKILL.md')
    if (existsSync(file)) result[name] = extractImperatives(readFileSync(file, 'utf8'))
  }
  return result
}

export const keyOf = (skill, hash) => `${skill}#${hash}`
export const readTable = (path = TABLE_PATH) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { proseBaseline: 0, rules: {} })
const ENFORCER = /^(?:hook:[a-z-]+\/[a-z0-9-]+|script:\S+|prose)$/

export const counts = (extracted, table) => {
  const total = { total: 0, hook: 0, script: 0, prose: 0, unmapped: 0 }
  for (const [skill, items] of Object.entries(extracted)) {
    for (const item of items) {
      total.total++
      const to = table.rules[keyOf(skill, item.hash)]?.to
      if (!to) total.unmapped++
      else total[to.split(':')[0]]++
    }
  }
  return total
}

/**
 * The errors of the table against the extracted imperatives; `knownRules` (rule IDs of hook-rules.json) and `exists(path)` check the targets.
 * Each error is `{ file, message }` with the skill file and line where there is one.
 */
export function checkEnforcers(extracted, table, { knownRules = null, exists = null, skillsDir = 'plugins/stage-pipeline/skills' } = {}) {
  const errors = []
  const fileOf = (skill, line) => `${skillsDir}/${skill}/SKILL.md${line ? `:${line}` : ''}`
  let prose = 0
  const fresh = []
  const live = new Set()
  for (const [skill, items] of Object.entries(extracted)) {
    for (const item of items) {
      const key = keyOf(skill, item.hash)
      live.add(key)
      const entry = table.rules[key]
      const shown = item.text.length > 90 ? `${item.text.slice(0, 90)}...` : item.text
      if (!entry) {
        errors.push({ file: fileOf(skill, item.line), message: `imperative "${shown}" (${key}) has no enforcer in scripts/rule-enforcers.json - map it to hook:<rule ID> | script:<path> | prose (node scripts/validate.mjs --update-enforcers adds it as prose)` })
        continue
      }
      if (!ENFORCER.test(entry.to ?? '')) errors.push({ file: fileOf(skill, item.line), message: `${key}: enforcer "${entry.to}" is none of hook:<rule ID> | script:<path> | prose` })
      else if (entry.to.startsWith('hook:') && knownRules && !knownRules.has(entry.to.slice(5))) errors.push({ file: fileOf(skill, item.line), message: `${key}: ${entry.to} is not a rule ID of scripts/hook-rules.json` })
      else if (entry.to.startsWith('script:') && exists && !exists(entry.to.slice(7))) errors.push({ file: fileOf(skill, item.line), message: `${key}: ${entry.to} does not exist` })
      if (entry.to === 'prose') {
        prose++
        if (!entry.baseline) fresh.push({ skill, item })
      }
    }
  }
  for (const key of Object.keys(table.rules)) if (!live.has(key)) errors.push({ file: 'scripts/rule-enforcers.json', message: `${key} maps a sentence that is no longer in the skill - drop the entry (node scripts/validate.mjs --update-enforcers)` })
  if (prose > table.proseBaseline) {
    const where = fresh.length ? fresh : []
    errors.push({
      file: where[0] ? fileOf(where[0].skill, where[0].item.line) : 'scripts/rule-enforcers.json',
      message:
        `prose-only imperatives: ${prose}, the recorded baseline is ${table.proseBaseline}. A rule that a hook or a script can hold should be mapped to it; ` +
        'if it cannot, accept it on purpose with node scripts/validate.mjs --update-enforcers --raise-enforcer-baseline. New prose-only: ' +
        (where.length ? where.map(({ skill, item }) => `${fileOf(skill, item.line)} "${item.text.slice(0, 60)}"`).join('; ') : '(none flagged - the baseline number was lowered by hand?)'),
    })
  }
  return errors
}

/** The table after `--update`: new imperatives as prose, dead entries dropped, the baseline lowered (and raised only on request). */
export function updatedTable(extracted, table, { raise = false } = {}) {
  const rules = {}
  let prose = 0
  for (const [skill, items] of Object.entries(extracted)) {
    for (const item of items) {
      const key = keyOf(skill, item.hash)
      const old = table.rules[key]
      const entry = { to: old?.to ?? 'prose', text: item.text.slice(0, 110) }
      if (entry.to === 'prose') {
        prose++
        if (old?.baseline || (raise && !old?.baseline)) entry.baseline = true
      }
      rules[key] = entry
    }
  }
  const baseline = raise ? prose : Math.min(table.proseBaseline ?? prose, prose)
  // A prose entry counted in the baseline keeps its flag; when the baseline fell, the flags still describe the accepted ones.
  return { proseBaseline: baseline, rules }
}

export const writeTable = (table, path = TABLE_PATH) => writeFileSync(path, `${JSON.stringify(table, null, 2)}\n`)

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const extracted = extractAll()
  const table = readTable()
  if (process.argv.includes('--update')) {
    const next = updatedTable(extracted, table, { raise: process.argv.includes('--raise-baseline') })
    writeTable(next)
    console.log(`rule-enforcers.json updated: baseline ${table.proseBaseline} -> ${next.proseBaseline}`)
  }
  const now = readTable()
  console.log(JSON.stringify(counts(extracted, now)), `baseline ${now.proseBaseline}`)
}
