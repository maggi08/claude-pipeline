#!/usr/bin/env node
/**
 * floor-ok-file: guard fixtures — the violations in the lines below are planted on purpose
 * Self-test of floor-guard on fixtures — deterministic, no model, runs in CI.
 * Each case is a base commit plus an edit on top; the exact set of rules is expected (or exit code 2).
 * A guard that silently stopped seeing its class is worse than none: it reports green.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '../plugins/stage-pipeline/scripts/floor-guard.mjs')

const CASES = [
  {
    name: 'clean diff',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/a.ts': 'export const a = 2\n' },
    expect: [],
  },
  {
    name: '@ts-ignore and eslint-disable without a reason',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/a.ts': '// @ts-ignore\nexport const a: string = 1\n// eslint-disable-next-line no-console\nconsole.log(a)\n' },
    expect: ['silenced-checker', 'silenced-checker'],
  },
  {
    name: 'a justified suppression is not a violation but an exception',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/a.ts': '// eslint-disable-next-line no-console -- the log is needed until the metrics release\nconsole.log(1)\n' },
    expect: [],
    accepted: 1,
  },
  {
    name: '@ts-ignore is not justified even by floor-ok',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/a.ts': '// floor-ok: needed until the types are updated\n// @ts-ignore\nexport const a: string = 1\n' },
    expect: ['silenced-checker'],
  },
  {
    name: 'a directive mentioned in prose or a regexp is not a directive',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/a.ts': "// there used to be a @ts-ignore here, removed\nexport const re = /@ts-ignore|eslint-disable/\nexport const s = 'todo'\n" },
    expect: [],
  },
  {
    name: 'as any and stubs',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: {
      'src/a.ts':
        "export const a = (1 as any) as number\nexport function f() { throw new Error('Not implemented') }\ntry { f() } catch {}\n// TODO: finish this\n",
    },
    expect: ['type-escape', 'unfinished-work', 'unfinished-work', 'unfinished-work'],
  },
  {
    name: 'skip/only, a removed assert, a deleted test',
    base: {
      'src/a.test.ts': "it('a', () => {\n  expect(1).toBe(1)\n  expect(2).toBe(2)\n})\n",
      'src/b.test.ts': "it('b', () => { expect(1).toBe(1) })\n",
    },
    change: {
      'src/a.test.ts': "it.skip('a', () => {\n  expect(1).toBe(1)\n})\n",
      'src/b.test.ts': null,
    },
    expect: ['test-made-easier', 'test-made-easier', 'test-made-easier'],
  },
  {
    name: 'a rewritten assert is not a weakening',
    base: { 'src/a.test.ts': "it('a', () => {\n  expect(1).toBe(1)\n})\n" },
    change: { 'src/a.test.ts': "it('a', () => {\n  expect(1).toEqual(1)\n})\n" },
    expect: [],
  },
  {
    name: 'weakened configs and a raised baseline',
    base: {
      'tsconfig.json': '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n',
      'eslint.config.js': "export default [{ rules: {\n  'no-console': 'error',\n} }]\n",
      'vitest.config.ts': 'export default { test: { retry: 1, coverage: { thresholds: { lines: 80 } } } }\n',
      '.claude/pipeline.config.md': '- type_check: yarn tsc  # baseline: 3\n',
    },
    change: {
      'tsconfig.json': '{\n  "compilerOptions": {\n    "strict": false\n  }\n}\n',
      'eslint.config.js': "export default [{ rules: {\n  'no-console': 'off',\n} }]\n",
      'vitest.config.ts': 'export default { test: { retry: 0, coverage: { thresholds: { lines: 60 } } } }\n',
      '.claude/pipeline.config.md': '- type_check: yarn tsc  # baseline: 9\n',
    },
    expect: ['loosened-config', 'loosened-config', 'loosened-config', 'loosened-config'],
  },
  {
    name: 'an untracked file is visible, a secret is not printed',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/new.ts': `export const key = 'ghp_${'aB3dE5'.repeat(6)}'\n// @ts-nocheck\n` },
    untracked: true,
    expect: ['secret', 'silenced-checker'],
    forbidOutput: /ghp_aB3/,
  },
  {
    name: 'floor-ok-file turns a file\'s findings into exceptions, but not a secret',
    base: { 'src/a.test.ts': "it('a', () => {})\n" },
    change: { 'src/a.test.ts': `// floor-ok-file: a fixture with planted defects\nit.skip('a', () => {})\nconst k = 'ghp_${'y'.repeat(36)}'\n` },
    expect: ['secret'],
    accepted: 1,
  },
  // ── real formats from repos where the guard gave a false positive or missed a real one ──
  {
    name: 'a path with a space — rules work (git appends a tab to the name)',
    base: { 'src/my file.ts': 'export const a = 1\n' },
    change: { 'src/my file.ts': 'export const a = 1 as any\n' },
    expect: ['type-escape'],
  },
  {
    name: '# noqa without a Python linter in the repo is not a suppression',
    base: { 'bot.py': 'def f():\n    pass\n' },
    change: { 'bot.py': 'def f():\n    try:\n        g()\n    except Exception:  # noqa: BLE001\n        raise\n' },
    expect: [],
  },
  {
    name: '# noqa with ruff is a suppression; with a reason it is an exception',
    base: { 'ruff.toml': 'line-length = 100\n', 'bot.py': 'x = 1\n' },
    change: { 'bot.py': 'x = 1\ny = g()  # noqa: BLE001\nz = h()  # noqa: BLE001 — telegram drops the bot on any error\n' },
    expect: ['silenced-checker'],
    accepted: 1,
  },
  {
    name: '.catch(() => null) is not a stub; an empty .catch in code is, in a test it is not',
    base: { 'src/a.ts': 'export const a = 1\n', 'src/a.test.ts': "it('a', () => { expect(1).toBe(1) })\n" },
    change: {
      'src/a.ts': 'export const a = load().catch(() => null)\nexport const b = load().catch(() => undefined)\nexport const c = load().catch(() => {})\n',
      'src/a.test.ts': "it('a', async () => { await run().catch(() => {}); expect(1).toBe(1) })\n",
    },
    expect: ['unfinished-work'],
  },
  {
    name: 'a domain module test/ is not a test, a cast in tests is not a bypass',
    base: {
      'apps/api/src/modules/test/test.service.ts': 'export const s = 1\n',
      'src/b.test.ts': "it('b', () => { expect(1).toBe(1) })\n",
    },
    change: {
      'apps/api/src/modules/test/test.service.ts': null,
      'src/b.test.ts': "it('b', () => { const r = {} as unknown as Request; expect(r).toBeTruthy() })\n",
    },
    expect: [],
  },
  {
    name: 'a test deleted together with its code or moved is not a weakening',
    base: {
      'src/Banner.tsx': 'export const Banner = () => null\n',
      'src/Banner.test.tsx': "it('b', () => { expect(1).toBe(1) })\n",
      'src/old/format.test.ts': "it('f', () => { expect(1).toBe(1) })\n",
    },
    change: {
      'src/Banner.tsx': null,
      'src/Banner.test.tsx': null,
      'src/old/format.test.ts': null,
      'src/lib/format.test.ts': "it('f', () => { expect(1).toBe(1) })\n",
    },
    untracked: true,
    expect: [],
  },
  {
    name: 'a test split across two files — no asserts lost',
    base: { 'src/a.test.ts': "it('a', () => {\n  expect(1).toBe(1)\n  expect(2).toBe(2)\n})\n" },
    change: {
      'src/a.test.ts': "it('a', () => {\n  expect(1).toBe(1)\n})\n",
      'src/a2.test.ts': "it('a2', () => {\n  expect(2).toBe(2)\n})\n",
    },
    expect: [],
  },
  {
    name: 'a removed assert is visible even if the branch added tests in another folder',
    base: {
      'tests/smoke/roles.spec.ts': "test('r', async () => {\n  expect(a).toContain(b)\n  await expect(page.getByText(DENIED)).toHaveCount(0)\n})\n",
      'src/other/x.test.ts': "it('x', () => { expect(1).toBe(1) })\n",
    },
    change: {
      'tests/smoke/roles.spec.ts': "test('r', async () => {\n  expect(a).toContain(b)\n})\n",
      'src/other/x.test.ts': "it('x', () => {\n  expect(1).toBe(1)\n  expect(2).toBe(2)\n  expect(3).toBe(3)\n})\n",
    },
    expect: ['test-made-easier'],
  },
  {
    name: 'dependency versions in package.json are not thresholds; a jest coverage threshold is',
    base: {
      'package.json': '{\n  "devDependencies": {\n    "baseline-browser-mapping": "^2.8.1",\n    "firebase-functions": "^5.0.0"\n  },\n  "jest": { "coverageThreshold": { "global": {\n    "lines": 80\n  } } }\n}\n',
    },
    change: {
      'package.json': '{\n  "devDependencies": {\n    "baseline-browser-mapping": "^2.9.0",\n    "firebase-functions": "^4.9.0"\n  },\n  "jest": { "coverageThreshold": { "global": {\n    "lines": 70\n  } } }\n}\n',
    },
    expect: ['loosened-config'],
  },
  {
    name: 'secret placeholders are not a secret',
    base: { 'README.md': '# x\n' },
    change: {
      '.env.example': 'OPENAI_API_KEY=sk-proj-XXXXXXXXXXXXXXXXXXXXXXXXXXXX\n',
      'src/aws.test.ts': "const k = 'AKIAIOSFODNN7EXAMPLE'\nit('k', () => { expect(k).toBeTruthy() })\n",
      'src/ctx.ts': "export const sample = 'ctx7sk-00000000000000000000'\n",
    },
    expect: [],
  },
  {
    name: 'model.fit() and addon.fit() are not test focus',
    base: { 'train.py': 'x = 1\n', 'src/term.ts': 'export const t = 1\n' },
    change: { 'train.py': 'x = 1\nmodel.fit(X, y)\n', 'src/term.ts': 'export const t = 1\nfitAddon.fit()\n' },
    expect: [],
  },
  {
    name: 'a new floor-ok-file in a production file silences nothing',
    base: { 'src/pay.ts': 'export const p = 1\n' },
    change: { 'src/pay.ts': '// floor-ok-file: temporary, we will sort it out later\nexport const p = (1 as any) as number\ntry { f() } catch {}\n' },
    expect: ['type-escape', 'unfinished-work'],
  },
  {
    name: 'a floor-ok-file that stood in the file before the diff is in effect',
    base: { 'scripts/fixtures.mjs': '// floor-ok-file: guard fixtures with planted defects\nexport const a = 1\n' },
    change: { 'scripts/fixtures.mjs': '// floor-ok-file: guard fixtures with planted defects\nexport const a = 1 as any\n' },
    expect: [],
    accepted: 1,
  },
  {
    name: 'diff.mnemonicPrefix in the developer config does not break paths',
    base: { 'src/a.test.ts': "it('a', () => {})\n" },
    change: { 'src/a.test.ts': "// floor-ok-file: a fixture with planted defects\nit.skip('a', () => {})\n" },
    gitConfig: { 'diff.mnemonicPrefix': 'true', 'diff.renames': 'false' },
    expect: [],
    accepted: 1,
  },
  {
    name: 'a nested repo and a symlink to a directory are not a crash',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: {},
    after: (repo) => {
      mkdirSync(join(repo, 'vendor-kit'))
      git(join(repo, 'vendor-kit'), 'init', '-q')
      symlinkSync(join(repo, 'src'), join(repo, 'src-link'))
    },
    expect: [],
  },
  {
    name: 'without scope: junk next to the code is visible but marked "not in git"',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/a.ts': 'export const a = 2\n', 'Saved PR_files/02v-48e5.js': 'try{x()}catch{}\n' },
    untracked: true,
    expect: ['unfinished-work'],
    untrackedMarked: 1,
  },
  {
    name: 'commit scope: untracked junk outside the paths is not checked',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/a.ts': 'export const a = 2\n', 'Saved PR_files/02v-48e5.js': 'try{x()}catch{}\n// TODO later\n' },
    untracked: true,
    args: ['--pathspec-from-stdin'],
    stdin: ':(literal)src/a.ts',
    expect: [],
  },
  {
    name: 'commit scope: a new file from `git add` is checked',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/new.ts': 'export const b = 1 as any\n' },
    untracked: true,
    args: ['--pathspec-from-stdin'],
    stdin: 'src',
    expect: ['type-escape'],
  },
  {
    name: 'commit scope: empty — nothing to commit, clean',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/a.ts': 'export const a = 1 as any\n' },
    args: ['--pathspec-from-stdin'],
    stdin: '',
    expect: [],
  },
  {
    name: 'commit scope: a name with square brackets is taken literally',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { '[T-1] page.ts': 'export const p = 1 as any\n' },
    args: ['--pathspec-from-stdin'],
    stdin: ':(literal)[T-1] page.ts',
    expect: ['type-escape'],
  },
  {
    name: '--base without a value — code 2',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: {},
    args: ['--base'],
    exitCode: 2,
  },
  {
    name: 'no merge-base — code 2, not clean',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: {},
    args: ['--base', 'no-such-branch'],
    exitCode: 2,
  },
]

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
const write = (repo, files) => {
  for (const [path, content] of Object.entries(files)) {
    const target = join(repo, path)
    if (content === null) rmSync(target)
    else {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
  }
}

let failed = 0
for (const spec of CASES) {
  const repo = mkdtempSync(join(tmpdir(), 'floor-guard-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  for (const [key, value] of Object.entries(spec.gitConfig ?? {})) git(repo, 'config', key, value)
  write(repo, spec.base)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  write(repo, spec.change)
  if (!spec.untracked) git(repo, 'add', '-A')
  spec.after?.(repo)

  const run = spawnSync('node', [GUARD, '--json', ...(spec.args ?? [])], { cwd: repo, encoding: 'utf8', input: spec.stdin ?? '' })
  const problems = []
  const wantExit = spec.exitCode ?? (spec.expect.length ? 1 : 0)
  if (run.status !== wantExit) problems.push(`exit code ${run.status}, expected ${wantExit}`)
  if (wantExit !== 2) {
    const out = JSON.parse(run.stdout)
    const got = out.violations.map((v) => v.rule).sort()
    const want = [...spec.expect].sort()
    if (got.join() !== want.join()) problems.push(`rules ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
    if (spec.accepted !== undefined && out.accepted.length !== spec.accepted) problems.push(`exceptions ${out.accepted.length}, expected ${spec.accepted}`)
    const marked = out.violations.filter((v) => v.untracked).length
    if (spec.untrackedMarked !== undefined && marked !== spec.untrackedMarked) problems.push(`marked "not in git" ${marked}, expected ${spec.untrackedMarked}`)
    if (spec.forbidOutput?.test(run.stdout)) problems.push('the secret value is in the output')
  }
  rmSync(repo, { recursive: true, force: true })
  console.log(`${problems.length ? '✘' : '✔'} ${spec.name}${problems.length ? ` — ${problems.join('; ')}` : ''}`)
  if (problems.length) failed++
}
process.exit(failed ? 1 : 0)
