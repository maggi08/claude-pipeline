/**
 * `retro.mjs --findings` (stage 13 of VT-6): the input of /promote. For the tasks of one repo it lists the critical and major findings of the checker
 * reports with their outcomes, groups them into classes with a count and a recurrence flag, counts the commits made on the task branch after the task
 * closed (VT-1 memo N4: fixes after "done" run no checker, so they are at least counted) and, with a corpus file, adds the stage 1 review corpus rows of the repo.
 *
 * The classes are a deterministic first cut by keywords (`CLASSES`, English and Russian words of live reports): a finding that fits none is `other`.
 * /promote does the real clustering on top of it; the cut only makes sure a repeat is not missed because nobody read all the reports.
 * A class recurs when it has hits in two or more tasks. A `signal` is a backticked path or identifier that stands in the findings of two or more tasks.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { disposition, ledgerEntries, findingCounts, reportChecker } from './journal-check.mjs'
import { entryHead, entrySeverity, findingRows } from './dismissals.mjs'
import { closedForceDate, configRoot, readConfig, taskBranches } from './hooks/pipeline-state.mjs'
import { headingDate } from './markers.mjs'

/** Ordered: the first class whose words are in the finding wins. */
export const CLASSES = [
  ['i18n', /i18n|locale|translation|перевод|локал|hard-?coded\s+(?:text|copy|string)|хардкод|plural/i],
  ['styling-tokens', /token|tailwind|rounded-|font-(?:semibold|bold)|kit[- ]?override|переопределени|palette|палитр|\bhex\b|shadow|radius|радиус|\w-\[\d/i],
  ['dead-code', /dead[- ]code|unused|orphan|unreachable|не\s+использу|мёртв|мертв|осирот|без\s+call-site|без\s+потребител/i],
  ['reuse-duplicate', /duplicat|дубл|already\s+exists|уже\s+есть|reuse|переиспольз|copy\s+of|копи[яю]\s/i],
  ['types', /\bas\s+any\b|:\s*any\b|type\s+escape|ts-ignore|typing|типизац|as\s+unknown/i],
  ['layering', /layer|слой|no-restricted|boundar|api\s+(?:call\s+)?in\s+(?:a\s+)?component|import(?:s|ed)?\s+from\s+['"`]/i],
  ['a11y', /a11y|aria-|accessib|доступност|tabindex|alt\s+text/i],
  ['states', /loading\s+state|empty\s+state|error\s+state|skeleton|пуст\w+\s+состоян|состояни[ея]\s+загрузк/i],
  ['test-quality', /\btests?\b|\bтест|assert|coverage|покрыти/i],
  ['security', /security|\bxss\b|injection|csrf|secret|секрет|уязвим/i],
  ['performance', /perf(?:ormance)?\b|re-?render|n\+1|производительн/i],
  ['comments', /commented-out|\bTODO\b|\bFIXME\b|\bcomments?\s+(?:that|retell|duplicat|restat)|комментари\w*\s+(?:перескаж|дублир|лишн)/i],
  ['naming', /\bnaming\b|нейминг|названи/i],
  ['config-env', /\.env\b|\bconfig\b|конфиг|окружени/i],
  ['logic-correctness', /\brace\b|\bnull\b|undefined|edge\s+case|off-by|неверн|ошибк|\bbug\b|\bбаг|crash|падает|\b500\b|regress/i],
]
const classOf = (text) => CLASSES.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other'

const CHECKER_NAMES = ['kit-overrides', 'cleanup-review', 'security-review']
const checkerOf = (name) => reportChecker(name) ?? CHECKER_NAMES.find((checker) => name.includes(checker)) ?? 'other'

const walkReports = (root) => {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return walkReports(path).map((child) => `${entry.name}/${child}`)
    return entry.isFile() && entry.name.endsWith('.md') ? [entry.name] : []
  })
}

/** The row of the report the ledger line closes: the first line before the ledger that starts with the line's id (`K-1`, `M-2`, `#4`), else the ledger line itself. */
const rowText = (entry, rows) => {
  const id = entryHead(entry).trim().replace(/^\**|\**$/g, '').split(/\s+/)[0]
  if (!id) return null
  const start = new RegExp(`^\\s*(?:[-*]\\s+|\\d+\\.\\s+|#{2,4}\\s+|\\|\\s*)?\\**${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\**(?![\\w.-])`)
  return rows.lines.find((line) => start.test(line))?.replace(/[|*#]+/g, ' ').replace(/\s+/g, ' ').trim() ?? null
}

const fileOf = (text) => [...text.matchAll(/`?((?:[\w@.[\]()-]+\/)+[\w@.[\]()-]+\.\w+)(?::\d+)?`?/g)].map((found) => found[1]).find((path) => !path.startsWith('checks/')) ?? null

const gitOut = (cwd, ...args) => {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

/** The last dated line of a journal, as a fallback for "the task closed" when no Force block closed. */
const lastJournalDate = (stages) => {
  const section = stages.split(/^## (?:Журнал|Journal)/m)[1]?.split(/^## /m)[0] ?? ''
  const dates = [...section.matchAll(/\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4}/g)].map(([found]) => headingDate(found)).filter(Boolean)
  return dates.length ? dates.sort().at(-1) : null
}

/**
 * Commits on the task branch after the task closed (by author date: a rebase after the close rewrites the committer date, not this one): `{ branch, closed, closedBy, commits, shas }`; `commits: null` and a `why` when it cannot be counted (no repo, no
 * branch in the header, the branch is gone, the task never closed). "Closed" is the end of the day the Force block was closed, else of the last dated journal line.
 */
export function postDoneCommits(stages, repoRoot) {
  const branch = taskBranches(stages)[0] ?? null
  const forced = closedForceDate(stages)
  const closed = forced ?? lastJournalDate(stages)
  const closedBy = forced ? 'force-close' : closed ? 'last-journal-line' : null
  const out = { branch, closed, closedBy, commits: null, shas: [] }
  if (!repoRoot) return { ...out, why: 'no repo' }
  if (!branch) return { ...out, why: 'no branch in the STAGES.md header' }
  if (!closed) return { ...out, why: 'no close date' }
  const ref = ['', 'refs/heads/', 'refs/remotes/origin/'].map((prefix) => `${prefix}${branch}`).find((candidate) => gitOut(repoRoot, 'rev-parse', '--verify', '-q', candidate))
  if (!ref) return { ...out, why: 'the branch is not in the repo' }
  // the config the hooks read: a linked worktree with an excluded `.claude/` has the main tree's
  const config = readConfig(configRoot(repoRoot, repoRoot) ?? repoRoot)
  const configured = config.match(/^[ \t]*-[ \t]*main_branch:[ \t]*[`*]*([\w./-]+)/m)?.[1]
  const base = [configured, `origin/${configured}`, 'origin/HEAD', 'main', 'master', 'dev'].filter(Boolean).find((candidate) => gitOut(repoRoot, 'rev-parse', '--verify', '-q', candidate))
  const log = gitOut(repoRoot, 'log', '--format=%H %aI', ref, ...(base ? ['--not', base] : []))
  if (log === null) return { ...out, why: 'git log failed' }
  const until = new Date(`${closed}T23:59:59`).getTime()
  const shas = log
    .split('\n')
    .filter(Boolean)
    .filter((line) => Date.parse(line.split(' ')[1]) > until)
    .map((line) => line.split(' ')[0].slice(0, 10))
  const subjects = (gitOut(repoRoot, 'log', '--format=%h %s', '-n', '60', ref, ...(base ? ['--not', base] : [])) ?? '').split('\n').filter(Boolean)
  return { ...out, commits: shas.length, shas: shas.slice(0, 20), branchCommits: subjects, ref, base: base ?? null }
}

/** The commits of the task branch (not on the base) that touched a file: `["<sha> <subject>", …]`: the candidates for the `fixes` of a proof. */
export function commitsTouching(repoRoot, ref, base, file) {
  if (!repoRoot || !ref || !file) return []
  const log = gitOut(repoRoot, 'log', '--format=%h %s', '-n', '5', ref, ...(base ? ['--not', base] : []), '--', file)
  return (log ?? '').split('\n').filter(Boolean)
}

/** The findings of one task directory: `{ findings: [...], withoutOutcome, unrated, reports }`. */
export function taskFindings(dir) {
  const ticket = basename(dir)
  const findings = []
  let withoutOutcome = 0
  let unrated = 0
  const names = walkReports(join(dir, 'checks'))
  for (const name of names) {
    let text
    try {
      if (statSync(join(dir, 'checks', name)).size > 4 * 1024 * 1024) continue
      text = readFileSync(join(dir, 'checks', name), 'utf8')
    } catch {
      continue
    }
    const entries = ledgerEntries(text) ?? []
    const rows = findingRows(text)
    let seen = 0
    for (const entry of entries) {
      const severity = entrySeverity(entry, rows)
      if (severity !== 'critical' && severity !== 'major') {
        if (severity === null) unrated++
        continue
      }
      seen++
      const row = rowText(entry, rows)
      const body = entry.replace(/^\s*(?:[-*]|\d+\.)\s+/, '')
      const shown = `${row ?? ''} ${body}`.trim()
      findings.push({
        task: ticket,
        report: name,
        checker: checkerOf(name),
        id: entryHead(entry).trim().slice(0, 60),
        severity,
        outcome: disposition(entry),
        class: classOf(shown),
        file: fileOf(shown),
        text: (row ?? body).slice(0, 220),
        outcomeText: body.slice(0, 220),
      })
    }
    const counts = findingCounts(text, name)
    withoutOutcome += Math.max(0, counts.critical + counts.major - seen)
  }
  return { ticket, findings, withoutOutcome, unrated, reports: names.length }
}

const SIGNAL_NOISE = /^(?:[A-Z]{1,5}-\d+[a-z]?|#?\d+|true|false|null|undefined|checks\/.*)$/
const signalsOf = (text) => [...text.matchAll(/`([^`\n]{4,80})`/g)].map(([, token]) => token.replace(/:\d+(?:-\d+)?$/, '').trim()).filter((token) => !SIGNAL_NOISE.test(token) && /[/.(\-_]|[a-z][A-Z]/.test(token))

/** Corpus rows (the stage 1 TSV) of one repo, unique ones (`dup_of` empty): by class with the checker outcome. */
export function corpusRows(tsvPath, repoName) {
  const [head, ...lines] = readFileSync(tsvPath, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\t'))
  const col = Object.fromEntries(head.map((name, index) => [name, index]))
  const rows = lines
    .filter((cells) => cells[col.repo] === repoName && !cells[col.dup_of])
    .map((cells) => Object.fromEntries(['uid', 'class', 'severity', 'raised_by', 'checker_outcome', 'let_through', 'file_line', 'quote'].filter((name) => name in col).map((name) => [name, cells[col[name]]])))
  const byClass = new Map()
  for (const row of rows) {
    const entry = byClass.get(row.class) ?? { class: row.class, rows: 0, missed: 0, majorOrCritical: 0 }
    entry.rows++
    if (/^missed|^never-reached/.test(row.checker_outcome)) entry.missed++
    if (row.severity === 'major' || row.severity === 'critical') entry.majorOrCritical++
    byClass.set(row.class, entry)
  }
  return { repo: repoName, file: tsvPath, rows: rows.length, byClass: [...byClass.values()].sort((a, b) => b.rows - a.rows), sample: rows.slice(0, 200) }
}

/** The whole report for a list of task directories. `repoRoot` is for the post-done count, `corpus` is `{ path, repo }` or null. */
export function findingsReport(taskDirs, { repoRoot = null, corpus = null } = {}) {
  const tasks = []
  const all = []
  const branches = new Map()
  for (const dir of taskDirs) {
    const found = taskFindings(dir)
    let stages = ''
    try {
      stages = readFileSync(join(dir, 'STAGES.md'), 'utf8')
    } catch {
      // no journal — nothing to count after
    }
    const post = postDoneCommits(stages, repoRoot)
    branches.set(found.ticket, { ref: post.ref ?? null, base: post.base ?? null })
    delete post.ref
    delete post.base
    tasks.push({ task: found.ticket, reports: found.reports, findings: found.findings.length, withoutOutcome: found.withoutOutcome, unrated: found.unrated, postDone: post })
    all.push(...found.findings)
  }
  const classes = new Map()
  for (const finding of all) {
    const entry = classes.get(finding.class) ?? { class: finding.class, hits: 0, tasks: new Set(), checkers: new Set(), outcomes: {}, files: new Map(), examples: [] }
    entry.hits++
    entry.tasks.add(finding.task)
    entry.checkers.add(finding.checker)
    entry.outcomes[finding.outcome] = (entry.outcomes[finding.outcome] ?? 0) + 1
    if (finding.file) entry.files.set(finding.file, (entry.files.get(finding.file) ?? 0) + 1)
    if (entry.examples.length < 5) {
      const where = branches.get(finding.task)
      entry.examples.push({ task: finding.task, report: finding.report, id: finding.id, severity: finding.severity, outcome: finding.outcome, file: finding.file, text: finding.text, commits: commitsTouching(repoRoot, where?.ref, where?.base, finding.file) })
    }
    classes.set(finding.class, entry)
  }
  const groups = [...classes.values()]
    .map((entry) => ({
      class: entry.class,
      hits: entry.hits,
      tasks: [...entry.tasks].sort(),
      recurrent: entry.tasks.size >= 2,
      checkers: [...entry.checkers].sort(),
      outcomes: entry.outcomes,
      repeatedFiles: [...entry.files].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([file, count]) => ({ file, count })),
      examples: entry.examples,
    }))
    .sort((a, b) => Number(b.recurrent) - Number(a.recurrent) || b.hits - a.hits || a.class.localeCompare(b.class))
  const bySignal = new Map()
  for (const finding of all) for (const token of new Set(signalsOf(`${finding.text} ${finding.outcomeText}`))) bySignal.set(token, (bySignal.get(token) ?? new Set()).add(finding.task))
  const signals = [...bySignal].filter(([, tasks]) => tasks.size >= 2).sort((a, b) => b[1].size - a[1].size).slice(0, 15).map(([signal, tasks]) => ({ signal, tasks: [...tasks].sort() }))
  // The reverse direction: findings closed as `false`, per checker, each with the reason the outcome line gives (a dismissal without a proof is listed too: /promote counts only the proven ones).
  const byChecker = new Map()
  for (const finding of all.filter(({ outcome }) => outcome === 'false')) {
    const list = byChecker.get(finding.checker) ?? []
    list.push({ task: finding.task, report: finding.report, id: finding.id, severity: finding.severity, file: finding.file, text: finding.text, outcomeText: finding.outcomeText })
    byChecker.set(finding.checker, list)
  }
  const dismissals = [...byChecker].map(([checker, items]) => ({ checker, count: items.length, tasks: [...new Set(items.map(({ task }) => task))].sort(), items })).sort((a, b) => b.count - a.count || a.checker.localeCompare(b.checker))
  return {
    tasks,
    totals: { tasks: tasks.length, findings: all.length, critical: all.filter(({ severity }) => severity === 'critical').length, major: all.filter(({ severity }) => severity === 'major').length, postDoneCommits: tasks.reduce((sum, { postDone }) => sum + (postDone.commits ?? 0), 0) },
    classes: groups,
    signals,
    dismissals,
    corpus: corpus ? corpusRows(corpus.path, corpus.repo) : null,
  }
}

/** The short text view. */
export function renderFindings(report, { dismissals = false } = {}) {
  const out = ['# Findings for /promote', '']
  const { totals } = report
  out.push(`Tasks: ${totals.tasks} · critical+major findings with an outcome line: ${totals.findings} (critical ${totals.critical}, major ${totals.major}) · commits after the task closed: ${totals.postDoneCommits}`, '')
  out.push('## Classes (a class recurs when it has hits in two or more tasks)')
  if (!report.classes.length) out.push('- none')
  for (const group of report.classes) {
    const outcomes = Object.entries(group.outcomes).map(([name, count]) => `${name} ${count}`).join(', ')
    out.push(`- ${group.recurrent ? 'RECURS ' : ''}${group.class}: ${group.hits} hit(s) in ${group.tasks.length} task(s) [${outcomes}] — ${group.checkers.join(', ')}${group.repeatedFiles.length ? ` — repeated files: ${group.repeatedFiles.map(({ file, count }) => `${file} ×${count}`).join(', ')}` : ''}`)
    for (const example of group.examples.slice(0, 2)) {
      out.push(`    · ${example.task}/${example.report} ${example.id} (${example.severity}, ${example.outcome}): ${example.text.slice(0, 140)}`)
      if (example.commits?.length) out.push(`        commits on the branch that touched ${example.file}: ${example.commits.slice(0, 3).join(' | ')}`)
    }
  }
  if (report.signals.length) {
    out.push('', '## Signals (the same path or identifier in the findings of two or more tasks)')
    for (const { signal, tasks } of report.signals) out.push(`- \`${signal}\` — ${tasks.join(', ')}`)
  }
  if (dismissals) {
    out.push('', '## Dismissals per checker (outcome false: the reverse direction of /promote)')
    if (!report.dismissals.length) out.push('- none')
    for (const group of report.dismissals) {
      out.push(`- ${group.checker}: ${group.count} in ${group.tasks.length} task(s) — ${group.tasks.join(', ')}`)
      for (const item of group.items.slice(0, 12)) out.push(`    · ${item.task}/${item.report} ${item.id}: ${item.text.slice(0, 100)} → ${item.outcomeText.slice(0, 160)}`)
    }
  }
  out.push('', '## Commits after the task closed (no checker ran on them)')
  for (const { task, postDone } of report.tasks) {
    out.push(`- ${task}: ${postDone.commits === null ? `not counted — ${postDone.why}` : `${postDone.commits}${postDone.commits ? ` (${postDone.shas.slice(0, 5).join(', ')}${postDone.shas.length > 5 ? ', …' : ''})` : ''} after ${postDone.closed} (${postDone.closedBy}), branch ${postDone.branch}`}`)
  }
  const missing = report.tasks.filter(({ withoutOutcome }) => withoutOutcome)
  if (missing.length) out.push('', `Findings without an outcome line: ${missing.map(({ task, withoutOutcome }) => `${task} ${withoutOutcome}`).join(', ')}`)
  if (report.corpus) {
    out.push('', `## Stage 1 corpus rows of ${report.corpus.repo} (${report.corpus.rows} unique, ${report.corpus.file})`)
    if (!report.corpus.rows) out.push('- none')
    for (const entry of report.corpus.byClass) out.push(`- ${entry.class}: ${entry.rows} (checker missed or never reached ${entry.missed}, major or critical ${entry.majorOrCritical})`)
  }
  return `${out.join('\n')}\n`
}
