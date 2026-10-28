#!/usr/bin/env node
/**
 * A lower quality floor over the diff — catches the moves by which an agent gets to green without fixing anything:
 * a silenced checker, a weakened test, unfinished work, a loosened config, a secret in code.
 *
 *   node floor-guard.mjs                        # the stage diff: working tree + untracked files against HEAD
 *   node floor-guard.mjs --base origin/dev      # the whole branch: from the merge-base with the base to the working tree
 *   node floor-guard.mjs --json                 # the same, machine-readable
 *   node floor-guard.mjs --pathspec-from-stdin  # only these paths (git pathspecs from the root, NUL-separated; empty — nothing to check)
 *
 * Without `--pathspec-from-stdin` all untracked files are looked at too: violations in them are marked `untracked`,
 * because in a developer's tree there also lies what will never be committed next to the code.
 * Exit code: 0 — clean, 1 — there are violations, 2 — could not check (not a git repo, no base).
 * 2 is never read as 0: "could not look" ≠ "looked, clean".
 *
 * A justified exception is a `floor-ok: <reason>` marker on the same or the previous line, or an
 * idiomatic justification of the suppression itself (`eslint-disable-line x -- reason`, `@ts-expect-error reason`).
 * Such lines are not violations, but they are printed as a separate list: review and the user see them.
 * A file where defects are planted on purpose (test fixtures, the guard itself) gets `floor-ok-file: <reason>` in the first
 * 10 lines: all its findings go into exceptions with this reason instead of vanishing. The marker works in tests
 * and fixtures or if it stood in the file before the diff: a new marker in a production file would silence everything added next to it.
 * The value of a found secret is never printed — only the rule and the place; placeholders (`…EXAMPLE`,
 * `xxxx`, `0000`) do not count as secrets.
 * The rules adapt to the repo: `# noqa` and `# type: ignore` are suppression only if the repo has the
 * Python linter / type checker they are addressed to.
 *
 * Repo rules (stage 13): a `## Repo rules` table in the project's `pipeline.config.md` (id · pattern · files · message · evidence, parsed by `parseRepoRules`
 * in markers.mjs) adds the project's own rules, applied to ADDED lines only: a violation is printed as `[repo:<id>]` with the rule's message, and
 * `floor-ok: <reason>` on the same or the previous line exempts it like any other rule. The config is found as the hooks find it (`configRoot`: this tree, else the
 * main tree of a linked worktree whose `.claude/` is excluded). No table — no change in the output. A row that cannot be used is a config problem, printed once:
 * the other rows still apply, exit code 2 ("could not check") when nothing else failed, never a silent pass.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { configRoot, readConfig } from './hooks/pipeline-state.mjs'
import { parseRepoRules, repoRuleAppliesAll, testLines } from './markers.mjs'

const args = process.argv.slice(2)
const json = args.includes('--json')
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : null
// A crashed script is not "found violations": the hook reads code 1 as a refusal to commit, so any error is code 2.
process.on('uncaughtException', (error) => bail(`internal error: ${error.code ?? error.message}`))
if (args.includes('--base') && (!baseArg || baseArg.startsWith('--'))) bail('--base expects a branch or a commit')
// The scope from the hook is what goes into the commit; `null` — the whole tree including untracked files.
const pathspecs = args.includes('--pathspec-from-stdin') ? readFileSync(0, 'utf8').split('\0').filter(Boolean) : null

const git = (...cmd) => execFileSync('git', ['-c', 'core.quotePath=false', ...cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 })
const tryGit = (...cmd) => {
  try {
    return git(...cmd)
  } catch {
    return null
  }
}

const root = tryGit('rev-parse', '--show-toplevel')?.trim()
if (!root) bail('not a git repository')
process.chdir(root)

// The project's rules. A config that cannot be read is no config; a row that cannot be used is a problem to print, never a crash.
const repoRules = (() => {
  try {
    const configAt = configRoot(root, root)
    return configAt ? parseRepoRules(readConfig(configAt)) : { rules: [], problems: [] }
  } catch {
    return { rules: [], problems: [] }
  }
})()
// The table quotes its own patterns, so the config files are not checked against them.
const REPO_RULE_SKIP = /(^|\/)pipeline\.config(\.local)?\.md$/
// A long minified line is cut here. This is not the guard against a backtracking pattern (60 characters are enough to hang one): `parseRepoRules` rejects the
// shapes it can see, and `testLines` runs each rule on a file's lines in a `vm` that stops it after REPO_RULE_MS, drops the row with a named problem and
// goes on — the built-in rules never depend on a row.
const REPO_LINE_MAX = 4000
const REPO_RULE_MS = 1000
const REPO_TOTAL_MS = 3000
let repoSpent = 0

let base = 'HEAD'
if (baseArg) {
  base = tryGit('merge-base', baseArg, 'HEAD')?.trim()
  if (!base) bail(`no merge-base with ${baseArg} — a git fetch or another base is needed`)
} else if (!tryGit('rev-parse', '--verify', '-q', 'HEAD')) {
  bail('the repo has no commits')
}

// Code and configs. Markdown is not looked at: documentation legitimately quotes `@ts-ignore` and `.skip`.
const CODE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|astro|py|go|rb|kt|swift|java|php|rs|cs)$/
const CONFIG = /(^|\/)(\.?eslintrc(\.\w+)?|eslint\.config\.\w+|biome\.jsonc?|tsconfig[\w.-]*\.json|(vitest|jest|vite|playwright)\.config\.\w+|package\.json|pipeline\.config\.md)$/
const SKIP_PATH = /(^|\/)(node_modules|dist|build|\.next|\.nuxt|\.output|coverage|vendor|__generated__)\/|(\.lock|-lock\.json|\.lock\.yaml|\.min\.js|\.map|\.snap)$|\.(generated|gen)\.\w+$/
// A test is recognised by the file name. A `test/` segment in the path does not count as a test: in live repos it can be a domain
// module ("tests/exams"), and its removal would read as "a test was deleted".
const TEST_FILE = /\.(test|spec|cy|e2e)\.\w+$|(^|\/)__tests__\/|_test\.\w+$|(^|\/)test_\w+\.py$|^tests?\/|(^|\/)\w+Tests?\.(swift|kt|java)$/
// Mocks and fixtures: type casts and a swallowed promise there are an idiom, not a bypass.
const TESTISH = new RegExp(`${TEST_FILE.source}|(^|\\/)(__mocks__|__fixtures__|fixtures?|testdata|mocks?)\\/`)

const RULES = {
  'silenced-checker': 'checker silenced',
  'type-escape': 'types bypassed by a cast',
  'test-made-easier': 'test weakened',
  'unfinished-work': 'unfinished work',
  'loosened-config': 'check config loosened',
  'secret': 'looks like a secret',
}

// A directive works only when it is the first word of a comment (for noqa and type: ignore the `#` comment is at the end
// of a code line, so it is searched for anywhere). A mention of a directive in prose, in a string or in a regexp is not a directive.
const COMMENT = String.raw`(?:\/\/|\/\*+|<!--|\{\/\*|^\s*\*)\s*`
const SUPPRESSION = new RegExp(`${COMMENT}(?:@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable|biome-ignore|oxlint-disable|stylelint-disable|(?:istanbul|c8|v8) ignore|nosemgrep|NOLINT)`)
const PY_SUPPRESSION = /#\s*noqa\b/
const PY_TYPE_SUPPRESSION = /#\s*type:\s*ignore\b/
const HARD_SUPPRESSION = new RegExp(`${COMMENT}@ts-(?:ignore|nocheck)`)
const TYPE_ESCAPE = /\bas\s+any\b|\bas\s+unknown\s+as\b/
const SKIPPED_TEST = /\b(it|test|describe|context|suite)\.(skip|only|todo)\s*\(|@pytest\.mark\.skip|\bt\.Skip\(/
// `xit(`/`fit(` — only in tests and not as a method: `model.fit(X, y)` and `fitAddon.fit()` are not a test focus.
const SKIPPED_TEST_BARE = /(?<![.\w$])(xit|xdescribe|xtest|fit|fdescribe)\s*\(/
// An empty catch is a swallowed error. `.catch(() => null)` is the "data is optional" idiom, not a stub.
const EMPTY_CATCH = /\bcatch\s*(\(\s*\w*\s*\))?\s*\{\s*\}|\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*\{\s*\}\s*\)/
const STUB = [/throw\s+new\s+\w*Error\([^)]*not\s+implemented/i, new RegExp(`(?:${COMMENT}|#\\s*)(?:TODO|FIXME|XXX)\\b`)]
const ASSERTION = /\b(expect|assert\w*|should)\b\s*[.(]/
// Placeholders from documentation and `.env.example`: AWS's `AKIAIOSFODNN7EXAMPLE`, `sk-proj-XXXX…`, `ctx7sk-0000…`.
const PLACEHOLDER = /EXAMPLE|X{6,}|x{6,}|0{8,}|\*{4,}|your[_-]?(api[_-]?)?key|placeholder|dummy|fake|redacted/i
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{24,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bctx7sk-[A-Za-z0-9-]{16,}\b/,
]
// Config loosening — only by added lines and only in the config of its own tool:
// `retry: 0` in vitest.config is not a switched-off rule, and `"off"` does not occur in package.json.
const ESLINT_CONFIG = /(^|\/)(\.?eslintrc(\.\w+)?|eslint\.config\.\w+|biome\.jsonc?)$/
const LOOSENED = [
  { file: /(^|\/)tsconfig[\w.-]*\.json$/, pattern: /["']?(strict|noImplicitAny|strictNullChecks|noUncheckedIndexedAccess|noImplicitReturns|noUnusedLocals|noUnusedParameters)["']?\s*:\s*false/ },
  { file: ESLINT_CONFIG, pattern: /:\s*\[?\s*["']off["']|:\s*\[?\s*0\s*[\],}]|["']?level["']?\s*:\s*["']off["']/ },
  { file: /(^|\/)package\.json$/, pattern: /--passWithNoTests|--no-verify/ },
]
// A coverage threshold is only a key in the test runner's config (or its section in package.json), baseline — only
// in the pipeline config. Otherwise dependency versions (`"baseline-browser-mapping": "^2.8.1"`) read as thresholds,
// and in JSON there is nowhere to put `floor-ok`.
const THRESHOLD_FILE = /(^|\/)((vitest|jest|vite)\.config\.\w+|package\.json|\.nycrc(\.json)?|\.c8rc(\.json)?)$/
const THRESHOLD = /["']?\b(lines|branches|functions|statements)\b["']?\s*:\s*(\d+(?:\.\d+)?)/
const BASELINE_FILE = /(^|\/)pipeline\.config(\.local)?\.md$/
const BASELINE = /\b(baseline)\b[^\n]*?(\d+(?:\.\d+)?)/

// floor-ok is for any rule; idioms of a justified suppression are only for the suppression itself.
const FLOOR_OK = /floor-ok:\s*\S.{8,}/
const JUSTIFIED_SUPPRESSION = [
  /eslint-disable(-next-line|-line)?\s+[\w@/-]+(\s*,\s*[\w@/-]+)*\s+--\s*\S.{4,}/,
  /@ts-expect-error:?\s+\S.{4,}/,
  /biome-ignore\s+\S+:\s*\S.{4,}/,
  // `# noqa: BLE001 — reason`, `# noqa: E501  # reason`, `# type: ignore[attr-defined]  # reason`
  /#\s*noqa:\s*[A-Z]+\d+(\s*,\s*[A-Z]+\d+)*\s*(?:[—–-]{1,2}|#|:)\s*\S.{4,}/,
  /#\s*type:\s*ignore(\[[\w,\s-]+\])?\s*#\s*\S.{4,}/,
]

// ── diff ─────────────────────────────────────────────────────────────────────
const files = new Map()
const fileEntry = (path) => {
  if (!files.has(path)) files.set(path, { added: [], removed: [] })
  return files.get(path)
}

// Prefixes and renames are explicit: `diff.mnemonicPrefix`/`diff.noprefix`/`diff.renames` from the developer's config
// change the headers, and the path stops matching the file.
const DIFF = ['--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/']
// An empty scope means no files at all, not "no limit": `git diff --` without paths looks at everything.
const scoped = (...cmd) => (pathspecs?.length === 0 ? '' : git(...cmd, '--', ...(pathspecs ?? [])))
parseUnified(scoped('diff', '--unified=0', ...DIFF, base))

// A regular file, not a directory (a nested repo, a submodule pointer), not a symlink and not a binary.
const regularFile = (path) => {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && stat.size <= 2 * 1024 * 1024
  } catch {
    return false
  }
}

const untracked = new Set(scoped('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))
for (const path of untracked) {
  if (SKIP_PATH.test(path) || !regularFile(path)) continue
  const text = readFileSync(path, 'utf8')
  if (text.includes('\0')) continue
  const entry = fileEntry(path)
  text.split('\n').forEach((line, i) => entry.added.push({ line: i + 1, text: line }))
}

const deleted = scoped('diff', '--name-only', '--diff-filter=D', '-z', ...DIFF, base).split('\0').filter(Boolean)
const repoHas = (...paths) => paths.some((path) => existsSync(path))
const repoFileHas = (path, pattern) => regularFile(path) && pattern.test(readFileSync(path, 'utf8'))
const pythonLinted =
  repoHas('ruff.toml', '.ruff.toml', '.flake8', '.pylintrc', 'tox.ini') ||
  repoFileHas('pyproject.toml', /\[tool\.(ruff|flake8|pylint)/) ||
  repoFileHas('setup.cfg', /\[flake8\]/)
const pythonTyped =
  repoHas('mypy.ini', '.mypy.ini', 'pyrightconfig.json') || repoFileHas('pyproject.toml', /\[tool\.(mypy|pyright)/) || repoFileHas('setup.cfg', /\[mypy\]/)

function parseUnified(diff) {
  let entry = null
  let header = false
  let oldLine = 0
  let newLine = 0
  for (const raw of diff.split('\n')) {
    // A file header runs from `diff --git` to the first `@@`: a content line `-- x` inside a hunk is not a header.
    if (raw.startsWith('diff --git ')) {
      entry = null
      header = true
    } else if (header && raw.startsWith('+++ ')) {
      const path = diffPath(raw.slice(4))
      entry = path === null ? null : fileEntry(path)
    } else if (header && !raw.startsWith('@@')) continue
    else if (raw.startsWith('@@')) {
      header = false
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/)
      oldLine = Number(m?.[1] ?? 0)
      newLine = Number(m?.[2] ?? 0)
    } else if (entry && raw.startsWith('+')) entry.added.push({ line: newLine++, text: raw.slice(1) })
    else if (entry && raw.startsWith('-')) entry.removed.push({ line: oldLine++, text: raw.slice(1) })
  }
}

// `+++ b/my file.ts\t` — git appends a tab to a path with a space; special characters are C-quoted even with quotePath=false.
function diffPath(raw) {
  let path = raw.replace(/\t$/, '')
  if (path === '/dev/null') return null
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1).replace(/\\([\\"tn])/g, (_, c) => ({ t: '\t', n: '\n' })[c] ?? c)
  }
  return path.replace(/^b\//, '')
}

// ── rules ────────────────────────────────────────────────────────────────────
const violations = []
const accepted = []
let addedTotal = 0
let removedTotal = 0

const justification = (lines, index, rule) => {
  const here = lines[index]?.text ?? ''
  const above = lines[index - 1]?.line === lines[index].line - 1 ? lines[index - 1].text : ''
  const patterns = rule === 'silenced-checker' ? [FLOOR_OK, ...JUSTIFIED_SUPPRESSION] : [FLOOR_OK]
  for (const text of [here, above]) {
    for (const pattern of patterns) {
      const m = text.match(pattern)
      if (m) return m[0].trim().slice(0, 120)
    }
  }
  return null
}

const FILE_OK = /floor-ok-file:\s*(\S.{8,})/
const fileMarker = (text) => text?.split('\n', 10).join('\n').match(FILE_OK)?.[1].replace(/\s*\*\/\s*$/, '').trim().slice(0, 120) ?? null
const fileJustification = (path) => {
  if (!regularFile(path)) return null
  const why = fileMarker(readFileSync(path, 'utf8'))
  if (!why) return null
  // A new marker in a production file is not an exception but a way to silence the whole file with one line.
  return TESTISH.test(path) || fileMarker(tryGit('show', `${base}:${path}`)) ? why : null
}

const record = (rule, path, line, text, lines, index, { redact = false, justifiable = true, message = null } = {}) => {
  const shown = redact ? '(value hidden)' : text.trim().slice(0, 120)
  // A secret is not justified by anything — neither by a line nor by a file.
  const why = rule === 'secret' ? null : currentFileOk ?? (justifiable && lines ? justification(lines, index, rule) : null)
  ;(why ? accepted : violations).push({ rule, file: path, line, text: shown, ...(message ? { message } : {}), ...(why ? { justification: why } : {}), ...notInGit(path) })
}

// The rows of the Repo rules table, one row at a time over the whole commit: one glob run over all paths and one pattern run over all covered added lines (one `vm`
// context each). A context per file and row spent the budget on setup, not on matching (1200 files x 8 rows ended in exit 2 with no violation). All rows share one
// budget: many slow rows must not add up past the hook's kill (the built-in rules below would be lost with it), so what the budget does not reach is skipped and named.
const repoHitsByPath = new Map() // path → Map(rule id → boolean[] per added line)
if (repoRules.rules.length) {
  const scanned = [...files].filter(([path, { added }]) => added.length && !SKIP_PATH.test(path) && !REPO_RULE_SKIP.test(path))
  const names = scanned.map(([path]) => path)
  const coveredByAny = new Set()
  for (const [at, rule] of repoRules.rules.entries()) {
    const left = REPO_TOTAL_MS - repoSpent
    if (left <= 0) {
      repoRules.problems.push(`Repo rules: the time budget of ${REPO_TOTAL_MS} ms for all rows ran out before row "${rule.id}" — it and the ${repoRules.rules.length - at - 1} row(s) after it were skipped (many rows or files, or a slow pattern or glob; the built-in rules ran)`)
      break
    }
    const limit = Math.min(REPO_RULE_MS, left)
    const gone = (what, set) =>
      repoRules.problems.push(
        set < REPO_RULE_MS
          ? `Repo rules row "${rule.id}": the time budget of ${REPO_TOTAL_MS} ms for all rows ran out during its ${what} — the row was skipped, the rows after it too, the built-in rules ran`
          : `Repo rules row "${rule.id}": the ${what} did not finish within ${REPO_RULE_MS} ms (backtracking) — the row was skipped, the other rules ran`,
      )
    let started = Date.now()
    const applies = repoRuleAppliesAll(rule, names, limit)
    repoSpent += Date.now() - started
    if (applies === null) {
      gone('files glob', limit)
      continue
    }
    const covered = scanned.filter((_, index) => applies[index])
    if (!covered.length) continue
    const texts = covered.flatMap(([, { added }]) => added.map(({ text }) => text.slice(0, REPO_LINE_MAX)))
    started = Date.now()
    const patternLimit = Math.min(REPO_RULE_MS, Math.max(1, REPO_TOTAL_MS - repoSpent))
    const hits = testLines(rule.regex, texts, patternLimit)
    repoSpent += Date.now() - started
    if (!hits) {
      gone('pattern', patternLimit)
      continue
    }
    let offset = 0
    for (const [path, { added }] of covered) {
      coveredByAny.add(path)
      if (!repoHitsByPath.has(path)) repoHitsByPath.set(path, new Map())
      repoHitsByPath.get(path).set(rule.id, hits.slice(offset, offset + added.length))
      offset += added.length
    }
  }
  // A repo rule looks at the first REPO_LINE_MAX characters of a line: what stands further is not checked, and that is said, not passed over.
  for (const [path, { added }] of scanned) {
    const longLines = coveredByAny.has(path) ? added.filter(({ text }) => text.length > REPO_LINE_MAX).length : 0
    if (longLines) repoRules.problems.push(`Repo rules: ${longLines} added line(s) in ${path} are longer than ${REPO_LINE_MAX} characters — repo rules were checked on the first ${REPO_LINE_MAX} only, not checked after that`)
  }
}

// An untracked file may not have been created by the stage — whoever knows the stage's file list decides.
const notInGit = (path) => (untracked.has(path) ? { untracked: true } : {})
let currentFileOk = null
const push = (rule, file, line, text) =>
  (currentFileOk ? accepted : violations).push({ rule, file, line, text, ...(currentFileOk ? { justification: currentFileOk } : {}), ...notInGit(file) })
for (const [path, { added, removed }] of files) {
  if (SKIP_PATH.test(path)) continue
  currentFileOk = fileJustification(path)
  addedTotal += added.length
  removedTotal += removed.length
  const isCode = CODE.test(path)
  const isConfig = CONFIG.test(path)
  const isTest = TEST_FILE.test(path)
  const isTestish = TESTISH.test(path)
  const isPython = path.endsWith('.py')

  // The hits of the Repo rules rows on this file, computed for the whole commit before this loop (`repoHitsByPath`).
  const repoHits = repoHitsByPath.get(path) ?? new Map()
  added.forEach(({ line, text }, i) => {
    if (SECRET.some((pattern) => pattern.exec(text) && !PLACEHOLDER.test(text.match(pattern)[0]))) {
      record('secret', path, line, text, added, i, { redact: true, justifiable: false })
    }
    for (const rule of repoRules.rules) {
      if (repoHits.get(rule.id)?.[i]) record(`repo:${rule.id}`, path, line, text, added, i, { message: rule.message })
    }
    if (!isCode && !isConfig) return
    if (HARD_SUPPRESSION.test(text)) record('silenced-checker', path, line, text, added, i, { justifiable: false })
    else if (SUPPRESSION.test(text)) record('silenced-checker', path, line, text, added, i)
    else if (isPython && ((pythonLinted && PY_SUPPRESSION.test(text)) || (pythonTyped && PY_TYPE_SUPPRESSION.test(text)))) {
      record('silenced-checker', path, line, text, added, i)
    }
    if (isCode && !isTestish && TYPE_ESCAPE.test(text)) record('type-escape', path, line, text, added, i)
    if (isCode && (SKIPPED_TEST.test(text) || (isTest && SKIPPED_TEST_BARE.test(text)))) record('test-made-easier', path, line, text, added, i)
    if (isCode && (STUB.some((pattern) => pattern.test(text)) || (!isTestish && EMPTY_CATCH.test(text)))) {
      record('unfinished-work', path, line, text, added, i)
    }
    if (LOOSENED.some((rule) => rule.file.test(path) && rule.pattern.test(text))) record('loosened-config', path, line, text, added, i)
  })

  // A threshold lowered (coverage) or a baseline raised (type_check): the number in the same key line changed toward weaker.
  const thresholds = THRESHOLD_FILE.test(path) ? THRESHOLD : BASELINE_FILE.test(path) ? BASELINE : null
  if (thresholds) {
    for (const before of removed) {
      const key = before.text.match(thresholds)
      if (!key) continue
      const after = added.find(({ text }) => text.match(thresholds)?.[1] === key[1])
      if (!after) continue
      const was = Number(key[2])
      const now = Number(after.text.match(thresholds)[2])
      const weaker = key[1] === 'baseline' ? now > was : now < was
      if (weaker) push('loosened-config', path, after.line, `${key[1]}: ${was} → ${now}`)
    }
  }
}

// A deleted test is a violation unless the diff itself explains it: the code it checked was deleted too
// (a component removed together with its test), or a test with the same name appeared elsewhere (a move without `git add`).
const stem = (path) => basename(path).replace(/\.(test|spec|cy|e2e)(?=\.)/, '').replace(/^test_|_test(?=\.)/, '').replace(/\.\w+$/, '')
const deletedSources = new Set(deleted.filter((path) => !TEST_FILE.test(path)).map(stem))
const addedTests = new Set([...files.keys()].filter((path) => TEST_FILE.test(path) && !deleted.includes(path)).map((path) => basename(path)))
const deletedTests = deleted.filter((path) => TEST_FILE.test(path) && CODE.test(path) && !SKIP_PATH.test(path))
for (const path of deletedTests) {
  if (deletedSources.has(stem(path)) || addedTests.has(basename(path))) continue
  violations.push({ rule: 'test-made-easier', file: path, line: 0, text: 'test file deleted' })
}

// An assertion removed — per file: an assertion rewritten in place (`toBe` → `toEqual`) does not disturb the balance, a removed one shows,
// even if the branch added tests elsewhere. An assertion counts as moved only if the same line
// appeared in another test file of the diff (a test split into two files). Deleted files are counted by the rule above.
const count = (lines) => lines.filter(({ text }) => ASSERTION.test(text)).length
const normalized = (text) => text.trim().replace(/\s+/g, ' ').replace(/;$/, '')
const testFiles = [...files].filter(([path]) => TEST_FILE.test(path) && CODE.test(path) && !SKIP_PATH.test(path) && !deleted.includes(path))
const addedElsewhere = (path) => {
  const pool = new Map()
  for (const [other, { added }] of testFiles) {
    if (other === path) continue
    for (const { text } of added) if (ASSERTION.test(text)) pool.set(normalized(text), (pool.get(normalized(text)) ?? 0) + 1)
  }
  return pool
}
for (const [path, { added, removed }] of testFiles) {
  let lost = count(removed) - count(added)
  if (lost <= 0) continue
  const pool = addedElsewhere(path)
  for (const { text } of removed.filter(({ text }) => ASSERTION.test(text))) {
    const key = normalized(text)
    if (lost > 0 && pool.get(key) > 0) {
      pool.set(key, pool.get(key) - 1)
      lost--
    }
  }
  if (lost <= 0) continue
  currentFileOk = fileJustification(path)
  push('test-made-easier', path, removed.find(({ text }) => ASSERTION.test(text))?.line ?? 0, `${lost} fewer assertions`)
}

// ── output ───────────────────────────────────────────────────────────────────
const baseLabel = `${baseArg ? `${baseArg} (merge-base ${base.slice(0, 8)})` : 'HEAD'}${pathspecs ? ` · commit paths only (${pathspecs.length})` : ''}`
const size = { files: [...files.keys()].filter((path) => !SKIP_PATH.test(path)).length, added: addedTotal, removed: removedTotal }

if (json) {
  process.stdout.write(JSON.stringify({ base: baseLabel, size, violations, accepted, ...(repoRules.problems.length ? { configProblems: repoRules.problems } : {}) }, null, 2) + '\n')
} else {
  console.log(`floor-guard: base ${baseLabel} · diff +${size.added} −${size.removed} lines in ${size.files} files (without lock/build)`)
  if (!violations.length) console.log('✔ no violations')
  else {
    console.log(`✘ violations: ${violations.length}`)
    for (const v of violations) console.log(`  - [${v.rule}] ${v.file}${v.line ? `:${v.line}` : ''}${v.untracked ? ' (not in git)' : ''} — ${v.message ?? RULES[v.rule]}: ${v.text}`)
  }
  // Once per run, not once per line: a row that cannot be used is a problem of the config, and the rows after it still ran.
  if (repoRules.problems.length) {
    console.log(`⚠ config problem: ${repoRules.problems.length} row(s) of the Repo rules table did not run:`)
    for (const problem of repoRules.problems) console.log(`  - ${problem}`)
  }
  if (accepted.length) {
    console.log(`justified exceptions: ${accepted.length} (for the stage journal and "⚠ Awaiting user confirmation")`)
    for (const a of accepted) console.log(`  - [${a.rule}] ${a.file}:${a.line} — ${a.justification}`)
  }
}
// A bad row is never a pass: with nothing else wrong the exit code is 2 ("could not check"), which the force-commit hook reports as an unchecked commit.
if (!violations.length && repoRules.problems.length) {
  console.error(`floor-guard: could not check the project's repo rules — ${repoRules.problems[0]}${repoRules.problems.length > 1 ? ` (+${repoRules.problems.length - 1} more)` : ''}`)
  process.exit(2)
}
process.exit(violations.length ? 1 : 0)

function bail(message) {
  if (json) process.stdout.write(JSON.stringify({ error: message }) + '\n')
  else console.error(`floor-guard: could not check — ${message}`)
  process.exit(2)
}
