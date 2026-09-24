#!/usr/bin/env node
/**
 * Регрессионные прогоны агентов плагина на фикстурах с заложенными дефектами.
 *
 *   node scripts/eval.mjs                          # все кейсы, по одному прогону
 *   node scripts/eval.mjs dead-code-orphan i18n-hardcode
 *   node scripts/eval.mjs --runs 3 --model i18n-sweep=haiku i18n-hardcode
 *   node scripts/eval.mjs --list
 *
 * Правило в скилле ничего не стоит, пока не проверено, что агент с ним ловит свой класс дефектов —
 * и что следующая правка скилла этого не сломала. Кейс — это evals/cases/<name>/:
 *   case.json   агент, промпт, ожидания
 *   base/       исходное дерево (коммит «base»)
 *   stages/N/   слои, которые коммитятся по очереди поверх base («stage N»)
 *   working/    слой, который остаётся незакоммиченным (диф текущего этапа)
 * Файл с содержимым `__DELETE__` в слое удаляет файл.
 *
 * Ожидания в case.json:
 *   expect / forbid   регэкспы по отчёту в checks/ (+ финальное сообщение для expect)
 *   files             [{ path, pattern, why }] — файл (или все файлы каталога) после прогона обязан совпасть
 *   filesForbid       [{ path, pattern, why }] — и обязан НЕ совпасть
 *   unchanged         [path] — файлы, которые агент не вправе трогать
 *   noCommits         агент не делает коммитов (для maker-агентов: коммит — работа оркестратора)
 *   maxSummaryLines   предел длины финального сообщения — оно целиком идёт в главный контекст
 *   requireReport     false — агент не пишет отчёт в checks/ (maker или справочный агент)
 *   forbidSummary     регэкспы, которых не должно быть в финальном сообщении
 *   mcp               ["context7"] — MCP-серверы плагина, которые нужны кейсу (остальные отключены).
 *                     Context7 без CONTEXT7_API_KEY отвечает 401 — такой кейс пропускается, а не падает.
 *
 * Кейс маршрутизации (`"kind": "routing"`, без `agent`) проверяет не работу скилла, а то, вызовет ли
 * его модель по обычной фразе: промпт уходит в главную сессию с плагином, из потока событий берутся
 * вызовы Skill (и Agent с subagent_type плагина), прогон обрывается через пару ходов.
 *   expectSkill       имя скилла/агента плагина, который обязан быть вызван первым
 *   forbidSkills      [имя] — не должны быть вызваны вовсе
 *   base              путь к base/ другого кейса (своего дерева у кейса маршрутизации обычно нет)
 * Лексическое приближение того же — scripts/routing.mjs (бесплатно, в CI); здесь — сама модель.
 *
 * --model <agent>=<model> прогоняет кейсы на копии плагина, где у агента переписан `model:` во
 * frontmatter, — так сравнивают модели на одних и тех же кейсах. Какая модель реально отработала,
 * видно по modelUsage из JSON-вывода claude и печатается в сводке. --runs N повторяет каждый кейс:
 * модель недетерминирована, один прогон — это анекдот, а не замер.
 *
 * Прогон идёт по рабочей копии плагина (--plugin-dir) без пользовательских настроек
 * (--setting-sources project), поэтому установленная версия плагина на результат не влияет.
 * Каждый прогон — реальный вызов модели (лимит подписки или деньги по API-ключу): не в CI,
 * а перед релизом, где менялись агенты.
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
// task_path фикстур — tasks/, а не .claude/tasks/: запись в .claude/ защищена и в режиме dontAsk отклоняется.
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
  console.error(`Нет кейсов: ${unknown.join(', ')}. Список: --list`)
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
      if (!agent || !model) fail('--model ждёт <agent>=<model>, например i18n-sweep=haiku')
      result.overrides[agent] = model
    } else result.names.push(argv[i])
  }
  if (!Number.isInteger(result.runs) || result.runs < 1) fail('--runs ждёт целое число ≥ 1')
  return result
}

function fail(message) {
  console.error(message)
  process.exit(2)
}

function readCase(name) {
  return JSON.parse(readFileSync(join(CASES, name, 'case.json'), 'utf8'))
}

/** Копия плагина с переписанным `model:` у агентов из --model; без переопределений — сам плагин. */
function preparePlugin(overrides) {
  if (!Object.keys(overrides).length) return SOURCE_PLUGIN
  const copy = mkdtempSync(join(tmpdir(), 'stage-pipeline-plugin-'))
  cpSync(SOURCE_PLUGIN, copy, { recursive: true })
  for (const [agent, model] of Object.entries(overrides)) {
    const path = join(copy, 'agents', `${agent}.md`)
    if (!existsSync(path)) fail(`нет агента ${agent}`)
    const text = readFileSync(path, 'utf8')
    if (!/^model: .*$/m.test(text)) fail(`у агента ${agent} нет поля model во frontmatter`)
    writeFileSync(path, text.replace(/^model: .*$/m, `model: ${model}`))
  }
  return copy
}

/**
 * --mcp-config только с серверами, которые кейс попросил; ${CLAUDE_PLUGIN_ROOT} раскрыт вручную.
 * Имя сервера уникально на прогон (но содержит исходное — ToolSearch агента ищет по нему): Claude Code
 * кэширует needs-auth по имени сервера, и один неудачный прогон иначе отравил бы все следующие.
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
  if ((spec.mcp ?? []).includes('context7') && !process.env.CONTEXT7_API_KEY) return 'нет CONTEXT7_API_KEY — хостед Context7 без ключа отвечает 401'
  return null
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

// Файл — его содержимое; каталог — все файлы подряд (для «нигде в src/ нет второй копии»).
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

/** Вызовы скиллов и агентов плагина по порядку из потока stream-json: `stage-pipeline:root-cause` → `root-cause`. */
function invokedSkills(events) {
  const names = []
  for (const event of events) {
    for (const block of event.type === 'assistant' ? event.message?.content ?? [] : []) {
      if (block.type !== 'tool_use') continue
      const raw =
        block.name === 'Skill' ? block.input?.skill ?? block.input?.command : ['Agent', 'Task'].includes(block.name) ? block.input?.subagent_type : null
      const name = raw && String(raw).replace(/^\/?(stage-pipeline:)?/, '')
      // Встроенные агенты (Explore, general-purpose) — не маршрут в плагин: считаем только скиллы и агентов плагина.
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
      // Skill разрешён: отказ в разрешении подменил бы выбор модели. Дальше пары ходов прогон не нужен.
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
  // Упавший прогон (лимит сессии, ошибка API) не вызывает скиллов — без этой проверки он засчитал бы forbidSkills.
  // Обрыв по --max-turns / --max-budget-usd — штатный конец кейса маршрутизации: выбор к этому моменту уже сделан.
  const stoppedByLimit = /^error_max_(turns|budget)/.test(final.subtype ?? '')
  if (!events.length || !Object.keys(final.modelUsage ?? {}).length || (final.is_error && !stoppedByLimit)) {
    failures.push(`claude не отработал: код ${result.status}, ${String(final.result ?? result.stderr ?? '').trim().slice(0, 200)}`)
  }
  if (spec.expectSkill && invoked[0] !== spec.expectSkill) failures.push(`первым вызван ${invoked[0] ?? 'ни один скилл'}, ждали ${spec.expectSkill}`)
  for (const forbidden of spec.forbidSkills ?? []) {
    if (invoked.includes(forbidden)) failures.push(`вызван ${forbidden}, а не должен`)
  }

  mkdirSync(RESULTS, { recursive: true })
  const saved = join(RESULTS, `${name}--${label.replace(/[^\w=,-]/g, '_')}--${attempt}.md`)
  writeFileSync(
    saved,
    `# ${name} (${label}, прогон ${attempt})\n\nВызваны: ${invoked.join(' → ') || '—'} · конец: ${final.subtype ?? '—'}\n\n` +
      `## Провалы\n\n${failures.map((f) => `- ${f}`).join('\n') || '—'}\n\n## Ответ\n\n${final.result ?? ''}\n`,
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
  const prompt = spec.requireReport === false ? spec.prompt : `${spec.prompt}\n\nОтчёт сохрани в ${CHECKS}/ по конвенции имени отчёта.`

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
    // В -p серверы из --mcp-config подключаются асинхронно: без этого агент успевает решить,
    // что тулов нет, раньше, чем сервер поднялся.
    { cwd: repo, encoding: 'utf8', timeout: (spec.timeoutSec ?? 600) * 1000, env: { ...process.env, MCP_CONNECTION_NONBLOCKING: 'false' } },
  )
  const seconds = Math.round((Date.now() - started) / 1000)

  let output = {}
  try {
    output = JSON.parse(result.stdout ?? '')
  } catch {
    // не JSON — claude упал до вывода; причина в stderr
  }
  const summary = output.result ?? ''
  const cost = output.total_cost_usd ?? 0
  const models = Object.keys(output.modelUsage ?? {})

  // Имя файла — забота конвенции скилла, кейс проверяет только, что отчёт вообще сохранён.
  const checksDir = join(repo, CHECKS)
  const report = existsSync(checksDir)
    ? walk(checksDir).filter((file) => file.endsWith('.md')).map((file) => readFileSync(file, 'utf8')).join('\n')
    : ''
  const haystack = `${report}\n${summary}`
  const failures = []
  if (result.status !== 0 || output.is_error) failures.push(`claude: код ${result.status}, ${output.subtype ?? ''} ${(result.stderr ?? '').trim().slice(0, 300)}`)
  if (!report && spec.requireReport !== false) failures.push(`отчёт не сохранён в ${CHECKS}/`)
  for (const expectation of spec.expect ?? []) {
    if (!new RegExp(expectation.pattern, 'i').test(haystack)) failures.push(`не найдено: ${expectation.why} (/${expectation.pattern}/)`)
  }
  for (const expectation of spec.forbid ?? []) {
    if (new RegExp(expectation.pattern, 'i').test(report)) failures.push(`лишнее в отчёте: ${expectation.why} (/${expectation.pattern}/)`)
  }
  for (const expectation of spec.forbidSummary ?? []) {
    if (new RegExp(expectation.pattern, 'i').test(summary)) failures.push(`лишнее в сообщении: ${expectation.why} (/${expectation.pattern}/)`)
  }
  for (const check of spec.files ?? []) {
    if (!new RegExp(check.pattern, 'i').test(readTree(join(repo, check.path)))) failures.push(`${check.path}: ${check.why} (/${check.pattern}/)`)
  }
  for (const check of spec.filesForbid ?? []) {
    if (new RegExp(check.pattern, 'i').test(readTree(join(repo, check.path)))) failures.push(`${check.path}: ${check.why} (/${check.pattern}/)`)
  }
  for (const [path, before] of Object.entries(snapshot)) {
    if (readIfExists(join(repo, path)) !== before) failures.push(`${path} изменён — агенту трогать его нельзя`)
  }
  if (spec.noCommits && git(repo, 'rev-list', '--count', 'HEAD').trim() !== commitsBefore) failures.push('агент сделал коммит — коммитит оркестратор')
  const summaryLines = summary.trim().split('\n').length
  if (spec.maxSummaryLines && summaryLines > spec.maxSummaryLines) failures.push(`сводка ${summaryLines} строк при пределе ${spec.maxSummaryLines} — раздувает главный контекст`)

  mkdirSync(RESULTS, { recursive: true })
  const saved = join(RESULTS, `${name}--${label.replace(/[^\w=,-]/g, '_')}--${attempt}.md`)
  const denials = (output.permission_denials ?? []).map((denial) => `- ${denial.tool_name}: ${JSON.stringify(denial.tool_input).slice(0, 200)}`)
  writeFileSync(
    saved,
    `# ${name} (${label}, прогон ${attempt})\n\nМодели: ${models.join(', ') || '—'} · $${cost.toFixed(3)} · ${seconds}s\n\n` +
      `## Провалы\n\n${failures.map((f) => `- ${f}`).join('\n') || '—'}\n\n## Отказы в разрешениях\n\n${denials.join('\n') || '—'}\n\n` +
      `## Отчёт агента\n\n${report || '(нет)'}\n\n## Финальное сообщение\n\n${summary}\n`,
  )
  rmSync(repo, { recursive: true, force: true })
  return { failures, seconds, cost, models, saved }
}

const table = []
for (const name of selected) {
  const skip = skipReason(readCase(name))
  if (skip) {
    console.log(`⏭ ${name} — пропущен: ${skip}`)
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
    if (failures.length) console.log(`    полный вывод: ${relative(ROOT, saved)}`)
  }
  table.push(row)
}

console.log(`\n## ${label}, прогонов на кейс: ${runs}\n`)
console.log('| Кейс | Прошло | Модели | $ за прогон | с за прогон |')
console.log('|---|---|---|---|---|')
for (const row of table) {
  console.log(`| ${row.name} | ${row.passed}/${runs} | ${[...row.models].join(', ')} | ${(row.cost / runs).toFixed(3)} | ${Math.round(row.seconds / runs)} |`)
}
const total = table.reduce((sum, row) => sum + row.cost, 0)
console.log(`\nИтого: ${table.reduce((s, r) => s + r.passed, 0)}/${table.length * runs} прогонов, $${total.toFixed(2)}`)
if (plugin !== SOURCE_PLUGIN) rmSync(plugin, { recursive: true, force: true })
process.exit(table.every((row) => row.passed === runs) ? 0 : 1)
