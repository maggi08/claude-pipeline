#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain } from './main-guard.mjs'
import { backendConfig, backendFileMatcher, readConfig } from './hooks/pipeline-state.mjs'
import { globToRegExp } from './markers.mjs'
import { bashRulePattern, permissionRules, settingsFiles, subcommands } from './hooks/permission-rules.mjs'
import { shellQuote } from './ci-gates.mjs'
import { loadProfile, overriddenBy } from './permission-profile.mjs'

/**
 * backend-detect — what a Python backend repo has (framework, package manager, test command, compose, API schema), read from its files.
 *
 *   node backend-detect.mjs <repo>                          # what was found + the `## Backend` candidate; read-only
 *   node backend-detect.mjs <repo> --json                   # the same as an object
 *   node backend-detect.mjs <repo> --init [--language ru]   # writes <repo>/.claude/pipeline.config.md ONLY if there is none, then excludes it from git
 *   node backend-detect.mjs <repo> --doctor                 # docker answers, compose file, external networks, the tests collect; exit 1 on a `fail`
 *
 * `--init` is a command, not only prose in /pipeline-init: a session cannot write with its file tools into a neighbouring repo or another worktree.
 * A value that is not found is `—`, never a guess. No YAML parser: compose is read by indentation. Needs only node and git.
 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'dist', 'build', 'site-packages'])
const DASH = '—'
const COMPOSE_NAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
const EXCLUDE_LINES = ['.claude/pipeline.config.md', '.claude/pipeline.config.local.md', '.claude/tasks/']
const DJANGO_MASKS = ['**/views/**', '**/views*.py', '**/serializers/**', '**/serializers*.py', '**/urls/**', '**/urls*.py', '**/models/**', '**/models*.py', '**/migrations/*.py', '**/access_polic*.py']
const FASTAPI_MASKS = ['**/routers/**', '**/routes/**', '**/api/**', '**/schemas/**', '**/models/**']
const COLLECT_TIMEOUT_MS = 300000

const read = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
const isFile = (path) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Repo-relative paths of the files, depth-limited, without caches and virtualenvs. */
function listFiles(root, dir = '', depth = 0, out = []) {
  if (depth > 7 || out.length > 20000) return out
  let entries
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listFiles(root, rel, depth + 1, out)
    } else if (entry.isFile()) out.push(rel)
  }
  return out
}

const depPresent = (text, name) => new RegExp(`(?:^|[^\\w-])${name.replace(/[-_]/g, '[-_]')}(?![\\w-])`, 'im').test(text)

/** `Makefile` targets: `{ name, recipe: [lines] }`, plus its `NAME := value` variables. */
function parseMakefile(text) {
  const targets = []
  const vars = {}
  let current = null
  for (const line of text.split('\n')) {
    const variable = line.match(/^([A-Za-z_]\w*)[ \t]*:?=[ \t]*(.*)$/)
    if (variable) {
      vars[variable[1]] = variable[2].trim()
      current = null
      continue
    }
    const target = line.match(/^([A-Za-z0-9_.-]+)[ \t]*:(?!=)/)
    if (target && target[1] !== '.PHONY') {
      current = { name: target[1], recipe: [] }
      targets.push(current)
    } else if (/^\t/.test(line) && current) current.recipe.push(line.trim().replace(/^[@-]+/, ''))
    else if (!/^\s*$/.test(line)) current = null
  }
  return { targets, vars }
}

const SECRET_SEGMENTS = new Set(['TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASS', 'KEY', 'SK'])
const secretName = (name) => name.split('_').some((part) => SECRET_SEGMENTS.has(part.toUpperCase())) || /(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY)$/.test(name)
const VALUE = '"[^"]*"|\'[^\']*\'|\\S+'
const ASSIGNMENT = new RegExp(`((?:^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)=)(${VALUE})`, 'g')
const maskAssignments = (text) => {
  let out = ''
  let last = 0
  ASSIGNMENT.lastIndex = 0
  for (let m; (m = ASSIGNMENT.exec(text)); ) {
    const [, head, name, value] = m
    if (!secretName(name)) {
      ASSIGNMENT.lastIndex = m.index + head.length - 1 // go on from this name's `=`: the value may hold an assignment (`--env=DB_PASSWORD=x`)
      continue
    }
    const closing = /^["']/.test(head) && !/^["']/.test(value) ? text.indexOf(head[0], m.index + head.length) : -1
    out += `${text.slice(last, m.index)}${head}***`
    last = closing >= 0 ? closing : ASSIGNMENT.lastIndex
    ASSIGNMENT.lastIndex = last
  }
  return out + text.slice(last)
}

/**
 * What is printed (detection, `--json`, `--doctor` rows and the tail of the test output) never carries a secret of the repo: the userinfo of a URL, the value of a
 * `NAME=value` whose name has a segment (split on `_`) TOKEN, SECRET, PASSWORD, PASSWD, PASS, KEY or SK, or ends with TOKEN, SECRET, PASSWORD, PASSWD or KEY
 * (`PGPASSWORD`, `GITHUBTOKEN`), an assignment inside the value of another (`--env=DB_PASSWORD=x`), and the value of `--password x` / `--token x`.
 * The masking affects printed text only, so it errs toward too much (`primary_key=1` is masked); a quoted value is masked whole, with its spaces, and so is the
 * value of a quoted assignment (`-e "PGPASSWORD=a b"`), up to its closing quote.
 */
export const maskSecrets = (text) =>
  maskAssignments(String(text).replace(/(\/\/)[^/@\s]+@/g, '$1***@'))
    .replace(new RegExp(`(--(?:password|passwd|pass|token|secret|api-key|access-key|private-key)(?:=|\\s+))(?:${VALUE})`, 'gi'), '$1***')
const expandVars = (text, vars) => text.replace(/\$\(([A-Za-z_]\w*)\)/g, (whole, name) => vars[name] ?? whole)

/** The compose file read by indentation: service names (which have `build:`) and external networks. */
function parseCompose(text) {
  const services = []
  const external = []
  let top = ''
  let service = null
  let network = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const body = line.trim()
    if (indent === 0) {
      top = body.replace(/:.*$/, '')
      service = null
      network = null
      continue
    }
    if (top === 'services') {
      if (/^[A-Za-z0-9_.-]+:\s*$/.test(body) && (service === null || indent <= service.indent)) {
        service = { name: body.slice(0, -1).trim(), indent, build: false }
        services.push(service)
      } else if (service && indent === service.indent + (service.step ?? (service.step = indent - service.indent)) && /^build:/.test(body)) service.build = true
    } else if (top === 'networks') {
      if (/^[A-Za-z0-9_.-]+:\s*(?:\{.*\})?\s*$/.test(body) && (network === null || indent <= network.indent)) {
        network = { name: body.replace(/:.*$/, ''), indent }
        if (/external:\s*true/.test(body)) external.push(network.name)
      } else if (network && /^external:\s*true\b/.test(body)) external.push(network.name)
    }
  }
  return { services: services.map(({ name, build }) => ({ name, build })), external }
}

const git = (repo, args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 15000 })

export function detect(repoArg) {
  const repo = resolve(repoArg)
  const files = listFiles(repo)
  const pyproject = read(join(repo, 'pyproject.toml')) ?? ''
  // requirements under docs/ are documentation tooling, not the app's dependencies
  const reqFiles = files.filter((f) => !/^docs?\//.test(f) && (/(?:^|\/)requirements[^/]*\.txt$/.test(f) || /^requirements\/[^/]+\.txt$/.test(f)))
  const deps = [pyproject, ...reqFiles.map((f) => read(join(repo, f)) ?? ''), read(join(repo, 'Pipfile')) ?? ''].join('\n')
  const found = {}
  const src = {}

  // framework
  const manage = files.find((f) => /^(?:[^/]+\/)?manage\.py$/.test(f))
  const drf = depPresent(deps, 'djangorestframework') || /rest_framework/.test(deps)
  if (manage || depPresent(deps, 'django')) {
    found.framework = drf ? 'django-drf' : 'django'
    src.framework = manage ?? 'dependencies'
  } else if (depPresent(deps, 'fastapi')) {
    found.framework = 'fastapi'
    src.framework = 'dependencies'
  } else found.framework = null

  // package manager
  if (/\[tool\.poetry\]/.test(pyproject) || isFile(join(repo, 'poetry.lock'))) {
    found.packageManager = 'poetry'
    src.packageManager = isFile(join(repo, 'poetry.lock')) ? 'poetry.lock' : 'pyproject.toml'
  } else if (isFile(join(repo, 'uv.lock'))) {
    found.packageManager = 'uv'
    src.packageManager = 'uv.lock'
  } else if (reqFiles.length) {
    found.packageManager = 'pip'
    src.packageManager = reqFiles[0]
  } else found.packageManager = null
  const runner = { poetry: 'poetry run ', uv: 'uv run ' }[found.packageManager] ?? ''
  const hasPytest = depPresent(deps, 'pytest') || files.some((f) => /(?:^|\/)pytest\.(?:sh|ini)$/.test(f)) || /\[tool\.pytest/.test(pyproject)

  // compose
  const composeFile = COMPOSE_NAMES.find((name) => isFile(join(repo, name)))
  found.compose = null
  found.composeParts = null
  if (composeFile) {
    const parsed = parseCompose(read(join(repo, composeFile)) ?? '')
    const app = parsed.services.find((s) => s.build)
    found.composeParts = { file: composeFile, service: app?.name ?? null, networks: parsed.external }
    found.compose = [composeFile, `service: ${app?.name ?? DASH}`, `networks: ${parsed.external.length ? parsed.external.join(', ') : DASH}`].join(' · ')
    src.compose = composeFile
  }

  // test command: a Makefile target with pytest, ./pytest.sh, uv, poetry, python -m pytest
  const makefile = read(join(repo, 'Makefile'))
  const make = makefile ? parseMakefile(makefile) : { targets: [], vars: {} }
  const pytestTarget = make.targets.find((t) => /test/.test(t.name) && t.recipe.some((l) => /pytest/.test(l))) ?? make.targets.find((t) => t.recipe.some((l) => /pytest/.test(l)))
  found.makeRecipe = pytestTarget ? expandVars(pytestTarget.recipe.find((l) => /pytest/.test(l)), make.vars) : null
  if (pytestTarget) {
    found.testFull = `make ${pytestTarget.name}`
    src.testFull = `Makefile (${pytestTarget.name}: ${maskSecrets(found.makeRecipe)})`
  } else if (files.includes('pytest.sh')) {
    found.testFull = './pytest.sh'
    src.testFull = 'pytest.sh'
  } else if (found.packageManager === 'uv' && hasPytest) {
    found.testFull = 'uv run pytest'
    src.testFull = 'uv.lock + pytest in dependencies'
  } else if (found.packageManager === 'poetry' && hasPytest) {
    found.testFull = 'poetry run pytest'
    src.testFull = 'poetry + pytest in dependencies'
  } else if (hasPytest) {
    found.testFull = 'python -m pytest'
    src.testFull = 'pytest in dependencies'
  } else found.testFull = null
  // the host runner is not on PATH, the repo has a compose service with `build:` (its CI runs pytest there): the tests run in the container
  const hostRunner = { poetry: ['poetry'], uv: ['uv'], pip: ['python3', 'python'] }[found.packageManager]
  const runnerMissing = hostRunner && !hostRunner.some(hostOnPath)
  const viaCompose = Boolean(found.composeParts?.service) && found.testFull && !found.testFull.startsWith('make ') && found.testFull !== './pytest.sh' && runnerMissing
  if (viaCompose) {
    found.testFull = `docker compose run -T --rm --no-deps ${found.composeParts.service} python -m pytest`
    src.testFull = `runner not on PATH → compose service ${found.composeParts.service}`
  }
  // the file-run candidate (`{files:rel+py}`: a container sees the repo elsewhere)
  found.testInDocker = Boolean(found.composeParts?.service) && (viaCompose || found.testFull === './pytest.sh' || /\bdocker\b/.test(found.makeRecipe ?? ''))
  if (!found.testFull) found.test = null
  else if (viaCompose) found.test = `${found.testFull} {files:rel+py}`
  else if (found.testInDocker) found.test = `docker compose run -T --rm --no-deps ${found.composeParts.service} python -m pytest {files:rel+py}`
  else if (found.testFull === './pytest.sh') found.test = './pytest.sh {files:rel+py}'
  else if (found.testFull.startsWith('make ')) found.test = `${runner}pytest {files:rel+py}`
  else found.test = `${found.testFull} {files:rel+py}`

  // lint and type check follow the tests: a runner that is not on PATH and a compose service with `build:` → the tool runs in the container
  const toolViaCompose = Boolean(found.composeParts?.service) && Boolean(runner) && runnerMissing
  const toolRun = (cmd) => (toolViaCompose ? `docker compose run -T --rm --no-deps ${found.composeParts.service} ${cmd}` : `${runner}${cmd}`)
  const toolSrc = (text) => (toolViaCompose ? `${text} → runner not on PATH → compose service ${found.composeParts.service}` : text)

  // lint
  const ruffTarget = make.targets.find((t) => t.recipe.some((l) => /\bruff\b/.test(l)) && !t.recipe.some((l) => /--fix\b/.test(l)))
  const flakeTarget = make.targets.find((t) => t.recipe.some((l) => /\bflake8\b/.test(l)))
  if (ruffTarget || flakeTarget) {
    const target = ruffTarget ?? flakeTarget
    found.lint = `make ${target.name}`
    src.lint = `Makefile (${target.name})`
  } else if (depPresent(deps, 'ruff') || /\[tool\.ruff/.test(pyproject)) {
    found.lint = toolRun('ruff check')
    src.lint = toolSrc('ruff in dependencies / pyproject.toml')
  } else found.lint = null

  // type check
  if (isFile(join(repo, 'ty.toml'))) {
    found.typeCheck = found.packageManager === 'uv' || !toolViaCompose ? 'uv run ty check' : toolRun('ty check')
    src.typeCheck = toolSrc('ty.toml')
  } else if (isFile(join(repo, 'mypy.ini')) || /\[tool\.mypy\]/.test(pyproject) || /^\[mypy\]/m.test(read(join(repo, 'setup.cfg')) ?? '')) {
    found.typeCheck = toolRun('mypy .')
    src.typeCheck = toolSrc('mypy config')
  } else found.typeCheck = null

  // API schema
  if (found.framework === 'fastapi') found.apiSchema = 'auto (FastAPI /openapi.json)'
  else if (depPresent(deps, 'drf_yasg') || depPresent(deps, 'drf_spectacular')) {
    const schemaFile = files.filter((f) => f.endsWith('.py')).find((f) => /get_schema_view|SpectacularAPIView/.test(read(join(repo, f)) ?? ''))
    found.apiSchema = schemaFile ?? null
    if (schemaFile) src.apiSchema = schemaFile
  } else found.apiSchema = null

  // api_files masks: only those that match at least one repo file
  const masks = found.framework === 'fastapi' ? FASTAPI_MASKS : found.framework ? DJANGO_MASKS : []
  found.apiFiles = masks.filter((mask) => {
    const re = globToRegExp(mask)
    return files.some((f) => re.test(f))
  })
  found.claudeMd = isFile(join(repo, 'CLAUDE.md'))
  // a backend is a framework, a Python test runner, or an app entry (manage.py, `src/` or a package with .py files) beside a manifest; a manifest alone is tooling
  const hasManifest = Boolean(pyproject) || reqFiles.length > 0
  const appCode = files.some((f) => /^src\/.*\.py$/.test(f) || /^[^/]+\/__init__\.py$/.test(f))
  found.hasBackend = Boolean(found.framework || manage || hasPytest || (hasManifest && appCode))
  found.sources = src
  return { repo, ...found }
}

/** The `## Backend` candidate, one repo form. */
export function backendSection(d) {
  const v = (x) => x ?? DASH
  return [
    '## Backend',
    '<!-- Only for a backend repo; without this section the backend checks are off. -->',
    `- framework: ${v(d.framework)}`,
    `- test: ${v(d.test)}`,
    `- test_full: ${v(d.testFull)}`,
    `- lint: ${v(d.lint)}`,
    `- type_check: ${v(d.typeCheck)}`,
    `- compose: ${v(d.compose)}`,
    `- test_env: ${DASH}`,
    `- api_files: ${d.apiFiles.length ? d.apiFiles.join(', ') : DASH}`,
    `- api_schema: ${v(d.apiSchema)}`,
    `- auth: ${DASH}`,
    `- contracts: ${DASH}`,
  ].join('\n')
}

function mainBranch(repo) {
  const head = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head.status === 0 && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, '')
  return null
}

const STACK = { 'django-drf': 'Python / Django / DRF', django: 'Python / Django', fastapi: 'Python / FastAPI' }

export function configText(d, language) {
  const v = (x) => x ?? DASH
  const name = basename(d.repo)
  return `${[
    `# Pipeline config — ${name}`,
    `<!-- Read by the pipeline skills. Edit by hand when the project changes. Written by backend-detect.mjs --init: a value that is not found is ${DASH}, not a guess. -->`,
    '',
    '## Project',
    `- slug: ${name}`,
    `- stack: ${STACK[d.framework] ?? 'Python'}`,
    `- package_manager: ${v(d.packageManager)}`,
    `- main_branch: ${v(mainBranch(d.repo))}`,
    ...(language ? [`- language: ${language}`] : []),
    '',
    '## Task state',
    '- task_path: .claude/tasks/',
    '',
    '## Commands',
    `- dev: ${DASH}`,
    `- lint: ${v(d.lint)}`,
    `- type_check: ${v(d.typeCheck)}`,
    `- test: ${v(d.testFull)}`,
    '',
    '## Models',
    '- review_model: opus',
    '',
    backendSection(d),
    '',
    '## Dev server',
    `- url: ${DASH}`,
    '',
    '## Design sources of truth (figma-compare / figma-spec)',
    `- tokens: ${DASH}`,
    `- palette: ${DASH}`,
    `- ui_lib: ${DASH}`,
    `- breakpoints: ${DASH}`,
    `- icons: ${DASH}`,
    `- i18n: ${DASH}`,
    '',
    '## Conventions',
    d.claudeMd ? '- The project conventions are in CLAUDE.md (pro-review rubric A reads it).' : '- No CLAUDE.md — suggest `/init`, so that pro-review has something to rely on.',
  ].join('\n')}\n`
}

/** Write the config if there is none, then keep it out of git. Returns the lines to print. */
export function init(repoArg, language) {
  const d = detect(repoArg)
  const out = []
  const path = join(d.repo, '.claude/pipeline.config.md')
  if (existsSync(path)) return { out: [`${path}: exists, not touched`] }
  if (!d.hasBackend) return { out: [`${d.repo}: no backend found (no framework, pytest or app code beside a manifest) — nothing written`] }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, configText(d, language))
  out.push(`${path}: written`)
  if (git(d.repo, ['rev-parse', '--git-dir']).status !== 0) return { out: [...out, 'not a git repo — nothing excluded'] }
  if (git(d.repo, ['check-ignore', '-q', '.claude/pipeline.config.md']).status === 0) return { out: [...out, 'already ignored by git — exclude not touched'] }
  const excludePath = resolve(d.repo, git(d.repo, ['rev-parse', '--git-path', 'info/exclude']).stdout.trim())
  const current = read(excludePath) ?? ''
  const have = new Set(current.split('\n').map((l) => l.trim()))
  const add = EXCLUDE_LINES.filter((l) => !have.has(l))
  if (add.length) {
    mkdirSync(dirname(excludePath), { recursive: true })
    appendFileSync(excludePath, `${current && !current.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`)
  }
  out.push(`${excludePath}: ${add.length ? `added ${add.join(', ')}` : 'lines already there'}`)
  return { out }
}

const extraPath = () => `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin`
const hostOnPath = (name) => (process.env.PATH ?? '').split(':').some((dir) => dir && isFile(join(dir, name)))
const onPath = (name) => extraPath().split(':').some((dir) => dir && isFile(join(dir, name)))

function dockerRemedy() {
  if (onPath('colima')) return 'colima start (or `brew services start colima` if colima runs as a brew service)'
  if (existsSync('/Applications/Docker.app')) return 'start Docker Desktop (`open -a Docker`)'
  return 'install and start Docker (colima or Docker Desktop)'
}

const docker = (args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: extraPath() } })
const tailLines = (text, n = 6) => text.split('\n').filter((l) => l.trim() && !/^\S+::/.test(l)).slice(-n).join(' | ')

/** The command that collects the tests without running them, or `{ skip }`. `cfgTestFull` is `test_full` of the repo's own config: it wins over detection. */
function collectCommand(d, cfgTestFull) {
  const base = cfgTestFull ?? d.testFull
  if (!base) return { skip: 'no pytest command found' }
  if (base === './pytest.sh') return { skip: './pytest.sh builds an image and runs it — heavy; run it by hand with --collect-only as its argument' }
  if (base.startsWith('make ')) {
    const folders = d.makeRecipe ? d.makeRecipe.replace(/^.*?pytest\s*/, '') : ''
    if (d.testInDocker) return { command: `docker compose run -T --rm --no-deps ${d.composeParts.service} python -m pytest --collect-only -q${folders ? ` ${folders}` : ''}`, needsDocker: true }
    return d.makeRecipe ? { command: `${d.makeRecipe} --collect-only -q`, needsDocker: /docker/.test(d.makeRecipe) } : { skip: `cannot read the recipe of \`${base}\`` }
  }
  return { command: `${base} --collect-only -q`, needsDocker: /docker/.test(base) }
}

/** The allow/ask/deny lists of the settings the session sees (`settingsFiles`, the set force-guard reads too). `files` replaces them (the unit points it at temp files). */
function settingsLists(repo, files) {
  const sources = files ?? settingsFiles(repo)
  const list = (kind) => permissionRules(kind, sources).map(({ rule }) => rule)
  return { allow: list('allow'), ask: list('ask'), deny: list('deny') }
}

/** Is `command` allowed by the settings: some allow rule covers it (`Bash(*)` too) and no ask/deny rule beats it. Returns `{ ok }` or `{ ok: false, beatenBy }`. */
function commandAllowed(command, lists) {
  const covers = (rule) => rule === 'Bash' || rule === 'Bash(*)' || bashRulePattern(rule)?.test(command)
  if (!lists.allow.some(covers)) return { ok: false }
  const beaten = overriddenBy(`Bash(${command})`, lists)
  if (beaten) return { ok: false, beatenBy: beaten }
  return { ok: true }
}

const FILES_TOKEN = /\{files[^}]*\}/g
const dockerWords = (words) => (words[0] === 'docker' || words[0] === 'docker-compose' ? words : null)

/**
 * The docker command the repo's tests start, which api-verify must be allowed to run, or null when the tests run on the host.
 * api-verify runs the config's `test` (its `{files…}` placeholder replaced by a path): that line decides, a host one gives no row.
 * Only a repo without `test` falls back to what the detection reads: `test_full`, the Makefile recipe, `./pytest.sh`.
 */
function dockerProbe(d, cfg, plan) {
  if (cfg?.test) {
    // the permission is judged on a real path in place of `{files…}`; the rows show the config's own line (VT-15 delta nit: they printed `app/models.py`)
    const words = subcommands(cfg.test.replace(FILES_TOKEN, 'app/models.py')).map(dockerWords).find(Boolean)
    if (!words) return null
    const shown = subcommands(cfg.test).map(dockerWords).find(Boolean)?.join(' ')
    return { command: words.join(' '), shown, note: 'the tests run in docker', compose1: words[0] === 'docker-compose' }
  }
  const text = [cfg?.testFull, d.testFull, d.makeRecipe].filter(Boolean).join('\n')
  if ((cfg?.testFull ?? d.testFull) === './pytest.sh') return { command: 'docker build', note: '`./pytest.sh` builds an image and runs it' }
  const found = text.match(/\bdocker(?:-compose|\s+compose)?\s+(?:run|exec|build)\b/)?.[0]?.replace(/\s+/g, ' ')
  if (found) return { command: found, note: 'the tests run in docker', compose1: found.startsWith('docker-compose') }
  if (d.testInDocker || plan.needsDocker || /\bdocker\b/.test(text)) return { command: 'docker compose run', note: 'the tests run in docker' }
  return null
}

export function doctor(repoArg, { settingsFiles: files } = {}) {
  const d = detect(repoArg)
  const rows = []
  const row = (status, check, todo) => rows.push(maskSecrets(`${status} — ${check} — ${todo}`))
  const info = docker(['info', '--format', '{{.ServerVersion}}'])
  const dockerOk = info.status === 0
  if (dockerOk) row('ok', 'docker answers', `server ${info.stdout.trim()}`)
  else row('fail', 'docker does not answer', `${info.error ? (info.error.code ?? info.error.message) : tailLines(info.stderr || info.stdout, 2)}; ${dockerRemedy()}`)

  if (!d.composeParts) row('skip', 'compose file', 'none in the repo (docker-compose.yml, compose.yml): nothing to check')
  else {
    row('ok', 'compose file', d.composeParts.file)
    for (const net of d.composeParts.networks) {
      if (!dockerOk) row('skip', `external network ${net}`, 'docker is down — start it first')
      else if (docker(['network', 'inspect', net]).status === 0) row('ok', `external network ${net}`, 'exists')
      else row('fail', `external network ${net}`, `docker network create ${net}`)
    }
  }

  const cfgText = read(join(d.repo, '.claude/pipeline.config.md'))
  const cfg = cfgText ? backendConfig(cfgText, d.repo)?.repos?.[0] : null
  // VT-15 d-6: a glob the hooks refuse is skipped there without a word, and the files it names are never judged as backend code. Read as the hooks read it:
  // the local config over the shared one, every repo of the section (a frontend repo's `###` blocks of its backend repos too)
  const hookRepos = backendConfig(readConfig(d.repo), d.repo)?.repos ?? []
  for (const repo of hookRepos) {
    const where = hookRepos.length > 1 && repo.name ? ` (${repo.name})` : ''
    for (const { glob, reason } of backendFileMatcher(repo).skipped) row('fail', `api_files glob \`${glob}\`${where}`, `${reason}; until then the hooks skip it and do not treat its files as backend code`)
  }
  const plan = collectCommand(d, cfg?.testFull)
  const probe = dockerProbe(d, cfg, plan)
  if (probe) {
    const verdict = commandAllowed(probe.command, settingsLists(d.repo, files))
    if (verdict.ok) row('ok', 'permissions', `\`${probe.shown ?? probe.command}\` is allowed in the Claude settings`)
    else {
      const why = verdict.beatenBy ? `the ${verdict.beatenBy.key} rule \`${verdict.beatenBy.rule}\` beats the allow entry (remove it or keep the question knowingly)` : `no allow entry covers \`${probe.shown ?? probe.command}\``
      const fix = verdict.beatenBy ? '' : probe.compose1 ? ': add `Bash(docker-compose *)` to the allow list by hand (the docker group covers only `docker compose`)' : `: node ${shellQuote(fileURLToPath(new URL('./permissions.mjs', import.meta.url)))} --apply --groups ${[...loadProfile(resolve(dirname(fileURLToPath(import.meta.url)), '..')).defaultGroups, 'docker'].join(',')}`
      row('fail', 'permissions', `${probe.note} and ${why}, so api-verify stops on a permission question${fix}`)
    }
  }
  if (plan.skip) row('skip', 'tests collect', plan.skip)
  else if (plan.needsDocker && !dockerOk) row('skip', 'tests collect', `needs docker (\`${plan.command}\`)`)
  else {
    const started = Date.now()
    const run = spawnSync('sh', ['-c', plan.command], { cwd: d.repo, encoding: 'utf8', timeout: COLLECT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PATH: extraPath() } })
    const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
    const count = text.match(/(\d+)(?:\/\d+)? tests? collected/)?.[1]
    const secs = Math.round((Date.now() - started) / 1000)
    if (run.status === 0 && count) row('ok', 'tests collect', `${count} tests collected in ${secs}s (\`${plan.command}\`)`)
    else if (run.error?.code === 'ETIMEDOUT') row('fail', 'tests collect', `timeout after 5 min (\`${plan.command}\`): ${tailLines(text)}`)
    else row('fail', 'tests collect', `exit ${run.status} (\`${plan.command}\`): ${tailLines(text)}`)
  }
  return { rows, code: rows.some((r) => r.startsWith('fail')) ? 1 : 0 }
}

function printDetection(d) {
  const lines = [`repo: ${d.repo}`]
  if (!d.hasBackend) return [...lines, 'no backend (no framework, pytest or app code beside a manifest)'].join('\n')
  const show = (label, value, source) => lines.push(`${label}: ${value ?? DASH}${source ? `   [${source}]` : ''}`)
  show('framework', d.framework, d.sources.framework)
  show('package manager', d.packageManager, d.sources.packageManager)
  show('test command', d.testFull, d.sources.testFull)
  show('test (stage files)', d.test, d.testInDocker ? 'in the compose service' : null)
  show('lint', d.lint, d.sources.lint)
  show('type check', d.typeCheck, d.sources.typeCheck)
  show('compose', d.compose, d.sources.compose)
  show('api schema', d.apiSchema, d.sources.apiSchema)
  lines.push(`CLAUDE.md: ${d.claudeMd ? 'yes' : 'no'}`, '', backendSection(d))
  return lines.join('\n')
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const repoArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--language')
  const language = args.includes('--language') ? args[args.indexOf('--language') + 1] : null
  if (!repoArg || !existsSync(repoArg) || (language && !/^(?:ru|en)$/.test(language))) {
    console.error('usage: backend-detect.mjs <repo> [--json | --init [--language ru|en] | --doctor]')
    process.exit(2)
  }
  if (args.includes('--init')) console.log(init(repoArg, language).out.join('\n'))
  else if (args.includes('--doctor')) {
    const { rows, code } = doctor(repoArg)
    console.log(rows.join('\n'))
    process.exitCode = code
  } else if (args.includes('--json')) console.log(JSON.stringify(detect(repoArg), (key, value) => (typeof value === 'string' ? maskSecrets(value) : value), 2))
  else console.log(maskSecrets(printDetection(detect(repoArg))))
}
