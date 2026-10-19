#!/usr/bin/env node
/**
 * Skill routing by descriptions — deterministic, no model, runs in CI.
 *
 *   node scripts/routing.mjs            # check against evals/routing.json
 *   node scripts/routing.mjs --explain  # plus the top 3 per phrase and a description similarity matrix
 *
 * The model picks a skill by its description, so two classes of routing bugs are visible before
 * any model run: the description lacks the words users ask with (the skill never fires), and two
 * descriptions nearly coincide (the wrong one fires). Here that is approximated lexically: TF-IDF over
 * the descriptions with crude Russian and English stemming. It does not replace semantics — for that
 * there are the live `kind: "routing"` cases in scripts/eval.mjs — but it catches lost vocabulary and merged descriptions.
 * A failed check usually means "fix the description", not "fix the phrase".
 *
 * Russian stop words and endings stay on purpose: descriptions keep a Russian tail of trigger phrases
 * and routing.json keeps Russian phrases (Russian is a full second language of the plugin).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS = join(ROOT, 'plugins/stage-pipeline/skills')
const spec = JSON.parse(readFileSync(join(ROOT, 'evals/routing.json'), 'utf8'))
const explain = process.argv.includes('--explain')

const STOP = new Set(
  (
    'и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему ' +
    'теперь когда даже ну ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где ' +
    'есть надо ней для мы тебя их чем была сам чтобы без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой ' +
    'совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после ' +
    'над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том ' +
    'нельзя такой им более всегда конечно всю между это давай сделай сделать нужно пожалуйста ' +
    'the a an and or of to in on for with by is are be as at it this that from use when user asks not only'
  ).split(' '),
)

const ENDINGS = /(иями|ями|ами|ого|его|ому|ему|ыми|ими|ешь|ать|ять|ить|еть|ает|яет|ует|ах|ях|ов|ев|ей|ой|ый|ий|ая|яя|ое|ее|ые|ие|ую|юю|ть|ет|ем|ют|ут|ит|ат|ят|ом|ам|ям|а|я|о|е|ы|и|у|ю|ь|ing|ed|es|s)$/

function stem(word) {
  let w = word
  const stripped = w.replace(ENDINGS, '')
  if (stripped.length >= 3) w = stripped
  return w.length > 6 ? w.slice(0, 6) : w
}

function tokens(text) {
  return text
    .toLowerCase()
    .replaceAll('ё', 'е')
    .split(/[^a-zа-я0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t))
    .map(stem)
}

// ── index over descriptions ──────────────────────────────────────────────────────
const all = readdirSync(SKILLS)
  .filter((name) => existsSync(join(SKILLS, name, 'SKILL.md')))
  .map((name) => {
    const text = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8')
    const description = text.match(/^description:\s*(.*)$/m)?.[1] ?? ''
    // The skill name is invocation vocabulary too: users write "/stage-check" and "stage check" literally.
    return { name, manual: /^disable-model-invocation:\s*true\s*$/m.test(text), terms: tokens(`${name.replaceAll('-', ' ')} ${description}`) }
  })
// A manual skill (disable-model-invocation) is invoked only by the user with a command: the model never sees its description,
// so it does not take part in routing — neither as a candidate nor as a neighbour in description similarity.
const skills = all.filter((skill) => !skill.manual)
const manual = new Set(all.filter((skill) => skill.manual).map((skill) => skill.name))

const df = new Map()
for (const skill of skills) for (const term of new Set(skill.terms)) df.set(term, (df.get(term) ?? 0) + 1)
const idf = (term) => Math.log((skills.length + 1) / ((df.get(term) ?? 0) + 1)) + 1

function vector(terms) {
  const tf = new Map()
  for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1)
  const v = new Map([...tf].map(([term, count]) => [term, (1 + Math.log(count)) * idf(term)]))
  const norm = Math.sqrt([...v.values()].reduce((sum, x) => sum + x * x, 0)) || 1
  for (const [term, x] of v) v.set(term, x / norm)
  return v
}
const cosine = (a, b) => [...a].reduce((sum, [term, x]) => sum + x * (b.get(term) ?? 0), 0)
for (const skill of skills) skill.vector = vector(skill.terms)

const rank = (prompt) => {
  const q = vector(tokens(prompt))
  return skills.map((skill) => ({ name: skill.name, score: cosine(q, skill.vector) })).sort((a, b) => b.score - a.score)
}

// ── checks ─────────────────────────────────────────────────────────────────
const errors = []
const known = new Set(skills.map((skill) => skill.name))
const topK = spec.topK ?? 2
let rank1 = 0
let positives = 0

for (const c of spec.cases) {
  for (const name of [c.expect, ...(c.not ?? [])].filter(Boolean)) {
    if (manual.has(name)) errors.push(`«${c.prompt}»: ${name} is manual (disable-model-invocation) — the model does not pick it, the phrase checks nothing`)
    else if (!known.has(name)) errors.push(`«${c.prompt}»: no skill ${name}`)
  }
  const ranking = rank(c.prompt)
  const top = ranking.slice(0, topK).map((r) => r.name)
  if (explain) console.log(`${c.expect ?? '—'} ← «${c.prompt}»: ${ranking.slice(0, 3).map((r) => `${r.name} ${r.score.toFixed(2)}`).join(', ')}`)
  if (c.expect) {
    positives++
    if (ranking[0].name === c.expect) rank1++
    else if (!top.includes(c.expect)) {
      const place = ranking.findIndex((r) => r.name === c.expect) + 1
      errors.push(`«${c.prompt}» → expected ${c.expect}, it is #${place}; ahead: ${top.join(', ')} — the description of ${c.expect} lacks this vocabulary`)
    }
  }
  // A phrase for which no skill gained noticeable weight puts anyone first — that is noise, not a route.
  for (const name of c.not ?? []) {
    if (ranking[0].name === name && ranking[0].score >= (spec.noiseFloor ?? 0.12)) errors.push(`«${c.prompt}» → ${name} is first but must not be — the description of ${name} is too broad`)
  }
}

// A skill without a single phrase is not covered by the check: a new skill would pass silently even if nothing finds it.
const covered = new Set(spec.cases.map((c) => c.expect).filter(Boolean))
for (const name of known) if (!covered.has(name)) errors.push(`skill ${name} has no phrase in evals/routing.json`)

const floor = spec.minRank1 ?? 0.8
const rate = positives ? rank1 / positives : 1
if (rate < floor) errors.push(`first place hit ${rank1}/${positives} (${Math.round(rate * 100)}%) against a threshold of ${Math.round(floor * 100)}%`)

// Merged descriptions: a pair that is lexically indistinguishable is told apart by the model only by luck.
const allowed = new Map((spec.allowCollisions ?? []).map((a) => [[...a.pair].sort().join('|'), a.why]))
const maxSimilarity = spec.maxSimilarity ?? 0.5
const pairs = []
for (let i = 0; i < skills.length; i++) {
  for (let j = i + 1; j < skills.length; j++) {
    const similarity = cosine(skills[i].vector, skills[j].vector)
    pairs.push({ pair: [skills[i].name, skills[j].name], similarity })
    const key = [skills[i].name, skills[j].name].sort().join('|')
    if (similarity > maxSimilarity && !allowed.has(key)) {
      errors.push(`descriptions of ${skills[i].name} and ${skills[j].name} are close (${similarity.toFixed(2)} > ${maxSimilarity}) — separate the vocabulary or add the pair to allowCollisions with a reason`)
    }
  }
}
if (explain) {
  console.log('\nClosest description pairs:')
  for (const p of pairs.sort((a, b) => b.similarity - a.similarity).slice(0, 8)) console.log(`  ${p.similarity.toFixed(2)} ${p.pair.join(' ↔ ')}`)
}

if (errors.length) {
  console.error(`✘ Routing (${errors.length}):\n`)
  for (const error of errors) console.error(`  ${error}`)
  process.exit(1)
}
console.log(`✔ Routing: ${rank1}/${positives} phrases find their skill first, the rest in the top ${topK}; no merged descriptions`)
