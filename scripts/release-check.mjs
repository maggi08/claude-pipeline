import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * `main` is production: whatever lands in it, the team gets on `plugin update`.
 * So a plugin change without a bumped version is invisible to the update (the cache is versioned),
 * and without a CHANGELOG entry it is unclear to whoever updated.
 *
 *   node scripts/release-check.mjs <base-ref>
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

if (errors.length) {
  console.error(`✘ Release not ready:\n${errors.map((e) => `  ${e}`).join('\n')}`)
  process.exit(1)
}
console.log(`✔ Release ${baseVersion ?? '—'} → ${version}, CHANGELOG in place`)
