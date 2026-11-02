import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { agentCases, agentTreeAt, gateErrors, readReleases } from './release-lib.mjs'

/**
 * `main` is production: whatever lands in it, the team gets on `plugin update`.
 * So a plugin change without a bumped version is invisible to the update (the cache is versioned),
 * and without a CHANGELOG entry it is unclear to whoever updated.
 *
 *   node scripts/release-check.mjs <base-ref>
 *
 * The eval gate: when the diff changes an agent (`plugins/stage-pipeline/agents/<a>.md`) or its checker skill (`skills/<a>/`, a skill whose name is an agent), every case of
 * evals/cases/ whose case.json `agent` is <a> needs a row at this version in the committed evals/releases.tsv (written by `node scripts/eval.mjs --record-release`),
 * or the CHANGELOG section of this version needs a line `eval: skipped — <reason>` (all changed agents) / `eval: skipped <a>, <b> — <reason>` (the named ones).
 * A row stands for the agent's bytes, not for a commit (the branch may be rebased): its `agent_tree` column (the blob of the agent file + the tree of its skill at the measured sha) must equal HEAD's.
 * Routing and decision cases name no agent and do not count. An agent with no case and no skip line fails.
 */
const base = process.argv[2]
if (!base) {
  console.error('Usage: node scripts/release-check.mjs <base-ref>')
  process.exit(2)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const MANIFEST = 'plugins/stage-pipeline/.claude-plugin/plugin.json'

const changed = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean)
const pluginChanged = changed.filter((path) => path.startsWith('plugins/'))
if (!pluginChanged.length) {
  console.log('✔ Plugin unchanged — no version bump or CHANGELOG needed')
  process.exit(0)
}

const version = JSON.parse(readFileSync(MANIFEST, 'utf8')).version
let baseVersion = null
try {
  baseVersion = JSON.parse(git('show', `${base}:${MANIFEST}`)).version
} catch {
  // no manifest in base — the first release
}

const errors = []
// The version must grow, not merely change: rolling a version back breaks `claude plugin update` for the team.
const semver = (v) => v.split('.').map(Number)
const grew = (a, b) => {
  const [x, y] = [semver(a), semver(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}
if (baseVersion && !grew(version, baseVersion)) {
  errors.push(`plugin changed (${pluginChanged.length} files), but version ${version} is not above the base ${baseVersion} — bump version in ${MANIFEST}`)
}
if (!new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`, 'm').test(readFileSync('CHANGELOG.md', 'utf8'))) {
  errors.push(`CHANGELOG.md has no section «## ${version}»`)
}

const changelog = readFileSync('CHANGELOG.md', 'utf8')
const section = new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(changelog)?.[1] ?? ''
const AGENTS = 'plugins/stage-pipeline/agents/'
const SKILLS = 'plugins/stage-pipeline/skills/'
const changedAgents = [...new Set(changed.flatMap((path) => {
  if (path.startsWith(AGENTS) && path.endsWith('.md') && !path.slice(AGENTS.length).includes('/')) return [path.slice(AGENTS.length, -3)]
  if (path.startsWith(SKILLS)) return [path.slice(SKILLS.length).split('/')[0]]
  return []
}))]
  .filter((agent) => existsSync(`${AGENTS}${agent}.md`))
  .sort()
if (changedAgents.length) {
  const treeOf = (agent) => agentTreeAt(git, 'HEAD', agent)
  errors.push(...gateErrors({ changedAgents, cases: agentCases('evals/cases'), releases: readReleases('evals/releases.tsv'), version, changelogSection: section, treeOf }))
}

if (errors.length) {
  console.error(`✘ Release not ready:\n${errors.map((e) => `  ${e}`).join('\n')}`)
  process.exit(1)
}
console.log(`✔ Release ${baseVersion ?? '—'} → ${version}, CHANGELOG in place${changedAgents.length ? `, eval gate passed for ${changedAgents.join(', ')}` : ''}`)
