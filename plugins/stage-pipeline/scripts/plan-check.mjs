#!/usr/bin/env node
/**
 * plan-check — the plan is linted before work starts (VT-5 stage 10).
 *
 *   node plan-check.mjs <STAGES.md> [--stage N] [--root <repo>] [--json]
 *
 * Prints a summary line per stage (AC count, verifier spread, visual reference, state × action, references resolved N/M), then the problems,
 * then the warnings; exit code 1 when there are problems. `--stage N` narrows the problems to stage N plus the open Force block.
 *
 * Why: of 24 force runs since 2026-10-06, 16 closed with blockers (13 product, 10 backend) and 10 were rerun — the plan carried criteria nobody could
 * check, references that pointed nowhere, and forks nobody had asked about. These are the structural parts of that, which a script can see.
 *
 * Problems (hard):
 * - the same AC id twice; an AC without `[verify: …]` / `[live: …]`; an open `[Gap]` / `[Ambiguity]` (no closing form on its line);
 * - a `dir/file.ext:line` that resolves neither in the repo nor in a sibling repo the config names (a sibling missing on this machine makes it a warning);
 * - a UI stage (not `logic-only`) without a `Visual reference:`;
 * - an empty Stage cell in "Design source coverage"; a "Shared elements" table with no rows and no `Pairs checked: N`;
 * - in a NEW Force block: no `Stage dependencies:` line, a `Taxonomy:` line that does not name all 12 categories, an assumption with no rollback.
 * Warnings only: the "state × action" heuristic, "0 runtime AC" on a UI stage.
 *
 * Hard only for what was written after the release (D7: existing plans are never rewritten). The first-sight gate of journal-check decides, per task:
 * a Force block is new by `ruleAppliesToBlock(releaseGate)`; a stage is new when it was not in the plan snapshot taken the first time this version looked at
 * the plan (the snapshot is its own file under the plugin data directory — the journal baseline version stays as it is), or, with no snapshot yet, when the
 * plan has no dated journal line from before the day of the first sight. Everything old gets the same findings as warnings.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { baselineName } from './baseline-file.mjs'
import { decisionViolations } from './decisions.mjs'
import { likeViolation, releaseGate } from './journal-check.mjs'
import {
  ARCHIVED_STUB,
  CLOSED_STAGE,
  CLOSED_WORD,
  CONFIRMED_LINE,
  COVERAGE_SECTION,
  FORCE_FIELD_LINE,
  NO_VISUAL_REFERENCE,
  PAIRS_CHECKED,
  SHARED_SECTION,
  STAGE_DEPENDENCIES_LINE,
  STATE_ACTION_FIELD,
  TAXONOMY_CATEGORIES,
  TAXONOMY_LINE,
  forceBlockBody,
  forceHeadings,
  forceKey,
  headingDate,
  logicOnlyTag,
  ruleAppliesToBlock,
  stageBlocksOf,
  stripQuoted,
} from './markers.mjs'
import { pluginDataDir, readConfig, readDataFiles, readTaskFile } from './hooks/pipeline-state.mjs'

const AC_START = /^[ \t]*(?:[-*][ \t]*|\|[ \t]*)?(?:\[[ xX]\][ \t]*)?(?:✅[ \t]*)?\**`?(AC-[\w.]*\w)`?\**(?=[\s:.,—–|)-]|$)/
const VERIFIER_TAG = /\[(?:verify|live):/i
const VERIFY_TAG = /\[verify:\s*([^\]]+)\]/gi
const BLOCKED_TAG = /\[blocked:/i
const VISUAL_LINE = /^[ \t]*(?:[-*][ \t]*)?\**(?:эталон\s+вида|visual\s+reference)\**\s*:\s*(.+)$/im
const OPEN_FORK = /\[(?:Gap|Ambiguity)\]/i
// What closes a fork on its own line (stage-kickoff, Steps 1.5 and 4): "closed by a fact from the source" (a `path:line` or a node-id), a decision, the interview batch
// or an assumption (`→ A3`), a narrowing, or a struck-through / ticked marker. A bare file-like token, a date, "e.g." or a mention of "A1" closes nothing.
const FORK_CLOSED =
  /(?:→|->|[—–:(\[]|^)\s*(?:closed|resolved|decided|narrowed|answered)\b|\b(?:closed|resolved|decided|narrowed|answered)\s+(?:by|in|with|via)\b|\b(?:closed|resolved|decided|narrowed|answered)\s*[:—–→]|(?:→|->)\s*(?:[DAB]\d+|DESIGN-QUESTIONS|interview|batch|assumption)|(?<![\w@./-])[\w@./-]+\.[A-Za-z]{1,5}:\d+\b|\bnode-?id\s*[:=]?\s*\d+[:-]\d+|\bout\s+of\s+stage\b|~~|✅|закрыт[оа]?(?![\wа-яё])|реш[её]н[оа]?(?![\wа-яё])|снят[оа]?(?![\wа-яё])|сужен[оа]?(?![\wа-яё])|вынесен[оа]?(?![\wа-яё])|ответ(?:ил\w*)?\s+(?:на\s+)?интервью|по\s+интервью|допущени[еяю]\s*[A-ZА-Я]?\d/i
const REF_WITH_LINE = /(?<![\w@./~:-])((?:~\/|\.{1,2}\/|\/)?[\w@.…-]+(?:\/[\w@.…-]+)+\.([A-Za-z][A-Za-z0-9]{0,5})):(\d+)(?:[-–](\d+))?(?![\w])/g
const NOT_A_FILE_EXT = new Set(['com', 'org', 'net', 'io', 'kz', 'ru', 'dev', 'app', 'local', 'test'])
const ACTION_WORDS = /\b(?:save[sd]?|saving|send(?:s|ing)?|submit(?:s|ted)?|delet(?:e[sd]?|ing)|status\s+change|сохран\w*|отправ\w*|удал\w*)\b/i
const CONDITION_WORDS = /\b(?:incomplete|empty|invalid|partial(?:ly)?|server\s+error|not\s+filled|without|неполн\w*|пуст\w*|без|ошибк\w*)\b/i
const READ_MAX = 2 * 1024 * 1024
const DATE = /\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4}/g
const DATED_LINE = /^[ \t]*(?:[-*][ \t]*)?\**\[?(\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})/

/** The plan snapshot's file name: the journal baseline's hash, in its own directory, so the journal baseline version is not touched. */
export const planSnapshotName = (taskDir) => join('plan-baseline', basename(baselineName(taskDir)))

/** The day in the local calendar (`2026-10-25`). */
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

const isoOf = (text) => headingDate(text)

/**
 * Whether the plan has a dated journal line from before `since` (a line that starts with a date, or a heading carrying one). A date inside prose does not count:
 * a new plan that quotes last month's audit is still a new plan.
 */
function hasEarlierDatedLine(text, since) {
  for (const line of text.split('\n')) {
    const lead = line.match(DATED_LINE)?.[1] ?? (/^#{2,3} /.test(line) ? line.match(DATE)?.[0] : null)
    const day = lead ? isoOf(lead) : null
    if (day && day < since) return true
  }
  return false
}

/** The plan snapshot a data directory already holds for a task, or null. */
export function readPlanSnapshot(dataDir, taskDir) {
  for (const raw of readDataFiles(dataDir, planSnapshotName(taskDir))) {
    try {
      const data = JSON.parse(raw)
      if (Array.isArray(data?.stages)) return data
    } catch {
      // a broken snapshot — the next one, or none
    }
  }
  return null
}

/**
 * The first look at a plan (K10.2): returns the snapshot that exists, or writes one from `text`. journal-gate calls it in PreToolUse of an Edit / Write / MultiEdit of
 * STAGES.md, before the edit lands, so the first look does not depend on which call reaches plan-check first (a Write that creates the file passes an empty text:
 * every stage and block of a new task is new).
 */
export function takePlanSnapshot(dataDir, taskDir, text, gate = null) {
  const existing = readPlanSnapshot(dataDir, taskDir)
  if (existing) return existing
  gate ??= releaseGate(dataDir, taskDir)
  // A run already going at the first look (D7): every Force heading there is an old run whatever its date, and when one of them is open and confirmed the
  // stages there are old too — a plan opened and started the same morning must not be denied for fields that did not exist when it was written.
  const headings = forceHeadings(text)
  const forceSeen = [...new Set(headings.map(([line]) => forceKey(line)))]
  const running = headings.some((heading) => !CLOSED_WORD.test(heading[0]) && CONFIRMED_LINE.test(forceBlockBody(text, heading)))
  const old = running || hasEarlierDatedLine(text, localDate())
  const snapshot = { created: localDate(), since: gate.since, stages: old ? stageBlocksOf(text).map(({ number }) => number) : [], forceSeen }
  try {
    mkdirSync(join(dataDir, 'plan-baseline'), { recursive: true })
    writeFileSync(join(dataDir, planSnapshotName(taskDir)), JSON.stringify(snapshot))
  } catch {
    // not written — the next look decides the same way from the same plan
  }
  return snapshot
}

/**
 * Which stages are new (K10.2): `{ gate, isNewStage }`. The gate is `releaseGate` of the task (the day this version first saw it and the Force blocks already there).
 * The snapshot of stage numbers is written once, at the first look: when the plan has an earlier dated line the stages there are old; otherwise the snapshot is empty
 * and every stage — those there and those added later — is new. No data directory or task directory: everything is new (fail closed, like the other gates).
 */
export function planContext(text, { dataDir = null, taskDir = null } = {}) {
  if (!dataDir || !taskDir) return { gate: null, isNewStage: () => true }
  const gate = releaseGate(dataDir, taskDir)
  const snapshot = takePlanSnapshot(dataDir, taskDir, text, gate)
  const seen = new Set(snapshot.stages.map(String))
  gate.seen = new Set([...(gate.seen ?? []), ...(Array.isArray(snapshot.forceSeen) ? snapshot.forceSeen : [])])
  // A Force block counts from the day plan-check first looked at the plan too: a block of a run that was already going is not held to a field that did not exist yet.
  const first = /^\d{4}-\d{2}-\d{2}$/.test(snapshot.created ?? '') ? snapshot.created : null
  if (first && (!gate.since || first > gate.since)) gate.since = first
  return { gate, isNewStage: (number) => !seen.has(String(number)) }
}

// ── references ────────────────────────────────────────────────────────────────

const fileCache = new Map()
function lineCount(path) {
  if (fileCache.has(path)) return fileCache.get(path)
  let count = null
  try {
    const stat = statSync(path)
    if (stat.isFile()) count = stat.size > READ_MAX ? Infinity : readFileSync(path, 'utf8').split('\n').length
  } catch {
    count = null
  }
  fileCache.set(path, count)
  return count
}

/** The sibling repos a config names: `../<name>` at the first level of a path (not `../../node_modules/…`), resolved against the repo root. */
export function siblingRepos(config, root) {
  if (!root || !config) return []
  const names = [...config.matchAll(/(?<![\w./~-])\.\.\/([A-Za-z0-9_@][\w@.-]*)/g)].map((match) => match[1])
  return [...new Set(names)].map((name) => resolve(root, '..', name))
}

/** The tracked files of a repo (`git ls-files`), as a map from the base name to the paths; null when the directory is not a git repo. Computed once per `checkPlan` run. */
function trackedFiles(root, cache) {
  if (cache.has(root)) return cache.get(root)
  let index = null
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    index = new Map()
    for (const path of out.split('\0').filter(Boolean)) {
      const name = path.slice(path.lastIndexOf('/') + 1)
      if (!index.has(name)) index.set(name, [])
      index.get(name).push(path)
    }
  } catch {
    index = null
  }
  cache.set(root, index)
  return index
}

/**
 * Whether `path:line` exists: `'ok'`, `'missing'`, `'ambiguous'` (the path is a suffix of several tracked files) or `'elided'` (`apps/.../X.tsx` — it names no file).
 * A path that does not join to a file under a base is looked up as a UNIQUE suffix of a tracked file (`git ls-files`): live plans write package-relative
 * (`guests-information/utils/x.ts` for `packages/shared/src/guests-information/utils/x.ts`) and plugin-relative (`scripts/x.mjs`) paths.
 */
function resolveRef(path, line, bases, cache) {
  if (/\.{3}|…/.test(path)) return 'elided'
  const fits = (candidate) => {
    const lines = lineCount(candidate)
    return lines !== null && Number(line) <= lines
  }
  const candidates = path.startsWith('~/') ? [join(homedir(), path.slice(2))] : isAbsolute(path) ? [path] : bases.map((base) => resolve(base, path))
  if (candidates.some(fits)) return 'ok'
  if (path.startsWith('~/') || isAbsolute(path)) return 'missing'
  const tail = path.replace(/^(?:\.{1,2}\/)+/, '')
  const matches = []
  for (const base of bases) {
    const index = trackedFiles(base, cache)
    if (!index) continue
    for (const tracked of index.get(tail.slice(tail.lastIndexOf('/') + 1)) ?? []) {
      if (tracked === tail || tracked.endsWith(`/${tail}`)) matches.push(resolve(base, tracked))
    }
  }
  const unique = [...new Set(matches)]
  if (unique.length === 1) return fits(unique[0]) ? 'ok' : 'missing'
  return unique.length > 1 ? (unique.some(fits) ? 'ambiguous' : 'missing') : 'missing'
}

// ── stage parsing ─────────────────────────────────────────────────────────────

/** The acceptance criteria of a stage block: `{ id, text, line }` — a criterion line plus the deeper-indented lines under it. */
function criteriaOf(block) {
  const lines = block.split('\n')
  const found = []
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(AC_START)
    if (!match) continue
    const indent = lines[index].match(/^[ \t]*/)[0].length
    let text = lines[index]
    let next = index + 1
    while (next < lines.length && lines[next].trim() && /^[ \t]*/.exec(lines[next])[0].length > indent && !AC_START.test(lines[next])) text += ` ${lines[next].trim()}`, next++
    // A status line under the criteria ("`AC-4.3` ✅ pro-review — …", "`AC-4.1`, `AC-4.2` [live: user-side …]") reports on a criterion, it is not one.
    if (/✅|⏳|^[ \t]*(?:[-*][ \t]*)?`?AC-[\w.]*\w`?\s*[,–-]\s*`?AC-/.test(text.slice(0, 200)) && !/\bWHEN\b/.test(text)) continue
    found.push({ id: match[1].replace(/[.,:]+$/, ''), text, line: lines[index] })
  }
  return found
}

const verifiersOf = (text) => [...text.matchAll(VERIFY_TAG)].flatMap((match) => match[1].split(/[,+/&]|\band\b/).map((name) => name.trim().match(/^[\w-]+/)?.[0]).filter(Boolean))

const withoutFences = (text) => text.replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, '')

function referencesOf(block) {
  const refs = new Map()
  for (const line of withoutFences(block).split('\n')) {
    const plain = line.replace(/https?:\/\/\S+/g, ' ')
    for (const match of plain.matchAll(REF_WITH_LINE)) {
      if (NOT_A_FILE_EXT.has(match[2].toLowerCase())) continue
      const key = `${match[1]}:${match[3]}`
      if (!refs.has(key)) refs.set(key, { path: match[1], line: match[3], text: line })
    }
  }
  return [...refs.values()]
}

// ── tables ────────────────────────────────────────────────────────────────────

const cellsOf = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
const isSeparator = (row) => /^\|?[\s:|-]+\|?$/.test(row.trim()) && row.includes('-')

function sectionText(text, heading) {
  const start = text.search(heading)
  if (start === -1) return null
  const rest = text.slice(start).split('\n').slice(1)
  const end = rest.findIndex((line) => /^## /.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

function tableRows(section) {
  const rows = section.split('\n').filter((line) => /^\s*\|/.test(line))
  const header = rows.find((row) => !isSeparator(row))
  const body = rows.slice(rows.indexOf(header) + 1).filter((row) => !isSeparator(row))
  return { header: header ? cellsOf(header) : null, body: body.map(cellsOf) }
}

// ── the check ─────────────────────────────────────────────────────────────────

/**
 * Lints a plan. `options`: `taskDir`, `dataDir` (the first-sight gate and the plan snapshot; without both everything is new), `roots` (repo roots the references are
 * resolved in), `config` (the config text, for sibling repos), `stage` (narrow the problems), `context` (a ready `planContext`, for tests).
 * Returns `{ stages: [{ number, heading, isNew, summary, line }], problems, warnings }`; a finding is `{ level, rule, scope: 'stage' | 'force' | 'plan', stage, block, message }`.
 */
export function checkPlan(text, options = {}) {
  const { taskDir = null, dataDir = null, roots = [], config = '', stage = null } = options
  const context = options.context ?? planContext(text, { dataDir, taskDir })
  const findings = []
  const note = (hard, finding) => findings.push({ ...finding, level: hard ? 'problem' : 'warning' })
  const siblings = siblingRepos(config, roots[0])
  // A `../src/module` in the config is a playground note, not a sibling repo: a name that is also a directory of this repo is not a sibling.
  const missingSiblings = siblings.filter((dir) => !existsSync(dir) && !(roots[0] && existsSync(join(roots[0], basename(dir)))))
  const refCache = new Map()
  const bases = [...new Set([...roots, ...siblings, ...(roots[0] ? [dirname(roots[0])] : []), ...(taskDir ? [taskDir, dirname(taskDir)] : [])])]
  const stages = []
  const seenIds = new Map()

  for (const { number, block } of stageBlocksOf(text)) {
    const heading = block.split('\n')[0]
    const closed = CLOSED_STAGE.test(heading)
    const isNew = context.isNewStage(number)
    // A closed stage is history: its findings are warnings whatever its age.
    const hard = isNew && !closed
    const at = { scope: 'stage', stage: String(number) }
    const summary = { acs: 0, verifiers: {}, visual: null, stateAction: null, refs: [0, 0], runtime: 0, ui: !logicOnlyTag(heading), archived: ARCHIVED_STUB.test(block) }
    stages.push({ number: String(number), heading: heading.replace(/^#+\s*/, '').replace(/\s*\[status:[^\]]*\]\s*/i, ' ').trim(), isNew, closed, summary })
    if (summary.archived) continue

    const criteria = criteriaOf(block)
    summary.acs = criteria.length
    for (const criterion of criteria) {
      const blocked = BLOCKED_TAG.test(criterion.text)
      const key = criterion.id.toLowerCase()
      if (seenIds.has(key)) note(hard, { ...at, rule: 'duplicate-ac', message: `${criterion.id}: the id is already used by a criterion of stage ${seenIds.get(key)} — ids are stable, a second criterion takes the next number.` })
      else seenIds.set(key, number)
      const names = verifiersOf(criterion.text)
      for (const name of names) summary.verifiers[name] = (summary.verifiers[name] ?? 0) + 1
      if (/devtools-verify|\[live:/i.test(criterion.text)) summary.runtime++
      if (!VERIFIER_TAG.test(criterion.text) && !blocked && !/\[cancelled:/i.test(criterion.text)) {
        note(hard, { ...at, rule: 'ac-no-verifier', message: `${criterion.id}: no \`[verify: …]\` or \`[live: …]\` tag — a criterion nobody can check is a defect of the plan (stage-plan, Step 3); reword it to something measurable, tag it, or mark it \`[blocked: B<n>]\`.` })
      }
      const like = likeViolation(criterion.line)
      if (like && !blocked) note(hard, { ...at, rule: 'ac-like-ref', message: like.message })
    }

    const forks = block.split('\n').filter((line) => OPEN_FORK.test(stripQuoted(line)) && !BLOCKED_TAG.test(line) && !FORK_CLOSED.test(stripQuoted(line).replace(OPEN_FORK, ' ')))
    for (const fork of forks) {
      note(hard, { ...at, rule: 'open-fork', message: `open ${fork.match(OPEN_FORK)[0]} "${fork.trim().slice(0, 70)}…" — close it with a fact from the source (path:line or node-id), a decision, the interview batch, or narrow the stage (stage-kickoff, Step 1.5).` })
    }

    const visual = block.match(VISUAL_LINE)?.[1]?.trim()
    summary.visual = visual && !NO_VISUAL_REFERENCE.test(visual) ? visual.slice(0, 40) : visual ? 'none' : 'missing'
    if (summary.ui) {
      if (summary.visual === 'missing' || summary.visual === 'none') {
        note(hard, { ...at, rule: 'no-visual-reference', message: `UI stage without a \`Visual reference:\` — name the neighbouring section (path and URL) devtools-verify compares typography with, or tag the stage \`logic-only\` (stage-plan, Step 3).` })
      }
      if (!summary.runtime) note(false, { ...at, rule: 'no-runtime-ac', message: `UI stage with 0 runtime AC — no criterion is checked by devtools-verify or tagged \`[live: …]\`.` })
    }

    const hasTable = STATE_ACTION_FIELD.test(`\n${block}`)
    const conditional = criteria.some((criterion) => ACTION_WORDS.test(criterion.text) && CONDITION_WORDS.test(criterion.text))
    summary.stateAction = hasTable ? 'yes' : conditional ? 'missing' : 'n/a'
    if (summary.stateAction === 'missing') note(false, { ...at, rule: 'state-action', message: `a criterion describes an action with conditions (save / send / delete, incomplete / empty / error) but the stage has no "State × action" table (stage-plan, Step 3).` })

    const refs = referencesOf(block)
    const verdicts = refs.map((ref) => ({ ref, verdict: resolveRef(ref.path, ref.line, bases, refCache) }))
    summary.refs = [verdicts.filter((entry) => entry.verdict === 'ok').length, refs.length]
    for (const { ref, verdict } of verdicts.filter((entry) => entry.verdict !== 'ok' && !BLOCKED_TAG.test(entry.ref.text))) {
      if (verdict === 'elided' || verdict === 'ambiguous') {
        note(false, {
          ...at,
          rule: 'ref-unverifiable',
          message: `\`${ref.path}:${ref.line}\` cannot be verified (${verdict === 'elided' ? 'the path is elided with "..."' : 'the path matches several tracked files'}) — write the full path from the repo root.`,
        })
        continue
      }
      // Only a ref that could point into a missing sibling repo is downgraded: its first segment is the sibling's name.
      const first = ref.path.replace(/^(?:\.{1,2}\/)+/, '').split('/')[0]
      const missing = missingSiblings.filter((dir) => basename(dir) === first)
      note(hard && missing.length === 0, {
        ...at,
        rule: 'unresolved-ref',
        message: `\`${ref.path}:${ref.line}\` does not resolve${missing.length ? ` (the sibling repo it points into is not on this machine: ${missing.map((dir) => basename(dir)).join(', ')})` : ' in the repo or a sibling repo'} — write the real file and line of what you refer to.`,
      })
    }
  }

  // The plan-level tables are hard only for a plan written wholly after the release (D7): one catch-up stage in an old plan does not make its old sections problems.
  const planHard = stages.length > 0 && stages.every((entry) => entry.isNew)
  const plan = { scope: 'plan', stage: null }
  const coverage = sectionText(text, COVERAGE_SECTION)
  if (coverage !== null) {
    const { header, body } = tableRows(coverage)
    const column = header?.findIndex((cell) => /^(?:stage|этап)/i.test(cell)) ?? -1
    if (column >= 0) {
      for (const row of body.filter((cells) => cells.some(Boolean) && !(cells[column] ?? '').trim())) {
        note(planHard, { ...plan, rule: 'coverage-empty-stage', message: `"Design source coverage": the row "${row[0]?.slice(0, 50)}" has an empty Stage cell — every source item has a stage or an explicit "out of plan" reason.` })
      }
    }
  }
  const shared = sectionText(text, SHARED_SECTION)
  if (shared !== null) {
    const { body } = tableRows(shared)
    const rows = body.filter((cells) => cells.some(Boolean) && !cells.every((cell) => /^<.*>$/.test(cell)))
    if (!rows.length && !PAIRS_CHECKED.test(shared)) {
      note(planHard, { ...plan, rule: 'shared-elements-empty', message: '"Shared elements" has no rows and no `Pairs checked: N` line — an empty table must say how many stage pairs were scanned (stage-plan, Step 2.1).' })
    }
  }
  if (missingSiblings.length) note(false, { ...plan, rule: 'sibling-missing', message: `sibling repos named by the config are not on this machine: ${missingSiblings.map((dir) => dir).join(', ')} — references into them are not checked.` })

  // Force blocks: new ones by the release gate (dated before the first sight = old).
  const headings = forceHeadings(text)
  for (const heading of headings) {
    const body = forceBlockBody(text, heading)
    const confirmedDay = isoOf(body.match(/^[ \t]*(?:[-*][ \t]*)?\**(?:Confirmed|Подтверждено)\**\s*:[^\n]*/im)?.[0] ?? '')
    // A closed run is history, as a closed stage is: its findings are warnings whatever its age.
    const isNew = !CLOSED_WORD.test(heading[0]) && (context.gate ? ruleAppliesToBlock(context.gate, heading[0], confirmedDay) : true)
    const at = { scope: 'force', stage: null, block: heading[0].replace(/^##\s*/, '') }
    if (!STAGE_DEPENDENCIES_LINE.test(body)) {
      note(isNew, { ...at, rule: 'force-no-dependencies', message: 'the Force block has no `Stage dependencies:` line — which stage waits for which, or "none" (stage-force, Step 0).' })
    }
    const taxonomy = taxonomyText(body)
    if (taxonomy === null) {
      note(isNew, { ...at, rule: 'force-no-taxonomy', message: 'the Force block has no `Taxonomy:` line — all 12 interview categories, each with its status (stage-force, Step 0).' })
    } else {
      const missing = TAXONOMY_CATEGORIES.filter((category) => !category.test.test(taxonomy)).map((category) => category.en)
      if (missing.length) note(isNew, { ...at, rule: 'force-taxonomy', message: `the \`Taxonomy:\` line does not name ${missing.length} of the 12 categories: ${missing.join(', ')}.` })
    }
    for (const violation of decisionViolations(`${heading[0]}\n${body}`).filter((entry) => entry.id === 'assumption' && /has no rollback cost/.test(entry.message))) {
      note(isNew, { ...at, rule: 'assumption-no-rollback', message: violation.message.replace(/^Assumption/, 'Assumption').split(' A decision taken alone')[0] + ' — add "Rollback: <what undoing it costs>".' })
    }
  }

  const keep = (finding) => stage === null || finding.scope === 'force' || finding.stage === String(stage)
  const openBlock = headings.filter(([line]) => !/заверш|\bcomplete/i.test(line)).at(-1)?.[0]
  const scoped = findings.filter((finding) => {
    if (stage === null) return true
    if (finding.scope === 'plan') return false
    if (finding.scope === 'force') return !openBlock || finding.block === openBlock.replace(/^##\s*/, '')
    return keep(finding)
  })
  return {
    stages: stage === null ? stages : stages.filter((entry) => entry.number === String(stage)),
    problems: scoped.filter((finding) => finding.level === 'problem'),
    warnings: scoped.filter((finding) => finding.level === 'warning'),
  }
}

/** The text of the `Taxonomy:` field: its line plus the lines under it, up to the next field (an indented line stays inside), or null when the line is not there. */
export function taxonomyText(body) {
  const lines = body.split('\n')
  const at = lines.findIndex((line) => TAXONOMY_LINE.test(line))
  if (at === -1) return null
  const out = [lines[at]]
  for (let index = at + 1; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim()) break
    // A bullet never ends the field: "- Boundaries: Clear" is a category of the list, not the Boundaries field.
    if (FORCE_FIELD_LINE.test(line) && !/^[ \t]{2,}/.test(line) && !/^[ \t]*[-*][ \t]/.test(line)) break
    out.push(line)
  }
  return out.join('\n')
}

/**
 * The stage a `stage-implement` prompt is about (K10.3): `Stage N`, `stage number: N`, the Russian form; the id is the plan's (`7c`, `A0`, `3.2`). Of the stages the prompt
 * names, the first that exists in the plan (an open one before a closed one: "stage 10 is closed, now implement stage 11"); with no number the first stage that is not
 * done. Null when there is none.
 */
export function stageForSpawn(text, prompt) {
  const blocks = stageBlocksOf(text)
  const named = [...String(prompt).matchAll(/(?:\bstage|этап)(?:\s+number)?\s*[:#]?\s*\**([0-9][\w.]*)/gi)].map((match) => match[1].replace(/\.+$/, ''))
  if (named.length) {
    const found = named.map((id) => blocks.find(({ number }) => String(number).toLowerCase() === id.toLowerCase())).filter(Boolean)
    const pick = found.find(({ block }) => !CLOSED_STAGE.test(block.split('\n')[0])) ?? found[0]
    return pick ? String(pick.number) : null
  }
  const open = blocks.find(({ block }) => !CLOSED_STAGE.test(block.split('\n')[0]))
  return open ? String(open.number) : null
}

/** One summary line per stage. */
export function summaryLine(entry) {
  const { summary } = entry
  if (summary.archived) return `Stage ${entry.number}: archived`
  const spread = Object.entries(summary.verifiers).map(([name, count]) => `${name} ${count}`).join(', ') || 'none'
  const runtime = summary.ui && !summary.runtime ? ' · 0 runtime AC' : ''
  const kind = summary.ui ? 'UI' : 'logic-only'
  return `Stage ${entry.number} (${kind}${entry.closed ? ', closed' : ''}${entry.isNew ? ', new' : ', old'}): AC ${summary.acs} · verifiers ${spread}${runtime} · visual reference ${summary.visual} · state × action ${summary.stateAction} · references resolved ${summary.refs[0]}/${summary.refs[1]}`
}

export const format = (finding) => `- ${finding.scope === 'stage' ? `Stage ${finding.stage}: ` : finding.scope === 'force' ? `Force block "${finding.block}": ` : ''}${finding.message}`

/** The CLI's text: summary lines, problems, warnings. */
export function formatReport(result, name = '') {
  const lines = [`plan-check${name ? ` ${name}` : ''}: ${result.stages.length} stage(s)`]
  for (const entry of result.stages) lines.push(summaryLine(entry))
  lines.push(`Problems (${result.problems.length}):`, ...result.problems.map(format))
  lines.push(`Warnings (${result.warnings.length}):`, ...result.warnings.map(format))
  return lines.join('\n')
}

/** The repo root for a STAGES.md: the nearest directory above it with `.claude/pipeline.config.md`, else the working directory. */
function rootFor(file) {
  let dir = dirname(resolve(file))
  for (;;) {
    if (existsSync(join(dir, '.claude/pipeline.config.md'))) return dir
    const up = dirname(dir)
    if (up === dir) return process.cwd()
    dir = up
  }
}

function main(args) {
  const flag = (name) => {
    const at = args.indexOf(name)
    return at === -1 ? null : args[at + 1]
  }
  const used = new Set(['--stage', '--root'].flatMap((name) => (args.includes(name) ? [args.indexOf(name) + 1] : [])))
  const target = args.find((arg, index) => !arg.startsWith('--') && !used.has(index))
  if (!target || !existsSync(target)) {
    console.error('Usage: node plan-check.mjs <STAGES.md> [--stage N] [--root <repo>] [--json]')
    process.exit(2)
  }
  const file = resolve(target)
  const taskDir = dirname(file)
  const text = readTaskFile(taskDir, basename(file)) ?? readFileSync(file, 'utf8')
  const root = flag('--root') ? resolve(flag('--root')) : rootFor(file)
  const result = checkPlan(text, { taskDir, dataDir: pluginDataDir(), roots: [root], config: readConfig(root), stage: flag('--stage') })
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : formatReport(result, file))
  // exitCode, not exit(): on a pipe the write is still pending when exit() runs, and a large report is cut at 64 KB.
  process.exitCode = result.problems.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
