#!/usr/bin/env node
/**
 * floor-ok-file: фикстуры guard'а — нарушения в строках ниже заложены намеренно
 * Самопроверка floor-guard на фикстурах — детерминированно, без модели, гоняется в CI.
 * Каждый кейс — base-коммит и правка поверх; ждём точный набор правил (или код выхода 2).
 * Guard, который молча перестал видеть свой класс, хуже отсутствующего: он выдаёт зелёный.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '../plugins/stage-pipeline/scripts/floor-guard.mjs')

const CASES = [
  {
    name: 'чистый диф',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/a.ts': 'export const a = 2\n' },
    expect: [],
  },
  {
    name: '@ts-ignore и eslint-disable без причины',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/a.ts': '// @ts-ignore\nexport const a: string = 1\n// eslint-disable-next-line no-console\nconsole.log(a)\n' },
    expect: ['silenced-checker', 'silenced-checker'],
  },
  {
    name: 'обоснованное подавление — не нарушение, а исключение',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/a.ts': '// eslint-disable-next-line no-console -- лог нужен до релиза метрик\nconsole.log(1)\n' },
    expect: [],
    accepted: 1,
  },
  {
    name: '@ts-ignore не обосновывается даже floor-ok',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/a.ts': '// floor-ok: так надо до обновления типов\n// @ts-ignore\nexport const a: string = 1\n' },
    expect: ['silenced-checker'],
  },
  {
    name: 'упоминание директивы в прозе и регэкспе — не директива',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/a.ts': "// раньше тут стоял @ts-ignore, убран\nexport const re = /@ts-ignore|eslint-disable/\nexport const s = 'todo'\n" },
    expect: [],
  },
  {
    name: 'as any и заглушки',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: {
      'src/a.ts':
        "export const a = (1 as any) as number\nexport function f() { throw new Error('Not implemented') }\ntry { f() } catch {}\n// TODO: доделать\n",
    },
    expect: ['type-escape', 'unfinished-work', 'unfinished-work', 'unfinished-work'],
  },
  {
    name: 'skip/only, убранный ассерт, удалённый тест',
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
    name: 'переписанный ассерт — не ослабление',
    base: { 'src/a.test.ts': "it('a', () => {\n  expect(1).toBe(1)\n})\n" },
    change: { 'src/a.test.ts': "it('a', () => {\n  expect(1).toEqual(1)\n})\n" },
    expect: [],
  },
  {
    name: 'ослабленные конфиги и поднятый baseline',
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
    name: 'неотслеживаемый файл виден, секрет не печатается',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/new.ts': `export const key = 'ghp_${'x'.repeat(36)}'\n// @ts-nocheck\n` },
    untracked: true,
    expect: ['secret', 'silenced-checker'],
    forbidOutput: /ghp_x/,
  },
  {
    name: 'floor-ok-file переводит находки файла в исключения, но не секрет',
    base: { 'src/a.test.ts': "it('a', () => {})\n" },
    change: { 'src/a.test.ts': `// floor-ok-file: фикстура с заложенными дефектами\nit.skip('a', () => {})\nconst k = 'ghp_${'y'.repeat(36)}'\n` },
    expect: ['secret'],
    accepted: 1,
  },
  {
    name: 'нет merge-base — код 2, а не чисто',
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
  write(repo, spec.base)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  write(repo, spec.change)
  if (!spec.untracked) git(repo, 'add', '-A')

  const run = spawnSync('node', [GUARD, '--json', ...(spec.args ?? [])], { cwd: repo, encoding: 'utf8' })
  const problems = []
  const wantExit = spec.exitCode ?? (spec.expect.length ? 1 : 0)
  if (run.status !== wantExit) problems.push(`код выхода ${run.status}, ждали ${wantExit}`)
  if (wantExit !== 2) {
    const out = JSON.parse(run.stdout)
    const got = out.violations.map((v) => v.rule).sort()
    const want = [...spec.expect].sort()
    if (got.join() !== want.join()) problems.push(`правила ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`)
    if (spec.accepted !== undefined && out.accepted.length !== spec.accepted) problems.push(`исключений ${out.accepted.length}, ждали ${spec.accepted}`)
    if (spec.forbidOutput?.test(run.stdout)) problems.push('в выводе значение секрета')
  }
  rmSync(repo, { recursive: true, force: true })
  console.log(`${problems.length ? '✘' : '✔'} ${spec.name}${problems.length ? ` — ${problems.join('; ')}` : ''}`)
  if (problems.length) failed++
}
process.exit(failed ? 1 : 0)
