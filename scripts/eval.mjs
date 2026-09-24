#!/usr/bin/env node
/**
 * Регрессионные прогоны чекеров на фикстурах с заложенными дефектами.
 *
 *   node scripts/eval.mjs                 # все кейсы
 *   node scripts/eval.mjs dead-code-orphan i18n-hardcode
 *   node scripts/eval.mjs --list
 *
 * Правило в скилле ничего не стоит, пока не проверено, что агент с ним ловит свой класс дефектов —
 * и что следующая правка скилла этого не сломала. Кейс — это evals/cases/<name>/:
 *   case.json   агент, промпт, ожидания к отчёту
 *   base/       исходное дерево (коммит «base»)
 *   stages/N/   слои, которые коммитятся по очереди поверх base («stage N»)
 *   working/    слой, который остаётся незакоммиченным (диф текущего этапа)
 * Файл с содержимым `__DELETE__` в слое удаляет файл.
 *
 * Ожидания в case.json:
 *   expect / forbid   регэкспы по отчёту в checks/ (+ stdout для expect)
 *   files             [{ path, pattern, why }] — файл (или все файлы каталога) после прогона обязан совпасть
 *   filesForbid       [{ path, pattern, why }] — и обязан НЕ совпасть
 *   unchanged         [path] — файлы, которые агент не вправе трогать
 *   noCommits         агент не делает коммитов (для maker-агентов: коммит — работа оркестратора)
 *   maxSummaryLines   предел длины финального сообщения — оно целиком идёт в главный контекст
 *   requireReport     false — агент не пишет отчёт в checks/ (maker, а не checker)
 *
 * Прогон идёт по рабочей копии плагина (--plugin-dir) без пользовательских настроек
 * (--setting-sources project), поэтому установленная версия плагина на результат не влияет.
 * Каждый кейс — реальный вызов модели и стоит денег: не в CI, а перед релизом, где менялись чекеры.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CASES = join(ROOT, 'evals/cases')
const PLUGIN = join(ROOT, 'plugins/stage-pipeline')
// task_path фикстур — tasks/, а не .claude/tasks/: запись в .claude/ защищена и в режиме dontAsk отклоняется.
const CHECKS = 'tasks/EVAL-1/checks'

const args = process.argv.slice(2)
const all = readdirSync(CASES).filter((name) => existsSync(join(CASES, name, 'case.json')))
if (args.includes('--list')) {
  for (const name of all) console.log(`${name} — ${JSON.parse(readFileSync(join(CASES, name, 'case.json'), 'utf8')).why}`)
  process.exit(0)
}
const selected = args.length ? args : all
const unknown = selected.filter((name) => !all.includes(name))
if (unknown.length) {
  console.error(`Нет кейсов: ${unknown.join(', ')}. Список: --list`)
  process.exit(2)
}

const git = (cwd, ...cmd) => execFileSync('git', cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })

function applyLayer(layer, repo) {
  for (const file of walk(layer)) {
    const target = join(repo, relative(layer, file))
    if (readFileSync(file, 'utf8').trim() === '__DELETE__') rmSync(target, { force: true })
    else cpSync(file, target)
  }
}

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

function buildRepo(caseDir) {
  const repo = mkdtempSync(join(tmpdir(), 'stage-pipeline-eval-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'eval@example.com')
  git(repo, 'config', 'user.name', 'eval')
  cpSync(join(caseDir, 'base'), repo, { recursive: true })
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

function runCase(name) {
  const caseDir = join(CASES, name)
  const spec = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8'))
  const repo = buildRepo(caseDir)
  const snapshot = Object.fromEntries((spec.unchanged ?? []).map((path) => [path, readIfExists(join(repo, path))]))
  const commitsBefore = git(repo, 'rev-list', '--count', 'HEAD').trim()
  const prompt = `${spec.prompt}\n\nОтчёт сохрани в ${CHECKS}/ по конвенции имени отчёта.`

  const started = Date.now()
  const result = spawnSync(
    'claude',
    [
      '-p', prompt,
      '--agent', `stage-pipeline:${spec.agent}`,
      '--plugin-dir', PLUGIN,
      '--setting-sources', 'project',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--permission-mode', 'dontAsk',
      '--allowedTools', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash(git *)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(grep *)', 'Bash(rg *)', 'Bash(find *)', 'Bash(wc *)', 'Bash(mkdir -p *)',
      '--max-budget-usd', String(spec.budgetUsd ?? 1),
    ],
    { cwd: repo, encoding: 'utf8', timeout: (spec.timeoutSec ?? 600) * 1000 },
  )
  const seconds = Math.round((Date.now() - started) / 1000)

  // Имя файла — забота конвенции скилла, кейс проверяет только, что отчёт вообще сохранён.
  const checksDir = join(repo, CHECKS)
  const report = existsSync(checksDir)
    ? walk(checksDir).filter((file) => file.endsWith('.md')).map((file) => readFileSync(file, 'utf8')).join('\n')
    : ''
  const haystack = `${report}\n${result.stdout ?? ''}`
  const failures = []
  if (result.status !== 0) failures.push(`claude вышел с кодом ${result.status}: ${(result.stderr ?? '').trim().slice(0, 300)}`)
  if (!report && spec.requireReport !== false) failures.push(`отчёт не сохранён в ${CHECKS}/`)
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
  const summaryLines = (result.stdout ?? '').trim().split('\n').length
  if (spec.maxSummaryLines && summaryLines > spec.maxSummaryLines) failures.push(`сводка ${summaryLines} строк при пределе ${spec.maxSummaryLines} — раздувает главный контекст`)
  for (const expectation of spec.expect ?? []) {
    if (!new RegExp(expectation.pattern, 'i').test(haystack)) failures.push(`не найдено: ${expectation.why} (/${expectation.pattern}/)`)
  }
  for (const expectation of spec.forbid ?? []) {
    if (new RegExp(expectation.pattern, 'i').test(report)) failures.push(`лишнее в отчёте: ${expectation.why} (/${expectation.pattern}/)`)
  }

  const saved = join(ROOT, 'evals/.results', `${name}.md`)
  execFileSync('mkdir', ['-p', dirname(saved)])
  writeFileSync(saved, `# ${name}\n\n## Отчёт агента\n\n${report || '(нет)'}\n\n## stdout\n\n${result.stdout ?? ''}\n`)
  rmSync(repo, { recursive: true, force: true })
  return { name, failures, seconds, saved }
}

let failed = 0
for (const name of selected) {
  process.stdout.write(`… ${name}`)
  const { failures, seconds, saved } = runCase(name)
  if (failures.length) failed++
  process.stdout.write(`\r${failures.length ? '✘' : '✔'} ${name} (${seconds}s)\n`)
  for (const failure of failures) console.log(`    ${failure}`)
  if (failures.length) console.log(`    полный вывод: ${relative(ROOT, saved)}`)
}
console.log(`\n${selected.length - failed}/${selected.length} кейсов прошло`)
process.exit(failed ? 1 : 0)
