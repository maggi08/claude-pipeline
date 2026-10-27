#!/usr/bin/env node
/**
 * Regression runs of the plugin agents on synthetic projects with planted problems.
 *
 *   node scripts/eval.mjs                          # all cases, three runs each (the model is nondeterministic: one run is an anecdote)
 *   node scripts/eval.mjs dead-code-orphan i18n-hardcode
 *   node scripts/eval.mjs --runs 1 --model i18n-sweep=haiku i18n-hardcode
 *   node scripts/eval.mjs --list
 *   node scripts/eval.mjs --lint                   # free, no model: builds every case and runs the leak lint (CI runs it through validate.mjs)
 *   node scripts/eval.mjs --ref stage-pipeline--v0.18.0 devtools-verify-console   # the plugin as of a git tag
 *   node scripts/eval.mjs --ablate skill:pro-review pro-review-clean-ac            # the plugin without a skill (`skill:<n>`), as a bare model (`agent:<n>`: the agent keeps its
 *                                                                                  # frontmatter and loses its body, its skill goes too), or without both (<n>; the agent then cannot launch)
 *   node scripts/eval.mjs --variant no-devtools-verify stage-check-ui-stage         # the plugin with the edit list of evals/cases/<case>/variants/<name>.json applied (one case; `provenFailing.on` = `variant:<name>`)
 *   node scripts/eval.mjs --ref <tag> --record-failing <new-case>                   # writes `provenFailing` into the case
 *   node scripts/eval.mjs --budget-usd 20 --budget-since 2026-10-25T00:00:00Z       # skip runs that would pass the lane budget
 *
 * A rule in a skill is worth nothing until it is verified that the agent with it catches its class of problems —
 * and that the next skill edit did not break that. A case is evals/cases/<name>/:
 *   case.json   agent, prompt, identity, expectations
 *   base/       the initial tree (commit "chore: initial import")
 *   stages/N/   layers committed one by one on top of base
 *   working/    the layer that stays uncommitted (the diff of the current stage)
 *   stubs/      local stdio MCP servers a case points `mcpServers` at (copied next to the repo; `{stubs}` in a command is that copy)
 * `serve: { dir }` in case.json — the repo's `dir` is served on a free port of 127.0.0.1 by a static server of the harness (started before the run with its cwd inside
 * the repo, stopped by its PID after it; `/api/*` answers 404). `{port}` in the tree and in the prompt becomes that port, so the dev url reaches the agent through the
 * fixture's pipeline config like a real one.
 * A file whose content is `__DELETE__` in a layer deletes the file.
 *
 * Blind. The agent must not be able to tell it is tested. Every case is dressed as a project of its own: the repo directory, the ticket, the git
 * author and the commit messages come from `identity` in case.json (`repo`, `ticket`, `user`, `email`, `branch`, `commits: { base, stages: { "1": "…" } }`)
 * or, when absent, from a deterministic default by case name. Before any model call the leak lint scans the built tree (paths and contents),
 * every prompt (including the thin-parent one), the cwd and work dir paths, the plugin path, the git history and the MCP config for the words
 * eval / fixture / planted / defect / judge / rubric / benchmark / candidate / кейс / фикстур (whole words, so «evaluate» does not fire) and
 * aborts the case on a hit. `leakAllow: [{ word, why }]` in case.json allows a word for one case.
 *
 * Production-faithful. The plugin under test is copied to a neutral temp directory and loaded with --plugin-dir; MCP servers from --mcp-config
 * are named plugin_stage-pipeline_<server>, so tool names equal production (mcp__plugin_stage-pipeline_<server>__*); --allowedTools / --disallowedTools
 * come from permissions/base.json (default groups) through scripts/permission-profile.mjs, the logic permissions.mjs uses, so `node` (floor-guard) is allowed;
 * an agent case runs as a real subagent under a thin haiku parent session (stream-json, --include-hook-events), so PreToolUse(Agent), SubagentStart,
 * SubagentStop and agent-guard fire as in production. The graded summary is the subagent's own result (the Agent tool_result), not the parent's retelling,
 * and the subagent's tool calls feed the trace graders. The plugin data directory is a fresh temp one per run (STAGE_PIPELINE_DATA_DIR: Claude Code overwrites
 * CLAUDE_PLUGIN_DATA for hooks, so that variable alone never reached them); nothing of the live data directory is read or written.
 *
 * Expectations in case.json (deterministic graders are the floor):
 *   expect / forbid       regexps over the report in checks/ (plus the final message for expect)
 *   forbidSummary         regexps that must not appear in the final message
 *   findings              [{ severity: "major|critical|minor|any", file: <regex>, line?: <n or regex>, why }] — one report line in the ledger form
 *                         (a list item, a table row or an id/severity-led line) with the severity and the file (and `:line`); a negated mention
 *                         («formatTime — no duplicates found») is not a finding, and neither is a line under «Deliberately kept» / «Could not verify»
 *   findingsForbid        the same form, and the case fails when such a line exists (use it instead of a text regexp for «X must not be flagged»)
 *   files / filesForbid   [{ path, pattern, why }] — the file (or all files of a directory) must / must not match after the run
 *   unchanged             [path] — files the agent must not touch
 *   trace                 [{ tool, input?: <regex>, min?, max?, includeDenied?, why }] — calls the subagent made (a denied call does not count)
 *   traceForbid           [{ tool, input?, why }] — calls it must not make
 *   screenshotsRead       true | { min } — every screenshot taken was later opened with Read
 *   hooks                 [{ event, min?, why }] — hooks that must have started: `PreToolUse:Agent`, `SubagentStop:devtools-verify` (or just `SubagentStop`)
 *   noCommits             the agent makes no commits (for maker agents: committing is the orchestrator's job)
 *   maxSummaryLines       cap on the final message length — it goes whole into the main context
 *   thread                "main" — the agent is the session itself (`claude -p <prompt> --agent stage-pipeline:<agent>`, its own frontmatter model) instead of a subagent under the thin
 *                         parent. For agents that no hook of the plugin targets (hooks.json: agent-guard sits on the parent's Agent call, SubagentStop only on devtools-verify) and whose
 *                         prompts carry long drafts: the haiku parent retold, cut and translated such prompts in 7 of 12 runs, so the run measured the parent, not the agent.
 *   requireReport         false — the agent writes no report to checks/ (a maker or a reference agent)
 *   mcp                   ["chrome-devtools"] — plugin MCP servers the case needs (the rest are disabled).
 *                         A server missing from the plugin's .mcp.json (and from `mcpServers`) makes the case skipped, not failed.
 *   mcpServers            { figma: { command, args, env } } — replaces a server with a local stdio command
 * A non-routing case needs at least one forbid-family grader (validate.mjs checks).
 *
 * A routing case (`"kind": "routing"`, no `agent`) checks not how a skill works but whether the model
 * invokes it on an ordinary phrase: the prompt goes to the main session with the plugin, the Skill calls
 * (and Agent calls with a plugin subagent_type) are taken from the event stream, and the run is cut after a couple of turns.
 *   expectSkill       the name of the plugin skill/agent that must be invoked first
 *   forbidSkills      [name] — must not be invoked at all
 *   base              path to the base/ of another case (a routing case usually has no tree of its own; it borrows that case's identity)
 * The lexical approximation of the same is scripts/routing.mjs (free, in CI); here it is the model itself.
 *
 * New-case rule: a case added after 0494f32 carries `provenFailing` in case.json — its failing run on the previous tag (--ref) or with
 * the skill/agent ablated (--ablate), written by --record-failing with `runs`, `failed` and `caseHash` (the content of the case); validate.mjs fails a case
 * without it, with failed !== runs, or whose hash no longer matches. A `--variant` is a hand-made edit a model may get around, so its record is a rate instead:
 * the counts are those of the whole recording invocation (never a picked run), `--runs 3` at least with 2 or more failing, and `detection` ("2/3") says so. A harness failure (an MCP server not connected, an allowed tool denied, a server that did not start)
 * is marked `W-` in the ledger and never recorded as a grade.
 * A `trace` grader takes `before: <tool regex>`: only the calls ahead of the first call of that tool count.
 *
 * Statistics. Every run appends a row to evals/ledger.tsv (gitignored, append-only): timestamp, invocation, case, attempt, plugin ref/version/SHA,
 * `claude --version`, resolved models (from modelUsage), a hit/miss mark per expectation (E expect, F forbid, S forbidSummary, N findings, M findingsForbid,
 * P files, Q filesForbid, U unchanged, T trace, V traceForbid, X screenshots, H hooks, C commits, L length; `+` hit, `-` miss), pass, cost, seconds.
 * Results of one invocation go to evals/.results/<invocation>/ and are never overwritten. The total cost is printed. --budget-usd <x> sums the
 * ledger cost (since --budget-since <ts>, else the whole ledger) and skips a run when spent + the case's mean past cost (else its budgetUsd) would pass x;
 * the skipped runs are listed with their estimates and the exit code is 3.
 *
 * Every run is a real model call (subscription limit or API-key money): not in CI (only --lint is), but before a release where agents changed.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { wantedFor, loadProfile } from '../plugins/stage-pipeline/scripts/permission-profile.mjs'
import {
  CASES, ROOT, SOURCE_PLUGIN, STATIC_SERVER, appendLedger, buildWorld, caseHash, decisionSettings, git, gradeAgent, gradeDecision, harnessProblems, hookEvents, lintCase, lintWorld, meanCost, missingServers, parseStream, readCase, readLedger,
  spentSince, subagentRun, toolCalls, walk,
} from './eval-lib.mjs'

const RESULTS = join(ROOT, 'evals/.results')

const opts = parseArgs(process.argv.slice(2))
const all = readdirSync(CASES).filter((name) => existsSync(join(CASES, name, 'case.json')))

function parseArgs(argv) {
  const result = { names: [], runs: 3, overrides: {}, flags: new Set() }
  const value = (flag) => argv[++i] ?? fail(`${flag} expects a value`)
  let i = 0
  for (; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--runs') result.runs = Number(value(arg))
    else if (arg === '--model') {
      const [agent, model] = value(arg).split('=')
      if (!agent || !model) fail('--model expects <agent>=<model>, e.g. i18n-sweep=haiku')
      result.overrides[agent] = model
    } else if (arg === '--ref') result.ref = value(arg)
    else if (arg === '--ablate') result.ablate = value(arg)
    else if (arg === '--variant') result.variant = value(arg)
    else if (arg === '--budget-usd') result.budget = Number(value(arg))
    else if (arg === '--budget-since') result.budgetSince = value(arg)
    else if (['--list', '--lint', '--record-failing'].includes(arg)) result.flags.add(arg)
    else if (arg.startsWith('--')) fail(`unknown flag ${arg}`)
    else result.names.push(arg)
  }
  if (!Number.isInteger(result.runs) || result.runs < 1) fail('--runs expects an integer ≥ 1')
  if (result.budget !== undefined && !(result.budget > 0)) fail('--budget-usd expects a positive number')
  if ([result.ref, result.ablate, result.variant].filter(Boolean).length > 1) fail('--ref, --ablate and --variant do not combine: pick one comparison')
  if (result.flags.has('--record-failing') && !(result.ref || result.ablate || result.variant)) fail('--record-failing needs --ref <tag>, --ablate <name> or --variant <name>: the failing run is the point')
  return result
}

function fail(message) {
  console.error(message)
  process.exit(2)
}

if (opts.flags.has('--list')) {
  for (const name of all) console.log(`${name} [${readCase(join(CASES, name)).agent ?? readCase(join(CASES, name)).kind}] — ${readCase(join(CASES, name)).why}`)
  process.exit(0)
}
const selected = opts.names.length ? opts.names : all
const unknown = selected.filter((name) => !all.includes(name))
if (unknown.length) fail(`No such cases: ${unknown.join(', ')}. List: --list`)

if (opts.flags.has('--lint')) {
  let dirty = 0
  for (const name of selected) {
    const hits = lintCase(join(CASES, name))
    if (!hits.length) console.log(`✔ ${name}`)
    else {
      dirty++
      console.log(`✘ ${name} — the case would give itself away:`)
      for (const hit of hits.slice(0, 10)) console.log(`    ${hit.where}: «${hit.word}» in …${hit.context}…`)
    }
  }
  console.log(dirty ? `\n✘ leak lint: ${dirty} of ${selected.length} case(s) would be aborted` : `\n✔ leak lint: ${selected.length} case(s) clean`)
  process.exit(dirty ? 1 : 0)
}

/**
 * A variant of the plugin: `evals/cases/<case>/variants/<name>.json` = { why, edits: [{ file, find, replace } | { file, deleteLines: <regex> }] }, paths relative to the plugin.
 * An edit that matches nothing (or, for `find`, not exactly once) aborts the run: the plugin drifted and the variant no longer says what it claims.
 */
function applyVariant(dir, caseName, variant) {
  const path = join(CASES, caseName, 'variants', `${variant}.json`)
  if (!existsSync(path)) fail(`--variant ${variant}: no ${relative(ROOT, path)}`)
  const { edits } = JSON.parse(readFileSync(path, 'utf8'))
  for (const edit of edits) {
    const file = join(dir, edit.file)
    if (!existsSync(file)) fail(`variant ${variant}: no file ${edit.file} in the plugin`)
    const text = readFileSync(file, 'utf8')
    if (edit.deleteLines) {
      const re = new RegExp(edit.deleteLines)
      const lines = text.split('\n')
      const kept = lines.filter((line) => !re.test(line))
      if (kept.length === lines.length) fail(`variant ${variant}: /${edit.deleteLines}/ matches no line of ${edit.file}`)
      writeFileSync(file, kept.join('\n'))
    } else {
      const parts = text.split(edit.find)
      if (parts.length !== 2) fail(`variant ${variant}: «${edit.find.slice(0, 60)}» occurs ${parts.length - 1} times in ${edit.file}, expected once`)
      writeFileSync(file, parts.join(edit.replace))
    }
  }
}

/**
 * The plugin under test, copied to a neutral directory (`<tmp>/pl-XXXX/stage-pipeline`, so the path does not carry the repo name):
 * the working tree, a git tag (`git archive`, never a worktree of this checkout), or either without a skill/agent; `--model` rewrites `model:`.
 */
function preparePlugin({ overrides, ref, ablate, variant }) {
  const base = mkdtempSync(join(tmpdir(), 'pl-'))
  const dir = join(base, 'stage-pipeline')
  let sha
  if (ref) {
    try {
      sha = git(ROOT, 'rev-parse', '--verify', `${ref}^{commit}`).trim()
    } catch {
      fail(`--ref ${ref}: no such tag or commit (git tag --list 'stage-pipeline--v*')`)
    }
    const tar = execFileSync('git', ['archive', '--format=tar', sha, 'plugins/stage-pipeline'], { cwd: ROOT, maxBuffer: 1 << 28 })
    execFileSync('tar', ['-x', '-C', base], { input: tar })
    cpSync(join(base, 'plugins/stage-pipeline'), dir, { recursive: true })
    rmSync(join(base, 'plugins'), { recursive: true, force: true })
  } else {
    cpSync(SOURCE_PLUGIN, dir, { recursive: true })
    sha = git(ROOT, 'rev-parse', 'HEAD').trim()
    if (git(ROOT, 'status', '--porcelain', '--', 'plugins/stage-pipeline').trim()) sha += '+dirty'
  }
  if (ablate) {
    // `skill:<name>` removes only the skill (an agent that reads its skill as the methodology keeps running without it); `agent:<name>` is the bare model:
    // the agent keeps its frontmatter (name, description, model) and loses its body, and the skill of the same name goes too; a bare name removes both and
    // the run then fails to launch the agent (use it to prove a case notices a missing component, not to record a failing run).
    const [, kind = 'both', bare] = /^(?:(skill|agent):)?(.+)$/.exec(ablate) ?? []
    const skill = join(dir, 'skills', bare)
    const agent = join(dir, 'agents', `${bare}.md`)
    const hasSkill = kind !== 'agent' || existsSync(skill)
    if (kind !== 'agent' && !existsSync(skill) && !existsSync(agent)) fail(`--ablate ${ablate}: no such ${kind === 'both' ? 'skill or agent' : kind} in the plugin`)
    if (kind === 'skill' && !existsSync(skill)) fail(`--ablate ${ablate}: no such skill in the plugin`)
    if (kind === 'agent') {
      if (!existsSync(agent)) fail(`--ablate ${ablate}: no such agent in the plugin`)
      const front = /^---\n[\s\S]*?\n---\n/.exec(readFileSync(agent, 'utf8'))?.[0]
      if (!front) fail(`agent ${bare} has no frontmatter`)
      writeFileSync(agent, `${front}\nCarry out the task in the prompt.\n`)
      if (hasSkill) rmSync(skill, { recursive: true, force: true })
    } else {
      if (existsSync(skill)) rmSync(skill, { recursive: true, force: true })
      if (kind === 'both') rmSync(agent, { force: true })
    }
  }
  if (variant) {
    if (selected.length !== 1) fail('--variant takes exactly one case: the edit list lives in that case')
    applyVariant(dir, selected[0], variant)
  }
  for (const [agent, model] of Object.entries(overrides)) {
    const path = join(dir, 'agents', `${agent}.md`)
    if (!existsSync(path)) fail(`no agent ${agent}`)
    const text = readFileSync(path, 'utf8')
    if (!/^model: .*$/m.test(text)) fail(`agent ${agent} has no model field in its frontmatter`)
    writeFileSync(path, text.replace(/^model: .*$/m, `model: ${model}`))
  }
  const refLabel = ref ? `ref:${ref}` : variant ? `variant:${variant}` : ablate ? `ablate:${ablate}` : Object.keys(overrides).length ? `model:${Object.entries(overrides).map(([a, m]) => `${a}=${m}`).join(',')}` : 'working-tree'
  const version = JSON.parse(readFileSync(join(dir, '.claude-plugin/plugin.json'), 'utf8')).version
  return { dir, base, sha, version, refLabel }
}

const plugin = preparePlugin(opts)
const claudeVersion = (spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout ?? '').trim().split('\n')[0] || '?'
const invocation = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${Math.random().toString(36).slice(2, 6)}`
const resultsDir = join(RESULTS, invocation)
mkdirSync(resultsDir, { recursive: true })
const labelSlug = plugin.refLabel.replace(/[^\w=,:-]/g, '_')

// Permissions as a user who applied the profile has them: the default groups allowed, `ask` not allowed (denied in dontAsk), `deny` denied.
const profile = loadProfile(SOURCE_PLUGIN)
const wanted = wantedFor(plugin.dir, profile.defaultGroups, profile)
const allowed = [...new Set([...wanted.allow, 'Agent', 'Task'])]

function runClaude(args, cwd, seconds, dataDir) {
  const env = { ...process.env, STAGE_PIPELINE_DATA_DIR: dataDir, MCP_CONNECTION_NONBLOCKING: 'false' }
  delete env.CLAUDE_PLUGIN_DATA
  const started = Date.now()
  // In -p, servers from --mcp-config connect asynchronously: MCP_CONNECTION_NONBLOCKING=false makes the session wait for them.
  const result = spawnSync('claude', args, { cwd, encoding: 'utf8', timeout: seconds * 1000, env, maxBuffer: 1 << 28 })
  return { result, seconds: Math.round((Date.now() - started) / 1000) }
}

const common = ['--plugin-dir', plugin.dir, '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk']

function runRouting(name, attempt, spec, world, dataDir) {
  const { result, seconds } = runClaude(
    [
      '-p', spec.prompt, ...common,
      '--output-format', 'stream-json', '--verbose',
      // Skill is allowed: a permission denial would replace the model's choice. A run needs nothing past a couple of turns.
      '--allowedTools', 'Skill', 'Read', 'Grep', 'Glob',
      '--max-turns', String(spec.maxTurns ?? 3),
      '--max-budget-usd', String(spec.budgetUsd ?? 0.3),
    ],
    world.repo, spec.timeoutSec ?? 180, dataDir,
  )
  const events = parseStream(result.stdout)
  const final = events.filter((event) => event.type === 'result').pop() ?? {}
  const invoked = invokedSkills(events)
  const failures = []
  const marks = []
  // A failed run (session limit, API error) invokes no skills — without this check it would count toward forbidSkills.
  // A cut by --max-turns / --max-budget-usd is the normal end of a routing case: the choice has already been made by then.
  const stoppedByLimit = /^error_max_(turns|budget)/.test(final.subtype ?? '')
  const harness = !events.length || !Object.keys(final.modelUsage ?? {}).length || (final.is_error && !stoppedByLimit)
  if (harness) failures.push(`claude did not run: code ${result.status}, ${String(final.result ?? result.stderr ?? '').trim().slice(0, 200)}`)
  if (spec.expectSkill) {
    const ok = invoked[0] === spec.expectSkill
    marks.push(`R1${ok ? '+' : '-'}`)
    if (!ok) failures.push(`first invoked: ${invoked[0] ?? 'no skill'}, expected ${spec.expectSkill}`)
  }
  ;(spec.forbidSkills ?? []).forEach((forbidden, i) => {
    const ok = !invoked.includes(forbidden)
    marks.push(`K${i + 1}${ok ? '+' : '-'}`)
    if (!ok) failures.push(`${forbidden} was invoked but must not be`)
  })
  const body = `# ${name} (${plugin.refLabel}, run ${attempt})\n\nInvoked: ${invoked.join(' → ') || '—'} · end: ${final.subtype ?? '—'}\n\n## Failures\n\n${failures.map((f) => `- ${f}`).join('\n') || '—'}\n\n## Answer\n\n${final.result ?? ''}\n`
  return { failures, marks, harness, seconds, cost: final.total_cost_usd ?? 0, models: Object.keys(final.modelUsage ?? {}), body, stdout: result.stdout }
}

/** Plugin skill and agent calls in order from the event stream: `stage-pipeline:root-cause` → `root-cause`. */
function invokedSkills(events) {
  const names = []
  for (const call of toolCalls(events)) {
    const raw = call.name === 'Skill' ? call.input?.skill ?? call.input?.command : ['Agent', 'Task'].includes(call.name) ? call.input?.subagent_type : null
    const name = raw && String(raw).replace(/^\/?(stage-pipeline:)?/, '')
    // Built-in agents (Explore, general-purpose) are not a route into the plugin: only the plugin's skills and agents count.
    if (name && PLUGIN_NAMES.has(name)) names.push(name)
  }
  return names
}

const PLUGIN_NAMES = new Set([...readdirSync(join(SOURCE_PLUGIN, 'skills')), ...readdirSync(join(SOURCE_PLUGIN, 'agents')).map((file) => file.replace(/\.md$/, ''))])

/** The static server of a `serve` case: a child of this harness with its cwd inside the repo; stopped by its own PID. Ready when it answers this run's token path. */
function startServer(world) {
  if (!world.serve) return null
  const dir = join(world.repo, world.serve.dir)
  const token = randomBytes(8).toString('hex')
  const child = spawn(process.execPath, ['-e', STATIC_SERVER, dir, String(world.serve.port), token], { cwd: dir, stdio: 'ignore' })
  const probe = `require('http').get('http://127.0.0.1:${world.serve.port}/__run/${token}',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>process.exit(r.statusCode===200&&b==='${token}'?0:1))}).on('error',()=>process.exit(1))`
  const until = Date.now() + 5000
  while (Date.now() < until && child.exitCode === null) {
    if (spawnSync(process.execPath, ['-e', probe]).status === 0) return child
    spawnSync('sleep', ['0.2'])
  }
  child.kill()
  throw new Error(`the static server on :${world.serve.port} did not start, or another listener holds the port`)
}

/**
 * A decision case: the orchestrator skill runs as the MAIN session on the production default model (no --model), for a few turns, on a blind STAGES tree.
 * A harness-only PreToolUse hook (`--settings`) ends the session at the first Agent/Task or AskUserQuestion call, so the first batch of spawns is captured whole
 * and no subagent runs. The spawn inputs and the questions are graded from the stream.
 */
function runDecision(name, attempt, spec, world, dataDir) {
  let server
  try {
    server = startServer(world)
  } catch (error) {
    return { failures: [`harness: ${error.message}`], marks: ['W-'], harness: true, seconds: 0, cost: 0, models: [], body: `# ${name} (${plugin.refLabel}, run ${attempt})\n\n## Failures\n\n- harness: ${error.message}\n`, stdout: '' }
  }
  let ran
  try {
    ran = runClaude(
      [
        '-p', world.prompt, ...common, '--add-dir', plugin.dir, ...(world.mcp ? ['--mcp-config', world.mcp.path] : []),
        '--settings', decisionSettings(world.work),
        '--output-format', 'stream-json', '--verbose', '--include-hook-events',
        '--allowedTools', ...allowed, 'AskUserQuestion', ...(world.mcp?.tools ?? []),
        '--disallowedTools', ...wanted.deny,
        '--max-turns', String(spec.maxTurns ?? 15),
        '--max-budget-usd', String(spec.budgetUsd ?? 1),
      ],
      world.repo, spec.timeoutSec ?? 600, dataDir,
    )
  } finally {
    server?.kill()
  }
  const { result, seconds } = ran
  const events = parseStream(result.stdout)
  const final = events.filter((event) => event.type === 'result').pop() ?? {}
  const calls = toolCalls(events).filter((call) => call.parent === null)
  const hooks = hookEvents(events)
  const models = Object.keys(final.modelUsage ?? {})
  const failures = []
  let harness = false
  const harnessFail = (message) => {
    harness = true
    failures.push(message)
  }
  // A run cut by the stop hook or by --max-turns / --max-budget-usd is the normal end; a run that never started is not.
  const stoppedByLimit = /^error_max_(turns|budget)/.test(final.subtype ?? '')
  if (!events.length || !models.length || (final.is_error && !stoppedByLimit && !/hook|stop/i.test(String(final.result ?? '')) && !calls.some((call) => ['Agent', 'Task', 'AskUserQuestion'].includes(call.name)))) {
    harnessFail(`claude: code ${result.status}, ${final.subtype ?? ''} ${String(final.result ?? result.stderr ?? '').trim().slice(0, 300)}`)
  }
  // K7.6: no subagent runs. A SubagentStart hook or an event under an Agent call means the stop hook did not hold.
  if (hooks.some((hook) => hook.startsWith('SubagentStart')) || events.some((event) => event.parent_tool_use_id)) harnessFail('a subagent ran: the spawn stop hook did not hold')
  for (const problem of harnessProblems(events, { allowed: [...allowed, 'AskUserQuestion', ...(world.mcp?.tools ?? [])], mcpNames: (world.mcp?.tools ?? []).map((tool) => tool.slice('mcp__'.length)) })) harnessFail(problem)
  const read = (path) => (existsSync(join(world.repo, path)) ? readFileSync(join(world.repo, path), 'utf8') : '')
  const graded = gradeDecision(spec, {
    repo: world.repo, calls, hooks, final: String(final.result ?? ''),
    stagesText: read(`tasks/${world.identity.ticket}/STAGES.md`), configText: read('.claude/pipeline.config.md'),
  })
  failures.push(...graded.failures)
  const trace = calls.map((call) => `- ${call.name}${call.denied ? ' [denied]' : call.isError ? ' [error]' : ''}: ${JSON.stringify(call.input).slice(0, ['Agent', 'Task', 'AskUserQuestion'].includes(call.name) ? 1500 : 160)}`)
  const hookCounts = Object.entries(hooks.reduce((acc, event) => ({ ...acc, [event]: (acc[event] ?? 0) + 1 }), {})).map(([event, n]) => `${event}×${n}`)
  const cost = final.total_cost_usd ?? 0
  const body =
    `# ${name} (${plugin.refLabel}, run ${attempt})\n\nModels: ${models.join(', ') || '—'} · $${cost.toFixed(3)} · ${seconds}s · turns ${final.num_turns ?? '?'} · end: ${final.subtype ?? '—'}\n\n` +
    `## Failures\n\n${failures.map((f) => `- ${f}`).join('\n') || '—'}\n\n## Hook events\n\n${hookCounts.join(', ') || '—'}\n\n## Orchestrator calls (${trace.length})\n\n${trace.join('\n') || '—'}\n\n## Final text\n\n${final.result ?? ''}\n`
  return { failures, marks: graded.marks, harness, seconds, cost, models, body, stdout: result.stdout }
}

function runAgent(name, attempt, spec, world, dataDir) {
  const readIfExists = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null)
  const snapshot = Object.fromEntries((spec.unchanged ?? []).map((path) => [path, readIfExists(join(world.repo, path))]))
  const commitsBefore = git(world.repo, 'rev-list', '--count', 'HEAD').trim()
  let server
  try {
    server = startServer(world)
  } catch (error) {
    return { failures: [`harness: ${error.message}`], marks: ['W-'], harness: true, seconds: 0, cost: 0, models: [], body: `# ${name} (${plugin.refLabel}, run ${attempt})\n\n## Failures\n\n- harness: ${error.message}\n`, stdout: '' }
  }
  const main = spec.thread === 'main'
  let ran
  try {
    ran = runClaude(
    [
      // --add-dir: the plugin directory is outside the repo, and `Read(**)` covers the cwd only; in production the plugin's own files (skills, references, scripts) are readable.
      // `thread: "main"`: the agent is the session itself (`--agent`, its own model), the prompt goes in unchanged; otherwise a thin haiku parent launches it as a subagent.
      ...(main ? ['-p', world.prompt, '--agent', `stage-pipeline:${spec.agent}`] : ['-p', world.prompts.parent, '--model', 'haiku']), ...common, '--add-dir', plugin.dir, ...(world.mcp ? ['--mcp-config', world.mcp.path] : []),
      '--output-format', 'stream-json', '--verbose', '--include-hook-events',
      '--allowedTools', ...allowed, ...(world.mcp?.tools ?? []),
      '--disallowedTools', ...wanted.deny,
      '--max-turns', '8',
      '--max-budget-usd', String(spec.budgetUsd ?? 1),
    ],
    world.repo, spec.timeoutSec ?? 600, dataDir,
    )
  } finally {
    server?.kill()
  }
  const { result, seconds } = ran
  const events = parseStream(result.stdout)
  const final = events.filter((event) => event.type === 'result').pop() ?? {}
  // In the main thread the session's own calls and final message are the agent's.
  const sub = main ? { launch: { id: null }, calls: toolCalls(events).filter((call) => call.parent === null), summary: String(final.result ?? '').trim() } : subagentRun(events, spec.agent)
  const hooks = hookEvents(events)
  const cost = final.total_cost_usd ?? 0
  const models = Object.keys(final.modelUsage ?? {})

  const failures = []
  let harness = false
  const harnessFail = (message) => {
    harness = true
    failures.push(message)
  }
  if (!events.length || !models.length || final.is_error) harnessFail(`claude: code ${result.status}, ${final.subtype ?? ''} ${String(final.result ?? result.stderr ?? '').trim().slice(0, 300)}`)
  else if (main) { /* no launch to check: the prompt reaches the agent as it is */ }
  else if (!sub.launch) harnessFail('the parent session never launched the subagent')
  else if (sub.launch.input.prompt?.trim() !== world.prompt.trim()) harnessFail('the parent session changed the subagent prompt — the run says nothing about the agent')

  // A server that did not connect or a denial of an allowed tool is the harness's failure, never a grade (and never a `provenFailing`).
  for (const problem of harnessProblems(events, { allowed: [...allowed, ...(world.mcp?.tools ?? [])], mcpNames: (world.mcp?.tools ?? []).map((tool) => tool.slice('mcp__'.length)) })) harnessFail(problem)

  // The file name is the skill convention's business; the case only checks that a report was saved at all.
  const checksDir = join(world.repo, world.checks)
  const report = existsSync(checksDir) ? walk(checksDir).filter((file) => file.endsWith('.md')).map((file) => readFileSync(file, 'utf8')).join('\n') : ''
  const graded = gradeAgent(spec, {
    repo: world.repo, report, summary: sub.summary, calls: sub.calls, hooks, snapshot, commitsBefore, commitsAfter: git(world.repo, 'rev-list', '--count', 'HEAD').trim(),
  })
  const marks = [...graded.marks]
  if (spec.requireReport !== false) {
    marks.unshift(`D1${report ? '+' : '-'}`)
    if (!report) failures.push(`report not saved to ${world.checks}/`)
  }
  failures.push(...graded.failures)

  const denials = (final.permission_denials ?? []).map((denial) => `- ${denial.tool_name}: ${JSON.stringify(denial.tool_input).slice(0, 200)}`)
  const trace = sub.calls.map((call) => `- ${call.name}${call.denied ? ' [denied]' : call.isError ? ' [error]' : ''}: ${JSON.stringify(call.input).slice(0, 160)}`)
  const hookCounts = Object.entries(hooks.reduce((acc, event) => ({ ...acc, [event]: (acc[event] ?? 0) + 1 }), {})).map(([event, n]) => `${event}×${n}`)
  const body =
    `# ${name} (${plugin.refLabel}, run ${attempt})\n\nModels: ${models.join(', ') || '—'} · $${cost.toFixed(3)} · ${seconds}s\n\n` +
    `## Failures\n\n${failures.map((f) => `- ${f}`).join('\n') || '—'}\n\n## Permission denials\n\n${denials.join('\n') || '—'}\n\n` +
    `## Hook events\n\n${hookCounts.join(', ') || '—'}\n\n## Subagent tool calls (${trace.length})\n\n${trace.join('\n') || '—'}\n\n` +
    `## Agent report\n\n${report || '(none)'}\n\n## Final message of the subagent\n\n${sub.summary}\n`
  return { failures, marks, harness, seconds, cost, models, body, stdout: result.stdout }
}

function runCase(name, attempt) {
  const caseDir = join(CASES, name)
  const spec = readCase(caseDir)
  const world = buildWorld({ caseDir, name, spec, plugin: plugin.dir })
  const dataDir = mkdtempSync(join(tmpdir(), 'pd-'))
  try {
    const hits = lintWorld(world, spec)
    if (hits.length) return { aborted: hits }
    const run = spec.kind === 'routing' ? runRouting(name, attempt, spec, world, dataDir) : spec.kind === 'decision' ? runDecision(name, attempt, spec, world, dataDir) : runAgent(name, attempt, spec, world, dataDir)
    const saved = join(resultsDir, `${name}--${labelSlug}--${attempt}.md`)
    writeFileSync(saved, run.body)
    writeFileSync(join(resultsDir, `${name}--${labelSlug}--${attempt}.jsonl`), run.stdout ?? '')
    return { ...run, saved }
  } finally {
    world.cleanup()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

const table = []
const skipped = []
const aborted = []
let spendNow = 0
for (const name of selected) {
  const spec = readCase(join(CASES, name))
  const missing = missingServers(spec, plugin.dir)
  if (missing.length) {
    console.log(`⏭ ${name} — skipped: the plugin's .mcp.json has no ${missing.join(', ')}`)
    continue
  }
  const row = { name, passed: 0, ran: 0, cost: 0, seconds: 0, models: new Set(), failures: [], harness: 0 }
  for (let attempt = 1; attempt <= opts.runs; attempt++) {
    if (opts.budget) {
      const ledger = readLedger()
      const estimate = meanCost(ledger, name) ?? spec.budgetUsd ?? (spec.kind === 'routing' ? 0.3 : 1)
      const spent = spentSince(ledger, opts.budgetSince ?? '')
      if (spent + estimate > opts.budget) {
        skipped.push({ name, attempt, estimate })
        console.log(`⏭ ${name} #${attempt} — skipped: $${spent.toFixed(2)} spent + ~$${estimate.toFixed(2)} would pass $${opts.budget}`)
        continue
      }
    }
    process.stdout.write(`… ${name} #${attempt}`)
    const run = runCase(name, attempt)
    if (run.aborted) {
      process.stdout.write(`\r✘ ${name} #${attempt} — aborted before any model call, the case gives itself away:\n`)
      for (const hit of run.aborted.slice(0, 8)) console.log(`    ${hit.where}: «${hit.word}» in …${hit.context}…`)
      aborted.push(name)
      break
    }
    const { failures, marks, harness, seconds, cost, models, saved } = run
    if (harness && !marks.includes('W-')) marks.push('W-')
    row.ran++
    if (!failures.length) row.passed++
    if (harness) row.harness++
    row.cost += cost
    spendNow += cost
    row.seconds += seconds
    row.failures.push(failures)
    for (const model of models) row.models.add(model)
    appendLedger({
      ts: new Date().toISOString(), invocation, case: name, attempt, plugin_ref: plugin.refLabel, plugin_version: plugin.version, plugin_sha: plugin.sha,
      claude_version: claudeVersion, models: models.join('+'), marks: marks.join(' '), pass: failures.length ? 0 : 1, cost_usd: cost.toFixed(4), seconds,
    })
    process.stdout.write(`\r${failures.length ? '✘' : '✔'} ${name} #${attempt} (${seconds}s, $${cost.toFixed(3)}, ${models.join('+') || '?'})\n`)
    for (const failure of failures) console.log(`    ${failure}`)
    if (failures.length) console.log(`    full output: ${relative(ROOT, saved)}`)
  }
  table.push(row)
}

console.log(`\n## ${plugin.refLabel} (plugin ${plugin.version} @ ${plugin.sha.slice(0, 9)}, ${claudeVersion}), runs per case: ${opts.runs}, invocation ${invocation}\n`)
console.log('| Case | Passed | Models | $ per run | s per run |')
console.log('|---|---|---|---|---|')
for (const row of table) {
  const n = Math.max(row.ran, 1)
  console.log(`| ${row.name} | ${row.passed}/${row.ran} | ${[...row.models].join(', ')} | ${(row.cost / n).toFixed(3)} | ${Math.round(row.seconds / n)} |`)
}
console.log(`\nTotal: ${table.reduce((s, r) => s + r.passed, 0)}/${table.reduce((s, r) => s + r.ran, 0)} runs passed, cost this invocation $${spendNow.toFixed(2)} (ledger: ${relative(ROOT, join(ROOT, 'evals/ledger.tsv'))})`)
if (skipped.length) {
  console.log(`\nSkipped by the budget (${skipped.length} runs, ~$${skipped.reduce((s, r) => s + r.estimate, 0).toFixed(2)}):`)
  for (const run of skipped) console.log(`  ${run.name} #${run.attempt} ~$${run.estimate.toFixed(2)}`)
}

if (opts.flags.has('--record-failing')) recordFailing()
rmSync(plugin.base, { recursive: true, force: true })
if (aborted.length) process.exit(2)
process.exit(table.every((row) => row.passed === row.ran) ? (skipped.length ? 3 : 0) : 1)

/** The new-case rule: the case must fail on the previous tag / without the skill. Every run failed on the comparison → the proof goes into case.json. */
function recordFailing() {
  if (selected.length !== 1) fail('--record-failing takes exactly one case')
  const [row] = table
  const path = join(CASES, selected[0], 'case.json')
  // A reference or an ablation is a clean break: every run must fail. A variant is a hand-made edit that a model may still get around: three runs at least, two or more failing,
  // and the counts written are those of this whole invocation (a favourable run is never picked out).
  const isVariant = Boolean(opts.variant)
  const failedRuns = row ? row.ran - row.passed : 0
  const enough = isVariant ? row?.ran >= 3 && failedRuns >= 2 : row?.passed === 0
  if (!row?.ran || !enough || row.harness > 0) {
    console.error(`\n✘ not recorded: ${!row?.ran ? 'no run happened' : row.harness > 0 ? 'a run failed for a harness reason, not a grade' : isVariant ? `${failedRuns} of ${row.ran} runs failed on ${plugin.refLabel}; a variant needs at least 3 runs (--runs 3) and 2 failing` : `${row.passed} of ${row.ran} runs PASSED on ${plugin.refLabel} — the case does not tell the versions apart`}`)
    rmSync(plugin.base, { recursive: true, force: true })
    process.exit(1)
  }
  const spec = readCase(join(CASES, selected[0]))
  const failures = [...new Set(row.failures.flat().map((message) => message.slice(0, 160)))].slice(0, 6)
  spec.provenFailing = { on: plugin.refLabel, date: new Date().toISOString().slice(0, 10), plugin: `${plugin.version}@${plugin.sha.slice(0, 9)}`, runs: row.ran, failed: row.ran - row.passed, detection: `${row.ran - row.passed}/${row.ran}`, caseHash: caseHash(join(CASES, selected[0])), failures }
  writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`)
  console.log(`\n✔ recorded provenFailing (${plugin.refLabel}, ${row.ran} run(s)) in ${relative(ROOT, path)}`)
}
