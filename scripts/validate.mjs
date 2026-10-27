import { readFileSync, readdirSync, existsSync, statSync, lstatSync, realpathSync, utimesSync } from 'node:fs'
import { join, dirname, basename, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const fail = (file, msg) => {
  const line = `${file}: ${msg}`
  if (!errors.includes(line)) errors.push(line)
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

// A link inside the plugin is never followed (it may dangle or lead out of the repo): the walkers report it and skip it.
const failLink = (path) => fail(path.replace(`${ROOT}/`, ''), 'is a symbolic link — links are not allowed in the plugin; replace it with a regular file or directory')

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
  // An entry that lives in its own repo (human-text) has no tree here to validate; only its shape is checked.
  if (source && typeof source === 'object') {
    if (source.source !== 'github' || !/^[\w.-]+\/[\w.-]+$/.test(source.repo ?? '')) fail('marketplace.json', `plugin "${entry.name}": expected source { "source": "github", "repo": "owner/name" }`)
    if (!entry.description) fail('marketplace.json', `plugin "${entry.name}": no description`)
    continue
  }
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

// Every file read below assumes a regular file. A link in the plugin (dangling, or out of the repo) would crash the
// readers with ENOENT, so links are collected first and, if there are any, the rest of the tree checks are skipped.
function reportLinks(dir) {
  let found = 0
  if (isLink(dir)) {
    failLink(dir)
    return 1
  }
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const path = join(dir, name)
    const kind = lstatSync(path)
    if (kind.isSymbolicLink()) {
      failLink(path)
      found++
    } else if (kind.isDirectory()) found += reportLinks(path)
  }
  return found
}

function validatePluginTree(pluginDir) {
  if (reportLinks(join(ROOT, pluginDir))) return
  const skillsDir = join(ROOT, pluginDir, 'skills')
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir)) {
      const skillPath = join(skillsDir, name, 'SKILL.md')
      const rel = `${pluginDir}/skills/${name}/SKILL.md`
      if (isLink(join(skillsDir, name))) {
        failLink(join(skillsDir, name))
        continue
      }
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
  validateSummaryNotFenced(pluginDir)
  validatePluginPaths(pluginDir)
  validateHooks(pluginDir)
  validateNoProjectIds(pluginDir)
  validateStageChecklist(pluginDir)
  validateSizeBudget(pluginDir)
  validateXrefs(pluginDir)
  validateVendoredHumanText(pluginDir)
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
 * The human-text skill and agent are a vendored copy (scripts/sync-human-text.mjs): every file must match the sha256
 * in human-text.lock.json, nothing may be added to or missing from the vendored paths, and the lock paths stay inside the plugin.
 */
function validateVendoredHumanText(pluginDir) {
  if (pluginDir !== 'plugins/stage-pipeline') return
  const lockRel = `${pluginDir}/human-text.lock.json`
  const hint = 'edit in the human-text repo, then run scripts/sync-human-text.mjs'
  const vendored = []
  const skillDir = join(ROOT, pluginDir, 'skills/human-text')
  // lstat, not stat: a link must not be followed out of the plugin (nor hashed as if it were the vendored file).
  const walkFiles = (dir) => readdirSync(dir).flatMap((name) => (lstatSync(join(dir, name)).isDirectory() ? walkFiles(join(dir, name)) : [join(dir, name)]))
  if (isLink(skillDir)) fail(`${pluginDir}/skills/human-text`, `is a link — ${hint}`)
  else if (existsSync(skillDir)) vendored.push(...walkFiles(skillDir).map((abs) => relative(join(ROOT, pluginDir), abs).split('\\').join('/')))
  if (existsSync(join(ROOT, pluginDir, 'agents/human-text-check.md'))) vendored.push('agents/human-text-check.md')
  if (!existsSync(join(ROOT, lockRel))) {
    if (vendored.length) fail(lockRel, `no lock for the vendored human-text files — run scripts/sync-human-text.mjs`)
    return
  }
  const lock = readJson(lockRel)
  if (!lock) return
  if (!lock.ref || !lock.source) fail(lockRel, 'no source or ref')
  const locked = Object.entries(lock.files ?? {})
  for (const [rel, hash] of locked) {
    if (rel.split('/').includes('..') || rel.startsWith('/') || !/^(skills\/human-text\/|agents\/human-text-check\.md$)/.test(rel)) {
      fail(lockRel, `path «${rel}» is outside the vendored human-text paths`)
      continue
    }
    const abs = join(ROOT, pluginDir, rel)
    if (!existsSync(abs) && !isLink(abs)) fail(`${pluginDir}/${rel}`, `listed in the lock but missing — ${hint}`)
    else if (!lstatSync(abs).isFile()) fail(`${pluginDir}/${rel}`, `is not a regular file (a link or a special file) — ${hint}`)
    else if (createHash('sha256').update(readFileSync(abs)).digest('hex') !== hash) fail(`${pluginDir}/${rel}`, `differs from human-text.lock.json — ${hint}`)
  }
  const lockedPaths = new Set(locked.map(([rel]) => rel))
  for (const rel of vendored) {
    const abs = join(ROOT, pluginDir, rel)
    if (!lstatSync(abs).isFile()) fail(`${pluginDir}/${rel}`, `is not a regular file (a link or a special file) — ${hint}`)
    else if (!realpathSync(abs).startsWith(`${realpathSync(join(ROOT, pluginDir))}${sep}`)) fail(`${pluginDir}/${rel}`, 'resolves outside the plugin')
  }
  for (const rel of vendored) if (!lockedPaths.has(rel)) fail(`${pluginDir}/${rel}`, `not in human-text.lock.json — ${hint}`)
}

/**
 * Cross-references inside the plugin must go through ${CLAUDE_PLUGIN_ROOT}:
 * a ~/.claude/skills path exists only on the author's machine; for everyone else the link leads nowhere.
 */
function validateNoHomePaths(pluginDir) {
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const kind = lstatSync(path)
      if (kind.isSymbolicLink()) {
        failLink(path)
        continue
      }
      if (kind.isDirectory()) walk(path)
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
 * The run summary is pasted into the chat as it is. A code fence in the «Output» section of stage-force is copied with it, and the run-digest headings
 * then show as one monospace block with a horizontal scroll (VT-1 stage 5e): the template there is plain markdown lines.
 */
function validateSummaryNotFenced(pluginDir) {
  const rel = `${pluginDir}/skills/stage-force/SKILL.md`
  if (!existsSync(join(ROOT, rel))) return
  const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n')
  const start = lines.findIndex((line) => /^## Output\b/.test(line))
  if (start === -1) return fail(rel, 'no "## Output" section — the run summary template is missing')
  const end = lines.findIndex((line, i) => i > start && /^## /.test(line))
  const fence = lines.slice(start, end === -1 ? undefined : end).findIndex((line) => /^\s*(?:```|~~~)/.test(line))
  if (fence !== -1) fail(`${rel}:${start + fence + 1}`, 'the "Output" section holds a fenced block — the run summary template is plain markdown, never inside a code block')
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
  scanProjectIds(walkMarkdown(join(ROOT, pluginDir)))
}

/** Ticket-shaped ids that are invented on purpose and stay in the eval cases (the text of a status update the human-text-check cases grade). */
const SYNTHETIC_IDS = new Set(['SEARCH-212'])

/** The same scan over the eval cases: a company's ticket or product name in a fixture, a prompt or a recorded result is as much a leak as one in a skill. */
function validateNoProjectIdsInEvals() {
  const files = existsSync(join(ROOT, 'evals'))
    ? walkAll(join(ROOT, 'evals')).filter((file) => !file.includes('/evals/.results/') && !file.endsWith('/evals/ledger.tsv'))
    : []
  scanProjectIds(files, SYNTHETIC_IDS)
}

function walkAll(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) return []
    return entry.isDirectory() ? walkAll(path) : [path]
  })
}

function scanProjectIds(files, synthetic = new Set()) {
  const denylistPath = join(ROOT, '.product-denylist')
  const names = existsSync(denylistPath)
    ? readFileSync(denylistPath, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    : []
  for (const file of files) {
    const buffer = readFileSync(file)
    if (buffer.subarray(0, 4096).includes(0)) continue
    buffer.toString('utf8').split('\n').forEach((line, i) => {
      const where = `${file.replace(`${ROOT}/`, '')}:${i + 1}`
      // Standards (SHA-256, ISO-8601, RFC-7231, CVE-…) look like a ticket but are not one.
      const ticket = [...line.matchAll(/\b(?!AC-|SHA-|ISO-|RFC-|CVE-|UTF-|WCAG-|HTTP-|ECMA-|ES-)[A-Z]{2,6}-\d{3,5}\b/g)].find((match) => !synthetic.has(match[0]))
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
    const kind = lstatSync(path)
    if (kind.isSymbolicLink()) {
      failLink(path)
      return []
    }
    if (kind.isDirectory()) return walkMarkdown(path)
    return name.endsWith('.md') ? [path] : []
  })
}

/**
 * Cross-references inside the plugin: "/stage-check, Step 4.4" and "`references/x.md`, "Section"" must lead to an
 * existing heading (or a bold run-in label). A renamed step or section otherwise leaves a reference that
 * points nowhere, and nobody notices until the model follows it. Sources: everything under the plugin
 * (md, mjs, json) and the root README.md / ROLLOUT.md. The Russian step form is still read.
 */
function validateXrefs(pluginDir) {
  const skillsDir = join(ROOT, pluginDir, 'skills')
  if (!existsSync(skillsDir)) return
  const skills = readdirSync(skillsDir).filter((name) => existsSync(join(skillsDir, name, 'SKILL.md')))
  if (!skills.length) return
  const norm = (s) => s.replace(/[`*_]/g, '').replace(/[«»"“”]/g, '').replace(/\s+/g, ' ').replace(/[.:\s]+$/, '').trim().toLowerCase()
  const outlines = new Map()
  const outline = (file) => {
    if (outlines.has(file)) return outlines.get(file)
    const result = { headings: [], bold: [], steps: new Set() }
    let fence = null
    let section = null
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const f = line.match(/^\s*(`{3,}|~{3,})/)
      if (f) {
        fence = fence ? (f[1][0] === fence ? null : fence) : f[1][0]
        continue
      }
      if (fence) continue
      const h = line.match(/^(#{1,6})\s+(.*?)\s*$/)
      if (h) {
        result.headings.push(norm(h[2]))
        const s = h[2].match(/^(?:Step|Шаг)\s+(\d+(?:\.\d+)?)/i)
        section = s ? s[1] : null
        if (s) result.steps.add(s[1])
        continue
      }
      // "N. item" inside "Step N" is the sub-step N.M
      const item = section && line.match(/^\s{0,3}(\d+)\.\s/)
      if (item && !section.includes('.')) result.steps.add(`${section}.${item[1]}`)
      const bold = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)?\*\*([^*]+?)\*\*/)
      if (bold) result.bold.push(norm(bold[1]))
    }
    outlines.set(file, result)
    return result
  }
  const walkFiles = (dir) =>
    readdirSync(dir).flatMap((name) => {
      if (name === 'node_modules' || name === '.git') return []
      const path = join(dir, name)
      const kind = lstatSync(path)
      if (kind.isSymbolicLink()) {
        failLink(path)
        return []
      }
      if (kind.isDirectory()) return walkFiles(path)
      return /\.(md|mjs|json)$/.test(name) ? [path] : []
    })
  const sources = [...walkFiles(join(ROOT, pluginDir)), ...['README.md', 'ROLLOUT.md'].map((name) => join(ROOT, name)).filter((path) => existsSync(path))]
  const names = skills.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const stepNo = '\\d+(?:\\.\\d+)?'
  const stepRe = new RegExp(`(?<![\\w-])\`?\\/?(${names})\`?(?:\\s+skill)?,?\\s+\`?(?:Steps?|Шаг[иа]?)\\s+(${stepNo}(?:\\s*[–-]\\s*${stepNo})?(?:(?:,\\s*(?:and\\s+|и\\s+)?|\\s+(?:and|и)\\s+)${stepNo}(?:\\s*[–-]\\s*${stepNo})?)*)`, 'gi')
  const sectionRe = /(`?[\w.${}\/<>-]+`?)\s*,\s*(?:step\s+|шаг\s+)?(?:«([^»\n]+)»|"([^"\n]+)"|“([^”\n]+)”)/gi
  const skillFile = (name) => join(skillsDir, name, 'SKILL.md')
  const mdTarget = (src, token) => {
    const skillDir = src.slice(ROOT.length + 1).match(/^(plugins\/[^/]+\/skills\/[^/]+)\//)?.[1]
    const candidates = [join(ROOT, pluginDir, token), join(dirname(src), token), skillDir && join(ROOT, skillDir, token), join(ROOT, token)]
    return candidates.find((path) => path && existsSync(path) && statSync(path).isFile()) ?? null
  }
  for (const src of sources) {
    const rel = src.slice(ROOT.length + 1)
    readFileSync(src, 'utf8').split('\n').forEach((line, i) => {
      const where = `${rel}:${i + 1}`
      for (const m of line.matchAll(stepRe)) {
        for (const step of m[2].match(/\d+(?:\.\d+)?/g)) {
          if (!outline(skillFile(m[1])).steps.has(step)) fail(where, `reference «${m[1]}, Step ${step}» — no such step in skills/${m[1]}/SKILL.md`)
        }
      }
      for (const m of line.matchAll(sectionRe)) {
        const token = m[1].replace(/`/g, '')
        const name = m[2] ?? m[3] ?? m[4]
        const bare = token.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, '').replace(/^\//, '').replace(/^skills\//, '')
        let target = null
        if (skills.includes(bare)) target = skillFile(bare)
        else if (/\.md$/.test(token)) {
          target = mdTarget(src, token)
          if (!target) {
            fail(where, `reference «${token}, "${name}"» — file not found`)
            continue
          }
        } else continue
        const query = norm(name).replace(/^(?:step|шаг)\s+/, '')
        const o = outline(target)
        if (!o.headings.some((h) => h.includes(query)) && !o.bold.some((h) => h.includes(query))) {
          fail(where, `reference «${token}, "${name}"» — no such heading or bold label in ${target.slice(ROOT.length + 1)}`)
        }
      }
    })
  }
}

/**
 * Cyrillic outside the allowlist (scripts/cyrillic-allowlist.json). The plugin is English; Russian stays only where
 * it is the second supported task language or a trigger phrase: each rule there is a glob, an optional
 * line regex and a reason. Scans tracked and untracked, not ignored files (`git ls-files --cached --others --exclude-standard`); outside a git checkout it is skipped with a warning, and fails under CI.
 */
function validateCyrillic() {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (listed.status !== 0) {
    if (process.env.CI) return fail('scripts/validate.mjs', 'Cyrillic check cannot run: not a git checkout')
    console.warn('Cyrillic check skipped: not a git checkout')
    return
  }
  const allowlistPath = join(ROOT, 'scripts/cyrillic-allowlist.json')
  if (!existsSync(allowlistPath)) return fail('scripts/cyrillic-allowlist.json', 'no allowlist — Cyrillic cannot be checked')
  const globToRegExp = (glob) => {
    let out = ''
    for (let i = 0; i < glob.length; i++) {
      const ch = glob[i]
      if (ch === '*') {
        if (glob[i + 1] === '*') {
          i++
          if (glob[i + 1] === '/') {
            i++
            out += '(?:.*/)?'
          } else out += '.*'
        } else out += '[^/]*'
      } else if (ch === '?') out += '[^/]'
      else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
    return new RegExp(`^${out}$`)
  }
  const data = readJson('scripts/cyrillic-allowlist.json')
  const rules = (data?.rules ?? []).map((rule) => {
    if (!rule.reason) fail('scripts/cyrillic-allowlist.json', `rule for «${rule.glob}» has no reason`)
    return { glob: globToRegExp(rule.glob), line: rule.line ? new RegExp(rule.line, 'u') : null }
  })
  for (const path of listed.stdout.split('\0').filter(Boolean)) {
    const abs = join(ROOT, path)
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue
    const buffer = readFileSync(abs)
    if (buffer.includes(0)) continue
    const applicable = rules.filter((rule) => rule.glob.test(path))
    if (applicable.some((rule) => !rule.line)) continue
    const hits = []
    buffer.toString('utf8').split('\n').forEach((line, i) => {
      if (/[\u0400-\u052F]/.test(line) && !applicable.some((rule) => rule.line.test(line))) hits.push(i + 1)
    })
    if (hits.length) fail(`${path}:${hits.slice(0, 8).join(',')}`, `Cyrillic outside the allowlist in ${hits.length} line(s) — translate it or add a rule with a reason to scripts/cyrillic-allowlist.json`)
  }
}

/**
 * The eval cases (VT-3 stage 6). Free: no model call.
 *  - every case is blind: the leak lint builds each one (tree, prompts, paths, git history, MCP config) and must find nothing (AC-6.1);
 *    a copy with a planted «eval» word must be aborted;
 *  - the finding grader does not count a negated mention («formatTime — no duplicates found») as a finding (AC-6.4);
 *  - every non-routing case has at least one forbid-family grader, a routing case has forbidSkills;
 *  - a case added after 0494f32 carries `provenFailing`, its failing run on the previous tag or with the skill ablated (AC-6.6);
 *  - the project-id check runs over evals/** as well (AC-6.7).
 */
const FROZEN_CASES = new Set([
  'dead-code-orphan', 'deps-audit-duplicate-lib', 'docs-lookup-not-installed', 'docs-lookup-version-mismatch', 'human-text-check-clean',
  'human-text-check-feature-doc', 'human-text-check-injection', 'human-text-check-violations', 'i18n-hardcode', 'pro-review-clean-ac',
  'pro-review-cross-stage-dup', 'pro-review-language-en', 'pro-review-language-ru', 'routing-figma-compare', 'routing-figma-compare-en',
  'routing-root-cause', 'routing-root-cause-en', 'routing-stage-check', 'routing-stage-check-en', 'routing-stays-quiet', 'routing-stays-quiet-en',
  'stage-implement-reuse',
])
const FORBID_FAMILY = ['forbid', 'findingsForbid', 'forbidSummary', 'filesForbid', 'traceForbid']
// A decision case (the orchestrator's choices) forbids a spawn or a tool instead of a report text.
const DECISION_FORBID_FAMILY = ['forbidAgents', 'forbidTools', 'traceForbid', 'forbidSummary']

async function validateEvals() {
  const casesDir = join(ROOT, 'evals/cases')
  if (!existsSync(casesDir)) return
  const names = readdirSync(casesDir).filter((name) => existsSync(join(casesDir, name, 'case.json')))
  for (const name of names) {
    const where = `evals/cases/${name}/case.json`
    const spec = readJson(where)
    if (!spec) continue
    if (spec.kind === 'routing') {
      if (!spec.forbidSkills?.length) fail(where, 'a routing case needs forbidSkills: a skill that must not be picked for this phrase')
    } else if (spec.kind === 'decision') {
      if (spec.agent) fail(where, 'a decision case runs the orchestrator skill as the main session: no `agent`')
      if (!DECISION_FORBID_FAMILY.some((key) => spec[key]?.length)) fail(where, `no forbid: a decision case needs at least one of ${DECISION_FORBID_FAMILY.join(' / ')} — what the orchestrator must not spawn, call or say`)
      if (!['expectAgents', 'askQuestion', 'agentPrompts', 'agentModel'].some((key) => spec[key]?.length)) fail(where, 'a decision case needs a positive grader: expectAgents / askQuestion / agentPrompts / agentModel')
    } else if (!FORBID_FAMILY.some((key) => spec[key]?.length)) {
      fail(where, `no forbid: add at least one of ${FORBID_FAMILY.join(' / ')} — what the agent must not do or say`)
    }
    if (!FROZEN_CASES.has(name)) {
      const proof = spec.provenFailing
      if (!proof || !proof.on || !proof.date || !Array.isArray(proof.failures) || !proof.failures.length) {
        fail(where, 'a case added after 0494f32 needs `provenFailing` {on, date, plugin, runs, failed, caseHash, failures}: its failing run on the previous tag or with the skill ablated (node scripts/eval.mjs --ref <tag> --record-failing <case>)')
      } else if (/^variant:/.test(proof.on) && !existsSync(join(casesDir, name, 'variants', `${proof.on.slice(8)}.json`))) {
        fail(where, `provenFailing.on is ${proof.on}, but evals/cases/${name}/variants/${proof.on.slice(8)}.json does not exist`)
      } else if (/^variant:/.test(proof.on) ? !(Number.isInteger(proof.runs) && proof.runs >= 3 && Number.isInteger(proof.failed) && proof.failed >= 2 && proof.failed <= proof.runs) : !Number.isInteger(proof.runs) || proof.runs < 1 || proof.failed !== proof.runs) {
        fail(where, /^variant:/.test(proof.on) ? `a variant's provenFailing needs runs >= 3 and failed >= 2 (a hand-made edit may be got around by a model, so the proof is a rate); got runs ${proof.runs}, failed ${proof.failed}` : `provenFailing must have failed === runs (every recorded run failed on the comparison); got runs ${proof.runs}, failed ${proof.failed}`)
      } else if (/^variant:/.test(proof.on) && proof.detection !== `${proof.failed}/${proof.runs}`) {
        fail(where, `a variant's provenFailing must state its detection rate: "detection": "${proof.failed}/${proof.runs}", written by --record-failing; got ${JSON.stringify(proof.detection)}`)
      } else {
        const { caseHash } = await import('./eval-lib.mjs')
        if (proof.caseHash !== caseHash(join(casesDir, name))) fail(where, 'provenFailing.caseHash does not match the case: the case changed since the failing run was recorded — record it again (node scripts/eval.mjs --ref <tag> --record-failing <case>)')
      }
    }
  }
  const linted = spawnSync(process.execPath, [join(ROOT, 'scripts/eval.mjs'), '--lint'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 })
  if (linted.status !== 0) fail('scripts/eval.mjs --lint', `the leak lint failed:\n${(linted.stdout + linted.stderr).split('\n').filter((line) => /^\s+|✘/.test(line)).slice(0, 12).join('\n')}`)
  await validateEvalSelfTests(names)
}

async function validateEvalSelfTests(names) {
  // Loaded here, not at the top: scripts/hooks-test.mjs runs copies of this file in directories that have no eval harness.
  const { acIdsFor, applyVariantEdits, caseHash, decisionSettings, questionLines, findingMatches, gradeAgent, gradeDecision, lintCase, matchScreenshotReads, patchDataDirOverride, unreadScreenshots } = await import('./eval-lib.mjs')
  const here = 'scripts/eval-lib.mjs'
  // AC-6.1: a copy of a case with a planted word is aborted, and the original passes.
  const probe = names.find((name) => existsSync(join(ROOT, 'evals/cases', name, 'base/CLAUDE.md'))) ?? names[0]
  if (probe) {
    const holder = mkdtempSync(join(tmpdir(), 'lint-probe-'))
    try {
      cpSync(join(ROOT, 'evals/cases', probe), join(holder, probe), { recursive: true })
      const claudeMd = join(holder, probe, 'base/CLAUDE.md')
      const original = readFileSync(claudeMd, 'utf8')
      appendFileSync(claudeMd, '\nThis project runs in an eval harness.\n')
      const hits = lintCase(join(holder, probe))
      if (!hits.some((hit) => hit.word.toLowerCase() === 'eval')) fail(here, `leak lint self-test: a copy of ${probe} with the word «eval» in CLAUDE.md was not aborted`)
      writeFileSync(join(holder, probe, 'case.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(holder, probe, 'case.json'), 'utf8')), prompt: 'Review this. The change is evaluated by retrieval of candidates.' }))
      const words = lintCase(join(holder, probe)).map((hit) => hit.word.toLowerCase())
      if (!words.includes('candidates') || words.includes('evaluated') || words.includes('retrieval')) fail(here, `leak lint self-test: the lint must stop at «candidates» and not at «evaluated» / «retrieval» (got ${words.join(', ')})`)
      writeFileSync(claudeMd, original)
      writeFileSync(join(holder, probe, 'case.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(holder, probe, 'case.json'), 'utf8')), prompt: 'Review the candidate list.', leakAllow: [{ word: 'candidate', why: 'a voting list' }] }))
      if (lintCase(join(holder, probe)).length) fail(here, 'leak lint self-test: a word in the case allowlist must pass')
    } finally {
      rmSync(holder, { recursive: true, force: true })
    }
  }
  // M-2: an archived plugin of an old tag, patched as `--ref` patches it, resolves its data directory to STAGE_PIPELINE_DATA_DIR even when CLAUDE_PLUGIN_DATA is set.
  for (const tag of ['stage-pipeline--v0.15.1', 'stage-pipeline--v0.18.0']) {
    let tar
    try {
      tar = execFileSync('git', ['archive', '--format=tar', tag, 'plugins/stage-pipeline'], { cwd: ROOT, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      continue // a checkout without the tag (a shallow CI clone): nothing to archive
    }
    const holder = mkdtempSync(join(tmpdir(), 'ref-probe-'))
    try {
      execFileSync('tar', ['-x', '-C', holder], { input: tar })
      const dir = join(holder, 'plugins/stage-pipeline')
      patchDataDirOverride(dir)
      const asked = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(join(dir, 'scripts/hooks/pipeline-state.mjs'))}); process.stdout.write(m.pluginDataDir())`], {
        encoding: 'utf8', env: { ...process.env, STAGE_PIPELINE_DATA_DIR: join(holder, 'data'), CLAUDE_PLUGIN_DATA: join(holder, 'claude-data') },
      })
      if (asked.stdout !== join(holder, 'data')) fail(here, `--ref data dir self-test: ${tag} patched resolves pluginDataDir() to «${asked.stdout}» ${asked.stderr.slice(0, 120)}, not the STAGE_PIPELINE_DATA_DIR override`)
    } catch (error) {
      fail(here, `--ref data dir self-test: ${tag}: ${error.message}`)
    } finally {
      rmSync(holder, { recursive: true, force: true })
    }
  }
  // VT-3 branch review M-2: a freshly written variant record validates. --record-failing hashes with the `on` it is about to write (the record on disk is the previous one).
  {
    const holder = mkdtempSync(join(tmpdir(), 'hash-probe-'))
    try {
      mkdirSync(join(holder, 'variants'))
      writeFileSync(join(holder, 'case.json'), JSON.stringify({ prompt: 'x' }))
      writeFileSync(join(holder, 'variants', 'v.json'), JSON.stringify({ edits: [] }))
      const written = caseHash(holder, 'variant:v') // what recordFailing writes: no record on disk yet
      writeFileSync(join(holder, 'case.json'), JSON.stringify({ prompt: 'x', provenFailing: { on: 'variant:v', caseHash: written } }))
      if (caseHash(holder) !== written) fail(here, 'caseHash self-test: the hash written by --record-failing for a variant differs from the one validate recomputes from the record on disk')
      if (caseHash(holder, 'ref:v0.1.0') === written) fail(here, 'caseHash self-test: a variants/ file did not count for the record that names it')
      writeFileSync(join(holder, 'case.json'), JSON.stringify({ prompt: 'x', provenFailing: { on: 'ref:v0.1.0', caseHash: 'x' } }))
      if (caseHash(holder, 'ref:v0.1.0') !== caseHash(holder)) fail(here, 'caseHash self-test: a ref record and the explicit on disagree')
    } finally {
      rmSync(holder, { recursive: true, force: true })
    }
  }
  // m-5: every variant of every case applies to a copy of the plugin (a variant whose `find` text left the skill is dead).
  for (const name of names) {
    const variantsDir = join(ROOT, 'evals/cases', name, 'variants')
    if (!existsSync(variantsDir)) continue
    for (const file of readdirSync(variantsDir).filter((f) => f.endsWith('.json'))) {
      const holder = mkdtempSync(join(tmpdir(), 'variant-probe-'))
      try {
        cpSync(join(ROOT, 'plugins/stage-pipeline'), join(holder, 'stage-pipeline'), { recursive: true })
        applyVariantEdits(join(holder, 'stage-pipeline'), JSON.parse(readFileSync(join(variantsDir, file), 'utf8')).edits, file.slice(0, -5))
      } catch (error) {
        fail(`evals/cases/${name}/variants/${file}`, `the variant does not apply to the current plugin: ${error.message}`)
      } finally {
        rmSync(holder, { recursive: true, force: true })
      }
    }
  }
  // AC-6.4: a negated mention is not a finding; a finding in the ledger form is.
  const negated = 'formatTime — no duplicates found'
  const asks = { severity: 'any', file: 'formatTime' }
  const expectMatches = (label, spec, text, count) => {
    const got = findingMatches(spec, text).length
    if ((count === 0) !== (got === 0)) fail(here, `finding grader self-test: ${label} — wanted ${count === 0 ? 'no match' : 'a match'}, got ${got}`)
  }
  expectMatches('the negation example in prose', asks, negated, 0)
  expectMatches('the negation example as a list item', asks, `- ${negated}`, 0)
  expectMatches('"not an orphan" under Deliberately kept', { severity: 'any', file: 'PromoBanner' }, '## Deliberately kept\n- `PromoBanner.tsx` (added by the task, not an orphan)', 0)
  expectMatches('"not an orphan" as a list item outside that section', { severity: 'any', file: 'PromoBanner' }, '- PromoBanner.tsx (added by the task, not an orphan)', 0)
  expectMatches('a finding with the wrong severity', { severity: 'critical', file: 'toClock' }, '- minor: src/orders/toClock.ts:12 repeats formatTime', 0)
  expectMatches('a finding with another line', { severity: 'major', file: 'toClock', line: 40 }, '- major: src/orders/toClock.ts:12 repeats formatTime', 0)
  expectMatches('a finding in the ledger form', { severity: 'major|critical', file: 'toClock', line: 12 }, '- major: src/orders/toClock.ts:12 repeats formatTime', 1)
  expectMatches('a table row without a severity word', { severity: 'any', file: 'OldBanner' }, '| 1 | Component `OldBanner` | src/components/OldBanner.tsx | its only use was replaced |', 1)
  // A negation counts only as the predicate attached to the file token, not anywhere on the line.
  expectMatches('"without" and "problems" in one finding line', { severity: 'major', file: 'toClock', line: 12 }, '- major: src/orders/toClock.ts:12 copies formatTime without the timezone argument, so output has problems', 1)
  expectMatches('"not reuse ... a duplicate" in one finding line', { severity: 'major', file: 'toClock', line: 12 }, '- major: src/orders/toClock.ts:12 does not reuse formatTime, a duplicate', 1)
  expectMatches('"no error shown ... no findings logged" in one finding line', { severity: 'major|critical', file: 'removeGuest' }, '- major: removeGuest is not awaited: no error shown to the user and no findings logged', 1)
  expectMatches('the negation example with a path and a line', asks, '- src/orders/formatTime.ts:3 — no duplicates found', 0)
  expectMatches('a finding that says "no" about something else', { severity: 'minor', file: 'a\\.ts', line: 5 }, '- minor: src/a.ts:5 — no error handling around fetch', 1)
  // M-1 (VT-3 final checks): the three real shapes of a pro-review report. The bracket item form of the skill's Step 5, a heading that is the finding, and a final message
  // that follows a report ending in «Could not verify» (the heading must not leak into the message).
  const portal = { severity: 'critical|major', file: 'DeleteGuestModal\\.tsx', line: 12 }
  expectMatches('the Step 5 bracket form', portal, '[major] src/DeleteGuestModal.tsx:12 — the delete is not awaited', 1)
  expectMatches('the Step 5 bracket form with the emoji', portal, '🟠 [major] src/DeleteGuestModal.tsx:12 — the delete is not awaited', 1)
  expectMatches('a finding heading', { ...portal, line: 11 }, '## Findings\n\n### M-1 (major) — `DeleteGuestModal.tsx:9-13`: removed awaits\n\nProse about it.', 1)
  expectMatches('a finding heading under «Discarded»', portal, '## Discarded at the re-check\n\n### M-9 (major) — DeleteGuestModal.tsx:12 — dropped', 0)
  const afterKept = { report: '## Findings\n\n- none\n\n## Could not verify\n\n- no paid run', summary: '- major: src/DeleteGuestModal.tsx:12 — the delete is not awaited' }
  if (gradeAgent({ findings: [{ ...portal, why: 'x' }] }, { repo: ROOT, ...afterKept, calls: [] }).failures.length) fail(here, 'finding grader self-test: a finding in the final message after a report ending in «Could not verify» was swallowed')
  if (!gradeAgent({ findingsForbid: [{ ...portal, why: 'x' }] }, { repo: ROOT, ...afterKept, calls: [] }).failures.length) fail(here, 'finding grader self-test: findingsForbid did not see a forbidden finding in the final message after «Could not verify»')
  // VT-3 branch review M-1: the agent's own summary shape (a counters line with «Discarded at the re-check: 0.» before the findings) is a counter, not a «kept» section.
  const realMessage = 'stage: uncommitted `git diff HEAD`, 1 file\n\nSummary: 🔴 0 · 🟠 1 · 🟡 0 · ⚪ 0. Discarded at the re-check: 0.\n\n- 🟠 `src/DeleteGuestModal.tsx:9-13` (M-1, AC-1.1) — `handleConfirm` lost `async`/`await`.\n\nCould not verify: no type_check.\n'
  expectMatches('a finding after the counters line of the real final message', portal, realMessage, 1)
  expectMatches('a finding after a «Discarded:» label line is still dropped', portal, 'Discarded at the re-check:\n- 🟠 `src/DeleteGuestModal.tsx:12` — dropped', 0)
  expectMatches('a finding after a bold «Could not verify:» label line is still dropped', portal, '**Could not verify:**\n- major: src/DeleteGuestModal.tsx:12 — x', 0)
  const graded = gradeAgent({ findings: [{ ...asks, why: 'x' }] }, { repo: ROOT, report: negated, summary: '', calls: [] })
  if (!graded.failures.length) fail(here, 'finding grader self-test: gradeAgent passed the negation example')
  // Trace graders: a denied call does not count; every screenshot must be opened.
  const call = (name, input, extra = {}) => ({ name, input, result: '', isError: false, denied: false, ...extra })
  const traced = (calls) => gradeAgent({ trace: [{ tool: 'Bash', input: 'floor-guard\\.mjs', why: 'floor-guard ran' }] }, { repo: ROOT, report: '', summary: '', calls }).failures.length
  if (traced([call('Bash', { command: 'node /p/scripts/floor-guard.mjs' })])) fail(here, 'trace grader self-test: a Bash call of floor-guard was not counted')
  if (!traced([call('Bash', { command: 'node /p/scripts/floor-guard.mjs' }, { isError: true, denied: true })])) fail(here, 'trace grader self-test: a denied call was counted')
  const shot = call('mcp__plugin_stage-pipeline_chrome-devtools__take_screenshot', { filePath: '/w/shot-1440.png' })
  if (unreadScreenshots([shot, call('Read', { file_path: '/w/shot-1440.png' })]).length) fail(here, 'screenshot grader self-test: an opened screenshot was reported')
  if (!unreadScreenshots([shot, call('Read', { file_path: '/w/other.png' })]).length) fail(here, 'screenshot grader self-test: an unopened screenshot passed')
  if (!unreadScreenshots([call('mcp__plugin_stage-pipeline_chrome-devtools__take_screenshot', { filePath: '/w/1440.png' }), call('Read', { file_path: '/w/dark-1440.png' })]).length) fail(here, 'screenshot grader self-test: dark-1440.png was taken for an opening of 1440.png')
  const matched = matchScreenshotReads([{ path: '/private/tmp/s/a.png', ts: 1 }, { path: 'b.png', ts: 2 }, { path: '/w/c.png', ts: 3 }, { path: '/w/c.png', ts: 6 }], [{ path: '/tmp/s/a.png', ts: 4 }, { path: '/x/y/b.png', ts: 4 }, { path: '/w/c.png', ts: 7 }])
  if (matched.map((t) => t.read).join() !== 'true,true,false,true') fail(here, `screenshot matcher self-test: /private fold, a relative tail and the re-shoot rule — got ${matched.map((t) => t.read).join()}, wanted true,true,false,true`)
  // Decision graders: spawn types, the tagged AC IDs in a prompt, the model parameter, forbidden tools, the question text.
  const stagesText = '### Stage 1: A  [status: todo]\nAcceptance criteria:\n- `AC-1.1` x - [verify: figma-compare]\n- `AC-1.2` y - [verify: devtools-verify]\n- `AC-1.3` z - [verify: pro-review, devtools-verify]\n### Stage 2: B\n- `AC-2.1` w - [verify: devtools-verify]\n'
  if (acIdsFor(stagesText, 1, 'devtools-verify').join() !== 'AC-1.2,AC-1.3' || acIdsFor(stagesText, 1, 'figma-compare').join() !== 'AC-1.1') fail(here, 'decision grader self-test: acIdsFor did not take the IDs of the stage by the verifier tag')
  const spawn = (type, prompt, model) => call('Agent', { subagent_type: `stage-pipeline:${type}`, prompt, ...(model ? { model } : {}) })
  const decided = (spec, calls, extra = {}) => gradeDecision(spec, { calls, hooks: [], final: '', stagesText, configText: '- review_model: opus', ...extra }).failures.length
  const dv = { agent: 'devtools-verify', acs: { tag: 'devtools-verify', stage: 1 } }
  if (decided({ expectAgents: ['devtools-verify'], agentPrompts: [dv] }, [spawn('devtools-verify', 'AC-1.2 and AC-1.3 at 1440')])) fail(here, 'decision grader self-test: a complete spawn was failed')
  if (!decided({ expectAgents: ['devtools-verify'] }, [spawn('pro-review', 'x')])) fail(here, 'decision grader self-test: a missing agent passed')
  if (!decided({ forbidAgents: ['proto-compare'] }, [spawn('proto-compare', 'x')])) fail(here, 'decision grader self-test: a forbidden agent passed')
  if (!decided({ agentPrompts: [dv] }, [spawn('devtools-verify', 'only AC-1.2')])) fail(here, 'decision grader self-test: a prompt missing a tagged AC ID passed')
  if (!decided({ agentPrompts: [dv] }, [spawn('devtools-verify', 'AC-1.2, AC-1.30')])) fail(here, 'decision grader self-test: AC-1.30 was taken for AC-1.3')
  // VT-3 branch converge C2: the plain-text form of a question after `Confirmed:` (the recorded variant runs stop with one, no AskUserQuestion call).
  const quiet = { forbidQuestionEnd: { why: 'x' } }
  if (!decided(quiet, [], { final: 'I stopped before writing any code.\n\n**Should `PAGE_SIZE` be 20 or 50?**\n\n- 20: the list view.' })) fail(here, 'decision grader self-test: a final text that asks a question with no spawn passed')
  if (!decided(quiet, [], { final: 'Neither choice is hard to undo.\n\nReply with A, B or another number. I will record it and go on.' })) fail(here, 'decision grader self-test: a final text that asks for a reply with no spawn passed')
  if (decided(quiet, [spawn('stage-implement', 'x')], { final: 'Should this be 20 or 50? I decided 20 and recorded it.' })) fail(here, 'decision grader self-test: a final text with a question in a run that spawned the maker was failed')
  if (decided(quiet, [], { final: 'Decided: PAGE_SIZE 20 (matches the list view). Starting stage 1.\n\n```\nwhy not 50?\n```\nSee https://x.dev/a?b=1 for the spec; is it 20? yes, so go on.' })) fail(here, 'decision grader self-test: a «?» inside a sentence, a URL or a code fence counted as a question')
  if (questionLines('A\nOK?\n> **Which one?**\n').length !== 2) fail(here, 'decision grader self-test: questionLines did not read a bare and a bold quoted question line')
  const review = { agentModel: [{ agent: 'pro-review', model: 'config:review_model', why: 'x' }] }
  if (decided(review, [spawn('pro-review', 'x', 'opus')])) fail(here, 'decision grader self-test: the right model was failed')
  if (!decided(review, [spawn('pro-review', 'x')]) || !decided(review, [spawn('pro-review', 'x', 'sonnet')])) fail(here, 'decision grader self-test: a missing or wrong model passed')
  if (!decided({ forbidTools: [{ tool: 'AskUserQuestion', why: 'x' }] }, [call('AskUserQuestion', { questions: [] })])) fail(here, 'decision grader self-test: a forbidden tool passed')
  const ask = { askQuestion: [{ pattern: '/orders', why: 'x' }] }
  if (decided(ask, [call('AskUserQuestion', { questions: [{ question: 'Log in at /orders?' }] })]) || !decided(ask, [call('AskUserQuestion', { questions: [{ question: 'Log in?' }] })])) fail(here, 'decision grader self-test: the question text grader is wrong')
  if (decided(ask, [], { final: 'log in at /orders' }) || !decided(ask, [], { final: 'nothing' })) fail(here, 'decision grader self-test: the final-text fallback is wrong')
  // The harness hook that ends a decision session must deny the call and stop the session.
  const holder = mkdtempSync(join(tmpdir(), 'gate-probe-'))
  try {
    const settings = JSON.parse(readFileSync(decisionSettings(holder), 'utf8'))
    const hook = settings.hooks?.PreToolUse?.[0]
    const out = spawnSync(process.execPath, [hook?.hooks?.[0]?.command.match(/"(.+)"/)?.[1] ?? ''], { input: '{}', encoding: 'utf8' })
    const verdict = (() => { try { return JSON.parse(out.stdout) } catch { return {} } })()
    if (!/Agent/.test(hook?.matcher ?? '') || !/AskUserQuestion/.test(hook?.matcher ?? '') || verdict.continue !== false || verdict.hookSpecificOutput?.permissionDecision !== 'deny') fail(here, 'decision harness self-test: the stop hook must match Agent|Task|AskUserQuestion and answer deny + continue:false')
  } finally {
    rmSync(holder, { recursive: true, force: true })
  }
}

/**
 * VT-3 stage 7: the plugin's own correction loop, on the dev side.
 * - hook rule IDs: every ID a hook emits has an entry in scripts/hook-rules.json with an incident and a legitimate fixture of hooks-test.mjs (scripts/hook-rules.mjs);
 * - rule -> enforcer table: every imperative of the SKILL.md files maps to a hook rule, a script or `prose`, and the prose count may not pass its baseline (scripts/rule-enforcers.mjs);
 * - docs-vs-tree: unknown slash commands, broken relative links and broken anchors in the READMEs, ROLLOUT, CHANGELOG (links only) and references (scripts/docs-tree.mjs).
 * Each has a free self-test: the check must fail on a doctored copy.
 */
async function validateCorrectionLoop() {
  const here = 'scripts/validate.mjs'
  const { checkHookRules, readHookSources } = await import('./hook-rules.mjs')
  const enforcers = await import('./rule-enforcers.mjs')
  const { checkDocs, markdownUnder, DEV_COMMANDS } = await import('./docs-tree.mjs')
  // A dev-repo command is a dev skill of this repo (`.claude/skills/<name>/SKILL.md`, not a plugin skill): each one named in DEV_COMMANDS must exist there.
  for (const name of DEV_COMMANDS) if (!existsSync(join(ROOT, '.claude/skills', name, 'SKILL.md'))) fail('scripts/docs-tree.mjs', `DEV_COMMANDS names /${name}, but .claude/skills/${name}/SKILL.md does not exist`)
  const pluginDir = 'plugins/stage-pipeline'

  // hook rule IDs
  const testSource = readFileSync(join(ROOT, 'scripts/hooks-test.mjs'), 'utf8')
  const sources = readHookSources(ROOT)
  const map = readJson('scripts/hook-rules.json')
  for (const error of checkHookRules({ sources, map, testSource })) fail(error.split(': ')[0], error.slice(error.indexOf(': ') + 2))
  const known = new Set(Object.keys(map?.rules ?? {}))
  {
    const one = Object.keys(map?.rules ?? {})[0]
    const base = { sources, map, testSource }
    const rule = (extra) => checkHookRules({ ...base, ...extra }).length
    if (rule({ sources: { ...sources, 'git-guard.mjs': `${sources['git-guard.mjs']}\ndeny('git-guard/invented-rule')` } }) !== 1) fail(here, 'hook-rules self-test: a rule ID with no map entry was not reported')
    if (one && rule({ map: { rules: { ...map.rules, [one]: { ...map.rules[one], incident: ['a fixture that is not in hooks-test'] } } } }) !== 1) fail(here, 'hook-rules self-test: an entry naming a missing fixture was not reported')
    if (one && rule({ map: { rules: { ...map.rules, [one]: { incident: map.rules[one].incident, head: map.rules[one].head } } } }) !== 1) fail(here, 'hook-rules self-test: an entry without a legitimate fixture was not reported')
    if (one && rule({ map: { rules: { ...map.rules, [one]: { ...map.rules[one], head: undefined } } } }) !== 1) fail(here, 'hook-rules self-test: a rule with no message head was not reported')
    if (one && rule({ map: { rules: { ...map.rules, [one]: { ...map.rules[one], head: 'a head that no hook writes' } } } }) !== 1) fail(here, 'hook-rules self-test: a head that is not in the hooks was not reported')
  }

  // rule -> enforcer table
  const extracted = enforcers.extractAll(join(ROOT, pluginDir, 'skills'))
  if (process.argv.includes('--update-enforcers')) {
    const before = enforcers.readTable()
    const next = enforcers.updatedTable(extracted, before, { raise: process.argv.includes('--raise-enforcer-baseline') })
    enforcers.writeTable(next)
    console.log(`scripts/rule-enforcers.json updated: prose baseline ${before.proseBaseline} -> ${next.proseBaseline}`)
  }
  const table = enforcers.readTable()
  const exists = (path) => existsSync(join(ROOT, path))
  for (const error of enforcers.checkEnforcers(extracted, table, { knownRules: known, exists })) fail(error.file, error.message)
  {
    // AC-7.3: a prose-only imperative added to stage-check fails until the table maps it
    const skillText = readFileSync(join(ROOT, pluginDir, 'skills/stage-check/SKILL.md'), 'utf8')
    const added = 'You must never close a stage on the strength of a green lint alone.'
    const doctored = `${skillText.replace(/\n+$/, '')}\n\n${added}\n`
    const mine = { 'stage-check': enforcers.extractImperatives(doctored) }
    // The table of stage-check as it is, with anything unmapped counted as accepted prose: the self-test is about the one added sentence, whatever else is open.
    const ownRules = Object.fromEntries(extracted['stage-check'].map((item) => [enforcers.keyOf('stage-check', item.hash), table.rules[enforcers.keyOf('stage-check', item.hash)] ?? { to: 'prose', baseline: true }]))
    const ownTable = { proseBaseline: Object.values(ownRules).filter((rule) => rule.to === 'prose').length, rules: ownRules }
    const run = (items, withTable) => enforcers.checkEnforcers(items, withTable, { knownRules: known, exists })
    const hash = enforcers.hashOf(added)
    if (run({ 'stage-check': extracted['stage-check'] }, ownTable).length) fail(here, 'rule-enforcers self-test: the untouched stage-check text does not pass its own table')
    const unmapped = run(mine, ownTable)
    if (!unmapped.some((error) => error.file.includes('stage-check/SKILL.md:') && /no enforcer/.test(error.message))) fail(here, 'rule-enforcers self-test: a prose-only imperative added to stage-check was not reported with skill and line')
    const asProse = { ...ownTable, rules: { ...ownTable.rules, [enforcers.keyOf('stage-check', hash)]: { to: 'prose' } } }
    if (!run(mine, asProse).some((error) => /baseline/.test(error.message))) fail(here, 'rule-enforcers self-test: a new prose-only imperative passed the prose baseline')
    const asScript = { ...ownTable, rules: { ...ownTable.rules, [enforcers.keyOf('stage-check', hash)]: { to: `script:${pluginDir}/scripts/floor-guard.mjs` } } }
    if (run(mine, asScript).length) fail(here, 'rule-enforcers self-test: an imperative mapped to an existing script was still reported')
    const toGhost = { ...ownTable, rules: { ...ownTable.rules, [enforcers.keyOf('stage-check', hash)]: { to: 'hook:git-guard/ghost' } } }
    if (!run(mine, toGhost).some((error) => /not a rule ID/.test(error.message))) fail(here, 'rule-enforcers self-test: a hook target that is no rule ID passed')
  }

  // docs-vs-tree
  const skills = readdirSync(join(ROOT, pluginDir, 'skills')).filter((name) => existsSync(join(ROOT, pluginDir, 'skills', name, 'SKILL.md')))
  const files = [...['README.md', 'ROLLOUT.md', 'CHANGELOG.md', `${pluginDir}/README.md`].map((path) => join(ROOT, path)), ...markdownUnder(join(ROOT, pluginDir, 'references'))].filter((path) => existsSync(path))
  // CHANGELOG is history: it names commands that no longer exist and placeholders like "/skill", so only its links and anchors are checked.
  const commandsIn = (file) => !file.endsWith(`${sep}CHANGELOG.md`)
  for (const failure of checkDocs({ root: ROOT, files, skills, commandsIn })) fail(failure.where, failure.message)
  {
    const dir = mkdtempSync(join(tmpdir(), 'docs-tree-'))
    try {
      writeFileSync(join(dir, 'other.md'), '# Other\n\n## A section\n')
      writeFileSync(join(dir, 'README.md'), '# Title\n\nRun /stage-check, /audit-runs, then /stage-chek.\n\nSee [ok](#title), [ok2](other.md#a-section), [gone](#no-such-heading), [bad](other.md#nope) and [file](missing.md).\n')
      const got = checkDocs({ root: dir, files: [join(dir, 'README.md')], skills })
      const hit = (pattern) => got.some((item) => pattern.test(item.message) && /^README\.md:\d+$/.test(item.where))
      if (!hit(/unknown slash command `\/stage-chek`/) || got.some((item) => /`\/stage-check`|`\/audit-runs`/.test(item.message))) fail(here, 'docs-tree self-test: an unknown slash command was not reported (or a known one was)')
      if (!hit(/broken anchor.*no-such-heading/) || !hit(/broken anchor.*nope/) || got.some((item) => /#title|a-section/.test(item.message))) fail(here, 'docs-tree self-test: a broken anchor was not reported (or a good one was)')
      if (!hit(/broken link.*missing\.md/)) fail(here, 'docs-tree self-test: a broken relative link was not reported')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}


/**
 * VT-3 stage 7b: `scripts/run-audit.mjs` counts what the transcripts show; this is its free self-test, on SYNTHETIC transcripts in scripts/fixtures/run-audit/ (two runs of a made-up task TK-1,
 * a session of another task, three subagents). The fixtures are under scripts/ and not under evals/ because they are not eval cases (evals/cases/* is checked case by case as blind, graded cases);
 * the leak and ticket-id scan of validate (`scanProjectIds`) is run over them here as over evals/**. Each count of the digest is checked against the number the fixture was built to give.
 */
async function validateRunAudit() {
  const here = 'scripts/validate.mjs'
  const fixtures = join(ROOT, 'scripts/fixtures/run-audit')
  scanProjectIds(walkAll(fixtures), new Set(['TK-1', 'OT-2']))
  const { runAudit, encodeProject, renderMarkdown, bashWrite } = await import('./run-audit.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'run-audit-'))
  const bad = (what) => fail(here, `run-audit self-test: ${what}`)
  try {
    cpSync(fixtures, dir, { recursive: true })
    // the fixtures name /synthetic/repo; the copy lives elsewhere, so the paths are pointed at it
    for (const file of walkAll(join(dir, 'transcripts'))) if (file.endsWith('.jsonl')) writeFileSync(file, readFileSync(file, 'utf8').replaceAll('/synthetic/repo', join(dir, 'repo')))
    const checks = join(dir, 'repo/tasks/TK-1/checks')
    utimesSync(join(checks, 'pro-review-1.md'), new Date('2026-03-02T13:00:00Z'), new Date('2026-03-02T13:00:00Z'))
    utimesSync(join(checks, 'pro-review-2.md'), new Date('2026-03-05T12:00:00Z'), new Date('2026-03-05T12:00:00Z'))
    const git = (...args) => execFileSync('git', ['-C', join(dir, 'repo'), '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore', env: { ...process.env, GIT_COMMITTER_DATE: '2026-03-03T12:00:00Z', GIT_AUTHOR_DATE: '2026-03-03T12:00:00Z' } })
    git('init', '-q', '-b', 'feat/TK-1/demo')
    git('add', '-A')
    git('commit', '-q', '-m', 'demo commit')
    const base = { repos: [join(dir, 'repo')], transcripts: [join(dir, 'transcripts')], tasks: ['TK-1'], plugin: join(dir, 'plugin') }
    const report = runAudit(base)
    const task = report.tasks[0]
    const [one, two] = task.runs
    const eq = (what, got, want) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) bad(`${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)
    }
    if (!task || task.error || task.runs.length !== 2) return bad(`two runs were expected: ${JSON.stringify(task?.error ?? task?.runs?.length)}`)
    eq('sessions read (the session of another task is not)', [report.generatedFrom.sessionFiles, task.sessionsRead.length], [2, 1])
    eq('stages without devtools-verify', [task.devtools.uiStages, task.devtools.without.map((x) => x.stage), task.devtools.without.filter((x) => x.skipped).map((x) => x.stage)], [3, ['2', '4'], ['4']])
    eq('a stage with only a ticked devtools-verify box is not covered and is listed as box only', [task.devtools.without.map((x) => x.stage), task.devtools.boxOnly.map((x) => x.stage)], [['2', '4'], ['2']])
    eq('spawns of run 1 (the foreign spawn is left out)', one.spawns.map((x) => [x.type.replace(/^stage-pipeline:/, ''), x.model, x.promptChars]), [['stage-implement', null, 44], ['devtools-verify', 'sonnet', 57], ['pro-review', null, 33]])
    eq('hook denials of run 1 (rule by the message head; an unknown message by its hook event)', one.denials.map((x) => x.rule).sort(), ['PostToolUse:Edit', 'PreToolUse:Bash', 'git-guard/normal-mode', 'journal-gate/close|journal-gate/journal|journal-gate/report'])
    eq('AskUserQuestion after Confirmed, run 1 / run 2', [one.mid.asksTotal, one.mid.afterConfirmed.length, two.mid.afterConfirmed.length], [1, 1, 1])
    eq('orchestrator edits to source, run 1 (one Edit in the repo, one Bash sed -i; task-dir edits are not source)', [one.sourceEdits.filter((x) => x.tool === 'Edit' && x.where === 'repo').length, one.sourceEdits.filter((x) => x.tool === 'Bash').map((x) => x.where), one.sourceEdits.filter((x) => x.tool !== 'Bash').length], [1, ['relative'], 1])
    const sh = one.screenshots
    eq('screenshots taken / failed / with a file / read back (a.png saved as a.jpeg, b.png relative to the taker cwd) / never read (d.jpeg, saved under /private/tmp) / inline', [sh.taken, sh.failed, sh.withFile, sh.readBack, sh.notRead, sh.inline], [4, 1, 3, 2, 1, 1])
    eq('screenshots left out as another ticket\'s', task.screenshotsOutsideRuns.leftOutForeign, 1)
    eq('findings vs ledger, run 1 (a report modified in the window)', [one.findings.length, sum(one.findings, 'major'), sum(one.findings, 'lines')], [1, 2, 1])
    eq('user messages after done, run 1 (the harness text is not a person; only a length is kept, never the text)', one.userAfterDone.map((x) => [x.chars, x.head]), [[37, undefined]])
    if (renderMarkdown(report).includes('please change the title')) bad('the markdown prints the text of a user message')
    eq('commits after close, run 1', one.commitsAfterClose.list.map((x) => x.subject), ['demo commit'])
    eq('skills and agents never invoked, run 1', [one.neverSkills, one.neverAgents], [['root-cause'], ['task-converge']])
    eq('stages implemented / verified / implemented without devtools-verify, run 1 and run 2', [one.implementedStages, one.verifiedStages, one.implementedWithoutDevtools, two.implementedWithoutDevtools], [['1'], ['1'], [], ['2']])
    if (!renderMarkdown(report).includes('git-guard/normal-mode')) bad('the markdown does not carry the rule ID of a denial')
    // VT-3 branch review m-5: no raw text in the digest. A denial that matches no rule (a force-guard ask-rule message starts with the command; here a secret-shaped URL) shows the event and the tool only;
    // a question shows its header and the length of the asked text, never the text.
    const rendered = renderMarkdown(report)
    if (/SECRET|ghp_|github\.com|force-run/.test(rendered)) bad('the markdown copies text of a command, a denial message or a question (a secret-shaped URL reached the digest)')
    if (!rendered.includes('PreToolUse:Bash') || !/header "Label", \d+ chars of question text/.test(rendered)) bad('the markdown does not show an unmatched denial as event:tool or a question as header and length')
    // a session given explicitly is one more run, with every event of it
    const withSession = runAudit({ ...base, sessions: [join(dir, 'transcripts/s1.jsonl')] })
    eq('a session given explicitly is audited as a run of its own', [withSession.tasks[0].runs.length, withSession.tasks[0].runs[2]?.heading.startsWith('session s1'), withSession.tasks[0].runs[2]?.spawns.length], [3, true, 4])
    // inputs: explicit paths; the derived project directory is one directory named from the repo path, and an explicit --transcripts wins over it
    eq('the encoding of a repo path', encodeProject('/Users/x/my.repo_1'), '-Users-x-my-repo-1')
    const derived = runAudit({ ...base, transcripts: [] }).generatedFrom.transcriptPaths
    eq('without --transcripts exactly one derived directory is named', [derived.length, derived[0].endsWith(`/.claude/projects/${encodeProject(join(dir, 'repo'))}`)], [1, true])
    eq('an explicit --transcripts is used as given', report.generatedFrom.transcriptPaths, [join(dir, 'transcripts')])
    // S-2: a write-like command is shown as the program name and the target path, never its text; S-3: a run of -e flags is read in linear time.
    const secret = bashWrite('echo OPENAI_API_KEY=sk-proj-SECRET123 >> /synthetic/r/.env.local', { repoRoots: ['/synthetic/r'], taskDirs: [] })
    eq('a Bash source edit shows the program and the path only', secret?.label, 'echo -> /synthetic/r/.env.local')
    if (/SECRET|OPENAI/.test(bashWrite('cd /synthetic/r && TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 sed -i s/a/b/ f.txt', { repoRoots: ['/synthetic/r'], taskDirs: [] })?.label ?? '')) bad('a command label carries a secret-shaped word')
    const started = Date.now()
    bashWrite(`sed ${'-e -e '.repeat(100)}x`, { repoRoots: ['/synthetic/r'], taskDirs: [] })
    bashWrite(`sed ${'-n -e s/a/b/ '.repeat(60)}x`, { repoRoots: ['/synthetic/r'], taskDirs: [] })
    if (Date.now() - started > 1000) bad(`200 -e flags took ${Date.now() - started} ms: the sed regex backtracks`)
    const noSource = readFileSync(join(ROOT, 'scripts/run-audit.mjs'), 'utf8')
    if (/readdirSync\([^)]*\.claude\/projects['"`]\s*\)/.test(noSource) || /readdirSync\(\s*join\(homedir\(\),\s*['"]\.claude\/projects['"]\s*\)\s*\)/.test(noSource)) bad('the script lists ~/.claude/projects as a whole')
  } catch (error) {
    bad(`threw ${error?.stack ?? error}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const sum = (items, key) => items.reduce((total, item) => total + (item[key] ?? 0), 0)

// The fixtures of hooks-test copy validate.mjs alone into a throwaway repo, where nothing of this repo's dev tooling exists. That copy is told by its having no scripts/hooks-test.mjs
// (the dev repo always has it); only there the dev checks are skipped. In the dev repo a missing module is a failure, not a reason to check less.
const STANDALONE_COPY = !existsSync(join(ROOT, 'scripts/hooks-test.mjs'))
if (!STANDALONE_COPY) {
  const missing = ['hook-rules.mjs', 'rule-enforcers.mjs', 'docs-tree.mjs', 'run-audit.mjs'].filter((name) => !existsSync(join(ROOT, 'scripts', name)))
  for (const name of missing) fail('scripts/validate.mjs', `scripts/${name} is missing: the release rule, the rule -> enforcer table, docs-vs-tree and the run-audit self-test need it`)
  const noFixtures = !existsSync(join(ROOT, 'scripts/fixtures/run-audit'))
  if (noFixtures) fail('scripts/validate.mjs', 'scripts/fixtures/run-audit is missing: the run-audit self-test needs it')
  if (!missing.some((name) => name !== 'run-audit.mjs')) await validateCorrectionLoop()
  if (!missing.includes('run-audit.mjs') && !noFixtures) await validateRunAudit()
}

await validateEvals()
validateNoProjectIdsInEvals()

validateCyrillic()

if (errors.length) {
  console.error(`✘ Validation failed (${errors.length}):\n`)
  for (const error of errors) console.error(`  ${error}`)
  process.exit(1)
}

console.log('✔ Manifests, skills, agents, hooks, .mcp.json and CHANGELOG are in order')
