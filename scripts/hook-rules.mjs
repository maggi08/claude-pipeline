/**
 * Release rule for hook rules (VT-3 stage 7, K7.2): every rule ID a hook emits has an incident fixture and a legitimate fixture in scripts/hooks-test.mjs.
 * The IDs are the `'<hook>/<slug>'` strings written at the block or deny sites of the six hooks; `scripts/hook-rules.json` maps each to the names of its fixtures
 * (a name is a text that occurs in hooks-test.mjs), so the fixtures that already exist are not renamed or rewritten - a lane only appends. Dev repo only; validate.mjs runs it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const HOOKS = ['journal-gate', 'git-guard', 'agent-guard', 'force-guard', 'frames-guard', 'maker-guard']
const ID = new RegExp(`'((?:${HOOKS.join('|')})/[a-z0-9]+(?:-[a-z0-9]+)*)'`, 'g')

/** The rule IDs found in the sources of the hooks: `{ id: [hook file names] }`. */
export function foundRules(sources) {
  const found = new Map()
  for (const [name, text] of Object.entries(sources)) for (const m of text.matchAll(ID)) found.set(m[1], [...(found.get(m[1]) ?? []), name])
  return found
}

// `pipeline-state` holds a message that two hooks share (`dataDirReason`, K11c.1): its text is searched for heads, and holds no rule ID
export const readHookSources = (root) => Object.fromEntries([...HOOKS, 'pipeline-state'].map((name) => [`${name}.mjs`, readFileSync(join(root, 'plugins/stage-pipeline/scripts/hooks', `${name}.mjs`), 'utf8')]))

/** Failures of the map against the IDs in the hooks and the fixtures in the test source: `[string]`. */
export function checkHookRules({ sources, map, testSource }) {
  const errors = []
  const found = foundRules(sources)
  const rules = map?.rules ?? {}
  for (const [id, files] of found) {
    if (!rules[id]) errors.push(`${files[0]}: rule ${id} has no entry in scripts/hook-rules.json - an incident fixture (the hook says no) and a legitimate fixture (it lets the lookalike through) are needed in scripts/hooks-test.mjs`)
  }
  for (const [id, entry] of Object.entries(rules)) {
    if (found.has(id) && !(typeof entry?.head === 'string' && entry.head.length >= 12)) errors.push(`scripts/hook-rules.json: ${id} has no "head" - a literal stretch of its message, so that run-audit can name the rule behind a denial it reads in a transcript`)
    else if (entry?.head && !Object.values(sources).some((text) => text.includes(entry.head))) errors.push(`scripts/hook-rules.json: ${id}: the head "${entry.head}" is not in the hooks - the message changed, update the head`)
    if (!found.has(id)) errors.push(`scripts/hook-rules.json: ${id} is no rule ID of any hook - drop the entry or restore the rule`)
    for (const form of ['incident', 'legitimate']) {
      const names = entry?.[form]
      if (!Array.isArray(names) || !names.length) {
        errors.push(`scripts/hook-rules.json: ${id} has no ${form} fixture`)
        continue
      }
      for (const name of names) if (typeof name !== 'string' || !name || !testSource.includes(name)) errors.push(`scripts/hook-rules.json: ${id}: the ${form} fixture "${name}" is not in scripts/hooks-test.mjs`)
    }
  }
  return errors
}

/** The rule IDs whose message head the text carries (`[]` when none): a denial in a transcript shows the message, not the rule ID. Rules with a shared message come together. */
export function rulesByHead(text, map) {
  const flat = String(text).replace(/\s+/g, ' ')
  return Object.entries(map?.rules ?? {})
    .filter(([, entry]) => entry?.head && flat.includes(entry.head.replace(/\s+/g, ' ')))
    .map(([id]) => id)
    .sort()
}
