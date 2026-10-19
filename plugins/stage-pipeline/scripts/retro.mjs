#!/usr/bin/env node
/**
 * Pipeline retro from the facts in task files, not from memory.
 *
 *   node retro.mjs <repo | task_dir | STAGES.md> [...]
 *
 * Sources: `metrics:` lines from the journals of STAGES.md / STAGES-ARCHIVE.md (format —
 * /stage-check, Step 4.1), the stage pipeline checklists and the reports in checks/. Tasks from before
 * the `metrics:` line appeared give only checklists and reports — this is visible in the output too.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { readConfig, taskDirFromConfig } from './hooks/pipeline-state.mjs'
import { STAGE_MENTION, stageBlocksOf } from './markers.mjs'

const targets = process.argv.slice(2)
if (!targets.length || targets.includes('--help')) {
  console.log('Usage: node retro.mjs <repo | task_dir | STAGES.md> [...]')
  process.exit(targets.length ? 0 : 2)
}

const taskDirs = new Set()
for (const target of targets.map((t) => resolve(t))) collectTaskDirs(target)

if (!taskDirs.size) {
  console.error('No STAGES.md found')
  process.exit(1)
}

const CHECKERS = ['figma-compare', 'proto-compare', 'devtools-verify', 'pro-review', 'dead-code', 'i18n-sweep', 'deps-audit', 'ds-parity', 'task-converge', 'figma-spec', 'proto-spec']
// Report names from before the single `<checker>-<stage>.md` scheme — the skills wrote them themselves, in live tasks they remain.
const REPORT_ALIASES = [
  [/(^|[/_-])deps-/, 'deps-audit'],
  [/(^|[/_-])i18n-/, 'i18n-sweep'],
  [/(^|[/_-])converge-/, 'task-converge'],
]
const STAGES_BUDGET_KB = 40
const stagesSizes = []
const perChecker = new Map()
const checker = (name) => {
  if (!perChecker.has(name)) perChecker.set(name, { ran: 0, skipped: 0, reports: 0 })
  return perChecker.get(name)
}
const totals = { tasks: 0, stages: 0, withMetrics: 0, findings: 0, dropped: 0, iterations: 0, fresh: 0, escalations: 0 }
const acOutcomes = { done: 0, userReview: 0, live: 0 }
const iterationHistogram = new Map()
// The stage size (the diff= field) against findings and rounds: confirms or refutes the guideline "~300 / >1000 lines".
const SIZE_BUCKETS = [
  { label: '≤300', max: 300 },
  { label: '301–1000', max: 1000 },
  { label: '>1000', max: Infinity },
]
const bySize = SIZE_BUCKETS.map((bucket) => ({ ...bucket, stages: 0, findings: 0, iterations: 0, fresh: 0 }))
let floorViolations = 0
let stagesWithFloor = 0

for (const dir of taskDirs) {
  totals.tasks++
  const text = ['STAGES.md', 'STAGES-ARCHIVE.md']
    .map((name) => join(dir, name))
    .filter(existsSync)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')

  // A stage from STAGES.md and its full record from the archive are one stage: take the fullest block.
  const stageBlocks = new Map()
  for (const { number, block } of stageBlocksOf(text)) {
    if (!stageBlocks.has(number) || block.length > stageBlocks.get(number).length) stageBlocks.set(number, block)
  }
  totals.stages += stageBlocks.size
  const metricsByStage = metricsLines(text, stageBlocks)

  for (const [number, block] of stageBlocks) {
    const line = metricsByStage.get(number)
    if (line) {
      const fields = Object.fromEntries([...line.matchAll(/(\w+)=([^\s`]+)/g)].map((m) => [m[1], m[2]]))
      totals.withMetrics++
      totals.findings += Number(fields.findings) || 0
      totals.dropped += Number(fields.dropped) || 0
      totals.escalations += Number(fields.escalations) || 0
      const iterations = Number(fields.iterations) || 0
      totals.iterations += iterations
      iterationHistogram.set(iterations, (iterationHistogram.get(iterations) ?? 0) + 1)
      if (fields.fresh === 'yes') totals.fresh++
      if (fields.floor !== undefined) {
        stagesWithFloor++
        floorViolations += Number(fields.floor) || 0
      }
      // `diff=+412/-30` (the size counts added lines, deletions do not count) or the old `diff=442`.
      const added = Number(fields.diff?.match(/^\+?(\d+)/)?.[1])
      if (Number.isFinite(added)) {
        const bucket = bySize.find((b) => added <= b.max)
        bucket.stages++
        bucket.findings += Number(fields.findings) || 0
        bucket.iterations += iterations
        if (fields.fresh === 'yes') bucket.fresh++
      }
      for (const name of listField(fields.checkers)) checker(name).ran++
      for (const name of listField(fields.skipped)) checker(name).skipped++
      continue
    }
    // The stage was closed before the metrics: format — only its pipeline checklist remains.
    for (const [, mark, name, rest] of block.matchAll(/^- \[([ xX])\] ([a-z0-9-]+)(.*)$/gm)) {
      if (!isChecker(name)) continue
      if (/\(skip|\[skip/.test(rest)) checker(name).skipped++
      else if (mark !== ' ') checker(name).ran++
    }
  }

  acOutcomes.done += (text.match(/AC-\d+\.\d+ ✅/g) ?? []).length
  acOutcomes.userReview += (text.match(/AC-\d+\.\d+ ⏳/g) ?? []).length
  acOutcomes.live += (text.match(/AC-\d+\.\d+ \[live: user-side\b/g) ?? []).length

  // Report names in live tasks diverged (pro-review-2.md, stage2-pro-review.md, stage-2/pro-review.md),
  // so the checker is searched for anywhere in the file name, not by an exact pattern.
  for (const file of walkMarkdown(join(dir, 'checks'))) {
    const name = CHECKERS.find((candidate) => file.includes(candidate)) ?? REPORT_ALIASES.find(([pattern]) => pattern.test(file))?.[1]
    if (name) checker(name).reports++
  }

  stagesSizes.push({ ticket: basename(dir), kb: Math.round(statSync(join(dir, 'STAGES.md')).size / 1024) })
}

/**
 * `metrics:` lines — wherever they stand. /stage-check writes the line last in a "Journal" entry, not in the stage
 * block, so the stage is taken from the `stage=` field, otherwise from the stage block the line stands in, otherwise from the nearest
 * "stage N" above in the same journal entry.
 */
function metricsLines(text, stageBlocks) {
  const lines = text.split('\n')
  const blocks = stageBlocksOf(text)
  const byStage = new Map()
  lines.forEach((line, index) => {
    if (!/metrics:.*=/.test(line)) return
    let stage = line.match(/\bstage=([\w.]+)/)?.[1]
    stage ??= blocks.find(({ start, end }) => index > start && index < end)?.number
    for (let back = index; !stage && back >= Math.max(0, index - 12); back--) {
      stage = lines[back].match(STAGE_MENTION)?.[1]
      if (back < index && /^[-*] /.test(lines[back])) break
    }
    if (stage && stageBlocks.has(stage)) byStage.set(stage, line)
  })
  return byStage
}

function walkMarkdown(root) {
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    if (statSync(path).isDirectory()) return walkMarkdown(path).map((child) => `${name}/${child}`)
    return name.endsWith('.md') ? [name] : []
  })
}

function listField(value) {
  return value && value !== '-' ? value.split(',').filter(Boolean) : []
}

function isChecker(name) {
  return CHECKERS.includes(name)
}

function collectTaskDirs(path) {
  if (!existsSync(path)) return
  if (statSync(path).isFile()) {
    if (basename(path) === 'STAGES.md') taskDirs.add(dirname(path))
    return
  }
  if (existsSync(join(path, 'STAGES.md'))) {
    taskDirs.add(path)
    return
  }
  if (existsSync(join(path, '.claude/pipeline.config.md'))) return collectTaskDirs(taskDirFromConfig(readConfig(path), path))
  for (const name of readdirSync(path)) {
    if (name === 'node_modules' || name === '.git') continue
    const child = join(path, name)
    if (statSync(child).isDirectory() && existsSync(join(child, 'STAGES.md'))) taskDirs.add(child)
  }
}

const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '—')

console.log(`# Pipeline retro\n`)
console.log(`Tasks: ${totals.tasks}, stages: ${totals.stages}, stages with a metrics: line: ${totals.withMetrics}`)
if (totals.withMetrics < totals.stages) {
  console.log(`(${totals.stages - totals.withMetrics} stages have no metrics — closed before the metrics: format or without /stage-check)`)
}
console.log('')
console.log('## Fix-loop')
console.log(`- findings in total: ${totals.findings}, dropped as false: ${totals.dropped} (${pct(totals.dropped, totals.findings)})`)
console.log(`- fix-loop rounds: ${totals.iterations}, on average per stage: ${totals.withMetrics ? (totals.iterations / totals.withMetrics).toFixed(1) : '—'}`)
console.log(`- stages with a fresh checker run: ${totals.fresh} (${pct(totals.fresh, totals.withMetrics)})`)
console.log(`- escalations: ${totals.escalations}`)
if (iterationHistogram.size) {
  const hist = [...iterationHistogram.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}→${c}`)
  console.log(`- round distribution (rounds→stages): ${hist.join(', ')}`)
}
if (stagesWithFloor) console.log(`- floor-guard: ${floorViolations} violations on the first run across ${stagesWithFloor} stages`)

const sized = bySize.filter((bucket) => bucket.stages)
if (sized.length) {
  console.log('')
  console.log('## Stage size (diff lines) against fix-loop')
  console.log('| Size | Stages | Findings per stage | Rounds per stage | Fresh run |')
  console.log('|---|---|---|---|---|')
  for (const b of sized) {
    console.log(`| ${b.label} | ${b.stages} | ${(b.findings / b.stages).toFixed(1)} | ${(b.iterations / b.stages).toFixed(1)} | ${pct(b.fresh, b.stages)} |`)
  }
}
console.log('')
console.log('## Checkers')
console.log('| Checker | Runs | Skip | Reports in checks/ | Skip share |')
console.log('|---|---|---|---|---|')
for (const [name, c] of [...perChecker.entries()].sort()) {
  console.log(`| ${name} | ${c.ran} | ${c.skipped} | ${c.reports} | ${pct(c.skipped, c.ran + c.skipped)} |`)
}
console.log('')
console.log('## Acceptance criteria')
console.log(`- closed by a checker (✅): ${acOutcomes.done}, went to user-review (⏳): ${acOutcomes.userReview}, live user-side: ${acOutcomes.live}`)

const oversized = stagesSizes.filter((task) => task.kb > STAGES_BUDGET_KB).sort((a, b) => b.kb - a.kb)
console.log('')
console.log(`## STAGES.md larger than ${STAGES_BUDGET_KB} KB (read by every session — archive the done stages, /stage-check Step 4.2)`)
console.log(oversized.length ? oversized.map((task) => `- ${task.ticket}: ${task.kb} KB`).join('\n') : '- none')
