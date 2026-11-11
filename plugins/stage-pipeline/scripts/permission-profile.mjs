/**
 * The permission profile of the plugin as data: ../permissions/base.json plus the entries generated from the plugin itself
 * (Skill(...) per skill, mcp__* per server in .mcp.json). Shared by permissions.mjs (which writes settings.json) and the eval harness
 * (which passes the same entries to `claude -p`), so a run is allowed exactly what a user who applied the profile is allowed.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bashRulePattern } from './hooks/permission-rules.mjs'

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

/**
 * The allow / ask / deny lists for the given groups of the profile. A group's `narrowsAsk` takes an entry out of the profile's ask
 * and puts its narrower entries in its place: ask beats allow, so the group's allow would mean nothing next to the wide entry.
 */
export function wantedFor(pluginRoot, groups, profile = loadProfile(pluginRoot)) {
  const wanted = { allow: [], ask: [...profile.ask], deny: profile.deny }
  for (const group of groups) {
    wanted.allow.push(...profile.groups[group].allow)
    if (profile.groups[group].generated) wanted.allow.push(...generatedEntries(pluginRoot))
  }
  for (const [wide, narrow] of narrowedAsk(groups, profile)) {
    wanted.ask = wanted.ask.filter((entry) => entry !== wide)
    for (const entry of narrow) if (!wanted.ask.includes(entry)) wanted.ask.push(entry)
  }
  return wanted
}

/** `[[wide ask entry, [narrow entries]]]` of the given groups. */
export function narrowedAsk(groups, profile) {
  return groups.flatMap((group) => Object.entries(profile.groups[group]?.narrowsAsk ?? {}))
}

/**
 * The deny / ask rule that beats an allow entry: `{ key, rule }` or null. Claude Code checks deny, then ask, then allow, however
 * narrow the allow is, so `Bash(gh *)` in ask beats `Bash(gh pr view *)` — an exact comparison counted that allow as in place.
 * The entry's command is tried with an argument in place of its tail ` *`: an ask on the bare command alone (`Bash(git push -u origin)`)
 * does not beat the allow of its forms with arguments.
 */
export function overriddenBy(entry, lists) {
  const command = allowedCommand(entry)
  for (const key of ['deny', 'ask']) {
    for (const rule of lists[key] ?? []) {
      if (rule === entry || (command !== null && bashRulePattern(rule)?.test(command))) return { key, rule }
    }
  }
  return null
}

function allowedCommand(entry) {
  const body = String(entry).match(/^Bash\((.*)\)$/s)?.[1]?.trim()
  if (!body || body === '*') return null
  const tail = body.endsWith(' *') || body.endsWith(':*')
  return (tail ? `${body.slice(0, -2)} x` : body).replaceAll('*', '')
}
