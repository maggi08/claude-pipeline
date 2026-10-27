/**
 * The parts of scripts/eval.mjs that need no model: how a case is dressed as a real project (identity), the leak lint,
 * the graders and the ledger. Split out so scripts/validate.mjs can run the lint and the grader self-tests for free in CI.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reviewModel } from '../plugins/stage-pipeline/scripts/hooks/pipeline-state.mjs'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const CASES = join(ROOT, 'evals/cases')
export const SOURCE_PLUGIN = join(ROOT, 'plugins/stage-pipeline')
export const LEDGER = join(ROOT, 'evals/ledger.tsv')

export const readCase = (caseDir) => JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8'))
export const git = (cwd, ...cmd) => execFileSync('git', cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })

export function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

// ── identity: every case looks like a project of its own ─────────────────────────────────────────────────────────────

const REPOS = ['billing-web', 'catalog-ui', 'help-center-web', 'partner-portal', 'booking-app', 'inventory-console', 'loyalty-web', 'shipments-ui']
const PREFIXES = ['BIL', 'CAT', 'HLP', 'PRT', 'BKG', 'INV', 'LOY', 'SHP']
const FIRST = ['Maya', 'Jonas', 'Alina', 'Peter', 'Nadia', 'Oskar', 'Lena', 'Victor']
const LAST = ['Okafor', 'Lindgren', 'Petrova', 'Hollis', 'Brandt', 'Novak', 'Reyes', 'Aalto']

const hash = (text) => [...text].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)

/**
 * The identity of a case: repository directory, ticket, git author, commit messages, branch. `identity` in case.json wins;
 * the rest is derived from the case name, so it is stable between runs and different between cases. A routing case that borrows
 * another case's tree (`base: ../<other>/base`) borrows its identity too.
 */
export function identityOf(name, spec, casesDir = CASES) {
  const borrowed = spec.base && /^\.\.\/([^/]+)\//.exec(spec.base)
  if (borrowed && existsSync(join(casesDir, borrowed[1], 'case.json')) && !spec.identity) {
    return identityOf(borrowed[1], readCase(join(casesDir, borrowed[1])), casesDir)
  }
  const h = hash(name)
  const first = FIRST[h % FIRST.length]
  const last = LAST[Math.floor(h / 7) % LAST.length]
  const repo = REPOS[Math.floor(h / 13) % REPOS.length]
  const ticket = `${PREFIXES[Math.floor(h / 17) % PREFIXES.length]}-${1 + (Math.floor(h / 19) % 60)}`
  const defaults = { repo, ticket, user: `${first} ${last}`, email: `${first}.${last}@${repo}.dev`.toLowerCase(), branch: 'feature' }
  const identity = { ...defaults, ...spec.identity }
  identity.commits = {
    base: spec.identity?.commits?.base ?? 'chore: initial import',
    stage: (n) => `feat(${identity.ticket}): stage ${n}`,
    stages: spec.identity?.commits?.stages ?? {},
  }
  return identity
}

const commitMessage = (identity, stage) => identity.commits.stages[stage] ?? identity.commits.stage(stage)

// ── the leak lint ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Words that tell an agent it is being tested. Matched as whole words (letters, digits on both sides break the match), so
 * «evaluate», «retrieval», «defective», «judgement» and camelCase identifiers do not fire, while `eval-fixture`, «Evals», «fixtures» and «кейсы» do.
 * A case that legitimately needs one (a «candidate» in a voting component) lists it in `leakAllow: [{ word, why }]` of its case.json.
 */
const WORDS = ['evals?', 'fixtures?', 'planted', 'defects?', 'judge[ds]?', 'judging', 'rubrics?', 'benchmarks?', 'candidates?', 'кейс\\p{L}*', 'фикстур\\p{L}*']
const LEAK = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${WORDS.join('|')})(?![\\p{L}\\p{N}])`, 'giu')

function leakHits(where, text, allow = []) {
  const allowed = new Set(allow.map((entry) => String(entry.word ?? entry).toLowerCase()))
  const hits = []
  for (const match of text.matchAll(LEAK)) {
    if (allowed.has(match[0].toLowerCase())) continue
    const from = Math.max(0, match.index - 25)
    hits.push({ where, word: match[0], context: text.slice(from, match.index + match[0].length + 25).replace(/\s+/g, ' ') })
  }
  return hits
}

const isText = (buffer) => !buffer.subarray(0, 4096).includes(0)

/** Every surface of a built world the agent can see, linted: tree (paths and contents), prompts, paths, git history, MCP config. */
export function lintWorld(world, spec) {
  const allow = spec.leakAllow ?? []
  const hits = []
  const lint = (where, text) => hits.push(...leakHits(where, text, allow))
  for (const file of walk(world.repo)) {
    const rel = relative(world.repo, file)
    if (rel.split('/')[0] === '.git') continue
    lint(`tree path ${rel}`, rel)
    const buffer = readFileSync(file)
    if (buffer.length < 4_000_000 && isText(buffer)) lint(`tree ${rel}`, buffer.toString('utf8'))
  }
  for (const [label, text] of Object.entries(world.prompts)) lint(`prompt (${label})`, text)
  lint('cwd path', world.repo)
  lint('work dir path', world.work)
  lint('plugin path', world.plugin)
  lint('git history', gitHistory(world.repo))
  if (world.mcp) {
    lint('mcp config path', world.mcp.path)
    lint('mcp config', readFileSync(world.mcp.path, 'utf8'))
    for (const file of world.mcp.files) {
      lint(`mcp stub path ${file}`, file)
      // The stub's output reaches the agent as tool results, so its contents are what the agent reads.
      const buffer = readFileSync(file)
      if (buffer.length < 4_000_000 && isText(buffer)) lint(`mcp stub ${file}`, buffer.toString('utf8'))
    }
  }
  return hits
}

/** Messages, author and committer, and branch names of every commit, as text. */
function gitHistory(repo) {
  return git(repo, 'log', '--all', '--format=%an <%ae> | %cn <%ce> | %s%n%b') + git(repo, 'branch', '-a') + git(repo, 'config', '--local', '--list')
}

// ── the world of one run ────────────────────────────────────────────────────────────────────────────────────────────

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

/**
 * A hash of the case's content: every file of its directory (path and bytes) with case.json taken without `provenFailing`.
 * `provenFailing` carries it, so a record is tied to the version of the case it was recorded on. A file under variants/ counts only when the record
 * is that variant's (`on: variant:<name>`, the `on` argument: --record-failing passes the one it is about to write, the record on disk is the previous one): a `--ref` or `--ablate` run never saw the variants, and keeping one applicable must not void such a record.
 */
export function caseHash(caseDir, on = readCase(caseDir).provenFailing?.on) {
  const hash = createHash('sha256')
  const proofOn = on ?? ''
  const files = walk(caseDir).map((path) => relative(caseDir, path).split('\\').join('/')).filter((path) => !path.endsWith('.DS_Store') && (!path.startsWith('variants/') || path === `variants/${proofOn.replace(/^variant:/, '')}.json`))
  for (const file of files.sort()) {
    hash.update(`${file}\0`)
    if (file === 'case.json') {
      const { provenFailing, ...rest } = readCase(caseDir)
      hash.update(JSON.stringify(rest))
    } else hash.update(readFileSync(join(caseDir, file)))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

/** The case tree as a git repository of its own: base, one commit per stage layer, the working layer uncommitted. */
function buildRepo(caseDir, parent, identity, basePath = 'base', vars = {}) {
  const repo = join(parent, identity.repo)
  mkdirSync(repo)
  const day = (n) => ({ GIT_AUTHOR_DATE: `2026-09-${String(1 + n).padStart(2, '0')}T10:00:00Z`, GIT_COMMITTER_DATE: `2026-09-${String(1 + n).padStart(2, '0')}T10:00:00Z` })
  const commit = (message, n) =>
    execFileSync('git', ['commit', '-qm', message], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...day(n) } })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', identity.email)
  git(repo, 'config', 'user.name', identity.user)
  git(repo, 'config', 'commit.gpgsign', 'false')
  cpSync(join(caseDir, basePath), repo, { recursive: true })
  fillVars(repo, vars)
  git(repo, 'add', '-A')
  commit(identity.commits.base, 0)
  git(repo, 'checkout', '-qb', identity.branch)
  const stagesDir = join(caseDir, 'stages')
  if (existsSync(stagesDir)) {
    for (const stage of readdirSync(stagesDir).sort((a, b) => Number(a) - Number(b))) {
      applyLayer(join(stagesDir, stage), repo)
      fillVars(repo, vars)
      git(repo, 'add', '-A')
      commit(commitMessage(identity, stage), Number(stage))
    }
  }
  if (existsSync(join(caseDir, 'working'))) applyLayer(join(caseDir, 'working'), repo)
  fillVars(repo, vars)
  return repo
}

/** `{port}` and the like in the text files of the tree become the run's values (a served page's URL is only known once a free port is picked). */
function fillVars(repo, vars) {
  const keys = Object.keys(vars)
  if (!keys.length) return
  for (const file of walk(repo)) {
    if (file.includes('/.git/')) continue
    const buffer = readFileSync(file)
    if (!isText(buffer)) continue
    const text = buffer.toString('utf8')
    if (!keys.some((key) => text.includes(`{${key}}`))) continue
    writeFileSync(file, keys.reduce((out, key) => out.replaceAll(`{${key}}`, String(vars[key])), text))
  }
}

/** A free TCP port on 127.0.0.1 (asked from the OS; the server of a served case binds it right after). */
function freePort() {
  return Number(
    execFileSync(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: 'utf8' }).trim(),
  )
}

/**
 * A static server for a case with `serve: { dir }`: serves the repo's `dir` on `port`, answers `/api/*` with 404 (a page's own fetch fails the way it does against
 * a dev server without a backend). Its cwd is inside the repo, so verify-doctor sees the listener as this worktree's app. The caller starts it with
 * `spawn(process.execPath, ['-e', STATIC_SERVER, dir, port, token], { cwd: join(repo, dir) })` and stops it by the child's PID.
 */
export const STATIC_SERVER = `
const http = require('http'), fs = require('fs'), path = require('path')
const [dir, port, token] = process.argv.slice(1)
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }
http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])
  // The readiness probe asks for this run's token: only this server knows it, a foreign listener on the port does not.
  if (url === '/__run/' + token) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(token) }
  const file = path.join(dir, url.endsWith('/') ? url + 'index.html' : url)
  if (!file.startsWith(dir) || url.startsWith('/api/') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found') }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(file).pipe(res)
}).listen(Number(port), '127.0.0.1')
`

/**
 * --mcp-config for the servers the case asked for. The name is `plugin_<plugin>_<server>`, so the tools are
 * `mcp__plugin_<plugin>_<server>__*` as in production. A server may be replaced by a local command in case.json:
 * `"mcpServers": { "figma": { "command": "node", "args": ["{stubs}/figma.mjs"] } }` — the case's `stubs/` directory is copied next to
 * the repo and `{stubs}` points at the copy. Claude Code caches «needs authentication» by server name; that cache is only ever written
 * for servers with an OAuth flow (the http `figma` one), never for a stdio server, so the old per-run `-eval-<suffix>` rename is not
 * needed for the servers a case runs (the figma server is always a stdio stub).
 */
function mcpConfig(servers, spec, caseDir, plugin, work) {
  const manifest = JSON.parse(readFileSync(join(plugin, '.claude-plugin/plugin.json'), 'utf8'))
  const declared = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8'))
  const replaced = spec.mcpServers ?? {}
  const stubsDir = join(work, 'mcp')
  const files = []
  if (existsSync(join(caseDir, 'stubs'))) {
    cpSync(join(caseDir, 'stubs'), stubsDir, { recursive: true })
    files.push(...walk(stubsDir))
  }
  const expand = (value) => JSON.parse(JSON.stringify(value).replaceAll('{stubs}', stubsDir).replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin))
  const picked = Object.fromEntries(servers.map((name) => [`plugin_${manifest.name}_${name}`, expand(replaced[name] ?? declared[name])]))
  const path = join(work, 'mcp.json')
  writeFileSync(path, JSON.stringify({ mcpServers: picked }))
  return { path, tools: Object.keys(picked).map((name) => `mcp__${name}`), files }
}

export function missingServers(spec, plugin) {
  const declared = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8'))
  return (spec.mcp ?? []).filter((name) => !declared[name] && !spec.mcpServers?.[name])
}

const launchPrompt = (agent, prompt) =>
  `Launch the subagent stage-pipeline:${agent} (the Agent tool, subagent_type "stage-pipeline:${agent}") and pass it exactly the text between the two lines of equals signs as its prompt, unchanged. ` +
  `Run it in the foreground (run_in_background false), wait for it to finish, then answer with the single word done.\n\n==========\n${prompt}\n==========`

/** Everything one run needs, built in a neutral temp directory: <work>/<repo>/ is the cwd, mcp.json and the stubs sit next to it. */
export function buildWorld({ caseDir, name, spec, plugin }) {
  const work = mkdtempSync(join(tmpdir(), 'wk-'))
  const identity = identityOf(name, spec, dirname(caseDir))
  // `serve: { dir }` — the case needs a page served locally; `{port}` in the tree and the prompt is that server's port.
  const serve = spec.serve ? { dir: spec.serve.dir, port: freePort() } : null
  const vars = serve ? { port: serve.port } : {}
  const repo = buildRepo(caseDir, work, identity, spec.base, vars)
  const checks = `tasks/${identity.ticket}/checks`
  const routing = spec.kind === 'routing' || spec.kind === 'decision'
  const filled = serve ? spec.prompt.replaceAll('{port}', String(serve.port)) : spec.prompt
  const prompt = routing || spec.requireReport === false ? filled : `${filled}\n\nSave the report to ${checks}/ following the report naming convention.`
  const prompts = routing ? { prompt } : { prompt, parent: launchPrompt(spec.agent, prompt) }
  const servers = spec.mcp ?? []
  const mcp = servers.length ? mcpConfig(servers, spec, caseDir, plugin, work) : null
  return { work, repo, identity, checks, prompt, prompts, mcp, plugin, serve, cleanup: () => rmSync(work, { recursive: true, force: true }) }
}

/** The leak lint of one case dir, for the free `--lint` mode and the self-test: builds the world on a neutral copy of the plugin, lints it, removes it. */
export function lintCase(caseDir, source = SOURCE_PLUGIN) {
  const name = caseDir.split('/').pop()
  const spec = readCase(caseDir)
  const holder = mkdtempSync(join(tmpdir(), 'pl-'))
  const plugin = join(holder, 'stage-pipeline')
  cpSync(source, plugin, { recursive: true })
  try {
    if (missingServers(spec, plugin).length) return []
    const world = buildWorld({ caseDir, name, spec, plugin })
    try {
      return lintWorld(world, spec)
    } finally {
      world.cleanup()
    }
  } finally {
    rmSync(holder, { recursive: true, force: true })
  }
}

// ── the plugin data directory of an archived plugin ──────────────────────────────────────────────────────────────────

/**
 * Tags before 0.19.0 have a `pluginDataDir()` that ignores STAGE_PIPELINE_DATA_DIR, and Claude Code sets CLAUDE_PLUGIN_DATA itself for the hooks of a
 * `--plugin-dir` session, so such a plugin writes into the live data directory. Patches the copy of an archived plugin so that the function
 * returns an absolute STAGE_PIPELINE_DATA_DIR first. Throws when `export function pluginDataDir() {` does not occur exactly once.
 */
export function patchDataDirOverride(pluginDir) {
  const file = join(pluginDir, 'scripts/hooks/pipeline-state.mjs')
  if (!existsSync(file)) throw new Error(`no scripts/hooks/pipeline-state.mjs in the archived plugin: cannot route its data directory away from the live one`)
  const head = 'export function pluginDataDir() {'
  const parts = readFileSync(file, 'utf8').split(head)
  if (parts.length !== 2) throw new Error(`«${head}» occurs ${parts.length - 1} times in the archived pipeline-state.mjs, expected once: the data directory cannot be routed away from the live one`)
  writeFileSync(file, `${parts[0]}${head}\n  const harnessDir = process.env.STAGE_PIPELINE_DATA_DIR\n  if (harnessDir && /^(?:\\/|[A-Za-z]:[\\\\/])/.test(harnessDir)) return harnessDir\n${parts[1]}`)
}

/**
 * Applies the edit list of a variant (`{ file, find, replace } | { file, deleteLines: <regex> }`, paths relative to the plugin dir) in place. An edit that matches nothing
 * (or, for `find`, not exactly once) throws: the plugin drifted and the variant no longer says what it claims.
 */
export function applyVariantEdits(dir, edits, label) {
  for (const edit of edits) {
    const file = join(dir, edit.file)
    if (!existsSync(file)) throw new Error(`variant ${label}: no file ${edit.file} in the plugin`)
    const text = readFileSync(file, 'utf8')
    if (edit.deleteLines) {
      const re = new RegExp(edit.deleteLines)
      const lines = text.split('\n')
      const kept = lines.filter((line) => !re.test(line))
      if (kept.length === lines.length) throw new Error(`variant ${label}: /${edit.deleteLines}/ matches no line of ${edit.file}`)
      writeFileSync(file, kept.join('\n'))
    } else {
      const parts = text.split(edit.find)
      if (parts.length !== 2) throw new Error(`variant ${label}: «${edit.find.slice(0, 60)}» occurs ${parts.length - 1} times in ${edit.file}, expected once`)
      writeFileSync(file, parts.join(edit.replace))
    }
  }
}

// ── the stream ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function parseStream(stdout) {
  return (stdout ?? '').split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

/** The text of a message `content` (a string, or an array of blocks); shared with scripts/run-audit.mjs. */
export const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((block) => (typeof block === 'string' ? block : block?.text ?? '')).join('\n') : ''

/** Every tool call of the stream with its result; `parent` is the Agent call a call was made under (null for the top-level session). */
export function toolCalls(events) {
  const calls = new Map()
  for (const event of events) {
    for (const block of event.message?.content ?? []) {
      if (event.type === 'assistant' && block.type === 'tool_use') {
        calls.set(block.id, { id: block.id, name: block.name, input: block.input ?? {}, parent: event.parent_tool_use_id ?? null, result: null, isError: false, denied: false })
      } else if (event.type === 'user' && block.type === 'tool_result' && calls.has(block.tool_use_id)) {
        const call = calls.get(block.tool_use_id)
        call.result = textOf(block.content)
        call.isError = Boolean(block.is_error)
        call.denied = call.isError && /permission|denied|not allowed|haven't granted|requires approval/i.test(call.result)
      }
    }
  }
  return [...calls.values()]
}

/** The subagent a thin parent launched: its Agent call, its own tool calls, and its final message (the Agent tool_result without the usage footer). */
export function subagentRun(events, agent) {
  const calls = toolCalls(events)
  const launch = calls.find((call) => ['Agent', 'Task'].includes(call.name) && call.parent === null && String(call.input.subagent_type ?? '').replace(/^stage-pipeline:/, '') === agent)
  if (!launch) return { launch: null, calls: [], summary: '' }
  let summary = launch.result ?? ''
  // A backgrounded subagent answers the Agent call with «Async agent launched»; its own final message then arrives as a task_notification.
  if (/^Async agent launched/.test(summary)) {
    const done = events.find((event) => event.type === 'system' && event.subtype === 'task_notification' && event.tool_use_id === launch.id)
    summary = done?.summary ?? ''
  }
  // Claude Code frames a finished subagent's report («[Subagent hand-back] … The report follows:») and indents every line of it by two spaces.
  const framed = /^\[Subagent hand-back\][\s\S]*?The report follows:\n/.exec(summary)
  if (framed) summary = summary.slice(framed[0].length).replace(/^ {2}/gm, '')
  summary = summary
    .replace(/<usage>[\s\S]*?<\/usage>/g, '')
    .replace(/^agentId:.*$/gm, '')
    .trim()
  return { launch, calls: calls.filter((call) => call.parent === launch.id), summary }
}

/** Names of the hooks that started in the session (`SessionStart:startup`, `PreToolUse:Agent`, `SubagentStop:devtools-verify`), one per run of a hook. */
export function hookEvents(events) {
  return events.filter((event) => event.type === 'system' && event.subtype === 'hook_started').map((event) => event.hook_name ?? event.hook_event ?? '?')
}

// ── graders ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const SEVERITY = {
  critical: /\b(critical|blocker)\b|🔴/i,
  major: /\bmajor\b|🟠/i,
  minor: /\bminor\b|🟡|⚪/i,
}
// A negation counts only as the predicate attached to the file token: what stands right after it («formatTime — no duplicates found»,
// «PromoBanner.tsx (added by the task, not an orphan)»), never a «no» / «without» / «not» somewhere else on the line.
const NOUNS = 'duplicat\\w*|issues?|findings?|problems?|defects?|violations?|orphan\\w*|dead code|concerns?|matches|bugs?'
const NEGATION = new RegExp(
  '^(?:' + [
    `(?:no|none|zero|nothing)\\s+(?:\\w+\\s+){0,2}?(?:${NOUNS})\\b`,
    `(?:found|detected|reported)\\s+(?:no|nothing|none)\\b`,
    `(?:is|are|was|were|isn't|aren't|wasn't|weren't)?\\s*(?:not|isn't|aren't|wasn't|weren't)\\s+(?:an?\\s+|the\\s+)?(?:${NOUNS}|dead)\\b`,
    `(?:no|zero)\\s+(?:\\w+\\s+){0,3}?(?:found|detected)\\b`,
    `не\\s+(?:найден\\w*|обнаружен\\w*|является|осиротел\\w*|дублир\\w*)|нет\\s+(?:дубл|пробл|замечан|находок|нарушен)`,
    `false positives?\\b|ложн\\w+ срабатыван\\w+`,
  ].join('|') + ')',
  'iu',
)
// After the file token: the rest of the path / `:line`, closing quotes, then a dash, colon or comma, or an opening parenthesis with a short aside.
const BRIDGE = /^[\w./\\:-]*[`'")\]*_]*\s*(?:[—–:,-]\s*|\(\s*(?:[^(),]{0,40},\s*)?)?/u
/** True when the text after a file token is a negated verdict on that file. */
const negatedTail = (tail) => {
  const bridged = BRIDGE.exec(tail)?.[0] ?? ''
  const rest = tail.slice(bridged.length)
  return NEGATION.test(rest)
}
const KEPT_SECTION = /\b(kept|discarded|could not verify|cannot verify|not verified|dismissed|out of scope|ruled out|false positives?|findings outcome)\b|не проверен|оставлен|намеренно|отклонен|не удалось проверить|итог находок|отброшено/i
const ITEM = /^\s*(?:[-*•]|\d+[.)])\s+|^\s*\|(?![\s:|-]*$)|^\s*[*_`>]*\s*(?:[CMFm]-?\d+|#\d+|AC-[\d.]+)\b|^\s*[*_`>]*\s*(?:critical|major|minor|blocker)\b|^\s*[*_`>]*\s*(?:🔴|🟠|🟡|⚪)|^\s*[*_`>]*\s*(?:🔴|🟠|🟡|⚪)?\s*\[(?:critical|major|minor|blocker)\]/i
// A heading that is itself a finding («### M-1 (major) — src/a.ts:12 — …»): an id-led heading. It is judged as a line, and it does not open a «kept» section.
const FINDING_HEADING = /^\s{0,3}#{1,6}\s+[*_`]*\s*(?:(?:🔴|🟠|🟡|⚪)\s*)?(?:\[(?:critical|major|minor|blocker)\]\s*)?[*_`]*(?:[CMFm]-?\d+|#\d+)\b/i

/** The lines of a report that are findings in the ledger form: a list item, a table row or an id/severity-led line, outside the «kept / could not verify» sections. */
function findingLines(text) {
  const lines = []
  let heading = ''
  text.split('\n').forEach((raw, index) => {
    const kept = KEPT_SECTION.test(heading)
    if (FINDING_HEADING.test(raw)) {
      if (!kept) lines.push({ text: raw, n: index + 1 })
    } else if (/^\s{0,3}#{1,6}\s/.test(raw) || (!ITEM.test(raw) && raw.trim().length <= 80 && /:[\s*_`]*$/.test(raw.trim()))) {
      // A markdown heading or a short label line that ends with «:» («Deliberately kept:», «**Discarded:**») opens a section.
      // Any other plain line (prose, or a counters line such as «Summary: 🔴 0 · 🟠 1. Discarded at the re-check: 0.») leaves the section as it was.
      heading = raw
    } else if (ITEM.test(raw) && !kept) lines.push({ text: raw, n: index + 1 })
  })
  return lines
}

/** The finding lines for a spec in the report and in the final message, each graded on its own: the report's last «Could not verify» heading must not swallow the message. */
export function findingMatchesIn(spec, ...texts) {
  return texts.flatMap((text) => findingMatches(spec, text ?? ''))
}

/**
 * One line must carry the severity (when asked), the file (and `:line`, when asked), and must not say there is nothing:
 * a negated mention such as «formatTime — no duplicates found» is not a finding.
 */
export function findingMatches(spec, text) {
  const severity = (spec.severity ?? 'any').split('|').map((s) => s.trim())
  const file = new RegExp(spec.file, 'i')
  return findingLines(text).filter(({ text: line }) => {
    if (!severity.includes('any') && !severity.some((name) => SEVERITY[name]?.test(line))) return false
    if (!file.test(line)) return false
    if (spec.line !== undefined) {
      const at = [...line.matchAll(new RegExp(`(?:${spec.file})[\\w./\\\\-]*:(\\d+)(?:[-–](\\d+))?`, 'gi'))]
      const ok = at.some(([, from, to]) =>
        typeof spec.line === 'number'
          ? Number(from) - (spec.tolerance ?? 0) <= spec.line && spec.line <= Number(to ?? from) + (spec.tolerance ?? 0)
          : new RegExp(spec.line).test(from),
      )
      if (!ok) return false
    }
    return [...line.matchAll(new RegExp(spec.file, 'gi'))].some((m) => !negatedTail(line.slice(m.index + m[0].length)))
  })
}

const inputText = (input) => Object.values(input).map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join('\n')
const toolMatches = (spec, call) => new RegExp(`^(?:${spec.tool})$`).test(call.name) && (!spec.input || new RegExp(spec.input, 'i').test(inputText(call.input)))

/**
 * Infrastructure failures visible in a run's stream, which must never be read as a grade: a case MCP server that did not connect (`init.mcp_servers`),
 * and a denied call to a tool the harness itself allowed unrestricted (`result.permission_denials`: the allow list maps wrongly) — except a denial by a plugin hook or a subagent's nested Agent launch.
 * `allowed`: the --allowedTools entries; `mcpNames`: the server names of --mcp-config. A denial of `Bash(...)`-style restricted tools is the normal dontAsk behavior.
 */
export function harnessProblems(events, { allowed = [], mcpNames = [] } = {}) {
  const problems = []
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init')
  for (const name of mcpNames) {
    const server = (init?.mcp_servers ?? []).find((entry) => entry.name === name)
    if (server?.status !== 'connected') problems.push(`mcp server ${name} is ${server?.status ?? 'missing from init'}, not connected`)
  }
  const final = events.filter((event) => event.type === 'result').pop() ?? {}
  const covers = (entry, tool) => entry === tool || (entry.startsWith('mcp__') && !entry.includes('(') && (entry.endsWith('__*') ? tool.startsWith(entry.slice(0, -1)) : tool.startsWith(`${entry}__`)))
  // A denial the allow list does not explain is the product's behavior, not the harness's: a plugin PreToolUse hook rejecting the call (agent-guard on a wrong model), and a
  // nested Agent/Task launch from inside a subagent (Claude Code refuses it).
  const byId = new Map(toolCalls(events).map((call) => [call.id, call]))
  for (const denial of final.permission_denials ?? []) {
    const tool = String(denial.tool_name ?? '')
    const call = byId.get(denial.tool_use_id)
    if (call && /hook (?:error|blocked|rejected)|PreToolUse:\w+ hook/i.test(call.result ?? '')) continue
    if (call?.parent && ['Agent', 'Task'].includes(call.name)) continue
    if (allowed.some((entry) => covers(entry, tool))) problems.push(`${tool} was denied although the harness allows it`)
  }
  return problems
}

/**
 * Where a take_screenshot call's frame really went. The server says so («Saved screenshot to …/x.jpeg.») and rewrites an extension that does not match `format` (x.jpg + jpeg -> x.jpeg),
 * so the requested `filePath` is only the fallback. Shared by the eval grader and by scripts/run-audit.mjs.
 */
export function savedScreenshotPath(result, input = {}) {
  const text = String(result ?? '')
  return /Saved screenshot to (\S+?)\.?(?:\s|$)/.exec(text)?.[1] ?? input.filePath ?? input.path ?? /[\w./~-]+\.(?:png|jpe?g|webp)/.exec(text)?.[0] ?? null
}

/** A path as a transcript names it, made comparable: a relative path against the taker's cwd (when known), macOS /private/tmp and /private/var folded to /tmp and /var. */
export function shotKey(path, cwd) {
  const full = !path.startsWith('/') && cwd ? resolve(cwd, path) : path
  return full.replace(/^\/private(?=\/(?:tmp|var)\/)/, '')
}

/**
 * The one screenshot matcher of the eval grader and of scripts/run-audit.mjs. `takes`: [{ path, cwd?, ts }], the path the tool SAYS it saved (savedScreenshotPath);
 * `reads`: [{ path, ts }], every Read of the pool. A Read opens a take when the folded full paths are equal (a take with no known cwd keeps its relative path and is matched by
 * `/` + that tail), never by a bare basename (`1440.png` is not `dark-1440.png`). A Read marks only the latest take of that path made before it: shooting the same file again
 * overwrites the earlier image unseen. Returns the takes (ordered by ts) with `read` set.
 */
export function matchScreenshotReads(takes, reads) {
  const marked = takes.map((take) => ({ ...take, key: shotKey(take.path, take.cwd), read: false })).sort((a, b) => a.ts - b.ts)
  const keys = new Set(marked.map((take) => take.key))
  const relativeKeys = [...keys].filter((key) => !key.startsWith('/')) // no cwd known: matched by the tail of the Read path
  for (const read of [...reads].sort((a, b) => a.ts - b.ts)) {
    const readKey = shotKey(read.path, null)
    const key = keys.has(readKey) ? readKey : relativeKeys.find((k) => readKey.endsWith(`/${k.replace(/^\.\//, '')}`))
    const before = key === undefined ? [] : marked.filter((take) => take.key === key && take.ts <= read.ts)
    if (before.length) before.at(-1).read = true
  }
  return marked
}

/** Every screenshot a subagent took was later opened with Read (a screenshot nobody looks at proves nothing). */
export function unreadScreenshots(calls) {
  const problems = []
  const takes = []
  calls.forEach((call, index) => {
    if (!/take_screenshot$/.test(call.name) || call.isError) return
    const path = savedScreenshotPath(call.result, call.input)
    if (!path) return problems.push(`a screenshot with no file to open (call ${index + 1})`)
    takes.push({ path, ts: index })
  })
  const reads = calls.flatMap((call, index) => (call.name === 'Read' && !call.isError && call.input.file_path ? [{ path: String(call.input.file_path), ts: index }] : []))
  for (const take of matchScreenshotReads(takes, reads)) if (!take.read) problems.push(`${take.path.split('/').pop()} was taken and never opened with Read`)
  return problems
}

/**
 * The verdict on one agent run. `ctx`: { repo, report, summary, calls, hooks, snapshot, commitsBefore, commitsAfter }.
 * Returns the failure messages and a compact hit/miss mark per expectation, for the ledger.
 */
export function gradeAgent(spec, ctx) {
  const failures = []
  const marks = []
  const mark = (id, ok, message) => {
    marks.push(`${id}${ok ? '+' : '-'}`)
    if (!ok) failures.push(message)
  }
  const haystack = `${ctx.report}\n${ctx.summary}`
  const re = (pattern) => new RegExp(pattern, 'i')
  const readTree = (path) => {
    const full = join(ctx.repo, path)
    if (!existsSync(full)) return ''
    return statSync(full).isDirectory() ? walk(full).map((file) => readFileSync(file, 'utf8')).join('\n') : readFileSync(full, 'utf8')
  }
  ;(spec.expect ?? []).forEach((e, i) => mark(`E${i + 1}`, re(e.pattern).test(haystack), `not found: ${e.why} (/${e.pattern}/)`))
  ;(spec.forbid ?? []).forEach((e, i) => mark(`F${i + 1}`, !re(e.pattern).test(ctx.report), `extra in the report: ${e.why} (/${e.pattern}/)`))
  ;(spec.forbidSummary ?? []).forEach((e, i) => mark(`S${i + 1}`, !re(e.pattern).test(ctx.summary), `extra in the message: ${e.why} (/${e.pattern}/)`))
  ;(spec.findings ?? []).forEach((g, i) => mark(`N${i + 1}`, findingMatchesIn(g, ctx.report, ctx.summary).length > 0, `no finding line: ${g.why} (${g.severity ?? 'any'} /${g.file}/${g.line !== undefined ? `:${g.line}` : ''})`))
  ;(spec.findingsForbid ?? []).forEach((g, i) => {
    const found = findingMatchesIn(g, ctx.report, ctx.summary)
    mark(`M${i + 1}`, found.length === 0, `finding that must not be raised: ${g.why} (${found[0]?.text.trim().slice(0, 120)})`)
  })
  ;(spec.files ?? []).forEach((c, i) => mark(`P${i + 1}`, re(c.pattern).test(readTree(c.path)), `${c.path}: ${c.why} (/${c.pattern}/)`))
  ;(spec.filesForbid ?? []).forEach((c, i) => mark(`Q${i + 1}`, !re(c.pattern).test(readTree(c.path)), `${c.path}: ${c.why} (/${c.pattern}/)`))
  Object.entries(ctx.snapshot ?? {}).forEach(([path, before], i) => {
    const now = existsSync(join(ctx.repo, path)) ? readFileSync(join(ctx.repo, path), 'utf8') : null
    mark(`U${i + 1}`, now === before, `${path} was changed — the agent must not touch it`)
  })
  ;(spec.trace ?? []).forEach((t, i) => {
    // `before: <tool regex>` — only the calls ahead of the first call of that tool count («verify-doctor ran before the first navigation»).
    const cut = t.before ? ctx.calls.findIndex((call) => toolMatches({ tool: t.before }, call)) : -1
    const scope = cut < 0 ? ctx.calls : ctx.calls.slice(0, cut)
    const hits = scope.filter((call) => toolMatches(t, call) && (t.includeDenied || !call.denied)).length
    mark(`T${i + 1}`, hits >= (t.min ?? 1) && hits <= (t.max ?? Infinity), `trace: ${t.why} (${t.tool}${t.input ? ` /${t.input}/` : ''}${t.before ? ` before ${t.before}` : ''}: ${hits} call(s), wanted ${t.min ?? 1}..${t.max ?? '∞'})`)
  })
  ;(spec.traceForbid ?? []).forEach((t, i) => {
    const hit = ctx.calls.find((call) => toolMatches(t, call))
    mark(`V${i + 1}`, !hit, `trace: ${t.why} (${t.tool}${t.input ? ` /${t.input}/` : ''} was called)`)
  })
  if (spec.screenshotsRead) {
    const problems = unreadScreenshots(ctx.calls)
    const shots = ctx.calls.filter((call) => /take_screenshot$/.test(call.name) && !call.isError).length
    const min = spec.screenshotsRead.min ?? 1
    mark('X1', !problems.length && shots >= min, `screenshots: ${problems.join('; ') || `${shots} taken, wanted at least ${min}`}`)
  }
  ;(spec.hooks ?? []).forEach((h, i) => {
    const count = (ctx.hooks ?? []).filter((name) => name === h.event || name.startsWith(`${h.event}:`)).length
    mark(`H${i + 1}`, count >= (h.min ?? 1), `hook ${h.event} fired ${count} time(s): ${h.why}`)
  })
  if (spec.noCommits) mark('C1', ctx.commitsAfter === ctx.commitsBefore, 'the agent made a commit — the orchestrator commits')
  if (spec.maxSummaryLines) {
    const lines = ctx.summary.trim().split('\n').length
    mark('L1', lines <= spec.maxSummaryLines, `summary is ${lines} lines against a cap of ${spec.maxSummaryLines} — it bloats the main context`)
  }
  return { failures, marks }
}

// ── decision cases ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Harness-only PreToolUse hook of a decision case (passed through `--settings`, never part of the plugin): the first Agent/Task or AskUserQuestion call of the
 * orchestrator is denied AND ends the session (`continue: false`). `continue: false` alone does not stop the call — the subagents still launched in the background
 * (measured, Claude Code 2.1.296) — and a deny alone leaves the orchestrator reacting; together the tool does not run and the session ends after that assistant
 * message. The tool_use blocks of the message are already in the stream, so a parallel batch of spawns is captured whole and no subagent runs. The plugin's own
 * agent-guard sits on the same matcher and still runs (two PreToolUse:Agent hook starts per call).
 */
export const SPAWN_STOP_HOOK = `process.stdin.on('data', () => {})
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    continue: false,
    stopReason: 'session ends here',
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Not available in this session.' },
  }))
})
`

export function decisionSettings(work) {
  const dir = join(work, 'hk')
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'gate.mjs')
  writeFileSync(script, SPAWN_STOP_HOOK)
  const path = join(dir, 'settings.json')
  writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Agent|Task|AskUserQuestion', hooks: [{ type: 'command', command: `node "${script}"`, timeout: 5 }] }] } }))
  return path
}

const SPAWN_TOOLS = ['Agent', 'Task']
export const spawnType = (call) => String(call.input?.subagent_type ?? '').replace(/^stage-pipeline:/, '')

/** The `AC-*` IDs of a stage in STAGES.md whose `[verify: …]` tag list names `tag`. */
export function acIdsFor(stagesText, stage, tag) {
  const block = new RegExp(`^### Stage ${stage}\\b[^\\n]*\\n([\\s\\S]*?)(?=^###? |(?![\\s\\S]))`, 'm').exec(stagesText)?.[1] ?? ''
  const ids = []
  for (const line of block.split('\n')) {
    const m = /`(AC-[\w.]+)`.*\[verify:\s*([^\]]*)\]/.exec(line)
    if (m && m[2].split(/[,;]/).map((t) => t.trim()).includes(tag)) ids.push(m[1])
  }
  return ids
}

/** A key of the fixture's pipeline config; `review_model` goes through the plugin's own reader (its `opus` default included), so the grader wants what the hook wants. */
export const configValue = (configText, key) => (key === 'review_model' ? reviewModel(configText) : new RegExp(`^[ \\t]*-[ \\t]*${key}:[ \\t]*[\`*]*([\\w.-]+)`, 'm').exec(configText)?.[1])

/**
 * The lines of a final message that ask the user something: a line outside a code fence, at most 300 characters, that ends with «?» once the closing markdown (`*`, `_`, backticks,
 * quotes, brackets) is stripped, or that OPENS with a request for an answer («Reply with …», «Tell me which …», «Let me know …», «Please choose …», «Which one …»; the
 * saved model runs end a stopped turn with the second form as often as with a «?»). A «?» inside a sentence, in a code span or URL does not count, and neither does a line that only mentions a question; an answer's own
 * rhetorical question on its own line would count (a deliberate over-reach: a force run's final text before the first spawn is short, and the case wants it silent).
 */
const REQUEST_REPLY = /^[\s>#*_\-•\d.)]*(?:reply with|tell me (?:which|what|how|the)|let me know (?:which|what|how|the|if|whether)|please (?:choose|confirm|pick|say|answer)|which (?:one|do you))\b/i
export function questionLines(text) {
  let fenced = false
  const found = []
  for (const raw of String(text).split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const line = raw.replace(/[\s*_`"'»”)\]]+$/u, '').trim()
    if (line.length >= 3 && line.length <= 300 && (line.endsWith('?') || REQUEST_REPLY.test(line))) found.push(line.replace(/^[\s>#*_\-•\d.)]+/, ''))
  }
  return found
}

/**
 * The verdict on a decision case: the orchestrator ran as the main session until its first spawn or question. `ctx`: { calls (top-level), final, hooks, stagesText, configText }.
 *   expectAgents    [name]       subagent types that must be spawned
 *   forbidAgents    [name]       subagent types that must not
 *   agentPrompts    [{ agent, acs?: { tag, stage }, contains?: [{ pattern, why }] }]  — the prompt of that agent carries every `[verify: <tag>]` AC ID of the stage and each pattern
 *   agentModel      [{ agent, model | "config:<key>", why }]  — the `model` parameter of that agent's call (config:<key> reads the fixture's pipeline config)
 *   forbidTools     [{ tool, input?, why }]  — top-level tools the orchestrator must not call (AskUserQuestion)
 *   forbidQuestionEnd { why }  — no spawn happened and the final text has a line asking the user something (`questionLines`): the plain-text form of a question
 *   askQuestion     [{ pattern, why }]  — over the AskUserQuestion input; the final text when the tool did not run
 * and the generic trace / traceForbid / expect / forbidSummary / hooks of gradeAgent over the same calls.
 */
export function gradeDecision(spec, ctx) {
  const generic = gradeAgent(spec, { repo: ctx.repo ?? '', report: '', summary: ctx.final ?? '', calls: ctx.calls, hooks: ctx.hooks, snapshot: {} })
  const failures = [...generic.failures]
  const marks = [...generic.marks]
  const mark = (id, ok, message) => {
    marks.push(`${id}${ok ? '+' : '-'}`)
    if (!ok) failures.push(message)
  }
  const spawns = ctx.calls.filter((call) => SPAWN_TOOLS.includes(call.name))
  const forAgent = (name) => spawns.filter((call) => spawnType(call) === name)
  ;(spec.expectAgents ?? []).forEach((name, i) => mark(`A${i + 1}`, forAgent(name).length > 0, `agent ${name} was not spawned (spawned: ${spawns.map(spawnType).join(', ') || 'none'})`))
  ;(spec.forbidAgents ?? []).forEach((name, i) => mark(`B${i + 1}`, forAgent(name).length === 0, `agent ${name} was spawned but must not be`))
  ;(spec.agentPrompts ?? []).forEach((p, i) => {
    const prompts = forAgent(p.agent).map((call) => String(call.input.prompt ?? ''))
    const wanted = p.acs ? acIdsFor(ctx.stagesText ?? '', p.acs.stage, p.acs.tag) : []
    const missing = []
    if (p.acs && !wanted.length) missing.push(`the fixture has no [verify: ${p.acs.tag}] AC in stage ${p.acs.stage} (broken case)`)
    const prompt = prompts[0]
    if (prompt === undefined) missing.push(`no ${p.agent} call`)
    else {
      for (const id of wanted) if (!new RegExp(`(?<![\\w.-])${id.replaceAll('.', '\\.')}(?![\\w-])`).test(prompt)) missing.push(`${id} missing`)
      for (const c of p.contains ?? []) if (!new RegExp(c.pattern, 'i').test(prompt)) missing.push(`${c.why} (/${c.pattern}/)`)
    }
    mark(`R${i + 1}`, !missing.length, `${p.agent} prompt: ${missing.join('; ')}`)
  })
  ;(spec.agentModel ?? []).forEach((m, i) => {
    const want = m.model.startsWith('config:') ? configValue(ctx.configText ?? '', m.model.slice(7)) : m.model
    const calls = forAgent(m.agent)
    const got = calls.map((call) => String(call.input.model ?? '').toLowerCase())
    mark(`O${i + 1}`, Boolean(calls.length) && Boolean(want) && got.every((model) => model && (model.includes(want.toLowerCase()) || want.toLowerCase().includes(model))), `${m.agent} model: ${m.why ?? ''} wanted ${want}, got ${got.map((model) => model || 'none').join(', ') || 'no call'}`)
  })
  ;(spec.forbidTools ?? []).forEach((t, i) => {
    const hit = ctx.calls.find((call) => toolMatches(t, call))
    mark(`Y${i + 1}`, !hit, `${t.tool} was called: ${t.why}`)
  })
  // `forbidQuestionEnd`: the orchestrator spawned nothing and its final text asks the user something (the turn ends on a question in plain text, which no tool check can see).
  ;(spec.forbidQuestionEnd ? [spec.forbidQuestionEnd] : []).forEach((q, i) => {
    const asked = spawns.length ? [] : questionLines(ctx.final ?? '')
    mark(`K${i + 1}`, !asked.length, `the run ended on a question to the user: ${q.why} («${asked[0]?.slice(0, 120)}»)`)
  })
  ;(spec.askQuestion ?? []).forEach((q, i) => {
    const asks = ctx.calls.filter((call) => call.name === 'AskUserQuestion')
    const text = asks.length ? asks.map((call) => JSON.stringify(call.input)).join('\n') : ctx.final ?? ''
    mark(`Z${i + 1}`, new RegExp(q.pattern, 'i').test(text), `${asks.length ? 'AskUserQuestion input' : 'final text (the tool did not run)'}: ${q.why} (/${q.pattern}/)`)
  })
  return { failures, marks }
}

// ── the ledger ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** `marks` letters: a hit or miss per expectation (+/-), and `W-` for a harness failure (the run says nothing about the agent). */
export const LEDGER_COLUMNS = ['ts', 'invocation', 'case', 'attempt', 'plugin_ref', 'plugin_version', 'plugin_sha', 'claude_version', 'models', 'marks', 'pass', 'cost_usd', 'seconds']

export function appendLedger(row, path = LEDGER) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${LEDGER_COLUMNS.join('\t')}\n`)
  }
  appendFileSync(path, `${LEDGER_COLUMNS.map((column) => String(row[column] ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')}\n`)
}

export function readLedger(path = LEDGER) {
  if (!existsSync(path)) return []
  const [header, ...lines] = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  const columns = header.split('\t')
  return lines.map((line) => Object.fromEntries(line.split('\t').map((value, i) => [columns[i], value])))
}

/** Spent so far (rows at or after `since`, an ISO timestamp) and the mean past cost of a case — the estimate of its next run. */
export function spentSince(rows, since = '') {
  return rows.filter((row) => row.ts >= since).reduce((sum, row) => sum + Number(row.cost_usd || 0), 0)
}

export function meanCost(rows, name) {
  const past = rows.filter((row) => row.case === name && Number(row.cost_usd) > 0)
  return past.length ? past.reduce((sum, row) => sum + Number(row.cost_usd), 0) / past.length : null
}
