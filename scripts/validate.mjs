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
    fail(path, `does not parse — ${e.message}`)
    return null
  }
}

/**
 * Skill/agent frontmatter: a minimal parser for top-level fields.
 * Full YAML is not needed — only name and description matter.
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
    fail('marketplace.json', `plugin "${entry.name}": expected a relative source like ./plugins/<name>`)
    continue
  }

  const pluginDir = source.slice(2)
  const manifestPath = join(pluginDir, '.claude-plugin/plugin.json')

  if (!existsSync(join(ROOT, manifestPath))) {
    fail('marketplace.json', `plugin "${entry.name}": no ${manifestPath}`)
    continue
  }

  const manifest = readJson(manifestPath)
  if (!manifest) continue

  if (manifest.name !== entry.name) {
    fail(manifestPath, `name "${manifest.name}" does not match the marketplace entry "${entry.name}"`)
  }
  if (!manifest.version) {
    fail(manifestPath, 'no version — claude plugin tag does not work without it')
  }
  if (!manifest.description) {
    fail(manifestPath, 'no description')
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
        fail(rel, 'skill without SKILL.md')
        continue
      }
      const fm = readFrontmatter(skillPath)
      if (!fm) fail(rel, 'no frontmatter')
      else if (fm.name !== name) fail(rel, `name "${fm.name}" does not match the folder name "${name}"`)
      else if (!fm.description) fail(rel, 'no description — the skill cannot be found by its description')
    }
  }

  const agentsDir = join(ROOT, pluginDir, 'agents')
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir).filter((f) => f.endsWith('.md'))) {
      const rel = `${pluginDir}/agents/${file}`
      const fm = readFrontmatter(join(agentsDir, file))
      const expected = basename(file, '.md')
      if (!fm) fail(rel, 'no frontmatter')
      else if (fm.name !== expected) fail(rel, `name "${fm.name}" does not match the file name "${expected}"`)
      else if (!fm.description) fail(rel, 'no description')
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
    fail(rel, 'MCP server on @latest — pin the version, otherwise checkers behave differently for different developers')
  }
  if (/_authToken|API_KEY|SECRET|PASSWORD|Bearer /i.test(raw)) {
    fail(rel, 'looks like a secret — .mcp.json ships to the whole team')
  }

  // An external server means data leaving the developer's machine. The team learns about it from ROLLOUT.md,
  // so a new external endpoint not mentioned there is an error, not forgotten documentation.
  // headersHelper is a script that carries the key: rename the file and the server silently loses authorization.
  for (const [, script] of raw.matchAll(/"headersHelper":\s*"[^"]*\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s\\]+)/g)) {
    if (!existsSync(join(ROOT, pluginDir, script))) fail(rel, `headersHelper points to a missing ${script}`)
  }

  const rollout = existsSync(join(ROOT, 'ROLLOUT.md')) ? readFileSync(join(ROOT, 'ROLLOUT.md'), 'utf8') : ''
  for (const [, url] of raw.matchAll(/"url":\s*"([^"]+)"/g)) {
    const host = new URL(url).hostname
    if (['127.0.0.1', 'localhost'].includes(host)) continue
    if (!rollout.includes(host)) fail(rel, `external MCP server ${host} is not mentioned in ROLLOUT.md — the team must know what leaves the machine`)
  }
}

/**
 * Permission profile: a mistake here silently leaves checkers without rights,
 * visible only as confirmation prompts coming back on every stage.
 */
function validatePermissions(pluginDir) {
  const rel = `${pluginDir}/permissions/base.json`
  if (!existsSync(join(ROOT, rel))) return

  if (!existsSync(join(ROOT, pluginDir, 'scripts/permissions.mjs'))) {
    fail(rel, 'there is a profile but no scripts/permissions.mjs — nothing to apply it with')
  }

  const profile = readJson(rel)
  if (!profile) return

  const groups = profile.groups ?? {}
  for (const name of profile.defaultGroups ?? []) {
    if (!groups[name]) fail(rel, `defaultGroups points to a missing group "${name}"`)
  }
  for (const [name, group] of Object.entries(groups)) {
    if (!Array.isArray(group.allow)) fail(rel, `group "${name}": allow must be an array`)
    if (!group.title || !group.why) fail(rel, `group "${name}": title and why are required — otherwise it is unclear what the user is signing off`)
    if (!group.generated && !group.allow?.length) fail(rel, `group "${name}": empty and not marked generated`)
  }

  const allowed = new Set(Object.values(groups).flatMap((group) => group.allow ?? []))
  for (const entry of Object.keys(profile.retired ?? {})) {
    if (entry === '$comment') continue
    if (allowed.has(entry)) fail(rel, `"${entry}" is marked retired and also granted from allow`)
  }
  for (const key of ['ask', 'deny']) {
    if (!Array.isArray(profile[key])) {
      fail(rel, `no ${key} array — the /stage-force rules rest on it`)
      continue
    }
    for (const entry of profile[key]) {
      if (allowed.has(entry)) fail(rel, `"${entry}" is in both allow and ${key}`)
    }
  }
}

/**
 * "Should show N skills, M agents" and the version in prose are numbers that
 * go stale in exactly the commit that adds a skill: the commit itself passes, while the README,
 * cheat sheet and deck start lying about the plugin contents. Let them lie loudly.
 */
function validateDeclaredCounts(pluginDir) {
  const manifest = readJson(`${pluginDir}/.claude-plugin/plugin.json`)
  const count = (sub, isReal) => {
    const abs = join(ROOT, pluginDir, sub)
    return existsSync(abs) ? readdirSync(abs).filter(isReal).length : 0
  }
  // A count in any form, Russian or English: "18 скиллов", "21 скилл", "22 скилла", "18 skills", "1 skill".
  // "Шаг 4 скилла" / "step 4 of the skill" / "Stage 2 agent" are not counts and do not trigger the rule.
  const declared = {
    'скилл|skill': count('skills', (name) => existsSync(join(ROOT, pluginDir, 'skills', name, 'SKILL.md'))),
    'агент|agent': count('agents', (name) => name.endsWith('.md')),
  }

  // Plugin showcases: people read them instead of the contents, so the numbers in them must add up.
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
        const [ru, en] = word.split('|')
        const match = line.match(countPattern(ru, en))
        if (match && Number(match[1]) !== actual) fail(`${rel}:${i + 1}`, `says «${match[0]}», the plugin has ${actual}`)
      }
      // The plugin version sits next to its name or alone on a header line; `chrome-devtools-mcp v1.6.0` is not it.
      const version = line.match(/(?:stage-pipeline[^\n]*?|^\s*|>\s*)\bv(\d+\.\d+\.\d+)\b/)
      if (version && manifest?.version && version[1] !== manifest.version) {
        fail(`${rel}:${i + 1}`, `version ${version[0]} differs from plugin.json (${manifest.version})`)
      }
    })
  }
}

/**
 * Cross-references inside the plugin must go through ${CLAUDE_PLUGIN_ROOT}:
 * a ~/.claude/skills path exists only on the author's machine; for everyone else the link leads nowhere.
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
            fail(`${path.replace(`${ROOT}/`, '')}:${i + 1}`, 'link to ~/.claude — use ${CLAUDE_PLUGIN_ROOT}')
          }
        })
      }
    }
  }
  walk(join(ROOT, pluginDir))
}

/**
 * The first CHANGELOG section is the current version. Otherwise, after `plugin update`, a person
 * reads the previous release notes and cannot find what to do by hand on upgrade.
 */
function validateChangelog(pluginDir) {
  const manifest = readJson(`${pluginDir}/.claude-plugin/plugin.json`)
  if (!manifest?.version || !existsSync(join(ROOT, 'CHANGELOG.md'))) return
  const top = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').match(/^## (\d+\.\d+\.\d+)/m)?.[1]
  if (top !== manifest.version) fail('CHANGELOG.md', `the top section is ${top ?? 'missing'}, plugin.json has ${manifest.version}`)
}

/**
 * `${CLAUDE_PLUGIN_ROOT}/…` links in skills and agents are "read/run this" instructions.
 * Rename the file and the link silently leads nowhere; the model just will not find the methodology.
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
            fail(`${file.replace(`${ROOT}/`, '')}:${i + 1}`, `link to a missing \${CLAUDE_PLUGIN_ROOT}/${candidate}`)
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
      if (script && !existsSync(join(ROOT, pluginDir, script))) fail(rel, `${event}: no file ${script}`)
    }
  }
}

/**
 * The plugin is enabled in every repository: ticket ids and product names in skills are noise for someone
 * else's project (0.7.1 scrubbed them by hand across 15 files). The general signal is a ticket id; product names
 * that should not be exposed in a public repo are listed in a local `.product-denylist`
 * (one name per line, the file is in .gitignore).
 */
function validateNoProjectIds(pluginDir) {
  const denylistPath = join(ROOT, '.product-denylist')
  const names = existsSync(denylistPath)
    ? readFileSync(denylistPath, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    : []
  for (const file of walkMarkdown(join(ROOT, pluginDir))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const where = `${file.replace(`${ROOT}/`, '')}:${i + 1}`
      // Standards (SHA-256, ISO-8601, RFC-7231, CVE-…) look like a ticket but are not one.
      const ticket = line.match(/\b(?!AC-|SHA-|ISO-|RFC-|CVE-|UTF-|WCAG-|HTTP-|ECMA-|ES-)[A-Z]{2,6}-\d{3,5}\b/)
      if (ticket) fail(where, `ticket id «${ticket[0]}» — write a precedent without identifiers`)
      for (const name of names) {
        if (line.toLowerCase().includes(name.toLowerCase())) fail(where, `name from .product-denylist «${name}»`)
      }
    })
  }
}

/**
 * Every checklist item in the STAGES.md template must have an executor: a skill, an agent or a process
 * step. An item without an executor (formerly a11y and metrics-guard) hangs as an unclosable checkbox
 * and contradicts the rule "a stage does not close with an item without an outcome".
 */
function validateStageChecklist(pluginDir) {
  const rel = `${pluginDir}/skills/stage-plan/SKILL.md`
  if (!existsSync(join(ROOT, rel))) return
  const known = new Set([
    ...readdirSync(join(ROOT, pluginDir, 'skills')),
    ...readdirSync(join(ROOT, pluginDir, 'agents')).map((file) => basename(file, '.md')),
    // process steps: run by the orchestrator or the user; metrics-* is the bundle_size command from the config
    'kickoff', 'implement', 'user-review', 'commit', 'security-review', 'metrics-baseline', 'metrics-guard', 'floor-guard',
    'coverage', 'test-plan', 'confirmations', 'wrapup', 'full-checks', 'ci-gates', 'kit-overrides',
  ])
  readFileSync(join(ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
    const item = line.match(/^- \[ \] ([a-z0-9-]+)/)?.[1]
    if (item && !known.has(item)) fail(`${rel}:${i + 1}`, `checklist item «${item}» — there is no skill, agent or process step with that name`)
  })
}

/**
 * The orchestrator skill is read in full on every stage, and every retro appends a paragraph to it.
 * The budget makes growth a decision, not drift: precedents go to references/, the rule is one line.
 */
function validateSizeBudget(pluginDir) {
  const SKILL_KB = 30
  const AGENT_KB = 8
  for (const name of readdirSync(join(ROOT, pluginDir, 'skills'))) {
    const path = join(ROOT, pluginDir, 'skills', name, 'SKILL.md')
    if (!existsSync(path)) continue
    const kb = statSync(path).size / 1024
    if (kb > SKILL_KB) fail(`${pluginDir}/skills/${name}/SKILL.md`, `${kb.toFixed(1)} KB over a ${SKILL_KB} KB budget — move precedents and measurements to references/`)
  }
  for (const file of readdirSync(join(ROOT, pluginDir, 'agents'))) {
    // An agent without a skill of the same name (proto-spec, docs-lookup) carries the methodology itself — same budget as a skill.
    const hasSkill = existsSync(join(ROOT, pluginDir, 'skills', basename(file, '.md'), 'SKILL.md'))
    const kb = statSync(join(ROOT, pluginDir, 'agents', file)).size / 1024
    if (!hasSkill && kb > SKILL_KB) fail(`${pluginDir}/agents/${file}`, `${kb.toFixed(1)} KB over a ${SKILL_KB} KB budget`)
    if (hasSkill && kb > AGENT_KB) fail(`${pluginDir}/agents/${file}`, `${kb.toFixed(1)} KB over a ${AGENT_KB} KB budget — the methodology lives in the skill, the agent holds only the role and the report contract`)
  }
}

/**
 * The "N skills / N agents" count in a showcase line, Russian or English. `ru` and `en` are the word stems.
 * Not a count: "Шаг 4 скилла", "Этап 2 агент", "Пункт 3 агента" and the English "Step 4 skill", "Stage 2 agent", "Point 3 agent".
 * A count is also only a number-and-word that ends a phrase: "2 agents run in parallel" and "3 skill files" are prose.
 * The word must be followed by the end of the line, `,.;:()<|`, a dash, a markup or list separator (`*` `/` `·` `+` `&`),
 * or "and" / "plus" / the Russian conjunction before the next word.
 */
function countPattern(ru, en) {
  const notAfter = '(?<![\\d.]|[Шш]аг[а-я]*\\s|[Ээ]тап[а-я]*\\s|[Пп]ункт[а-я]*\\s|[Ss]teps?\\s|[Ss]tages?\\s|[Pp]oints?\\s)'
  const phraseEnd = '(?=\\s*$|[,.;:)(<|*`\\]/—–·•+&]|\\s-\\s|\\s(?:и|and|plus)\\s)'
  return new RegExp(`${notAfter}(\\d+) (?:${ru}(?:ов|а)?(?![а-яё])|${en}s?(?![\\w-]))${phraseEnd}`)
}

function walkMarkdown(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return walkMarkdown(path)
    return name.endsWith('.md') ? [path] : []
  })
}

if (errors.length) {
  console.error(`✘ Validation failed (${errors.length}):\n`)
  for (const error of errors) console.error(`  ${error}`)
  process.exit(1)
}

console.log('✔ Manifests, skills, agents, hooks, .mcp.json and CHANGELOG are in order')
