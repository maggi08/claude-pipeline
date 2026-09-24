import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * `main` — прод: всё, что в него попало, команда получает на `plugin update`.
 * Поэтому правка плагина без поднятой версии невидима для обновления (кэш версионированный),
 * а без записи в CHANGELOG — непонятна тому, кто обновился.
 *
 *   node scripts/release-check.mjs <base-ref>
 */
const base = process.argv[2]
if (!base) {
  console.error('Использование: node scripts/release-check.mjs <base-ref>')
  process.exit(2)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const MANIFEST = 'plugins/stage-pipeline/.claude-plugin/plugin.json'

const changed = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean)
const pluginChanged = changed.filter((path) => path.startsWith('plugins/'))
if (!pluginChanged.length) {
  console.log('✔ Плагин не менялся — версия и CHANGELOG не требуются')
  process.exit(0)
}

const version = JSON.parse(readFileSync(MANIFEST, 'utf8')).version
let baseVersion = null
try {
  baseVersion = JSON.parse(git('show', `${base}:${MANIFEST}`)).version
} catch {
  // манифеста в базе нет — первый релиз
}

const errors = []
if (baseVersion === version) {
  errors.push(`плагин изменён (${pluginChanged.length} файлов), а версия осталась ${version} — подними version в ${MANIFEST}`)
}
if (!new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`, 'm').test(readFileSync('CHANGELOG.md', 'utf8'))) {
  errors.push(`в CHANGELOG.md нет раздела «## ${version}»`)
}

if (errors.length) {
  console.error(`✘ Релиз не готов:\n${errors.map((e) => `  ${e}`).join('\n')}`)
  process.exit(1)
}
console.log(`✔ Релиз ${baseVersion ?? '—'} → ${version}, CHANGELOG на месте`)
