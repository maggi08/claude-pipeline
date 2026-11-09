#!/usr/bin/env node
/**
 * Free tests of the tuning tooling (run by scripts/validate.mjs, so by CI and by the `test` command): `eval.mjs --effort` / `--show-plugin`, the model drift check and the
 * models.json seed, `eval.mjs --record-release`, and the release-check eval gate on fixtures (agent changed with no row and no skip → fail; with a row → pass; with a skip
 * line → pass; an agent with no case and no skip line → fail). No model is called.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentModelsOf, withEffort } from './eval-lib.mjs'
import { agentCases, agentTreeAt, buildReleaseRows, gateErrors, mergeReleases, modelDrift, ownModels, releaseWarnings, seedModels } from './release-lib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const check = (ok, message) => {
  if (!ok) problems.push(message)
}
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const put = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
const holders = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tun-'))
  holders.push(dir)
  return dir
}

try {
  // ── effort: the frontmatter of the copy ─────────────────────────────────────────────────────────────────────────────
  const agent = '---\nname: x\nmodel: sonnet\n---\n\nBody with effort: high in text.\n'
  check(withEffort(agent, 'low') === '---\nname: x\nmodel: sonnet\neffort: low\n---\n\nBody with effort: high in text.\n', 'effort: a missing line should be inserted after model:')
  check(withEffort(withEffort(agent, 'low'), 'medium').includes('effort: medium\n') && !withEffort(withEffort(agent, 'low'), 'medium').includes('effort: low'), 'effort: an existing line should be replaced')
  check(withEffort(withEffort(agent, 'low'), 'none') === agent, 'effort: none should remove the line and leave the rest as it was')
  check(withEffort(agent, 'none') === agent, 'effort: none on a file with no line is a no-op')
  check(withEffort('---\nname: x\n---\nB\n', 'max') === '---\nname: x\neffort: max\n---\nB\n', 'effort: with no model line it goes at the end of the frontmatter')
  check(spawnSync(process.execPath, ['-e', `import('${join(ROOT, 'scripts/eval-lib.mjs')}').then((m) => m.withEffort('no frontmatter', 'low'))`]).status !== 0, 'effort: a file with no frontmatter should throw')

  const sourceBefore = readFileSync(join(ROOT, 'plugins/stage-pipeline/agents/pro-review.md'), 'utf8')
  const shown = spawnSync(process.execPath, [join(ROOT, 'scripts/eval.mjs'), '--show-plugin', '--effort', 'pro-review=low', '--effort', 'docs-lookup=none', '--model', 'dead-code=haiku'], { encoding: 'utf8' })
  check(shown.status === 0 && /^label: model:dead-code=haiku\+effort:pro-review=low,docs-lookup=none$/m.test(shown.stdout), `effort: the label of an effort run should tell it apart in the ledger; got ${shown.stdout.split('\n')[0]}`)
  check(/--- pro-review[\s\S]*?model: sonnet\neffort: low\n/.test(shown.stdout) && !/--- docs-lookup[\s\S]*?effort:/.test(shown.stdout), 'effort: the copied plugin should carry effort: low for pro-review and none for docs-lookup')
  check(readFileSync(join(ROOT, 'plugins/stage-pipeline/agents/pro-review.md'), 'utf8') === sourceBefore, 'effort: the source plugin was touched')
  check(spawnSync(process.execPath, [join(ROOT, 'scripts/eval.mjs'), '--effort', 'pro-review=loud'], { encoding: 'utf8' }).status === 2, 'effort: an unknown level should be refused')

  // ── model drift ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const event = (model, parent) => ({ type: 'assistant', parent_tool_use_id: parent, message: { model, content: [] } })
  check(agentModelsOf([event('claude-haiku-5-5', null), event('claude-sonnet-5-5', 'toolu_1'), event('<synthetic>', 'toolu_1')], 'toolu_1').join() === 'claude-sonnet-5-5', "drift: the subagent's own assistant events carry its model, not the haiku parent's")
  check(agentModelsOf([event('claude-sonnet-5-5', null)], null).join() === 'claude-sonnet-5-5', 'drift: a main-thread agent is the session itself')
  check(ownModels('claude-haiku-5-5+claude-sonnet-5-5').join() === 'claude-sonnet-5-5' && ownModels('claude-haiku-5-5').join() === 'claude-haiku-5-5', 'drift: the haiku parent is subtracted unless the agent is haiku')
  const known = { 'pro-review': 'claude-sonnet-5-5' }
  check(modelDrift(known, 'pro-review', ['claude-sonnet-6']) === 'agent pro-review resolved to claude-sonnet-6, evals/models.json has claude-sonnet-5-5', 'drift: the warning names the agent, what it got and what is expected')
  check(modelDrift(known, 'pro-review', ['claude-sonnet-5-5']) === null && modelDrift(known, 'other', ['x']) === null && modelDrift(known, 'pro-review', []) === null, 'drift: the same model, an unknown agent and an empty result do not warn')

  // ── the models.json seed and the release rows ───────────────────────────────────────────────────────────────────────
  const cases = tmp()
  for (const [name, spec] of Object.entries({ a1: { agent: 'pro-review' }, a2: { agent: 'pro-review' }, a3: { agent: 'pro-review' }, d1: { agent: 'deps-audit' }, h1: { agent: 'human-text-check', thread: 'main' }, r1: { kind: 'routing' } })) put(cases, `${name}/case.json`, JSON.stringify(spec))
  check(JSON.stringify(Object.entries(agentCases(cases)).sort()) === JSON.stringify([['deps-audit', ['d1']], ['human-text-check', ['h1']], ['pro-review', ['a1', 'a2', 'a3']]]), 'cases: a case counts for its agent; a routing case counts for none')
  const row = (fields) => ({ ts: '2026-10-27T00:00:00Z', invocation: 'i', attempt: '1', plugin_ref: 'working-tree', plugin_version: '0.22.0', plugin_sha: 'abc', claude_version: '2.1', marks: 'E1+', pass: '1', cost_usd: '0.1', ...fields })
  const ledger = [
    row({ case: 'a1', models: 'claude-haiku-5-5+claude-sonnet-5-5', ts: '2026-10-27T01:00:00Z' }),
    row({ case: 'a2', models: 'claude-haiku-5-5+claude-sonnet-5-5', ts: '2026-10-27T02:00:00Z' }),
    row({ case: 'a3', models: 'claude-haiku-5-5+claude-opus-5-5', ts: '2026-10-27T03:00:00Z' }),
    row({ case: 'a3', models: 'claude-haiku-5-5+claude-opus-5-5', plugin_ref: 'model:pro-review=haiku', ts: '2026-10-27T04:00:00Z' }),
    row({ case: 'd1', models: 'claude-haiku-5-5' }),
    row({ case: 'h1', models: 'claude-haiku-5-5+claude-sonnet-5-5' }),
  ]
  const seeded = seedModels(ledger, cases)
  check(seeded['pro-review'] === 'claude-sonnet-5-5', `seed: two cases on sonnet outvote the one the parent put on opus; got ${seeded['pro-review']}`)
  check(seeded['deps-audit'] === 'claude-haiku-5-5' && seeded['human-text-check'] === 'claude-sonnet-5-5', 'seed: a haiku agent keeps haiku, a main-thread run loses the haiku helper')
  const rows = buildReleaseRows({
    ledger: [
      row({ case: 'a1', invocation: 'old', ts: '2026-10-27T01:00:00Z', models: 'claude-sonnet-5-5' }),
      row({ case: 'a1', invocation: 'new', attempt: '1', ts: '2026-10-28T01:00:00Z', models: 'claude-haiku-5-5+claude-sonnet-5-5' }),
      row({ case: 'a1', invocation: 'new', attempt: '2', ts: '2026-10-28T01:01:00Z', pass: '0', cost_usd: '0.2', models: 'claude-haiku-5-5+claude-sonnet-5-5' }),
      row({ case: 'a1', invocation: 'effort', ts: '2026-10-29T01:00:00Z', plugin_ref: 'effort:pro-review=low' }),
      row({ case: 'a1', invocation: 'older-version', ts: '2026-10-29T02:00:00Z', plugin_version: '0.21.0' }),
    ],
    casesDir: cases, version: '0.22.0', today: '2026-10-30',
  })
  check(rows.length === 1 && rows[0].invocation === 'new' && rows[0].pass === '1/2' && rows[0].cost_usd === '0.3000' && rows[0].models === 'claude-sonnet-5-5', `release rows: the latest working-tree invocation at the version, passes over runs, summed cost; got ${JSON.stringify(rows)}`)
  const merged = mergeReleases([{ version: '0.21.0', case: 'a1' }, { version: '0.22.0', case: 'a1', invocation: 'stale' }, { version: '0.22.0', case: 'a2' }], rows)
  check(merged.length === 3 && merged.some((entry) => entry.invocation === 'new') && !merged.some((entry) => entry.invocation === 'stale') && merged.some((entry) => entry.case === 'a2'), 'release rows: a rerun replaces the rows of the same version and case and keeps the others')

  // ── a copy of the tooling in a temp git repo: --record-release, and the release-check gate ─────────────────────────────
  const repoWith = (agents, caseSpecs) => {
    const repo = tmp()
    git(repo, 'init', '-q', '-b', 'main')
    cpSync(join(ROOT, 'scripts'), join(repo, 'scripts'), { recursive: true })
    cpSync(join(ROOT, 'plugins/stage-pipeline'), join(repo, 'plugins/stage-pipeline'), { recursive: true })
    for (const [name, spec] of Object.entries(caseSpecs)) put(repo, `evals/cases/${name}/case.json`, JSON.stringify(spec))
    for (const name of agents) if (!existsSync(join(repo, 'plugins/stage-pipeline/agents', `${name}.md`))) put(repo, `plugins/stage-pipeline/agents/${name}.md`, `---\nname: ${name}\nmodel: sonnet\n---\n\nbody\n`)
    put(repo, 'plugins/stage-pipeline/.claude-plugin/plugin.json', JSON.stringify({ name: 'stage-pipeline', version: '1.0.0' }))
    put(repo, 'CHANGELOG.md', '# Changelog\n\n## 1.0.0 — 2026-10-01\n\nfirst\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'base')
    return repo
  }
  const evalRun = (repo, ...args) => spawnSync(process.execPath, [join(repo, 'scripts/eval.mjs'), ...args], { cwd: repo, encoding: 'utf8' })

  {
    const repo = repoWith(['pro-review', 'docs-lookup'], { 'pr-1': { agent: 'pro-review' }, 'dl-1': { agent: 'docs-lookup' }, 'route-1': { kind: 'routing' } })
    const base = git(repo, 'rev-parse', 'HEAD').trim()
    const ledgerRow = (fields) => ['2026-10-30T10:00:00Z', 'inv', 'pr-1', '1', 'working-tree', '1.0.0', base, '2.1.314 (Claude Code)', 'claude-haiku-5-5+claude-sonnet-5-5', 'E1+', '1', '0.1000', '10'].map((value, i) => fields[i] ?? value).join('\t')
    const header = ['ts', 'invocation', 'case', 'attempt', 'plugin_ref', 'plugin_version', 'plugin_sha', 'claude_version', 'models', 'marks', 'pass', 'cost_usd', 'seconds'].join('\t')
    put(repo, 'evals/ledger.tsv', `${header}\n${[1, 2, 3].map((n) => ledgerRow({ 3: String(n), 10: n === 3 ? '0' : '1' })).join('\n')}\n${ledgerRow({ 1: 'inv-dl', 2: 'dl-1', 6: `${base}+dirty` })}\n`)
    const first = evalRun(repo, '--record-release')
    const tsv = existsSync(join(repo, 'evals/releases.tsv')) ? readFileSync(join(repo, 'evals/releases.tsv'), 'utf8') : ''
    check(first.status === 0 && /pr-1\tpro-review\t2\/3\t0\.3000\tinv\t/.test(tsv), `record-release: one row per agent case with pass N/runs and cost; got ${first.stderr}${tsv}`)
    const headTree = agentTreeAt((...args) => git(repo, ...args), 'HEAD', 'pro-review')
    check(tsv.includes(`\tinv\t${base}\t${headTree}\t`) && /^[0-9a-f]{40}\+(-|[0-9a-f]{40})$/.test(headTree), `record-release: the row carries agent_tree, the agent's content identity at the measured sha; got ${tsv}`)
    check(!/route-1/.test(tsv), 'record-release: a routing case names no agent and gets no row')
    check(/dl-1: run inv-dl not recorded: the run measured a dirty tree/.test(first.stdout) && !/dl-1/.test(tsv), `record-release: a run on a dirty tree is skipped, with a line saying so; got ${first.stdout}`)
    put(repo, 'plugins/stage-pipeline/agents/pro-review.md', '---\nname: pro-review\nmodel: sonnet\n---\n\nchanged body\n')
    const second = evalRun(repo, '--record-release', 'pr-1')
    check(/pr-1: pro-review changed since the run/.test(second.stdout), 'record-release: an agent file changed since the row\'s sha should warn')
    // a rerun at the same version replaces; another version's rows stay
    writeFileSync(join(repo, 'evals/releases.tsv'), `${readFileSync(join(repo, 'evals/releases.tsv'), 'utf8')}0.9.0\tpr-1\tpro-review\t3/3\t0.5\told\tsha\ttree\tv\tm\t2026-01-01\n`)
    put(repo, 'evals/ledger.tsv', `${readFileSync(join(repo, 'evals/ledger.tsv'), 'utf8')}${ledgerRow({ 0: '2026-10-31T10:00:00Z', 1: 'inv2', 3: '1' })}\n`)
    evalRun(repo, '--record-release', 'pr-1')
    const after = readFileSync(join(repo, 'evals/releases.tsv'), 'utf8')
    check(after.split('\n').filter((line) => line.includes('\tpr-1\t')).length === 2 && /1\.0\.0\tpr-1\tpro-review\t1\/1\t[\d.]+\tinv2\t/.test(after) && /^0\.9\.0\tpr-1/m.test(after), `record-release: a rerun replaces the rows of the same version and case, keeps other versions and cases; got\n${after}`)
    // a hill-climb candidate (labelled plugin_ref), a run at a sha that is not an ancestor of HEAD, and a harness failure never make a row; an older clean run does
    git(repo, 'checkout', '-q', '-b', 'side')
    put(repo, 'side.txt', 'x')
    git(repo, 'add', 'side.txt')
    git(repo, 'commit', '-q', '-m', 'side')
    const sideSha = git(repo, 'rev-parse', 'HEAD').trim()
    git(repo, 'checkout', '-q', 'main')
    put(repo, 'evals/ledger.tsv', `${readFileSync(join(repo, 'evals/ledger.tsv'), 'utf8')}${ledgerRow({ 0: '2026-11-01T10:00:00Z', 1: 'inv-climb', 2: 'dl-1', 4: 'working-tree+hillclimb:hc-1' })}\n${ledgerRow({ 0: '2026-11-02T10:00:00Z', 1: 'inv-side', 2: 'dl-1', 6: sideSha })}\n${ledgerRow({ 0: '2026-11-03T10:00:00Z', 1: 'inv-w', 2: 'dl-1', 9: 'W-', 10: '0' })}\n${ledgerRow({ 0: '2026-10-31T10:00:00Z', 1: 'inv-ok', 2: 'dl-1' })}\n`)
    const third = evalRun(repo, '--record-release', 'dl-1')
    const tsv3 = readFileSync(join(repo, 'evals/releases.tsv'), 'utf8')
    check(/dl-1\tdocs-lookup\t1\/1\t[\d.]+\tinv-ok\t/.test(tsv3) && !/inv-climb|inv-side|inv-w/.test(tsv3), `record-release: a labelled hill-climb run, a non-ancestor sha and a W- run never make a row, the older clean run does; got\n${tsv3}`)
    check(/dl-1: run inv-side not recorded: sha [0-9a-f]{9} is not an ancestor of HEAD/.test(third.stdout), `record-release: the skipped non-ancestor run is named; got ${third.stdout}`)
    // --seed-models and models.json
    check(evalRun(repo, '--seed-models').status === 0 && JSON.parse(readFileSync(join(repo, 'evals/models.json'), 'utf8'))['pro-review'] === 'claude-sonnet-5-5', 'seed: eval.mjs --seed-models writes evals/models.json from the ledger')
  }

  // evals/pending/: never selected by default, --list, --lint or --record-release; a run names a pending case with --pending (a name that is also under evals/cases/ stays the real case)
  {
    const repo = repoWith(['pro-review'], { 'pr-1': { agent: 'pro-review', why: 'real' } })
    put(repo, 'evals/pending/pn-1/case.json', JSON.stringify({ agent: 'pro-review', why: 'pending one' }))
    put(repo, 'evals/pending/pr-1/case.json', JSON.stringify({ agent: 'pro-review', why: 'pending twin' }))
    const listed = evalRun(repo, '--list')
    check(listed.status === 0 && /pr-1/.test(listed.stdout) && !/pn-1/.test(listed.stdout), `pending: --list must not show a pending case; got ${listed.stdout}`)
    check(evalRun(repo, 'pn-1').status === 2 && /No such cases: pn-1/.test(evalRun(repo, 'pn-1').stderr), 'pending: a run that names a pending case without --pending must fail')
    const shown = evalRun(repo, '--pending', 'pn-1', '--show-plugin')
    check(shown.status === 0, `pending: --pending lets a run name the case; got ${shown.status} ${shown.stderr}`)
    check(evalRun(repo, '--pending').status === 2 && evalRun(repo, '--pending', '--runs', '1').status === 2, 'pending: --pending with no case name fails (exit 2) instead of running every regular case')
    check(evalRun(repo, '--pending', 'nope', '--show-plugin').status === 2, 'pending: --pending does not invent cases')
    for (const flag of ['--list', '--lint', '--record-release']) check(evalRun(repo, '--pending', flag).status === 2, `pending: ${flag} refuses --pending, it ignores evals/pending/`)
    check(!/pn-1/.test(evalRun(repo, '--lint').stdout) && !/pn-1/.test(evalRun(repo, '--record-release').stdout), 'pending: --lint and --record-release ignore pending cases')
    check(!existsSync(join(repo, 'evals/hillclimb')) && evalRun(repo, '--label', 'hillclimb:x', '--show-plugin').stdout.startsWith('label: working-tree+hillclimb:x'), 'label: --label joins the plugin_ref label of the run')
  }

  // The gate. A release branch from `base`: bump the version, add a CHANGELOG section, change what the case sets.
  const gate = ({ caseSpecs, changed, releases = '', changelog = '', agents = ['pro-review', 'dead-code'] }) => {
    const repo = repoWith(agents, caseSpecs)
    const base = git(repo, 'rev-parse', 'HEAD').trim()
    git(repo, 'checkout', '-q', '-b', 'release')
    put(repo, 'plugins/stage-pipeline/.claude-plugin/plugin.json', JSON.stringify({ name: 'stage-pipeline', version: '1.1.0' }))
    put(repo, 'CHANGELOG.md', `# Changelog\n\n## 1.1.0 — 2026-10-30\n\nwhat changed\n${changelog}\n\n## 1.0.0 — 2026-10-01\n\nfirst\n`)
    for (const path of changed) put(repo, path, `---\nname: x\nmodel: sonnet\n---\n\nchanged ${path}\n`)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'release')
    if (releases) {
      // The row's agent_tree is the agent's content identity: `<tree>` is HEAD's (the release commit above), `<basetree>` the one at the base.
      const tree = agentTreeAt((...args) => git(repo, ...args), 'HEAD', 'pro-review')
      const baseTree = agentTreeAt((...args) => git(repo, ...args), base, 'pro-review')
      put(repo, 'evals/releases.tsv', `version\tcase\tagent\tpass\tcost_usd\tinvocation\tplugin_sha\tagent_tree\tclaude_version\tmodels\trecorded\n${releases.replaceAll('<base>', base).replaceAll('<basetree>', baseTree).replaceAll('<tree>', tree)}`)
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'releases')
    }
    const result = spawnSync(process.execPath, [join(repo, 'scripts/release-check.mjs'), base], { cwd: repo, encoding: 'utf8' })
    return { status: result.status, out: result.stdout + result.stderr }
  }
  const proCases = { 'pr-1': { agent: 'pro-review' }, 'pr-2': { agent: 'pro-review' }, 'route-1': { kind: 'routing', expectSkill: 'pro-review' } }
  const agentPath = (name) => `plugins/stage-pipeline/agents/${name}.md`
  const row11 = (name, pass = '3/3', sha = '<base>', tree = '<tree>') => `1.1.0\t${name}\tpro-review\t${pass}\t0.3\tinv\t${sha}\t${tree}\tv\tm\t2026-10-30\n`

  let result = gate({ caseSpecs: proCases, changed: [agentPath('pro-review')] })
  check(result.status === 1 && /agent pro-review changed/.test(result.out) && /pr-1, pr-2/.test(result.out) && !/route-1/.test(result.out), `gate: an agent changed with no row and no skip must fail and name the agent and its cases (not the routing case); got ${result.status} ${result.out}`)
  result = gate({ caseSpecs: proCases, changed: [agentPath('pro-review')], releases: row11('pr-1') + row11('pr-2') })
  check(result.status === 0 && /eval gate passed for pro-review/.test(result.out), `gate: rows at the current version for every case must pass; got ${result.status} ${result.out}`)
  result = gate({ caseSpecs: proCases, changed: [agentPath('pro-review')], releases: row11('pr-1', '0/3') + row11('pr-2') })
  check(result.status === 1 && /case pr-1 passed 0\/3 at 1\.1\.0 — fix it or name the agent in a skip line/.test(result.out) && !/pr-2/.test(result.out), `gate: a row with 0 passing runs must fail, naming the case and the pass count; got ${result.out}`)
  result = gate({ caseSpecs: proCases, changed: [agentPath('pro-review')], releases: row11('pr-1', '1/3') + row11('pr-2', '3/3') })
  check(result.status === 0, `gate: a row with at least one pass stays accepted; got ${result.out}`)
  // rebase-like: the recorded sha is no ancestor of HEAD (and not even in this clone), the agent's bytes are the same
  result = gate({ caseSpecs: proCases, changed: [agentPath('pro-review')], releases: row11('pr-1', '3/3', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef') + row11('pr-2', '3/3', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef') })
  check(result.status === 0, `gate: a row whose sha was orphaned by a rebase passes when the agent tree is the same as HEAD's; got ${result.out}`)
  // same version, the agent changed after the measured sha (an ancestor)
  result = gate({ caseSpecs: proCases, changed: [agentPath('pro-review')], releases: row11('pr-1', '3/3', '<base>', '<basetree>') + row11('pr-2') })
  check(result.status === 1 && /case pr-1: the row at 1\.1\.0 measured a different pro-review than HEAD — record it again/.test(result.out) && !/case pr-2/.test(result.out), `gate: a row measured before a later agent change must fail; got ${result.out}`)
  result = gate({ caseSpecs: proCases, changed: ['plugins/stage-pipeline/skills/pro-review/references/lenses.md'], releases: row11('pr-1', '3/3', '<base>', '<basetree>') + row11('pr-2', '3/3', '<base>', '<basetree>') })
  check(result.status === 1 && /measured a different pro-review than HEAD/.test(result.out), `gate: a change in the agent's skill is part of its identity; got ${result.out}`)
  result = gate({ caseSpecs: proCases, changed: [agentPath('pro-review')], releases: row11('pr-1', '3/3', '<base>', '') + row11('pr-2') })
  check(result.status === 1 && /case pr-1: .*no agent_tree in the row/.test(result.out), `gate: a row without the agent_tree column value is a mismatch; got ${result.out}`)
  result = gate({ caseSpecs: proCases, changed: [agentPath('pro-review')], releases: row11('pr-1', '3/3', '<base>+dirty') + row11('pr-2') })
  check(result.status === 1 && /case pr-1: .*dirty tree/.test(result.out), `gate: a row measured on a dirty tree must fail; got ${result.out}`)
  result = gate({ caseSpecs: proCases, changed: [agentPath('pro-review')], changelog: '\neval: skipped — <reason>\n' })
  check(result.status === 1, `gate: a skip line with the literal «<reason>» placeholder is no skip; got ${result.out}`)
  result = gate({ caseSpecs: proCases, changed: [agentPath('pro-review')], changelog: '\n- eval: skipped pro-review — <reason>   \n' })
  check(result.status === 1, 'gate: the placeholder behind an agent list is no skip either')
  result = gate({ caseSpecs: proCases, changed: [agentPath('pro-review')], releases: row11('pr-1') })
  check(result.status === 1 && /for pr-2/.test(result.out) && !/pr-1,/.test(result.out), `gate: a missing case must fail naming only the missing one; got ${result.out}`)
  result = gate({ caseSpecs: proCases, changed: [agentPath('pro-review')], releases: row11('pr-1').replace('1.1.0', '1.0.0') + row11('pr-2').replace('1.1.0', '1.0.0') })
  check(result.status === 1, 'gate: rows of an older version do not count')
  result = gate({ caseSpecs: proCases, changed: [agentPath('pro-review')], changelog: '\neval: skipped — only a typo in the body\n' })
  check(result.status === 0, `gate: «eval: skipped — <reason>» in the section of this version must pass; got ${result.out}`)
  result = gate({ caseSpecs: proCases, changed: [agentPath('pro-review')], changelog: '\n- eval: skipped pro-review, dead-code — wording only\n' })
  check(result.status === 0, `gate: a skip line naming the agent (with a list dash) must pass; got ${result.out}`)
  result = gate({ caseSpecs: proCases, changed: [agentPath('pro-review')], changelog: '\neval: skipped dead-code — wording only\n' })
  check(result.status === 1, 'gate: a skip line naming another agent does not cover this one')
  result = gate({ caseSpecs: proCases, changed: [agentPath('pro-review')], changelog: '\neval: skipped —\n' })
  check(result.status === 1, 'gate: a skip line with no reason does not count')
  const older = (() => {
    const repo = repoWith(['pro-review'], proCases)
    const base = git(repo, 'rev-parse', 'HEAD').trim()
    put(repo, 'plugins/stage-pipeline/.claude-plugin/plugin.json', JSON.stringify({ name: 'stage-pipeline', version: '1.1.0' }))
    put(repo, 'CHANGELOG.md', '# Changelog\n\n## 1.1.0 — 2026-10-30\n\nchanged\n\n## 1.0.0 — 2026-10-01\n\neval: skipped — belongs to 1.0.0\n')
    put(repo, agentPath('pro-review'), 'changed\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'r')
    return spawnSync(process.execPath, [join(repo, 'scripts/release-check.mjs'), base], { cwd: repo, encoding: 'utf8' }).status
  })()
  check(older === 1, 'gate: a skip line in an older CHANGELOG section does not cover this version')
  result = gate({ caseSpecs: proCases, changed: ['plugins/stage-pipeline/skills/pro-review/references/lenses.md'] })
  check(result.status === 1 && /agent pro-review changed/.test(result.out), `gate: a change in the checker skill of an agent gates that agent; got ${result.out}`)
  result = gate({ caseSpecs: proCases, changed: ['plugins/stage-pipeline/skills/stage-check/SKILL.md'] })
  check(result.status === 0, `gate: a skill with no agent of its name does not gate; got ${result.out}`)
  result = gate({ caseSpecs: proCases, changed: [agentPath('dead-code')] })
  check(result.status === 1 && /agent dead-code changed and has no eval case/.test(result.out), `gate: an agent with no case and no skip must fail; got ${result.out}`)
  result = gate({ caseSpecs: proCases, changed: [agentPath('dead-code')], changelog: '\neval: skipped — no case yet\n' })
  check(result.status === 0, 'gate: an agent with no case passes with a skip line')
  result = gate({ caseSpecs: { 'route-1': { kind: 'routing' } }, changed: [agentPath('pro-review')] })
  check(result.status === 1, 'gate: a routing case does not stand for an agent')

  // gate pure function
  check(gateErrors({ changedAgents: ['x'], cases: { x: ['c'] }, releases: [{ version: '2.0.0', case: 'c', pass: '1/3' }], version: '2.0.0', changelogSection: '' }).length === 0, 'gate: a row at the version passes')
  check(releaseWarnings({ case: 'c', agent: 'x', plugin_sha: 'deadbeef+dirty' }, () => { throw new Error('unknown') }).length === 2, 'release warnings: dirty and an unknown sha both warn')
} finally {
  for (const dir of holders) rmSync(dir, { recursive: true, force: true })
}

if (problems.length) {
  console.error(`✘ tuning tooling tests: ${problems.length} problem(s)\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
  process.exit(1)
}
console.log('✔ tuning tooling: effort rewrite, model drift, models.json seed, --record-release, release-check eval gate')
