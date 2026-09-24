#!/usr/bin/env node
/**
 * floor-ok-file: фикстуры guard'а — нарушения в строках ниже заложены намеренно
 * Самопроверка floor-guard на фикстурах — детерминированно, без модели, гоняется в CI.
 * Каждый кейс — base-коммит и правка поверх; ждём точный набор правил (или код выхода 2).
 * Guard, который молча перестал видеть свой класс, хуже отсутствующего: он выдаёт зелёный.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
    change: { 'src/new.ts': `export const key = 'ghp_${'aB3dE5'.repeat(6)}'\n// @ts-nocheck\n` },
    untracked: true,
    expect: ['secret', 'silenced-checker'],
    forbidOutput: /ghp_aB3/,
  },
  {
    name: 'floor-ok-file переводит находки файла в исключения, но не секрет',
    base: { 'src/a.test.ts': "it('a', () => {})\n" },
    change: { 'src/a.test.ts': `// floor-ok-file: фикстура с заложенными дефектами\nit.skip('a', () => {})\nconst k = 'ghp_${'y'.repeat(36)}'\n` },
    expect: ['secret'],
    accepted: 1,
  },
  // ── живые форматы из репо, где guard давал ложное или пропускал настоящее ──
  {
    name: 'путь с пробелом — правила работают (git дописывает таб к имени)',
    base: { 'src/my file.ts': 'export const a = 1\n' },
    change: { 'src/my file.ts': 'export const a = 1 as any\n' },
    expect: ['type-escape'],
  },
  {
    name: '# noqa без Python-линтера в репо — не подавление',
    base: { 'bot.py': 'def f():\n    pass\n' },
    change: { 'bot.py': 'def f():\n    try:\n        g()\n    except Exception:  # noqa: BLE001\n        raise\n' },
    expect: [],
  },
  {
    name: '# noqa при ruff — подавление; с причиной — исключение',
    base: { 'ruff.toml': 'line-length = 100\n', 'bot.py': 'x = 1\n' },
    change: { 'bot.py': 'x = 1\ny = g()  # noqa: BLE001\nz = h()  # noqa: BLE001 — телеграм роняет бота на любой ошибке\n' },
    expect: ['silenced-checker'],
    accepted: 1,
  },
  {
    name: '.catch(() => null) — не заглушка; пустой .catch в коде — да, в тесте — нет',
    base: { 'src/a.ts': 'export const a = 1\n', 'src/a.test.ts': "it('a', () => { expect(1).toBe(1) })\n" },
    change: {
      'src/a.ts': 'export const a = load().catch(() => null)\nexport const b = load().catch(() => undefined)\nexport const c = load().catch(() => {})\n',
      'src/a.test.ts': "it('a', async () => { await run().catch(() => {}); expect(1).toBe(1) })\n",
    },
    expect: ['unfinished-work'],
  },
  {
    name: 'доменный модуль test/ — не тест, приведение в тестах — не обход',
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
    name: 'тест удалён вместе с кодом или перенесён — не ослабление',
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
    name: 'тест разнесён по двум файлам — ассерты не потеряны',
    base: { 'src/a.test.ts': "it('a', () => {\n  expect(1).toBe(1)\n  expect(2).toBe(2)\n})\n" },
    change: {
      'src/a.test.ts': "it('a', () => {\n  expect(1).toBe(1)\n})\n",
      'src/a2.test.ts': "it('a2', () => {\n  expect(2).toBe(2)\n})\n",
    },
    expect: [],
  },
  {
    name: 'версии зависимостей в package.json — не пороги; порог покрытия jest — да',
    base: {
      'package.json': '{\n  "devDependencies": {\n    "baseline-browser-mapping": "^2.8.1",\n    "firebase-functions": "^5.0.0"\n  },\n  "jest": { "coverageThreshold": { "global": {\n    "lines": 80\n  } } }\n}\n',
    },
    change: {
      'package.json': '{\n  "devDependencies": {\n    "baseline-browser-mapping": "^2.9.0",\n    "firebase-functions": "^4.9.0"\n  },\n  "jest": { "coverageThreshold": { "global": {\n    "lines": 70\n  } } }\n}\n',
    },
    expect: ['loosened-config'],
  },
  {
    name: 'плейсхолдеры секретов — не секрет',
    base: { 'README.md': '# x\n' },
    change: {
      '.env.example': 'OPENAI_API_KEY=sk-proj-XXXXXXXXXXXXXXXXXXXXXXXXXXXX\n',
      'src/aws.test.ts': "const k = 'AKIAIOSFODNN7EXAMPLE'\nit('k', () => { expect(k).toBeTruthy() })\n",
      'src/ctx.ts': "export const sample = 'ctx7sk-00000000000000000000'\n",
    },
    expect: [],
  },
  {
    name: 'model.fit() и addon.fit() — не фокус теста',
    base: { 'train.py': 'x = 1\n', 'src/term.ts': 'export const t = 1\n' },
    change: { 'train.py': 'x = 1\nmodel.fit(X, y)\n', 'src/term.ts': 'export const t = 1\nfitAddon.fit()\n' },
    expect: [],
  },
  {
    name: 'новый floor-ok-file в продовом файле ничего не глушит',
    base: { 'src/pay.ts': 'export const p = 1\n' },
    change: { 'src/pay.ts': '// floor-ok-file: временно, потом разберёмся\nexport const p = (1 as any) as number\ntry { f() } catch {}\n' },
    expect: ['type-escape', 'unfinished-work'],
  },
  {
    name: 'floor-ok-file, стоявший в файле до дифа, действует',
    base: { 'scripts/fixtures.mjs': '// floor-ok-file: фикстуры guard-а с заложенными дефектами\nexport const a = 1\n' },
    change: { 'scripts/fixtures.mjs': '// floor-ok-file: фикстуры guard-а с заложенными дефектами\nexport const a = 1 as any\n' },
    expect: [],
    accepted: 1,
  },
  {
    name: 'diff.mnemonicPrefix в конфиге разработчика не ломает пути',
    base: { 'src/a.test.ts': "it('a', () => {})\n" },
    change: { 'src/a.test.ts': "// floor-ok-file: фикстура с заложенными дефектами\nit.skip('a', () => {})\n" },
    gitConfig: { 'diff.mnemonicPrefix': 'true', 'diff.renames': 'false' },
    expect: [],
    accepted: 1,
  },
  {
    name: 'вложенный репо и симлинк на каталог — не падение',
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
    name: 'без охвата: мусор рядом с кодом виден, но помечен «не в git»',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/a.ts': 'export const a = 2\n', 'Saved PR_files/02v-48e5.js': 'try{x()}catch{}\n' },
    untracked: true,
    expect: ['unfinished-work'],
    untrackedMarked: 1,
  },
  {
    name: 'охват коммита: неотслеживаемый мусор вне путей не проверяется',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/a.ts': 'export const a = 2\n', 'Saved PR_files/02v-48e5.js': 'try{x()}catch{}\n// TODO later\n' },
    untracked: true,
    args: ['--pathspec-from-stdin'],
    stdin: ':(literal)src/a.ts',
    expect: [],
  },
  {
    name: 'охват коммита: новый файл из `git add` проверяется',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/new.ts': 'export const b = 1 as any\n' },
    untracked: true,
    args: ['--pathspec-from-stdin'],
    stdin: 'src',
    expect: ['type-escape'],
  },
  {
    name: 'охват коммита: пустой — коммитить нечего, чисто',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { 'src/a.ts': 'export const a = 1 as any\n' },
    args: ['--pathspec-from-stdin'],
    stdin: '',
    expect: [],
  },
  {
    name: 'охват коммита: имя с квадратными скобками — буквально',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: { '[T-1] page.ts': 'export const p = 1 as any\n' },
    args: ['--pathspec-from-stdin'],
    stdin: ':(literal)[T-1] page.ts',
    expect: ['type-escape'],
  },
  {
    name: '--base без значения — код 2',
    base: { 'src/a.ts': 'export const a = 1\n' },
    change: {},
    args: ['--base'],
    exitCode: 2,
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
  if (run.status !== wantExit) problems.push(`код выхода ${run.status}, ждали ${wantExit}`)
  if (wantExit !== 2) {
    const out = JSON.parse(run.stdout)
    const got = out.violations.map((v) => v.rule).sort()
    const want = [...spec.expect].sort()
    if (got.join() !== want.join()) problems.push(`правила ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`)
    if (spec.accepted !== undefined && out.accepted.length !== spec.accepted) problems.push(`исключений ${out.accepted.length}, ждали ${spec.accepted}`)
    const marked = out.violations.filter((v) => v.untracked).length
    if (spec.untrackedMarked !== undefined && marked !== spec.untrackedMarked) problems.push(`помечено «не в git» ${marked}, ждали ${spec.untrackedMarked}`)
    if (spec.forbidOutput?.test(run.stdout)) problems.push('в выводе значение секрета')
  }
  rmSync(repo, { recursive: true, force: true })
  console.log(`${problems.length ? '✘' : '✔'} ${spec.name}${problems.length ? ` — ${problems.join('; ')}` : ''}`)
  if (problems.length) failed++
}
process.exit(failed ? 1 : 0)
