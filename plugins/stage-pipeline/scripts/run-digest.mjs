#!/usr/bin/env node
/**
 * The run summary for the final message — from the journal and reports, not from the orchestrator's memory.
 *
 * In one task the final message named "kk/en texts, tab title, labels and small deviations",
 * and under that label lay two defects that the user found while using the product; three decisions
 * from "Decided myself" they reverted the next morning. In another "[live: user-side]" stands 46 times, and six
 * defects were found by the user exactly there. The summary accounts for everything not closed by a check —
 * the order of going through it is the user's choice. On a long task the full list ran to 150 lines, so there are two views of
 * the same data, and the script, not the model, decides what goes where:
 *
 *   full  — everything, line by line; it lies in `<task_dir>/<TICKET>/RUN-DIGEST.md` (outside `checks/`: it is not a checker report);
 *   short — for the chat: blockers, red gates and findings without an outcome in full, every other category as a number
 *           (the unverified one by stage, "accepted on my own" with the first three), and the path to the file.
 *
 *   node run-digest.mjs <task_dir>/<TICKET>              # writes RUN-DIGEST.md, prints the short view
 *   node run-digest.mjs <task_dir>/<TICKET> --full       # writes the file, prints it
 *   node run-digest.mjs <task_dir>/<TICKET> --no-write   # prints the short view, writes nothing
 *
 * The scope is the freshest run only (lastForceBlock — the latest date in the heading): checker reports written from the run date
 * and after the task snapshot, journal lines not in the snapshot, not dated earlier than the run and not inside an earlier run's block. It is called from /stage-force ("Output")
 * and by the journal-gate hook when a "Force run" block closes.
 *
 * The digest is a text for the user and belongs to the task's files, so its headings and lines are in the
 * task language (taskLanguage; unknown → ru, as before). Console messages are always English.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  baselineInfo,
  disposition,
  findingCounts,
  fingerprint,
  journalText,
  lastForceBlock,
  ledgerEntries,
  LEDGER_DOC,
  ledgerViolations,
  newReports,
  openBlockers,
  SUMMARY_LINE,
} from './journal-check.mjs'
import { hasReceipts, stagesWithoutRuntime, uiFiles } from './receipts.mjs'
import { describe, forceSkips, gateAccepted, gateStatus } from './ci-gates.mjs'
import { AWAITING_SECTION, CONFIRMED_LINE, UNVERIFIED_HEADING, forceBlockBody, forceHeadings, headingDate } from './markers.mjs'
import { pluginDataDir, readPipelineState, taskLanguage } from './hooks/pipeline-state.mjs'

const ACCEPTED = new Set(['fixed', 'false', 'blocker', 'user'])

// Digest headings and lines by task language. In a ru task they stay as they were, byte for byte.
const TEXT = {
  ru: {
    blockers: (n) => `### Блокеры — нужен твой ответ (${n})`,
    none: '- нет',
    gates: (green, all, skipped = 0) => `### Гейты CI на HEAD (${green} из ${all} зелёные${skipped ? `, пропущено ${skipped}` : ''})`,
    noOutcome: (n) => `### Находки без итога (${n}) — исправить или вынести блокером`,
    notVerified: (n) => `### Не проверено (${n})`,
    minor: (n) => `### Minor без итога (${n})`,
    accepted: (n) => `### Принято само — проверь, дорогие откаты первыми (${n})`,
    noRuntime: (n) => `### Этапы без проверки в рантайме (${n})`,
    noRuntimeLine: ({ stage, sha, ui, skip }) => `- ${stage ?? sha}: изменены UI-файлы (${ui}), отчёта devtools-verify нет${skip ? ` — пропуск: ${skip}` : ''}`,
    // The short view and the file. The category names are the same words as in the headings above.
    labels: { noOutcome: 'находок без итога', notVerified: 'непроверенного', minor: 'minor', accepted: 'принятого само', noRuntime: 'этапов без проверки в рантайме' },
    noneOf: (names) => `Нет: ${names.join(', ')}.`,
    notReady: (names) => `Не готово к PR — critical/major или FAIL без итога в отчётах: ${names.join(', ')}.`,
    verifiedJournal: (n, byStage) => `- критерии журнала (${n}): ${byStage}`,
    verifiedReports: (n) => `- чекеры не смогли проверить (${n})`,
    stage: (n) => `этап ${n}`,
    otherStage: 'без этапа',
    title: (ticket) => `# Дайджест прогона — ${ticket}`,
    run: (heading) => `Прогон: ${heading}`,
    sameDay: (n, date) => `В охват попал и ранний прогон того же дня (${date}): ещё блоков — ${n}. Отчёты и строки журнала с даты прогона относятся к обоим.`,
    checkers: (n) => `### Чекеры — вердикты по отчётам (${n})`,
    file: (path) => `Полный дайджест: ${path} — «подробнее» раскрою оттуда нужный раздел.`,
    notWritten: (reason) => `Полный дайджест не записан: ${{ dirLink: 'каталог задачи — симлинк', fileLink: 'RUN-DIGEST.md — симлинк', notDir: 'путь задачи не каталог', missing: 'каталога задачи нет', outside: 'каталог задачи вне каталога задач из конфига', readonly: 'в каталог задачи нельзя писать' }[reason]}.`,
    // The lines of the "Findings without outcome" section, from the violation's data (journal-check, ledgerViolations); as before the English hook messages.
    ledger: ({ rule, id: name, shown, what, accepted }) =>
      ({
        'ledger-parked': `checks/${name}: «${shown}» — это решение не исправлять, его принимает пользователь. Итог — исправлено, ложная (с доказательством) или блокер B<n> (${LEDGER_DOC}).`,
        'ledger-unproven': `checks/${name}: «${shown}» — «давнее» без доказательства на базе. Проверь на sha базы или на проде и впиши замер, иначе это находка задачи.`,
        'ledger-unknown': `checks/${name}: итог «${shown}» не распознан — допустимы «исправлено: …», «ложная: …», «B<n>», «решение пользователя <дата>» (${LEDGER_DOC}).`,
        'ledger-missing':
          `checks/${name}: ${what}, а итогов в «## Итог находок» — ${accepted}. Каждая находка закрывается строкой: исправлено / ложная / B<n> ` +
          `(${LEDGER_DOC}). Находку, которую fix-loop не исправил, не откладывают — это блокер.`,
      })[rule],
  },
  en: {
    blockers: (n) => `### Blockers — your answer needed (${n})`,
    none: '- none',
    gates: (green, all, skipped = 0) => `### CI gates on HEAD (${green} of ${all} green${skipped ? `, ${skipped} skipped` : ''})`,
    noOutcome: (n) => `### Findings without outcome (${n}) — fix or raise as a blocker`,
    notVerified: (n) => `### Not verified (${n})`,
    minor: (n) => `### Minor without outcome (${n})`,
    accepted: (n) => `### Accepted on my own — check, expensive rollbacks first (${n})`,
    noRuntime: (n) => `### Stages without runtime check (${n})`,
    noRuntimeLine: ({ stage, sha, ui, skip }) => `- ${stage ?? sha}: UI files changed (${ui}), no devtools-verify report${skip ? ` — skipped: ${skip}` : ''}`,
    labels: { noOutcome: 'findings without an outcome', notVerified: 'unverified items', minor: 'minor', accepted: 'items accepted on my own', noRuntime: 'stages without runtime check' },
    noneOf: (names) => `None: ${names.join(', ')}.`,
    notReady: (names) => `Not ready for PR — critical/major or FAIL without an outcome in: ${names.join(', ')}.`,
    verifiedJournal: (n, byStage) => `- journal criteria (${n}): ${byStage}`,
    verifiedReports: (n) => `- checkers could not verify (${n})`,
    stage: (n) => `stage ${n}`,
    otherStage: 'no stage',
    title: (ticket) => `# Run digest — ${ticket}`,
    run: (heading) => `Run: ${heading}`,
    sameDay: (n, date) => `An earlier run of the same day (${date}) is inside the scope: ${n} more block(s). Reports and journal lines from the run date belong to both.`,
    checkers: (n) => `### Checkers — verdicts by report (${n})`,
    file: (path) => `Full digest: ${path} — ask "more" and I will open the section you need from it.`,
    notWritten: (reason) => `Full digest not written: ${{ dirLink: 'the task directory is a symlink', fileLink: 'RUN-DIGEST.md is a symlink', notDir: 'the task path is not a directory', missing: 'the task directory does not exist', outside: 'the task directory is outside the task directory of the config', readonly: 'the task directory is not writable' }[reason]}.`,
    ledger: ({ message }) => message,
  },
}
/** "None", "nothing left", "all widths verified (by code)": the section lists nothing. The "all … verified" form is checked without backtracking: the tail is cut off by hand. */
function nothingLeft(text) {
  const plain = text.trim().replace(/\.$/, '')
  if (/^(?:нет|ничего|всё .*проверено|none|nothing(?:\s+left(?!.*\b(?:not|except|but)\b).*)?|no\s+items)$/i.test(plain)) return true
  if (!/^(?:all|everything)\b/i.test(plain) || /\b(?:not|except|but|unverified)\b|n['’]t\b/i.test(plain)) return false
  const open = plain.lastIndexOf('(')
  const head = plain.endsWith(')') && open !== -1 && !plain.slice(open, -1).includes(')') ? plain.slice(0, open).trimEnd() : plain
  return /\b(?:verified|checked)$/i.test(head)
}
const bullet = (line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim()

const lineDate = (line) => {
  const dates = [...line.matchAll(/\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4}/g)].map(([found]) => headingDate(found))
  return dates.length ? dates.reduce((max, date) => (date > max ? date : max)) : null
}

/**
 * What the digest covers: the date of the run (from its heading, else from its `Confirmed:` line, the Russian form too), the moment
 * reports are taken from (the later of the run date and the task snapshot), and how many other blocks sit on the same date.
 */
export function runScope(stages, block, ledgerSince) {
  const date = block ? (headingDate(block.heading) ?? headingDate(block.body.split('\n').find((line) => CONFIRMED_LINE.test(line)) ?? '')) : null
  const start = date ? new Date(`${date}T00:00:00`).getTime() : 0
  const sameDay = date ? forceHeadings(stages).filter(([heading]) => heading !== block.heading && headingDate(heading) === date).length : 0
  return { date, since: Math.max(ledgerSince, start), sameDay }
}

/** The numbers and lines of the digest — one structure for both views, so that no category exists in one and not in the other. */
export function collectDigest(taskDir, dataDir = pluginDataDir(), repo = null) {
  const { lines, ledgerSince } = baselineInfo(dataDir, taskDir)
  const stages = existsSync(join(taskDir, 'STAGES.md')) ? readFileSync(join(taskDir, 'STAGES.md'), 'utf8') : ''
  const language = taskLanguage(stages) ?? 'ru'
  const block = lastForceBlock(stages)
  const scope = runScope(stages, block, ledgerSince)
  // The lines of the other Force blocks are theirs: an earlier run's "Unfinished: AC-… ⏳" is not this run's.
  const others = new Set(
    forceHeadings(stages)
      .filter(([heading]) => heading !== block?.heading)
      .flatMap((heading) => forceBlockBody(stages, heading).split('\n').map((line) => line.trim()))
      .filter(Boolean),
  )
  // A line dated before the run belongs to an earlier run; an undated one is judged by the snapshot alone.
  const fresh = (line, { byDate = true } = {}) => {
    if (!line.trim() || lines.has(fingerprint(line)) || others.has(line.trim())) return false
    const dated = lineDate(line)
    return !(byDate && scope.date && dated && dated < scope.date)
  }
  const reports = newReports(taskDir, scope.since).map((name) => ({ name, text: readFileSync(join(taskDir, 'checks', name), 'utf8') }))

  const blockers = (block ? openBlockers(block.body) : []).map((line) => `- ${bullet(line)}`)
  const gates = (repo ? gateStatus(dataDir, repo.worktree, repo.config, forceSkips(taskDir)) : []).map((gate) => ({ ok: gateAccepted(gate), skipped: gate.status === 'skipped', lastRed: Boolean(gate.lastRed), line: `- ${gate.status === 'green' ? '✅' : gate.status === 'skipped' ? '⏭' : '✗'} ${describe(gate, language)}` }))
  const noOutcome = reports.flatMap(({ name, text }) => ledgerViolations(text, name, { complete: true }).map((violation) => `- ${TEXT[language].ledger(violation)}`))

  const unverifiedReports = []
  for (const { name, text } of reports) {
    const start = text.search(UNVERIFIED_HEADING)
    if (start === -1) continue
    const body = text.slice(start).split('\n').slice(1)
    const end = body.findIndex((line) => /^#{1,3}\s/.test(line))
    for (const line of end === -1 ? body : body.slice(0, end)) {
      if (/^\s*(?:[-*]|\d+\.)\s+\S/.test(line) && !nothingLeft(bullet(line))) unverifiedReports.push(`- ${name}: ${bullet(line)}`)
    }
  }
  const unverifiedJournal = journalText(taskDir)
    .split('\n')
    .filter((line) => fresh(line) && /AC-\d/.test(line) && /⏳|\[live:|\[blocked/i.test(line))
    .map((line) => ({ line: `- ${bullet(line).slice(0, 220)}`, stage: line.match(/AC-(\d+)/)?.[1] ?? null }))
    // A closed stage lies both in the archive and as a folded line in STAGES.md — it is one criterion.
    .filter((entry, index, all) => all.findIndex((other) => other.line === entry.line) === index)

  const minors = reports
    .map(({ name, text }) => {
      const counts = findingCounts(text, name)
      const accepted = (ledgerEntries(text) ?? []).filter((entry) => ACCEPTED.has(disposition(entry))).length
      return { name, left: Math.max(0, counts.minor - Math.max(0, accepted - counts.critical - counts.major)) }
    })
    .filter(({ left }) => left)

  // "Awaiting confirmation" is a live list: an item leaves it only when the user confirms it, so a date earlier than the run does not cut it.
  const accepted = section(stages, AWAITING_SECTION)
    .filter((line) => fresh(line, { byDate: false }))
    .filter((line) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line))
    .map((line) => `- ${bullet(line).slice(0, 220)}`)

  const checkers = reports.map(({ name, text }) => {
    const summary = text.split('\n').find((line) => SUMMARY_LINE.test(line) && /\d/.test(line))
    return summary ? `- ${name}: ${bullet(summary).slice(0, 200)}` : `- ${name}`
  })
  // A report is not ready for PR while a critical or major finding has no allowed outcome in its "Findings outcome" (fixed / false with proof / blocker / user decision).
  // The verdict in the head of the report is the first round's: a finding closed by an outcome line no longer counts.
  const notReady = reports
    .filter(({ name, text }) => ledgerViolations(text, name, { complete: true }).some((violation) => violation.rule === 'ledger-missing'))
    .map(({ name }) => name)
  // Stage receipts (VT-1 stage 3): force commits of this run that changed UI and have no devtools-verify report. `receipted` — the run has receipts at all (the old runs have none, and their digest stays as it was).
  const receipted = hasReceipts(dataDir, taskDir, scope.since)
  const noRuntime = stagesWithoutRuntime(dataDir, taskDir, scope.since).map((receipt) => {
    const skip = (receipt.skips ?? []).find((item) => item.checker === 'devtools-verify')
    const ui = uiFiles(receipt.files ?? [])
    return `${TEXT[language].noRuntimeLine({ stage: receipt.stage, sha: String(receipt.sha).slice(0, 7), ui: `${ui.slice(0, 3).join(', ')}${ui.length > 3 ? ` +${ui.length - 3}` : ''}`, skip: skip?.reason })}`
  })
  return { language, text: TEXT[language], receipted, noRuntime, notReady, heading: block?.heading.replace(/^## /, '') ?? null, scope, blockers, gates, noOutcome, unverifiedReports, unverifiedJournal, minors, accepted, checkers }
}

/** The full view: every line of every category (as the digest was before it had two views, plus the early-run note). */
function renderFull(d) {
  const { text } = d
  const out = [text.blockers(d.blockers.length), ...(d.blockers.length ? d.blockers : [text.none])]
  if (d.gates.length) {
    const skipped = d.gates.filter((gate) => gate.skipped).length
    out.push('', text.gates(d.gates.filter(({ ok }) => ok).length - skipped, d.gates.length, skipped), ...d.gates.map(({ line }) => line))
  }
  if (d.noOutcome.length) out.push('', text.noOutcome(d.noOutcome.length), ...d.noOutcome)
  const unverified = d.unverifiedJournal.length + d.unverifiedReports.length
  out.push('', text.notVerified(unverified), ...(unverified ? [...d.unverifiedJournal.map(({ line }) => line), ...d.unverifiedReports] : [text.none]))
  if (d.minors.length) {
    out.push('', text.minor(d.minors.reduce((sum, { left }) => sum + left, 0)), `- ${d.minors.map(({ name, left }) => `${name}: ${left}`).join(' · ')}`)
  }
  out.push('', text.accepted(d.accepted.length), ...(d.accepted.length ? d.accepted : [text.none]))
  if (d.noRuntime.length) out.push('', text.noRuntime(d.noRuntime.length), ...d.noRuntime)
  if (d.scope.sameDay) out.push('', text.sameDay(d.scope.sameDay, d.scope.date))
  return out.join('\n')
}

/**
 * The short view for the chat. What goes in is decided here by fixed rules: blockers, red gates and findings without an outcome — line by line;
 * one line with the names of the reports with a critical/major finding or a FAIL without an outcome (none — no line); the unverified — a number by stage plus the number of the checkers' "could not verify"; minor — a number; accepted on my own — a number and the first three.
 * A category with nothing in it is folded into one "None: …" line, a category with something in it is never dropped.
 */
function renderShort(d, path, unwritten = null) {
  const { text } = d
  const out = [text.blockers(d.blockers.length), ...(d.blockers.length ? d.blockers : [text.none])]
  if (d.notReady.length) out.push(text.notReady(d.notReady))
  if (d.gates.length) {
    const red = d.gates.filter(({ ok }) => !ok)
    const skipped = d.gates.filter((gate) => gate.skipped).length
    // A skipped gate whose last recorded run is red is listed too: the skip does not hide it.
    out.push(text.gates(d.gates.length - red.length - skipped, d.gates.length, skipped), ...d.gates.filter((gate) => !gate.ok || gate.lastRed).map(({ line }) => line))
  }
  const empty = []
  if (d.noOutcome.length) out.push(text.noOutcome(d.noOutcome.length), ...d.noOutcome)
  else empty.push(text.labels.noOutcome)
  const unverified = d.unverifiedJournal.length + d.unverifiedReports.length
  if (unverified) {
    out.push(text.notVerified(unverified))
    if (d.unverifiedJournal.length) {
      const counts = new Map()
      for (const { stage } of d.unverifiedJournal) counts.set(stage, (counts.get(stage) ?? 0) + 1)
      const order = [...counts.keys()].sort((a, b) => (a === null) - (b === null) || Number(a) - Number(b))
      out.push(text.verifiedJournal(d.unverifiedJournal.length, order.map((stage) => `${stage === null ? text.otherStage : text.stage(stage)} — ${counts.get(stage)}`).join(' · ')))
    }
    if (d.unverifiedReports.length) out.push(text.verifiedReports(d.unverifiedReports.length))
  } else empty.push(text.labels.notVerified)
  if (d.minors.length) out.push(text.minor(d.minors.reduce((sum, { left }) => sum + left, 0)))
  else empty.push(text.labels.minor)
  if (d.accepted.length) out.push(text.accepted(d.accepted.length), ...d.accepted.slice(0, 3))
  else empty.push(text.labels.accepted)
  if (d.noRuntime.length) out.push(text.noRuntime(d.noRuntime.length))
  else if (d.receipted) empty.push(text.labels.noRuntime)
  if (empty.length) out.push(text.noneOf(empty))
  if (d.scope.sameDay) out.push(text.sameDay(d.scope.sameDay, d.scope.date))
  if (path) out.push(text.file(path))
  else if (unwritten) out.push(text.notWritten(unwritten))
  return out.join('\n')
}

const realTaskDir = (taskDir) => {
  try {
    return realpathSync(taskDir)
  } catch {
    return resolve(taskDir)
  }
}

/** The state of the repo of THIS task, for its CI gates: the caller's state if it owns the task, else the repo the task directory lies in; no repo — no gates (never the gates of whichever repo the script was started from). */
export function taskRepo(taskDir, state) {
  const dir = realTaskDir(taskDir)
  if (state?.tasks?.some((task) => !task.foreign && realTaskDir(task.dir) === dir)) return state
  return readPipelineState(dirname(dirname(dirname(dir))))
}

/** The digest of the freshest run. `view`: `full` (every line, no file header) or `short` (for the chat). `repo` is `{ worktree, config }` of the task's repo: the CI gates on its HEAD. */
export function runDigest(taskDir, dataDir = pluginDataDir(), repo = null, view = 'full', path = null) {
  const digest = collectDigest(realTaskDir(taskDir), dataDir, repo)
  return view === 'short' ? renderShort(digest, path) : renderFull(digest)
}

/** `<task_dir>/<TICKET>/RUN-DIGEST.md`: the run date in the header, the full view, then the checkers' verdicts. Outside `checks/`, so it is not a checker report. */
export function digestFilePath(taskDir) {
  return join(realTaskDir(taskDir), 'RUN-DIGEST.md')
}

/** Writes the file (overwriting the previous run's) and returns `{ short, full, path }`; `path` is null when the file could not be written. */
export function publishDigest(taskDir, dataDir = pluginDataDir(), repo = null, { write = true } = {}) {
  const dir = realTaskDir(taskDir)
  const digest = collectDigest(dir, dataDir, repo)
  const { text } = digest
  const full = [
    text.title(basename(dir)),
    ...(digest.heading ? [text.run(digest.heading)] : []),
    '',
    renderFull(digest),
    ...(digest.checkers.length ? ['', text.checkers(digest.checkers.length), ...digest.checkers] : []),
    '',
  ].join('\n')
  let path = null
  let unwritten = null
  if (write) {
    unwritten = unsafeDigestTarget(taskDir, dir, repo)
    if (!unwritten) {
      // A temp file next to the target and a rename: rename replaces the name, never the file a link points to.
      const target = digestFilePath(dir)
      const temp = `${target}.${process.pid}.tmp`
      try {
        writeFileSync(temp, full, { flag: 'wx' })
        renameSync(temp, target)
        path = target
      } catch {
        // the task directory is read-only — the short view just has no path
        try {
          unlinkSync(temp)
        } catch {
          // no temp file was made
        }
        unwritten = 'readonly'
      }
    }
  }
  return { short: renderShort(digest, path, unwritten), full, path }
}

/** Why `RUN-DIGEST.md` must not be written (null — it may): the task directory or the file is a symlink, or the task directory is outside the task directory of the config. */
function unsafeDigestTarget(taskDir, realDir, repo) {
  const isLink = (path) => {
    try {
      return lstatSync(path).isSymbolicLink()
    } catch {
      return false
    }
  }
  if (isLink(resolve(taskDir))) return 'dirLink'
  if (isLink(digestFilePath(realDir))) return 'fileLink'
  try {
    if (!lstatSync(realDir).isDirectory()) return 'notDir'
  } catch {
    return 'missing'
  }
  // The task directory of the config (`task_path`, `pipeline.config.local.md` over the shared one): it may lie outside the repo, or be reached through a symlink.
  if (repo?.taskDir) {
    let root
    try {
      root = realpathSync(repo.taskDir)
    } catch {
      return null
    }
    const rel = relative(root, realDir)
    if (rel.startsWith('..') || isAbsolute(rel)) return 'outside'
  }
  return null
}

function section(text, heading) {
  const start = text.search(heading)
  if (start === -1) return []
  const body = text.slice(start).split('\n').slice(1)
  const end = body.findIndex((line) => /^## /.test(line))
  return end === -1 ? body : body.slice(0, end)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const target = args.find((arg) => !arg.startsWith('--'))
  if (!target || !existsSync(target)) {
    console.error('Usage: node run-digest.mjs <task_dir>/<TICKET> [--full | --no-write]')
    process.exit(2)
  }
  const { short, full } = publishDigest(resolve(target), pluginDataDir(), taskRepo(target, readPipelineState(process.cwd())), { write: !args.includes('--no-write') })
  console.log(args.includes('--full') ? full : short)
}
