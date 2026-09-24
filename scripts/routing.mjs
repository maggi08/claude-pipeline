#!/usr/bin/env node
/**
 * Маршрутизация скиллов по описаниям — детерминированно, без модели, гоняется в CI.
 *
 *   node scripts/routing.mjs            # проверка по evals/routing.json
 *   node scripts/routing.mjs --explain  # плюс топ-3 по каждой фразе и матрица близости описаний
 *
 * Модель выбирает скилл по description, поэтому два класса багов маршрутизации видны ещё до
 * прогона модели: в описании нет слов, которыми пользователь просит (скилл не вызовется), и два
 * описания почти совпадают (вызовется не тот). Здесь это приближено лексически: TF-IDF по
 * описаниям с грубым стеммингом русского и английского. Семантику это не заменяет — для неё
 * живые кейсы `kind: "routing"` в scripts/eval.mjs, — но ловит пропавшую лексику и слипшиеся описания.
 * Упавшая проверка обычно значит «поправь description», а не «поправь фразу».
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

// ── индекс по описаниям ──────────────────────────────────────────────────────
const skills = readdirSync(SKILLS)
  .filter((name) => existsSync(join(SKILLS, name, 'SKILL.md')))
  .map((name) => {
    const text = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8')
    const description = text.match(/^description:\s*(.*)$/m)?.[1] ?? ''
    // Имя скилла — тоже лексика вызова: «/stage-check» и «stage check» пользователь пишет буквально.
    return { name, terms: tokens(`${name.replaceAll('-', ' ')} ${description}`) }
  })

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

// ── проверки ─────────────────────────────────────────────────────────────────
const errors = []
const known = new Set(skills.map((skill) => skill.name))
const topK = spec.topK ?? 2
let rank1 = 0
let positives = 0

for (const c of spec.cases) {
  for (const name of [c.expect, ...(c.not ?? [])].filter(Boolean)) {
    if (!known.has(name)) errors.push(`«${c.prompt}»: нет скилла ${name}`)
  }
  const ranking = rank(c.prompt)
  const top = ranking.slice(0, topK).map((r) => r.name)
  if (explain) console.log(`${c.expect ?? '—'} ← «${c.prompt}»: ${ranking.slice(0, 3).map((r) => `${r.name} ${r.score.toFixed(2)}`).join(', ')}`)
  if (c.expect) {
    positives++
    if (ranking[0].name === c.expect) rank1++
    else if (!top.includes(c.expect)) {
      const place = ranking.findIndex((r) => r.name === c.expect) + 1
      errors.push(`«${c.prompt}» → ждали ${c.expect}, он ${place}-й; впереди ${top.join(', ')} — в описании ${c.expect} нет этой лексики`)
    }
  }
  // Фраза, для которой ни один скилл не набрал заметного веса, первым ставит кого угодно — это шум, а не маршрут.
  for (const name of c.not ?? []) {
    if (ranking[0].name === name && ranking[0].score >= (spec.noiseFloor ?? 0.12)) errors.push(`«${c.prompt}» → первым ${name}, а не должен — описание ${name} слишком широкое`)
  }
}

const floor = spec.minRank1 ?? 0.8
const rate = positives ? rank1 / positives : 1
if (rate < floor) errors.push(`первым местом попало ${rank1}/${positives} (${Math.round(rate * 100)}%) при пороге ${Math.round(floor * 100)}%`)

// Слипшиеся описания: пара, неразличимая лексически, различается для модели только удачей.
const allowed = new Map((spec.allowCollisions ?? []).map((a) => [[...a.pair].sort().join('|'), a.why]))
const maxSimilarity = spec.maxSimilarity ?? 0.5
const pairs = []
for (let i = 0; i < skills.length; i++) {
  for (let j = i + 1; j < skills.length; j++) {
    const similarity = cosine(skills[i].vector, skills[j].vector)
    pairs.push({ pair: [skills[i].name, skills[j].name], similarity })
    const key = [skills[i].name, skills[j].name].sort().join('|')
    if (similarity > maxSimilarity && !allowed.has(key)) {
      errors.push(`описания ${skills[i].name} и ${skills[j].name} близки (${similarity.toFixed(2)} > ${maxSimilarity}) — разведи лексику или впиши пару в allowCollisions с причиной`)
    }
  }
}
if (explain) {
  console.log('\nСамые близкие пары описаний:')
  for (const p of pairs.sort((a, b) => b.similarity - a.similarity).slice(0, 8)) console.log(`  ${p.similarity.toFixed(2)} ${p.pair.join(' ↔ ')}`)
}

if (errors.length) {
  console.error(`✘ Маршрутизация (${errors.length}):\n`)
  for (const error of errors) console.error(`  ${error}`)
  process.exit(1)
}
console.log(`✔ Маршрутизация: ${rank1}/${positives} фраз находят свой скилл первым, остальные — в топ-${topK}; слипшихся описаний нет`)
