#!/usr/bin/env node
/**
 * Самопроверка хуков и скриптов состояния — детерминированно, без модели, гоняется в CI.
 * Фикстуры — формы, которые реально встречаются в живых STAGES.md и конфигах: путь задач в бэктиках
 * и с `~`, «Ветка: … отведена от …», статусы `in-progress — …`, даты `22.08.2026`, подзаголовки
 * в журнале. Хук, который молча перестал видеть свою задачу, хуже отсутствующего: он выдаёт зелёный,
 * а хук, который видит чужие задачи, блокирует параллельную работу.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
const { closedForceDate, taskLanguage, readPipelineState } = await import(join(PLUGIN, 'hooks/pipeline-state.mjs'))
const markers = await import(join(PLUGIN, 'markers.mjs'))
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

// ── английские близнецы маркеров: тот же результат, что на русском ──────────────
const EN_HEADERS = [
  ['Branch: `T-4/feat/app` · App: `apps/expert` · Contexts: desktop', ['T-4/feat/app']],
  ['Branch: redesign-2.0  Contexts: mobile + desktop', ['redesign-2.0']],
  ['Branch: TBD, base — `redesign-2.0` (decision 2026-08-04)', []],
  ['Branch: none', []],
  ['Branch: n/a', []],
  ['Figma: — (logic-only)  Branch: master (no PR flow, commits per stage)  Contexts: owner', ['master']],
  ['Branches: `T-5/feat/a` cut from `dev`', ['T-5/feat/a']],
  ['Branch: T-5/feat/b branched from dev', ['T-5/feat/b']],
  ['Branch: T-5/feat/c rebased onto dev', ['T-5/feat/c']],
  ['Branch: T-5/feat/d → PR into dev', ['T-5/feat/d']],
]
for (const [line, want] of EN_HEADERS) {
  const got = taskBranches(`# T: task\n${line}\nUpdated: 2026-09-01\n\n## Status: stage 1\n\nBranch: \`not-a-header\`\n`)
  check(`EN header ${JSON.stringify(line).slice(0, 60)}`, same(got, want), `got ${JSON.stringify(got)}`)
}
check('EN open Force run block', forceActive('## Force run 2026-09-01\nMode: …'))
check('EN closed Force run block', !forceActive('## Force run 2026-09-01 — completed 2026-09-02\nMode: …'))
check('EN closed with blockers', !forceActive('## Force run 2026-09-01 — completed with blockers 2026-09-02\nMode: …'))
check('EN status closes the run', !forceActive('## Status: 5 of 5 stages done — force run completed, waiting for push\n\n## Force run 2026-09-01\n'))
check('EN status with a date between the words', !forceActive('## Status: force run 2026-09-23 completed — three commits\n\n## Force run 2026-09-23\n'))
check('EN "force run not completed" keeps the run open', forceActive('## Status: force run not completed, stage 7 in progress\n\n## Force run 2026-09-01\n'))
check('EN all stages done, final checks — run is open', forceActive('## Status: all stages done, final checks\n\n## Force run 2026-09-01\n\n### Stage 1: x  [status: done]\n'))
check('EN open Force block: date from the heading, text up to the next section', (() => {
  const block = openForceBlock('## Force run 28.09.2026 — completed 28.09.2026\nold\n\n## Force run 2026-10-05b (second)\nInterview answers: …\n\n## Stages\n')
  return block?.date === '2026-10-05' && block.body.includes('Interview answers') && !block.body.includes('Stages')
})())
const CLOSE_DATES = [
  ['## Force-прогон 2026-10-05 — завершён 2026-10-06\n', '## Force run 2026-10-05 — completed 2026-10-06\n'],
  ['## Статус: force-прогон 2026-10-05 завершён 06.10.2026\n\n## Force-прогон 2026-10-05\n', '## Status: force run 2026-10-05 completed 06.10.2026\n\n## Force run 2026-10-05\n'],
  ['## Force-прогон 2026-10-05\n', '## Force run 2026-10-05\n'],
]
for (const [ru, en] of CLOSE_DATES) check(`closing date ${JSON.stringify(en).slice(0, 50)} — same as the Russian twin`, closedForceDate(en) === closedForceDate(ru) && (closedForceDate(ru) !== null || !/completed/.test(en)), `${closedForceDate(ru)} / ${closedForceDate(en)}`)
check('closing date: EN heading gives the date', closedForceDate('## Force run 2026-10-05 — completed 2026-10-06\n') === '2026-10-06')
const LANGS = [
  ['# T: задача\nFigma: x  Ветка: `x`  Language: en  Контексты: web\n\n## Журнал\n', 'en'],
  ['# T: task\nFigma: x  Branch: `x`  Язык: ru  Contexts: web\n\n## Journal\n', 'ru'],
  ['# T: task\nFigma: x · Language: en\n\n## Журнал\n', 'en'],
  ['# T: task\nBranch: `x`\n\n## Журнал\n\nThe Language: en option is documented elsewhere.\n', 'ru'],
  ['# T: задача\nЯзык: ru\nВетка: `x`\n\n## Journal\n', 'ru'],
  ['# T: task\nLanguage: en\nBranch: `x`\n\n## Журнал\n', 'en'],
  ['# T: task\n- **Language:** en\n\n## Stages\n', 'en'],
  ['# T: задача\nВетка: `x`\n\n## Статус: этап 1\n\n## Этапы\n\n### Этап 1: первый\n\n## Журнал\n', 'ru'],
  ['# T: task\nBranch: `x`\n\n## Status: stage 1\n\n## Stages\n\n### Stage 1: first\n\n## Journal\n', 'en'],
  ['# T: task\n\n## Force run 2026-10-05\n\n### Stage 1: first\n', 'en'],
  ['# T: задача\n\n## Force-прогон 2026-10-05\n\n### Этап 1: первый\n', 'ru'],
  ['# T: no headings at all\nBranch: `x`\n', null],
  ['# T\n\n## Force run 2026-10-05\n', null],
  ['', null],
]
for (const [text, want] of LANGS) check(`task language ${JSON.stringify(text).slice(0, 56)} → ${want}`, taskLanguage(text) === want, String(taskLanguage(text)))
check('markers: Parity — prose is not a table', ['the prototype parity pass', 'see parity.mjs', 'feature parity with the kit'].every((line) => !markers.PARITY_TABLE.test(line)))
check('markers: Parity — field, heading, table cell', ['Parity: moved', '- **Parity:** moved', '### Parity', '| Parity | x |'].every((line) => markers.PARITY_TABLE.test(line)))
check('markers: stage mention needs a word boundary', !markers.STAGE_MENTION.test('backstage 2 of the show') && markers.STAGE_MENTION.test('Stage 2 done') && markers.STAGE_MENTION.test('этап 2'))
check('markers: Parity table — the word, not the ds-parity skill name', markers.PARITY_TABLE.test('| Parity | was `Old` |') && markers.PARITY_TABLE.test('| Паритет | было |') && !markers.PARITY_TABLE.test('- [x] ds-parity (checks/ds-parity-1.md)'))

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
check('session-start: задача текущей ветки первой', /^- T-1 \(branch T-1\/feat\/a\)/m.test(hook('session-start.mjs', repo)))

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
    text: out.hookSpecificOutput?.permissionDecisionReason ?? out.reason ?? out.systemMessage ?? out.hookSpecificOutput?.additionalContext ?? '',
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
const unconfirmed = runHook('agent-guard.mjs', { cwd: app, tool_name: 'Agent', tool_input: { subagent_type: 'stage-pipeline:stage-implement', prompt: 'Тикет T-7, этап 2' } }).text
check('stage-implement: отказ не требует второго «да» после интервью', /interview answers/.test(unconfirmed) && /Do not ask the user for a separate confirmation/.test(unconfirmed), unconfirmed)
withForce('## Force-прогон 2026-10-05', 'Режим: автономный.\nОтветы интервью: ветка — от dev\nПодтверждено: 2026-10-05 — «да, гони»')
check('stage-implement: подтверждение есть — проходит', agentHook('stage-pipeline:stage-implement', 'Тикет T-7, этап 2') === 'allow')
withForce('## Force-прогон 2026-09-24', 'Режим: автономный.')
check('stage-implement: блок, открытый до 0.12, — не трогается', agentHook('stage-pipeline:stage-implement', 'Тикет T-7, этап 2') === 'allow')
check('другие агенты — молчит', agentHook('stage-pipeline:devtools-verify', 'whole-branch mode') === 'allow')
withForce('## Force run 2026-10-05', 'Mode: autonomous.\nInterview answers: branch — from dev')
check('EN stage-implement: new Force block without "Confirmed:" — denied', agentHook('stage-pipeline:stage-implement', 'Ticket T-7, stage 2, implement mode') === 'deny')
withForce('## Force run 2026-10-05', 'Mode: autonomous.\nInterview answers: branch — from dev\nConfirmed: 2026-10-05 — "yes, go"')
check('EN stage-implement: "Confirmed:" is there — passes', agentHook('stage-pipeline:stage-implement', 'Ticket T-7, stage 2') === 'allow')
withForce('## Force run 2026-10-05', 'Mode: autonomous.\n- **Confirmed**: 2026-10-05 — "yes"')
check('EN stage-implement: bold "**Confirmed**:" bullet — passes', agentHook('stage-pipeline:stage-implement', 'Ticket T-7, stage 2') === 'allow')
withForce('## Force run 2026-10-05 — completed 2026-10-05', 'Mode: autonomous.')
check('EN stage-implement: closed block is not an open run — passes', agentHook('stage-pipeline:stage-implement', 'Ticket T-7, stage 2') === 'allow')
check('EN whole-branch pro-review: "Mode: whole-branch" without model — denied', agentHook('stage-pipeline:pro-review', 'Ticket T-7, Mode: whole-branch.') === 'deny')

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
check('соседний репо: session-start показывает задачу и путь к ней', /KC-9 \(branch KC-9\/feat\/x\)/.test(runHook('session-start.mjs', { cwd: web }).text))
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
check('session-start: коммит после force мимо журнала — назван', /commits on the task's branches that are in neither STAGES\.md nor PR\.md \(1\)/.test(after) && /правка после прогона/.test(after), after)
write(app, { '.claude/tasks/T-7/STAGES.md': journal('- 2026-10-05 — догон: `T-7: правка после прогона без этапа`, pro-review Approve\n', '## Force-прогон 2026-10-05 — завершён 2026-10-05\n\n') })
check('session-start: коммит записан в журнал — молчит', !/мимо журнала|нет ни в STAGES/.test(runHook('session-start.mjs', { cwd: app }).text))
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
check('session-start: база — ближайшая интеграционная ветка, чужой PR не в счёт', /commits on the task's branches that are in neither STAGES\.md nor PR\.md \(1\)/.test(nearest) && !/чужая фича/.test(nearest), nearest)
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
check('force: gh под ask проекта — отклонён', /blocker/.test(force(join(fApp, 'src'), 'gh pr view 1').text))
check('force: обычные команды не трогаются', force(fApp, 'git status && pnpm test').decision === 'allow')
git(fApp, 'checkout', '-qb', 'T-10/feat/n')
check('обычный режим: pkill не отклоняется — пользователь рядом и ответит сам', force(fApp, 'pkill -f x').decision === 'allow')
git(fApp, 'checkout', '-q', 'main')
check('ветка без задачи: хук молчит', force(fApp, 'git push').decision === 'allow')
write(fApp, { '.claude/tasks/T-9/STAGES.md': stages('T-9', 'T-9/feat/f', { force: '## Force-прогон 2026-10-03 — завершён с блокерами 2026-10-03\n\n' }) })
git(fApp, 'checkout', '-q', 'T-9/feat/f')
check('force «завершён с блокерами» — закрыт, хук молчит', force(fApp, 'pkill -f x').decision === 'allow')
rmSync(fRoot, { recursive: true, force: true })

// ── 0.14: итог находок, непроверенное, кадры ─────────────────────────────────
const jc = await import(join(PLUGIN, 'journal-check.mjs'))
const COUNTS = [
  ['# pro-review\nНаходки: critical 1 · major 2 · minor 3\n', 'pro-review-1.md', [1, 2, 3]],
  ['# figma\nВердикт: 3 расхождения (0 critical / 2 major / 1 minor-spec-note).\n', 'figma-compare-2.md', [0, 2, 1]],
  ['# pro\nИтог: 🔴0 · 🟠2 · 🟡3 · ⚪2. Отброшено при перепроверке: 6.\n', 'stage-8-pro-review.md', [0, 2, 3]],
  ['# pro\n## Сводка\n- 🔴 Critical: 0\n- 🟠 Major: 1\n', 'pro-review-7a.md', [0, 1, 0]],
  ['# devtools\n1 critical / 0 major / 0 minor. Shutter crashes on open\n', 'devtools-verify-1.md', [1, 0, 0]],
  ['# figma\nВердикт: PASS\n- кегль/вес — text-xs 12 / font-medium 500 / leading-4 16\n', 'stage-3-figma-compare.md', [0, 0, 0]],
  ['# dead\nИтог: 1 удалить / 2 под вопросом.\n', 'final-dead-code.md', [0, 1, 0]],
  ['# dead\nVerdict: 1 to remove / 2 uncertain.\n', 'final-dead-code.md', [0, 1, 0]],
  ['# dead\nVerdict: 1 remove / 2 uncertain.\n', 'final-dead-code.md', [0, 1, 0]],
  ['# sec\n## Итог\n| M1 | medium | ПДн в localStorage |\n| M2 | medium | стенд в проде |\n', 'final-security-review.md', [0, 2, 0]],
  ['# dead\n| 1 | `X` | a.ts:83 | high |\n', 'dead-code-final.md', [0, 0, 0]],
  ['# pro\nВердикт: Request changes (2 major).\n', 'stage-4-pro-review.md', [0, 2, 0]],
]
for (const [text, name, want] of COUNTS) {
  const got = jc.findingCounts(text, name)
  check(`сводка ${name}: critical/major/minor ${want}`, same([got.critical, got.major, got.minor], want), JSON.stringify(got))
}
check('FAIL по критерию — находка, «было FAIL» — нет', same(jc.failedCriteria('- `AC-2.1` - FAIL по 2 major\n- AC-3.1 — PASS (было FAIL)\n'), ['AC-2.1']))
const DISPOSITIONS = [
  ['- M-1 — исправлено: use-express-form.ts:104, перепроверено', 'fixed'],
  ['- #2 — ложная: 109×32 — нативный размер svg', 'false'],
  ['- AC-5.9 — B1', 'blocker'],
  ['- M-1 — принят как компромисс, см. «Ожидают подтверждения»', 'parked'],
  ['- #3 — давний, не находка', 'unproven'],
  ['- #3 — давний: на базе 422729d0 то же самое (замер 1037)', 'false'],
  ['- #4 — вопрос дизайнеру', 'parked'],
  ['- #5 — решение пользователя 04.10.2026: оставить 109', 'user'],
  ['- #6 — посмотрим', 'unknown'],
]
for (const [entry, want] of DISPOSITIONS) check(`итог «${entry.slice(2, 40)}» → ${want}`, jc.disposition(entry) === want, jc.disposition(entry))
const REVIEW = '# pro-review, этап 1\nНаходки: critical 0 · major 2 · minor 0\n\n### 🟠 M-1 a.ts:1 — дубль\n### 🟠 M-2 b.ts:2 — гонка\n'
const missing = jc.ledgerViolations(REVIEW, 'pro-review-1.md', { complete: true })
check('итог: две major без строк — ledger-missing', missing.length === 1 && missing[0].rule === 'ledger-missing', JSON.stringify(missing))
check('итог: одна строка на две major — всё ещё неполный', jc.ledgerViolations(`${REVIEW}\n## Итог находок\n- M-1 — исправлено: a.ts:3\n`, 'pro-review-1.md', { complete: true }).length === 1)
check('итог: обе закрыты — чисто', jc.ledgerViolations(`${REVIEW}\n## Итог находок\n- M-1 — исправлено: a.ts:3\n- M-2 — B1\n`, 'pro-review-1.md', { complete: true }).length === 0)
check('итог: «оставляю» — ledger-parked даже без полноты', jc.ledgerViolations(`${REVIEW}\n## Итог находок\n- M-1 — оставляю, minor по сути\n`, 'pro-review-1.md')[0]?.rule === 'ledger-parked')
check('✅ с оговоркой — ac-caveat', jc.caveatViolation('- `AC-2.7` WHEN тема THEN ок — [verify: devtools-verify] ✅ devtools-verify (тёмная тема выпадашек не снята)')?.rule === 'ac-caveat')
check('✅ и явный ⏳ на непроверенное — не оговорка', jc.caveatViolation('- `AC-2.7` — ✅ devtools-verify (light) · ⏳ devtools-verify (dark не снят)') === null)
check('[live] из-за «нет броней» — live-no-data', jc.noDataViolation('- `AC-4.5` WHEN бар THEN статус — [live: user-side] — нет броней с police на аккаунте')?.rule === 'live-no-data')
check('[live] с подставленной фикстурой — не нарушение', jc.noDataViolation('- `AC-4.5` — ⏳ нет броней на стенде, проверено на подменённом ответе (фикстура)') === null)
check('devtools без строк geometry — no-geometry', jc.runtimeViolations('# devtools\nНаходки: critical 0 · major 0 · minor 0\n', 'devtools-verify-3.md')[0]?.rule === 'no-geometry')
check(
  'devtools с geometry и «нет данных» в непроверенном — live-no-data',
  same(jc.runtimeViolations('# d\nНаходки: critical 0 · major 0 · minor 0\ngeometry 1440: overflow 0 · zero-gap 0 · clipped 0\n## Не удалось проверить\n- AC-3.2 — нет данных на стенде\n', 'stage-3-devtools-verify.md').map((v) => v.rule), ['live-no-data']),
)
check('devtools skip — геометрии не требует', jc.runtimeViolations('# devtools-verify\nskip: MCP недоступен\n', 'devtools-verify-2.md').length === 0)
check('отчёт чекера без сводки — report-summary', jc.summaryViolation('# i18n\nВердикт: 3 дефекта\n', 'i18n-sweep-2.md')?.rule === 'report-summary')
check('не отчёт чекера (проба стенда) — сводка не нужна', jc.summaryViolation('# probe\n', 'stand-probe-2026-10-03.md') === null)
const REVIEW_EN = '# pro-review, stage 1\nFindings: critical 0 · major 2 · minor 0\n\n### 🟠 M-1 a.ts:1 — duplicate\n### 🟠 M-2 b.ts:2 — race\n'
const missingEn = jc.ledgerViolations(REVIEW_EN, 'pro-review-1.md', { complete: true })
check('EN findings outcome: two major without lines — ledger-missing', missingEn.length === 1 && missingEn[0].rule === 'ledger-missing', JSON.stringify(missingEn))
check('EN findings outcome: one line for two major — still incomplete', jc.ledgerViolations(`${REVIEW_EN}\n## Findings outcome\n- M-1 — fixed: a.ts:3\n`, 'pro-review-1.md', { complete: true }).length === 1)
check('EN findings outcome: both closed — clean', jc.ledgerViolations(`${REVIEW_EN}\n## Findings outcome\n- M-1 — fixed: a.ts:3\n- M-2 — B1\n`, 'pro-review-1.md', { complete: true }).length === 0)
check('EN findings outcome: heading level ### is read too', jc.ledgerViolations(`${REVIEW_EN}\n### Findings outcome\n- M-1 — fixed: a.ts:3\n- M-2 — fixed: b.ts:4\n`, 'pro-review-1.md', { complete: true }).length === 0)
check('EN findings outcome: entries are read from the section', same(jc.ledgerEntries(`${REVIEW_EN}\n## Findings outcome\n- M-1 — fixed: a.ts:3\n- M-2 — B1\n\n## Next\n- other\n`), ['- M-1 — fixed: a.ts:3', '- M-2 — B1']))
check('EN summary line: counts are read', same(jc.findingCounts(REVIEW_EN, 'pro-review-1.md'), { critical: 0, major: 2, minor: 0, summary: true }), JSON.stringify(jc.findingCounts(REVIEW_EN, 'pro-review-1.md')))
check('EN checker report without a summary — report-summary', jc.summaryViolation('# i18n\nVerdict: 3 defects\n', 'i18n-sweep-2.md')?.rule === 'report-summary')
check('EN checker report with "Findings: critical N · major N" — clean', jc.summaryViolation('# i18n\nFindings: critical 0 · major 1 · minor 0\n', 'i18n-sweep-2.md') === null)
check('RU checker report with «Находки: critical N · major N» — clean', jc.summaryViolation('# i18n\nНаходки: critical 0 · major 1 · minor 0\n', 'i18n-sweep-2.md') === null)
check(
  'EN devtools: "Could not verify" with "no data" — live-no-data',
  same(jc.runtimeViolations('# d\nFindings: critical 0 · major 0 · minor 0\ngeometry 1440: overflow 0 · zero-gap 0 · clipped 0\n## Could not verify\n- AC-3.2 — no data on the stand\n', 'stage-3-devtools-verify.md').map((v) => v.rule), ['live-no-data']),
)
check(
  'EN devtools: "Could not verify" with a stubbed state — clean',
  jc.runtimeViolations('# d\nFindings: critical 0 · major 0 · minor 0\ngeometry 1440: overflow 0 · zero-gap 0 · clipped 0\n## Could not verify\n- AC-3.2 — no data, checked with a stubbed API response\n', 'stage-3-devtools-verify.md').length === 0,
)
const stageRef = (stages) => {
  const dir = mkdtempSync(join(tmpdir(), 'stageref-'))
  writeFileSync(join(dir, 'STAGES.md'), stages)
  const got = ['stage-3-devtools-verify.md', 'этап-3-devtools-verify.md', 'devtools-verify-3.md'].map((name) => jc.stageReference(dir, name))
  rmSync(dir, { recursive: true, force: true })
  return got
}
const REF_RU = '# T\n\n### Этап 2: x\nЭталон вида: `a.tsx`\n\n### Этап 3: карточка\nЭталон вида: `src/Other.tsx:12` — соседняя секция\nКритерии:\n'
const REF_EN = '# T\n\n### Stage 2: x\nVisual reference: `a.tsx`\n\n### Stage 3: card\nVisual reference: `src/Other.tsx:12` — neighbouring section\nCriteria:\n'
check('visual reference: RU stage field is found for stage-/этап-/devtools-verify- names', stageRef(REF_RU).every((v) => v?.startsWith('`src/Other.tsx:12`')), JSON.stringify(stageRef(REF_RU)))
check('visual reference: EN stage field gives the same value', same(stageRef(REF_EN).map((v) => v?.split(' — ')[0]), stageRef(REF_RU).map((v) => v?.split(' — ')[0])), JSON.stringify(stageRef(REF_EN)))
for (const none of ['—', 'нет', 'n/a', 'не нужен']) check(`visual reference: RU value «${none}» — none`, stageRef(`### Этап 3: x\nЭталон вида: ${none}\n`).every((v) => v === null))
for (const none of ['—', 'none', 'n/a', 'not needed', 'None.']) check(`visual reference: EN value «${none}» — none`, stageRef(`### Stage 3: x\nVisual reference: ${none}\n`).every((v) => v === null))
check('visual reference: stage 3 is not stage 30', stageRef('### Stage 30: x\nVisual reference: `a.tsx`\n').every((v) => v === null))
const OPEN_BLOCKERS = (done) => `- B1 — race — need a backend answer\n- B2 — y — ${done}\nB3: z\n`
check('blockers: RU lifted forms are closed, others open', jc.openBlockers(OPEN_BLOCKERS('снят пользователем')).length === 2 && jc.openBlockers(OPEN_BLOCKERS('решение пользователя 2026-10-04')).length === 2)
check('blockers: EN lifted forms are closed, others open', ['lifted by the user', 'resolved by the user', 'resolved: backend confirmed', 'closed by the user', 'answered by the user', 'user answer 2026-10-04', 'user decision 2026-10-04'].every((done) => jc.openBlockers(OPEN_BLOCKERS(done)).length === 2))
check('blockers: bare EN words do not lift', jc.openBlockers('- B1 — issue не closed\n- B2 — not resolved yet\n').length === 2)
check('blockers: EN open blocker lines are read from the block', same(jc.openBlockers('Blockers: B1\n- B1 — a\n- **B2** — b\n').length, 2))

const lRoot = mkdtempSync(join(tmpdir(), 'ledger-test-'))
const lApp = join(lRoot, 'app')
repoAt(lApp, 'main')
const lTask = join(lApp, '.claude/tasks/T-11')
const forceBlock = (heading = '## Force-прогон 2026-10-04', blockers = '') => `${heading}\nПодтверждено: 04.10.2026 — да\nБлокеры: ${blockers}\n\n`
const lStages = (extra = '', force = forceBlock()) =>
  `# T-11: задача\nВетка: \`T-11/feat/l\`\n\n## Статус: этап 1\n\n${force}## Этапы\n\n### Этап 1: первый  [status: in-progress]\n- [x] pro-review (\`checks/pro-review-0.md\` — M-1 принят как компромисс)\n${extra}`
write(lApp, {
  '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n',
  '.claude/tasks/T-11/STAGES.md': lStages(),
  // Отчёт прошлой версии: находка без итога, на неё ссылается старая строка журнала.
  '.claude/tasks/T-11/checks/pro-review-0.md': '# pro-review\nИтог: 🔴0 · 🟠1\n### 🟠 M-1 a.ts:1 — дубль\n',
})
const past = Date.now() / 1000 - 3600
utimesSync(join(lTask, 'checks/pro-review-0.md'), past, past)
// Снимок v1 (0.12–0.13): только строки с ✅ — новая версия дописывает в него текущие строки, а не придирается к ним.
const v1 = join(DATA, 'journal-baseline')
mkdirSync(v1, { recursive: true })
const { createHash } = await import('node:crypto')
const { realpathSync } = await import('node:fs')
writeFileSync(join(v1, `${createHash('sha1').update(realpathSync(lTask)).digest('hex').slice(0, 16)}.json`), JSON.stringify({ taskDir: lTask, created: new Date(past * 1000).toISOString(), lines: [] }))
git(lApp, 'checkout', '-qb', 'T-11/feat/l')
const lGate = (file) => runHook('journal-gate.mjs', { cwd: lApp, tool_name: 'Write', tool_input: { file_path: join(lTask, file) } })
check('снимок v1 → v2: старая строка «[x] pro-review … компромисс» не придирается', lGate('STAGES.md').decision === 'allow', lGate('STAGES.md').text)
check('force-коммит: старый отчёт без итога (до снимка) не мешает', hook('git-guard.mjs', lApp, 'git commit --allow-empty -m x') === 'allow')

const future = Date.now() / 1000 + 5
const writeReport = (name, text) => {
  write(lApp, { [`.claude/tasks/T-11/checks/${name}`]: text })
  utimesSync(join(lTask, 'checks', name), future, future)
}
writeReport('pro-review-1.md', REVIEW)
check('запись отчёта с находками без итога — не блок (итог пишется после fix-loop)', lGate('checks/pro-review-1.md').decision === 'allow', lGate('checks/pro-review-1.md').text)
const denied = runHook('git-guard.mjs', { cwd: lApp, tool_input: { command: 'git commit --allow-empty -m x' } })
check('force-коммит: новый отчёт без итога — отклонён', denied.decision === 'deny' && /pro-review-1\.md/.test(denied.text), denied.text)
writeReport('pro-review-1.md', `${REVIEW}\n## Итог находок\n- M-1 — оставляю\n- M-2 — исправлено: b.ts:4\n`)
const parked = lGate('checks/pro-review-1.md')
check('итог «оставляю» — возвращён тем же ходом', parked.decision === 'block' && /decision not to fix/.test(parked.text), parked.text)
writeReport('pro-review-1.md', `${REVIEW}\n## Итог находок\n- M-1 — исправлено: a.ts:3\n- M-2 — исправлено: b.ts:4\n`)
check('итог полный — force-коммит проходит', hook('git-guard.mjs', lApp, 'git commit --allow-empty -m x') === 'allow')
writeReport('devtools-verify-1.md', '# devtools-verify, этап 1\nНаходки: critical 0 · major 0 · minor 0\n')
check('рантайм-отчёт без geometry — возвращён', /geometry/.test(lGate('checks/devtools-verify-1.md').text))
writeReport('pro-review-2.md', REVIEW)
write(lApp, { '.claude/tasks/T-11/STAGES.md': lStages('- [x] pro-review (`checks/pro-review-2.md` — Request changes)\n') })
check('новая отметка «[x] pro-review (checks/…)» при неполном итоге — возвращена', /pro-review-2\.md/.test(lGate('STAGES.md').text))
writeReport('pro-review-2.md', `${REVIEW}\n## Итог находок\n- M-1 — исправлено: a.ts:3\n- M-2 — B1\n`)
write(lApp, { '.claude/tasks/T-11/STAGES.md': lStages('', forceBlock('## Force-прогон 2026-10-04 — завершён 2026-10-04', '\n- B1 — гонка M-2 — нужен ответ бэкенда — рекомендую очередь')) })
const closedEarly = lGate('STAGES.md')
check('«завершён» при открытом блокере — возвращено', closedEarly.decision === 'block' && /completed with blockers/.test(closedEarly.text), closedEarly.text)
write(lApp, { '.claude/tasks/T-11/STAGES.md': lStages('- `AC-1.2` WHEN бар THEN статус — ⏳ devtools-verify (подставить нечем)\n', forceBlock('## Force-прогон 2026-10-04 — завершён с блокерами 2026-10-04', '\n- B1 — гонка M-2 — нужен ответ бэкенда — рекомендую очередь')) })
const closed = runHook('journal-gate.mjs', { cwd: lApp, tool_name: 'Edit', tool_input: { file_path: join(lTask, 'STAGES.md') } })
check('«завершён с блокерами» — сводка прогона в контексте', closed.decision === 'message' && /Блокеры — нужен твой ответ \(1\)/.test(closed.text) && /AC-1\.2/.test(closed.text), `${closed.decision}: ${closed.text.slice(0, 200)}`)
check('сводка прогона — один раз на закрытие', runHook('journal-gate.mjs', { cwd: lApp, tool_name: 'Edit', tool_input: { file_path: join(lTask, 'STAGES.md') } }).decision === 'allow')

// Английские близнецы блокеров и закрытия force-блока в journal-gate.
const forceBlockEn = (heading, blockers = '') => `${heading}\nConfirmed: 2026-10-04 — yes\nBlockers: ${blockers}\n\n`
const lStagesEn = (force) => `# T-11: task\nBranch: \`T-11/feat/l\`\n\n## Status: stage 1\n\n${force}## Stages\n\n### Stage 1: first  [status: in-progress]\n- [ ] pro-review\n`
const ruClosedStages = readFileSync(join(lTask, 'STAGES.md'), 'utf8')
write(lApp, { '.claude/tasks/T-11/STAGES.md': lStagesEn(forceBlockEn('## Force run 2026-10-04 — completed 2026-10-04', '\n- B1 — race M-2 — backend answer needed — recommend a queue')) })
const closedEarlyEn = lGate('STAGES.md')
check('EN "completed" with an open blocker — returned', closedEarlyEn.decision === 'block' && /completed with blockers/.test(closedEarlyEn.text), closedEarlyEn.text)
write(lApp, { '.claude/tasks/T-11/STAGES.md': lStagesEn(forceBlockEn('## Force run 2026-10-04 — completed 2026-10-04', '\n- B1 — race M-2 — backend answer needed — resolved by the user')) })
check('EN "completed" with a lifted blocker — passes', lGate('STAGES.md').decision !== 'block', lGate('STAGES.md').text)
write(lApp, { '.claude/tasks/T-11/STAGES.md': lStagesEn(forceBlockEn('## Force run 2026-10-04b — completed with blockers 2026-10-04', '\n- B1 — race M-2 — backend answer needed — recommend a queue')) })
const closedEn = runHook('journal-gate.mjs', { cwd: lApp, tool_name: 'Edit', tool_input: { file_path: join(lTask, 'STAGES.md') } })
check('EN "completed with blockers" — run summary is in the context', closedEn.decision === 'message' && /Blockers — your answer needed \(1\)/.test(closedEn.text), `${closedEn.decision}: ${closedEn.text.slice(0, 200)}`)
check('EN task: pipeline state gives task.language = en', readPipelineState(lApp)?.tasks.find((t) => t.ticket === 'T-11')?.language === 'en')
write(lApp, { '.claude/tasks/T-11/STAGES.md': ruClosedStages })
check('RU task: pipeline state gives task.language = ru', readPipelineState(lApp)?.tasks.find((t) => t.ticket === 'T-11')?.language === 'ru')
write(lApp, { '.claude/tasks/T-11/STAGES.md': `# T-11\nLanguage: en\nBranch: \`T-11/feat/l\`\n\n## Статус: этап 1\n\n## Этапы\n\n### Этап 1: первый  [status: in-progress]\n` })
check('task.language: the header line wins over the headings', readPipelineState(lApp)?.tasks.find((t) => t.ticket === 'T-11')?.language === 'en')
write(lApp, { '.claude/tasks/T-11/STAGES.md': ruClosedStages })

// frames-guard: кадры агента devtools-verify, открытые Read'ом, и неоткрытые.
const shots = join(lTask, 'checks/screens')
mkdirSync(shots, { recursive: true })
const frame = (name) => {
  writeFileSync(join(shots, name), 'png')
  return join(shots, name)
}
const [a, b] = [frame('a.png'), frame('b.png')]
const record = (time, content) => JSON.stringify({ timestamp: new Date(time).toISOString(), message: { content } })
const agentLog = (reads) => {
  const path = join(lRoot, `agent-${reads.length}.jsonl`)
  const now = Date.now()
  writeFileSync(
    path,
    [
      record(now - 60_000, [{ type: 'tool_use', name: 'mcp__chrome-devtools__take_screenshot', input: { filePath: a } }]),
      record(now - 50_000, [{ type: 'tool_use', name: 'mcp__chrome-devtools__take_screenshot', input: { filePath: b } }]),
      ...reads.map((path, i) => record(now - 40_000 + i, [{ type: 'tool_use', name: 'Read', input: { file_path: path } }])),
    ].join('\n'),
  )
  return path
}
const frames = (agent_type, reads) => runHook('frames-guard.mjs', { cwd: lApp, agent_type, agent_transcript_path: agentLog(reads) })
const unseen = frames('stage-pipeline:devtools-verify', [a])
check('frames-guard: один кадр не открыт — агент продолжает', unseen.decision === 'block' && /b\.png/.test(unseen.text) && !/a\.png/.test(unseen.text), unseen.text)
check('frames-guard: все кадры открыты — агент заканчивает', frames('stage-pipeline:devtools-verify', [a, b]).decision === 'allow')
check('frames-guard: другие агенты не трогаются', frames('stage-pipeline:pro-review', []).decision === 'allow')
rmSync(lRoot, { recursive: true, force: true })

// ── 0.15: критерии в плане, вид из кита, гейты CI, работа после «готово» ──────
const LIKES = [
  ['- `AC-5.3` WHEN сохранить THEN как у эксперта — [verify: devtools-verify]', 'AC-5.3'],
  ['- D11: «Сохранить» — как у эксперта (expert-lead-card-sheet.tsx:227)', null],
  ['- `AC-2.1` WHEN карточка THEN отступы как в макете — [verify: figma-compare]', null],
  ['- `AC-2.2` WHEN поля нет THEN прочерк, так как в API его нет — [verify: pro-review]', null],
  ['- Решение: активная «Сохранить» — как сейчас в шторке', 'decision'],
  ['- 2026-10-01 — сделал как у эксперта', null],
]
for (const [line, want] of LIKES) check(`«как у X» ${line.slice(2, 46)} → ${want}`, (jc.likeViolation(line)?.id ?? null) === want, JSON.stringify(jc.likeViolation(line)))

const gates = await import(join(PLUGIN, 'ci-gates.mjs'))
const GATES_TABLE =
  '## Commands\n- test: `pnpm test`\n\n## Гейты CI (ронять нельзя)\n\n| Проверка | Команда | Что ловит |\n| --- | --- | --- |\n| Юниты | `pnpm test` | словари |\n' +
  '| **Смоук** | `pnpm --filter smoke exec playwright test` | маршруты |\n\n## Архитектура\n| слой | `не гейт` |\n'
const parsed = gates.gateCommands(GATES_TABLE)
check('гейты: таблица «Гейты CI» — названия и команды до следующего раздела', same(parsed, [{ name: 'Юниты', command: 'pnpm test' }, { name: 'Смоук', command: 'pnpm --filter smoke exec playwright test' }]), JSON.stringify(parsed))
check('гейты: без таблицы — e2e из Commands', same(gates.gateCommands('- test: `yarn test`\n- e2e: `yarn e2e:test` / `yarn e2e:test:stg` (Playwright)\n'), [{ name: 'e2e', command: 'yarn e2e:test' }]))
check('гейты: «e2e: НЕТ» — не гейт', gates.gateCommands('- e2e: НЕТ # тестов нет\n- test: yarn test\n').length === 0)
const GATES_TABLE_EN =
  '## Commands\n- test: `pnpm test`\n\n## CI gates (must not break)\n\n| Check | Command | What it catches |\n| --- | --- | --- |\n| Units | `pnpm test` | dictionaries |\n' +
  '| **Smoke** | `pnpm --filter smoke exec playwright test` | routes |\n\n## Architecture\n| layer | `not a gate` |\n'
check('EN gates: "CI gates" table — names and commands up to the next section', same(gates.gateCommands(GATES_TABLE_EN), parsed.map(({ command }, i) => ({ name: ['Units', 'Smoke'][i], command }))), JSON.stringify(gates.gateCommands(GATES_TABLE_EN)))
check('EN gates: "e2e: NONE" — not a gate', gates.gateCommands('- e2e: NONE # no tests\n- test: yarn test\n').length === 0 && gates.gateCommands('- e2e: n/a\n').length === 0)
check('EN gates: without a table — e2e from Commands', same(gates.gateCommands('- test: `yarn test`\n- e2e: `yarn e2e:test` / `yarn e2e:test:stg` (Playwright)\n'), [{ name: 'e2e', command: 'yarn e2e:test' }]))
check('EN gates: "kit_overrides: disabled" and RU "нет" both switch the scan off', markers.KIT_OVERRIDES_OFF.test('- kit_overrides: disabled\n') && markers.KIT_OVERRIDES_OFF.test('- kit_overrides: нет\n') && !markers.KIT_OVERRIDES_OFF.test('- kit_overrides: on\n'))

const kRoot = mkdtempSync(join(tmpdir(), 'kit-test-'))
const kApp = join(kRoot, 'app')
repoAt(kApp, 'main')
write(kApp, { 'src/ui/button.tsx': 'export const B = 1\n', 'src/Old.tsx': 'export const Old = () => null\n', 'src/Other.tsx': 'export const o = "font-bold"\n' })
git(kApp, 'add', '-A')
git(kApp, 'commit', '-qm', 'base 2')
const kits = await import(join(PLUGIN, 'kit-override-scan.mjs'))
const KIT_CONFIG = '- ui_lib: shadcn/ui → `src/ui/`\n'
write(kApp, {
  'src/Card.tsx': [
    'export const Card = () => <h3 className="text-[13px] font-bold uppercase text-[var(--text-secondary)]">x</h3>',
    '// font-extrabold в комментарии не в счёт',
    'export const panel = "rounded-[9px] px-[18px] max-w-[70ch] p-4 font-medium"',
    '',
  ].join('\n'),
  'src/ui/button.tsx': 'export const B = "font-bold"\n',
  'src/Card.stories.tsx': 'export const s = "font-bold"\n',
})
const kitFound = kits.scanOverrides(kApp, { config: KIT_CONFIG })
check('kit-overrides: новые и изменённые файлы, без каталога кита и сторис', same(kitFound.map(({ file }) => file), ['src/Card.tsx']), JSON.stringify(kitFound.map(({ file }) => file)))
const tokens = [...new Set(kitFound[0]?.hits.map(({ token }) => token))].sort()
check('kit-overrides: вес, регистр, кегль, радиус, отступ, ширина; токен через var и комментарий — нет', same(tokens, ['font-bold', 'max-w-[70ch]', 'px-[18px]', 'rounded-[9px]', 'text-[13px]', 'uppercase'].sort()), JSON.stringify(tokens))
check('kit-overrides: «kit_overrides: off» — в репо кита молчит', kits.scanOverrides(kApp, { config: '- kit_overrides: off\n' }).length === 0)
const rendered = kits.renderReport(kitFound, { previous: '# old\n## Итог находок\n- K-1 — исправлено: src/Card.tsx:1\n' })
check('kit-overrides: отчёт со сводкой чекера, итог прошлого прогона сохранён', jc.findingCounts(rendered, 'stage-1-kit-overrides.md').major === 1 && /## Итог находок\n- K-1 — исправлено/.test(rendered))
rmSync(join(kApp, 'src/Card.stories.tsx'))

const today = new Date().toISOString().slice(0, 10)
const kTask = join(kApp, '.claude/tasks/T-12')
const kStages = ({ extra = '', heading = `## Force-прогон ${today}`, blockers = '' } = {}) =>
  `# T-12: задача\nВетка: \`T-12/feat/k\`\n\n## Статус: этап 1\n\n${heading}\nПодтверждено: ${today} — «да»\nБлокеры: ${blockers}\n\n## Этапы\n\n` +
  `### Этап 1: карточка  [status: in-progress]\nЭталон вида: src/Other.tsx — соседняя секция\n${extra}`
const KIT_GATE = '`node -e "process.exit(0)"`'
write(kApp, {
  '.claude/pipeline.config.md': `- task_path: .claude/tasks/\n- main_branch: main\n${KIT_CONFIG}\n## Гейты CI\n| Проверка | Команда |\n|---|---|\n| Смоук | ${KIT_GATE} |\n`,
  '.claude/tasks/T-12/STAGES.md': kStages(),
})
git(kApp, 'checkout', '-qb', 'T-12/feat/k')
runHook('session-start.mjs', { cwd: kApp })
const kCommit = (command) => runHook('git-guard.mjs', { cwd: kApp, tool_input: { command } })
const noKitReport = kCommit('git add -A && git commit -m "T-12: карточка"')
check('force-коммит: переопределения кита без отчёта — отклонён', noKitReport.decision === 'deny' && /src\/Card\.tsx/.test(noKitReport.text) && /kit-override-scan/.test(noKitReport.text), noKitReport.text)
const kReport = join(kTask, 'checks/stage-1-kit-overrides.md')
mkdirSync(dirname(kReport), { recursive: true })
spawnSync(process.execPath, [join(PLUGIN, 'kit-override-scan.mjs'), '--out', kReport], { cwd: kApp })
{
  // The report is a task file: its language is the task language (D1). A ru task gets the old text, byte for byte.
  const ruReport = readFileSync(kReport, 'utf8')
  check(
    'kit-overrides: отчёт ru-задачи — по-русски, как раньше',
    ruReport.startsWith('# kit-overrides: рабочее дерево против HEAD\nНаходки: critical 0 · major 1 · minor 0\n\nПереопределения кита и ручная типографика') &&
      /\| K-1 \| `src\/Card\.tsx` \| .*вес шрифта.*регистр/.test(ruReport) &&
      /\n## Не удалось проверить\n- стили, собранные в рантайме/.test(ruReport) &&
      !/Findings|Could not verify/.test(ruReport),
    ruReport,
  )
  check('kit-overrides: отчёт ru-задачи читается обратно (сводка, язык)', jc.findingCounts(ruReport, 'stage-1-kit-overrides.md').major === 1 && jc.languageViolation(ruReport, 'stage-1-kit-overrides.md', 'ru') === null)
  check(
    'kit-overrides: ru-сводка с хитом !important — вид из RULES, не undefined',
    kits.summarize([{ kind: '!important', token: '!important', line: 1 }, { kind: 'font weight', token: 'font-bold', line: 2 }], 'ru') === '!important (`!important`), вес шрифта (`font-bold`)' &&
      kits.summarize([{ kind: 'new kind', token: 'x', line: 1 }], 'ru') === 'new kind (`x`)',
  )
}
const soon = Date.now() / 1000 + 5
utimesSync(kReport, soon, soon)
const noKitLedger = kCommit('git add -A && git commit -m "T-12: карточка"')
check('force-коммит: отчёт kit-overrides есть, итога нет — отклонён', noKitLedger.decision === 'deny' && /stage-1-kit-overrides\.md/.test(noKitLedger.text), noKitLedger.text)
writeFileSync(kReport, `${readFileSync(kReport, 'utf8')}\n## Итог находок\n- K-1 — ложная: эталон src/Other.tsx:1 — тот же font-bold\n`)
utimesSync(kReport, soon, soon)
const kitOk = kCommit('git add -A && git commit -m "T-12: карточка"')
check('force-коммит: итог доказан эталоном — проходит', kitOk.decision === 'allow', kitOk.text)
git(kApp, 'add', '-A')
git(kApp, 'commit', '-qm', 'T-12: карточка')
const cardSha = git(kApp, 'rev-parse', 'HEAD').trim()

rmSync(join(kApp, 'src/Old.tsx'))
const noParity = kCommit('git commit -am "T-12: убрал старую секцию"')
check('force-коммит: удалён UI-компонент без таблицы паритета — отклонён', noParity.decision === 'deny' && /`Old`/.test(noParity.text), noParity.text)
const PARITY = '| Паритет | было `Old` → перенесено в Card (`AC-1.P1`) |\n'
write(kApp, { '.claude/tasks/T-12/STAGES.md': kStages({ extra: PARITY }) })
check('force-коммит: Old в таблице паритета — проходит', kCommit('git commit -am "T-12: убрал старую секцию"').decision === 'allow')
git(kApp, 'commit', '-qam', 'T-12: убрал старую секцию')
const oldSha = git(kApp, 'rev-parse', 'HEAD').trim()

const dv = join(kTask, 'checks/stage-1-devtools-verify.md')
const DV = '# devtools-verify, этап 1\nНаходки: critical 0 · major 0 · minor 0\ngeometry 1440: overflow 0 · zero-gap 0 · clipped 0\n'
writeFileSync(dv, DV)
check('devtools-verify у этапа с «Эталоном вида» без style-diff — no-style-diff', jc.reportViolations(dv).some(({ rule }) => rule === 'no-style-diff'), JSON.stringify(jc.reportViolations(dv)))
writeFileSync(dv, `${DV}style-diff 1440: roles 4 · differ 0\n`)
check('devtools-verify со строкой style-diff — чисто', jc.reportViolations(dv).length === 0, JSON.stringify(jc.reportViolations(dv)))

// Гейт CI: «завершён» — только с зелёным прогоном на текущем HEAD.
const JOURNALED = `${PARITY}- [x] commit: \`${cardSha.slice(0, 8)}\` T-12: карточка\n- [x] commit: \`${oldSha.slice(0, 8)}\` T-12: убрал старую секцию\n`
const kGate = () => runHook('journal-gate.mjs', { cwd: kApp, tool_name: 'Edit', tool_input: { file_path: join(kTask, 'STAGES.md') } })
write(kApp, { '.claude/tasks/T-12/STAGES.md': kStages({ extra: JOURNALED, heading: `## Force-прогон ${today} — завершён ${today}` }) })
const redGate = kGate()
check('закрытие «завершён» без прогона гейта CI — возвращено', redGate.decision === 'block' && /Смоук/.test(redGate.text) && /never ran/.test(redGate.text), redGate.text)
const kConfig = readFileSync(join(kApp, '.claude/pipeline.config.md'), 'utf8')
write(kApp, { '.claude/tasks/T-12/STAGES.md': kStages({ extra: JOURNALED, heading: `## Force-прогон ${today} — завершён с блокерами ${today}`, blockers: '\n- B1 — Смоук: нужен стейджинг, локально не поднимается' }) })
check('«с блокерами»: незелёный гейт назван блокером — не нарушение', gates.gateCloseViolations(DATA, kApp, kConfig, kTask).length === 0)
spawnSync(process.execPath, [join(PLUGIN, 'run-check.mjs'), '--', 'node -e "process.exit(0)"'], { cwd: kApp, encoding: 'utf8', env: { ...process.env, STAGE_PIPELINE_RESOURCES: 'normal' } })
check('run-check: прогон на чистом дереве записан — гейт зелёный', gates.gateStatus(DATA, kApp, kConfig)[0]?.status === 'green', JSON.stringify(gates.gateStatus(DATA, kApp, kConfig)))
write(kApp, { '.claude/tasks/T-12/STAGES.md': kStages({ extra: JOURNALED, heading: `## Force-прогон ${today} — завершён ${today}` }) })
const greenGate = kGate()
check('гейт зелёный на HEAD — закрытие проходит, гейты в сводке', greenGate.decision === 'message' && /Гейты CI на HEAD \(1 из 1/.test(greenGate.text), `${greenGate.decision}: ${greenGate.text.slice(0, 300)}`)

// Пересобранный без подписи коммит — тот же коммит: журнал узнаёт его по содержимому.
git(kApp, 'commit', '--amend', '-qm', 'секция: перенос в карточку')
const rebuilt = runHook('session-start.mjs', { cwd: kApp }).text
check('session-start: пересобранный коммит с другим заголовком — не «мимо журнала»', !/мимо журнала|нет ни в STAGES/.test(rebuilt), rebuilt)
check('гейт после нового коммита с тем же деревом — всё ещё зелёный', gates.gateStatus(DATA, kApp, kConfig)[0]?.status === 'green')

// Доработка после «готово» прямо в интеграционную ветку под чужим тикетом.
git(kApp, 'checkout', '-q', 'main')
git(kApp, 'merge', '-q', '--no-ff', 'T-12/feat/k', '-m', 'Merge T-12')
write(kApp, { 'src/Card.tsx': 'export const Card = () => null\n' })
const later = new Date(Date.now() + 120_000).toISOString()
execFileSync('git', ['commit', '-qam', 'Fix(T-99): карточка обрезалась'], { cwd: kApp, env: { ...process.env, GIT_AUTHOR_DATE: later, GIT_COMMITTER_DATE: later } })
const elsewhere = runHook('session-start.mjs', { cwd: kApp }).text
check('session-start на main: фикс файла задачи под чужим тикетом после закрытия — назван', /T-12 \(closed /.test(elsewhere) && /Fix\(T-99\)/.test(elsewhere), elsewhere)
check('session-start: та же строка второй раз не повторяется', !/T-12 \(закрыта/.test(runHook('session-start.mjs', { cwd: kApp }).text))
rmSync(kRoot, { recursive: true, force: true })

// ── английский близнец force-прогона с гейтами, паритетом и эталоном вида ────
const eRoot = mkdtempSync(join(tmpdir(), 'kit-test-en-'))
const eApp = join(eRoot, 'app')
repoAt(eApp, 'main')
write(eApp, { 'src/ui/button.tsx': 'export const B = 1\n', 'src/Old.tsx': 'export const Old = () => null\n', 'src/Other.tsx': 'export const o = "font-bold"\n' })
git(eApp, 'add', '-A')
git(eApp, 'commit', '-qm', 'base 2')
const eTask = join(eApp, '.claude/tasks/T-13')
const eStages = ({ extra = '', heading = `## Force run ${today}`, blockers = '' } = {}) =>
  `# T-13: task\nLanguage: en\nBranch: \`T-13/feat/k\`\n\n## Status: stage 1\n\n${heading}\nConfirmed: ${today} — "yes"\nBlockers: ${blockers}\n\n## Stages\n\n` +
  `### Stage 1: card  [status: in-progress]\nVisual reference: src/Other.tsx — neighbouring section\n${extra}`
write(eApp, {
  '.claude/pipeline.config.md': `- task_path: .claude/tasks/\n- main_branch: main\n${KIT_CONFIG}\n## CI gates\n| Check | Command |\n|---|---|\n| Smoke | ${KIT_GATE} |\n`,
  '.claude/tasks/T-13/STAGES.md': eStages(),
})
git(eApp, 'checkout', '-qb', 'T-13/feat/k')
runHook('session-start.mjs', { cwd: eApp })
const eCommit = (command) => runHook('git-guard.mjs', { cwd: eApp, tool_input: { command } })
write(eApp, { 'src/Card.tsx': 'export const Card = () => <h3 className="text-[13px] font-bold uppercase">x</h3>\n' })
const noKitReportEn = eCommit('git add -A && git commit -m "T-13: card"')
check('EN force commit: kit overrides without a report — denied', noKitReportEn.decision === 'deny' && /src\/Card\.tsx/.test(noKitReportEn.text), noKitReportEn.text)
const eReport = join(eTask, 'checks/stage-1-kit-overrides.md')
mkdirSync(dirname(eReport), { recursive: true })
spawnSync(process.execPath, [join(PLUGIN, 'kit-override-scan.mjs'), '--out', eReport], { cwd: eApp })
{
  const enReport = readFileSync(eReport, 'utf8')
  check(
    'EN kit-overrides report: an en task gets English markers',
    enReport.startsWith('# kit-overrides: working tree against HEAD\nFindings: critical 0 · major 1 · minor 0\n\nKit overrides and hand-set typography') &&
      /\| K-1 \| `src\/Card\.tsx` \| .*font weight.*text case/.test(enReport) &&
      /\n## Could not verify\n- styles assembled at runtime/.test(enReport) &&
      !/[а-яё]/i.test(enReport),
    enReport,
  )
  check('EN kit-overrides report: read back (summary, language, "Could not verify" counted by the digest)', jc.findingCounts(enReport, 'stage-1-kit-overrides.md').major === 1 && jc.languageViolation(enReport, 'stage-1-kit-overrides.md', 'en') === null)
  check('EN kit-overrides report: a rerun keeps the "Findings outcome" of the previous run', /## Findings outcome\n- K-1 — fixed/.test(kits.renderReport([], { language: 'en', previous: '# old\n## Findings outcome\n- K-1 — fixed: src/Card.tsx:1\n' })))
}
utimesSync(eReport, soon, soon)
const noKitLedgerEn = eCommit('git add -A && git commit -m "T-13: card"')
check('EN force commit: report without an outcome — denied', noKitLedgerEn.decision === 'deny' && /stage-1-kit-overrides\.md/.test(noKitLedgerEn.text), noKitLedgerEn.text)
writeFileSync(eReport, `${readFileSync(eReport, 'utf8')}\n## Findings outcome\n- K-1 — false positive: reference src/Other.tsx:1 — the same font-bold\n`)
utimesSync(eReport, soon, soon)
check('EN force commit: outcome proven by the reference — passes', eCommit('git add -A && git commit -m "T-13: card"').decision === 'allow')
git(eApp, 'add', '-A')
git(eApp, 'commit', '-qm', 'T-13: card')
const eCardSha = git(eApp, 'rev-parse', 'HEAD').trim()
rmSync(join(eApp, 'src/Old.tsx'))
const noParityEn = eCommit('git commit -am "T-13: remove the old section"')
check('EN force commit: UI component removed without a Parity table — denied', noParityEn.decision === 'deny' && /`Old`/.test(noParityEn.text), noParityEn.text)
const PARITY_EN = '| Parity | was `Old` → moved to Card (`AC-1.P1`) |\n'
write(eApp, { '.claude/tasks/T-13/STAGES.md': eStages({ extra: PARITY_EN }) })
check('EN force commit: Old is in the Parity table — passes', eCommit('git commit -am "T-13: remove the old section"').decision === 'allow')
git(eApp, 'commit', '-qam', 'T-13: remove the old section')
const eOldSha = git(eApp, 'rev-parse', 'HEAD').trim()
const eDv = join(eTask, 'checks/stage-1-devtools-verify.md')
const eDvText = '# devtools-verify, stage 1\nFindings: critical 0 · major 0 · minor 0\ngeometry 1440: overflow 0 · zero-gap 0 · clipped 0\n'
writeFileSync(eDv, eDvText)
check('EN devtools-verify at a stage with "Visual reference" and no style-diff — no-style-diff', jc.reportViolations(eDv).some(({ rule }) => rule === 'no-style-diff'), JSON.stringify(jc.reportViolations(eDv)))
writeFileSync(eDv, `${eDvText}style-diff 1440: roles 4 · differ 0\n`)
check('EN devtools-verify with a style-diff line — clean', jc.reportViolations(eDv).length === 0, JSON.stringify(jc.reportViolations(eDv)))
const EJOURNALED = `${PARITY_EN}- [x] commit: \`${eCardSha.slice(0, 8)}\` T-13: card\n- [x] commit: \`${eOldSha.slice(0, 8)}\` T-13: remove the old section\n`
const eGate = () => runHook('journal-gate.mjs', { cwd: eApp, tool_name: 'Edit', tool_input: { file_path: join(eTask, 'STAGES.md') } })
write(eApp, { '.claude/tasks/T-13/STAGES.md': eStages({ extra: EJOURNALED, heading: `## Force run ${today} — completed ${today}` }) })
const redGateEn = eGate()
check('EN "completed" without a CI gate run — returned', redGateEn.decision === 'block' && /Смоук|Smoke/.test(redGateEn.text) && /never ran/.test(redGateEn.text), redGateEn.text)
const eConfig = readFileSync(join(eApp, '.claude/pipeline.config.md'), 'utf8')
check('EN gate table "CI gates" is read', same(gates.gateCommands(eConfig).map(({ name }) => name), ['Smoke']))
write(eApp, { '.claude/tasks/T-13/STAGES.md': eStages({ extra: EJOURNALED, heading: `## Force run ${today} — completed with blockers ${today}`, blockers: '\n- B1 — Smoke: needs staging, does not start locally' }) })
check('EN "completed with blockers": the red gate is named by a blocker — no violation', gates.gateCloseViolations(DATA, eApp, eConfig, eTask).length === 0)
write(eApp, { '.claude/tasks/T-13/STAGES.md': eStages({ extra: EJOURNALED, heading: `## Force run ${today} — completed with blockers ${today}`, blockers: '\n- B1 — something else entirely' }) })
check('EN "completed with blockers": the red gate is not named — violation', gates.gateCloseViolations(DATA, eApp, eConfig, eTask).length === 1)
spawnSync(process.execPath, [join(PLUGIN, 'run-check.mjs'), '--', 'node -e "process.exit(0)"'], { cwd: eApp, encoding: 'utf8', env: { ...process.env, STAGE_PIPELINE_RESOURCES: 'normal' } })
write(eApp, { '.claude/tasks/T-13/STAGES.md': eStages({ extra: EJOURNALED, heading: `## Force run ${today} — completed ${today}` }) })
const greenGateEn = eGate()
check('EN gate is green on HEAD — closing passes, gates are in the summary', greenGateEn.decision === 'message' && /CI gates on HEAD \(1 of 1/.test(greenGateEn.text), `${greenGateEn.decision}: ${greenGateEn.text.slice(0, 300)}`)
const eRebuilt = runHook('session-start.mjs', { cwd: eApp }).text
check('EN session-start: the state line carries the force mark and the task', /T-13/.test(eRebuilt) || eRebuilt === '', eRebuilt)
rmSync(eRoot, { recursive: true, force: true })

// ── 0.16 / EN-1 этап 2: английские фразовые эвристики и язык отчёта ───────────
// На каждую эвристику — позитивная английская фикстура с тем же результатом, что у русского близнеца выше,
// и негативная: легитимная английская строка без срабатывания. Русские фикстуры выше не менялись.
const EN_CAVEATS = [
  ['- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify (dark theme not verified)', true],
  ['- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify, only from code', true],
  ['- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify (code only)', true],
  ['- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ partially: light only', true],
  ['- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify, could not check dark', true],
  ['- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify, did not look at the dropdowns', true],
  ['- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify (fully verified, all checked)', false],
  ['- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify, not a regression', false],
  ['- `AC-2.7` — ✅ devtools-verify (light) · ⏳ devtools-verify (dark not verified)', false],
  ['- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify, dark not checked yet', true],
  ['- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify, not checked at 1024', true],
  ['- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify, I did not check the dropdown', true],
  ['- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify, checked by code only', true],
  ['- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify, checkbox is not checked by default', false],
  ['- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify, drawer not opened on load', false],
  ['- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify, code-only change, checked via devtools-verify', false],
  ['- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify, nothing partially hidden', false],
]
for (const [line, want] of EN_CAVEATS) check(`EN caveat ${line.slice(line.indexOf('✅'), line.indexOf('✅') + 52)} → ${want}`, Boolean(jc.caveatViolation(line)) === want, JSON.stringify(jc.caveatViolation(line)))
const EN_NO_DATA = [
  ['- `AC-4.5` WHEN bar THEN status — [live: user-side] — no bookings with police on the account', true],
  ['- `AC-4.5` WHEN bar THEN status — ⏳ no test data on the stand', true],
  ['- `AC-4.5` WHEN bar THEN status — not verified: no suitable data', true],
  ['- `AC-4.5` WHEN bar THEN status — ⏳ not on the account', true],
  ['- `AC-4.5` — ⏳ no data, checked with a stubbed API response (fixture)', false],
  ['- `AC-4.5` — ⏳ no bookings on the stand, replaced the API response', false],
  ['- `AC-4.5` — ⏳ not verified: no data loss on save', false],
  ['- `AC-4.5` — ⏳ not verified: no records changed, no orders were lost', false],
  ['- `AC-4.5` — ✅ devtools-verify, no data loss', false],
  ['- `AC-4.5` — ✅ devtools-verify, no data was lost', false],
]
for (const [line, want] of EN_NO_DATA) check(`EN no data ${line.slice(12, 70)} → ${want}`, Boolean(jc.noDataViolation(line)) === want, JSON.stringify(jc.noDataViolation(line)))
const EN_LIKES = [
  ['- `AC-5.3` WHEN save THEN same as the expert — [verify: devtools-verify]', 'AC-5.3'],
  ['- `AC-5.3` WHEN save THEN as before — [verify: devtools-verify]', 'AC-5.3'],
  ['- `AC-5.4` WHEN opened THEN as in the old page — [verify: devtools-verify]', 'AC-5.4'],
  ['- `AC-5.5` WHEN opened THEN as it is now in the drawer — [verify: pro-review]', 'AC-5.5'],
  ['- Decision: the active "Save" — same as now in the drawer', '*'],
  ['- Decided: copy the old layout, as currently shown', '*'],
  ['- D11: "Save" — same as the expert (expert-lead-card-sheet.tsx:227)', null],
  ['- `AC-2.1` WHEN card THEN gaps like in the mockup — [verify: figma-compare]', null],
  ['- `AC-2.1` WHEN card THEN gaps same as in the design — [verify: figma-compare]', null],
  ['- `AC-2.2` WHEN no field THEN dash, such as in the API — [verify: pro-review]', null],
  ['- `AC-2.2` WHEN no field THEN dash, as well as a hint — [verify: pro-review]', null],
  ['- `AC-2.3` WHEN open THEN same as AC-2.1 — [verify: pro-review]', null],
  ['- `AC-2.3` WHEN open THEN as in the ticket — [verify: pro-review]', null],
  ['- `AC-2.3` WHEN open THEN as in the task description — [verify: pro-review]', null],
  ['- `AC-2.3` WHEN open THEN same as stage 2 — [verify: pro-review]', null],
  ['- `AC-2.3` WHEN open THEN as in the spec — [verify: pro-review]', null],
  ['- 2026-10-01 — did it same as the expert', null],
  ['- Decisions: kept the grid', null],
]
for (const [line, want] of EN_LIKES) {
  const got = jc.likeViolation(line)
  check(`EN "same as X" ${line.slice(2, 50)} → ${want}`, want === null ? got === null : got !== null && (want === '*' || got.id === want), JSON.stringify(got))
}
const EN_SKIPS = [
  ['Checks: pro-review-7a.md; proto-compare and devtools-verify — skip: the MCP Chrome is busy with another session', true],
  ['- [x] proto-compare [skip: staging does not accept the token]', true],
  ['- [x] figma-compare [skip: no browser available]', true],
  ['- [x] figma-compare [skip: dev server is down]', true],
  ['- [x] figma-compare `[skip: logic-only]`', false],
  ['- [ ] figma-compare (skip — no Figma; visual check by hand)', false],
  ['- [x] proto-compare [skip: no design source]', false],
  ['- [x] figma-compare [skip: no visual change, browser not needed]', false],
  ['- [x] figma-compare [skip: visuals unchanged]', false],
]
for (const [line, want] of EN_SKIPS) check(`EN design checker skip ${JSON.stringify(line).slice(0, 60)} → ${want ? 'violation' : 'ok'}`, Boolean(skipViolation(line)) === want, JSON.stringify(skipViolation(line)))
const EN_ACS = [
  ['- `AC-5.2` WHEN screen opened THEN no errors — [verify: devtools-verify] ✅ without the checker, user decision 2026-10-02', null],
  ['- `AC-6.1` WHEN listing hydrated THEN no requests — [verify: devtools-verify] ✅ confirmed live: 0 requests', null],
  ['- `AC-6.2` WHEN listing hydrated THEN no requests — [verify: devtools-verify] ✅ checked in the browser: 0 requests', null],
  ['- `AC-8.1` WHEN form empty THEN "Add" active — [verify: devtools-verify] ✅ smoke (new-lead.spec.ts:40)', null],
  ['- `AC-4.5` WHEN field empty THEN "Save" disabled — [verify: devtools-verify] ✅ pro-review by code · ⏳ user-review', 'ac-checker'],
  ['- `AC-4.6` WHEN saved THEN toast — [verify: devtools-verify] ✅ livelihood of the page', 'ac-checker'],
  ['- `AC-1.2` WHEN compared with the node THEN gaps match — [verify: figma-compare] ✅ checked live', 'ac-checker'],
  ['- `AC-4.7` WHEN list opened THEN empty state — [verify: devtools-verify] ✅ no live bookings on the account', 'ac-checker'],
  ['- `AC-4.8` WHEN list opened THEN empty state — [verify: devtools-verify] ✅ live check: 0 requests', null],
]
for (const [line, want] of EN_ACS) check(`EN criterion outcome ${JSON.stringify(line.slice(line.indexOf('✅'))).slice(0, 56)} → ${want}`, (acViolation(line, REPORTS)?.rule ?? null) === want, JSON.stringify(acViolation(line, REPORTS)))
const EN_DISPOSITIONS = [
  ['- M-1 — fixed: use-express-form.ts:104, rechecked', 'fixed'],
  ['- M-1 — resolved: moved to Card.vue:12', 'fixed'],
  ['- M-1 — left padding fixed: a.ts:3', 'fixed'],
  ['- #2 — false: 109×32 is the native svg size', 'false'],
  ['- #2 — false positive: the node is hidden (a.ts:9)', 'false'],
  ['- #3 — not confirmed, could not reproduce at 1440', 'false'],
  ['- #3 — not reproduced on 3 runs', 'false'],
  ['- #3 — pre-existing: on base 422729d0 the same (measured 1037)', 'false'],
  ['- #3 — pre-existing, production shows the same', 'false'],
  ['- #3 — long-standing, not a finding', 'unproven'],
  ['- #3 — pre-existing, was there before the task', 'unproven'],
  ['- M-1 — accepted as a compromise, see "Awaiting user confirmation"', 'parked'],
  ['- M-1 — leaving it, minor in essence', 'parked'],
  ['- M-1 — keeping the current behavior', 'parked'],
  ['- M-1 — left as is', 'parked'],
  ['- M-1 — will do later', 'parked'],
  ['- M-1 — separate task', 'parked'],
  ['- M-1 — out of scope', 'parked'],
  ['- M-1 — not fixed', 'parked'],
  ["- M-1 — won't fix", 'parked'],
  ['- #4 — question for design', 'parked'],
  ['- #5 — user decision 2026-10-16: keep 109', 'user'],
  ['- #5 — user decided "keep 109"', 'user'],
  ['- #5 — user decision', 'unknown'],
  ['- #7 — not false, the gap is real', 'unknown'],
  ['- M-3 — handler returns false: needs a refactor', 'unknown'],
  ['- M-3 — handler returns false: fixed in a.ts:4', 'fixed'],
  ['- M-4 — was not repaired', 'unknown'],
  ['- M-4 — wasn\'t fixed yet', 'unknown'],
  ['- M-5 — stand-alone component is untouched', 'unknown'],
  ['- #6 — we will see', 'unknown'],
  ['- AC-5.9 — B1', 'blocker'],
]
for (const [entry, want] of EN_DISPOSITIONS) check(`EN outcome "${entry.slice(2, 44)}" → ${want}`, jc.disposition(entry) === want, jc.disposition(entry))
check(
  'EN: "was FAIL", "before the fix: FAIL" after a fix — not a finding',
  same(jc.failedCriteria('- `AC-2.1` - FAIL in 2 major\n- AC-3.1 — PASS (was FAIL)\n- AC-3.2 — PASS (before the fix: FAIL)\n- AC-3.3 — PASS (was previously FAIL)\n'), ['AC-2.1']),
)
check('EN outcome "false: <proof>" is a closed finding', jc.ledgerViolations(`${REVIEW_EN}\n## Findings outcome\n- M-1 — false: 12px at a.ts:3\n- M-2 — fixed: b.ts:4\n`, 'pro-review-1.md', { complete: true }).length === 0)
check('EN outcome "leaving it" — ledger-parked', jc.ledgerViolations(`${REVIEW_EN}\n## Findings outcome\n- M-1 — leaving it, minor in essence\n`, 'pro-review-1.md')[0]?.rule === 'ledger-parked')
check('EN outcome "pre-existing" without proof — ledger-unproven', jc.ledgerViolations(`${REVIEW_EN}\n## Findings outcome\n- M-1 — pre-existing\n`, 'pro-review-1.md')[0]?.rule === 'ledger-unproven')
check('EN outcome "user decision" without a date or quote — ledger-unknown', jc.ledgerViolations(`${REVIEW_EN}\n## Findings outcome\n- M-1 — user decision\n`, 'pro-review-1.md')[0]?.rule === 'ledger-unknown')

// «Could not verify»: пустой список по-английски не попадает в сводку прогона.
const { runDigest } = await import(join(PLUGIN, 'run-digest.mjs'))
const { describe: describeGate } = await import(join(PLUGIN, 'ci-gates.mjs'))
const digestFor = (items) => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-en-'))
  mkdirSync(join(dir, 'T-30/checks'), { recursive: true })
  writeFileSync(join(dir, 'T-30/STAGES.md'), '# T-30: task\nLanguage: en\n\n## Status: stage 1\n\n## Stages\n\n### Stage 1: card  [status: in-progress]\n')
  const report = join(dir, 'T-30/checks/pro-review-1.md')
  writeFileSync(report, `# pro-review, stage 1\nFindings: critical 0 · major 0 · minor 0\n\n## Could not verify\n${items.map((item) => `- ${item}`).join('\n')}\n`)
  const later = new Date(Date.now() + 60_000)
  utimesSync(report, later, later)
  const text = runDigest(join(dir, 'T-30'), mkdtempSync(join(tmpdir(), 'digest-en-data-')), null)
  rmSync(dir, { recursive: true, force: true })
  return text.match(/^### Not verified \((\d+)\)/m)?.[1]
}
const DIGEST_EMPTY = [['none'], ['None.'], ['nothing'], ['no items'], ['all verified'], ['All checked.'], ['everything is verified'], ['нет'], ['ничего']]
for (const items of DIGEST_EMPTY) check(`digest: «Could not verify» "${items[0]}" — nothing unverified`, digestFor(items) === '0', String(digestFor(items)))
for (const item of ['none of the states could be opened', 'AC-3.2 — no data on the stand', 'nothing was captured for dark']) check(`digest: a real item "${item.slice(0, 36)}" is counted`, digestFor([item]) === '1', String(digestFor([item])))

// Язык отчёта (D9): проза по языку задачи; код, пути, id, цитаты UI и короткие отчёты не считаются.
const lines = (text, count) => Array.from({ length: count }, () => text).join('\n')
const RU_PROSE = 'Проверил карточку этапа: компонент рендерится без ошибок, отступы совпадают с макетом, а пустое состояние списка показывает заглушку.'
const EN_PROSE = 'Checked the stage card: the component renders without errors, the gaps match the mockup and the empty list state shows a placeholder.'
const RU_REPORT = `# pro-review, этап 3\nНаходки: critical 0 · major 1 · minor 0\n\n${lines(RU_PROSE, 5)}\n`
const EN_REPORT = `# pro-review, stage 3\nFindings: critical 0 · major 1 · minor 0\n\n${lines(EN_PROSE, 5)}\n`
const RU_TECH =
  '# devtools-verify, этап 3\nНаходки: critical 0 · major 0 · minor 0\n\n' +
  lines('Проверил `src/ui/Card.vue:34` и padding в src/ui/card.css:12: карточка не вылезает за контейнер, overflow 0, hover работает, AC-3.1 PASS, M-1 minor закрыт.', 6) +
  `\n${lines('- AC-3.2 — PASS: tsc без ошибок, jest 169/169, lint чистый, devtools-verify-2.md и stage-3-pro-review.md сверены, useFooBar вызывается один раз.', 4)}\n`
const EN_QUOTED =
  `# pro-review, stage 3\nFindings: critical 0 · major 0 · minor 0\n\n${lines(EN_PROSE, 4)}\n` +
  'The button label «Сохранить», the toast "Данные успешно сохранены" and the tab `Настройки аккаунта` match the copy deck.\n' +
  '```\nОшибка: не удалось сохранить данные пользователя. Попробуйте ещё раз позже, пожалуйста.\n```\n' +
  `${lines('Placeholder «Введите номер телефона или адрес электронной почты» is shown on the empty field.', 3)}\n`
const SHORT_EN = '# pro-review, stage 3\nFindings: critical 0 · major 0 · minor 0\nAll good, see the diff.\n'
const SHORT_RU = '# pro-review, этап 3\nНаходки: critical 0 · major 0 · minor 0\nВсё в порядке.\n'
const REPORT_LANGUAGE = [
  ['RU task, RU report', RU_REPORT, 'ru', false],
  ['RU task, RU report with many paths and English terms', RU_TECH, 'ru', false],
  ['RU task, EN report', EN_REPORT, 'ru', true],
  ['EN task, EN report', EN_REPORT, 'en', false],
  ['EN task, EN report quoting Russian UI texts', EN_QUOTED, 'en', false],
  ['EN task, RU report', RU_REPORT, 'en', true],
  ['EN task, RU report with paths and English terms', RU_TECH, 'en', true],
  ['RU task, short EN report', SHORT_EN, 'ru', false],
  ['EN task, short RU report', SHORT_RU, 'en', false],
  ['task without a language, EN report', EN_REPORT, null, false],
  ['task without a language, RU report', RU_REPORT, null, false],
]
for (const [name, text, language, want] of REPORT_LANGUAGE) {
  const got = jc.languageViolation(text, 'pro-review-3.md', language)
  check(`report language: ${name} → ${want ? 'returned' : 'passes'}`, Boolean(got) === want, JSON.stringify(got))
}
{
  const dir = mkdtempSync(join(tmpdir(), 'lang-report-'))
  const path = join(dir, 'pro-review-3.md')
  writeFileSync(path, EN_REPORT)
  check('reportViolations: language passed — EN report in a RU task is returned', jc.reportViolations(path, 'ru').some(({ rule }) => rule === 'report-language'))
  check('reportViolations: no language — nothing to compare', !jc.reportViolations(path).some(({ rule }) => rule === 'report-language'))
  rmSync(dir, { recursive: true, force: true })
}

// journal-gate возвращает автору отчёт не на языке задачи тем же ходом, что остальные нарушения отчёта.
const lgRoot = mkdtempSync(join(tmpdir(), 'lang-gate-'))
const lgApp = join(lgRoot, 'app')
repoAt(lgApp, 'main')
const lgStages = (language) => `# T-31: task\n${language ? `Language: ${language}\n` : ''}Branch: \`T-31/feat/l\`\n\n## Status: stage 1\n\n## Stages\n\n### Stage 1: card  [status: in-progress]\n`
const lgReport = join(lgApp, '.claude/tasks/T-31/checks/pro-review-1.md')
write(lgApp, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n', '.claude/tasks/T-31/STAGES.md': lgStages('en') })
git(lgApp, 'checkout', '-qb', 'T-31/feat/l')
runHook('session-start.mjs', { cwd: lgApp })
const lgWrite = (stagesText, report) => {
  write(lgApp, { '.claude/tasks/T-31/STAGES.md': stagesText, '.claude/tasks/T-31/checks/pro-review-1.md': report })
  return runHook('journal-gate.mjs', { cwd: lgApp, tool_name: 'Write', tool_input: { file_path: lgReport } })
}
const lgRu = lgWrite(lgStages('en'), RU_REPORT)
check('journal-gate: RU report in an EN task — returned to the author', lgRu.decision === 'block' && /pro-review-1\.md/.test(lgRu.text) && /task language/.test(lgRu.text), lgRu.text)
check('journal-gate: EN report in an EN task — passes', lgWrite(lgStages('en'), EN_REPORT).decision === 'allow')
check('journal-gate: EN report quoting Russian UI texts in an EN task — passes', lgWrite(lgStages('en'), EN_QUOTED).decision === 'allow')
const lgEn = lgWrite(lgStages('ru'), EN_REPORT)
check('journal-gate: EN report in a RU task — returned to the author', lgEn.decision === 'block' && /task language/.test(lgEn.text), lgEn.text)
check('journal-gate: RU report in a RU task — passes', lgWrite(lgStages('ru'), RU_REPORT).decision === 'allow')
check('journal-gate: task without a language line and without headings — report language is not checked', lgWrite('# T-31: task\nBranch: `T-31/feat/l`\n\n## Status: stage 1\n', RU_REPORT).decision === 'allow')
// Язык проверяется только у отчёта, созданного после снимка задачи (имя отчёта не из снимка): старый отчёт старой задачи правят без возврата.
git(lgApp, 'checkout', '-qb', 'T-32/feat/old')
write(lgApp, { '.claude/tasks/T-32/STAGES.md': lgStages('ru').replace('T-31', 'T-32'), '.claude/tasks/T-32/checks/pro-review-0.md': EN_REPORT })
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
runHook('session-start.mjs', { cwd: lgApp })
const lgOld2 = join(lgApp, '.claude/tasks/T-32/checks/pro-review-0.md')
const lgOldRun = (report) => {
  write(lgApp, { '.claude/tasks/T-32/checks/pro-review-0.md': report })
  return runHook('journal-gate.mjs', { cwd: lgApp, tool_name: 'Edit', tool_input: { file_path: lgOld2 } })
}
check('journal-gate: old EN report (created before the snapshot) in a RU task, edited — no language return', lgOldRun(EN_REPORT + '\n## Итог находок\n').decision === 'allow')
// правка с заменой файла (новый inode): запись во временный файл и rename поверх, как делает Edit
const lgReplace = (report) => {
  const tmp = lgOld2 + '.tmp'
  writeFileSync(tmp, report)
  renameSync(tmp, lgOld2)
  return runHook('journal-gate.mjs', { cwd: lgApp, tool_name: 'Edit', tool_input: { file_path: lgOld2 } })
}
check('journal-gate: old EN report in a RU task, replaced via rename (new inode) — no language return', lgReplace(EN_REPORT + '\n## Итог находок\n').decision === 'allow')
appendFileSync(lgOld2, '\n- M-2\n')
check('journal-gate: old EN report in a RU task, appended via Bash path (fresh mtime) — no language return', runHook('journal-gate.mjs', { cwd: lgApp, tool_name: 'Bash', tool_input: { command: 'cat >> report' } }).decision === 'allow')
write(lgApp, { '.claude/tasks/T-32/checks/pro-review-1.md': EN_REPORT })
const lgNewRun = runHook('journal-gate.mjs', { cwd: lgApp, tool_name: 'Write', tool_input: { file_path: join(lgApp, '.claude/tasks/T-32/checks/pro-review-1.md') } })
check('journal-gate: new EN report (created after the snapshot) in a RU task — returned', lgNewRun.decision === 'block' && /task language/.test(lgNewRun.text), lgNewRun.text)
// снимок v2 без имён отчётов: миграция записывает текущие отчёты как старые
const lgSnap = join(DATA, 'journal-baseline')
const lgSnapFile = readdirSync(lgSnap).map((n) => join(lgSnap, n)).find((f) => JSON.parse(readFileSync(f, 'utf8')).taskDir?.endsWith('T-32'))
const lgSnapData = JSON.parse(readFileSync(lgSnapFile, 'utf8'))
check('journal-baseline: the snapshot stores report names seen at the first look', lgSnapData.reports?.includes('pro-review-0.md') && !lgSnapData.reports.includes('pro-review-1.md'), JSON.stringify(lgSnapData.reports))
const { reports: _dropped, ...lgNoReports } = lgSnapData
writeFileSync(lgSnapFile, JSON.stringify(lgNoReports))
const lgMig = jc.baselineInfo(DATA, join(lgApp, '.claude/tasks/T-32'))
const lgMigData = JSON.parse(readFileSync(lgSnapFile, 'utf8'))
check('journal-baseline: v2 snapshot without names — migration records current reports as old, other fields intact', lgMig.reports.has('pro-review-0.md') && lgMig.reports.has('pro-review-1.md') && same(lgMigData.reports.sort(), ['pro-review-0.md', 'pro-review-1.md']) && lgMigData.ledgerSince === lgSnapData.ledgerSince && same(lgMigData.lines, lgSnapData.lines))
rmSync(lgRoot, { recursive: true, force: true })

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
check('run-check: файлов нет — команда не запускается, код 0', none.status === 0 && /skipped/.test(none.stdout))
check('run-check: код выхода — код команды', rc(['--', 'exit 3']).status === 3)
check('run-check: git через обёртку не запускается', rc(['--', 'git', 'commit', '-m', 'x']).status === 2 && rc(['--', 'echo x && git push']).status === 2)
check('run-check: режим из resources в конфиге', (() => {
  write(rcRepo, { '.claude/pipeline.config.local.md': '- resources: normal\n' })
  return /^normal/.test(rc(['--mode']).stdout)
})())
const first = spawnSync('/bin/sh', ['-c', `STAGE_PIPELINE_RESOURCES=low STAGE_PIPELINE_LOCK_DIR='${locks}' '${process.execPath}' '${RUN_CHECK}' -- 'sleep 2; date +%s%N' & sleep 0.5; STAGE_PIPELINE_RESOURCES=low STAGE_PIPELINE_LOCK_DIR='${locks}' '${process.execPath}' '${RUN_CHECK}' -- 'date +%s%N'; wait`], { cwd: rcRepo, encoding: 'utf8' })
const stamps = first.stdout.match(/^\d{15,}$/gm) ?? []
check('run-check: в low второй прогон ждёт первый (очередь на машину)', /waiting in the queue/.test(first.stdout) && stamps.length === 2 && Number(stamps[1]) >= Number(stamps[0]), first.stdout)
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
const entriesEn = Array.from({ length: 10 }, (_, i) => `- **2026-08-${String(22 - i).padStart(2, '0')}** — entry ${22 - i}\n  details ${22 - i}`)
const sourceEn = [
  '# T: task',
  'Branch: `T/feat/x`',
  '',
  '## Status: stage 3',
  '',
  '## Force run 2026-08-20',
  '### Stage 9: catch-up inside force  [status: done]',
  ...Array.from({ length: 30 }, (_, i) => `catch-up detail ${i}`),
  '',
  '## Stages',
  '',
  '### Stage 1: first  [status: done]',
  'Decisions: took the shared formatter',
  '- [x] commit: `T: formatter`',
  '- [ ] user-review',
  '- `AC-1.2` ⏳ user-review',
  ...Array.from({ length: 40 }, (_, i) => `long stage detail ${i} — ${'x'.repeat(40)}`),
  '',
  '### Stage 2: second  [status: in-progress]',
  'in progress',
  '',
  '### Stage 4: dropped  [status: cancelled]',
  ...Array.from({ length: 12 }, (_, i) => `dropped detail ${i} — ${'y'.repeat(40)}`),
  '',
  '## ⚠ Awaiting user confirmation',
  '- default sort order',
  '',
  '## Journal (newest first)',
  '',
  ...entriesEn.slice(0, 5),
  '### Stage 1 — progress',
  'Group intro.',
  ...entriesEn.slice(5),
  '',
].join('\n')
const planEn = planArchive(sourceEn)
check('EN archive: done and cancelled stages are folded, in-progress stage and force block are not', same(planEn.moved.map((m) => m.heading), ['### Stage 1: first  [status: done]', '### Stage 4: dropped  [status: cancelled]']), JSON.stringify(planEn.moved.map((m) => m.heading)))
check('EN archive: open items and decisions stay in the folded stage', ['Decisions: took', '- [x] commit:', '- [ ] user-review', '⏳ user-review'].every((s) => planEn.result.includes(s)))
check('EN archive: "## Journal" — 8 fresh entries stay', planEn.movedJournal.length === 2 && planEn.result.includes('entry 22') && !planEn.result.includes('entry 13'), String(planEn.movedJournal.length))
check('EN archive: the journal subheading stays while the group has entries', planEn.result.includes('### Stage 1 — progress'))
check('EN archive: same moved counts as the Russian twin', planEn.moved.length === plan.moved.length + 1 && planEn.movedJournal.length === plan.movedJournal.length)
const lostEn = sourceEn.split('\n').filter((line) => line.trim() && !planEn.result.includes(line) && !planEn.moved.some((m) => m.text.includes(line)) && !planEn.movedJournal.some((e) => e.lines.includes(line)))
check('EN archive: no line is lost', !lostEn.length, JSON.stringify(lostEn.slice(0, 2)))
const secondEn = planArchive(planEn.result)
check('EN archive is idempotent', !secondEn.moved.length && !secondEn.movedJournal.length, JSON.stringify(secondEn.moved.map((m) => m.heading)))
const stubEn = planArchive('# T\n\n## Stages\n\n### Stage 1: first  [status: done]\nFull record: STAGES-ARCHIVE.md — "Stage 1: first"\n' + Array.from({ length: 30 }, (_, i) => `detail ${i}`).join('\n') + '\n')
check('EN archive: a stage with "Full record: STAGES-ARCHIVE.md" is already folded', !stubEn.moved.length)
const olderEn = planArchive(`# T\n\n## Journal\nOlder entries (3): STAGES-ARCHIVE.md — "Journal".\n\n${entriesEn.join('\n')}\n`)
check('EN archive: "Older entries (N)" counter is read and replaced, not duplicated', olderEn.movedJournal.length === 2 && (olderEn.result.match(/^(?:Старые записи|Older entries) \(/gm) ?? []).length === 1 && /\(5\)/.test(olderEn.result), olderEn.result.split('\n').slice(0, 6).join('|'))

// ── 0.16 (AC-3.3): texts that scripts write into task files — in the task language, read back by the same scripts ──
check('archive text: an en task — the stub and the counter are English', /^Full record: STAGES-ARCHIVE\.md — "Stage 1: first {2}\[status: done\]"$/m.test(planEn.result) && /^Older entries \(2\): STAGES-ARCHIVE\.md — "Journal"\.$/m.test(planEn.result) && !/[а-яё]/i.test(planEn.result), planEn.result)
check('archive text: a ru task — the stub and the counter are as before, byte for byte', /^Полная запись: STAGES-ARCHIVE\.md — «Этап 1: первый {2}\[status: done\]»$/m.test(plan.result) && /^Старые записи \(2\): STAGES-ARCHIVE\.md — «Журнал»\.$/m.test(plan.result) && !/Full record|Older entries/.test(plan.result), plan.result)
for (const [lang, text, head, moved, journal, entryWord] of [
  ['en', sourceEn, '# Stage archive\n\nFull records of closed stages, moved from STAGES.md.', '<!-- moved ', '## Journal', 'entry 13'],
  ['ru', source, '# Архив этапов\n\nПолные записи закрытых этапов, перенесённые из STAGES.md.', '<!-- перенесено ', '## Журнал', 'запись 13'],
]) {
  const dir = mkdtempSync(join(tmpdir(), `archive-${lang}-`))
  writeFileSync(join(dir, 'STAGES.md'), text)
  const run = spawnSync(process.execPath, [join(PLUGIN, 'archive-stages.mjs'), join(dir, 'STAGES.md'), '--apply'], { encoding: 'utf8' })
  const archive = readFileSync(join(dir, 'STAGES-ARCHIVE.md'), 'utf8')
  check(`archive --apply (${lang} task): the archive header and markers are in the task language`, run.status === 0 && archive.startsWith(head) && archive.includes(moved) && archive.includes(`${journal}\n${moved}`) && archive.includes(entryWord), archive.slice(0, 300))
  check(`archive --apply (${lang} task): the console is English`, /^Moved stages: \d+, journal entries: \d+, STAGES\.md: \d+ KB → \d+ KB/.test(run.stdout) && /\nArchive: .*\nBackup: /.test(run.stdout) && !/[а-яё]/i.test(run.stdout.split('\n').filter((row) => !row.startsWith('  ###')).join('\n')), run.stdout)
  const folded = readFileSync(join(dir, 'STAGES.md'), 'utf8')
  const again = spawnSync(process.execPath, [join(PLUGIN, 'archive-stages.mjs'), join(dir, 'STAGES.md')], { encoding: 'utf8' })
  check(`archive (${lang} task): the folded file is read back — nothing more to move`, !planArchive(folded).moved.length && !planArchive(folded).movedJournal.length && /Nothing to archive/.test(again.stdout), again.stdout)
  rmSync(dir, { recursive: true, force: true })
}
{
  // The run summary: headings in the task language; the same script reads the reports of both languages.
  const digestOf = (language, headLines, reportName, report) => {
    const dir = mkdtempSync(join(tmpdir(), `digest-${language}-`))
    mkdirSync(join(dir, 'T-31/checks'), { recursive: true })
    writeFileSync(join(dir, 'T-31/STAGES.md'), headLines)
    const path = join(dir, 'T-31/checks', reportName)
    writeFileSync(path, report)
    const later = new Date(Date.now() + 60_000)
    utimesSync(path, later, later)
    const text = runDigest(join(dir, 'T-31'), mkdtempSync(join(tmpdir(), 'digest-data-')), null)
    rmSync(dir, { recursive: true, force: true })
    return text
  }
  const found = [{ file: 'src/Card.tsx', hits: [{ kind: 'font weight', token: 'font-bold', line: 1 }] }]
  const enText = digestOf('en', '# T-31: task\nLanguage: en\n\n## Status: stage 1\n\n## ⚠ Awaiting user confirmation\n- default sort order\n', 'stage-1-kit-overrides.md', kits.renderReport(found, { language: 'en' }))
  check('digest: an en task — English headings', /^### Blockers — your answer needed \(0\)\n- none$/m.test(enText) && /^### Not verified \(1\)$/m.test(enText) && /^### Accepted on my own — check, expensive rollbacks first \(\d+\)$/m.test(enText) && !/[а-яё]/i.test(enText), enText)
  const ruText = digestOf('ru', '# T-31: задача\nЯзык: ru\n\n## Статус: этап 1\n\n## ⚠ Ожидают подтверждения пользователя\n- дефолт сортировки\n', 'stage-1-kit-overrides.md', kits.renderReport(found, { language: 'ru' }))
  check('digest: a ru task — the old Russian headings, byte for byte', /^### Блокеры — нужен твой ответ \(0\)\n- нет$/m.test(ruText) && /^### Не проверено \(1\)$/m.test(ruText) && /^### Принято само — проверь, дорогие откаты первыми \(\d+\)$/m.test(ruText) && !/Blockers|Not verified/.test(ruText), ruText)
  const bare = digestOf('x', '# T-31: task\n\n## Status: stage 1\n', 'pro-review-1.md', '# pro-review\nFindings: critical 0 · major 0 · minor 0\n')
  check('digest: a task without a language — Russian, as before', /^### Блокеры — нужен твой ответ \(0\)$/m.test(bare), bare)
  check('describe: the gate text is English by default, Russian for a ru task', describeGate({ name: 'smoke', command: 'yarn smoke', status: 'red', code: 1 }) === '"smoke" (`yarn smoke`) — red, code 1' && describeGate({ name: 'smoke', command: 'yarn smoke', status: 'red', code: 1 }, 'ru') === '«smoke» (`yarn smoke`) — красный, код 1')
}

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
check('ретро: metrics из журнала разнесены по этапам, 2.1 — отдельный этап', /stages: 3, stages with a metrics: line: 3/.test(retro.stdout), retro.stdout.split('\n')[2])
check('ретро: находки просуммированы по всем этапам', /findings in total: 14/.test(retro.stdout))
check('ретро: размер по добавленным строкам', /\| ≤300 \| 1 \|/.test(retro.stdout) && /\| 301–1000 \| 1 \|/.test(retro.stdout))
check('ретро: старое имя отчёта deps-2.md засчитано', /\| deps-audit \| 0 \| 0 \| 1 \|/.test(retro.stdout))
rmSync(retroRoot, { recursive: true, force: true })

process.exit(failed ? 1 : 0)
