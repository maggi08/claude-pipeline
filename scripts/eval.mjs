#!/usr/bin/env node
/**
 * Regression runs of the plugin agents on fixtures with planted defects.
 *
 *   node scripts/eval.mjs                          # all cases, one run each
 *   node scripts/eval.mjs dead-code-orphan i18n-hardcode
 *   node scripts/eval.mjs --runs 3 --model i18n-sweep=haiku i18n-hardcode
 *   node scripts/eval.mjs --list
 *
 * A rule in a skill is worth nothing until it is verified that the agent with it catches its class of defects —
 * and that the next skill edit did not break that. A case is evals/cases/<name>/:
 *   case.json   agent, prompt, expectations
 *   base/       the initial tree (commit "base")
 *   stages/N/   layers committed one by one on top of base ("stage N")
 *   working/    the layer that stays uncommitted (the diff of the current stage)
 * A file whose content is `__DELETE__` in a layer deletes the file.
 *
 * Expectations in case.json:
 *   expect / forbid   regexps over the report in checks/ (plus the final message for expect)
 *   files             [{ path, pattern, why }] — the file (or all files of a directory) must match after the run
 *   filesForbid       [{ path, pattern, why }] — and must NOT match
 *   unchanged         [path] — files the agent must not touch
 *   noCommits         the agent makes no commits (for maker agents: committing is the orchestrator's job)
 *   maxSummaryLines   cap on the final message length — it goes whole into the main context
 *   requireReport     false — the agent writes no report to checks/ (a maker or a reference agent)
 *   forbidSummary     regexps that must not appear in the final message
 *   mcp               ["chrome-devtools"] — plugin MCP servers the case needs (the rest are disabled).
 *                     A server missing from the plugin's .mcp.json makes the case skipped, not failed.
 *
 * A routing case (`"kind": "routing"`, no `agent`) checks not how a skill works but whether the model
 * invokes it on an ordinary phrase: the prompt goes to the main session with the plugin, the Skill calls
 * (and Agent calls with a plugin subagent_type) are taken from the event stream, and the run is cut after a couple of turns.
 *   expectSkill       the name of the plugin skill/agent that must be invoked first
 *   forbidSkills      [name] — must not be invoked at all
 *   base              path to the base/ of another case (a routing case usually has no tree of its own)
 * The lexical approximation of the same is scripts/routing.mjs (free, in CI); here it is the model itself.
 *
 * --model <agent>=<model> runs the cases on a copy of the plugin where the agent's `model:` in the
 * frontmatter is rewritten — this is how models are compared on the same cases. Which model actually ran
 * is visible in modelUsage of the claude JSON output and printed in the summary. --runs N repeats each case:
 * the model is nondeterministic, one run is an anecdote, not a measurement.
 *
 * A run uses the working copy of the plugin (--plugin-dir) without user settings
 * (--setting-sources project), so the installed plugin version does not affect the result.
 * Every run is a real model call (subscription limit or API-key money): not in CI,
 * but before a release where agents changed.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CASES = join(ROOT, 'evals/cases')
const SOURCE_PLUGIN = join(ROOT, 'plugins/stage-pipeline')
const RESULTS = join(ROOT, 'evals/.results')
// The fixtures' task_path is tasks/, not .claude/tasks/: writes to .claude/ are protected and rejected in dontAsk mode.
const CHECKS = 'tasks/EVAL-1/checks'

const { names, runs, overrides } = parseArgs(process.argv.slice(2))
const all = readdirSync(CASES).filter((name) => existsSync(join(CASES, name, 'case.json')))
if (names.includes('--list')) {
  for (const name of all) console.log(`${name} [${readCase(name).agent ?? readCase(name).kind}] — ${readCase(name).why}`)
  process.exit(0)
}
const selected = names.length ? names : all
const unknown = selected.filter((name) => !all.includes(name))
if (unknown.length) {
  console.error(`No such cases: ${unknown.join(', ')}. List: --list`)
  process.exit(2)
}

const plugin = preparePlugin(overrides)
const label = Object.entries(overrides).map(([agent, model]) => `${agent}=${model}`).join(',') || 'as-is'

function parseArgs(argv) {
  const result = { names: [], runs: 1, overrides: {} }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') result.runs = Number(argv[++i])
    else if (argv[i] === '--model') {
      const [agent, model] = (argv[++i] ?? '').split('=')
      if (!agent || !model) fail('--model expects <agent>=<model>, e.g. i18n-sweep=haiku')
      result.overrides[agent] = model
    } else result.names.push(argv[i])
  }
  if (!Number.isInteger(result.runs) || result.runs < 1) fail('--runs expects an integer ≥ 1')
  return result
}

function fail(message) {
  console.error(message)
  process.exit(2)
}

function readCase(name) {
  return JSON.parse(readFileSync(join(CASES, name, 'case.json'), 'utf8'))
}

/** A copy of the plugin with `model:` rewritten for the agents from --model; without overrides it is the plugin itself. */
function preparePlugin(overrides) {
  if (!Object.keys(overrides).length) return SOURCE_PLUGIN
  const copy = mkdtempSync(join(tmpdir(), 'stage-pipeline-plugin-'))
  cpSync(SOURCE_PLUGIN, copy, { recursive: true })
  for (const [agent, model] of Object.entries(overrides)) {
    const path = join(copy, 'agents', `${agent}.md`)
    if (!existsSync(path)) fail(`no agent ${agent}`)
    const text = readFileSync(path, 'utf8')
    if (!/^model: .*$/m.test(text)) fail(`agent ${agent} has no model field in its frontmatter`)
    writeFileSync(path, text.replace(/^model: .*$/m, `model: ${model}`))
  }
  return copy
}

/**
 * --mcp-config with only the servers the case asked for; ${CLAUDE_PLUGIN_ROOT} is expanded by hand.
 * The server name is unique per run (but contains the original — the agent's ToolSearch looks it up by it): Claude Code
 * caches needs-auth by server name, and one failed run would otherwise poison all the following ones.
 */
function mcpConfig(servers, repo) {
  const declared = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8'))
  const suffix = relative(tmpdir(), repo).replace(/\W/g, '').slice(-8)
  const picked = Object.fromEntries(servers.map((name) => [`${name}-eval-${suffix}`, declared[name]]))
  const path = join(repo, '..', `${suffix}-mcp.json`)
  writeFileSync(path, JSON.stringify({ mcpServers: picked }).replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin))
  return { path, tools: Object.keys(picked).map((name) => `mcp__${name}`) }
}

function skipReason(spec) {
  const declared = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8'))
  const missing = (spec.mcp ?? []).filter((name) => !declared[name])
  return missing.length ? `the plugin's .mcp.json has no ${missing.join(', ')}` : null
}

const git = (cwd, ...cmd) => execFileSync('git', cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

// A file is its content; a directory is all its files in a row (for "nowhere in src/ is there a second copy").
function readTree(path) {
  if (!existsSync(path)) return ''
  return statSync(path).isDirectory() ? walk(path).map((file) => readFileSync(file, 'utf8')).join('\n') : readFileSync(path, 'utf8')
}

function applyLayer(layer, repo) {
  for (const file of walk(layer)) {
    const target = join(repo, relative(layer, file))
    if (readFileSync(file, 'utf8').trim() === '__DELETE__') rmSync(target, { force: true })
    else {
      mkdirSync(dirname(target), { recursive: true })
      cpSync(file, target)
    }
  }
}

function buildRepo(caseDir, basePath = 'base') {
  const repo = mkdtempSync(join(tmpdir(), 'stage-pipeline-eval-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'eval@example.com')
  git(repo, 'config', 'user.name', 'eval')
  cpSync(join(caseDir, basePath), repo, { recursive: true })
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  git(repo, 'checkout', '-qb', 'feature')
  const stagesDir = join(caseDir, 'stages')
  if (existsSync(stagesDir)) {
    for (const stage of readdirSync(stagesDir).sort((a, b) => Number(a) - Number(b))) {
      applyLayer(join(stagesDir, stage), repo)
      git(repo, 'add', '-A')
      git(repo, 'commit', '-qm', `stage ${stage}`)
    }
  }
  if (existsSync(join(caseDir, 'working'))) applyLayer(join(caseDir, 'working'), repo)
  return repo
}

/** Plugin skill and agent calls in order from the stream-json stream: `stage-pipeline:root-cause` → `root-cause`. */
function invokedSkills(events) {
  const names = []
  for (const event of events) {
    for (const block of event.type === 'assistant' ? event.message?.content ?? [] : []) {
      if (block.type !== 'tool_use') continue
      const raw =
        block.name === 'Skill' ? block.input?.skill ?? block.input?.command : ['Agent', 'Task'].includes(block.name) ? block.input?.subagent_type : null
      const name = raw && String(raw).replace(/^\/?(stage-pipeline:)?/, '')
      // Built-in agents (Explore, general-purpose) are not a route into the plugin: only the plugin's skills and agents count.
      if (name && PLUGIN_NAMES.has(name)) names.push(name)
    }
  }
  return names
}

const PLUGIN_NAMES = new Set([
  ...readdirSync(join(SOURCE_PLUGIN, 'skills')),
  ...readdirSync(join(SOURCE_PLUGIN, 'agents')).map((file) => file.replace(/\.md$/, '')),
])

function runRouting(name, attempt, spec) {
  const repo = buildRepo(join(CASES, name), spec.base)
  const started = Date.now()
  const result = spawnSync(
    'claude',
    [
      '-p', spec.prompt,
      '--plugin-dir', plugin,
      '--setting-sources', 'project',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'dontAsk',
      // Skill is allowed: a permission denial would replace the model's choice. A run needs nothing past a couple of turns.
      '--allowedTools', 'Skill', 'Read', 'Grep', 'Glob',
      '--max-turns', String(spec.maxTurns ?? 3),
      '--max-budget-usd', String(spec.budgetUsd ?? 0.3),
    ],
    { cwd: repo, encoding: 'utf8', timeout: (spec.timeoutSec ?? 180) * 1000 },
  )
  const seconds = Math.round((Date.now() - started) / 1000)
  const events = (result.stdout ?? '').split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
  const final = events.filter((event) => event.type === 'result').pop() ?? {}
  const invoked = invokedSkills(events)
  const failures = []
  // A failed run (session limit, API error) invokes no skills — without this check it would count toward forbidSkills.
  // A cut by --max-turns / --max-budget-usd is the normal end of a routing case: the choice has already been made by then.
  const stoppedByLimit = /^error_max_(turns|budget)/.test(final.subtype ?? '')
  if (!events.length || !Object.keys(final.modelUsage ?? {}).length || (final.is_error && !stoppedByLimit)) {
    failures.push(`claude did not run: code ${result.status}, ${String(final.result ?? result.stderr ?? '').trim().slice(0, 200)}`)
  }
  if (spec.expectSkill && invoked[0] !== spec.expectSkill) failures.push(`first invoked: ${invoked[0] ?? 'no skill'}, expected ${spec.expectSkill}`)
  for (const forbidden of spec.forbidSkills ?? []) {
    if (invoked.includes(forbidden)) failures.push(`${forbidden} was invoked but must not be`)
  }

  mkdirSync(RESULTS, { recursive: true })
  const saved = join(RESULTS, `${name}--${label.replace(/[^\w=,-]/g, '_')}--${attempt}.md`)
  writeFileSync(
    saved,
    `# ${name} (${label}, run ${attempt})\n\nInvoked: ${invoked.join(' → ') || '—'} · end: ${final.subtype ?? '—'}\n\n` +
      `## Failures\n\n${failures.map((f) => `- ${f}`).join('\n') || '—'}\n\n## Answer\n\n${final.result ?? ''}\n`,
  )
  rmSync(repo, { recursive: true, force: true })
  return { failures, seconds, cost: final.total_cost_usd ?? 0, models: Object.keys(final.modelUsage ?? {}), saved }
}

function runCase(name, attempt) {
  const caseDir = join(CASES, name)
  const spec = readCase(name)
  if (spec.kind === 'routing') return runRouting(name, attempt, spec)
  const repo = buildRepo(caseDir)
  const snapshot = Object.fromEntries((spec.unchanged ?? []).map((path) => [path, readIfExists(join(repo, path))]))
  const commitsBefore = git(repo, 'rev-list', '--count', 'HEAD').trim()
  const prompt = spec.requireReport === false ? spec.prompt : `${spec.prompt}\n\nSave the report to ${CHECKS}/ following the report naming convention.`

  const servers = spec.mcp ?? []
  const mcp = servers.length ? mcpConfig(servers, repo) : null
  const mcpArgs = mcp ? ['--mcp-config', mcp.path] : []
  const started = Date.now()
  const result = spawnSync(
    'claude',
    [
      '-p', prompt,
      '--agent', `stage-pipeline:${spec.agent}`,
      '--plugin-dir', plugin,
      '--setting-sources', 'project',
      '--strict-mcp-config', ...mcpArgs,
      '--no-session-persistence',
      '--output-format', 'json',
      '--permission-mode', 'dontAsk',
      '--allowedTools', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'ToolSearch',
      'Bash(git *)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(grep *)', 'Bash(rg *)', 'Bash(find *)', 'Bash(wc *)', 'Bash(mkdir -p *)',
      ...(mcp?.tools ?? []),
      '--max-budget-usd', String(spec.budgetUsd ?? 1),
    ],
    // In -p, servers from --mcp-config connect asynchronously: without this the agent manages to decide
    // there are no tools before the server is up.
    { cwd: repo, encoding: 'utf8', timeout: (spec.timeoutSec ?? 600) * 1000, env: { ...process.env, MCP_CONNECTION_NONBLOCKING: 'false' } },
  )
  const seconds = Math.round((Date.now() - started) / 1000)

  let output = {}
  try {
    output = JSON.parse(result.stdout ?? '')
  } catch {
    // not JSON — claude crashed before output; the reason is in stderr
  }
  const summary = output.result ?? ''
  const cost = output.total_cost_usd ?? 0
  const models = Object.keys(output.modelUsage ?? {})

  // The file name is the skill convention's business; the case only checks that a report was saved at all.
  const checksDir = join(repo, CHECKS)
  const report = existsSync(checksDir)
    ? walk(checksDir).filter((file) => file.endsWith('.md')).map((file) => readFileSync(file, 'utf8')).join('\n')
    : ''
  const haystack = `${report}\n${summary}`
  const failures = []
  if (result.status !== 0 || output.is_error) failures.push(`claude: code ${result.status}, ${output.subtype ?? ''} ${(result.stderr ?? '').trim().slice(0, 300)}`)
  if (!report && spec.requireReport !== false) failures.push(`report not saved to ${CHECKS}/`)
  for (const expectation of spec.expect ?? []) {
    if (!new RegExp(expectation.pattern, 'i').test(haystack)) failures.push(`not found: ${expectation.why} (/${expectation.pattern}/)`)
  }
  for (const expectation of spec.forbid ?? []) {
    if (new RegExp(expectation.pattern, 'i').test(report)) failures.push(`extra in the report: ${expectation.why} (/${expectation.pattern}/)`)
  }
  for (const expectation of spec.forbidSummary ?? []) {
    if (new RegExp(expectation.pattern, 'i').test(summary)) failures.push(`extra in the message: ${expectation.why} (/${expectation.pattern}/)`)
  }
  for (const check of spec.files ?? []) {
    if (!new RegExp(check.pattern, 'i').test(readTree(join(repo, check.path)))) failures.push(`${check.path}: ${check.why} (/${check.pattern}/)`)
  }
  for (const check of spec.filesForbid ?? []) {
    if (new RegExp(check.pattern, 'i').test(readTree(join(repo, check.path)))) failures.push(`${check.path}: ${check.why} (/${check.pattern}/)`)
  }
  for (const [path, before] of Object.entries(snapshot)) {
    if (readIfExists(join(repo, path)) !== before) failures.push(`${path} was changed — the agent must not touch it`)
  }
  if (spec.noCommits && git(repo, 'rev-list', '--count', 'HEAD').trim() !== commitsBefore) failures.push('the agent made a commit — the orchestrator commits')
  const summaryLines = summary.trim().split('\n').length
  if (spec.maxSummaryLines && summaryLines > spec.maxSummaryLines) failures.push(`summary is ${summaryLines} lines against a cap of ${spec.maxSummaryLines} — it bloats the main context`)

  mkdirSync(RESULTS, { recursive: true })
  const saved = join(RESULTS, `${name}--${label.replace(/[^\w=,-]/g, '_')}--${attempt}.md`)
  const denials = (output.permission_denials ?? []).map((denial) => `- ${denial.tool_name}: ${JSON.stringify(denial.tool_input).slice(0, 200)}`)
  writeFileSync(
    saved,
    `# ${name} (${label}, run ${attempt})\n\nModels: ${models.join(', ') || '—'} · $${cost.toFixed(3)} · ${seconds}s\n\n` +
      `## Failures\n\n${failures.map((f) => `- ${f}`).join('\n') || '—'}\n\n## Permission denials\n\n${denials.join('\n') || '—'}\n\n` +
      `## Agent report\n\n${report || '(none)'}\n\n## Final message\n\n${summary}\n`,
  )
  rmSync(repo, { recursive: true, force: true })
  return { failures, seconds, cost, models, saved }
}

const table = []
for (const name of selected) {
  const skip = skipReason(readCase(name))
  if (skip) {
    console.log(`⏭ ${name} — skipped: ${skip}`)
    continue
  }
  const row = { name, passed: 0, cost: 0, seconds: 0, models: new Set() }
  for (let attempt = 1; attempt <= runs; attempt++) {
    process.stdout.write(`… ${name} #${attempt}`)
    const { failures, seconds, cost, models, saved } = runCase(name, attempt)
    if (!failures.length) row.passed++
    row.cost += cost
    row.seconds += seconds
    for (const model of models) row.models.add(model)
    process.stdout.write(`\r${failures.length ? '✘' : '✔'} ${name} #${attempt} (${seconds}s, $${cost.toFixed(3)}, ${models.join('+') || '?'})\n`)
    for (const failure of failures) console.log(`    ${failure}`)
    if (failures.length) console.log(`    full output: ${relative(ROOT, saved)}`)
  }
  table.push(row)
}

console.log(`\n## ${label}, runs per case: ${runs}\n`)
console.log('| Case | Passed | Models | $ per run | s per run |')
console.log('|---|---|---|---|---|')
for (const row of table) {
  console.log(`| ${row.name} | ${row.passed}/${runs} | ${[...row.models].join(', ')} | ${(row.cost / runs).toFixed(3)} | ${Math.round(row.seconds / runs)} |`)
}
const total = table.reduce((sum, row) => sum + row.cost, 0)
console.log(`\nTotal: ${table.reduce((s, r) => s + r.passed, 0)}/${table.length * runs} runs, $${total.toFixed(2)}`)
if (plugin !== SOURCE_PLUGIN) rmSync(plugin, { recursive: true, force: true })
process.exit(table.every((row) => row.passed === runs) ? 0 : 1)
