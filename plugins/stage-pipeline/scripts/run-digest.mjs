#!/usr/bin/env node
/**
 * The run summary for the final message — from the journal and reports, not from the orchestrator's memory.
 *
 * In one task the final message named "kk/en texts, tab title, labels and small deviations",
 * and under that label lay two defects that the user found while using the product; three decisions
 * from "Decided myself" they reverted the next morning. In another "[live: user-side]" stands 46 times, and six
 * defects were found by the user exactly there. The summary shows everything not closed by a check —
 * the order of going through it is the user's choice.
 *
 *   node run-digest.mjs <task_dir>/<TICKET>
 *
 * The scope is what was written after the task snapshot (session-start takes it when the plugin first sees the task):
 * new checker reports and new journal lines. It is called from /stage-force ("Output") and by the journal-gate hook
 * when a "Force run" block closes.
 *
 * The digest is a text for the user and belongs to the task's files, so its headings and lines are in the
 * task language (taskLanguage; unknown → ru, as before). Console messages are always English.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  baselineInfo,
  disposition,
  findingCounts,
  fingerprint,
  journalText,
  lastForceBlock,
  ledgerEntries,
  ledgerViolations,
  newReports,
  openBlockers,
} from './journal-check.mjs'
import { describe, gateStatus } from './ci-gates.mjs'
import { AWAITING_SECTION, UNVERIFIED_HEADING } from './markers.mjs'
import { pluginDataDir, readPipelineState, taskLanguage } from './hooks/pipeline-state.mjs'

const ACCEPTED = new Set(['fixed', 'false', 'blocker', 'user'])

// Digest headings and lines by task language. In a ru task they stay as they were, byte for byte.
const TEXT = {
  ru: {
    blockers: (n) => `### Блокеры — нужен твой ответ (${n})`,
    none: '- нет',
    gates: (green, all) => `### Гейты CI на HEAD (${green} из ${all} зелёные)`,
    noOutcome: (n) => `### Находки без итога (${n}) — исправить или вынести блокером`,
    notVerified: (n) => `### Не проверено (${n})`,
    minor: (n) => `### Minor без итога (${n})`,
    accepted: (n) => `### Принято само — проверь, дорогие откаты первыми (${n})`,
  },
  en: {
    blockers: (n) => `### Blockers — your answer needed (${n})`,
    none: '- none',
    gates: (green, all) => `### CI gates on HEAD (${green} of ${all} green)`,
    noOutcome: (n) => `### Findings without outcome (${n}) — fix or raise as a blocker`,
    notVerified: (n) => `### Not verified (${n})`,
    minor: (n) => `### Minor without outcome (${n})`,
    accepted: (n) => `### Accepted on my own — check, expensive rollbacks first (${n})`,
  },
}
const bullet = (line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim()

/** `repo` is `{ worktree, config }` of the run's repo: the digest shows the state of the CI gates on the current HEAD from it. */
export function runDigest(taskDir, dataDir = pluginDataDir(), repo = null) {
  const { lines, ledgerSince } = baselineInfo(dataDir, taskDir)
  const stages = existsSync(join(taskDir, 'STAGES.md')) ? readFileSync(join(taskDir, 'STAGES.md'), 'utf8') : ''
  const fresh = (line) => line.trim() && !lines.has(fingerprint(line))
  const reports = newReports(taskDir, ledgerSince).map((name) => ({ name, text: readFileSync(join(taskDir, 'checks', name), 'utf8') }))
  const out = []
  const language = taskLanguage(stages) ?? 'ru'
  const text = TEXT[language]

  const block = lastForceBlock(stages)
  const blockers = block ? openBlockers(block.body) : []
  out.push(text.blockers(blockers.length), ...(blockers.length ? blockers.map((line) => `- ${bullet(line)}`) : [text.none]))

  const gates = repo ? gateStatus(dataDir, repo.worktree, repo.config) : []
  if (gates.length) {
    const red = gates.filter(({ status }) => status !== 'green')
    out.push('', text.gates(gates.length - red.length, gates.length), ...gates.map((gate) => `- ${gate.status === 'green' ? '✅' : '✗'} ${describe(gate, language)}`))
  }

  const open = reports.flatMap(({ name, text }) => ledgerViolations(text, name, { complete: true }).map((violation) => `- ${violation.message}`))
  if (open.length) out.push('', text.noOutcome(open.length), ...open)

  const unverified = []
  for (const { name, text } of reports) {
    const start = text.search(UNVERIFIED_HEADING)
    if (start === -1) continue
    const body = text.slice(start).split('\n').slice(1)
    const end = body.findIndex((line) => /^#{1,3}\s/.test(line))
    for (const line of end === -1 ? body : body.slice(0, end)) {
      if (/^\s*(?:[-*]|\d+\.)\s+\S/.test(line) && !/^(?:нет|ничего|всё .*проверено|none|nothing|no\s+items|(?:all|everything)\s+(?:items\s+)?(?:is\s+|are\s+)?(?:verified|checked))\.?$/i.test(bullet(line))) unverified.push(`- ${name}: ${bullet(line)}`)
    }
  }
  const journal = journalText(taskDir)
    .split('\n')
    .filter((line) => fresh(line) && /AC-\d/.test(line) && /⏳|\[live:|\[blocked/i.test(line))
    .map((line) => `- ${bullet(line).slice(0, 220)}`)
    // A closed stage lies both in the archive and as a folded line in STAGES.md — it is one criterion.
    .filter((line, index, all) => all.indexOf(line) === index)
  out.push('', text.notVerified(unverified.length + journal.length), ...(unverified.length + journal.length ? [...journal, ...unverified] : [text.none]))

  const minors = reports
    .map(({ name, text }) => {
      const counts = findingCounts(text, name)
      const accepted = (ledgerEntries(text) ?? []).filter((entry) => ACCEPTED.has(disposition(entry))).length
      return { name, left: Math.max(0, counts.minor - Math.max(0, accepted - counts.critical - counts.major)) }
    })
    .filter(({ left }) => left)
  if (minors.length) {
    out.push('', text.minor(minors.reduce((sum, { left }) => sum + left, 0)), `- ${minors.map(({ name, left }) => `${name}: ${left}`).join(' · ')}`)
  }

  const pending = section(stages, AWAITING_SECTION).filter(fresh).filter((line) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line))
  out.push('', text.accepted(pending.length), ...(pending.length ? pending.map((line) => `- ${bullet(line).slice(0, 220)}`) : [text.none]))
  return out.join('\n')
}

function section(text, heading) {
  const start = text.search(heading)
  if (start === -1) return []
  const body = text.slice(start).split('\n').slice(1)
  const end = body.findIndex((line) => /^## /.test(line))
  return end === -1 ? body : body.slice(0, end)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv[2]
  if (!target || !existsSync(target)) {
    console.error('Usage: node run-digest.mjs <task_dir>/<TICKET>')
    process.exit(2)
  }
  console.log(runDigest(resolve(target), pluginDataDir(), readPipelineState(process.cwd())))
}
