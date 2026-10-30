#!/usr/bin/env node
/**
 * Pipeline permissions in settings.json — topping up what is missing, without removing anything foreign.
 *
 * The profile lives in ../permissions/base.json; Skill(...) and mcp__* entries are generated
 * from the plugin itself, so a new skill gets into the permissions automatically.
 *
 *   node permissions.mjs                     report: what is missing (writes nothing)
 *   node permissions.mjs --apply             append to ~/.claude/settings.json
 *   node permissions.mjs --check             exit code 1 if something is missing or overridden
 *   node permissions.mjs --scope project     the target is <cwd>/.claude/settings.local.json
 *   node permissions.mjs --groups pipeline,vcs | --all | --minimal
 *   node permissions.mjs --dirs ../ui-lib,../prototypes --scope project --apply
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { generatedEntries, loadProfile, wantedFor } from './permission-profile.mjs'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag) => {
  const index = args.indexOf(flag)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value || value.startsWith('--')) die(`${flag} requires a value`)
  return value
}
const die = (message) => {
  console.error(`✘ ${message}`)
  process.exit(2)
}

if (has('--check') && has('--apply')) die('--check and --apply do not work together: --check only reports, --apply writes')

const scope = valueOf('--scope') ?? 'user'
if (!['user', 'project'].includes(scope)) die('--scope: user | project')

const target =
  scope === 'user'
    ? join(homedir(), '.claude', 'settings.json')
    : join(process.cwd(), '.claude', 'settings.local.json')

const profile = loadProfile(PLUGIN_ROOT)
const allGroups = Object.keys(profile.groups)

let groups = profile.defaultGroups
if (has('--all')) groups = allGroups
if (has('--minimal')) groups = ['pipeline']
const explicit = valueOf('--groups')
if (explicit) {
  groups = explicit.split(',').map((g) => g.trim()).filter(Boolean)
  const unknown = groups.filter((g) => !allGroups.includes(g))
  if (unknown.length) die(`unknown groups: ${unknown.join(', ')} (available: ${allGroups.join(', ')})`)
}

const generated = () => generatedEntries(PLUGIN_ROOT)

const wanted = wantedFor(PLUGIN_ROOT, groups, profile)

const readSettings = () => {
  if (!existsSync(target)) return {}
  try {
    return JSON.parse(readFileSync(target, 'utf8'))
  } catch (error) {
    die(`${target} does not parse as JSON (${error.message}). Fix the file or restore it from the .bak-* next to it — the script will not touch it blindly`)
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
    // the user's strict choice is not weakened: allow does not override deny/ask already in place
    if (key === 'allow' && (listOf('deny').includes(entry) || listOf('ask').includes(entry))) {
      conflicts.push(`${entry} — is in ${listOf('deny').includes(entry) ? 'deny' : 'ask'}, left as is`)
      continue
    }
    if (!report[key].includes(entry)) report[key].push(entry)
  }
}

if (listOf('allow').includes('Bash')) {
  notes.push('allow has a bare "Bash" — all of Bash is allowed, point Bash(...) entries change nothing')
}
// Skill(pro-review)-style entries left over from when skills lived in the user scope:
// after the move into the plugin the rule's subject is called stage-pipeline:pro-review, and the old entry allows nothing
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
    `entries without the plugin prefix allow nothing any more (the skills moved into the plugin): ${staleSkills.slice(0, 4).join(', ')}${staleSkills.length > 4 ? ` (+${staleSkills.length - 4})` : ''} — can be removed`,
  )
}

// the profile used to hand these entries out; the script has no right to remove foreign settings, but being silent about them is wrong too
const retired = Object.entries(profile.retired ?? {}).filter(([entry]) => entry !== '$comment')
for (const [entry, why] of retired) {
  if (listOf('allow').includes(entry)) notes.push(`obsolete entry "${entry}" — ${why}; remove it by hand`)
}

const dirsRaw = valueOf('--dirs')
const wantedDirs = dirsRaw ? dirsRaw.split(',').map((d) => resolve(d.trim())).filter(Boolean) : []
const missingDirs = wantedDirs.filter((dir) => !(current.additionalDirectories ?? []).includes(dir))
const notOnDisk = wantedDirs.filter((dir) => !existsSync(dir))

const missingTotal = report.allow.length + report.ask.length + report.deny.length + missingDirs.length
// a conflict is also a missing permission: it cannot be appended, and it will be asked about.
// Counting as "in place" an environment where the needed entry is overridden by its own deny is exactly the false green
// for which /pipeline-doctor calls --check.
const blockedTotal = conflicts.length
const notReadyTotal = missingTotal + blockedTotal

console.log(`stage-pipeline permissions → ${target} (scope ${scope})`)
console.log(`Groups: ${groups.join(', ')}${groups.length < allGroups.length ? `  |  also available: ${allGroups.filter((g) => !groups.includes(g)).join(', ')}` : ''}`)
console.log('')
for (const key of ['allow', 'ask', 'deny']) {
  const total = new Set(wanted[key]).size
  console.log(`${key}: ${report[key].length} of ${total} missing`)
  for (const entry of report[key]) console.log(`  + ${entry}`)
}
if (wantedDirs.length) {
  console.log(`additionalDirectories: ${missingDirs.length} of ${wantedDirs.length} missing`)
  for (const dir of missingDirs) console.log(`  + ${dir}`)
}
for (const conflict of conflicts) console.log(`⚠ conflict: ${conflict}`)
for (const note of notes) console.log(`⚠ ${note}`)
for (const dir of notOnDisk) console.log(`⚠ path not on disk: ${dir}`)

if (has('--check')) {
  const problems = []
  if (missingTotal) problems.push(`missing entries: ${missingTotal}`)
  if (blockedTotal) problems.push(`overridden by own deny/ask: ${blockedTotal} (cannot be appended — the user decides)`)
  console.log('')
  console.log(notReadyTotal === 0 ? '✔ permissions are in place' : `✘ ${problems.join('; ')}`)
  process.exit(notReadyTotal === 0 ? 0 : 1)
}

const blockedNote = blockedTotal
  ? `\n  ${blockedTotal} entr${blockedTotal === 1 ? 'y is' : 'ies are'} overridden by your own deny/ask — the script does not touch them, remove them or keep them knowingly (see "conflict" above)`
  : ''

if (!has('--apply')) {
  console.log('')
  console.log(missingTotal === 0 ? `✔ everything is already in place, nothing to write${blockedNote}` : `Nothing written. To apply: node ${join(PLUGIN_ROOT, 'scripts', 'permissions.mjs')} --apply${scope === 'project' ? ' --scope project' : ''}${blockedNote}`)
  process.exit(0)
}

if (missingTotal === 0) {
  console.log('')
  console.log(`✔ everything is already in place, the file was not touched${blockedNote}`)
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
console.log(`✔ appended entries: ${missingTotal} → ${target}${blockedNote}`)
if (backup) console.log(`  backup: ${backup}`)
console.log('  permissions are read at session start — restart Claude Code, otherwise confirmations will keep being asked')
