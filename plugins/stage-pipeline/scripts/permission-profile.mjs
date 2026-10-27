/**
 * The permission profile of the plugin as data: ../permissions/base.json plus the entries generated from the plugin itself
 * (Skill(...) per skill, mcp__* per server in .mcp.json). Shared by permissions.mjs (which writes settings.json) and the eval harness
 * (which passes the same entries to `claude -p`), so a run is allowed exactly what a user who applied the profile is allowed.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const loadProfile = (pluginRoot) => JSON.parse(readFileSync(join(pluginRoot, 'permissions', 'base.json'), 'utf8'))

/** Skill(...) and mcp__* — from the plugin itself, so the list does not diverge from its contents */
export function generatedEntries(pluginRoot) {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'))
  const entries = []

  const skillsDir = join(pluginRoot, 'skills')
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir).sort()) {
      if (!existsSync(join(skillsDir, name, 'SKILL.md'))) continue
      entries.push(`Skill(${manifest.name}:${name})`, `Skill(${manifest.name}:${name} *)`)
    }
  }

  const mcpPath = join(pluginRoot, '.mcp.json')
  if (existsSync(mcpPath)) {
    const raw = JSON.parse(readFileSync(mcpPath, 'utf8'))
    for (const server of Object.keys(raw.mcpServers ?? raw)) {
      // the plugin's server is visible under both names — depends on the Claude Code version
      entries.push(`mcp__${server}`, `mcp__plugin_${manifest.name}_${server}`)
    }
  }
  // the persistent-profile browser `/pipeline-doctor` proposes (item 4a) is a local-scope server under the plugin's own name, not in .mcp.json
  entries.push('mcp__stage-pipeline-chrome')

  return entries
}

/** The allow / ask / deny lists for the given groups of the profile. */
export function wantedFor(pluginRoot, groups, profile = loadProfile(pluginRoot)) {
  const wanted = { allow: [], ask: profile.ask, deny: profile.deny }
  for (const group of groups) {
    wanted.allow.push(...profile.groups[group].allow)
    if (profile.groups[group].generated) wanted.allow.push(...generatedEntries(pluginRoot))
  }
  return wanted
}
