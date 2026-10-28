#!/usr/bin/env node
/**
 * The proof runner of `/promote` (stage 13 of VT-6, AC-13.2). A candidate rule is proven when it fires on at least two real pre-fix versions of files
 * and stays quiet on HEAD, swept over every tracked file it covers (or fires there only on lines added after the fix). The output carries the revs and the counts; /promote shows it as is.
 *
 *   node promote-proof.mjs --root <repo> --candidate <file.json | '{"json"}'> [--json]
 *   node promote-proof.mjs --root <repo> --check-eslint          # which ESLint the project has (its own node_modules, never npx)
 *
 * A candidate (JSON):
 *   { "id": "no-resolve-component",
 *     "kind": "eslint",                         // or "repo-rule" (a `## Repo rules` row proven by `git show <rev>:<file>` and its regex)
 *     "eslint": { "no-restricted-syntax": ["error", { "selector": "CallExpression[callee.name='resolveComponent']", "message": "…" }] },   // kind eslint
 *     "pattern": "resolveComponent\\(", "files": "**\/*.vue", "message": "…",                                                              // kind repo-rule
 *     "fixes": ["cb488346"],                    // each fix commit: its parent's version of the files it changed is a pre-fix probe
 *     "probes": [{ "rev": "e1afd7c6^", "file": "pages/a.vue" }],      // or explicit pre-fix versions
 *     "headFiles": ["pages/a.vue"],             // narrows the HEAD probe to these files (default: every tracked file the candidate covers; narrowed is not a HEAD proof)
 *     "since": ["cb488346"] }                   // a HEAD hit on a line added after these commits is "added later", not a failure (default: fixes)
 *
 * ESLint is the project's own, loaded from `<root>/package.json`'s resolution (`createRequire`), with `cache:false, fix:false` and the candidate as an
 * override; messages are filtered by the candidate's `ruleId`. A file counts only when `git show` worked and ESLint returned a result with no fatal,
 * parse, ignored or no-config message; otherwise it is inconclusive, which is never "quiet". `--rule` of the CLI replaces the project's entry of the
 * same rule id, and so does the override here: the result says what the project already has, so that the proposal is merged and not substituted.
 * The CLI form for the user to see (the same semantics, one file): git show <rev>:<file> | node_modules/.bin/eslint --stdin --stdin-filename <file> --rule '<json>' --format json
 *
 * Exit: 0 proven, 1 not proven, 2 bad input, 3 no ESLint for a candidate that needs it (go one level down: a repo rule or an unproven CLAUDE.md line).
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { parseRepoRules, repoRuleApplies } from './markers.mjs'

const MAX_PER_FIX = 12
const SOURCE_FILE = /\.(?:vue|[cm]?[jt]sx?|svelte|css|scss|html)$/

const git = (root, ...args) => {
  try {
    return { ok: true, out: execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }) }
  } catch (error) {
    return { ok: false, out: '', status: error.status ?? null }
  }
}

/** The project's own ESLint: `{ ESLint, version, major, path }`, or `{ error }`. Never npx: no node_modules, no proof by ESLint. */
export async function loadProjectEslint(root) {
  let path
  try {
    path = realpathSync(createRequire(join(root, 'package.json')).resolve('eslint'))
  } catch {
    return { error: `no eslint in ${root}/node_modules` }
  }
  // Node resolution walks up to an ancestor's node_modules: code outside the project is not the project's ESLint. The repo's own root (a hoisting monorepo) counts.
  const toplevel = git(root, 'rev-parse', '--show-toplevel').out.trim()
  const homes = [root, toplevel].filter(Boolean).map((dir) => {
    try {
      return `${realpathSync(dir)}${sep}node_modules${sep}`
    } catch {
      return null
    }
  })
  if (!homes.some((home) => home && path.startsWith(home))) return { error: `eslint resolves to ${path}, outside ${root}/node_modules and the repo's own node_modules: not the project's ESLint` }
  try {
    const module = await import(pathToFileURL(path).href)
    const ESLint = module.ESLint ?? module.default?.ESLint
    if (!ESLint) return { error: `${path} exports no ESLint class` }
    const version = String(ESLint.version ?? '0.0.0')
    return { ESLint, version, major: Number(version.split('.')[0]), path }
  } catch (error) {
    return { error: `eslint did not load: ${error.message}` }
  }
}

/** An ESLint message that says the file was not linted at all: fatal, parse, ignored, no config. */
const INCONCLUSIVE = /file ignored|no matching configuration|parsing error|couldn'?t find a configuration|eslint-?(?:\w+)? configuration is invalid/i
export function judgeResult(results, ruleIds) {
  const result = results?.[0]
  if (!result) return { status: 'inconclusive', why: 'ESLint returned no result (the file is ignored)' }
  const broken = result.messages.find((message) => message.fatal || INCONCLUSIVE.test(message.message ?? ''))
  if (broken) return { status: 'inconclusive', why: String(broken.message).slice(0, 100) }
  const hits = result.messages.filter((message) => ruleIds.includes(message.ruleId))
  return hits.length ? { status: 'fired', count: hits.length, lines: hits.map((hit) => hit.line), message: hits[0].message } : { status: 'quiet', count: 0, lines: [] }
}

/** The line numbers of a file at a rev that were added after every one of `since` (a strict descendant of each), by `git blame`. */
function laterLines(root, rev, file, lines, since) {
  if (!since.length) return new Set()
  const blame = git(root, 'blame', '--porcelain', rev, '--', file)
  if (!blame.ok) return new Set()
  const owner = new Map()
  for (const line of blame.out.split('\n')) {
    const found = line.match(/^([0-9a-f]{40}) \d+ (\d+)/)
    if (found) owner.set(Number(found[2]), found[1])
  }
  const full = since.map((sha) => git(root, 'rev-parse', '--verify', '-q', `${sha}^{commit}`).out.trim())
  if (full.some((sha) => !sha)) return new Set()
  const later = new Set()
  for (const line of lines) {
    const sha = owner.get(line)
    if (sha && full.every((fix) => sha !== fix && git(root, 'merge-base', '--is-ancestor', fix, sha).ok)) later.add(line)
  }
  return later
}

// A rev from a candidate reaches git as an argument: a leading dash would be an option (`--output=<path>` truncates a file), so it is not a rev.
const SAFE_REV = /^[\w@][\w./^~@{}:-]*$/
/** The first rev of a candidate (fixes, since, probes) that is not a plain rev, or null. */
export const unsafeRev = (candidate) => [...(candidate.fixes ?? []), ...(candidate.since ?? []), ...(candidate.probes ?? []).map((probe) => probe?.rev)].find((rev) => typeof rev !== 'string' || !SAFE_REV.test(rev)) ?? null

/** The pre-fix probes of a candidate: its explicit ones plus the files each fix commit changed, at the fix's parent. */
export function collectProbes(root, candidate, accepts = (file) => SOURCE_FILE.test(file)) {
  const probes = [...(candidate.probes ?? [])].map(({ rev, file }) => ({ rev, file }))
  for (const fix of candidate.fixes ?? []) {
    const changed = git(root, 'diff', '--name-only', '--diff-filter=MD', '--end-of-options', `${fix}^`, fix)
    for (const file of changed.out.split('\n').filter((name) => name && accepts(name)).slice(0, MAX_PER_FIX)) probes.push({ rev: `${fix}^`, file })
  }
  const seen = new Set()
  return probes.filter(({ rev, file }) => !seen.has(`${rev}\0${file}`) && seen.add(`${rev}\0${file}`))
}

/** The engines: `lint(text, file)` → `{ status, count, lines, message }`; one for an ESLint candidate, one for a repo-rule row. */
async function eslintEngine(root, candidate) {
  const loaded = await loadProjectEslint(root)
  if (loaded.error) return { unavailable: loaded.error }
  const rules = candidate.eslint ?? {}
  const ruleIds = Object.keys(rules)
  if (!ruleIds.length) return { invalid: 'an eslint candidate needs an "eslint" object: { "<ruleId>": ["error", { … }] }' }
  const typed = (file) => /\.[cm]?tsx?$/.test(file)
  const instances = new Map()
  const instanceFor = (file) => {
    // flat config (ESLint 9): type-aware parsing needs the file on disk, so a `.ts` from an old rev is linted without the program
    const key = loaded.major >= 9 && typed(file) ? 'untyped' : 'plain'
    if (!instances.has(key)) {
      const override = loaded.major >= 9 ? [{ ...(key === 'untyped' ? { languageOptions: { parserOptions: { project: null } } } : {}), rules }] : { rules }
      instances.set(key, new loaded.ESLint({ cwd: root, cache: false, fix: false, overrideConfig: override }))
    }
    return instances.get(key)
  }
  let existing = null
  let existingNote = ''
  return {
    describe: `eslint ${loaded.version} (${ruleIds.join(', ')})`,
    version: loaded.version,
    async lint(text, file) {
      let results
      try {
        results = await instanceFor(file).lintText(text, { filePath: join(root, file) })
      } catch (error) {
        return { status: 'inconclusive', why: `ESLint threw: ${String(error.message).split('\n')[0].slice(0, 100)}` }
      }
      const judged = judgeResult(results, ruleIds)
      if (judged.status !== 'inconclusive' && existing === null) {
        try {
          const config = await new loaded.ESLint({ cwd: root, cache: false, fix: false }).calculateConfigForFile(join(root, file))
          existing = Object.fromEntries(ruleIds.filter((id) => config?.rules?.[id] !== undefined).map((id) => [id, config.rules[id]]))
          existingNote = ruleIds.filter((id) => existing[id] === undefined).map((id) => `no entry for ${id} (checked on ${file})`).join('; ')
        } catch (error) {
          existing = {}
          existingNote = `could not read the project's entry for ${ruleIds.join(', ')} (on ${file}): ${String(error.message).split('\n')[0].slice(0, 100)}`
        }
      }
      return judged
    },
    existing: () => existing ?? {},
    existingNote: () => existingNote,
  }
}

function repoRuleEngine(candidate) {
  const row = `| ${candidate.id} | \`${String(candidate.pattern).replace(/\|/g, '\\|')}\` | ${candidate.files ?? '*'} | ${candidate.message ?? 'm'} | proof |`
  const { rules, problems } = parseRepoRules(`## Repo rules\n\n${row}\n`)
  if (!rules.length) return { invalid: `the row does not parse: ${problems.join('; ') || 'unknown'}` }
  const [rule] = rules
  return {
    describe: `repo rule ${rule.id} /${rule.source}/${rule.flags}`,
    rule,
    async lint(text, file) {
      if (!repoRuleApplies(rule, file)) return { status: 'inconclusive', why: 'the files column does not cover this path' }
      const lines = []
      text.split('\n').forEach((line, index) => {
        if (rule.regex.test(line)) lines.push(index + 1)
      })
      return lines.length ? { status: 'fired', count: lines.length, lines } : { status: 'quiet', count: 0, lines: [] }
    },
    existing: () => ({}),
  }
}

const MAX_SWEPT = 5000

/** The tracked files at HEAD a candidate covers: `{ files, covered, truncated }`; `files` are the ones to probe (a repo rule is prefiltered by `git grep`), `covered` all the covered ones. */
function headSweep(root, kind, engine, probes) {
  const tracked = git(root, 'ls-files').out.split('\n').filter(Boolean)
  let covered
  if (kind === 'repo-rule') covered = tracked.filter((file) => repoRuleApplies(engine.rule, file))
  else {
    const extensions = new Set(probes.map(({ file }) => file.match(/\.[^./]+$/)?.[0]).filter(Boolean))
    covered = tracked.filter((file) => SOURCE_FILE.test(file) && (!extensions.size || extensions.has(file.match(/\.[^./]+$/)?.[0])))
  }
  let files = covered
  if (kind === 'repo-rule' && covered.length) {
    // the prefilter only drops files that cannot fire: when git grep fails (a flavor it does not read), everything is probed
    const grep = git(root, 'grep', '-l', '-I', '-P', ...(engine.rule.flags.includes('i') ? ['-i'] : []), '-e', engine.rule.source, 'HEAD', '--')
    if (grep.ok) {
      const hit = new Set(grep.out.split('\n').map((name) => name.replace(/^HEAD:/, '')).filter(Boolean))
      files = covered.filter((file) => hit.has(file))
    } else if (grep.status === 1) files = []
  }
  const truncated = files.length > MAX_SWEPT
  return { files: truncated ? files.slice(0, MAX_SWEPT) : files, covered: covered.length, truncated }
}

/** Run a candidate: `{ proven, reason, engine, pre, head, … }`. */
export async function proveCandidate(root, candidate) {
  const kind = candidate.kind ?? (candidate.eslint ? 'eslint' : 'repo-rule')
  if (kind === 'claude-md') return { id: candidate.id, kind, proven: false, unproven: true, reason: 'a CLAUDE.md line has no mechanical proof: marked unproven' }
  const unsafe = unsafeRev(candidate)
  if (unsafe !== null) return { id: candidate.id, kind, proven: false, invalid: true, reason: `"${String(unsafe).slice(0, 60)}" is not a revision (a rev is letters, digits and ./^~@{}:- and does not start with a dash)` }
  const engine = kind === 'eslint' ? await eslintEngine(root, candidate) : repoRuleEngine(candidate)
  if (engine.unavailable) return { id: candidate.id, kind, proven: false, noEslint: true, reason: `${engine.unavailable}: no proof by ESLint, offer a repo rule (proven by git show + its regex) or a CLAUDE.md line marked unproven` }
  if (engine.invalid) return { id: candidate.id, kind, proven: false, invalid: true, reason: engine.invalid }
  const accepts = kind === 'repo-rule' ? (file) => repoRuleApplies(engine.rule, file) : (file) => SOURCE_FILE.test(file)
  const probes = collectProbes(root, candidate, accepts)
  const probe = async (rev, file) => {
    const shown = git(root, 'show', '--end-of-options', `${rev}:${file}`)
    if (!shown.ok) return { rev, file, status: 'inconclusive', why: 'git show failed (the file does not exist at this rev)' }
    return { rev, file, ...(await engine.lint(shown.out, file)) }
  }
  const pre = []
  for (const { rev, file } of probes) pre.push(await probe(rev, file))
  // HEAD is swept by default: every tracked file the candidate covers, not the files the fix cleaned (those are quiet by construction).
  // `headFiles` narrows the sweep to the named files; a narrowed probe is not a HEAD proof and the result says so.
  const narrowed = Boolean(candidate.headFiles?.length)
  const sweep = narrowed ? null : headSweep(root, kind, engine, probes)
  const headFiles = narrowed ? candidate.headFiles : sweep.files
  const since = candidate.since ?? candidate.fixes ?? []
  const head = []
  for (const file of headFiles) {
    const found = await probe('HEAD', file)
    if (found.status === 'fired') {
      const later = laterLines(root, 'HEAD', file, found.lines, since)
      found.legacyLines = found.lines.filter((line) => !later.has(line))
      found.laterLines = found.lines.filter((line) => later.has(line))
    }
    head.push(found)
  }
  const firedPre = pre.filter(({ status }) => status === 'fired')
  const conclusivePre = pre.filter(({ status }) => status !== 'inconclusive').length
  const conclusiveHead = head.filter(({ status }) => status !== 'inconclusive')
  const legacy = head.filter(({ legacyLines }) => legacyLines?.length)
  const covered = narrowed ? headFiles.length : sweep.covered
  const headScope = { narrowed, covered, probed: headFiles.length, quiet: head.filter(({ status }) => status === 'quiet').length + (covered - headFiles.length), truncated: sweep?.truncated ?? false }
  let reason = ''
  if (headScope.truncated) reason = `the HEAD sweep is over ${MAX_SWEPT} files: narrow it with headFiles, "quiet" is not shown`
  else if (firedPre.length < 2) reason = `fires on ${firedPre.length} conclusive pre-fix version${firedPre.length === 1 ? '' : 's'} (needs 2; ${conclusivePre} of ${pre.length} probes were conclusive)`
  else if (legacy.length) reason = `still fires on HEAD at lines that predate the fix: ${legacy.map(({ file, legacyLines }) => `${file}:${legacyLines.join(',')}`).join('; ')} (legacy code, not proof of the rule)`
  else if (!conclusiveHead.length && !headScope.quiet) reason = 'no conclusive HEAD probe: the files are gone or not linted at HEAD, so "quiet" is not shown'
  const ok = narrowed ? `fires on pre-fix versions, quiet on the ${headFiles.length} HEAD file(s) named (narrowed: not a HEAD proof)` : `fires on pre-fix versions, quiet on HEAD (${headScope.quiet} of ${covered} tracked files)`
  return { id: candidate.id, kind, engine: engine.describe, proven: !reason, reason: reason || ok, pre, head, headScope, existing: engine.existing?.() ?? {}, existingNote: engine.existingNote?.() ?? '' }
}

const short = (rev) => (/^[0-9a-f]{12,40}(\^|~\d+)?$/.test(rev) ? `${rev.replace(/^([0-9a-f]{8})[0-9a-f]*/, '$1')}` : rev)

export function renderProof(result) {
  const out = [`${result.proven ? 'PROVEN' : result.unproven ? 'UNPROVEN' : 'NOT PROVEN'} — ${result.id} (${result.engine ?? result.kind}): ${result.reason}`]
  const line = (probe) => {
    const detail = probe.status === 'fired' ? `fired ${probe.count} (lines ${probe.lines.slice(0, 8).join(', ')}${probe.lines.length > 8 ? ', …' : ''})` : probe.status === 'quiet' ? 'quiet (0)' : `inconclusive, not counted: ${probe.why}`
    const added = probe.laterLines?.length ? `; added after the fix: ${probe.laterLines.join(', ')}` : ''
    const old = probe.legacyLines?.length ? `; predate the fix: ${probe.legacyLines.join(', ')}` : ''
    return `  ${short(probe.rev)}:${probe.file} — ${detail}${added}${old}`
  }
  if (result.pre) {
    const fired = result.pre.filter(({ status }) => status === 'fired')
    out.push(`Pre-fix: fired on ${fired.length} of ${result.pre.length} (${fired.reduce((sum, { count }) => sum + count, 0)} hits)`, ...result.pre.map(line))
    const scope = result.headScope
    const firing = result.head.filter(({ status }) => status === 'fired')
    const hushed = result.head.filter(({ status }) => status === 'inconclusive')
    if (scope.narrowed) out.push(`HEAD (narrowed to ${scope.probed} named file(s), not a HEAD proof): quiet on ${scope.quiet} of ${scope.probed}${firing.length ? `, fires on ${firing.length}` : ''}`, ...result.head.map(line))
    else {
      out.push(`HEAD: quiet on ${scope.quiet} of ${scope.covered} tracked files${firing.length ? `, fires on ${firing.length}` : ''}${hushed.length ? `, ${hushed.length} inconclusive` : ''}`)
      out.push(...firing.slice(0, 20).map(line), ...(firing.length > 20 ? [`  … and ${firing.length - 20} more files`] : []), ...hushed.slice(0, 5).map(line))
    }
  }
  if (result.existingNote) out.push(result.existingNote)
  if (Object.keys(result.existing ?? {}).length) out.push(`The project already has: ${JSON.stringify(result.existing)} — a proposal merges with these entries; the override used here replaced them`)
  return `${out.join('\n')}\n`
}

async function main() {
  const args = process.argv.slice(2)
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
  const root = resolve(flag('--root') ?? process.cwd())
  if (args.includes('--check-eslint')) {
    const loaded = await loadProjectEslint(root)
    console.log(loaded.error ? `no ESLint: ${loaded.error}` : `eslint ${loaded.version} at ${loaded.path}`)
    process.exit(loaded.error ? 3 : 0)
  }
  const raw = flag('--candidate')
  if (!raw) {
    console.error('Usage: node promote-proof.mjs --root <repo> --candidate <file.json | json> [--json] | --check-eslint')
    process.exit(2)
  }
  let candidate
  try {
    candidate = JSON.parse(raw.trim().startsWith('{') ? raw : readFileSync(resolve(raw), 'utf8'))
  } catch (error) {
    console.error(`the candidate is not JSON: ${error.message}`)
    process.exit(2)
  }
  if (!candidate.id) {
    console.error('the candidate needs an "id"')
    process.exit(2)
  }
  const result = await proveCandidate(root, candidate)
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : renderProof(result))
  process.exit(result.proven ? 0 : result.noEslint ? 3 : result.invalid ? 2 : 1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]) && existsSync(process.argv[1])) await main()
