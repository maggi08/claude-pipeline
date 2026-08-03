import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const fail = (file, msg) => errors.push(`${file}: ${msg}`)

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'))
  } catch (e) {
    fail(path, `не парсится — ${e.message}`)
    return null
  }
}

/**
 * Frontmatter скилла/агента: минимальный парсер полей верхнего уровня.
 * Полноценный YAML не нужен — нас интересуют только name и description.
 */
const readFrontmatter = (absPath) => {
  const lines = readFileSync(absPath, 'utf8').split('\n')
  if (lines[0].trim() !== '---') return null
  const end = lines.indexOf('---', 1)
  if (end === -1) return null
  const fields = {}
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([a-zA-Z-]+):\s*(.*)$/)
    if (match) fields[match[1]] = match[2].trim()
  }
  return fields
}

const marketplace = readJson('.claude-plugin/marketplace.json')

for (const entry of marketplace?.plugins ?? []) {
  const source = entry.source
  if (typeof source !== 'string' || !source.startsWith('./')) {
    fail('marketplace.json', `плагин "${entry.name}": ожидается относительный source вида ./plugins/<name>`)
    continue
  }

  const pluginDir = source.slice(2)
  const manifestPath = join(pluginDir, '.claude-plugin/plugin.json')

  if (!existsSync(join(ROOT, manifestPath))) {
    fail('marketplace.json', `плагин "${entry.name}": нет ${manifestPath}`)
    continue
  }

  const manifest = readJson(manifestPath)
  if (!manifest) continue

  if (manifest.name !== entry.name) {
    fail(manifestPath, `name "${manifest.name}" не совпадает с записью в маркетплейсе "${entry.name}"`)
  }
  if (!manifest.version) {
    fail(manifestPath, 'нет version — без него не работает claude plugin tag')
  }
  if (!manifest.description) {
    fail(manifestPath, 'нет description')
  }

  validatePluginTree(pluginDir)
}

function validatePluginTree(pluginDir) {
  const skillsDir = join(ROOT, pluginDir, 'skills')
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir)) {
      const skillPath = join(skillsDir, name, 'SKILL.md')
      const rel = `${pluginDir}/skills/${name}/SKILL.md`
      if (!statSync(join(skillsDir, name)).isDirectory()) continue
      if (!existsSync(skillPath)) {
        fail(rel, 'скилл без SKILL.md')
        continue
      }
      const fm = readFrontmatter(skillPath)
      if (!fm) fail(rel, 'нет frontmatter')
      else if (fm.name !== name) fail(rel, `name "${fm.name}" не совпадает с именем папки "${name}"`)
      else if (!fm.description) fail(rel, 'нет description — скилл не будет находиться по описанию')
    }
  }

  const agentsDir = join(ROOT, pluginDir, 'agents')
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir).filter((f) => f.endsWith('.md'))) {
      const rel = `${pluginDir}/agents/${file}`
      const fm = readFrontmatter(join(agentsDir, file))
      const expected = basename(file, '.md')
      if (!fm) fail(rel, 'нет frontmatter')
      else if (fm.name !== expected) fail(rel, `name "${fm.name}" не совпадает с именем файла "${expected}"`)
      else if (!fm.description) fail(rel, 'нет description')
    }
  }

  validateMcp(pluginDir)
  validateNoHomePaths(pluginDir)
}

function validateMcp(pluginDir) {
  const rel = `${pluginDir}/.mcp.json`
  if (!existsSync(join(ROOT, rel))) return
  const raw = readFileSync(join(ROOT, rel), 'utf8')

  if (/@latest/.test(raw)) {
    fail(rel, 'MCP-сервер на @latest — запинь версию, иначе у разработчиков разное поведение чекеров')
  }
  if (/_authToken|API_KEY|SECRET|PASSWORD|Bearer /i.test(raw)) {
    fail(rel, 'похоже на секрет — .mcp.json уезжает всей команде')
  }
}

/**
 * Кросс-ссылки внутри плагина должны идти через ${CLAUDE_PLUGIN_ROOT}:
 * путь ~/.claude/skills существует только у автора, у остальных ссылка ведёт в пустоту.
 */
function validateNoHomePaths(pluginDir) {
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.md')) {
        const lines = readFileSync(path, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (/~\/\.claude\/(skills|agents)/.test(line)) {
            fail(`${path.replace(`${ROOT}/`, '')}:${i + 1}`, 'ссылка на ~/.claude — нужен ${CLAUDE_PLUGIN_ROOT}')
          }
        })
      }
    }
  }
  walk(join(ROOT, pluginDir))
}

if (errors.length) {
  console.error(`✘ Проверка не прошла (${errors.length}):\n`)
  for (const error of errors) console.error(`  ${error}`)
  process.exit(1)
}

console.log('✔ Манифесты, скиллы, агенты и .mcp.json в порядке')
