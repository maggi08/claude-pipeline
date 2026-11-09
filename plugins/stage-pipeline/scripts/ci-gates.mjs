#!/usr/bin/env node
/**
 * The project's CI gates — commands that CI runs on a PR and that "must not fail": smoke, e2e, bundle size,
 * locale completeness. The pipeline's final checks knew only lint / type_check / test / build, and in one
 * task smoke failed only at the PR: the regression came from a round of a11y fixes that touched a wizard outside
 * the stage's screen, while the fresh devtools-verify looked only at the stage's screen.
 *
 * Where the list comes from: the "## CI gates" table in pipeline.config.md (the first cell is the name, the command is in backticks),
 * without a table — the `- e2e:` and `- smoke:` lines in Commands. The script does not take commands from CI files:
 * they hold deploys and secrets, and proposing a table is the job of /pipeline-doctor.
 *
 * The result of a run is written by run-check.mjs — by the commit tree (`HEAD^{tree}`), only when tracked
 * files did not change either before or during the run. A green gate is exit code 0 on the HEAD tree of the task's worktree (`taskWorktree`): a run before
 * the last fix does not count towards closing.
 *
 *   node ci-gates.mjs          # the repo's gates and their state on HEAD
 *   node ci-gates.mjs --run    # run the non-green ones through run-check.mjs and show the result
 *
 * A gate that cannot run on this machine (needs staging, no browser) is skipped on the record, not blocked on again and again:
 * `skip: <reason> <date>` in its row of the table (or after it on an `- e2e:` line), or a line in the run's Force block —
 * `skip: <gate name> — <reason> <date>`. A skipped gate is listed once as skipped and accepted when the run closes; the reason and the date are required,
 * a bare `skip:` does not count. A gate without the mark blocks as before. A green run on HEAD beats any skip; a run that is red on HEAD beats a skip of
 * the Force block (written by the run itself: it stands only for a gate that cannot run here, never for one that ran and failed) — the user's mark in the
 * config row still counts.
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { baselineInfo, blockerGate, fingerprint, lastForceBlock, openBlockers, readTaskFile } from './journal-check.mjs'
import { dirtyPaths, isCurrentTask, pathList, pluginDataDir, readDataFiles, readPipelineState, realOr } from './hooks/pipeline-state.mjs'
import { CI_GATES_HEADING, CLOSED_WORD, NO_GATE_COMMAND, WITH_BLOCKERS } from './markers.mjs'

const RUN_CHECK = join(dirname(fileURLToPath(import.meta.url)), 'run-check.mjs')

export const normalize = (command) => command.replace(/\s+/g, ' ').trim()

const SKIP_DATE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4})\b/

/** `skip: <reason> <date>` from a text: the reason and the date are both required; otherwise null. */
export function parseSkip(text) {
  const raw = text.match(/\bskip(?:ped)?\s*:\s*([^|\n]+)/i)?.[1]?.replace(/[`*]/g, '').trim()
  if (!raw || !SKIP_DATE.test(raw)) return null
  // The trailing trim starts only at the start of the run: a bare `[…]+$` backtracks from every separator of a long reason.
  const reason = raw.replace(SKIP_DATE, '').replace(/(?<![\s,;:()—–-])[\s,;:()—–-]+$/, '').replace(/^[\s,;:()—–-]+/, '').trim()
  return reason ? { reason, date: raw.match(SKIP_DATE)[0] } : null
}

/**
 * The skips of the run: lines of its Force block that carry `skip:` and name a gate (by name or by command). `[{ name, reason, date }]`.
 * The gate is named before `skip:` or right after it (before the dash), so a line about gate A never skips gate B.
 */
export function forceSkips(taskDir) {
  const stages = readTaskFile(taskDir, 'STAGES.md')
  if (stages === null) return []
  const block = lastForceBlock(stages)
  if (!block) return []
  return block.body.split('\n').flatMap((line) => {
    const at = line.search(/\bskip(?:ped)?\s*:/i)
    if (at === -1) return []
    // `skip: <gate> — <reason> <date>` names the gate after the colon; `<gate> skip: <reason> <date>` before it, in the same clause.
    const rest = line.slice(at).replace(/^\bskip(?:ped)?\s*:\s*/i, '')
    const split = rest.search(/\s[—–-]\s/)
    const tail = split === -1 ? '' : rest.slice(split).replace(/^\s[—–-]\s/, '')
    // `<reason> — <date>`: a dash before a bare date leaves the reason in front of it, and no gate is named after the colon.
    const dated = split !== -1 && SKIP_DATE.test(tail) && !tail.replace(SKIP_DATE, '').replace(/[\s,;:()—–-]/g, '')
    const named = split === -1 || dated ? '' : rest.slice(0, split)
    const skip = parseSkip(`skip: ${split === -1 ? rest : dated ? `${rest.slice(0, split)} ${tail}` : tail}`)
    // Only the clause that holds `skip:` speaks for its gate: `smoke failed, e2e skip: …` skips e2e alone.
    const clause = line.slice(0, at).split(/[,;]|\.(?=\s)/).pop()
    return skip ? [{ ...skip, before: `${clause} ${named}`.toLowerCase() }] : []
  })
}

/** Gates from the config: `[{ name, command, skip? }]`. Empty — the project has no gates, the rule stays silent. */
export function gateCommands(config) {
  const table = gateTable(config)
  if (table.length) return table
  const gates = []
  for (const [, key, raw] of config.matchAll(/^[ \t]*-[ \t]*\**(e2e|smoke)\**(?:[ \t]*\([^)\n]*\))?[ \t]*:[ \t]*(.+)$/gim)) {
    const command = raw.match(/`([^`]+)`/)?.[1] ?? raw.split(/\s+#|\s+\/\s+|\s+\(|\s+\|/)[0]
    if (!command || NO_GATE_COMMAND.test(command.trim())) continue
    gates.push({ name: key.toLowerCase(), command: normalize(command), ...skipOf(raw) })
  }
  return dedupe(gates)
}

function gateTable(config) {
  const heading = config.match(CI_GATES_HEADING)
  if (!heading) return []
  const rest = config.slice(heading.index + heading[0].length).split('\n')
  const end = rest.findIndex((line) => new RegExp(`^#{1,${heading[1].length}}\\s`).test(line))
  const gates = []
  for (const line of end === -1 ? rest : rest.slice(0, end)) {
    if (!/^\s*\|/.test(line) || /^\s*\|[\s:|-]+\|\s*$/.test(line)) continue
    const command = line.match(/`([^`]+)`/)?.[1]
    if (!command) continue
    const name = line.split('|')[1].replace(/[*`]/g, '').trim() || command
    gates.push({ name, command: normalize(command), ...skipOf(line.slice(line.indexOf(command) + command.length)) })
  }
  return dedupe(gates)
}

const skipOf = (text) => {
  const skip = parseSkip(text)
  return skip ? { skip } : {}
}

const dedupe = (gates) => gates.filter((gate, index) => gates.findIndex((other) => other.command === gate.command) === index)

/** The HEAD tree and whether tracked files are clean: untracked ones (the task directory, frames) do not get in the way of a run. `dirty`: the tracked paths that differ from HEAD. */
export function treeState(cwd) {
  try {
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const dirty = dirtyPaths(cwd)
    return dirty === null ? { tree: null, clean: false, dirty: [] } : { tree, clean: dirty.length === 0, dirty }
  } catch {
    return { tree: null, clean: false, dirty: [] }
  }
}

/** Why a gate run may not have counted: one wording for run-check, the close message and the listing. */
export const UNRECORDED = 'run-check records a gate run only on a clean tree'

/** The command is one of the config's gates (equal, or the gate with a tail of flags — the rule `gateStatus` reads records by). */
export const isGateCommand = (config, command) => {
  const run = normalize(command)
  return gateCommands(config).some((gate) => run === gate.command || run.startsWith(`${gate.command} `))
}

/**
 * The worktree whose gates close a task: the one where the task's branch is checked out. The journal of a task run in a linked worktree lives in the
 * main tree, so its close was judged on the main tree's HEAD: VT-8 bounced 12 closes on "ran on another tree" while its gates were green in its own worktree.
 * The caller's worktree is a candidate like any other. Matched in this order, and the first level with a match decides:
 * 1. the branch of the `Branch:` header (`task.branches`): a header that names a branch checked out nowhere keeps the caller's worktree;
 * 2. no header: a worktree whose path STAGES.md names in backticks (VT-8 names its worktree in the Force block);
 * 3. no header: a worktree whose branch carries the ticket (`isCurrentTask`). A bare branch name in the prose (`dev`, `main`) is never a match:
 *    most journals name the base branch, and a base worktree's green gates must not close a task.
 * Two matches at one level, or none — the caller's. A prunable worktree (its directory gone) is never picked.
 */
export function taskWorktree(worktree, task) {
  if (!task || task.current) return worktree
  let listing
  try {
    listing = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return worktree
  }
  const trees = listing
    .split('\n\n')
    .filter((block) => !/^prunable\b/m.test(block) && !/^bare$/m.test(block))
    .map((block) => ({ path: block.match(/^worktree (.+)$/m)?.[1], branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null }))
    .filter((tree) => tree.path && existsSync(tree.path))
  const caller = realOr(worktree)
  const level = (test) => {
    const hits = trees.filter(test)
    if (!hits.length) return undefined
    return hits.length === 1 && realOr(hits[0].path) !== caller ? hits[0].path : worktree
  }
  const branches = task.branches ?? []
  if (branches.length) return level((tree) => tree.branch && branches.includes(tree.branch)) ?? worktree
  const text = task.stages ?? ''
  return (
    level((tree) => text.includes(`\`${tree.path}\``) || text.includes(`\`${realOr(tree.path)}\``)) ??
    level((tree) => tree.branch && task.ticket && isCurrentTask(task.ticket, [], tree.branch)) ??
    worktree
  )
}

/** The records file name relative to a data directory (not a slice of the full path: `CLAUDE_PLUGIN_DATA` may end with a slash). */
function recordsName(worktree) {
  // a directory that is gone is keyed by the original path
  return join('gates', `${createHash('sha1').update(realOr(worktree)).digest('hex').slice(0, 16)}.json`)
}

const recordsPath = (dataDir, worktree) => join(dataDir, recordsName(worktree))

export function gateRecords(dataDir, worktree) {
  // The bare `stage-pipeline` directory is read first, the hooks' one over it: a run recorded earlier from Bash still counts.
  const records = {}
  for (const text of readDataFiles(dataDir, recordsName(worktree)).reverse()) {
    try {
      Object.assign(records, JSON.parse(text))
    } catch {
      // a broken file — skip it
    }
  }
  return records
}

export function recordGate(dataDir, worktree, command, code, tree) {
  const path = recordsPath(dataDir, worktree)
  const records = gateRecords(dataDir, worktree)
  records[normalize(command)] = { code, tree, at: new Date().toISOString() }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(records, null, 2))
  } catch {
    // not written — the gate will simply have to be run once more
  }
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A gate name matches as a whole word: `ci` / `test` / `build` are not found inside "special" or "rebuild".
const mentioned = (skips, gate) => {
  const word = new RegExp(`(^|[^\\w])${escapeRegExp(gate.name.toLowerCase())}($|[^\\w])`)
  const hit = skips.find(({ before }) => word.test(before) || before.includes(gate.command.toLowerCase()))
  return hit ? { reason: hit.reason, date: hit.date } : null
}

/**
 * The state of each gate on the HEAD of `worktree`: green | red | stale (the run was on another tree) | missing | skipped (on the record, with a reason and a date).
 * A run with a tail of flags counts too: `… playwright test --grep-invert "snapshot"` closes `… playwright test`.
 */
export function gateStatus(dataDir, worktree, config, skips = []) {
  const gates = gateCommands(config)
  if (!gates.length) return []
  const { tree } = treeState(worktree)
  const records = Object.entries(gateRecords(dataDir, worktree))
  return gates.map((gate) => {
    const runs = records.filter(([command]) => command === gate.command || command.startsWith(`${gate.command} `)).map(([, record]) => record)
    const here = runs.filter((record) => tree && record.tree === tree).sort((a, b) => (a.at < b.at ? 1 : -1))
    const status = here.length ? (here[0].code === 0 ? 'green' : 'red') : runs.length ? 'stale' : 'missing'
    // A green run beats a skip: the mark only stands in for a run that cannot happen. A run red on HEAD beats the Force block's own skip line: the run
    // that wrote the skip saw the gate fail, and a failing gate is a fix-loop finding, not a gate that "cannot run here". The config-row mark is the user's and still counts.
    const skip = status === 'green' ? null : (gate.skip ?? (status === 'red' ? null : mentioned(skips, gate)))
    // A skip still hides nothing: when the last recorded run of the gate (on any tree) is red, the listing says so.
    const last = [...runs].sort((a, b) => (a.at < b.at ? 1 : -1))[0]
    return skip ? { ...gate, skip, status: 'skipped', code: here[0]?.code ?? null, lastRed: Boolean(last) && last.code !== 0 } : { ...gate, status, code: here[0]?.code ?? null }
  })
}

// Gate descriptions go into hook messages (English) and into the run digest (task language); the default is English.
const STATUS_TEXT = {
  en: { green: 'green', red: 'red', stale: 'ran on another tree', missing: 'never ran', skipped: 'skipped', skippedRed: 'skipped — last run red' },
  ru: { green: 'зелёный', red: 'красный', stale: 'гонялся на другом дереве', missing: 'не запускался', skipped: 'пропущен', skippedRed: 'пропущен — последний запуск красный' },
}
const RED_CODE = { en: 'code', ru: 'код' }
export const describe = (gate, language = 'en') => {
  const tail = gate.status === 'skipped' ? `: ${gate.skip.reason}, ${gate.skip.date}` : gate.status === 'red' ? `, ${RED_CODE[language === 'ru' ? 'ru' : 'en']} ${gate.code}` : ''
  return language === 'ru'
    ? `«${gate.name}» (\`${gate.command}\`) — ${STATUS_TEXT.ru[gate.lastRed ? 'skippedRed' : gate.status]}${tail}`
    : `"${gate.name}" (\`${gate.command}\`) — ${STATUS_TEXT.en[gate.lastRed ? 'skippedRed' : gate.status]}${tail}`
}

/** A gate that does not hold the close back: green, or skipped on the record. */
export const gateAccepted = (gate) => gate.status === 'green' || gate.status === 'skipped'

/**
 * Closing a force run with a non-green gate. "Completed" — only when all gates are green on the HEAD of the task's worktree (`taskWorktree`; `caller` is the worktree the hook ran in);
 * "completed with blockers" — each non-green one is named in an open blocker (cannot run locally: needs
 * staging, no browser). Only for a closing written after the task snapshot.
 */
export function gateCloseViolations(dataDir, worktree, config, taskDir, { caller = worktree } = {}) {
  const stages = readTaskFile(taskDir, 'STAGES.md')
  if (stages === null) return []
  const block = lastForceBlock(stages)
  if (!block || !CLOSED_WORD.test(block.heading)) return []
  if (baselineInfo(dataDir, taskDir).lines.has(fingerprint(block.heading))) return []
  const skips = forceSkips(taskDir)
  const failing = gateStatus(dataDir, worktree, config, skips).filter((gate) => !gateAccepted(gate))
  if (!failing.length) return []
  const withBlockers = WITH_BLOCKERS.test(block.heading)
  const blockers = openBlockers(block, blockerGate(dataDir, taskDir)).join('\n').toLowerCase()
  // Where the gates were judged, when that is not the caller's worktree; why a run there may not have counted.
  const where = worktree === caller ? 'on the current HEAD' : `on the HEAD of the task's worktree \`${worktree}\``
  const { dirty } = treeState(worktree)
  const unrecorded = dirty.length ? ` Tracked files there differ from HEAD (${pathList(dirty)}): ${UNRECORDED}, so commit or stash them first.` : ''
  // The commands of the message run where the gates are judged: a run in the caller's worktree records for the caller's tree.
  const there = (command) => (worktree === caller ? command : `cd '${worktree}' && ${command}`)
  return failing
    .filter((gate) => !withBlockers || !(blockers.includes(gate.name.toLowerCase()) || blockers.includes(gate.command.toLowerCase())))
    .map((gate) => ({
      rule: 'ci-gate',
      id: gate.name,
      message:
        gate.status === 'red'
          ? `CI gate ${describe(gate)} ${where}. A red gate is a fix-loop finding: fix it and run it again (\`${there(`node ${RUN_CHECK} -- ${gate.command}`)}\`). ` +
            `${mentioned(skips, gate) ? 'The `skip:` line of the Force block does not cover it: a skip stands only for a gate that cannot run here, not for one that ran red. ' : ''}` +
            'If the fix-loop cannot make it green — a blocker B<n> that names the gate, and closing as "completed with blockers".'
          : `CI gate ${describe(gate)} ${where}.${unrecorded} Run it before closing: \`${there(`node ${RUN_CHECK} -- ${gate.command}`)}\` (or \`${there(`node ${fileURLToPath(import.meta.url)} --run`)}\`). ` +
            'If it cannot run here — `skip: <gate> — <reason> <date>` in the Force block, or a blocker B<n> with the reason and closing as "completed with blockers".',
    }))
}

function main(args) {
  const state = readPipelineState(process.cwd())
  if (!state) {
    console.error('ci-gates: there is no pipeline.config.md here')
    process.exit(2)
  }
  // The skips written in the Force block of the current task(s) count here too, as at the close.
  const skips = state.tasks.filter((task) => task.current).flatMap((task) => forceSkips(task.dir))
  let gates = gateStatus(pluginDataDir(), state.worktree, state.config, skips)
  if (!gates.length) {
    console.log('No CI gates in the config (a "## CI gates" table or e2e / smoke lines in Commands).')
    process.exit(0)
  }
  if (args.includes('--run')) {
    for (const gate of gates.filter((candidate) => !gateAccepted(candidate))) {
      console.log(`\n▶ ${gate.name}: ${gate.command}`)
      spawnSync(process.execPath, [RUN_CHECK, '--', gate.command], { cwd: state.worktree, stdio: 'inherit' })
    }
    gates = gateStatus(pluginDataDir(), state.worktree, state.config, skips)
  }
  for (const gate of gates) console.log(`- ${gate.status === 'green' ? '✅' : gate.status === 'skipped' ? '⏭' : '✗'} ${describe(gate)}`)
  const { dirty } = treeState(state.worktree)
  if (dirty.length && !gates.every(gateAccepted)) console.log(`Tracked files differ from HEAD (${pathList(dirty)}): ${UNRECORDED}. Commit or stash them, then run again.`)
  process.exit(gates.every(gateAccepted) ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
