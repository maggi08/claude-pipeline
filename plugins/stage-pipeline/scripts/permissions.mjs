#!/usr/bin/env node
/**
 * Разрешения пайплайна в settings.json — доливка недостающего, без удаления чужого.
 *
 * Профиль лежит в ../permissions/base.json; записи Skill(...) и mcp__* генерируются
 * из самого плагина, поэтому новый скилл попадает в разрешения автоматически.
 *
 *   node permissions.mjs                     отчёт: чего не хватает (ничего не пишет)
 *   node permissions.mjs --apply             дописать в ~/.claude/settings.json
 *   node permissions.mjs --check             код возврата 1, если чего-то не хватает или перекрыто
 *   node permissions.mjs --scope project     цель — <cwd>/.claude/settings.local.json
 *   node permissions.mjs --groups pipeline,vcs | --all | --minimal
 *   node permissions.mjs --dirs ../ui-lib,../prototypes --scope project --apply
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag) => {
  const index = args.indexOf(flag)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value || value.startsWith('--')) die(`${flag} требует значение`)
  return value
}
const die = (message) => {
  console.error(`✘ ${message}`)
  process.exit(2)
}

if (has('--check') && has('--apply')) die('--check и --apply вместе не работают: --check только отчитывается, --apply пишет')

const scope = valueOf('--scope') ?? 'user'
if (!['user', 'project'].includes(scope)) die('--scope: user | project')

const target =
  scope === 'user'
    ? join(homedir(), '.claude', 'settings.json')
    : join(process.cwd(), '.claude', 'settings.local.json')

const profile = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'permissions', 'base.json'), 'utf8'))
const allGroups = Object.keys(profile.groups)

let groups = profile.defaultGroups
if (has('--all')) groups = allGroups
if (has('--minimal')) groups = ['pipeline']
const explicit = valueOf('--groups')
if (explicit) {
  groups = explicit.split(',').map((g) => g.trim()).filter(Boolean)
  const unknown = groups.filter((g) => !allGroups.includes(g))
  if (unknown.length) die(`неизвестные группы: ${unknown.join(', ')} (есть: ${allGroups.join(', ')})`)
}

/** Skill(...) и mcp__* — из самого плагина, чтобы список не расходился с содержимым */
const generated = () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
  const entries = []

  const skillsDir = join(PLUGIN_ROOT, 'skills')
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir).sort()) {
      if (!existsSync(join(skillsDir, name, 'SKILL.md'))) continue
      entries.push(`Skill(${manifest.name}:${name})`, `Skill(${manifest.name}:${name} *)`)
    }
  }

  const mcpPath = join(PLUGIN_ROOT, '.mcp.json')
  if (existsSync(mcpPath)) {
    const raw = JSON.parse(readFileSync(mcpPath, 'utf8'))
    for (const server of Object.keys(raw.mcpServers ?? raw)) {
      // сервер плагина видно под обоими именами — зависит от версии Claude Code
      entries.push(`mcp__${server}`, `mcp__plugin_${manifest.name}_${server}`)
    }
  }

  return entries
}

const wanted = { allow: [], ask: profile.ask, deny: profile.deny }
for (const group of groups) {
  wanted.allow.push(...profile.groups[group].allow)
  if (profile.groups[group].generated) wanted.allow.push(...generated())
}

const readSettings = () => {
  if (!existsSync(target)) return {}
  try {
    return JSON.parse(readFileSync(target, 'utf8'))
  } catch (error) {
    die(`${target} не парсится как JSON (${error.message}). Почини файл или восстанови из .bak-* рядом — трогать его вслепую скрипт не будет`)
  }
}
const settings = readSettings()
const current = settings.permissions ?? {}
const listOf = (key) => (Array.isArray(current[key]) ? current[key] : [])

const report = { allow: [], ask: [], deny: [] }
const conflicts = []
const notes = []

for (const key of ['allow', 'ask', 'deny']) {
  const existing = new Set(listOf(key))
  for (const entry of wanted[key]) {
    if (existing.has(entry)) continue
    // строгий выбор пользователя не ослабляем: allow не перебивает уже стоящие deny/ask
    if (key === 'allow' && (listOf('deny').includes(entry) || listOf('ask').includes(entry))) {
      conflicts.push(`${entry} — стоит в ${listOf('deny').includes(entry) ? 'deny' : 'ask'}, оставлено как есть`)
      continue
    }
    if (!report[key].includes(entry)) report[key].push(entry)
  }
}

if (listOf('allow').includes('Bash')) {
  notes.push('в allow есть голый "Bash" — разрешён весь Bash, точечные Bash(...) записи ничего не меняют')
}
// записи вида Skill(pro-review), оставшиеся с тех пор, когда скиллы лежали в user-скоупе:
// после переезда в плагин субъект правила называется stage-pipeline:pro-review, и старая запись не разрешает ничего
const ownSkills = new Set(
  generated()
    .filter((entry) => entry.startsWith('Skill('))
    .map((entry) => entry.slice('Skill('.length, -1).split(':')[1].replace(' *', '')),
)
const staleSkills = listOf('allow').filter((entry) => {
  const match = entry.match(/^Skill\(([a-z0-9-]+)( \*)?\)$/)
  return match && ownSkills.has(match[1])
})
if (staleSkills.length) {
  notes.push(
    `записи без префикса плагина больше ничего не разрешают (скиллы переехали в плагин): ${staleSkills.slice(0, 4).join(', ')}${staleSkills.length > 4 ? ` (+${staleSkills.length - 4})` : ''} — можно удалить`,
  )
}

// профиль раздавал эти записи раньше; удалять чужой settings скрипт не вправе, но молчать о них — тоже
const retired = Object.entries(profile.retired ?? {}).filter(([entry]) => entry !== '$comment')
for (const [entry, why] of retired) {
  if (listOf('allow').includes(entry)) notes.push(`устаревшая запись "${entry}" — ${why}; сними её руками`)
}

const dirsRaw = valueOf('--dirs')
const wantedDirs = dirsRaw ? dirsRaw.split(',').map((d) => resolve(d.trim())).filter(Boolean) : []
const missingDirs = wantedDirs.filter((dir) => !(current.additionalDirectories ?? []).includes(dir))
const notOnDisk = wantedDirs.filter((dir) => !existsSync(dir))

const missingTotal = report.allow.length + report.ask.length + report.deny.length + missingDirs.length
// конфликт — это тоже отсутствующее разрешение: дописать его нельзя, и на нём будут спрашивать.
// Считать «на месте» окружение, где нужная запись перекрыта своим deny, — ровно тот ложный зелёный,
// ради которого /pipeline-doctor и вызывает --check.
const blockedTotal = conflicts.length
const notReadyTotal = missingTotal + blockedTotal

console.log(`stage-pipeline permissions → ${target} (scope ${scope})`)
console.log(`Группы: ${groups.join(', ')}${groups.length < allGroups.length ? `  |  ещё есть: ${allGroups.filter((g) => !groups.includes(g)).join(', ')}` : ''}`)
console.log('')
for (const key of ['allow', 'ask', 'deny']) {
  const total = new Set(wanted[key]).size
  console.log(`${key}: не хватает ${report[key].length} из ${total}`)
  for (const entry of report[key]) console.log(`  + ${entry}`)
}
if (wantedDirs.length) {
  console.log(`additionalDirectories: не хватает ${missingDirs.length} из ${wantedDirs.length}`)
  for (const dir of missingDirs) console.log(`  + ${dir}`)
}
for (const conflict of conflicts) console.log(`⚠ конфликт: ${conflict}`)
for (const note of notes) console.log(`⚠ ${note}`)
for (const dir of notOnDisk) console.log(`⚠ пути нет на диске: ${dir}`)

if (has('--check')) {
  const problems = []
  if (missingTotal) problems.push(`не хватает записей: ${missingTotal}`)
  if (blockedTotal) problems.push(`перекрыто своими deny/ask: ${blockedTotal} (дописать нельзя — решает пользователь)`)
  console.log('')
  console.log(notReadyTotal === 0 ? '✔ разрешения на месте' : `✘ ${problems.join('; ')}`)
  process.exit(notReadyTotal === 0 ? 0 : 1)
}

const blockedNote = blockedTotal
  ? `\n  ${blockedTotal} запис${blockedTotal === 1 ? 'ь перекрыта' : 'ей перекрыто'} собственными deny/ask — скрипт их не трогает, сними или оставь осознанно (см. «конфликт» выше)`
  : ''

if (!has('--apply')) {
  console.log('')
  console.log(missingTotal === 0 ? `✔ всё уже стоит, писать нечего${blockedNote}` : `Ничего не записано. Применить: node ${join(PLUGIN_ROOT, 'scripts', 'permissions.mjs')} --apply${scope === 'project' ? ' --scope project' : ''}${blockedNote}`)
  process.exit(0)
}

if (missingTotal === 0) {
  console.log('')
  console.log(`✔ всё уже стоит, файл не тронут${blockedNote}`)
  process.exit(0)
}

let backup = null
if (existsSync(target)) {
  backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(target, backup)
} else {
  mkdirSync(dirname(target), { recursive: true })
}

settings.permissions = current
for (const key of ['allow', 'ask', 'deny']) {
  if (!report[key].length && !Array.isArray(current[key])) continue
  current[key] = [...listOf(key), ...report[key]]
}
if (missingDirs.length) current.additionalDirectories = [...(current.additionalDirectories ?? []), ...missingDirs]

writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`)

console.log('')
console.log(`✔ дописано записей: ${missingTotal} → ${target}${blockedNote}`)
if (backup) console.log(`  бэкап: ${backup}`)
console.log('  разрешения читаются при старте сессии — перезапусти Claude Code, иначе подтверждения продолжат спрашиваться')
