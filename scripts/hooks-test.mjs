#!/usr/bin/env node
/**
 * Self-test of the hooks and state scripts — deterministic, no model, runs in CI.
 * The fixtures are forms that really occur in live STAGES.md files and configs: a tasks path in backticks
 * and with `~`, "Ветка: … отведена от …", `in-progress — …` statuses, dates like `22.08.2026`, subheadings
 * in the journal. A hook that silently stopped seeing its task is worse than none: it reports green,
 * and a hook that sees other people's tasks blocks parallel work.
 *
 * Russian inputs (STAGES.md text, reports, commit messages) are kept on purpose: they are the fixtures of the second
 * supported task language (Russian). The English twins next to them must give the same results.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '../plugins/stage-pipeline/scripts')
// The task directory registry and the journal snapshots are written by the hooks into the plugin data directory — a temporary one in the test.
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

// ── command parsing ──────────────────────────────────────────────────────────
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
  check(`command ${JSON.stringify(command).slice(0, 60)} → [${want}]`, same(got, want), `got [${got}]`)
}
check('git -C "a b" — repo from the option', gitInvocations('git -C "a b" commit -m x', CWD)[0]?.dir === '/repo/a b')
check('cd ../kit && git commit — repo after cd', gitInvocations('cd ../kit && git commit -m x', CWD)[0]?.dir === resolve('/repo', '../kit'))

// ── what goes into a commit ──────────────────────────────────────────────────
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
  check(`scope ${JSON.stringify(command).slice(0, 60)}`, same(got, want), `got ${JSON.stringify(got)}`)
}
check('scope: a path — with the directory of the call', commitScope(gitInvocations('cd src && git add a.ts', CWD)).specs[0]?.dir === '/repo/src')

// ── config and the STAGES.md header ──────────────────────────────────────────
// The header, status and Force block fixtures below are Russian on purpose (the second supported task language).
const TASK_PATHS = [
  ['- task_path: `.claude/tasks/` — один каталог на монорепо', '/r/.claude/tasks'],
  ['- task_path: ~/.claude/team-tasks/   # вне репо', join(homedir(), '.claude/team-tasks')],
  ['- task_path: ~/.claude/team-tasks/<ТИКЕТ>/   # глобально', join(homedir(), '.claude/team-tasks')],
  ['- task_path: docs/tasks', '/r/docs/tasks'],
  ['- main_branch: dev', '/r/.claude/tasks'],
]
for (const [line, want] of TASK_PATHS) {
  const got = taskDirFromConfig(line, '/r').replace(/\/$/, '')
  check(`task_path ${JSON.stringify(line).slice(0, 50)}`, got === want, `got ${got}`)
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
  check(`header ${JSON.stringify(line).slice(0, 60)}`, same(got, want), `got ${JSON.stringify(got)}`)
}

check('ticket in the branch name', isCurrentTask('KC-480', [], 'KC-480/feat/x') && isCurrentTask('api-layer', [], 'chore/refactor/api-layer'))
check('another ticket with the same prefix is not this task', !isCurrentTask('KC-48', [], 'KC-480/feat/x'))
check('detached HEAD — nobody\'s', !isCurrentTask('KC-480', ['KC-480/feat/x'], null))
check('open Force run block', forceActive('## Force-прогон 2026-09-01\nРежим: …'))
check('closed Force run block', !forceActive('## Force-прогон 2026-09-01 — завершён 2026-09-02\nРежим: …'))
check('run before 0.11, closed by the status', !forceActive('## Статус: 5 из 5 этапов done — force-прогон завершён, ждёт пуша\n\n## Force-прогон 2026-09-01\n'))
check('status with a date between the words', !forceActive('## Статус: force-прогон 2026-09-23 завершён — три коммита\n\n## Force-прогон 2026-09-23\n'))
check('"force run not completed" — the run is open', forceActive('## Статус: force-прогон не завершён, этап 7 в работе\n\n## Force-прогон 2026-09-01\n'))
check('all stages done, final checks — the run is open', forceActive('## Статус: все этапы done, финальные проверки\n\n## Force-прогон 2026-09-01\n\n### Этап 1: x  [status: done]\n'))
check('open Force block: date from the heading, text up to the next section', (() => {
  const block = openForceBlock('## Force-прогон 28.09.2026 — завершён 28.09.2026\nстарый\n\n## Force-прогон 2026-10-05b (второй)\nОтветы интервью: …\n\n## Этапы\n')
  return block?.date === '2026-10-05' && block.body.includes('Ответы интервью') && !block.body.includes('Этапы')
})())
check('review_model: from the config, opus by default', reviewModel('- review_model: sonnet   # дешевле') === 'sonnet' && reviewModel('- main_branch: dev') === 'opus')

// ── English twins of the markers: the same result as in Russian ──────────────
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

// ── criterion closing rules ──────────────────────────────────────────────────
// Russian fixtures of the second supported task language. The lines are live forms from STAGES.md: the outcome before the wording and after, a deferred check, smoke, a user decision.
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
  check(`criterion ${JSON.stringify(line.slice(line.indexOf('[verify'))).slice(0, 70)} → ${want}`, got === want, `got ${got}`)
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
  check(`design-checker skip ${JSON.stringify(line).slice(0, 60)} → ${want ? 'violation' : 'ok'}`, Boolean(skipViolation(line)) === want)
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
  check(`bare PASS ${JSON.stringify(text).slice(0, 50)} → [${want}]`, same(got, want), `got ${JSON.stringify(got)}`)
}

// ── git-guard and session-start on a live repo ──────────────────────────────
// The STAGES.md fixtures here are Russian (the second supported task language).
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
// `.claude/` is not in git, as in live repos: a worktree has no config, it is taken from the main tree.
write(repo, {
  '.claude/pipeline.config.md': '- task_path: `.claude/tasks/` — задачи\n- main_branch: main\n',
  '.claude/tasks/T-1/STAGES.md': stages('T-1', 'T-1/feat/a'),
  '.claude/tasks/T-2/STAGES.md': stages('T-2', 'T-2/feat/b', { force: '## Force-прогон 2026-09-24\nРежим: автономный.\n\n' }),
  '.claude/tasks/T-3/STAGES.md': stages('T-3', 'T-3/feat/c'),
})
const month = Date.now() / 1000 - 30 * 24 * 3600
utimesSync(join(repo, '.claude/tasks/T-3/STAGES.md'), month, month)

git(repo, 'checkout', '-qb', 'hotfix/x')
check('branch without a task: git add passes although T-1 is in progress', hook('git-guard.mjs', repo, 'git add -A') === 'allow')

git(repo, 'checkout', '-qb', 'T-1/feat/a')
check('branch T-1, normal mode: git add denied', hook('git-guard.mjs', repo, 'git add -A') === 'deny')
// /stage-check closes the stage in STAGES.md before it prepares the commit: the hook does not look at the stage status.
for (const status of ['done', 'todo']) {
  write(repo, { '.claude/tasks/T-1/STAGES.md': stages('T-1', 'T-1/feat/a', { status }) })
  check(`branch T-1, stage ${status}: the agent's git commit is still denied`, hook('git-guard.mjs', repo, 'git commit -m x') === 'deny')
}
write(repo, { '.claude/tasks/T-1/STAGES.md': stages('T-1', 'T-1/feat/a') })
check('branch T-1: grep "git add" is left alone', hook('git-guard.mjs', repo, 'grep -rn "git add" .') === 'allow')
check('session-start: the current branch\'s task first', /^- T-1 \(branch T-1\/feat\/a\)/m.test(hook('session-start.mjs', repo)))

git(repo, 'checkout', '-qb', 'T-2/feat/b')
check('branch T-2, force: git add passes', hook('git-guard.mjs', repo, 'git add -A') === 'allow')
check('branch T-2, force: a clean commit passes', hook('git-guard.mjs', repo, 'git commit -m x') === 'allow')
// floor-ok: fixture — a type bypass that the hook must deny on a force commit
const ESCAPE = 'export const a = 1 as any\n'
// floor-ok: fixture — a saved page with minified JS in the repo root, not part of the commit
const JUNK = { 'Saved PR_files/02v-48e5.js': 'try{x()}catch{}\n' }
write(repo, { 'src/a.ts': ESCAPE })
check('branch T-2, force: a commit with a type bypass is denied by floor-guard', hook('git-guard.mjs', repo, 'git commit -am x') === 'deny')
check('branch T-2, force: cd into a subdirectory and git add — the path is relative to it', hook('git-guard.mjs', repo, 'cd src && git add a.ts && git commit -m x') === 'deny')
write(repo, { '.claude/tasks/T-2/STAGES.md': stages('T-2', 'T-2/feat/b', { status: 'done', force: '## Force-прогон 2026-09-24\nРежим: автономный.\n\n' }) })
check('branch T-2, force, stage already done: floor-guard is still on the commit', hook('git-guard.mjs', repo, 'git commit -am x') === 'deny')
write(repo, { 'src/a.ts': 'export const a = 2\n', ...JUNK })
check('branch T-2, force: junk outside the commit does not deny git add of paths', hook('git-guard.mjs', repo, 'git add src/a.ts && git commit -m x') === 'allow')
check('branch T-2, force: junk outside the commit does not deny commit -a', hook('git-guard.mjs', repo, 'git commit -am x') === 'allow')
check('branch T-2, force: git add -A takes the junk into the commit — denied', hook('git-guard.mjs', repo, 'git add -A && git commit -m x') === 'deny')
git(repo, 'add', 'Saved PR_files/02v-48e5.js')
check('branch T-2, force: junk already in the index — denied', hook('git-guard.mjs', repo, 'git commit -m x') === 'deny')
git(repo, 'reset', '-q')
rmSync(join(repo, 'Saved PR_files'), { recursive: true, force: true })
git(repo, 'checkout', '-q', '--', 'src/a.ts')
write(repo, { '.claude/tasks/T-2/STAGES.md': stages('T-2', 'T-2/feat/b', { force: '## Force-прогон 2026-09-24 — завершён 2026-09-25\n\n' }) })
check('branch T-2, force closed: normal mode again', hook('git-guard.mjs', repo, 'git add -A') === 'deny')

git(repo, 'checkout', '-qb', 'T-3/feat/c')
check('an abandoned task (30 days) blocks nothing', hook('git-guard.mjs', repo, 'git add -A') === 'allow')
const listing = hook('session-start.mjs', repo)
check('session-start: an abandoned task is not listed', !/T-3/.test(listing) && /T-1/.test(listing), JSON.stringify(listing))

git(repo, 'checkout', '-q', 'main')
const worktree = join(root, 'wt')
git(repo, 'worktree', 'add', '-q', '-b', 'T-1/feat/a-2', worktree)
check('worktree without .claude/: task T-1 is visible, git add denied', hook('git-guard.mjs', worktree, 'git add -A') === 'deny')
check('a commit into a neighbouring repo via cd — by its state', hook('git-guard.mjs', worktree, `cd ${repo} && git commit -m x`) === 'allow')

const plain = join(root, 'plain')
mkdirSync(plain)
git(plain, 'init', '-q')
check('repo without the pipeline: the hooks are silent', hook('git-guard.mjs', plain, 'git add -A') === 'allow' && hook('session-start.mjs', plain) === '')
check('repo without the pipeline: a signature in the commit is none of our business', hook('git-guard.mjs', plain, 'git commit -m "x\n\nCo-Authored-By: X <x@y.z>"') === 'allow')
rmSync(root, { recursive: true, force: true })

// ── 0.12 gates: the journal, subagent launches, signatures, a task over two repos ──────
// Russian fixtures (the second supported task language).
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
check('journal: an old violation is in the snapshot, the hook is silent', gate('Edit', { file_path: stagesPath }).decision === 'allow')
write(app, { '.claude/tasks/T-7/STAGES.md': journal('- `AC-2.1` WHEN новое THEN новое — [verify: devtools-verify] ✅ pro-review по коду\n') })
const caught = gate('Edit', { file_path: stagesPath })
check('journal: a new "✅ pro-review по коду" on a devtools criterion — returned to the agent', caught.decision === 'block' && /AC-2\.1/.test(caught.text) && !/AC-1\.1/.test(caught.text), caught.text)
check('journal: an edit via Bash with the STAGES.md path — too', gate('Bash', { command: `python3 fix.py ${stagesPath}` }).decision === 'block')
check('journal: code and commands without the journal — silent', gate('Edit', { file_path: join(app, 'src/a.ts') }).decision === 'allow' && gate('Bash', { command: 'git status' }).decision === 'allow')
write(app, { '.claude/tasks/T-7/STAGES.md': journal('- `AC-2.1` WHEN новое THEN новое — [verify: devtools-verify] ⏳ devtools-verify\n') })
check('journal: fixed to ⏳ — silent', gate('Edit', { file_path: stagesPath }).decision === 'allow')
const report = join(app, '.claude/tasks/T-7/checks/pro-review-2.md')
write(app, { '.claude/tasks/T-7/checks/pro-review-2.md': '## AC\n2.1 PASS · 2.2 PASS · 2.3 PASS (`a.ts:3`, a=1)\n' })
const bare = gate('Write', { file_path: report })
check('report: bare PASS returned to the agent, PASS with a measurement not', bare.decision === 'block' && /AC-2\.1, AC-2\.2/.test(bare.text) && !/AC-2\.3/.test(bare.text), bare.text)

const agentHook = (subagent_type, prompt, model) =>
  runHook('agent-guard.mjs', { cwd: app, tool_name: 'Agent', tool_input: { subagent_type, prompt, ...(model ? { model } : {}) } }).decision
check('whole-branch pro-review without model — denied (the agent is on sonnet)', agentHook('stage-pipeline:pro-review', 'Тикет T-7, режим whole-branch. База origin/main.') === 'deny')
check('whole-branch pro-review on opus — passes', agentHook('stage-pipeline:pro-review', 'Тикет T-7, whole-branch mode.', 'opus') === 'allow')
check('stage pro-review — no model required', agentHook('stage-pipeline:pro-review', 'Тикет T-7, режим stage, этап 2. Перепроверка после whole-branch Request changes.') === 'allow')
write(app, { '.claude/pipeline.config.local.md': '- review_model: sonnet\n' })
check('review_model: sonnet in the config — whole-branch without model passes', agentHook('stage-pipeline:pro-review', 'Режим: whole-branch.') === 'allow')
rmSync(join(app, '.claude/pipeline.config.local.md'))
const withForce = (heading, body) => write(app, { '.claude/tasks/T-7/STAGES.md': journal('', `${heading}\n${body}\n\n`) })
withForce('## Force-прогон 2026-10-05', 'Режим: автономный.\nОтветы интервью: ветка — от dev')
check('stage-implement: a new Force block without "Подтверждено:" — denied', agentHook('stage-pipeline:stage-implement', 'Тикет T-7, этап 2, режим implement') === 'deny')
const unconfirmed = runHook('agent-guard.mjs', { cwd: app, tool_name: 'Agent', tool_input: { subagent_type: 'stage-pipeline:stage-implement', prompt: 'Тикет T-7, этап 2' } }).text
check('stage-implement: the denial does not require a second "yes" after the interview', /interview answers/.test(unconfirmed) && /Do not ask the user for a separate confirmation/.test(unconfirmed), unconfirmed)
withForce('## Force-прогон 2026-10-05', 'Режим: автономный.\nОтветы интервью: ветка — от dev\nПодтверждено: 2026-10-05 — «да, гони»')
check('stage-implement: confirmation is there — passes', agentHook('stage-pipeline:stage-implement', 'Тикет T-7, этап 2') === 'allow')
withForce('## Force-прогон 2026-09-24', 'Режим: автономный.')
check('stage-implement: a block opened before 0.12 is left alone', agentHook('stage-pipeline:stage-implement', 'Тикет T-7, этап 2') === 'allow')
check('other agents — silent', agentHook('stage-pipeline:devtools-verify', 'whole-branch mode') === 'allow')
withForce('## Force run 2026-10-05', 'Mode: autonomous.\nInterview answers: branch — from dev')
check('EN stage-implement: new Force block without "Confirmed:" — denied', agentHook('stage-pipeline:stage-implement', 'Ticket T-7, stage 2, implement mode') === 'deny')
withForce('## Force run 2026-10-05', 'Mode: autonomous.\nInterview answers: branch — from dev\nConfirmed: 2026-10-05 — "yes, go"')
check('EN stage-implement: "Confirmed:" is there — passes', agentHook('stage-pipeline:stage-implement', 'Ticket T-7, stage 2') === 'allow')
withForce('## Force run 2026-10-05', 'Mode: autonomous.\n- **Confirmed**: 2026-10-05 — "yes"')
check('EN stage-implement: bold "**Confirmed**:" bullet — passes', agentHook('stage-pipeline:stage-implement', 'Ticket T-7, stage 2') === 'allow')
    withForce('## Force run Oct 17, 2026', 'Mode: autonomous.\nInterview answers: branch — from dev')
    check('stage-implement: an unreadable date in the Force heading without "Confirmed:" — denied', agentHook('stage-pipeline:stage-implement', 'Ticket T-7, stage 2') === 'deny')
    withForce('## Force run 10/17/2026', 'Mode: autonomous.\nConfirmed: 2026-10-17 — "yes"')
    check('stage-implement: an unreadable date with "Confirmed:" — passes', agentHook('stage-pipeline:stage-implement', 'Ticket T-7, stage 2') === 'allow')
withForce('## Force run 2026-10-05 — completed 2026-10-05', 'Mode: autonomous.')
check('EN stage-implement: closed block is not an open run — passes', agentHook('stage-pipeline:stage-implement', 'Ticket T-7, stage 2') === 'allow')
check('EN whole-branch pro-review: "Mode: whole-branch" without model — denied', agentHook('stage-pipeline:pro-review', 'Ticket T-7, Mode: whole-branch.') === 'deny')

withForce('## Force-прогон 2026-10-05', 'Режим: автономный.\nПодтверждено: 2026-10-05 — «да»')
write(app, { 'src/a.ts': 'export const a = 2\n', 'msg.txt': 'T-7: правка\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n' })
const commit = (cwd, command) => runHook('git-guard.mjs', { cwd, tool_input: { command } }).decision
check('force: Co-Authored-By in a message heredoc — denied', commit(app, `git commit -am "$(cat <<'EOF'\nT-7: правка\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"`) === 'deny')
check('force: a signature in the -F file — denied', commit(app, 'git commit -a -F msg.txt') === 'deny')
check('force: a clean message — passes', commit(app, 'git commit -am "T-7: правка"') === 'allow')
git(app, 'checkout', '-q', '--', 'src/a.ts')
git(app, 'checkout', '-qb', 'hotfix/y')
check('branch without a task in a pipeline repo: a signature is denied too', commit(app, 'git commit -m "fix\n\nCo-Authored-By: X <x@y.z>"') === 'deny')

// A task over two repos: STAGES.md is in the task directory of app, the commit is in the neighbouring webapp.
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
check('neighbouring repo: a task from the registry — normal mode, git add denied', commit(web, 'git add -A') === 'deny')
check('neighbouring repo: session-start shows the task and the path to it', /KC-9 \(branch KC-9\/feat\/x\)/.test(runHook('session-start.mjs', { cwd: web }).text))
git(web, 'checkout', '-q', 'master')
check('neighbouring repo on master: "Ветка: master" of another task does not capture it', commit(web, 'git add -A') === 'allow')
git(web, 'checkout', '-qb', 'KC-10/feat/y')
check('neighbouring repo: the ticket is in the branch but the repo\'s STAGES.md does not name it — not its own', commit(web, 'git add -A') === 'allow')

// Work after force is closed: a commit on the task branch that the journal does not know.
git(app, 'checkout', '-q', 'T-7/feat/g')
withForce('## Force-прогон 2026-10-05 — завершён 2026-10-05', 'Режим: автономный.')
write(app, { 'src/b.ts': 'export const b = 1\n' })
git(app, 'add', 'src/b.ts')
git(app, 'commit', '-qm', 'T-7: правка после прогона без этапа')
const after = runHook('session-start.mjs', { cwd: app }).text
check('session-start: a commit after force bypassing the journal — named', /commits on the task's branches that are in neither STAGES\.md nor PR\.md \(1\)/.test(after) && /правка после прогона/.test(after), after)
write(app, { '.claude/tasks/T-7/STAGES.md': journal('- 2026-10-05 — догон: `T-7: правка после прогона без этапа`, pro-review Approve\n', '## Force-прогон 2026-10-05 — завершён 2026-10-05\n\n') })
check('session-start: the commit is recorded in the journal — silent', !/мимо журнала|нет ни в STAGES/.test(runHook('session-start.mjs', { cwd: app }).text))
// main_branch: main in the config while PRs go to dev: other people's PRs merged there are not the task's work.
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
check('session-start: base — the nearest integration branch, another PR does not count', /commits on the task's branches that are in neither STAGES\.md nor PR\.md \(1\)/.test(nearest) && !/чужая фича/.test(nearest), nearest)
rmSync(gRoot, { recursive: true, force: true })

// ── 0.13: force does not wait for confirmations ──────────────────────────────
// Russian fixtures (the second supported task language).
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
for (const [command, want] of KILLS) check(`lifting by name ${JSON.stringify(command).slice(0, 50)} → ${want}`, nameKill(command) === want, `got ${nameKill(command)}`)

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
  check(`ask ${JSON.stringify(command).slice(0, 50)} → ${want}`, got === want, `got ${got}`)
}
check('ask: a bare Bash and Bash(*) do not turn into "deny everything"', bashRulePattern('Bash') === null && bashRulePattern('Bash(*)') === null)

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
check('force: pkill is denied at once, with a hint about PID', killed.decision === 'deny' && /kill <PID>/.test(killed.text), killed.text)
check('force: killall without an ask rule — denied too', force(fApp, 'killall node').decision === 'deny')
check('force: kill by PID passes', force(fApp, 'kill 4242').decision === 'allow')
const pushed = force(fApp, 'git push -u origin T-9/feat/f')
check('force: git push under the user\'s ask — denied, the rule file is named', pushed.decision === 'deny' && pushed.text.includes(join(fHome, '.claude/settings.json')), pushed.text)
check('force: gh under the project\'s ask — denied', /blocker/.test(force(join(fApp, 'src'), 'gh pr view 1').text))
check('force: ordinary commands are left alone', force(fApp, 'git status && pnpm test').decision === 'allow')
git(fApp, 'checkout', '-qb', 'T-10/feat/n')
check('normal mode: pkill is not denied — the user is nearby and will answer themselves', force(fApp, 'pkill -f x').decision === 'allow')
git(fApp, 'checkout', '-q', 'main')
check('branch without a task: the hook is silent', force(fApp, 'git push').decision === 'allow')
write(fApp, { '.claude/tasks/T-9/STAGES.md': stages('T-9', 'T-9/feat/f', { force: '## Force-прогон 2026-10-03 — завершён с блокерами 2026-10-03\n\n' }) })
git(fApp, 'checkout', '-q', 'T-9/feat/f')
check('force "завершён с блокерами" — closed, the hook is silent', force(fApp, 'pkill -f x').decision === 'allow')
rmSync(fRoot, { recursive: true, force: true })

// ── 0.14: findings outcome, unverified, frames ───────────────────────────────
// Russian fixtures (the second supported task language).
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
  check(`summary ${name}: critical/major/minor ${want}`, same([got.critical, got.major, got.minor], want), JSON.stringify(got))
}
check('FAIL on a criterion is a finding, "было FAIL" is not', same(jc.failedCriteria('- `AC-2.1` - FAIL по 2 major\n- AC-3.1 — PASS (было FAIL)\n'), ['AC-2.1']))
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
for (const [entry, want] of DISPOSITIONS) check(`outcome "${entry.slice(2, 40)}" → ${want}`, jc.disposition(entry) === want, jc.disposition(entry))
const REVIEW = '# pro-review, этап 1\nНаходки: critical 0 · major 2 · minor 0\n\n### 🟠 M-1 a.ts:1 — дубль\n### 🟠 M-2 b.ts:2 — гонка\n'
const missing = jc.ledgerViolations(REVIEW, 'pro-review-1.md', { complete: true })
check('outcome: two majors without lines — ledger-missing', missing.length === 1 && missing[0].rule === 'ledger-missing', JSON.stringify(missing))
check('outcome: one line for two majors — still incomplete', jc.ledgerViolations(`${REVIEW}\n## Итог находок\n- M-1 — исправлено: a.ts:3\n`, 'pro-review-1.md', { complete: true }).length === 1)
check('outcome: both closed — clean', jc.ledgerViolations(`${REVIEW}\n## Итог находок\n- M-1 — исправлено: a.ts:3\n- M-2 — B1\n`, 'pro-review-1.md', { complete: true }).length === 0)
check('outcome: "оставляю" — ledger-parked even without completeness', jc.ledgerViolations(`${REVIEW}\n## Итог находок\n- M-1 — оставляю, minor по сути\n`, 'pro-review-1.md')[0]?.rule === 'ledger-parked')
check('✅ with a caveat — ac-caveat', jc.caveatViolation('- `AC-2.7` WHEN тема THEN ок — [verify: devtools-verify] ✅ devtools-verify (тёмная тема выпадашек не снята)')?.rule === 'ac-caveat')
check('✅ and an explicit ⏳ on the unverified — not a caveat', jc.caveatViolation('- `AC-2.7` — ✅ devtools-verify (light) · ⏳ devtools-verify (dark не снят)') === null)
check('[live] because of "нет броней" — live-no-data', jc.noDataViolation('- `AC-4.5` WHEN бар THEN статус — [live: user-side] — нет броней с police на аккаунте')?.rule === 'live-no-data')
check('[live] with a substituted fixture — not a violation', jc.noDataViolation('- `AC-4.5` — ⏳ нет броней на стенде, проверено на подменённом ответе (фикстура)') === null)
check('devtools without geometry lines — no-geometry', jc.runtimeViolations('# devtools\nНаходки: critical 0 · major 0 · minor 0\n', 'devtools-verify-3.md')[0]?.rule === 'no-geometry')
check(
  'devtools with geometry and "нет данных" in the unverified — live-no-data',
  same(jc.runtimeViolations('# d\nНаходки: critical 0 · major 0 · minor 0\ngeometry 1440: overflow 0 · zero-gap 0 · clipped 0\n## Не удалось проверить\n- AC-3.2 — нет данных на стенде\n', 'stage-3-devtools-verify.md').map((v) => v.rule), ['live-no-data']),
)
check('devtools skip — geometry not required', jc.runtimeViolations('# devtools-verify\nskip: MCP недоступен\n', 'devtools-verify-2.md').length === 0)
check('a checker report without a summary — report-summary', jc.summaryViolation('# i18n\nВердикт: 3 дефекта\n', 'i18n-sweep-2.md')?.rule === 'report-summary')
check('not a checker report (a stand probe) — no summary needed', jc.summaryViolation('# probe\n', 'stand-probe-2026-10-03.md') === null)
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
  // A report of the previous version: a finding without an outcome, referenced by an old journal line.
  '.claude/tasks/T-11/checks/pro-review-0.md': '# pro-review\nИтог: 🔴0 · 🟠1\n### 🟠 M-1 a.ts:1 — дубль\n',
})
const past = Date.now() / 1000 - 3600
utimesSync(join(lTask, 'checks/pro-review-0.md'), past, past)
// Snapshot v1 (0.12–0.13): only ✅ lines — the new version appends the current lines to it instead of nitpicking at them.
const v1 = join(DATA, 'journal-baseline')
mkdirSync(v1, { recursive: true })
const { createHash } = await import('node:crypto')
const { realpathSync } = await import('node:fs')
writeFileSync(join(v1, `${createHash('sha1').update(realpathSync(lTask)).digest('hex').slice(0, 16)}.json`), JSON.stringify({ taskDir: lTask, created: new Date(past * 1000).toISOString(), lines: [] }))
git(lApp, 'checkout', '-qb', 'T-11/feat/l')
const lGate = (file) => runHook('journal-gate.mjs', { cwd: lApp, tool_name: 'Write', tool_input: { file_path: join(lTask, file) } })
check('snapshot v1 → v2: the old line "[x] pro-review … компромисс" is not nitpicked', lGate('STAGES.md').decision === 'allow', lGate('STAGES.md').text)
check('force commit: an old report without an outcome (before the snapshot) does not interfere', hook('git-guard.mjs', lApp, 'git commit --allow-empty -m x') === 'allow')

const future = Date.now() / 1000 + 5
const writeReport = (name, text) => {
  write(lApp, { [`.claude/tasks/T-11/checks/${name}`]: text })
  utimesSync(join(lTask, 'checks', name), future, future)
}
writeReport('pro-review-1.md', REVIEW)
check('writing a report with findings without an outcome is not a block (the outcome is written after the fix-loop)', lGate('checks/pro-review-1.md').decision === 'allow', lGate('checks/pro-review-1.md').text)
const denied = runHook('git-guard.mjs', { cwd: lApp, tool_input: { command: 'git commit --allow-empty -m x' } })
check('force commit: a new report without an outcome — denied', denied.decision === 'deny' && /pro-review-1\.md/.test(denied.text), denied.text)
writeReport('pro-review-1.md', `${REVIEW}\n## Итог находок\n- M-1 — оставляю\n- M-2 — исправлено: b.ts:4\n`)
const parked = lGate('checks/pro-review-1.md')
check('outcome "оставляю" — returned in the same turn', parked.decision === 'block' && /decision not to fix/.test(parked.text), parked.text)
writeReport('pro-review-1.md', `${REVIEW}\n## Итог находок\n- M-1 — исправлено: a.ts:3\n- M-2 — исправлено: b.ts:4\n`)
check('full outcome — the force commit passes', hook('git-guard.mjs', lApp, 'git commit --allow-empty -m x') === 'allow')
writeReport('devtools-verify-1.md', '# devtools-verify, этап 1\nНаходки: critical 0 · major 0 · minor 0\n')
check('runtime report without geometry — returned', /geometry/.test(lGate('checks/devtools-verify-1.md').text))
writeReport('pro-review-2.md', REVIEW)
write(lApp, { '.claude/tasks/T-11/STAGES.md': lStages('- [x] pro-review (`checks/pro-review-2.md` — Request changes)\n') })
check('a new mark "[x] pro-review (checks/…)" with an incomplete outcome — returned', /pro-review-2\.md/.test(lGate('STAGES.md').text))
writeReport('pro-review-2.md', `${REVIEW}\n## Итог находок\n- M-1 — исправлено: a.ts:3\n- M-2 — B1\n`)
write(lApp, { '.claude/tasks/T-11/STAGES.md': lStages('', forceBlock('## Force-прогон 2026-10-04 — завершён 2026-10-04', '\n- B1 — гонка M-2 — нужен ответ бэкенда — рекомендую очередь')) })
const closedEarly = lGate('STAGES.md')
check('"завершён" with an open blocker — returned', closedEarly.decision === 'block' && /completed with blockers/.test(closedEarly.text), closedEarly.text)
write(lApp, { '.claude/tasks/T-11/STAGES.md': lStages('- `AC-1.2` WHEN бар THEN статус — ⏳ devtools-verify (подставить нечем)\n', forceBlock('## Force-прогон 2026-10-04 — завершён с блокерами 2026-10-04', '\n- B1 — гонка M-2 — нужен ответ бэкенда — рекомендую очередь')) })
const closed = runHook('journal-gate.mjs', { cwd: lApp, tool_name: 'Edit', tool_input: { file_path: join(lTask, 'STAGES.md') } })
const digestFile = join(lTask, 'RUN-DIGEST.md')
check(
  'closing a run with blockers — the short summary in the context: the blocker in full, the unverified as a number by stage, the path to the file',
  closed.decision === 'message' && /Блокеры — нужен твой ответ \(1\)/.test(closed.text) && /этап 1 — 1/.test(closed.text) && closed.text.includes(digestFile) && !/AC-1\.2/.test(closed.text),
  `${closed.decision}: ${closed.text.slice(0, 400)}`,
)
check('closing a run with blockers — the full digest is written to RUN-DIGEST.md (the criterion line is there)', existsSync(digestFile) && /AC-1\.2/.test(readFileSync(digestFile, 'utf8')) && /^# Дайджест прогона/m.test(readFileSync(digestFile, 'utf8')))
check('RUN-DIGEST.md is not a checker report: reportNames does not list it', !jc.reportNames(lTask).includes('RUN-DIGEST.md'))
check('writing RUN-DIGEST.md is not a journal event: the hook stays silent', runHook('journal-gate.mjs', { cwd: lApp, tool_name: 'Write', tool_input: { file_path: digestFile } }).decision === 'allow')
check('the run summary — once per closing', runHook('journal-gate.mjs', { cwd: lApp, tool_name: 'Edit', tool_input: { file_path: join(lTask, 'STAGES.md') } }).decision === 'allow')

// English twins of the blockers and of the Force block closing in journal-gate.
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

// frames-guard: the frames of the devtools-verify agent, opened by Read, and unopened ones.
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
check('frames-guard: one frame not opened — the agent continues', unseen.decision === 'block' && /b\.png/.test(unseen.text) && !/a\.png/.test(unseen.text), unseen.text)
check('frames-guard: all frames opened — the agent finishes', frames('stage-pipeline:devtools-verify', [a, b]).decision === 'allow')
check('frames-guard: other agents are left alone', frames('stage-pipeline:pro-review', []).decision === 'allow')
rmSync(lRoot, { recursive: true, force: true })

// ── 0.15: criteria in the plan, the kit view, CI gates, work after "done" ──────
// Russian fixtures (the second supported task language).
const LIKES = [
  ['- `AC-5.3` WHEN сохранить THEN как у эксперта — [verify: devtools-verify]', 'AC-5.3'],
  ['- D11: «Сохранить» — как у эксперта (expert-lead-card-sheet.tsx:227)', null],
  ['- `AC-2.1` WHEN карточка THEN отступы как в макете — [verify: figma-compare]', null],
  ['- `AC-2.2` WHEN поля нет THEN прочерк, так как в API его нет — [verify: pro-review]', null],
  ['- Решение: активная «Сохранить» — как сейчас в шторке', 'decision'],
  ['- 2026-10-01 — сделал как у эксперта', null],
]
for (const [line, want] of LIKES) check(`"как у X" ${line.slice(2, 46)} → ${want}`, (jc.likeViolation(line)?.id ?? null) === want, JSON.stringify(jc.likeViolation(line)))

const gates = await import(join(PLUGIN, 'ci-gates.mjs'))
const GATES_TABLE =
  '## Commands\n- test: `pnpm test`\n\n## Гейты CI (ронять нельзя)\n\n| Проверка | Команда | Что ловит |\n| --- | --- | --- |\n| Юниты | `pnpm test` | словари |\n' +
  '| **Смоук** | `pnpm --filter smoke exec playwright test` | маршруты |\n\n## Архитектура\n| слой | `не гейт` |\n'
const parsed = gates.gateCommands(GATES_TABLE)
check('gates: the "Гейты CI" table — names and commands up to the next section', same(parsed, [{ name: 'Юниты', command: 'pnpm test' }, { name: 'Смоук', command: 'pnpm --filter smoke exec playwright test' }]), JSON.stringify(parsed))
check('gates: without a table — e2e from Commands', same(gates.gateCommands('- test: `yarn test`\n- e2e: `yarn e2e:test` / `yarn e2e:test:stg` (Playwright)\n'), [{ name: 'e2e', command: 'yarn e2e:test' }]))
check('gates: "e2e: НЕТ" is not a gate', gates.gateCommands('- e2e: НЕТ # тестов нет\n- test: yarn test\n').length === 0)
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
check('kit-overrides: new and changed files, without the kit directory and stories', same(kitFound.map(({ file }) => file), ['src/Card.tsx']), JSON.stringify(kitFound.map(({ file }) => file)))
const tokens = [...new Set(kitFound[0]?.hits.map(({ token }) => token))].sort()
check('kit-overrides: weight, case, font size, radius, padding, width; a token via var and a comment — no', same(tokens, ['font-bold', 'max-w-[70ch]', 'px-[18px]', 'rounded-[9px]', 'text-[13px]', 'uppercase'].sort()), JSON.stringify(tokens))
check('kit-overrides: "kit_overrides: off" — silent in the kit repo', kits.scanOverrides(kApp, { config: '- kit_overrides: off\n' }).length === 0)
const rendered = kits.renderReport(kitFound, { previous: '# old\n## Итог находок\n- K-1 — исправлено: src/Card.tsx:1\n' })
check('kit-overrides: the report with the checker summary, the previous run\'s outcome is kept', jc.findingCounts(rendered, 'stage-1-kit-overrides.md').major === 1 && /## Итог находок\n- K-1 — исправлено/.test(rendered))
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
check('force commit: kit overrides without a report — denied', noKitReport.decision === 'deny' && /src\/Card\.tsx/.test(noKitReport.text) && /kit-override-scan/.test(noKitReport.text), noKitReport.text)
const kReport = join(kTask, 'checks/stage-1-kit-overrides.md')
mkdirSync(dirname(kReport), { recursive: true })
spawnSync(process.execPath, [join(PLUGIN, 'kit-override-scan.mjs'), '--out', kReport], { cwd: kApp })
{
  // The report is a task file: its language is the task language. A ru task gets the old text, byte for byte.
  const ruReport = readFileSync(kReport, 'utf8')
  check(
    'kit-overrides: the report of a ru task is in Russian, as before',
    ruReport.startsWith('# kit-overrides: рабочее дерево против HEAD\nНаходки: critical 0 · major 1 · minor 0\n\nПереопределения кита и ручная типографика') &&
      /\| K-1 \| `src\/Card\.tsx` \| .*вес шрифта.*регистр/.test(ruReport) &&
      /\n## Не удалось проверить\n- стили, собранные в рантайме/.test(ruReport) &&
      !/Findings|Could not verify/.test(ruReport),
    ruReport,
  )
  check('kit-overrides: the report of a ru task is read back (summary, language)', jc.findingCounts(ruReport, 'stage-1-kit-overrides.md').major === 1 && jc.languageViolation(ruReport, 'stage-1-kit-overrides.md', 'ru') === null)
  check(
    'kit-overrides: a ru summary with an !important hit — the kind comes from RULES, not undefined',
    kits.summarize([{ kind: '!important', token: '!important', line: 1 }, { kind: 'font weight', token: 'font-bold', line: 2 }], 'ru') === '!important (`!important`), вес шрифта (`font-bold`)' &&
      kits.summarize([{ kind: 'new kind', token: 'x', line: 1 }], 'ru') === 'new kind (`x`)',
  )
}
// Read at the moment of use: a time fixed once goes stale on a slow run, and the report falls before the task snapshot.
const touchAhead = (path) => utimesSync(path, Date.now() / 1000 + 5, Date.now() / 1000 + 5)
touchAhead(kReport)
const noKitLedger = kCommit('git add -A && git commit -m "T-12: карточка"')
check('force commit: a kit-overrides report exists, no outcome — denied', noKitLedger.decision === 'deny' && /stage-1-kit-overrides\.md/.test(noKitLedger.text), noKitLedger.text)
writeFileSync(kReport, `${readFileSync(kReport, 'utf8')}\n## Итог находок\n- K-1 — ложная: эталон src/Other.tsx:1 — тот же font-bold\n`)
touchAhead(kReport)
const kitOk = kCommit('git add -A && git commit -m "T-12: карточка"')
check('force commit: the outcome is proven by the reference — passes', kitOk.decision === 'allow', kitOk.text)
git(kApp, 'add', '-A')
git(kApp, 'commit', '-qm', 'T-12: карточка')
const cardSha = git(kApp, 'rev-parse', 'HEAD').trim()

rmSync(join(kApp, 'src/Old.tsx'))
const noParity = kCommit('git commit -am "T-12: убрал старую секцию"')
check('force commit: a UI component deleted without a parity table — denied', noParity.decision === 'deny' && /`Old`/.test(noParity.text), noParity.text)
const PARITY = '| Паритет | было `Old` → перенесено в Card (`AC-1.P1`) |\n'
write(kApp, { '.claude/tasks/T-12/STAGES.md': kStages({ extra: PARITY }) })
check('force commit: Old in the parity table — passes', kCommit('git commit -am "T-12: убрал старую секцию"').decision === 'allow')
git(kApp, 'commit', '-qam', 'T-12: убрал старую секцию')
const oldSha = git(kApp, 'rev-parse', 'HEAD').trim()

const dv = join(kTask, 'checks/stage-1-devtools-verify.md')
const DV = '# devtools-verify, этап 1\nНаходки: critical 0 · major 0 · minor 0\ngeometry 1440: overflow 0 · zero-gap 0 · clipped 0\n'
writeFileSync(dv, DV)
check('devtools-verify on a stage with a "Эталон вида" without style-diff — no-style-diff', jc.reportViolations(dv).some(({ rule }) => rule === 'no-style-diff'), JSON.stringify(jc.reportViolations(dv)))
writeFileSync(dv, `${DV}style-diff 1440: roles 4 · differ 0\n`)
check('devtools-verify with a style-diff line — clean', jc.reportViolations(dv).length === 0, JSON.stringify(jc.reportViolations(dv)))

// CI gate: "завершён" only with a green run on the current HEAD.
const JOURNALED = `${PARITY}- [x] commit: \`${cardSha.slice(0, 8)}\` T-12: карточка\n- [x] commit: \`${oldSha.slice(0, 8)}\` T-12: убрал старую секцию\n`
const kGate = () => runHook('journal-gate.mjs', { cwd: kApp, tool_name: 'Edit', tool_input: { file_path: join(kTask, 'STAGES.md') } })
write(kApp, { '.claude/tasks/T-12/STAGES.md': kStages({ extra: JOURNALED, heading: `## Force-прогон ${today} — завершён ${today}` }) })
const redGate = kGate()
check('closing "завершён" without a CI gate run — returned', redGate.decision === 'block' && /Смоук/.test(redGate.text) && /never ran/.test(redGate.text), redGate.text)
const kConfig = readFileSync(join(kApp, '.claude/pipeline.config.md'), 'utf8')
write(kApp, { '.claude/tasks/T-12/STAGES.md': kStages({ extra: JOURNALED, heading: `## Force-прогон ${today} — завершён с блокерами ${today}`, blockers: '\n- B1 — Смоук: нужен стейджинг, локально не поднимается' }) })
check('"с блокерами": a non-green gate named as a blocker is not a violation', gates.gateCloseViolations(DATA, kApp, kConfig, kTask).length === 0)
spawnSync(process.execPath, [join(PLUGIN, 'run-check.mjs'), '--', 'node -e "process.exit(0)"'], { cwd: kApp, encoding: 'utf8', env: { ...process.env, STAGE_PIPELINE_RESOURCES: 'normal' } })
check('run-check: a run on a clean tree is recorded — the gate is green', gates.gateStatus(DATA, kApp, kConfig)[0]?.status === 'green', JSON.stringify(gates.gateStatus(DATA, kApp, kConfig)))
write(kApp, { '.claude/tasks/T-12/STAGES.md': kStages({ extra: JOURNALED, heading: `## Force-прогон ${today} — завершён ${today}` }) })
const greenGate = kGate()
check('the gate is green on HEAD — closing passes, gates in the summary', greenGate.decision === 'message' && /Гейты CI на HEAD \(1 из 1/.test(greenGate.text), `${greenGate.decision}: ${greenGate.text.slice(0, 300)}`)

// A commit rebuilt without a signature is the same commit: the journal recognizes it by content.
git(kApp, 'commit', '--amend', '-qm', 'секция: перенос в карточку')
const rebuilt = runHook('session-start.mjs', { cwd: kApp }).text
check('session-start: a rebuilt commit with another title is not "bypassing the journal"', !/мимо журнала|нет ни в STAGES/.test(rebuilt), rebuilt)
check('the gate after a new commit with the same tree is still green', gates.gateStatus(DATA, kApp, kConfig)[0]?.status === 'green')

// A rework after "done" straight into the integration branch under another ticket.
git(kApp, 'checkout', '-q', 'main')
git(kApp, 'merge', '-q', '--no-ff', 'T-12/feat/k', '-m', 'Merge T-12')
write(kApp, { 'src/Card.tsx': 'export const Card = () => null\n' })
const later = new Date(Date.now() + 120_000).toISOString()
execFileSync('git', ['commit', '-qam', 'Fix(T-99): карточка обрезалась'], { cwd: kApp, env: { ...process.env, GIT_AUTHOR_DATE: later, GIT_COMMITTER_DATE: later } })
const elsewhere = runHook('session-start.mjs', { cwd: kApp }).text
check('session-start on main: a task-file fix under another ticket after closing — named', /T-12 \(closed /.test(elsewhere) && /Fix\(T-99\)/.test(elsewhere), elsewhere)
check('session-start: the same line is not repeated a second time', !/T-12 \(закрыта/.test(runHook('session-start.mjs', { cwd: kApp }).text))
rmSync(kRoot, { recursive: true, force: true })

// ── English twin of the force run with gates, parity and the visual reference ────
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
touchAhead(eReport)
const noKitLedgerEn = eCommit('git add -A && git commit -m "T-13: card"')
check('EN force commit: report without an outcome — denied', noKitLedgerEn.decision === 'deny' && /stage-1-kit-overrides\.md/.test(noKitLedgerEn.text), noKitLedgerEn.text)
writeFileSync(eReport, `${readFileSync(eReport, 'utf8')}\n## Findings outcome\n- K-1 — false positive: reference src/Other.tsx:1 — the same font-bold\n`)
touchAhead(eReport)
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

// ── 0.16: English phrase heuristics and the report language ───────────
// For each heuristic there is a positive English fixture with the same result as its Russian twin above,
// and a negative one: a legitimate English line without a hit. The Russian fixtures above were not changed.
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
  ['- M-4 — wasn\'t fixed yet', 'parked'],
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

// "Could not verify": an empty list in English does not get into the run summary.
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
const DIGEST_EMPTY = [['none'], ['None.'], ['nothing'], ['no items'], ['all verified'], ['All checked.'], ['everything is verified'], ['нет'], ['ничего'], ['everything verified (of what was passed in)'], ['Everything that was passed in is verified.'], ['Nothing left — everything verified.'], ['nothing left']]
for (const items of DIGEST_EMPTY) check(`digest: «Could not verify» "${items[0]}" — nothing unverified`, digestFor(items) === '0', String(digestFor(items)))
for (const item of ['none of the states could be opened', 'AC-3.2 — no data on the stand', 'nothing was captured for dark', 'everything verified except the dark theme', 'all verified, but 1024 is not checked']) check(`digest: a real item "${item.slice(0, 36)}" is counted`, digestFor([item]) === '1', String(digestFor([item])))

// HT-1: the freshest run, the run's scope, the short and the full view, the data directory.
{
  const { freshestForceHeading, headingDate } = markers
  const pick = (text) => freshestForceHeading(text)?.[0]
  const H = (date, tail = '') => `## Force-прогон ${date}${tail}\nПодтверждено: ${date}\n\n`
  check('freshest block: blocks appended downwards — the last one', pick(`${H('2026-10-10')}${H('2026-10-12')}${H('2026-10-13')}`).includes('2026-10-13'))
  check('freshest block: new blocks on top (KC-600) — the first one, not the last in the file', pick(`${H('2026-10-13')}${H('2026-10-12')}${H('2026-10-12', ' — второй прогон')}`).includes('2026-10-13'))
  check('freshest block: equal dates, the file writes new blocks on top — the first of them', pick(`${H('2026-10-13', ' — b')}${H('2026-10-13', ' — a')}${H('2026-10-12')}`).includes('— b'))
  check('freshest block: equal dates, the file writes blocks downwards — the last of them', pick(`${H('2026-10-12')}${H('2026-10-13', ' — a')}${H('2026-10-13', ' — b')}`).includes('— b'))
  check('freshest block: all dates equal, no direction — the last one, as before', pick(`${H('2026-10-13', ' — a')}${H('2026-10-13', ' — b')}`).includes('— b'))
  check('freshest block: dd.mm.yyyy dates are compared as dates (13.10 over 04.11 of the year before)', pick(`## Force-прогон 04.11.2025\n\n## Force-прогон 13.10.2026\n\n## Force-прогон 02.01.2026\n`).includes('13.10.2026'))
  check('freshest block: a heading without a date — the last in the file, as before', pick(`${H('2026-10-13')}## Force run\n\n`) === '## Force run')
  check('freshest block: Force run headings in English', pick('## Force run 2026-10-13\n\n## Force run 2026-10-12\n').includes('2026-10-13'))
  const KC600 = `${H('2026-10-12', ' — второй прогон — завершён 2026-10-12')}${H('2026-10-12', ' — завершён с блокерами 2026-10-12')}`
  check('freshest block: equal dates, no direction visible (KC-600) — the "second run", not the last in the file', pick(KC600).includes('второй прогон'), pick(KC600))
  check('freshest block: equal dates — the ordinal wins over the position, in both orders', pick(`${H('2026-10-12', ' — first')}${H('2026-10-12', ' — second run')}`).includes('second run') && pick(`${H('2026-10-12', ' — second run')}${H('2026-10-12', ' — first')}`).includes('second run'))
  check('freshest block: "(2)" and a letter after the date are ordinals', pick(`${H('2026-10-12', ' (2)')}${H('2026-10-12')}`).includes('(2)') && pick(`${H('2026-10-12b')}${H('2026-10-12a')}`).includes('12b'))
  check('freshest block: equal dates and equal ordinals — the direction, then the last', pick(`${H('2026-10-13', ' — b')}${H('2026-10-13', ' — a')}${H('2026-10-12')}`).includes('— b'))
  check('closedForceDate: a journal with new blocks on top — the date of the freshest run', closedForceDate('## Force-прогон 2026-10-13 — завершён 2026-10-13\n\n## Force-прогон 2026-10-12 — завершён с блокерами 2026-10-12\n') === '2026-10-13')
  check('headingDate: the first date of the heading', headingDate('## Force-прогон 2026-10-12 — завершён 2026-10-14') === '2026-10-12')
  const top = `## Force-прогон 2026-10-13 — ребейз — завершён с блокерами 2026-10-13\nПодтверждено: 2026-10-13\nБлокеры: B1 — контракт — без изменений. B7 — чистка — отдельной задачей.\n\n## Force-прогон 2026-10-12 — завершён с блокерами 2026-10-12\nБлокеры: B4 — перенос\n- B5 — дубли\n\n## Этапы\n`
  check('lastForceBlock: the 2026-10-13 block when it stands on top', jc.lastForceBlock(top).heading.includes('2026-10-13'))
  check('openBlockers: the blockers of the `Blockers:` field line are items of their own', same(jc.openBlockers(jc.lastForceBlock(top).body).map((line) => line.slice(0, 2)), ['B1', 'B7']), JSON.stringify(jc.openBlockers(jc.lastForceBlock(top).body)))
  check('openBlockers: a lifted item on the field line does not count, the other does', jc.openBlockers('Blockers: B1 — contract — resolved by backend 2026-10-04. B2 — queue — needs a user decision').length === 1)
  check('openBlockers (ru): a common mark "both lifted" in Russian lifts every item of the line', jc.openBlockers('Блокеры: B1 — контракт; B2 — гонка — оба сняты ответом пользователя 2026-10-14.').length === 0)
  check('openBlockers (en): a common mark "both lifted" lifts every item of the line', jc.openBlockers('Blockers: B1 — contract; B2 — race — both lifted by the user 2026-10-14.').length === 0)
  check('openBlockers: a mark before the items (Russian and English forms) lifts them', jc.openBlockers('Блокеры: сняты 2026-10-14 ответами интервью. B1 — a; B2 — b; B3 — c.').length === 0 && jc.openBlockers('Blockers: all lifted by the user. B1 — a; B2 — b').length === 0)
  check('openBlockers: a singular mark lifts only its own item', jc.openBlockers('Блокеры: B1 — a — снят; B2 — b').length === 1 && jc.openBlockers('Blockers: B1 — a — lifted by the user; B2 — b').length === 1)
  // M3: a lift mark counts in the head of the field or as its closing phrase; "not all closed" in an item is not a lift.
  for (const line of ['Blockers: B1 — staging is down; not all closed yet', 'Блокеры: B1 — PR-ы ещё не все закрыты', 'Блокеры: B2 — тикеты закрыты не все, e2e красный', 'Blockers: B1 — CI red, all closed issues reopened', 'Blockers: not all lifted. B1 — a', 'Блокеры: не все сняты. B1 — a'])
    check(`openBlockers: "${line.slice(0, 50)}" keeps the blocker open`, jc.openBlockers(line).length === 1, line)
  check('openBlockers: the closing phrase "both lifted <date>" and the head mark still lift (ru, en)', jc.openBlockers('Блокеры: B1 — a; B2 — b — оба сняты 2026-10-14.').length === 0 && jc.openBlockers('Blockers: B1 — a; B2 — b. Both lifted by the user 2026-10-14.').length === 0)
  // The closing mark takes the tail of the user-answer markers: a date in both formats, "by the user", "in chat", "user decision <date>", a quote.
  for (const line of [
    'Блокеры: B1 — контракт; B2 — гонка — оба сняты 14.10.2026.',
    'Блокеры: B1 — контракт; B2 — гонка — оба сняты пользователем 14.10.2026.',
    'Blockers: B1 — contract; B2 — race — both lifted by the user in chat.',
    'Blockers: B1 — contract; B2 — race — both lifted, user decision 2026-10-17.',
    'Блокеры: B1 — контракт; B2 — гонка — оба сняты ответом пользователя «делать v2».',
    'Блокеры: B1 — контракт; B2 — гонка — все сняты в чате 2026-10-14.',
    'Блокеры: B1 — контракт; B2 — гонка. Оба сняты, решение пользователя 17.10.2026.',
  ]) check(`openBlockers: closing mark with a date/answer tail lifts the field: ${line.slice(-40)}`, jc.openBlockers(line).length === 0, JSON.stringify(jc.openBlockers(line)))
  check('openBlockers: a closing mark without the quantifier or with a foreign tail lifts nothing', jc.openBlockers('Блокеры: B1 — a; B2 — b — сняты 14.10.2026.').some((b) => b.startsWith('B1')) && jc.openBlockers('Blockers: B1 — a; B2 — b — both lifted next week maybe.').length === 2)
  // A mark in the head followed by item numbers lifts only those items, not the whole field.
  for (const [line, open] of [
    ['Блокеры: сняты B1 и B3 (ответ пользователя 2026-10-14). B2 — нужен токен staging.', 'B2'],
    ['Blockers: lifted B1, B3; B2 — no staging access', 'B2'],
    ['Блокеры: сняты частично. B1 — a; B2 — b', 'B1'],
    ['Blockers: partially lifted. B1 — a; B2 — b', 'B1'],
    ['Blockers: lifted: B1, B3. B2 — no staging access', 'B2'],
  ]) check(`openBlockers: a head mark with listed numbers keeps the rest open: ${line.slice(0, 45)}`, jc.openBlockers(line).some((b) => b.startsWith(open)), JSON.stringify(jc.openBlockers(line)))
  check('openBlockers: a head mark as a finished phrase still lifts the field (ru, en)', jc.openBlockers('Блокеры: все сняты 14.10.2026. B1 — a; B2 — b').length === 0 && jc.openBlockers('Blockers: all lifted by the user. B1 — a; B2 — b').length === 0)
  {
    const pathological = ['B1 — x; not all closed ', 'B1 — ', 'Blockers: lifted ', '; '].map((unit) => `Blockers: ${unit}${' '.repeat(50_000)};${'—'.repeat(50_000)}${'. '.repeat(25_000)}`)
    const t0 = performance.now()
    for (const line of pathological) jc.openBlockers(line)
    check('openBlockers: the field-lift regexes on 50 000 characters of pathological input < 100 ms', performance.now() - t0 < 100, `${(performance.now() - t0).toFixed(0)} ms`)
  }
  check('openBlockers (ru): a single "closed" in one item does not lift the other blockers of the line', jc.openBlockers('Блокеры: B1 — e2e не гоняются: порты закрыты в CI. B2 — нет доступа к staging, нужен токен').some((item) => item.startsWith('B2')))
  check('openBlockers (ru): "resolved partly" in one item lifts no one', jc.openBlockers('Блокеры: B1 — нужен доступ к staging. B2 — вопросы по контракту решены частично, ждём ответ бэка').length === 2)
  check('openBlockers: an empty `Blockers:` field and "none" give nothing', jc.openBlockers('Блокеры: \n').length === 0 && jc.openBlockers('Blockers: none').length === 0)
}

{
  const { collectDigest, runScope, publishDigest, taskRepo } = await import(join(PLUGIN, 'run-digest.mjs'))
  const { pluginDataDir, legacyDataDir } = await import(join(PLUGIN, 'hooks/pipeline-state.mjs'))
  const fixture = (language, extra = '') => {
    const ru = language === 'ru'
    const dir = mkdtempSync(join(tmpdir(), `digest-run-${language}-`))
    const task = join(dir, 'T-40')
    mkdirSync(join(task, 'checks'), { recursive: true })
    const fresh = ru
      ? '## Force-прогон 2026-10-13 — ребейз — завершён с блокерами 2026-10-13\nПодтверждено: 2026-10-13 — да\nБлокеры: B1 — контракт — без изменений. B7 — чистка — отдельной задачей.\n\n'
      : '## Force run 2026-10-13 — rebase — completed with blockers 2026-10-13\nConfirmed: 2026-10-13 — yes\nBlockers: B1 — contract — unchanged. B7 — cleanup — a separate task.\n\n'
    const old = ru
      ? '## Force-прогон 2026-10-12 — завершён с блокерами 2026-10-12\nПодтверждено: 2026-10-12 — да\nБлокеры: B4 — перенос — нужен ответ пользователя\n- B5 — дубли\n- B6 — гонка\nНезакрытое: `AC-9.9` — ⏳ user-review\n\n'
      : '## Force run 2026-10-12 — completed with blockers 2026-10-12\nConfirmed: 2026-10-12 — yes\nBlockers: B4 — move — needs a user decision\n- B5 — duplicates\n- B6 — race\nUnfinished: `AC-9.9` — ⏳ user-review\n\n'
    const awaiting = ru ? '## ⚠ Ожидают подтверждения пользователя\n' : '## ⚠ Awaiting user confirmation\n'
    const items = ['первое', 'второе', 'третье', 'четвёртое', 'пятое'].map((word, i) => `- допущение ${i + 1} — ${word}`).join('\n')
    // The first look of the plugin makes the snapshot of the journal: it is taken of an empty journal, the lines below are new.
    const data = mkdtempSync(join(tmpdir(), 'digest-run-data-'))
    writeFileSync(join(task, 'STAGES.md'), `# T-40: task\n${ru ? 'Язык: ru' : 'Language: en'}\n`)
    jc.baselineInfo(data, task)
    writeFileSync(
      join(task, 'STAGES.md'),
      `# T-40: task\n${ru ? 'Язык: ru' : 'Language: en'}\n\n## ${ru ? 'Статус' : 'Status'}: stage 3\n\n${fresh}${old}## ${ru ? 'Этапы' : 'Stages'}\n\n### ${ru ? 'Этап' : 'Stage'} 1: a  [status: done]\n- \`AC-1.1\` WHEN a THEN b — ⏳ user-review\n### ${ru ? 'Этап' : 'Stage'} 3: c\n- \`AC-3.1\` WHEN a THEN b — [live: user-side]\n- \`AC-3.2\` WHEN a THEN b — [blocked: B1]\n\n${awaiting}${items}\n${extra}`,
    )
    const unverified = ru ? '## Не удалось проверить' : '## Could not verify'
    const report = (name, body) => {
      writeFileSync(join(task, 'checks', name), body)
      const later = new Date(Date.now() + 60_000)
      utimesSync(join(task, 'checks', name), later, later)
    }
    report('devtools-verify-1.md', `# devtools-verify\nFindings: critical 0 · major 0 · minor 0\n\n${unverified}\n- 1280 and the dark theme\n- the real login\n`)
    report('pro-review-2.md', `# pro-review\nFindings: critical 0 · major 0 · minor 2\n\n- m-1 minor\n- m-2 minor\n`)
    return { dir, task, data }
  }
  const numbers = (view) => Object.fromEntries([...view.matchAll(/^### ([^(\n]+?)\s*\((\d+)\)/gm)].map(([, name, count]) => [name.replace(/ [—-] .*$/, ''), Number(count)]))
  for (const language of ['ru', 'en']) {
    const { task, data } = fixture(language)
    const full = runDigest(task, data, null)
    const short = runDigest(task, data, null, 'short')
    const fullNumbers = numbers(full)
    const shortNumbers = numbers(short)
    const t = collectDigest(task, data, null).text
    check(`digest ${language}: blockers come from the freshest run (13.10), the old block's B4–B6 do not show`, /B1 —/.test(full) && /B7 —/.test(full) && !/B4|B5|B6/.test(full), full.slice(0, 300))
    check(`digest ${language}: a ⏳ line inside the earlier run's block is not in this run's digest`, !full.includes('AC-9.9') && !short.includes('AC-9.9'), full)
    check(`digest ${language}: the short view gives the same blockers line by line`, same(full.split('\n').filter((line) => /^- B\d/.test(line)), short.split('\n').filter((line) => /^- B\d/.test(line))))
    check(`digest ${language}: every category of the full view is in the short one with the same number`, Object.keys(fullNumbers).length >= 3 && Object.entries(fullNumbers).every(([name, count]) => shortNumbers[name] === count), `${JSON.stringify(fullNumbers)} vs ${JSON.stringify(shortNumbers)}`)
    check(`digest ${language}: headings of both views are the strings of one table`, full.includes(t.notVerified(5)) && short.includes(t.notVerified(5)) && short.includes(t.minor(2)) && full.includes(t.minor(2)) && short.includes(t.accepted(5)) && full.includes(t.accepted(5)), short)
    check(`digest ${language}: the short view counts the unverified by stage and the checkers' ones as a number`, short.includes(t.verifiedJournal(3, `${t.stage(1)} — 1 · ${t.stage(3)} — 2`)) && short.includes(t.verifiedReports(2)), short)
    check(`digest ${language}: the short view has no "<checker>-N.md: …" lines, the full one has them`, !/\w-\d+\.md: /.test(short) && /devtools-verify-1\.md: /.test(full))
    check(`digest ${language}: "accepted on my own" — the number and the first three`, short.includes('допущение 3') && !short.includes('допущение 4') && full.includes('допущение 5'))
    check(`digest ${language}: an empty category is folded into one line, a non-empty one is never dropped`, short.includes(t.noneOf([t.labels.noOutcome])) && short.split('\n').length <= 15, short)
    const published = publishDigest(task, data, null)
    const file = readFileSync(published.path, 'utf8')
    check(`digest ${language}: RUN-DIGEST.md has the run in the header, the full view and the checkers' verdicts; the short view ends with its path`, file.startsWith(t.title('T-40')) && file.includes(t.run(collectDigest(task, data, null).heading)) && file.includes(full) && file.includes(t.checkers(2)) && published.short.endsWith(t.file(published.path)))
    check(`digest ${language}: the file lies outside checks/ and is not a report`, !published.path.includes(`${join('T-40', 'checks')}`) && !jc.reportNames(task).includes('RUN-DIGEST.md'))
    writeFileSync(join(task, 'checks', 'dead-code-3.md'), `# dead-code\nFindings: critical 0 · major 0 · minor 1\n\n- m\n`)
    utimesSync(join(task, 'checks', 'dead-code-3.md'), new Date(Date.now() + 90_000), new Date(Date.now() + 90_000))
    check(`digest ${language}: the next run overwrites the file`, readFileSync(publishDigest(task, data, null).path, 'utf8').includes('dead-code-3.md'))
    check(`digest ${language}: no file is written without the write flag`, (() => { rmSync(published.path); publishDigest(task, data, null, { write: false }); return !existsSync(published.path) })())
    // M2: RUN-DIGEST.md as a symlink to a file outside the task is neither followed nor written; the short view says why.
    {
      const outside = join(mkdtempSync(join(tmpdir(), 'digest-outside-')), 'victim.txt')
      writeFileSync(outside, 'user file')
      rmSync(published.path, { force: true })
      symlinkSync(outside, published.path)
      const linked = publishDigest(task, data, null)
      check(`digest ${language}: a RUN-DIGEST.md symlink is not written through`, readFileSync(outside, 'utf8') === 'user file' && linked.path === null && linked.short.includes(language === 'ru' ? 'Полный дайджест не записан: RUN-DIGEST.md — симлинк' : 'Full digest not written: RUN-DIGEST.md is a symlink'), linked.short.slice(-120))
      rmSync(published.path, { force: true })
      const taskLink = join(mkdtempSync(join(tmpdir(), 'digest-link-')), 'T-40')
      symlinkSync(task, taskLink)
      const viaLink = publishDigest(taskLink, data, null)
      check(`digest ${language}: a task directory symlink is refused`, viaLink.path === null && !existsSync(published.path))
      // The rule compares the task directory with the `task_path` directory of the config, not with the repo root.
      const repoOf = (taskDir) => ({ worktree: mkdtempSync(join(tmpdir(), 'digest-repo-')), config: '', taskDir })
      const elsewhere = publishDigest(task, data, repoOf(mkdtempSync(join(tmpdir(), 'digest-other-tasks-'))))
      check(`digest ${language}: a task directory outside the task_path of the config is refused`, elsewhere.path === null && elsewhere.short.includes(language === 'ru' ? 'вне каталога задач из конфига' : 'outside the task directory of the config') && !existsSync(published.path))
      const outsideRepo = publishDigest(task, data, repoOf(dirname(task)))
      check(`digest ${language}: task_path outside the repo (the task lies in it) -> the file is written`, outsideRepo.path === published.path && existsSync(published.path), outsideRepo.short.slice(-120))
      rmSync(published.path, { force: true })
      const tasksLink = join(mkdtempSync(join(tmpdir(), 'digest-tasks-link-')), 'tasks')
      symlinkSync(dirname(task), tasksLink)
      const viaTasksLink = publishDigest(join(tasksLink, 'T-40'), data, repoOf(tasksLink))
      check(`digest ${language}: .claude/tasks is a symlink to a directory outside the repo -> the file is written`, viaTasksLink.path === published.path && existsSync(published.path), viaTasksLink.short.slice(-120))
      rmSync(published.path, { force: true })
      symlinkSync(outside, published.path)
      const fileLinkInRepo = publishDigest(join(tasksLink, 'T-40'), data, repoOf(tasksLink))
      check(`digest ${language}: RUN-DIGEST.md is a symlink (task_path outside the repo) -> not written`, fileLinkInRepo.path === null && readFileSync(outside, 'utf8') === 'user file')
      rmSync(published.path, { force: true })
    }
    rmSync(task, { recursive: true, force: true })
  }
  // The scope of the run: from the date of the run, a journal line dated before it belongs to an earlier run.
  {
    const { task, data } = fixture('ru')
    runDigest(task, data, null) // the first look makes the snapshot of the journal
    appendFileSync(join(task, 'STAGES.md'), '- `AC-4.1` WHEN a THEN b — ⏳ user-review 2026-10-12\n- `AC-4.2` WHEN a THEN b — ⏳ user-review 14.10.2026\n- `AC-4.3` WHEN a THEN b — ⏳ user-review\n')
    const digest = runDigest(task, data, null)
    const unverifiedPart = digest.split(/^### /m).find((part) => part.startsWith('Не проверено')) ?? ''
    check('scope: a new journal line dated before the run is not in it, a later and an undated one are', !unverifiedPart.includes('AC-4.1') && unverifiedPart.includes('AC-4.2') && unverifiedPart.includes('AC-4.3'), digest)
    check('scope: "awaiting confirmation" is an open list — the date of the run does not cut it', digest.split(/^### /m).find((part) => part.startsWith('Принято само'))?.includes('AC-4.1'), digest)
    const stages = readFileSync(join(task, 'STAGES.md'), 'utf8')
    const scope = runScope(stages, jc.lastForceBlock(stages), 0)
    check('scope: reports are taken from the start of the run date', scope.date === '2026-10-13' && scope.since === new Date('2026-10-13T00:00:00').getTime() && scope.sameDay === 0)
    check('scope: the later of the run date and the snapshot wins', runScope(stages, jc.lastForceBlock(stages), Date.now()).since >= Date.now() - 1000)
    appendFileSync(join(task, 'STAGES.md'), '\n## Force-прогон 2026-10-13 — утренний\nПодтверждено: 2026-10-13\n')
    const twoRuns = readFileSync(join(task, 'STAGES.md'), 'utf8')
    check('scope: an earlier run of the same day inside the scope is named in a line of both views', runScope(twoRuns, jc.lastForceBlock(twoRuns), 0).sameDay >= 1 && /ранний прогон того же дня/.test(runDigest(task, data, null, 'short')) && /ранний прогон того же дня/.test(runDigest(task, data, null)))
    rmSync(task, { recursive: true, force: true })
  }
  // The CI gates of the digest are the task's repo's, not the repo the script was started from.
  {
    const { task, data } = fixture('en')
    const foreign = { tasks: [], worktree: '/elsewhere', config: '- e2e: `npm run e2e`\n' }
    check('gates: a task outside the caller\'s repo and without a config of its own gets no gates', taskRepo(task, foreign) === null)
    check('gates: the caller\'s state is taken only when it owns the task', taskRepo(task, { ...foreign, tasks: [{ dir: task, foreign: false }] }) !== null)
    rmSync(task, { recursive: true, force: true })
    void data
  }
  // A run closed before the plugin first looked at the task (a snapshot without the closed headings) is not checked after the fact.
  {
    const { dir, task, data } = fixture('ru')
    const stages = readFileSync(join(task, 'STAGES.md'), 'utf8')
    const closedTop = '## Force-прогон 2026-10-05 — завершён 2026-10-05\nБлокеры: B1 — открыт\n\n'
    writeFileSync(join(task, 'STAGES.md'), stages.replace('## Этапы', `${closedTop}## Этапы`))
    // the snapshot as the previous version wrote it: no closed headings
    const snapDir = join(data, 'journal-baseline')
    const snapFile = join(snapDir, readdirSync(snapDir)[0])
    const snap = JSON.parse(readFileSync(snapFile, 'utf8'))
    delete snap.closedSeen
    writeFileSync(snapFile, JSON.stringify(snap))
    check('migration: a long-closed run with an open blocker — the close is not checked after the update', jc.forceCloseViolations(data, task).length === 0, JSON.stringify(jc.forceCloseViolations(data, task)))
    check('migration: the closed headings are recorded as old, the snapshot is marked', JSON.parse(readFileSync(snapFile, 'utf8')).closedSeen === true && jc.baselineInfo(data, task).lines.has(jc.fingerprint(closedTop.split('\n')[0])))
    const rewritten = readFileSync(join(task, 'STAGES.md'), 'utf8').replace('## Force-прогон 2026-10-05 — завершён 2026-10-05', '## Force-прогон 2026-10-19 — завершён 2026-10-19')
    writeFileSync(join(task, 'STAGES.md'), rewritten)
    check('migration: a close written after the update is still checked', jc.forceCloseViolations(data, task).some((violation) => violation.rule === 'force-blockers'))
    rmSync(dir, { recursive: true, force: true })
  }
  // A CLAUDE_PLUGIN_DATA with a trailing slash reads what was written.
  {
    const { dir, task } = fixture('ru')
    const slash = `${mkdtempSync(join(tmpdir(), 'digest-slash-'))}/`
    const gates = await import(join(PLUGIN, 'ci-gates.mjs'))
    gates.recordGate(slash, '/wt-slash', 'npm run e2e', 0, 'tree1')
    check('trailing slash: gate records written to the directory are read back', Object.keys(gates.gateRecords(slash, '/wt-slash')).includes('npm run e2e'))
    const first = jc.baselineInfo(slash, task)
    check('trailing slash: the snapshot is found on the second look (the same moment, one file)', jc.baselineInfo(slash, task).ledgerSince === first.ledgerSince && readdirSync(join(slash, 'journal-baseline')).length === 1)
    rmSync(dir, { recursive: true, force: true })
    rmSync(slash, { recursive: true, force: true })
  }
  // "Awaiting confirmation": an item dated before the run still waits for the user. The short view names the reports that block "ready for PR".
  for (const language of ['ru', 'en']) {
    const { dir, task, data } = fixture(language, '- допущение 6 — старое, 2026-10-10 ждёт заказчика\n')
    const view = runDigest(task, data, null, 'short')
    const t = collectDigest(task, data, null).text
    check(`digest ${language}: an awaiting item dated before the run is counted`, view.includes(t.accepted(6)), view)
    check(`digest ${language}: no "not ready" line without a critical/major finding or a FAIL without an outcome`, !view.includes(t.notReady(['x']).slice(0, 12)), view)
    writeFileSync(join(task, 'checks', 'pro-review-3.md'), '# pro-review\nFindings: critical 0 · major 1 · minor 0 · Вердикт: Request changes\n')
    utimesSync(join(task, 'checks', 'pro-review-3.md'), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
    writeFileSync(join(task, 'checks', 'i18n-sweep-1.md'), '# i18n-sweep\nFindings: critical 1 · major 0 · minor 0\n')
    utimesSync(join(task, 'checks', 'i18n-sweep-1.md'), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
    const after = runDigest(task, data, null, 'short')
    check(`digest ${language}: one line names the reports with a critical/major finding or a FAIL without an outcome`, after.includes(t.notReady(['i18n-sweep-1.md', 'pro-review-3.md'])) && after.split('\n').filter((line) => line === t.notReady(['i18n-sweep-1.md', 'pro-review-3.md'])).length === 1, after)
    check(`digest ${language}: the full view does not carry the line (the verdicts are in the checkers' section of the file)`, !runDigest(task, data, null).includes(t.notReady(['i18n-sweep-1.md', 'pro-review-3.md'])))
    // M-3: the verdict in the head is the first round's; a major closed by an outcome line makes the report ready.
    writeFileSync(join(task, 'checks', 'pro-review-4.md'), `# pro-review\nFindings: critical 0 · major 1 · minor 0 · ${language === 'ru' ? 'Вердикт' : 'Verdict'}: Request changes\n\n## ${language === 'ru' ? 'Итог находок' : 'Findings outcome'}\n- M-1 — ${language === 'ru' ? 'исправлено' : 'fixed'}: src/a.ts:1\n`)
    utimesSync(join(task, 'checks', 'pro-review-4.md'), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
    check(`digest ${language}: a major closed in "Findings outcome" does not make the report not ready`, !runDigest(task, data, null, 'short').includes('pro-review-4.md'))
    rmSync(dir, { recursive: true, force: true })
  }
  // The data directory: a script run from Bash (no CLAUDE_PLUGIN_DATA) finds the hooks' directory and still reads the bare one.
  {
    const home = mkdtempSync(join(tmpdir(), 'digest-home-'))
    const root = join(home, '.claude/plugins/data')
    // The name comes from where the script lies: `installPath` in installed_plugins.json that contains it; none — `-inline`.
    const dataFor = (installed, known = null) => {
      const own = mkdtempSync(join(tmpdir(), 'digest-home-'))
      mkdirSync(join(own, '.claude/plugins/data/stage-pipeline'), { recursive: true })
      if (installed) {
        mkdirSync(join(own, '.claude/plugins'), { recursive: true })
        writeFileSync(join(own, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: installed }))
      }
      if (known) {
        mkdirSync(join(own, '.claude/plugins'), { recursive: true })
        writeFileSync(join(own, '.claude/plugins/known_marketplaces.json'), JSON.stringify(known))
      }
      const env = { ...process.env, HOME: own }
      delete env.CLAUDE_PLUGIN_DATA
      return spawnSync(process.execPath, ['--input-type=module', '-e', `import { pluginDataDir } from ${JSON.stringify(join(PLUGIN, 'hooks/pipeline-state.mjs'))}; console.log(pluginDataDir())`], { env, encoding: 'utf8' }).stdout.trim()
    }
    const pluginRoot = dirname(PLUGIN)
    check('data dir: no registry — the --plugin-dir one (-inline), as the hooks of that session', dataFor(null).endsWith('/.claude/plugins/data/stage-pipeline-inline'))
    check('data dir: the script lies in the installPath of stage-pipeline@magzhan — the hooks\' directory', dataFor({ 'stage-pipeline@magzhan': [{ installPath: pluginRoot }] }).endsWith('/stage-pipeline-magzhan'))
    check('data dir: two marketplaces — the one whose installPath holds the script', dataFor({ 'stage-pipeline@other': [{ installPath: '/elsewhere/stage-pipeline' }], 'stage-pipeline@magzhan': [{ installPath: pluginRoot }] }).endsWith('/stage-pipeline-magzhan'))
    const marketplaceDir = dirname(dirname(pluginRoot))
    check('data dir: an install elsewhere, no marketplace holds the script (a --plugin-dir copy) — -inline, not the install\'s directory', dataFor({ 'stage-pipeline@magzhan': [{ installPath: '/elsewhere/stage-pipeline/0.16.0' }] }).endsWith('/stage-pipeline-inline'))
    check('data dir: a marketplace connected as a directory, the install in the cache elsewhere — the marketplace\'s directory (source.path)', dataFor({ 'stage-pipeline@magzhan': [{ installPath: '/elsewhere/cache/magzhan/stage-pipeline/0.16.0' }] }, { magzhan: { source: { source: 'directory', path: marketplaceDir }, installLocation: '/elsewhere/magzhan' } }).endsWith('/stage-pipeline-magzhan'))
    check('data dir: the same through installLocation, with a trailing slash', dataFor(null, { magzhan: { installLocation: `${marketplaceDir}/` } }).endsWith('/stage-pipeline-magzhan'))
    check('data dir: a marketplace directory that is only a name prefix of the script path does not match', dataFor(null, { magzhan: { source: { path: `${marketplaceDir}-ht1` } } }).endsWith('/stage-pipeline-inline'))
    check('data dir: the legacy directory is the bare one beside a marketplace one, and none beside the bare one', legacyDataDir(join(root, 'stage-pipeline-magzhan')) === join(root, 'stage-pipeline') && legacyDataDir(join(root, 'stage-pipeline')) === null)
    // A snapshot and a gate run written to the bare directory earlier are still read through the hooks' directory.
    const { task } = fixture('ru')
    const hooksData = join(root, 'stage-pipeline-magzhan')
    const bare = join(root, 'stage-pipeline')
    jc.baselineInfo(bare, task)
    const before = readdirSync(join(bare, 'journal-baseline')).length
    check('data dir: a snapshot from the bare directory is read, no second one is made in the hooks\' directory', jc.baselineInfo(hooksData, task).ledgerSince > 0 && !existsSync(join(hooksData, 'journal-baseline')) && before === 1)
    const gates = await import(join(PLUGIN, 'ci-gates.mjs'))
    gates.recordGate(bare, '/wt', 'npm run e2e', 0, 'tree1')
    gates.recordGate(hooksData, '/wt', 'npm run smoke', 0, 'tree1')
    check('data dir: gate runs of both directories are one set of records', same(Object.keys(gates.gateRecords(hooksData, '/wt')).sort(), ['npm run e2e', 'npm run smoke']))
    // AC-1.5: the CLI from Bash and the hook's call give the same text.
    mkdirSync(join(home, '.claude/plugins'), { recursive: true })
    writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'stage-pipeline@magzhan': [{ installPath: dirname(PLUGIN) }] } }))
    const env = { ...process.env, HOME: home }
    delete env.CLAUDE_PLUGIN_DATA
    const cli = spawnSync(process.execPath, [join(PLUGIN, 'run-digest.mjs'), task, '--no-write'], { env, cwd: home, encoding: 'utf8' }).stdout
    check('run-digest from Bash and the hook\'s call on one task give one text', cli === `${publishDigest(task, hooksData, null, { write: false }).short}\n`, cli)
    rmSync(home, { recursive: true, force: true })
    rmSync(task, { recursive: true, force: true })
  }
}

// Report language: prose in the task language; code, paths, ids, UI quotes and short reports do not count.
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

// journal-gate returns to the author a report not in the task language in the same turn as the other report violations.
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
// The language is checked only for a report created after the task snapshot (the report name is not from the snapshot): an old report of an old task is edited without a return.
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
// an edit that replaces the file (new inode): write to a temp file and rename over it, as Edit does
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
// snapshot v2 without report names: the migration records the current reports as old
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

// ── heavy checks: scope by the diff and the machine queue ─────────────────────
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
check('run-check: {files} — changed and new code files, without md and node_modules', listed.status === 0 && /src\/a\.ts\|/.test(listed.stdout) && /new card\.vue\|/.test(listed.stdout) && !/b\.ts|notes\.md|node_modules/.test(listed.stdout), listed.stdout)
const vueOnly = rc(['--', `printf '%s|' {files:vue}`])
check('run-check: {files:vue} — only that extension', /new card\.vue/.test(vueOnly.stdout) && !/a\.ts/.test(vueOnly.stdout), vueOnly.stdout)
const several = spawnSync('/bin/sh', ['-c', `'${process.execPath}' '${RUN_CHECK}' -- printf '%s|' {files:ts+vue}`], { cwd: rcRepo, encoding: 'utf8', env: { ...process.env, STAGE_PIPELINE_LOCK_DIR: locks } })
check('run-check: {files:ts+vue} survives the shell (it would expand the comma)', /a\.ts\|/.test(several.stdout) && /new card\.vue\|/.test(several.stdout), several.stdout + several.stderr)
const none = rc(['--', 'false', '{files:py}'])
check('run-check: no files — the command is not run, code 0', none.status === 0 && /skipped/.test(none.stdout))
check('run-check: exit code — the command\'s code', rc(['--', 'exit 3']).status === 3)
check('run-check: git is not run through the wrapper', rc(['--', 'git', 'commit', '-m', 'x']).status === 2 && rc(['--', 'echo x && git push']).status === 2)
check('run-check: the mode from resources in the config', (() => {
  write(rcRepo, { '.claude/pipeline.config.local.md': '- resources: normal\n' })
  return /^normal/.test(rc(['--mode']).stdout)
})())
const first = spawnSync('/bin/sh', ['-c', `STAGE_PIPELINE_RESOURCES=low STAGE_PIPELINE_LOCK_DIR='${locks}' '${process.execPath}' '${RUN_CHECK}' -- 'sleep 2; date +%s%N' & sleep 0.5; STAGE_PIPELINE_RESOURCES=low STAGE_PIPELINE_LOCK_DIR='${locks}' '${process.execPath}' '${RUN_CHECK}' -- 'date +%s%N'; wait`], { cwd: rcRepo, encoding: 'utf8' })
const stamps = first.stdout.match(/^\d{15,}$/gm) ?? []
check('run-check: in low the second run waits for the first (a machine queue)', /waiting in the queue/.test(first.stdout) && stamps.length === 2 && Number(stamps[1]) >= Number(stamps[0]), first.stdout)
mkdirSync(join(locks, 'heavy.lock'), { recursive: true })
writeFileSync(join(locks, 'heavy.lock', 'owner.json'), JSON.stringify({ pid: 999999, repo: 'x', command: 'y', started: Date.now() }))
const stale = rc(['--', 'echo ok'], { STAGE_PIPELINE_RESOURCES: 'low' })
check('run-check: the lock of a dead process is taken over', stale.status === 0 && /ok/.test(stale.stdout) && !/жду/.test(stale.stdout), stale.stdout)
rmSync(rcRoot, { recursive: true, force: true })

// ── STAGES.md archiving ──────────────────────────────────────────────────────
// The source is a Russian STAGES.md (the second supported task language); the English twin is below.
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
check('archive: a done stage is folded, the in-progress stage and the force block are untouched', same(plan.moved.map((m) => m.heading), ['### Этап 1: первый  [status: done]']))
check('archive: open items and decisions stayed in the folded stage', ['Решения: взяли', '- [x] commit:', '- [ ] user-review', '⏳ user-review'].every((s) => plan.result.includes(s)))
check('archive: DD.MM.YYYY dates — 8 fresh stayed', plan.movedJournal.length === 2 && plan.result.includes('запись 22') && !plan.result.includes('запись 13'))
check('archive: the journal subheading is in place while the group has entries', plan.result.includes('### Этап 1 — ход'))
check('archive: size in bytes', plan.sourceBytes === Buffer.byteLength(source))
const lost = source.split('\n').filter((line) => line.trim() && !plan.result.includes(line) && !plan.moved.some((m) => m.text.includes(line)) && !plan.movedJournal.some((e) => e.lines.includes(line)))
check('archive: no line is lost', !lost.length, JSON.stringify(lost.slice(0, 2)))
const second = planArchive(plan.result)
check('archive is idempotent', !second.moved.length && !second.movedJournal.length)
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

// ── validate.mjs: the "N skills / N agents" count in a showcase, Russian and English forms (AC-4.2) ──
// A temporary repo with one skill and one agent; validate.mjs is copied into it and run without the CI flag (the repo is not a git checkout).
// English forms plus a permanent Russian regression case (these are validate fixtures, not hook fixtures).
{
  const vRoot = mkdtempSync(join(tmpdir(), 'validate-test-'))
  write(vRoot, {
    'scripts/validate.mjs': readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'validate.mjs'), 'utf8'),
    '.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'p', source: './plugins/p' }] }),
    'plugins/p/.claude-plugin/plugin.json': JSON.stringify({ name: 'p', version: '1.0.0', description: 'x' }),
    'plugins/p/skills/a/SKILL.md': '---\nname: a\ndescription: x\n---\n',
    'plugins/p/agents/b.md': '---\nname: b\ndescription: x\n---\n',
    'CHANGELOG.md': '## 1.0.0\n',
  })
  const validateWith = (readme) => {
    write(vRoot, { 'README.md': readme })
    // The temp repo is not a git checkout: under CI the skipped Cyrillic check would fail it. This fixture checks the count only.
    const run = spawnSync(process.execPath, [join(vRoot, 'scripts/validate.mjs')], { encoding: 'utf8', env: { ...process.env, CI: '' } })
    return { ok: run.status === 0, out: run.stderr + run.stdout }
  }
  const SHOWCASE = [
    ['1 skill and 1 agent — correct', 'The plugin ships 1 skill and 1 agent.\n', true],
    ['17 skills — wrong, English form', 'The plugin ships 17 skills.\n', false],
    ['11 agents — wrong, English form', 'The plugin ships 11 agents.\n', false],
    ['"Step 4 of the skill" and "Stage 2 agent" are not counts', 'Step 4 of the skill. Stage 2 agent runs. Step 4 skill. Point 3 agent.\n', true],
    ['"2 agents run in parallel" and "3 skill files" are prose, not counts', '2 agents run in parallel. Reads 3 skill files first.\n', true],
    ['17 скиллов — wrong, Russian form', 'В плагине 17 скиллов.\n', false],
    ['11 агентов — wrong, Russian form', 'В плагине 11 агентов.\n', false],
    ['1 скилл и 1 агент — correct, Russian form', 'В плагине 1 скилл и 1 агент.\n', true],
    ['"Шаг 4 скилла" is not a count, Russian form', 'Шаг 4 скилла.\n', true],
  ]
  for (const [name, readme, wantOk] of SHOWCASE) {
    const got = validateWith(readme)
    check(`validate: showcase count — ${name}`, got.ok === wantOk && (wantOk || /README\.md:1/.test(got.out)), got.out)
  }
  rmSync(vRoot, { recursive: true, force: true })
}

// ── validate.mjs: cross-references and Cyrillic outside the allowlist (AC-15.4) ──
// A temporary git repo with one skill; validate.mjs and the real allowlist are copied into it and run as in CI.
{
  const here = dirname(fileURLToPath(import.meta.url))
  const xRoot = mkdtempSync(join(tmpdir(), 'validate-xref-test-'))
  write(xRoot, {
    'scripts/validate.mjs': readFileSync(join(here, 'validate.mjs'), 'utf8'),
    'scripts/cyrillic-allowlist.json': readFileSync(join(here, 'cyrillic-allowlist.json'), 'utf8'),
    '.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'stage-pipeline', source: './plugins/stage-pipeline' }] }),
    'plugins/stage-pipeline/.claude-plugin/plugin.json': JSON.stringify({ name: 'stage-pipeline', version: '1.0.0', description: 'x' }),
    'plugins/stage-pipeline/skills/stage-check/SKILL.md': '---\nname: stage-check\ndescription: Close a stage.\n---\n\n## Step 9: Close\n\n**Findings outcome** — one line.\n',
    'plugins/stage-pipeline/agents/b.md': '---\nname: b\ndescription: x\n---\n',
    'CHANGELOG.md': '## 1.0.0\n',
  })
  spawnSync('git', ['init', '-q'], { cwd: xRoot })
  const validateWithSkill = (extra, description = 'Close a stage.') => {
    write(xRoot, { 'plugins/stage-pipeline/skills/other/SKILL.md': `---\nname: other\ndescription: ${description}\n---\n\n${extra}\n` })
    spawnSync('git', ['add', '-A'], { cwd: xRoot })
    const run = spawnSync(process.execPath, [join(xRoot, 'scripts/validate.mjs')], { encoding: 'utf8' })
    return { ok: run.status === 0, out: run.stderr + run.stdout }
  }
  const OTHER = 'plugins/stage-pipeline/skills/other/SKILL.md'
  const XREF = [
    ['a reference to a missing step fails with the path and the line', 'See /stage-check, Step 9.9 for details.', false, new RegExp(`${OTHER}:6.*Step 9\\.9`)],
    ['a reference to an existing step passes', 'See /stage-check, Step 9 for details.', true],
    ['a reference to a missing section fails', 'See `skills/stage-check`, "No such section".', false, new RegExp(`${OTHER}:6`)],
    ['a reference to a bold run-in label passes', 'See `skills/stage-check`, "Findings outcome".', true],
  ]
  for (const [name, body, wantOk, where] of XREF) {
    const got = validateWithSkill(body)
    check(`validate: xref — ${name}`, got.ok === wantOk && (wantOk || where.test(got.out)), got.out)
  }
  const ruParagraph = validateWithSkill('Это русский абзац вне белого списка.')
  check('validate: cyrillic — a Russian paragraph in a skill fails with the path and the line', !ruParagraph.ok && new RegExp(`${OTHER}:6.*Cyrillic`).test(ruParagraph.out), ruParagraph.out)
  const ruTail = validateWithSkill('Plain English.', 'Close a stage. RU triggers — «закрой этап», «проверь этап»')
  check('validate: cyrillic — the RU triggers tail of a description passes', ruTail.ok, ruTail.out)
  const ruHead = validateWithSkill('Plain English.', 'Закрой этап. RU triggers — «закрой этап»')
  check('validate: cyrillic — Russian before the RU triggers label in a description fails', !ruHead.ok && /Cyrillic/.test(ruHead.out), ruHead.out)
  const tail = validateWithSkill('See /stage-check, Steps 9 and 9.9 for details.')
  check('validate: xref — the tail of a step list is checked (Steps 9 and 9.9 fails on 9.9)', !tail.ok && /Step 9\.9/.test(tail.out) && !/Step 9»/.test(tail.out), tail.out)
  const skillForm = validateWithSkill('See the stage-check skill, Step 9.9 for details.')
  check('validate: xref — the form "<skill> skill, Step N" is checked', !skillForm.ok && /Step 9\.9/.test(skillForm.out), skillForm.out)
  const skillFormOk = validateWithSkill('See the stage-check skill, Step 9 for details.')
  check('validate: xref — the form "<skill> skill, Step N" passes on an existing step', skillFormOk.ok, skillFormOk.out)
  // an untracked file (not added to git) is scanned too
  write(xRoot, { 'plugins/stage-pipeline/references/new.md': 'Это русский абзац в неотслеживаемом файле.\n' })
  const untracked = spawnSync(process.execPath, [join(xRoot, 'scripts/validate.mjs')], { encoding: 'utf8' })
  check('validate: cyrillic — an untracked file with a Russian paragraph fails', untracked.status !== 0 && /references\/new\.md:1.*Cyrillic/.test(untracked.stderr + untracked.stdout), untracked.stderr + untracked.stdout)
  rmSync(join(xRoot, 'plugins/stage-pipeline/references/new.md'))
  // a Russian reason in the allowlist is not allowed, a Russian line regex is
  const allowlist = JSON.parse(readFileSync(join(xRoot, 'scripts/cyrillic-allowlist.json'), 'utf8'))
  allowlist.rules.push({ glob: 'nothing/**', reason: 'русская причина' })
  write(xRoot, { 'scripts/cyrillic-allowlist.json': JSON.stringify(allowlist, null, 2) + '\n' })
  const ruReason = spawnSync(process.execPath, [join(xRoot, 'scripts/validate.mjs')], { encoding: 'utf8' })
  check('validate: cyrillic — a Russian reason in the allowlist fails', ruReason.status !== 0 && /cyrillic-allowlist\.json:\d+.*Cyrillic/.test(ruReason.stderr + ruReason.stdout), ruReason.stderr + ruReason.stdout)
  rmSync(xRoot, { recursive: true, force: true })
}

// ── retro ────────────────────────────────────────────────────────────────────
// The STAGES.md fixture is Russian (the second supported task language).
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
check('retro: does not crash on diff=—', retro.status === 0, retro.stderr.trim())
check('retro: metrics from the journal are split by stage, 2.1 is a separate stage', /stages: 3, stages with a metrics: line: 3/.test(retro.stdout), retro.stdout.split('\n')[2])
check('retro: findings are summed across all stages', /findings in total: 14/.test(retro.stdout))
check('retro: size by added lines', /\| ≤300 \| 1 \|/.test(retro.stdout) && /\| 301–1000 \| 1 \|/.test(retro.stdout))
check('retro: the old report name deps-2.md is counted', /\| deps-audit \| 0 \| 0 \| 1 \|/.test(retro.stdout))
rmSync(retroRoot, { recursive: true, force: true })

// ── 0.16 catch-up: English gate forms close only what they should (final reviews of the branch) ──
{
  const status = (line) => `## Status: ${line}\n\n## Force run 2026-10-17\n`
  // 1. Closing a force run in the status line: "force run" + an optional date + "completed", not any "completed" nearby.
  for (const line of ['stage 4 of 6 — force run 2026-10-17, stage 3 completed', 'force run 2026-10-17 running, stages 1–3 completed', 'force run in progress; stage 2 completed'])
    check(`EN status "${line.slice(0, 48)}" — the run stays open`, forceActive(status(line)), line)
  for (const line of ['force run completed, waiting for push', 'force run 2026-10-17 completed — three commits', 'force run 17.10.2026: completed', 'force run is completed'])
    check(`EN status "${line.slice(0, 48)}" — the run is closed`, !forceActive(status(line)), line)
  check('RU status: the closing form still closes, the plural progress phrase does not', !forceActive('## Статус: force-прогон 2026-10-17 завершён\n\n## Force-прогон 2026-10-17\n') && forceActive('## Статус: force-прогон 2026-10-17 идёт, этапы 1–3 завершены\n\n## Force-прогон 2026-10-17\n'))
  // The heading "— complete <date>": accepted as a close (both forceActive and the close checks read the same word), so a run is never open and closed at once.
  check('EN heading "— complete <date>" closes the run', !forceActive('## Force run 2026-10-17 — complete 2026-10-17\n') && markers.CLOSED_WORD.test('## Force run 2026-10-17 — complete 2026-10-17'))
  for (const heading of ['## Force run — complete the migration', '## Force run 2026-10-17 — for the complete redesign', '## Force run 2026-10-17 — stage 3 complete'])
    check(`EN heading "${heading.slice(3)}" — an ordinary word, the run stays open`, forceActive(`${heading}\n`) && !markers.CLOSED_WORD.test(heading))
  for (const heading of ['## Force run 2026-10-17 — completed 2026-10-17', '## Force run 2026-10-17 — complete 2026-10-17', '## Force run 2026-10-17 — completed with blockers 2026-10-17', '## Force run 2026-10-17 — completed'])
    check(`EN heading "${heading.slice(3)}" — closes the run`, !forceActive(`${heading}\n`) && markers.CLOSED_WORD.test(heading))
  check('EN heading "incomplete" does not close the run', forceActive('## Force run 2026-10-17 — incomplete\n') && !markers.CLOSED_WORD.test('## Force run — incomplete'))

  // 2. Lifting a blocker: a request to the user is not a lift.
  const blockerOpen = (line) => jc.openBlockers(`- B0 — x — lifted by the user\n${line}\n`).length === 1
  for (const line of ['- B1 — waiting for a user answer', '- B1 — needs a user decision: v1 or v2', '- B1 — unresolved: the API contract', '- B1 — needs a user answer with the token'])
    check(`EN blocker "${line.slice(0, 44)}" stays open`, blockerOpen(line))
  for (const line of ['- B1 — user decision 2026-10-17: v2', '- B1 — user answer "token is set"', '- B1 — resolved: backend confirmed', '- B1 — closed by the user'])
    check(`EN blocker "${line.slice(0, 44)}" is lifted`, !blockerOpen(line))
  for (const line of ['- B1 — нужно решение: v1 или v2', '- B1 — не решён', '- B1 — нужно решение пользователя: v1 или v2', '- B1 — ждёт ответа пользователя'])
    check(`RU blocker "${line.slice(0, 44)}" stays open`, blockerOpen(line))
  for (const line of ['- B1 — решён: v2', '- B1 — решено пользователем', '- B1 — решена', '- B1 — решение пользователя 2026-10-17: v2', '- B1 — ответ пользователя «токен есть»', '- B1 — закрыт', '- B1 — снят'])
    check(`RU blocker "${line.slice(0, 44)}" is lifted`, !blockerOpen(line))

  // 3. ✅ with a caveat: a bare "not checked / tested" is a caveat, the state of the interface is not.
  const AC = '- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify'
  for (const tail of ['(dark theme not checked)', ', 1024 — not checked', ', 1024 not tested', ', not checked live', ', dark theme unverified', ', untested at 1024', ', 1024 not opened', ', dark theme not tested'])
    check(`EN caveat "${tail}" is caught`, Boolean(jc.caveatViolation(`${AC}${tail.startsWith(',') || tail.startsWith('(') ? ' ' : ''}${tail}`)))
  for (const tail of [', checkbox is not checked by default', ', drawer not opened on load', ', the toggle is not checked initially', ', modal remains not opened on load', ', menu not checked by default'])
    check(`EN UI state "${tail}" is not a caveat`, jc.caveatViolation(`${AC}${tail}`) === null)
  for (const tail of [', radio button is not checked', ', row is not checked after click', ', the "untested" import is removed', ', `untested` flag renamed', ', item not checked by default'])
    check(`EN UI state / quoted "${tail}" is not a caveat`, jc.caveatViolation(`${AC}${tail}`) === null)
  check('EN caveat outside the quotes is still caught', Boolean(jc.caveatViolation(`${AC}, "ok" dark theme untested`)))
  check('EN "not checked live" is not a live check', Boolean(jc.acViolation('- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ pro-review by code, not checked live')))

  // 4. Outcome of a finding: a promise is not a fix.
  for (const entry of ['will be fixed in a follow-up PR', 'to be fixed in a follow-up once the backend lands', 'not yet fixed', "hasn't been fixed", "isn't fixed", 'has not been fixed yet', 'ещё не исправлено', 'не исправлено', 'исправим позже', 'будет исправлено отдельным PR'])
    check(`outcome "${entry.slice(0, 40)}" is not fixed`, !['fixed', 'false', 'blocker', 'user'].includes(jc.disposition(`- M-1 — ${entry}`)), jc.disposition(`- M-1 — ${entry}`))
  for (const entry of ['fixed: a.ts:10', 'исправлено: a.ts:10'])
    check(`outcome "${entry}" is fixed`, jc.disposition(`- M-1 — ${entry}`) === 'fixed')

  // 6. PARKED: code in backticks and the bare word "findings" are not an outcome.
  for (const entry of ['fixed: a.ts:10, the other findings of the round are minor', 'fixed: the `deferred` import is now eager (a.ts:3)', 'исправлено: `deferred` промис резолвится в finally (a.ts:12)', 'fixed: moved the helper, see b.ts:5'])
    check(`outcome "${entry.slice(0, 44)}" is fixed`, jc.disposition(`- M-2 — ${entry}`) === 'fixed', jc.disposition(`- M-2 — ${entry}`))
  for (const entry of ['to findings', 'в findings', 'moved to FINDINGS.md', 'deferred'])
    check(`outcome "${entry}" stays parked`, jc.disposition(`- M-2 — ${entry}`) === 'parked', jc.disposition(`- M-2 — ${entry}`))

  // 7. The run summary of a ru task: the "findings without outcome" lines are Russian (the lines of the base 3ea2473).
  {
    const dir = mkdtempSync(join(tmpdir(), 'digest-ledger-'))
    const digestIn = (header, name, report) => {
      mkdirSync(join(dir, 'T-32/checks'), { recursive: true })
      writeFileSync(join(dir, 'T-32/STAGES.md'), header)
      writeFileSync(join(dir, 'T-32/checks', name), report)
      const later = new Date(Date.now() + 60_000)
      utimesSync(join(dir, 'T-32/checks', name), later, later)
      return runDigest(join(dir, 'T-32'), mkdtempSync(join(tmpdir(), 'digest-ledger-data-')), null)
    }
    const REPORT = 'Findings: critical 0 · major 2 · minor 0\n\n## Findings outcome\n- M-1 — leaving it as is\n- M-2 — unclear\n'
    const ruDigest = digestIn('# T-32: задача\nЯзык: ru\n\n## Статус: этап 1\n', 'pro-review-1.md', REPORT)
    check('digest: a ru task — the "without outcome" lines are Russian, as on the base', /это решение не исправлять, его принимает пользователь/.test(ruDigest) && /не распознан/.test(ruDigest) && !/Findings outcome|this is a decision not to fix|is not recognised/.test(ruDigest), ruDigest)
    const enDigest = digestIn('# T-32: task\nLanguage: en\n\n## Status: stage 1\n', 'pro-review-1.md', REPORT)
    check('digest: an en task — the same lines in English', /this is a decision not to fix/.test(enDigest) && /is not recognised/.test(enDigest) && !/[а-яё]/i.test(enDigest), enDigest)
    rmSync(dir, { recursive: true, force: true })
  }

  // 8-10, 9: dates of the Force run heading, "like X", "no matching data", "skipped:".
  {
    const unread = (heading) => openForceBlock(`${heading}\nMode: autonomous.\n\n`)?.unreadDate
    for (const heading of ['## Force run Oct 17, 2026', '## Force run 10/17/2026', '## Force run 17 October 2026'])
      check(`Force heading "${heading.slice(10)}" — a date the parser did not read: fail closed`, unread(heading) === true)
    for (const heading of ['## Force run 2026-10-17', '## Force-прогон 17.10.2026', '## Force run'])
      check(`Force heading "${heading.slice(3)}" — a date read or none: no fail-closed flag`, unread(heading) === false)
    const like = (line) => Boolean(jc.likeViolation(line))
    for (const line of ['- D3 — saving like the expert', '- `AC-3.1` WHEN save THEN as on prod — [verify: pro-review]', '- `AC-3.1` WHEN open THEN like the rest of the page — [verify: pro-review]'])
      check(`EN "like X" without a path: ${line.slice(2, 44)} — caught`, like(line))
    for (const line of ['- `AC-3.1` WHEN open THEN like the rest of the page (page.tsx:12) — [verify: pro-review]', '- `AC-3.1` WHEN the user taps like THEN a heart — [verify: pro-review]', '- 2026-10-17 — did it like the expert'])
      check(`EN "like X" with a path or in plain prose: ${line.slice(2, 44)} — not caught`, !like(line))
    for (const line of ['- `AC-3.1` WHEN open THEN looks like the existing card — [verify: pro-review]', '- D3 — feels like the current thing, no change', '- `AC-3.1` WHEN open THEN sounds like the old one — [verify: pro-review]'])
      check(`EN "looks like the X" is a description, not a reference: ${line.slice(2, 44)}`, !like(line))
    check('EN "like the existing" without a verb is still caught', like('- D3 — saving like the existing form'))
    check('EN "no matching data" is "no data"', Boolean(jc.noDataViolation('- `AC-4.5` — ⏳ not verified: no matching data on the stand')))
    check('EN "skipped: MCP busy" is a browser reason', jc.skipViolation('proto-compare and devtools-verify — skipped: MCP Chrome is busy')?.rule === 'design-skip' && jc.skipViolation('figma-compare skipped: logic-only change') === null)
    check('a metrics line "skipped=devtools-verify,…" is not a skip of a design checker', jc.skipViolation('  metrics: checkers=figma-compare,pro-review skipped=devtools-verify,dead-code findings=7') === null)
  }

  // 11. Second review of the branch (AC-18.1): every finding with a positive and a negative case.
  {
    // M-1: the ru digest names the report ("checks/pro-review-1.md: …"), as on the base; en does too.
    const dir = mkdtempSync(join(tmpdir(), 'digest-name-'))
    const digestIn = (header, report) => {
      mkdirSync(join(dir, 'T-33/checks'), { recursive: true })
      writeFileSync(join(dir, 'T-33/STAGES.md'), header)
      writeFileSync(join(dir, 'T-33/checks/pro-review-1.md'), report)
      const later = new Date(Date.now() + 60_000)
      utimesSync(join(dir, 'T-33/checks/pro-review-1.md'), later, later)
      return runDigest(join(dir, 'T-33'), mkdtempSync(join(tmpdir(), 'digest-name-data-')), null)
    }
    const REPORT = 'Findings: critical 0 · major 2 · minor 0\n\n## Findings outcome\n- M-1 — leaving it as is\n- M-2 — unclear\n- M-3 — pre-existing\n'
    const ru = digestIn('# T-33: задача\nЯзык: ru\n\n## Статус: этап 1\n', REPORT)
    const en = digestIn('# T-33: task\nLanguage: en\n\n## Status: stage 1\n', REPORT)
    check('digest ru: every "without outcome" line names the report, none says "undefined"', (ru.match(/checks\/pro-review-1\.md: /g) ?? []).length === 4 && !/undefined/.test(ru), ru)
    check('digest en: the same, with the report name', (en.match(/checks\/pro-review-1\.md: /g) ?? []).length === 4 && !/undefined/.test(en), en)
    check(
      'digest ru: the lines are the base 3ea2473 ones, byte for byte',
      ru.includes('- checks/pro-review-1.md: «M-1 — leaving it as is» — это решение не исправлять, его принимает пользователь. Итог — исправлено, ложная (с доказательством) или блокер B<n> (references/checker-report.md).') &&
        ru.includes('- checks/pro-review-1.md: «M-3 — pre-existing» — «давнее» без доказательства на базе. Проверь на sha базы или на проде и впиши замер, иначе это находка задачи.') &&
        ru.includes('- checks/pro-review-1.md: итог «M-2 — unclear» не распознан — допустимы «исправлено: …», «ложная: …», «B<n>», «решение пользователя <дата>» (references/checker-report.md).') &&
        ru.includes('- checks/pro-review-1.md: major 2, а итогов в «## Итог находок» — 0. Каждая находка закрывается строкой: исправлено / ложная / B<n> (references/checker-report.md). Находку, которую fix-loop не исправил, не откладывают — это блокер.'),
      ru,
    )
    rmSync(dir, { recursive: true, force: true })

    // m-2: a request for an answer with a quote or a date further on, "not resolved:", "not closed by" — the blocker stays open; a date or a quote right after the words lifts.
    const open = (line) => jc.openBlockers(`- B0 — x — lifted by the user\n${line}\n`).length === 1
    for (const line of [
      '- B1 — AC-3.2 (stage 3) — the backend contract is unknown — needs a user decision — I recommend "move to v2": v1 is deprecated — stage 4 depends on it',
      '- B2 — AC-4.1 (stage 4) — rejected git push --force — needs a user decision: run "git push --force-with-lease" yourself — recommend yes — nothing else',
      '- B1 — not resolved: waiting',
      '- B1 — not closed by the backend',
      '- B1 — the endpoint is closed by the backend firewall — need a user answer',
      '- B1 — need a user answer: v1 or v2 (see 2026-10-16)',
      '- B1 — waiting for a user answer 2026-10-16',
      '- B1 — AC-3.2 (этап 3) — контракт неизвестен — нужно решение пользователя — рекомендация: «перейти на v2» — от него зависит этап 4',
      '- B1 — нужен ответ пользователя — рекомендация 16.10.2026',
    ])
      check(`blocker request stays open: ${line.slice(2, 60)}`, open(line), line)
    for (const line of ['- B1 — user decision 2026-10-16: v2', '- B1 — user answer "token is set"', '- B1 — closed by the user', '- B1 — resolved: backend confirmed', '- B1 — решение пользователя 16.10.2026', '- B1 — решение пользователя «v2»', '- B1 — ответ пользователя: «токен задан»'])
      check(`blocker lifted: ${line.slice(2, 60)}`, !open(line), line)

    // m-3: "completed" after a dash or a colon closes with any tail; "complete" stays narrow.
    for (const heading of ['## Force run 2026-10-17 — completed on 2026-10-18', '## Force run 2026-10-17 — completed.', '## Force run 2026-10-17 — completed (B1 open)', '## Force run 2026-10-17 — completed, with blockers', '## Force run 2026-10-17: completed on the 18th'])
      check(`EN heading "${heading.slice(3)}" — closes the run`, !forceActive(`${heading}\n`) && markers.CLOSED_WORD.test(heading), heading)
    for (const heading of ['## Force run — stage 3 completed', '## Force run 2026-10-17 — auto-completed tasks', '## Force run — complete the migration', '## Force run — complete redesign of the page', '## Force run — complete (B1 open)'])
      check(`EN heading "${heading.slice(3)}" — stays open`, forceActive(`${heading}\n`) && !markers.CLOSED_WORD.test(heading), heading)

    // m-4: quotes and the description of a fix are not the outcome; a refusal in the head or after ";" is.
    for (const entry of [
      'исправлено этапом 16: markers.mjs — «не исправлено» больше не засчитывается',
      'fixed: a.ts:10 — the "won\'t fix" label is removed from the UI',
      'fixed: a.ts:10 — the promise is not resolved twice anymore',
      'fixed: header.vue:12 — the header was not fixed on scroll, now sticky',
      'исправлено: a.ts:10 — ошибка, которая не исправлена бэком, теперь показывается тостом',
      'fixed: the deferred import is now eager (a.ts:3)',
      'fixed: a.ts:5 — renders later items lazily',
      'fixed: b.ts:2 — keeping the cache warm',
      'fixed: a.ts:1 — “postponed” label removed',
    ])
      check(`outcome "${entry.slice(0, 50)}" is fixed`, jc.disposition(`- M-1 — ${entry}`) === 'fixed', jc.disposition(`- M-1 — ${entry}`))
    for (const entry of ['fixed: a.ts:1; поправим тесты', 'fixed: a.ts:1; the rest later', 'исправлено: a.ts:1; остальное в findings', 'not yet fixed — a.ts:10', 'не исправлено: a.ts:10 — позже', 'leaving it as is — fixed elsewhere', 'will be fixed in a follow-up PR: a.ts:10', 'исправим позже: a.ts:10'])
      check(`outcome "${entry.slice(0, 50)}" is not fixed`, !['fixed', 'false', 'blocker', 'user'].includes(jc.disposition(`- M-1 — ${entry}`)), jc.disposition(`- M-1 — ${entry}`))
    check('stripQuoted cuts backticks and the three kinds of quotes', jc.stripQuoted('a `b` "c" «d» “e” f').replace(/\s+/g, ' ') === 'a f')

    // m-5: subject words and states of the interface are not a caveat.
    const AC5 = '- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify 1440/1280'
    for (const tail of [': an unverified account sees the banner', ': unverified phones get the OTP step (auth.ts:40)', ': the dialog is not opened twice on a double click', ': the bottom sheet is not opened after logout', ': submit stays disabled while terms are not checked', ': the tab is not opened again', ': the consent link is not checked by default'])
      check(`EN "${tail.slice(2, 50)}" is not a caveat`, jc.caveatViolation(`${AC5}${tail}`) === null, tail)
    for (const tail of [': dark theme stays unverified', ': 1024 is untested', ': dark theme unverified', ', untested at 1024', ': unverified; rest ok', ': the drawer opens, 1024 not opened'])
      check(`EN "${tail.slice(2, 50)}" is a caveat`, Boolean(jc.caveatViolation(`${AC5}${tail}`)), tail)

    // m-6: a quoted "smoke test" / "tested live" does not close a runtime criterion.
    const AC6 = (outcome) => `- \`AC-3.1\` WHEN open THEN ok — [verify: devtools-verify] ✅ ${outcome}`
    for (const outcome of ['pro-review: copy «smoke test» renders (Badge.vue:12)', 'pro-review: the "tested live" badge renders (Badge.vue:12)', 'pro-review: `smoke` flag renamed (a.ts:1)'])
      check(`quoted live word "${outcome.slice(11, 40)}" does not close a runtime criterion`, jc.acViolation(AC6(outcome))?.rule === 'ac-checker', outcome)
    for (const outcome of ['pro-review: smoke test of the page, renders', 'pro-review: tested live in the browser', 'devtools-verify 1440/1280', '⏳ devtools-verify']) {
      const v = jc.acViolation(AC6(outcome), ['devtools-verify-3.md'])
      check(`honest outcome "${outcome.slice(0, 40)}" passes`, v === null, v?.rule)
    }
    check('`[live: user-side]` in backticks still defers a runtime criterion', jc.acViolation(AC6('pro-review: the part behind the login — `[live: user-side]`')) === null)
    check('a quoted "user decision" does not defer a runtime criterion', jc.acViolation(AC6('pro-review: copy "user decision" renders'))?.rule === 'ac-checker')

    // nit: a heading without a date is not an "unreadable date".
    const unreadH = (heading) => openForceBlock(`${heading}\nMode: autonomous.\n\n`)?.unreadDate
    for (const heading of ['## Force run — deck translation', '## Force run — second run, separate branch', '## Force run — may need a rebase', '## Force-прогон этапы 4-6', '## Force run — stages 4-6, v4'])
      check(`Force heading "${heading.slice(3)}" has no date to read: no fail-closed flag`, unreadH(heading) === false, heading)
    for (const heading of ['## Force run Oct 17, 2026', '## Force run 10/17/2026', '## Force run 17 October 2026', '## Force run 17th of Oct 2026', '## Force run 17/10/2026'])
      check(`Force heading "${heading.slice(3)}" — an unread date: fail closed`, unreadH(heading) === true, heading)

    // m-7: the "nothing left" form of the digest in linear time, on the pathological tail of the old regexp.
    const sectionDir = mkdtempSync(join(tmpdir(), 'digest-lin-'))
    const timeDigest = (item) => {
      mkdirSync(join(sectionDir, 'T-34/checks'), { recursive: true })
      writeFileSync(join(sectionDir, 'T-34/STAGES.md'), '# T-34: task\nLanguage: en\n\n## Status: stage 1\n')
      writeFileSync(join(sectionDir, 'T-34/checks/pro-review-1.md'), `Findings: critical 0 · major 0 · minor 0\n\n## Could not verify\n- ${item}\n`)
      const later = new Date(Date.now() + 60_000)
      utimesSync(join(sectionDir, 'T-34/checks/pro-review-1.md'), later, later)
      const start = performance.now()
      const text = runDigest(join(sectionDir, 'T-34'), mkdtempSync(join(tmpdir(), 'digest-lin-data-')), null)
      return { ms: performance.now() - start, text }
    }
    const heavy = [`all ${' '.repeat(50_000)}`, `all ${'verified ('.repeat(5_000)}`, `all ${'verified '.repeat(5_000)}`, `everything ${'checked ('.repeat(5_000)}x`]
    const worstDigest = Math.max(...heavy.map((item) => timeDigest(item).ms))
    check('digest "nothing left" regexp: 50 000 characters < 100 ms', worstDigest < 100, `${worstDigest.toFixed(0)} ms`)
    check('digest "nothing left": "all verified (by code)" is empty, "all verified except 1024" is an item', /### Not verified \(0\)/.test(timeDigest('all widths verified (by code)').text) && /### Not verified \(1\)/.test(timeDigest('all verified except 1024').text))
    rmSync(sectionDir, { recursive: true, force: true })
  }

  // 12. Fresh review of stage 18 (AC-19.1…19.6): the remainder deferred after a comma or a dash, caveats, blocker requests, dates, ⏳ in backticks.
  {
    // M-1: a deferral of the remainder in the description of a fix is parked; "later" and "keeping" about the code are not.
    for (const entry of [
      'fixed: a.ts:1, fix the tests later',
      'fixed: a.ts:10 — the rest later',
      'fixed in a.ts:10, the rest later',
      'fixed: a.ts:1 — the second case will be fixed in a follow-up PR',
      'fixed: a.ts:1 — the dark theme part is out of scope',
      'fixed: a.ts:1 — rest moved to FINDINGS.md',
      'fixed partially: a.ts:1 — mobile is a separate task',
      'fixed: a.ts:1 — leaving the rest as is',
      'исправлено: a.ts:1 — вторую часть исправим позже',
      'исправлено: a.ts:1, остальное потом',
      'исправлено в a.ts:1 — мобильную версию оставляем как есть',
      'исправлено частично: a.ts:1 — остальное отдельной задачей',
      'исправлено: a.ts:1 — мобилка позже',
      'исправлено: a.ts:1 — тесты потом',
      'исправлено: a.ts:1 — иконку в кит',
      'исправлено: a.ts:1 — вторая часть — компромисс',
      'исправлено: a.ts:1 — остальное — вопрос к бэкенду',
      'исправлено: a.ts:1 — остальное не в скоупе',
      'исправлено: a.ts:1 — мобилку не чиним',
      'исправлено: a.ts:1, остальное в findings',
      "fixed: a.ts:1 — the rest: won't fix",
      'fixed: a.ts:1, the rest accepted as a compromise',
      'fixed: a.ts:1 — the rest is a question for the backend',
      'fixed: a.ts:1 — rest into Awaiting user confirmation',
      'fixed: a.ts:1 — the dark theme is not in scope',
      'fixed: a.ts:1, the rest to findings',
      'fixed: a.ts:1 — tests later',
    ])
      check(`deferred remainder "${entry.slice(0, 50)}" is parked`, jc.disposition(`- M-1 — ${entry}`) === 'parked', jc.disposition(`- M-1 — ${entry}`))
    for (const entry of ['fixed: a.ts:1 — the download starts later than the toast', 'fixed: a.ts:1 — the follow-up request is deduplicated', 'fixed: a.ts:1 — the findings counter shows 0'])
      check(`description "${entry.slice(0, 50)}" is fixed`, jc.disposition(`- M-1 — ${entry}`) === 'fixed', jc.disposition(`- M-1 — ${entry}`))

    // m-2: a preposition after "untested", a telegraphic "<noun> not checked" and "not checked again" without a verb are caveats.
    const AC = '- `AC-2.7` WHEN theme THEN ok — [verify: devtools-verify] ✅ devtools-verify 1440/1280'
    for (const tail of [', untested on mobile', '— unverified in Safari', '(unverified for the guest role)', ', settings page not checked', '; the profile page not opened', ', the billing tab not opened', ', the help link not checked', '(1024 not checked again after the fix)', ', dark theme untested yet', ': 1024 was not checked again after the fix', ': dark theme is not checked again after the fix'])
      check(`EN "${tail.slice(1, 50)}" is a caveat`, Boolean(jc.caveatViolation(`${AC}${tail}`)), tail)

    // m-3: a lift marker followed by a long run of spaces stays linear.
    const worstLift = Math.max(
      ...['- B1 — user decision', '- B1 — решение пользователя', '- B1 — user decision on', '- B1 — ответ пользователя от'].flatMap((head) =>
        [' ', '\t'].map((pad) => {
          const start = performance.now()
          jc.openBlockers(`${head}${pad.repeat(50_000)}x`)
          return performance.now() - start
        }),
      ),
    )
    check('openBlockers: a lift marker + 50 000 spaces or tabs < 100 ms', worstLift < 100, `${worstLift.toFixed(0)} ms`)

    // m-4: a day with an ordinal suffix, a dot or a dash after the month is a date the parser does not read: fail closed.
    const unreadH = (heading) => openForceBlock(`${heading}\nMode: autonomous.\n\n`)?.unreadDate
    for (const heading of ['## Force run October 17th', '## Force run Oct 17th', '## Force run Oct. 17', '## Force run Oct-17', '## Force run Tuesday, Oct 17th', '## Force run 17th of October'])
      check(`Force heading "${heading.slice(3)}" — an unread date: fail closed`, unreadH(heading) === true, heading)

    // m-5: a request with a quote of the options stays open; an answer with a date or a quote after "on", "(", "in chat" (and the Russian forms) lifts.
    const open = (line) => jc.openBlockers(`- B0 — x — lifted by the user\n${line}\n`).length === 1
    for (const line of [
      '- B1 — AC-3.2 (этап 3) — контракт неизвестен — ждём решение пользователя: «v1» или «v2» — рекомендую v2 — этап 4',
      '- B1 — ожидаем ответ пользователя «да/нет» — рекомендация: да',
      '- B1 — жду ответ пользователя «да»',
      '- B1 — AC-3.2 — contract unknown — awaiting user decision: "v1" or "v2" — recommend v2',
      '- B1 — pending user decision: "v1" or "v2"',
      '- B1 — AC-3.2 (stage 3) — contract unknown — user decision ("v1" or "v2") — recommend v2 — stage 4',
      '- B1 — AC-3.2 (этап 3) — контракт неизвестен — решение пользователя («v1» или «v2») — рекомендую v2 — этап 4',
      '- B1 — waiting: user decision on "v1" or "v2"',
      '- B1 — user decision on "v1" vs "v2" needed — recommend v2',
      '- B1 — необходимо решение пользователя: «v1» или «v2»',
    ])
      check(`blocker request stays open: ${line.slice(2, 60)}`, open(line), line)
    for (const line of ['- B1 — решение пользователя от 16.10.2026: v2', '- B1 — решение пользователя (16.10.2026): v2', '- B1 — ответ пользователя в чате: «токен задан»', '- B1 — user decision (2026-10-16): v2', '- B1 — user decision on 2026-10-16: v2', '- B1 — user answer in chat: "token is set"'])
      check(`blocker lifted: ${line.slice(2, 60)}`, !open(line), line)

    // m-6: "⏳ `checker`" in backticks defers the criterion, as "⏳ checker" does.
    const v = jc.acViolation('- `AC-3.1` WHEN open THEN ok — [verify: devtools-verify] ✅ pro-review: logic · ⏳ `devtools-verify`', ['pro-review-3.md'])
    check('"⏳ `devtools-verify`" in backticks defers a runtime criterion', v === null, v?.rule)
  }

  // 5. Linear time (AC-16.2): 50 000 characters of pathological input — every pattern under 100 ms.
  {
    const { languageMismatch } = await import(join(PLUGIN, 'report-language.mjs'))
    const N = 50_000
    const rep = (unit) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N)
    const INPUTS = {
      spaces: ' '.repeat(N), tabs: '\t'.repeat(N), newlines: '\n'.repeat(N), 'blank lines': rep('\n  '), stars: '*'.repeat(N), 'guillemets': '«'.repeat(N), 'curly quotes': '“'.repeat(N),
      'link opens': rep(']('), 'bang run': `a${'!'.repeat(N)}a`, 'html opens': rep('<!--'), 'ac ids': rep('AC-1.1 '), 'ids': rep('1.1 '), 'user decision': rep('user decision '),
      'figma-compare': rep('figma-compare '), dots: rep('· '), 'Confirmed': rep('- Confirmed '),
      'lift + spaces': `- B1 — user decision${' '.repeat(N)}x`, 'ru lift + spaces': `- B1 — решение пользователя${' '.repeat(N)}x`, 'deferral words': rep('fixed: a.ts:1, fix the rest остальное '),
    }
    const SUBJECTS = {
      CONFIRMED_LINE: (t) => markers.CONFIRMED_LINE.test(t), LANGUAGE_LINE: (t) => markers.LANGUAGE_LINE.test(t), PARITY_TABLE: (t) => markers.PARITY_TABLE.test(t),
      BLOCKER_LINE: (t) => markers.BLOCKER_LINE.test(t), BLOCKER_LIFTED: (t) => markers.BLOCKER_LIFTED.test(t), STATUS_FORCE_CLOSED: (t) => markers.STATUS_FORCE_CLOSED_WITH_DATE.test(t),
      'report language': (t) => languageMismatch(t, 'ru'), acViolation: (t) => jc.acViolation(`- \`AC-1.1\` ${t} ✅ ${t}`), skipViolation: (t) => jc.skipViolation(`figma-compare ${t} skip: ${t}`),
      caveatViolation: (t) => jc.caveatViolation(`- \`AC-1.1\` ✅ ${t}`), noDataViolation: (t) => jc.noDataViolation(`- \`AC-1.1\` ⏳ ${t}`), likeViolation: (t) => jc.likeViolation(`- \`AC-1.1\` WHEN ${t}`),
      disposition: (t) => jc.disposition(`- M-1 — ${t}`), barePasses: (t) => jc.barePasses(t), failedCriteria: (t) => jc.failedCriteria(t), findingCounts: (t) => jc.findingCounts(t, 'pro-review-1.md'),
      'force status': (t) => forceActive(`## Status: force run${t}\n`), 'force heading': (t) => forceActive(`## Force run${t}\n`),
      'acViolation with a tag': (t) => jc.acViolation(`- \`AC-1.1\` [verify: devtools-verify] ✅ ${t}`), 'acViolation tag + quote': (t) => jc.acViolation(`- \`AC-1.1\` [verify: devtools-verify] ✅ "${t}`),
      openBlockers: (t) => jc.openBlockers(t), 'runtime report': (t) => jc.runtimeViolations(`# devtools-verify\n${t}`, 'devtools-verify-1.md'),
    }
    for (const [name, run] of Object.entries(SUBJECTS)) {
      let worst = { ms: 0, input: '' }
      for (const [input, text] of Object.entries(INPUTS)) {
        const start = performance.now()
        run(text)
        const ms = performance.now() - start
        if (ms > worst.ms) worst = { ms, input }
      }
      check(`50 000 characters of pathological input: ${name} < 100 ms`, worst.ms < 100, `${worst.ms.toFixed(0)} ms on "${worst.input}"`)
    }
  }

}

process.exit(failed ? 1 : 0)
