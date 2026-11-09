/**
 * The free half of the eval gate: which cases belong to an agent, the last resolved model per agent (evals/models.json), and the committed per-release summary
 * (evals/releases.tsv). Shared by scripts/eval.mjs (--record-release, --seed-models), scripts/release-check.mjs (the gate) and their tests. Nothing here calls a model.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const RELEASES_COLUMNS = ['version', 'case', 'agent', 'pass', 'cost_usd', 'invocation', 'plugin_sha', 'agent_tree', 'claude_version', 'models', 'recorded']

/**
 * The agent's own model out of an aggregate `models` list (a ledger cell `a+b`, or `modelUsage` keys). A subagent case mixes the haiku parent in, and a `thread: "main"`
 * run still shows haiku next to its own model (measured in the ledger: human-text-check), so haiku is subtracted; when nothing else is left the agent is haiku itself
 * (deps-audit) and the list stays.
 */
export function ownModels(models) {
  const list = Array.isArray(models) ? models : String(models ?? '').split('+').filter(Boolean)
  const rest = list.filter((model) => !/haiku/i.test(model))
  return rest.length ? rest : list
}

/**
 * The content identity of an agent at `rev`: the blob of `agents/<a>.md` and the tree of `skills/<a>/` (`-` when that skill does not exist), joined by `+`. Unlike a commit sha
 * it survives a rebase: the same agent bytes give the same string whatever commit carries them. `run(...args)` is git in the repo; null when the agent file is not at `rev`.
 */
export function agentTreeAt(run, rev, agent) {
  const at = (path) => {
    try {
      return run('rev-parse', '--verify', '-q', `${rev}:${path}`).trim() || null
    } catch {
      return null
    }
  }
  const file = at(`plugins/stage-pipeline/agents/${agent}.md`)
  return file ? `${file}+${at(`plugins/stage-pipeline/skills/${agent}`) ?? '-'}` : null
}

const cell = (value) => String(value ?? '').replace(/[\t\r\n]+/g, ' ')
const semver = (version) => String(version).split('.').map((part) => Number(part) || 0)
export function compareVersions(a, b) {
  const [x, y] = [semver(a), semver(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/** `{ agent: [case names] }` from the case.json files of `casesDir`: a case counts for its `agent` (routing and decision cases name none). */
export function agentCases(casesDir) {
  const result = {}
  if (!existsSync(casesDir)) return result
  for (const name of readdirSync(casesDir).sort()) {
    const path = join(casesDir, name, 'case.json')
    if (!existsSync(path)) continue
    const spec = JSON.parse(readFileSync(path, 'utf8'))
    if (spec.agent) (result[spec.agent] ??= []).push(name)
  }
  return result
}

// ── evals/models.json ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The last resolved model per agent from the ledger rows: per case the latest working-tree row that is not a harness failure, the agent's own model out of its
 * `models` cell (haiku is subtracted: the thin parent of a subagent case, and the helper calls of a main-thread run; an agent that is itself haiku keeps it), then per agent the
 * model most cases agree on (a tie goes to the most recent row). A case that ran its agent on a model the parent chose (a whole-branch review on opus) is the minority.
 */
export function seedModels(ledger, casesDir) {
  const byAgent = {}
  for (const [agent, names] of Object.entries(agentCases(casesDir))) {
    for (const name of names) {
      const rows = ledger.filter((row) => row.case === name && row.plugin_ref === 'working-tree' && row.models && !/(^|\s)W-/.test(row.marks ?? '')).sort((a, b) => a.ts.localeCompare(b.ts))
      const last = rows.at(-1)
      if (!last) continue
      const [model] = ownModels(last.models)
      if (model) (byAgent[agent] ??= []).push({ model, ts: last.ts })
    }
  }
  const result = {}
  for (const [agent, picks] of Object.entries(byAgent).sort(([a], [b]) => a.localeCompare(b))) {
    const counts = new Map()
    for (const { model, ts } of picks) counts.set(model, { n: (counts.get(model)?.n ?? 0) + 1, ts: ts > (counts.get(model)?.ts ?? '') ? ts : counts.get(model).ts })
    result[agent] = [...counts.entries()].sort(([, a], [, b]) => b.n - a.n || b.ts.localeCompare(a.ts))[0][0]
  }
  return result
}

/** The drift message when the agent's resolved models do not include the one in evals/models.json (an agent with no entry cannot drift), else null. */
export function modelDrift(known, agent, resolved) {
  const expected = known[agent]
  if (!expected || !resolved.length || resolved.includes(expected)) return null
  return `agent ${agent} resolved to ${resolved.join('+')}, evals/models.json has ${expected}`
}

export function readModels(path) {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

export function writeModels(path, models) {
  mkdirSync(dirname(path), { recursive: true })
  const sorted = Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`)
}

// ── evals/releases.tsv ──────────────────────────────────────────────────────────────────────────────────────────────

export function readReleases(path) {
  if (!existsSync(path)) return []
  const [header, ...lines] = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  const columns = header.split('\t')
  return lines.map((line) => Object.fromEntries(line.split('\t').map((value, i) => [columns[i], value])))
}

export function writeReleases(path, rows) {
  mkdirSync(dirname(path), { recursive: true })
  const sorted = [...rows].sort((a, b) => compareVersions(a.version, b.version) || a.case.localeCompare(b.case))
  writeFileSync(path, `${[RELEASES_COLUMNS.join('\t'), ...sorted.map((row) => RELEASES_COLUMNS.map((column) => cell(row[column])).join('\t'))].join('\n')}\n`)
}

/**
 * One row per agent case at `version`: the latest invocation of a working-tree run at that plugin version (a `--ref`, `--model`, `--effort`, ablation or variant run is a
 * different plugin and never stands for this one), its passes over its runs, summed cost, sha, claude version, the agent's own models. Harness failures (`W-`) are runs
 * that said nothing: they are not counted. `only`: restrict to these case names.
 */
export function buildReleaseRows({ ledger, casesDir, version, only = null, today, rowProblem = null, skipped = [], treeOf = null }) {
  const rows = []
  for (const [agent, names] of Object.entries(agentCases(casesDir))) {
    for (const name of names) {
      if (only && !only.includes(name)) continue
      // plugin_ref is exactly `working-tree`: a hill-climb candidate (`working-tree+hillclimb:<run>`), a `--ref`, `--model`, `--effort`, ablation or variant run never stands for the release.
      const atVersion = ledger
        .filter((row) => row.case === name && row.plugin_version === version && row.plugin_ref === 'working-tree' && !/(^|\s)W-/.test(row.marks ?? ''))
        .filter((row) => {
          const problem = rowProblem?.(row)
          if (problem) skipped.push(`${name}: run ${row.invocation} not recorded: ${problem}`)
          return !problem
        })
      const invocation = atVersion.sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)?.invocation
      if (!invocation) continue
      const runs = atVersion.filter((row) => row.invocation === invocation)
      const models = [...new Set(runs.flatMap((row) => ownModels(row.models)))]
      rows.push({
        version, case: name, agent, pass: `${runs.filter((row) => row.pass === '1').length}/${runs.length}`,
        cost_usd: runs.reduce((sum, row) => sum + Number(row.cost_usd || 0), 0).toFixed(4), invocation, plugin_sha: runs[0].plugin_sha, agent_tree: treeOf?.(runs[0].plugin_sha, agent) ?? '',
        claude_version: runs[0].claude_version, models: models.join('+'), recorded: today,
      })
    }
  }
  return rows
}

/** The existing rows with those of `fresh` replacing the rows of the same version and case; other versions and cases stay. */
export function mergeReleases(existing, fresh) {
  const replaced = new Set(fresh.map((row) => `${row.version}\t${row.case}`))
  return [...existing.filter((row) => !replaced.has(`${row.version}\t${row.case}`)), ...fresh]
}

/**
 * Warnings about a release row: its sha is dirty (the run measured uncommitted files), or the agent's own files changed between that sha and the working tree
 * (`agents/<a>.md`, `skills/<a>/`), so the row no longer stands for what is committed. `run(...args)` is git in the repo; returns the list of warning strings.
 */
export function releaseWarnings(row, run) {
  const warnings = []
  const sha = String(row.plugin_sha ?? '')
  if (/\+dirty$/.test(sha)) warnings.push(`${row.case}: the run measured a dirty tree (${sha.slice(0, 9)}+dirty): uncommitted plugin files were part of it`)
  const clean = sha.replace(/\+dirty$/, '')
  try {
    run('rev-parse', '--verify', `${clean}^{commit}`)
  } catch {
    warnings.push(`${row.case}: sha ${clean.slice(0, 9)} is not in this repository: cannot tell whether ${row.agent} changed since the run`)
    return warnings
  }
  const changed = run('diff', '--name-only', clean, '--', `plugins/stage-pipeline/agents/${row.agent}.md`, `plugins/stage-pipeline/skills/${row.agent}/`).split('\n').filter(Boolean)
  if (changed.length) warnings.push(`${row.case}: ${row.agent} changed since the run at ${clean.slice(0, 9)} (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', …' : ''}): run it again before recording`)
  return warnings
}

/** Why a sha cannot stand for a release row, or null: the run measured a dirty tree, or the commit is not an ancestor of HEAD (a hill-climb branch, another repository). `run(...args)` is git in the repo. */
export function shaProblem(sha, run) {
  const text = String(sha ?? '')
  if (/\+dirty$/.test(text)) return `the run measured a dirty tree (${text.slice(0, 9)}+dirty)`
  try {
    run('merge-base', '--is-ancestor', text, 'HEAD')
  } catch {
    return `sha ${text.slice(0, 9) || '(none)'} is not an ancestor of HEAD`
  }
  return null
}

/**
 * The gate. `changedAgents`: agents whose file or checker skill the diff touched. `cases`: from agentCases(). `releases`: rows of evals/releases.tsv. `changelogSection`:
 * the text of this version's CHANGELOG section. A skip line is
 *     eval: skipped — <reason>                       covers every changed agent
 *     eval: skipped <agent>, <agent> — <reason>      covers only the named ones
 * (a leading list dash is allowed; the dash before the reason is «—», «–» or «--»). `treeOf(agent)`: the agent's content identity at HEAD (agentTreeAt); a row's `agent_tree` must equal it
 * (a row without the column is a mismatch). Returns the error lines.
 */
export function gateErrors({ changedAgents, cases, releases, version, changelogSection, treeOf = null }) {
  const skips = [...changelogSection.matchAll(/^[ \t]*(?:[-*][ \t]+)?eval: skipped(?:[ \t]+([^—–\n]*?))?[ \t]*(?:—|–|--)[ \t]*(\S.*)$/gm)].map((match) => ({
    agents: match[1] ? match[1].split(/[,\s]+/).filter(Boolean) : null,
    reason: match[2].trim(),
  })).filter((skip) => !/^<[^>]*>$/.test(skip.reason)) // the template's own «<reason>» is no reason
  const errors = []
  for (const agent of changedAgents) {
    if (skips.some((skip) => !skip.agents || skip.agents.includes(agent))) continue
    const names = cases[agent] ?? []
    if (!names.length) {
      errors.push(`agent ${agent} changed and has no eval case: add one under evals/cases/, or write «eval: skipped — <reason>» in the CHANGELOG section of ${version}`)
      continue
    }
    const hint = `fix it or name the agent in a skip line: «eval: skipped ${agent} — <reason>» in the CHANGELOG section of ${version}`
    const missing = []
    for (const name of names) {
      const row = releases.find((entry) => entry.version === version && entry.case === name)
      if (!row) {
        missing.push(name)
        continue
      }
      const passed = Number(String(row.pass).split('/')[0])
      if (!(passed > 0)) errors.push(`case ${name} passed ${row.pass} at ${version} — ${hint}`)
      else if (/\+dirty$/.test(String(row.plugin_sha ?? ''))) errors.push(`case ${name}: the row at ${version} measured a dirty tree (${String(row.plugin_sha).slice(0, 9)}+dirty) — record it again from a clean checkout, or ${hint}`)
      // The row stands for the agent's bytes, not for a commit: a rebase orphans every sha and leaves the agent identical; a later change to the agent leaves the sha an ancestor and the row stale.
      else if (treeOf && (!row.agent_tree || row.agent_tree !== treeOf(agent))) errors.push(`case ${name}: the row at ${version} measured a different ${agent} than HEAD${row.agent_tree ? '' : ' (no agent_tree in the row)'} — record it again, or ${hint}`)
    }
    if (missing.length) {
      errors.push(`agent ${agent} changed and evals/releases.tsv has no row at ${version} for ${missing.join(', ')}: run the case(s), then \`node scripts/eval.mjs --record-release\`; or write «eval: skipped — <reason>» in the CHANGELOG section of ${version}`)
    }
  }
  return errors
}
