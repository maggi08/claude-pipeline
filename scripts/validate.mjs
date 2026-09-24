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
  validatePermissions(pluginDir)
  validateNoHomePaths(pluginDir)
  validateDeclaredCounts(pluginDir)
  validateChangelog(pluginDir)
  validatePluginPaths(pluginDir)
  validateHooks(pluginDir)
  validateNoProjectIds(pluginDir)
  validateStageChecklist(pluginDir)
  validateSizeBudget(pluginDir)
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

  // Внешний сервер — это данные, уходящие с машины разработчика. Команда узнаёт об этом из ROLLOUT.md,
  // поэтому новый внешний эндпоинт без упоминания там — ошибка, а не забытая документация.
  // headersHelper — скрипт, который несёт ключ: переименовали файл — сервер молча остаётся без авторизации.
  for (const [, script] of raw.matchAll(/"headersHelper":\s*"[^"]*\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s\\]+)/g)) {
    if (!existsSync(join(ROOT, pluginDir, script))) fail(rel, `headersHelper ссылается на несуществующий ${script}`)
  }

  const rollout = existsSync(join(ROOT, 'ROLLOUT.md')) ? readFileSync(join(ROOT, 'ROLLOUT.md'), 'utf8') : ''
  for (const [, url] of raw.matchAll(/"url":\s*"([^"]+)"/g)) {
    const host = new URL(url).hostname
    if (['127.0.0.1', 'localhost'].includes(host)) continue
    if (!rollout.includes(host)) fail(rel, `внешний MCP-сервер ${host} не упомянут в ROLLOUT.md — команда должна знать, что уходит наружу`)
  }
}

/**
 * Профиль разрешений: ошибка здесь тихо оставляет чекеры без прав,
 * и это видно только по возвращающимся подтверждениям на каждом этапе.
 */
function validatePermissions(pluginDir) {
  const rel = `${pluginDir}/permissions/base.json`
  if (!existsSync(join(ROOT, rel))) return

  if (!existsSync(join(ROOT, pluginDir, 'scripts/permissions.mjs'))) {
    fail(rel, 'есть профиль, но нет scripts/permissions.mjs — применять его нечем')
  }

  const profile = readJson(rel)
  if (!profile) return

  const groups = profile.groups ?? {}
  for (const name of profile.defaultGroups ?? []) {
    if (!groups[name]) fail(rel, `defaultGroups ссылается на несуществующую группу "${name}"`)
  }
  for (const [name, group] of Object.entries(groups)) {
    if (!Array.isArray(group.allow)) fail(rel, `группа "${name}": allow должен быть массивом`)
    if (!group.title || !group.why) fail(rel, `группа "${name}": нужны title и why — иначе непонятно, что подписывает пользователь`)
    if (!group.generated && !group.allow?.length) fail(rel, `группа "${name}": пустая и не помечена generated`)
  }

  const allowed = new Set(Object.values(groups).flatMap((group) => group.allow ?? []))
  for (const entry of Object.keys(profile.retired ?? {})) {
    if (entry === '$comment') continue
    if (allowed.has(entry)) fail(rel, `"${entry}" помечена retired и одновременно раздаётся из allow`)
  }
  for (const key of ['ask', 'deny']) {
    if (!Array.isArray(profile[key])) {
      fail(rel, `нет массива ${key} — правила /stage-force держатся именно на нём`)
      continue
    }
    for (const entry of profile[key]) {
      if (allowed.has(entry)) fail(rel, `"${entry}" одновременно в allow и в ${key}`)
    }
  }
}

/**
 * «Должен показать N скиллов, M агентов» и версия в прозе — числа, которые
 * протухают ровно в том коммите, где добавили скилл: сам он проходит, а README,
 * чит-шит и дек начинают врать о содержимом плагина. Пусть врут заметно.
 */
function validateDeclaredCounts(pluginDir) {
  const manifest = readJson(`${pluginDir}/.claude-plugin/plugin.json`)
  const count = (sub, isReal) => {
    const abs = join(ROOT, pluginDir, sub)
    return existsSync(abs) ? readdirSync(abs).filter(isReal).length : 0
  }
  // Счёт — в любой форме: «18 скиллов», «21 скилл», «22 скилла». «Шаг 4 скилла» — не счёт и под правило не попадает.
  const declared = {
    'скилл': count('skills', (name) => existsSync(join(ROOT, pluginDir, 'skills', name, 'SKILL.md'))),
    'агент': count('agents', (name) => name.endsWith('.md')),
  }

  // Витрины плагина: их читают вместо содержимого, поэтому числа в них должны сходиться.
  const surfaces = ['README.md', `${pluginDir}/README.md`]
  const presentation = join(ROOT, 'presentation')
  if (existsSync(presentation)) {
    for (const name of readdirSync(presentation)) surfaces.push(`presentation/${name}`)
  }

  for (const rel of surfaces) {
    const abs = join(ROOT, rel)
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue
    readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
      for (const [word, actual] of Object.entries(declared)) {
        const match = line.match(new RegExp(`(?<![\\d.]|[Шш]аг[а-я]*\\s|[Ээ]тап[а-я]*\\s|[Пп]ункт[а-я]*\\s)(\\d+) ${word}(ов|а)?(?![а-яё])`))
        if (match && Number(match[1]) !== actual) fail(`${rel}:${i + 1}`, `сказано «${match[0]}», в плагине ${actual}`)
      }
      // Версия плагина — рядом с его именем или одна на строке-шапке; `chrome-devtools-mcp v1.6.0` — не она.
      const version = line.match(/(?:stage-pipeline[^\n]*?|^\s*|>\s*)\bv(\d+\.\d+\.\d+)\b/)
      if (version && manifest?.version && version[1] !== manifest.version) {
        fail(`${rel}:${i + 1}`, `версия ${version[0]} расходится с plugin.json (${manifest.version})`)
      }
    })
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

/**
 * Первый раздел CHANGELOG — текущая версия. Иначе человек после `plugin update`
 * читает описание предыдущего релиза и не находит, что делать руками на апгрейде.
 */
function validateChangelog(pluginDir) {
  const manifest = readJson(`${pluginDir}/.claude-plugin/plugin.json`)
  if (!manifest?.version || !existsSync(join(ROOT, 'CHANGELOG.md'))) return
  const top = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').match(/^## (\d+\.\d+\.\d+)/m)?.[1]
  if (top !== manifest.version) fail('CHANGELOG.md', `верхний раздел — ${top ?? 'нет'}, в plugin.json ${manifest.version}`)
}

/**
 * Ссылки `${CLAUDE_PLUGIN_ROOT}/…` в скиллах и агентах — это инструкции «прочитай/запусти это».
 * Переименовали файл — ссылка ведёт в пустоту молча, модель просто не найдёт методологию.
 */
function validatePluginPaths(pluginDir) {
  const expand = (path) => {
    const brace = path.match(/\{([^}]+)\}/)
    return brace ? brace[1].split(',').flatMap((part) => expand(path.replace(brace[0], part))) : [path]
  }
  for (const file of walkMarkdown(join(ROOT, pluginDir))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const [, raw] of line.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w{},./-]+)/g)) {
        const path = raw.replace(/[.,]+$/, '')
        for (const candidate of expand(path)) {
          if (!existsSync(join(ROOT, pluginDir, candidate))) {
            fail(`${file.replace(`${ROOT}/`, '')}:${i + 1}`, `ссылка на несуществующий \${CLAUDE_PLUGIN_ROOT}/${candidate}`)
          }
        }
      }
    })
  }
}

function validateHooks(pluginDir) {
  const rel = `${pluginDir}/hooks/hooks.json`
  if (!existsSync(join(ROOT, rel))) return
  const hooks = readJson(rel)
  for (const [event, matchers] of Object.entries(hooks?.hooks ?? {})) {
    for (const hook of matchers.flatMap((matcher) => matcher.hooks ?? [])) {
      const script = hook.command?.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/)?.[1]
      if (script && !existsSync(join(ROOT, pluginDir, script))) fail(rel, `${event}: нет файла ${script}`)
    }
  }
}

/**
 * Плагин включён во всех репозиториях: айди тикетов и имена продуктов в скиллах — шум для чужого
 * проекта (0.7.1 вычищал их руками по 15 файлам). Общий признак — айди тикета; имена продуктов,
 * которые не стоит светить в публичном репо, перечисляются в локальном `.product-denylist`
 * (по строке на имя, файл в .gitignore).
 */
function validateNoProjectIds(pluginDir) {
  const denylistPath = join(ROOT, '.product-denylist')
  const names = existsSync(denylistPath)
    ? readFileSync(denylistPath, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    : []
  for (const file of walkMarkdown(join(ROOT, pluginDir))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const where = `${file.replace(`${ROOT}/`, '')}:${i + 1}`
      // Стандарты (SHA-256, ISO-8601, RFC-7231, CVE-…) по форме как тикет, но тикетом не являются.
      const ticket = line.match(/\b(?!AC-|SHA-|ISO-|RFC-|CVE-|UTF-|WCAG-|HTTP-|ECMA-|ES-)[A-Z]{2,6}-\d{3,5}\b/)
      if (ticket) fail(where, `айди тикета «${ticket[0]}» — прецедент пишется без идентификаторов`)
      for (const name of names) {
        if (line.toLowerCase().includes(name.toLowerCase())) fail(where, `имя из .product-denylist «${name}»`)
      }
    })
  }
}

/**
 * Каждый пункт чеклиста в шаблоне STAGES.md должен иметь исполнителя: скилл, агент или шаг
 * процесса. Пункт без исполнителя (раньше — a11y и metrics-guard) висит незакрываемым чекбоксом
 * и противоречит правилу «этап не закрывается с пунктом без исхода».
 */
function validateStageChecklist(pluginDir) {
  const rel = `${pluginDir}/skills/stage-plan/SKILL.md`
  if (!existsSync(join(ROOT, rel))) return
  const known = new Set([
    ...readdirSync(join(ROOT, pluginDir, 'skills')),
    ...readdirSync(join(ROOT, pluginDir, 'agents')).map((file) => basename(file, '.md')),
    // шаги процесса: исполняет оркестратор или пользователь; metrics-* — команда bundle_size из конфига
    'kickoff', 'implement', 'user-review', 'commit', 'security-review', 'metrics-baseline', 'metrics-guard', 'floor-guard',
    'coverage', 'test-plan', 'confirmations', 'wrapup',
  ])
  readFileSync(join(ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
    const item = line.match(/^- \[ \] ([a-z0-9-]+)/)?.[1]
    if (item && !known.has(item)) fail(`${rel}:${i + 1}`, `пункт чеклиста «${item}» — нет ни скилла, ни агента, ни шага процесса с таким именем`)
  })
}

/**
 * Скилл оркестратора читается на каждом этапе целиком, и каждое ретро дописывает в него абзац.
 * Бюджет делает рост решением, а не дрейфом: прецеденты — в references/, правило — одной строкой.
 */
function validateSizeBudget(pluginDir) {
  const SKILL_KB = 30
  const AGENT_KB = 8
  for (const name of readdirSync(join(ROOT, pluginDir, 'skills'))) {
    const path = join(ROOT, pluginDir, 'skills', name, 'SKILL.md')
    if (!existsSync(path)) continue
    const kb = statSync(path).size / 1024
    if (kb > SKILL_KB) fail(`${pluginDir}/skills/${name}/SKILL.md`, `${kb.toFixed(1)} KB при бюджете ${SKILL_KB} KB — прецеденты и замеры вынеси в references/`)
  }
  for (const file of readdirSync(join(ROOT, pluginDir, 'agents'))) {
    // Агент без одноимённого скилла (proto-spec, docs-lookup) сам несёт методологию — бюджет как у скилла.
    const hasSkill = existsSync(join(ROOT, pluginDir, 'skills', basename(file, '.md'), 'SKILL.md'))
    const kb = statSync(join(ROOT, pluginDir, 'agents', file)).size / 1024
    if (!hasSkill && kb > SKILL_KB) fail(`${pluginDir}/agents/${file}`, `${kb.toFixed(1)} KB при бюджете ${SKILL_KB} KB`)
    if (hasSkill && kb > AGENT_KB) fail(`${pluginDir}/agents/${file}`, `${kb.toFixed(1)} KB при бюджете ${AGENT_KB} KB — методология живёт в скилле, агенту — только роль и контракт отчёта`)
  }
}

function walkMarkdown(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return walkMarkdown(path)
    return name.endsWith('.md') ? [path] : []
  })
}

if (errors.length) {
  console.error(`✘ Проверка не прошла (${errors.length}):\n`)
  for (const error of errors) console.error(`  ${error}`)
  process.exit(1)
}

console.log('✔ Манифесты, скиллы, агенты, хуки, .mcp.json и CHANGELOG в порядке')
