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
 * files did not change either before or during the run. A green gate is exit code 0 on the current HEAD's tree: a run before
 * the last fix does not count towards closing.
 *
 *   node ci-gates.mjs          # the repo's gates and their state on HEAD
 *   node ci-gates.mjs --run    # run the non-green ones through run-check.mjs and show the result
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { baselineInfo, fingerprint, lastForceBlock, openBlockers } from './journal-check.mjs'
import { pluginDataDir, readDataFiles, readPipelineState } from './hooks/pipeline-state.mjs'
import { CI_GATES_HEADING, CLOSED_WORD, NO_GATE_COMMAND, WITH_BLOCKERS } from './markers.mjs'

const RUN_CHECK = join(dirname(fileURLToPath(import.meta.url)), 'run-check.mjs')

export const normalize = (command) => command.replace(/\s+/g, ' ').trim()

/** Gates from the config: `[{ name, command }]`. Empty — the project has no gates, the rule stays silent. */
export function gateCommands(config) {
  const table = gateTable(config)
  if (table.length) return table
  const gates = []
  for (const [, key, raw] of config.matchAll(/^\s*-\s*\**(e2e|smoke)\**(?:\s*\([^)\n]*\))?\s*:\s*(.+)$/gim)) {
    const command = raw.match(/`([^`]+)`/)?.[1] ?? raw.split(/\s+#|\s+\/\s+|\s+\(|\s+\|/)[0]
    if (!command || NO_GATE_COMMAND.test(command.trim())) continue
    gates.push({ name: key.toLowerCase(), command: normalize(command) })
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
    gates.push({ name, command: normalize(command) })
  }
  return dedupe(gates)
}

const dedupe = (gates) => gates.filter((gate, index) => gates.findIndex((other) => other.command === gate.command) === index)

/** The HEAD tree and whether tracked files are clean: untracked ones (the task directory, frames) do not get in the way of a run. */
export function treeState(cwd) {
  try {
    const run = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return { tree: run('rev-parse', 'HEAD^{tree}'), clean: run('status', '--porcelain', '--untracked-files=no') === '' }
  } catch {
    return { tree: null, clean: false }
  }
}

/** The records file name relative to a data directory (not a slice of the full path: `CLAUDE_PLUGIN_DATA` may end with a slash). */
function recordsName(worktree) {
  let real = worktree
  try {
    real = realpathSync(worktree)
  } catch {
    // the directory is gone — keyed by the original path
  }
  return join('gates', `${createHash('sha1').update(real).digest('hex').slice(0, 16)}.json`)
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

/**
 * The state of each gate on the current HEAD: green | red | stale (the run was on another tree) | missing.
 * A run with a tail of flags counts too: `… playwright test --grep-invert "snapshot"` closes `… playwright test`.
 */
export function gateStatus(dataDir, worktree, config) {
  const gates = gateCommands(config)
  if (!gates.length) return []
  const { tree } = treeState(worktree)
  const records = Object.entries(gateRecords(dataDir, worktree))
  return gates.map((gate) => {
    const runs = records.filter(([command]) => command === gate.command || command.startsWith(`${gate.command} `)).map(([, record]) => record)
    const here = runs.filter((record) => tree && record.tree === tree).sort((a, b) => (a.at < b.at ? 1 : -1))
    const status = here.length ? (here[0].code === 0 ? 'green' : 'red') : runs.length ? 'stale' : 'missing'
    return { ...gate, status, code: here[0]?.code ?? null }
  })
}

// Gate descriptions go into hook messages (English) and into the run digest (task language); the default is English.
const STATUS_TEXT = {
  en: { green: 'green', red: 'red', stale: 'ran on another tree', missing: 'never ran' },
  ru: { green: 'зелёный', red: 'красный', stale: 'гонялся на другом дереве', missing: 'не запускался' },
}
export const describe = (gate, language = 'en') =>
  language === 'ru'
    ? `«${gate.name}» (\`${gate.command}\`) — ${STATUS_TEXT.ru[gate.status]}${gate.status === 'red' ? `, код ${gate.code}` : ''}`
    : `"${gate.name}" (\`${gate.command}\`) — ${STATUS_TEXT.en[gate.status]}${gate.status === 'red' ? `, code ${gate.code}` : ''}`

/**
 * Closing a force run with a non-green gate. "Completed" — only when all gates are green on the current tree;
 * "completed with blockers" — each non-green one is named in an open blocker (cannot run locally: needs
 * staging, no browser). Only for a closing written after the task snapshot.
 */
export function gateCloseViolations(dataDir, worktree, config, taskDir) {
  const stagesPath = join(taskDir, 'STAGES.md')
  if (!existsSync(stagesPath)) return []
  const block = lastForceBlock(readFileSync(stagesPath, 'utf8'))
  if (!block || !CLOSED_WORD.test(block.heading)) return []
  if (baselineInfo(dataDir, taskDir).lines.has(fingerprint(block.heading))) return []
  const failing = gateStatus(dataDir, worktree, config).filter((gate) => gate.status !== 'green')
  if (!failing.length) return []
  const withBlockers = WITH_BLOCKERS.test(block.heading)
  const blockers = openBlockers(block.body).join('\n').toLowerCase()
  return failing
    .filter((gate) => !withBlockers || !(blockers.includes(gate.name.toLowerCase()) || blockers.includes(gate.command.toLowerCase())))
    .map((gate) => ({
      rule: 'ci-gate',
      id: gate.name,
      message:
        `CI gate ${describe(gate)} on the current HEAD. Run it before closing: \`node ${RUN_CHECK} -- ${gate.command}\` (or \`node ${fileURLToPath(import.meta.url)} --run\`). ` +
        'A red gate is a fix-loop finding; if it cannot run locally — a blocker B<n> with the reason and closing as "completed with blockers".',
    }))
}

function main(args) {
  const state = readPipelineState(process.cwd())
  if (!state) {
    console.error('ci-gates: there is no pipeline.config.md here')
    process.exit(2)
  }
  let gates = gateStatus(pluginDataDir(), state.worktree, state.config)
  if (!gates.length) {
    console.log('No CI gates in the config (a "## CI gates" table or e2e / smoke lines in Commands).')
    process.exit(0)
  }
  if (args.includes('--run')) {
    for (const gate of gates.filter((candidate) => candidate.status !== 'green')) {
      console.log(`\n▶ ${gate.name}: ${gate.command}`)
      spawnSync(process.execPath, [RUN_CHECK, '--', gate.command], { cwd: state.worktree, stdio: 'inherit' })
    }
    gates = gateStatus(pluginDataDir(), state.worktree, state.config)
  }
  for (const gate of gates) console.log(`- ${gate.status === 'green' ? '✅' : '✗'} ${describe(gate)}`)
  process.exit(gates.every((gate) => gate.status === 'green') ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
