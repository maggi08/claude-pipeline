#!/usr/bin/env node
/**
 * Самопроверка хуков и скриптов состояния — детерминированно, без модели, гоняется в CI.
 * Фикстуры — формы, которые реально встречаются в живых STAGES.md и конфигах: путь задач в бэктиках
 * и с `~`, «Ветка: … отведена от …», статусы `in-progress — …`, даты `22.08.2026`, подзаголовки
 * в журнале. Хук, который молча перестал видеть свою задачу, хуже отсутствующего: он выдаёт зелёный,
 * а хук, который видит чужие задачи, блокирует параллельную работу.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '../plugins/stage-pipeline/scripts')
// Реестр каталогов задач и снимки журнала хуки пишут в каталог данных плагина — в тесте он временный.
const DATA = mkdtempSync(join(tmpdir(), 'hooks-test-data-'))
process.env.CLAUDE_PLUGIN_DATA = DATA
const { commitScope, gitInvocations } = await import(join(PLUGIN, 'hooks/git-command.mjs'))
const { taskDirFromConfig, taskBranches, isCurrentTask, forceActive, openForceBlock, reviewModel } = await import(join(PLUGIN, 'hooks/pipeline-state.mjs'))
const { planArchive } = await import(join(PLUGIN, 'archive-stages.mjs'))
const { acViolation, skipViolation, barePasses } = await import(join(PLUGIN, 'journal-check.mjs'))

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ── разбор команды ───────────────────────────────────────────────────────────
const CWD = '/repo'
const COMMANDS = [
  ['git add -A', ['add']],
  ['git commit -m "fix: git add в тексте сообщения"', ['commit']],
  ['grep -rn "git add" .', []],
  ['rg "git commit" docs', []],
  ["echo 'git add .'", []],
  ['git log --grep="git commit"', []],
  ['git commit-tree abc123', []],
  ['git -c core.hooksPath=/dev/null commit -m x', ['commit']],
  ['git --no-pager commit -m x', ['commit']],
  ['FOO=1 git commit -m x', ['commit']],
  ['/usr/bin/git add .', ['add']],
  ['git status && git add src/a.ts && git commit -m "x"', ['add', 'commit']],
  ["cat <<'EOF' > msg.txt\ngit add .\nEOF\ngit status", []],
  ['git commit -m "$(cat <<\'EOF\'\nmsg: git add\nEOF\n)"', ['commit']],
]
for (const [command, want] of COMMANDS) {
  const got = gitInvocations(command, CWD).map((call) => call.subcommand)
  check(`команда ${JSON.stringify(command).slice(0, 60)} → [${want}]`, same(got, want), `получили [${got}]`)
}
check('git -C "a b" — репо из опции', gitInvocations('git -C "a b" commit -m x', CWD)[0]?.dir === '/repo/a b')
check('cd ../kit && git commit — репо после cd', gitInvocations('cd ../kit && git commit -m x', CWD)[0]?.dir === resolve('/repo', '../kit'))

// ── что войдёт в коммит ──────────────────────────────────────────────────────
const SCOPES = [
  ['git add src/a.ts src/b.ts && git commit -m "x"', { all: false, tracked: false, specs: ['src/a.ts', 'src/b.ts'] }],
  ['git add -A && git commit -m x', { all: true, tracked: false, specs: [] }],
  ['git add -A src && git commit -m x', { all: false, tracked: false, specs: ['src'] }],
  ['git add -u', { all: false, tracked: true, specs: [] }],
  ['git commit -am "fix: src/a.ts"', { all: false, tracked: true, specs: [] }],
  ['git commit -m "x" -- src/a.ts', { all: false, tracked: false, specs: ['src/a.ts'] }],
  ['git commit --author "A <a@b.c>" -F msg.txt', { all: false, tracked: false, specs: [] }],
  ['git commit --message=x src/a.ts', { all: false, tracked: false, specs: ['src/a.ts'] }],
  ['git add . 2>/dev/null && git commit -m x > /dev/null', { all: false, tracked: false, specs: ['.'] }],
  ['git add --pathspec-from-file=list.txt', { all: true, tracked: false, specs: [] }],
]
for (const [command, want] of SCOPES) {
  const scope = commitScope(gitInvocations(command, CWD))
  const got = { ...scope, specs: scope.specs.map(({ spec }) => spec) }
  check(`охват ${JSON.stringify(command).slice(0, 60)}`, same(got, want), `получили ${JSON.stringify(got)}`)
}
check('охват: путь — с каталогом вызова', commitScope(gitInvocations('cd src && git add a.ts', CWD)).specs[0]?.dir === '/repo/src')

// ── конфиг и шапка STAGES.md ─────────────────────────────────────────────────
const TASK_PATHS = [
  ['- task_path: `.claude/tasks/` — один каталог на монорепо', '/r/.claude/tasks'],
  ['- task_path: ~/.claude/team-tasks/   # вне репо', join(homedir(), '.claude/team-tasks')],
  ['- task_path: ~/.claude/team-tasks/<ТИКЕТ>/   # глобально', join(homedir(), '.claude/team-tasks')],
  ['- task_path: docs/tasks', '/r/docs/tasks'],
  ['- main_branch: dev', '/r/.claude/tasks'],
]
for (const [line, want] of TASK_PATHS) {
  const got = taskDirFromConfig(line, '/r').replace(/\/$/, '')
  check(`task_path ${JSON.stringify(line).slice(0, 50)}`, got === want, `получили ${got}`)
}

const HEADERS = [
  ['Ветка: `T-1/feat/banner` (пересажена на origin/dev 2026-07-28)', ['T-1/feat/banner']],
  ['Figma: <url>  Ветка: `feat/y`  Контексты: desktop | adaptive', ['feat/y']],
  ['Ветка: feat/olympiads (диф этапов — от merge-base с `dev`)', ['feat/olympiads']],
  ['Ветка: `T-2_feat/host-chat`, отведена от `redesign-2.0` (= `d28ea3fa3`) · PR — в `redesign-2.0`', ['T-2_feat/host-chat']],
  ['База ветки: `redesign-2.0` (не development) · Ветка задачи: создать `feat/auth` от `redesign-2.0`', ['feat/auth']],
  ['Ветка: создаётся от свежего `origin/dev`  Контексты: apps/sales', []],
  ['Ветки: `A/chore/deploy` влита в `main` и `dev`; этапы 6–11 идут от `B/feat/sales`', ['A/chore/deploy']],
  ['Ветка: `T-3/fix/isolation` (от `origin/dev`, `--no-track`)', ['T-3/fix/isolation']],
  ['Ветка: `T-4/feat/app` · Приложение: `apps/expert` · Контексты: desktop', ['T-4/feat/app']],
  ['Ветка: redesign-2.0  Контексты: mobile + desktop', ['redesign-2.0']],
  ['Ветка: TBD, база — `redesign-2.0` (решение 2026-08-04)', []],
  ['Figma: — (logic-only)  Ветка: master (PR-флоу нет, коммиты по этапам)  Контексты: owner', ['master']],
]
for (const [line, want] of HEADERS) {
  const got = taskBranches(`# T: задача\n${line}\nОбновлено: 2026-09-01\n\n## Статус: этап 1\n\nВетка: \`not-a-header\`\n`)
  check(`шапка ${JSON.stringify(line).slice(0, 60)}`, same(got, want), `получили ${JSON.stringify(got)}`)
}

check('тикет в имени ветки', isCurrentTask('KC-480', [], 'KC-480/feat/x') && isCurrentTask('api-layer', [], 'chore/refactor/api-layer'))
check('чужой тикет с тем же префиксом — не своя задача', !isCurrentTask('KC-48', [], 'KC-480/feat/x'))
check('detached HEAD — ничья', !isCurrentTask('KC-480', ['KC-480/feat/x'], null))
check('открытый блок Force-прогон', forceActive('## Force-прогон 2026-09-01\nРежим: …'))
check('закрытый блок Force-прогон', !forceActive('## Force-прогон 2026-09-01 — завершён 2026-09-02\nРежим: …'))
check('прогон до 0.11, закрытый статусом', !forceActive('## Статус: 5 из 5 этапов done — force-прогон завершён, ждёт пуша\n\n## Force-прогон 2026-09-01\n'))
check('статус с датой между словами', !forceActive('## Статус: force-прогон 2026-09-23 завершён — три коммита\n\n## Force-прогон 2026-09-23\n'))
check('«force-прогон не завершён» — прогон идёт', forceActive('## Статус: force-прогон не завершён, этап 7 в работе\n\n## Force-прогон 2026-09-01\n'))
check('все этапы done, финальные проверки — прогон идёт', forceActive('## Статус: все этапы done, финальные проверки\n\n## Force-прогон 2026-09-01\n\n### Этап 1: x  [status: done]\n'))
check('открытый Force-блок: дата из заголовка, текст до следующего раздела', (() => {
  const block = openForceBlock('## Force-прогон 28.09.2026 — завершён 28.09.2026\nстарый\n\n## Force-прогон 2026-10-05b (второй)\nОтветы интервью: …\n\n## Этапы\n')
  return block?.date === '2026-10-05' && block.body.includes('Ответы интервью') && !block.body.includes('Этапы')
})())
check('review_model: из конфига, по умолчанию opus', reviewModel('- review_model: sonnet   # дешевле') === 'sonnet' && reviewModel('- main_branch: dev') === 'opus')

// ── правила закрытия критериев ───────────────────────────────────────────────
// Строки — живые формы из STAGES.md: исход перед формулировкой и после, отложенная проверка, smoke, решение пользователя.
const REPORTS = ['devtools-verify-2.md', 'pro-review-2.md']
const AC_LINES = [
  ['- `AC-4.5` WHEN обязательное поле пустое THEN «Сохранить» неактивна — [verify: devtools-verify] ✅ pro-review по коду · ⏳ user-review', 'ac-checker'],
  ['- `AC-4.6` WHEN сохранено THEN тост — [verify: devtools-verify] ✅ pro-review по коду, стенд: лиды 76 и 80', 'ac-checker'],
  ['- `AC-3.8` WHEN `yarn start` THEN без ошибок — [verify: devtools-verify] ✅', 'ac-checker'],
  ['- `AC-1.2` WHEN сверить алерт с нодой THEN отступы совпадают — [verify: figma-compare] ✅ проверено живьём', 'ac-checker'],
  ['- `AC-2.4` WHEN сверить с макетом THEN радиус 12 — [verify: figma-compare] ✅ figma-compare', 'ac-report'],
  ['- `AC-2.3` WHEN нажать «Позвонить» THEN тот же блок — [verify: devtools-verify] ✅ devtools-verify (2 карточки)', null],
  ['- `AC-2.2` ✅ devtools-verify (CommonInput `/prime/{id}`) · WHEN вставка THEN номер верный — [verify: devtools-verify]', null],
  ['- `AC-3.4` WHEN вкладка открыта THEN дата перехода — [verify: devtools-verify] ⏳ devtools-verify', null],
  ['- `AC-1.1` WHEN шторка открыта THEN блока нет — [verify: devtools-verify] ✅ pro-review статически · [live: user-side]', null],
  ['- `AC-6.1` WHEN листинг гидрирован THEN запросов нет — [verify: devtools-verify] ✅ подтверждено живьём: 0 запросов', null],
  ['- `AC-8.1` WHEN форма пустая THEN «Добавить» активна — [verify: devtools-verify] ✅ smoke (new-lead.spec.ts:40)', null],
  ['- `AC-1.4` WHEN type-check THEN не выше baseline — [verify: pro-review] ✅ pro-review по коду', null],
  ['- `AC-5.2` WHEN экран открыт THEN без ошибок — [verify: devtools-verify] ✅ без чекера по решению пользователя 2026-10-02', null],
]
for (const [line, want] of AC_LINES) {
  const got = acViolation(line, REPORTS)?.rule ?? null
  check(`критерий ${JSON.stringify(line.slice(line.indexOf('[verify'))).slice(0, 70)} → ${want}`, got === want, `получили ${got}`)
}
const SKIPS = [
  ['Проверки: pro-review-7a.md; proto-compare и devtools-verify — skip: MCP-Chrome занят другой сессией, рантайм → `[live: user-side]`', true],
  ['- [x] proto-compare [skip: staging не принимает токен]', true],
  ['- [x] figma-compare   `[skip: logic-only]`', false],
  ['- [ ] figma-compare   (skip — Figma нет; визуальная сверка с PNG вручную)', false],
  ['Чекеры прохода: figma-compare / proto-compare — skip (Figma нет, прототип больше не эталон вида); вид сверяет devtools-verify', false],
  ['Пайплайн: implement · proto-compare · devtools-verify (`[live: user-side]`) · dead-code (skip: нет признака)', false],
]
for (const [line, want] of SKIPS) {
  check(`скип дизайн-чекера ${JSON.stringify(line).slice(0, 60)} → ${want ? 'нарушение' : 'ок'}`, Boolean(skipViolation(line)) === want)
}
const PASSES = [
  ['## AC (по коду)\n4.1 PASS · 4.5 PASS · 4.7 PASS (данные, «Сохранить» — через\n`isContractDraftChanged`) · 4.16 PASS с замечанием (п.7) · 4.17 PASS', ['AC-4.1', 'AC-4.5', 'AC-4.16', 'AC-4.17']],
  ['Вердикт: AC-3.1 PASS, AC-3.2 PASS.\n- `AC-3.1` — PASS, радиус 12px (`Button.vue:34`)\n- `AC-3.2` — PASS по порядку: `Tabs.vue:12`', []],
  ['- **`AC-8.1` — PASS на обеих бронях.**\n  - бронь 1: `status=OK`, 2 строки', []],
  ['- `AC-1.3` — PASS.\n- `AC-1.4` — PASS.', ['AC-1.3', 'AC-1.4']],
  ['Поведение: SPEC §27.5-27.7 PASS по смыслу', []],
  ['| AC-4.5 | PASS |\n| AC-4.6 | PASS | Button.vue:34 |', ['AC-4.5']],
  ['AC-1.1 PASS (390: box y763 h61 w358; 768: y774 h50 w736; text RU exact)', []],
]
for (const [text, want] of PASSES) {
  const got = barePasses(text)
  check(`голый PASS ${JSON.stringify(text).slice(0, 50)} → [${want}]`, same(got, want), `получили ${JSON.stringify(got)}`)
}

// ── git-guard и session-start на живом репо ──────────────────────────────────
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
const write = (root, files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}
const stages = (ticket, branch, { status = 'in-progress', force = '' } = {}) =>
  `# ${ticket}: задача\nВетка: \`${branch}\`\n\n## Статус: этап 1 — в работе\n\n${force}## Этапы\n\n### Этап 1: первый  [status: ${status}]\n`
const hook = (name, cwd, command) => {
  const run = spawnSync(process.execPath, [join(PLUGIN, 'hooks', name)], {
    input: JSON.stringify({ cwd, tool_input: { command } }),
    encoding: 'utf8',
  })
  if (name === 'session-start.mjs') return run.stdout
  if (!run.stdout) return 'allow'
  return JSON.parse(run.stdout).hookSpecificOutput?.permissionDecision ?? 'message'
}

const root = mkdtempSync(join(tmpdir(), 'hooks-test-'))
const repo = join(root, 'app')
mkdirSync(repo)
git(repo, 'init', '-q', '-b', 'main')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
write(repo, { 'src/a.ts': 'export const a = 1\n', '.gitignore': '.claude/\n' })
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'base')
// `.claude/` не в git, как в живых репо: в worktree конфига нет, он берётся из основного дерева.
write(repo, {
  '.claude/pipeline.config.md': '- task_path: `.claude/tasks/` — задачи\n- main_branch: main\n',
  '.claude/tasks/T-1/STAGES.md': stages('T-1', 'T-1/feat/a'),
  '.claude/tasks/T-2/STAGES.md': stages('T-2', 'T-2/feat/b', { force: '## Force-прогон 2026-09-24\nРежим: автономный.\n\n' }),
  '.claude/tasks/T-3/STAGES.md': stages('T-3', 'T-3/feat/c'),
})
const month = Date.now() / 1000 - 30 * 24 * 3600
utimesSync(join(repo, '.claude/tasks/T-3/STAGES.md'), month, month)

git(repo, 'checkout', '-qb', 'hotfix/x')
check('ветка без задачи: git add проходит, хотя T-1 в работе', hook('git-guard.mjs', repo, 'git add -A') === 'allow')

git(repo, 'checkout', '-qb', 'T-1/feat/a')
check('ветка T-1, обычный режим: git add отклонён', hook('git-guard.mjs', repo, 'git add -A') === 'deny')
// /stage-check закрывает этап в STAGES.md раньше, чем готовит коммит: статус этапа хук не смотрит.
for (const status of ['done', 'todo']) {
  write(repo, { '.claude/tasks/T-1/STAGES.md': stages('T-1', 'T-1/feat/a', { status }) })
  check(`ветка T-1, этап ${status}: git commit агента всё равно отклонён`, hook('git-guard.mjs', repo, 'git commit -m x') === 'deny')
}
write(repo, { '.claude/tasks/T-1/STAGES.md': stages('T-1', 'T-1/feat/a') })
check('ветка T-1: grep "git add" не трогается', hook('git-guard.mjs', repo, 'grep -rn "git add" .') === 'allow')
check('session-start: задача текущей ветки первой', /^- T-1 \(ветка T-1\/feat\/a\)/m.test(hook('session-start.mjs', repo)))

git(repo, 'checkout', '-qb', 'T-2/feat/b')
check('ветка T-2, force: git add проходит', hook('git-guard.mjs', repo, 'git add -A') === 'allow')
check('ветка T-2, force: чистый коммит проходит', hook('git-guard.mjs', repo, 'git commit -m x') === 'allow')
// floor-ok: фикстура — обход типов, который хук обязан отклонить на force-коммите
const ESCAPE = 'export const a = 1 as any\n'
// floor-ok: фикстура — сохранённая страница с минифицированным JS в корне репо, в коммит не идёт
const JUNK = { 'Saved PR_files/02v-48e5.js': 'try{x()}catch{}\n' }
write(repo, { 'src/a.ts': ESCAPE })
check('ветка T-2, force: коммит с обходом типов отклонён floor-guard', hook('git-guard.mjs', repo, 'git commit -am x') === 'deny')
check('ветка T-2, force: cd в подкаталог и git add — путь от него', hook('git-guard.mjs', repo, 'cd src && git add a.ts && git commit -m x') === 'deny')
write(repo, { '.claude/tasks/T-2/STAGES.md': stages('T-2', 'T-2/feat/b', { status: 'done', force: '## Force-прогон 2026-09-24\nРежим: автономный.\n\n' }) })
check('ветка T-2, force, этап уже done: floor-guard всё равно на коммите', hook('git-guard.mjs', repo, 'git commit -am x') === 'deny')
write(repo, { 'src/a.ts': 'export const a = 2\n', ...JUNK })
check('ветка T-2, force: мусор вне коммита не отклоняет git add путей', hook('git-guard.mjs', repo, 'git add src/a.ts && git commit -m x') === 'allow')
check('ветка T-2, force: мусор вне коммита не отклоняет commit -a', hook('git-guard.mjs', repo, 'git commit -am x') === 'allow')
check('ветка T-2, force: git add -A берёт мусор в коммит — отклонён', hook('git-guard.mjs', repo, 'git add -A && git commit -m x') === 'deny')
git(repo, 'add', 'Saved PR_files/02v-48e5.js')
check('ветка T-2, force: мусор уже в индексе — отклонён', hook('git-guard.mjs', repo, 'git commit -m x') === 'deny')
git(repo, 'reset', '-q')
rmSync(join(repo, 'Saved PR_files'), { recursive: true, force: true })
git(repo, 'checkout', '-q', '--', 'src/a.ts')
write(repo, { '.claude/tasks/T-2/STAGES.md': stages('T-2', 'T-2/feat/b', { force: '## Force-прогон 2026-09-24 — завершён 2026-09-25\n\n' }) })
check('ветка T-2, force закрыт: снова обычный режим', hook('git-guard.mjs', repo, 'git add -A') === 'deny')

git(repo, 'checkout', '-qb', 'T-3/feat/c')
check('брошенная задача (30 дней) ничего не блокирует', hook('git-guard.mjs', repo, 'git add -A') === 'allow')
const listing = hook('session-start.mjs', repo)
check('session-start: брошенная задача не выводится', !/T-3/.test(listing) && /T-1/.test(listing), JSON.stringify(listing))

git(repo, 'checkout', '-q', 'main')
const worktree = join(root, 'wt')
git(repo, 'worktree', 'add', '-q', '-b', 'T-1/feat/a-2', worktree)
check('worktree без .claude/: задача T-1 видна, git add отклонён', hook('git-guard.mjs', worktree, 'git add -A') === 'deny')
check('коммит в соседний репо через cd — по его состоянию', hook('git-guard.mjs', worktree, `cd ${repo} && git commit -m x`) === 'allow')

const plain = join(root, 'plain')
mkdirSync(plain)
git(plain, 'init', '-q')
check('репо без пайплайна: хуки молчат', hook('git-guard.mjs', plain, 'git add -A') === 'allow' && hook('session-start.mjs', plain) === '')
check('репо без пайплайна: подпись в коммите не наше дело', hook('git-guard.mjs', plain, 'git commit -m "x\n\nCo-Authored-By: X <x@y.z>"') === 'allow')
rmSync(root, { recursive: true, force: true })

// ── гейты 0.12: журнал, запуск субагентов, подписи, задача на два репо ──────
const runHook = (name, input) => {
  const run = spawnSync(process.execPath, [join(PLUGIN, 'hooks', name)], { input: JSON.stringify(input), encoding: 'utf8' })
  if (!run.stdout.trim()) return { decision: 'allow', text: run.stderr }
  if (name === 'session-start.mjs') return { decision: 'message', text: run.stdout }
  const out = JSON.parse(run.stdout)
  return {
    decision: out.hookSpecificOutput?.permissionDecision ?? out.decision ?? 'message',
    text: out.hookSpecificOutput?.permissionDecisionReason ?? out.reason ?? out.systemMessage ?? '',
  }
}
const repoAt = (path, branch) => {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', branch)
  git(path, 'config', 'user.email', 'test@example.com')
  git(path, 'config', 'user.name', 'test')
  write(path, { 'src/a.ts': 'export const a = 1\n', '.gitignore': '.claude/\nmsg.txt\n' })
  git(path, 'add', '-A')
  git(path, 'commit', '-qm', 'base')
}
const gRoot = mkdtempSync(join(tmpdir(), 'gates-test-'))
const app = join(gRoot, 'app')
repoAt(app, 'main')
const OLD = '- `AC-1.1` WHEN старое THEN старое — [verify: devtools-verify] ✅ pro-review по коду'
const journal = (extra = '', force = '') =>
  `# T-7: задача\nВетка: \`T-7/feat/g\`\n\n## Статус: этап 2\n\n${force}## Этапы\n\n### Этап 1: первый  [status: done]\n${OLD}\n${extra}`
const stagesPath = join(app, '.claude/tasks/T-7/STAGES.md')
write(app, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n', '.claude/tasks/T-7/STAGES.md': journal() })
git(app, 'checkout', '-qb', 'T-7/feat/g')
runHook('session-start.mjs', { cwd: app })

const gate = (tool_name, tool_input) => runHook('journal-gate.mjs', { cwd: app, tool_name, tool_input })
check('журнал: старое нарушение — в снимке, хук молчит', gate('Edit', { file_path: stagesPath }).decision === 'allow')
write(app, { '.claude/tasks/T-7/STAGES.md': journal('- `AC-2.1` WHEN новое THEN новое — [verify: devtools-verify] ✅ pro-review по коду\n') })
const caught = gate('Edit', { file_path: stagesPath })
check('журнал: новое «✅ pro-review по коду» у devtools-критерия — возвращено агенту', caught.decision === 'block' && /AC-2\.1/.test(caught.text) && !/AC-1\.1/.test(caught.text), caught.text)
check('журнал: правка через Bash с путём STAGES.md — тоже', gate('Bash', { command: `python3 fix.py ${stagesPath}` }).decision === 'block')
check('журнал: код и команды без журнала — молчит', gate('Edit', { file_path: join(app, 'src/a.ts') }).decision === 'allow' && gate('Bash', { command: 'git status' }).decision === 'allow')
write(app, { '.claude/tasks/T-7/STAGES.md': journal('- `AC-2.1` WHEN новое THEN новое — [verify: devtools-verify] ⏳ devtools-verify\n') })
check('журнал: исправлено на ⏳ — молчит', gate('Edit', { file_path: stagesPath }).decision === 'allow')
const report = join(app, '.claude/tasks/T-7/checks/pro-review-2.md')
write(app, { '.claude/tasks/T-7/checks/pro-review-2.md': '## AC\n2.1 PASS · 2.2 PASS · 2.3 PASS (`a.ts:3`, a=1)\n' })
const bare = gate('Write', { file_path: report })
check('отчёт: голые PASS — возвращены агенту, PASS с замером — нет', bare.decision === 'block' && /AC-2\.1, AC-2\.2/.test(bare.text) && !/AC-2\.3/.test(bare.text), bare.text)

const agentHook = (subagent_type, prompt, model) =>
  runHook('agent-guard.mjs', { cwd: app, tool_name: 'Agent', tool_input: { subagent_type, prompt, ...(model ? { model } : {}) } }).decision
check('whole-branch pro-review без model — отклонён (агент на sonnet)', agentHook('stage-pipeline:pro-review', 'Тикет T-7, режим whole-branch. База origin/main.') === 'deny')
check('whole-branch pro-review на opus — проходит', agentHook('stage-pipeline:pro-review', 'Тикет T-7, whole-branch mode.', 'opus') === 'allow')
check('pro-review этапа — модель не требуется', agentHook('stage-pipeline:pro-review', 'Тикет T-7, режим stage, этап 2. Перепроверка после whole-branch Request changes.') === 'allow')
write(app, { '.claude/pipeline.config.local.md': '- review_model: sonnet\n' })
check('review_model: sonnet в конфиге — whole-branch без model проходит', agentHook('stage-pipeline:pro-review', 'Режим: whole-branch.') === 'allow')
rmSync(join(app, '.claude/pipeline.config.local.md'))
const withForce = (heading, body) => write(app, { '.claude/tasks/T-7/STAGES.md': journal('', `${heading}\n${body}\n\n`) })
withForce('## Force-прогон 2026-10-05', 'Режим: автономный.\nОтветы интервью: ветка — от dev')
check('stage-implement: новый Force-блок без «Подтверждено:» — отклонён', agentHook('stage-pipeline:stage-implement', 'Тикет T-7, этап 2, режим implement') === 'deny')
withForce('## Force-прогон 2026-10-05', 'Режим: автономный.\nОтветы интервью: ветка — от dev\nПодтверждено: 2026-10-05 — «да, гони»')
check('stage-implement: подтверждение есть — проходит', agentHook('stage-pipeline:stage-implement', 'Тикет T-7, этап 2') === 'allow')
withForce('## Force-прогон 2026-09-24', 'Режим: автономный.')
check('stage-implement: блок, открытый до 0.12, — не трогается', agentHook('stage-pipeline:stage-implement', 'Тикет T-7, этап 2') === 'allow')
check('другие агенты — молчит', agentHook('stage-pipeline:devtools-verify', 'whole-branch mode') === 'allow')

withForce('## Force-прогон 2026-10-05', 'Режим: автономный.\nПодтверждено: 2026-10-05 — «да»')
write(app, { 'src/a.ts': 'export const a = 2\n', 'msg.txt': 'T-7: правка\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n' })
const commit = (cwd, command) => runHook('git-guard.mjs', { cwd, tool_input: { command } }).decision
check('force: Co-Authored-By в heredoc сообщения — отклонён', commit(app, `git commit -am "$(cat <<'EOF'\nT-7: правка\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"`) === 'deny')
check('force: подпись в файле -F — отклонён', commit(app, 'git commit -a -F msg.txt') === 'deny')
check('force: чистое сообщение — проходит', commit(app, 'git commit -am "T-7: правка"') === 'allow')
git(app, 'checkout', '-q', '--', 'src/a.ts')
git(app, 'checkout', '-qb', 'hotfix/y')
check('ветка без задачи в репо пайплайна: подпись тоже отклонена', commit(app, 'git commit -m "fix\n\nCo-Authored-By: X <x@y.z>"') === 'deny')

// Задача на два репо: STAGES.md — в каталоге задач app, коммит — в соседнем webapp.
write(app, {
  '.claude/tasks/KC-9/STAGES.md': '# KC-9: задача на два репо\nВетка: `KC-9/feat/x` (app и webapp — одно имя)\n\n## Статус: этап 1\n',
  '.claude/tasks/KC-10/STAGES.md': '# KC-10: только app\nВетка: `KC-10/feat/y`\n\n## Статус: этап 1\n',
  '.claude/tasks/OPS/STAGES.md': '# OPS: без PR-флоу\nВетка: master (коммиты по этапам)\n\n## Статус: этап 1\n',
})
runHook('session-start.mjs', { cwd: app })
const web = join(gRoot, 'webapp')
repoAt(web, 'master')
write(web, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n' })
git(web, 'checkout', '-qb', 'KC-9/feat/x')
check('соседний репо: задача из реестра — обычный режим, git add отклонён', commit(web, 'git add -A') === 'deny')
check('соседний репо: session-start показывает задачу и путь к ней', /KC-9 \(ветка KC-9\/feat\/x\)/.test(runHook('session-start.mjs', { cwd: web }).text))
git(web, 'checkout', '-q', 'master')
check('соседний репо на master: «Ветка: master» чужой задачи его не захватывает', commit(web, 'git add -A') === 'allow')
git(web, 'checkout', '-qb', 'KC-10/feat/y')
check('соседний репо: тикет в ветке, но STAGES.md репо не называет — не своя', commit(web, 'git add -A') === 'allow')

// Работа после закрытия force: коммит на ветке задачи, которого журнал не знает.
git(app, 'checkout', '-q', 'T-7/feat/g')
withForce('## Force-прогон 2026-10-05 — завершён 2026-10-05', 'Режим: автономный.')
write(app, { 'src/b.ts': 'export const b = 1\n' })
git(app, 'add', 'src/b.ts')
git(app, 'commit', '-qm', 'T-7: правка после прогона без этапа')
const after = runHook('session-start.mjs', { cwd: app }).text
check('session-start: коммит после force мимо журнала — назван', /на ветке 1 коммит/.test(after) && /правка после прогона/.test(after), after)
write(app, { '.claude/tasks/T-7/STAGES.md': journal('- 2026-10-05 — догон: `T-7: правка после прогона без этапа`, pro-review Approve\n', '## Force-прогон 2026-10-05 — завершён 2026-10-05\n\n') })
check('session-start: коммит записан в журнал — молчит', !/коммит\(ов\)/.test(runHook('session-start.mjs', { cwd: app }).text))
// main_branch: main в конфиге, а PR идут в dev: смёржённые туда чужие PR — не работа задачи.
git(app, 'checkout', '-q', 'main')
git(app, 'checkout', '-qb', 'dev')
write(app, { 'src/c.ts': 'export const c = 1\n' })
git(app, 'add', 'src/c.ts')
git(app, 'commit', '-qm', 'Feat: чужая фича (#12)')
git(app, 'checkout', '-qb', 'T-8/feat/h')
write(app, {
  'src/d.ts': 'export const d = 1\n',
  '.claude/tasks/T-8/STAGES.md': '# T-8: задача\nВетка: `T-8/feat/h`\n\n## Статус: done\n\n## Force-прогон 2026-10-05 — завершён 2026-10-05\n',
})
git(app, 'add', 'src/d.ts')
git(app, 'commit', '-qm', 'T-8: своя правка мимо журнала')
const nearest = runHook('session-start.mjs', { cwd: app }).text
check('session-start: база — ближайшая интеграционная ветка, чужой PR не в счёт', /на ветке 1 коммит/.test(nearest) && !/чужая фича/.test(nearest), nearest)
rmSync(gRoot, { recursive: true, force: true })

// ── 0.13: force не ждёт подтверждений ────────────────────────────────────────
const { askMatch, bashRulePattern, nameKill } = await import(join(PLUGIN, 'hooks/permission-rules.mjs'))
const KILLS = [
  ['pkill -f "http.server 3199"; cd /repo; node floor-guard.mjs', 'pkill -f http.server 3199'],
  ["pkill -f 'scratchpad/stub.js'; lsof -ti :4010 | xargs -r kill", 'pkill -f scratchpad/stub.js'],
  ['/usr/bin/killall node', '/usr/bin/killall node'],
  ['pgrep -f stub | xargs pkill', 'xargs pkill'],
  ['FOO=1 nohup pkill -f x', 'pkill -f x'],
  ['kill 12345', null],
  ['lsof -ti :4010 | xargs -r kill', null],
  ['echo "pkill later"', null],
  ['grep -rn pkill plugins/', null],
  ["cat <<'EOF' > notes.md\npkill -f x\nEOF", null],
]
for (const [command, want] of KILLS) check(`снятие по имени ${JSON.stringify(command).slice(0, 50)} → ${want}`, nameKill(command) === want, `получили ${nameKill(command)}`)

const RULES = ['Bash(git push *)', 'Bash(git reset --hard *)', 'Bash(gh *)', 'Bash(npm run deploy:*)', 'Bash(ls)', 'Bash', 'Bash(*)'].map((rule) => ({ rule, source: 'settings.json' }))
const ASKS = [
  ['git push origin HEAD', 'Bash(git push *)'],
  ['git push', 'Bash(git push *)'],
  ['git status && git push -u origin x', 'Bash(git push *)'],
  ['cd app && GIT_TRACE=1 git reset --hard HEAD~1', 'Bash(git reset --hard *)'],
  ['gh pr view 12', 'Bash(gh *)'],
  ['npm run deploy -- --prod', 'Bash(npm run deploy:*)'],
  ['npm run deployment', null],
  ['ls', 'Bash(ls)'],
  ['ls -la', null],
  ['ghost --help', null],
  ['git commit -m "потом git push"', null],
  ['git pushx', null],
  ['echo ok', null],
]
for (const [command, want] of ASKS) {
  const got = askMatch(command, RULES)?.rule ?? null
  check(`ask ${JSON.stringify(command).slice(0, 50)} → ${want}`, got === want, `получили ${got}`)
}
check('ask: голое Bash и Bash(*) не превращаются в «отклонять всё»', bashRulePattern('Bash') === null && bashRulePattern('Bash(*)') === null)

const fRoot = mkdtempSync(join(tmpdir(), 'force-guard-test-'))
const fApp = join(fRoot, 'app')
const fHome = join(fRoot, 'home')
repoAt(fApp, 'main')
write(fHome, { '.claude/settings.json': JSON.stringify({ permissions: { ask: ['Bash(pkill *)', 'Bash(git push *)'] } }) })
write(fApp, {
  '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n',
  '.claude/settings.json': JSON.stringify({ permissions: { ask: ['Bash(gh *)'] } }),
  '.claude/tasks/T-9/STAGES.md': stages('T-9', 'T-9/feat/f', { force: '## Force-прогон 2026-10-03\nПодтверждено: 03.10.2026 — да\n\n' }),
  '.claude/tasks/T-10/STAGES.md': stages('T-10', 'T-10/feat/n'),
})
const force = (cwd, command) => {
  const run = spawnSync(process.execPath, [join(PLUGIN, 'hooks/force-guard.mjs')], {
    input: JSON.stringify({ cwd, tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, HOME: fHome, CLAUDE_PROJECT_DIR: fApp },
  })
  if (!run.stdout.trim()) return { decision: 'allow', text: run.stderr }
  const out = JSON.parse(run.stdout).hookSpecificOutput
  return { decision: out.permissionDecision, text: out.permissionDecisionReason }
}
git(fApp, 'checkout', '-qb', 'T-9/feat/f')
const killed = force(fApp, 'pkill -f "http.server 3199"; git status')
check('force: pkill отклонён сразу, с подсказкой про PID', killed.decision === 'deny' && /kill <PID>/.test(killed.text), killed.text)
check('force: killall без ask-правила — тоже отклонён', force(fApp, 'killall node').decision === 'deny')
check('force: kill по PID проходит', force(fApp, 'kill 4242').decision === 'allow')
const pushed = force(fApp, 'git push -u origin T-9/feat/f')
check('force: git push под ask пользователя — отклонён, назван файл правила', pushed.decision === 'deny' && pushed.text.includes(join(fHome, '.claude/settings.json')), pushed.text)
check('force: gh под ask проекта — отклонён', /Блокер/.test(force(join(fApp, 'src'), 'gh pr view 1').text))
check('force: обычные команды не трогаются', force(fApp, 'git status && pnpm test').decision === 'allow')
git(fApp, 'checkout', '-qb', 'T-10/feat/n')
check('обычный режим: pkill не отклоняется — пользователь рядом и ответит сам', force(fApp, 'pkill -f x').decision === 'allow')
git(fApp, 'checkout', '-q', 'main')
check('ветка без задачи: хук молчит', force(fApp, 'git push').decision === 'allow')
write(fApp, { '.claude/tasks/T-9/STAGES.md': stages('T-9', 'T-9/feat/f', { force: '## Force-прогон 2026-10-03 — завершён с блокерами 2026-10-03\n\n' }) })
git(fApp, 'checkout', '-q', 'T-9/feat/f')
check('force «завершён с блокерами» — закрыт, хук молчит', force(fApp, 'pkill -f x').decision === 'allow')
rmSync(fRoot, { recursive: true, force: true })

// ── тяжёлые проверки: охват по дифу и очередь на машину ─────────────────────
const RUN_CHECK = join(PLUGIN, 'run-check.mjs')
const rcRoot = mkdtempSync(join(tmpdir(), 'run-check-test-'))
const rcRepo = join(rcRoot, 'repo')
mkdirSync(rcRepo)
git(rcRepo, 'init', '-q', '-b', 'main')
git(rcRepo, 'config', 'user.email', 'test@example.com')
git(rcRepo, 'config', 'user.name', 'test')
write(rcRepo, { 'src/a.ts': 'export const a = 1\n', 'src/b.ts': 'export const b = 1\n', 'README.md': '# x\n' })
git(rcRepo, 'add', '-A')
git(rcRepo, 'commit', '-qm', 'base')
write(rcRepo, { 'src/a.ts': 'export const a = 2\n', 'src/new card.vue': '<template />\n', 'notes.md': 'x\n', 'node_modules/x/index.js': 'x\n' })
const locks = join(rcRoot, 'locks')
const rc = (args, env = {}) =>
  spawnSync(process.execPath, [RUN_CHECK, ...args], { cwd: rcRepo, encoding: 'utf8', env: { ...process.env, STAGE_PIPELINE_LOCK_DIR: locks, ...env } })
const listed = rc(['--', `printf '%s|' {files}`])
check('run-check: {files} — изменённые и новые файлы кода, без md и node_modules', listed.status === 0 && /src\/a\.ts\|/.test(listed.stdout) && /new card\.vue\|/.test(listed.stdout) && !/b\.ts|notes\.md|node_modules/.test(listed.stdout), listed.stdout)
const vueOnly = rc(['--', `printf '%s|' {files:vue}`])
check('run-check: {files:vue} — только это расширение', /new card\.vue/.test(vueOnly.stdout) && !/a\.ts/.test(vueOnly.stdout), vueOnly.stdout)
const several = spawnSync('/bin/sh', ['-c', `'${process.execPath}' '${RUN_CHECK}' -- printf '%s|' {files:ts+vue}`], { cwd: rcRepo, encoding: 'utf8', env: { ...process.env, STAGE_PIPELINE_LOCK_DIR: locks } })
check('run-check: {files:ts+vue} переживает шелл (запятую он раскрыл бы)', /a\.ts\|/.test(several.stdout) && /new card\.vue\|/.test(several.stdout), several.stdout + several.stderr)
const none = rc(['--', 'false', '{files:py}'])
check('run-check: файлов нет — команда не запускается, код 0', none.status === 0 && /пропущено/.test(none.stdout))
check('run-check: код выхода — код команды', rc(['--', 'exit 3']).status === 3)
check('run-check: git через обёртку не запускается', rc(['--', 'git', 'commit', '-m', 'x']).status === 2 && rc(['--', 'echo x && git push']).status === 2)
check('run-check: режим из resources в конфиге', (() => {
  write(rcRepo, { '.claude/pipeline.config.local.md': '- resources: normal\n' })
  return /^normal/.test(rc(['--mode']).stdout)
})())
const first = spawnSync('/bin/sh', ['-c', `STAGE_PIPELINE_RESOURCES=low STAGE_PIPELINE_LOCK_DIR='${locks}' '${process.execPath}' '${RUN_CHECK}' -- 'sleep 2; date +%s%N' & sleep 0.5; STAGE_PIPELINE_RESOURCES=low STAGE_PIPELINE_LOCK_DIR='${locks}' '${process.execPath}' '${RUN_CHECK}' -- 'date +%s%N'; wait`], { cwd: rcRepo, encoding: 'utf8' })
const stamps = first.stdout.match(/^\d{15,}$/gm) ?? []
check('run-check: в low второй прогон ждёт первый (очередь на машину)', /жду очереди/.test(first.stdout) && stamps.length === 2 && Number(stamps[1]) >= Number(stamps[0]), first.stdout)
mkdirSync(join(locks, 'heavy.lock'), { recursive: true })
writeFileSync(join(locks, 'heavy.lock', 'owner.json'), JSON.stringify({ pid: 999999, repo: 'x', command: 'y', started: Date.now() }))
const stale = rc(['--', 'echo ok'], { STAGE_PIPELINE_RESOURCES: 'low' })
check('run-check: лок умершего процесса забирается', stale.status === 0 && /ok/.test(stale.stdout) && !/жду/.test(stale.stdout), stale.stdout)
rmSync(rcRoot, { recursive: true, force: true })

// ── архивация STAGES.md ──────────────────────────────────────────────────────
const entries = Array.from({ length: 10 }, (_, i) => `- **${String(22 - i).padStart(2, '0')}.08.2026** — запись ${22 - i}\n  подробности ${22 - i}`)
const source = [
  '# T: задача',
  'Ветка: `T/feat/x`',
  '',
  '## Статус: этап 3',
  '',
  '## Force-прогон 2026-08-20',
  '### Этап 9: догон внутри force  [status: done]',
  ...Array.from({ length: 30 }, (_, i) => `подробность догона ${i}`),
  '',
  '## Этапы',
  '',
  '### Этап 1: первый  [status: done]',
  'Решения: взяли общий форматтер',
  '- [x] commit: `T: форматтер`',
  '- [ ] user-review',
  '- `AC-1.2` ⏳ user-review',
  ...Array.from({ length: 40 }, (_, i) => `длинная подробность этапа ${i} — ${'x'.repeat(40)}`),
  '',
  '### Этап 2: второй  [status: in-progress]',
  'в работе',
  '',
  '## ⚠ Ожидают подтверждения пользователя',
  '- дефолт сортировки',
  '',
  '## Журнал (новые сверху)',
  '',
  ...entries.slice(0, 5),
  '### Этап 1 — ход',
  'Вводный абзац группы.',
  ...entries.slice(5),
  '',
].join('\n')
const plan = planArchive(source)
check('архивация: done-этап свёрнут, этап в работе и force-блок не тронуты', same(plan.moved.map((m) => m.heading), ['### Этап 1: первый  [status: done]']))
check('архивация: незакрытое и решения остались в свёрнутом этапе', ['Решения: взяли', '- [x] commit:', '- [ ] user-review', '⏳ user-review'].every((s) => plan.result.includes(s)))
check('архивация: даты DD.MM.YYYY — остались 8 свежих', plan.movedJournal.length === 2 && plan.result.includes('запись 22') && !plan.result.includes('запись 13'))
check('архивация: подзаголовок журнала на месте, пока в группе есть записи', plan.result.includes('### Этап 1 — ход'))
check('архивация: размер в байтах', plan.sourceBytes === Buffer.byteLength(source))
const lost = source.split('\n').filter((line) => line.trim() && !plan.result.includes(line) && !plan.moved.some((m) => m.text.includes(line)) && !plan.movedJournal.some((e) => e.lines.includes(line)))
check('архивация: ни одна строка не потеряна', !lost.length, JSON.stringify(lost.slice(0, 2)))
const second = planArchive(plan.result)
check('архивация идемпотентна', !second.moved.length && !second.movedJournal.length)

// ── ретро ────────────────────────────────────────────────────────────────────
const retroRoot = mkdtempSync(join(tmpdir(), 'retro-test-'))
write(retroRoot, {
  'T/STAGES.md': [
    '# T: задача',
    '## Этапы',
    '### Этап 1: первый  [status: done]',
    '### Этап 2: второй  [status: done]',
    '### Этап 2.1: догон  [status: done]',
    '## Журнал',
    '### Этап 1 — ход',
    '- 2026-09-20 — этап 1 закрыт',
    '  metrics: checkers=pro-review skipped=dead-code findings=2 dropped=0 iterations=1 fresh=no escalations=0 floor=0 diff=+120/-10',
    '- 2026-09-21 — закрыт',
    '  metrics: stage=2 checkers=pro-review findings=5 dropped=1 iterations=2 fresh=yes escalations=0 floor=1 diff=+640/-900',
    '- 2026-09-22 — этап 2.1 закрыт',
    '  metrics: checkers=pro-review findings=7 dropped=0 iterations=0 fresh=no escalations=1 floor=0 diff=—',
    '',
  ].join('\n'),
  'T/checks/deps-2.md': '',
  'T/checks/pro-review-1.md': '',
})
const retro = spawnSync(process.execPath, [join(PLUGIN, 'retro.mjs'), retroRoot], { encoding: 'utf8' })
check('ретро: не падает на diff=—', retro.status === 0, retro.stderr.trim())
check('ретро: metrics из журнала разнесены по этапам, 2.1 — отдельный этап', /этапов: 3, этапов со строкой metrics: 3/.test(retro.stdout), retro.stdout.split('\n')[2])
check('ретро: находки просуммированы по всем этапам', /находок всего: 14/.test(retro.stdout))
check('ретро: размер по добавленным строкам', /\| ≤300 \| 1 \|/.test(retro.stdout) && /\| 301–1000 \| 1 \|/.test(retro.stdout))
check('ретро: старое имя отчёта deps-2.md засчитано', /\| deps-audit \| 0 \| 0 \| 1 \|/.test(retro.stdout))
rmSync(retroRoot, { recursive: true, force: true })

process.exit(failed ? 1 : 0)
