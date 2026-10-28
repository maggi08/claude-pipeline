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
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '../plugins/stage-pipeline/scripts')
// The task directory registry and the journal snapshots are written by the hooks into the plugin data directory — a temporary one in the test.
const DATA = mkdtempSync(join(tmpdir(), 'hooks-test-data-'))
process.env.CLAUDE_PLUGIN_DATA = DATA
// A force close in journal-gate closes the MCP browser of the Claude Code session above it — run inside a session, the close fixtures would close that
// session's real browser. Only the stage 5b fixtures turn it on, under a throwaway `claude` process of their own.
process.env.STAGE_PIPELINE_BROWSER_CLEANUP = 'off'
// The maker receipts of a force commit (VT-1 stage 11) judge every code path of a Force block dated from the release day on, and many fixtures commit code under a block dated today:
// the rule is off here and only the stage 11 fixtures turn it on.
process.env.STAGE_PIPELINE_MAKER_RECEIPTS = 'off'
const { commitScope, gitInvocations } = await import(join(PLUGIN, 'hooks/git-command.mjs'))
const { taskDirFromConfig, taskBranches, isCurrentTask, forceActive, openForceBlock, reviewModel } = await import(join(PLUGIN, 'hooks/pipeline-state.mjs'))
const { planArchive } = await import(join(PLUGIN, 'archive-stages.mjs'))
const { closedForceDate, taskLanguage, readPipelineState, unjournaledCommits: unjournaled } = await import(join(PLUGIN, 'hooks/pipeline-state.mjs'))
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
// A Bash call as the hooks see it: the PreToolUse run stamps the journal files, `effect` is what the command does, the PostToolUse run judges.
let bashCalls = 0
const bashGate = (cwd, command, effect = () => {}) => {
  const base = { cwd, tool_name: 'Bash', tool_use_id: `toolu_test_${bashCalls++}`, tool_input: { command } }
  runHook('journal-gate.mjs', { ...base, hook_event_name: 'PreToolUse' })
  effect()
  return runHook('journal-gate.mjs', { ...base, hook_event_name: 'PostToolUse' })
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
// AC-2.1: a Bash call is judged by what it changed in the journal, not by what its text names. The violation is already in STAGES.md here.
const BAD_LINE = '- `AC-2.1` WHEN новое THEN новое — [verify: devtools-verify] ✅ pro-review по коду\n'
const readsOnly = ['cat', 'ls', 'grep -n AC', 'sed -n 1,20p', 'head -5']
for (const reader of readsOnly) {
  check(`journal: a read-only \`${reader}\` of STAGES.md with the violation in it — silent`, bashGate(app, `${reader} ${stagesPath}`).decision === 'allow')
}
check('journal: a read-only `ls` of checks/ — silent', bashGate(app, `ls ${join(app, '.claude/tasks/T-7/checks')}/`).decision === 'allow')
check('journal: `node run-digest.mjs` over the task — silent', bashGate(app, `node ${join(PLUGIN, 'run-digest.mjs')} ${join(app, '.claude/tasks/T-7')} --no-write # STAGES.md`).decision === 'allow')
check('journal: an edit via Bash that rewrites STAGES.md — returned to the agent', bashGate(app, `python3 fix.py ${stagesPath}`, () => write(app, { '.claude/tasks/T-7/STAGES.md': `${journal(BAD_LINE)}\n` })).decision === 'block')
check('journal: a Bash call without the pre-hook stamp has nothing to compare — silent', runHook('journal-gate.mjs', { cwd: app, tool_name: 'Bash', tool_use_id: 'toolu_never_stamped', hook_event_name: 'PostToolUse', tool_input: { command: `python3 fix.py ${stagesPath}` } }).decision === 'allow')
check('journal: code and commands without the journal — silent', gate('Edit', { file_path: join(app, 'src/a.ts') }).decision === 'allow' && bashGate(app, 'git status').decision === 'allow')
write(app, { '.claude/tasks/T-7/STAGES.md': journal('- `AC-2.1` WHEN новое THEN новое — [verify: devtools-verify] ⏳ devtools-verify\n') })
check('journal: fixed to ⏳ — silent', gate('Edit', { file_path: stagesPath }).decision === 'allow')
const report = join(app, '.claude/tasks/T-7/checks/pro-review-2.md')
write(app, { '.claude/tasks/T-7/checks/pro-review-2.md': '## AC\n2.1 PASS · 2.2 PASS · 2.3 PASS (`a.ts:3`, a=1)\n' })
const bare = gate('Write', { file_path: report })
check('report: bare PASS returned to the agent, PASS with a measurement not', bare.decision === 'block' && /AC-2\.1, AC-2\.2/.test(bare.text) && !/AC-2\.3/.test(bare.text), bare.text)
// A Bash call that WRITES a new report is judged like a Write (the `changed ∩ checks` branch), and a valid one passes.
const bashBad = bashGate(app, 'python3 write_report.py pro-review-3', () => write(app, { '.claude/tasks/T-7/checks/pro-review-3.md': '## AC\n2.1 PASS · 2.2 PASS\n' }))
check('report via Bash: a new report with a bare PASS — returned to the agent', bashBad.decision === 'block' && /AC-2\.1, AC-2\.2/.test(bashBad.text) && /pro-review-3|T-7/.test(bashBad.text), bashBad.text)
const bashOk = bashGate(app, 'python3 write_report.py pro-review-4', () => write(app, { '.claude/tasks/T-7/checks/pro-review-4.md': '# pro-review\nFindings: critical 0 · major 0 · minor 0\n## AC\n2.1 PASS (`a.ts:3`, a=1) · 2.2 PASS (`a.ts:9`, b=2)\n' }))
check('report via Bash: a new report with measured PASS — passes', bashOk.decision === 'allow', bashOk.text)

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
// The 0.18 rules keyed on a Force block apply from the day the task snapshot recorded at the migration (`releaseGate`, VT-1 5a m-2), not from a fixed date:
// a fixture that needs them on a dated block records that day by hand (and which Force headings were already there), so it does not depend on today's date.
const snapshotFile = (dataDir, taskDir) => join(dataDir, 'journal-baseline', `${createHash('sha1').update(realpathSync(taskDir)).digest('hex').slice(0, 16)}.json`)
const setGate = (taskDir, since, seen = [], dataDir = DATA) => {
  jc.baselineInfo(dataDir, taskDir)
  const file = snapshotFile(dataDir, taskDir)
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), since018: since, forceSeen: seen }))
}
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
// The 0.15 rules alone: the run was already open when 0.18 first saw the task, so the 0.18 receipts and the fresh-final-review close stay out of these checks.
setGate(kTask, today, [`## Force-прогон ${today}`])
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
// AC-2.1, the live repro: a read-only Bash call whose text the OLD gate matched (`/STAGES|checks[/\\]/`: `checks/` with a slash, `STAGES.md`) returned the CURRENT task's
// (T-12) force-close demands, whichever task the call read. Reads stay silent, the same demands come to a call that edits the journal.
const otherTask = join(kApp, '.claude/tasks/T-99')
mkdirSync(join(otherTask, 'checks'), { recursive: true })
writeFileSync(join(otherTask, 'STAGES.md'), '# T-99: other task\nBranch: `T-99/feat/other`\n\n## Status: stage 1\n')
for (const read of [`ls ${join(kTask, 'checks')}/`, `ls ${join(otherTask, 'checks')}/`, `cat ${join(otherTask, 'STAGES.md')}`, `cat ${join(kTask, 'STAGES.md')}`, `grep -n Force ${join(kTask, 'STAGES.md')}`, `sed -n 1,30p ${join(kTask, 'STAGES.md')}`, `node ${join(PLUGIN, 'run-digest.mjs')} ${kTask} --no-write # STAGES.md checks/`]) {
  check(`journal-gate: a read-only \`${read.split(' ')[0]}\` (text names STAGES.md / checks/) with the current task's closing demands unmet — silent`, bashGate(kApp, read).decision === 'allow', read)
}
// M-1: a concurrent session's edit of an unrelated task during a Bash call is not this call's doing; a task named by path is.
check('journal-gate: an unrelated command while another task\'s journal changes (not current, not named) — silent', bashGate(kApp, 'echo see STAGES.md', () => appendFileSync(join(otherTask, 'STAGES.md'), '\n- [ ] x\n')).decision === 'allow')
rmSync(otherTask, { recursive: true, force: true })
check('journal-gate: a Bash call that rewrites the journal of that task gets the closing demands', /Смоук/.test(bashGate(kApp, `sed -i s/a/a/ ${join(kTask, 'STAGES.md')}`, () => appendFileSync(join(kTask, 'STAGES.md'), '\n')).text))
// AC-2.2: a gate that cannot run here is skipped on the record — `skip: <reason> <date>` in its table row or in the run's Force block. An unmarked gate still blocks.
{
  const closing = `## Force-прогон ${today} — завершён ${today}`
  const closeWith = (skipLine = '') =>
    write(kApp, { '.claude/tasks/T-12/STAGES.md': kStages({ extra: JOURNALED, heading: closing }).replace('\nПодтверждено:', `\n${skipLine}\nПодтверждено:`) })
  const cfgBase = readFileSync(join(kApp, '.claude/pipeline.config.md'), 'utf8')
  const withRow = (cell) => cfgBase.replace(`| Смоук | ${KIT_GATE} |`, `| Смоук | ${KIT_GATE} | ${cell} |`)
  const violations = (config = cfgBase) => gates.gateCloseViolations(DATA, kApp, config, kTask)
  closeWith()
  check('ci-gates skip: an unmarked gate (PLI-3474: e2e/smoke line without a mark) still blocks the close', violations().length === 1 && /Смоук/.test(violations()[0].message))
  check('ci-gates skip: `skip:` without a date is not a skip — still blocks', violations(withRow('skip: нужен стейджинг')).length === 1 && violations(withRow('skip: 2026-10-19')).length === 1)
  check('ci-gates skip: `skip: <reason> <date>` in the table row — accepted at close, listed once as skipped', violations(withRow('skip: нужен стейджинг 2026-10-19')).length === 0 && gates.gateStatus(DATA, kApp, withRow('skip: нужен стейджинг 2026-10-19'))[0]?.status === 'skipped')
  const listed = gates.gateStatus(DATA, kApp, withRow('skip: needs staging 2026-10-19')).map((gate) => gates.describe(gate))
  check('ci-gates skip: the description carries the reason and the date, once', listed.length === 1 && /skipped: needs staging, 2026-10-19/.test(listed[0]), listed.join('|'))
  closeWith('skip: Смоук — нужен стейджинг 2026-10-19')
  check('ci-gates skip: a Force-block line naming the gate — accepted at close', violations().length === 0)
  closeWith('skip: E2E — нужен стейджинг 2026-10-19')
  check('ci-gates skip: a Force-block line about another gate does not skip this one', violations().length === 1)
  const two = `${cfgBase}| e2e | \`node -e "process.exit(3)"\` |\n`
  closeWith('skip: Смоук — нужен стейджинг 2026-10-19')
  check('ci-gates skip: with two gates only the unmarked `e2e` still blocks', violations(two).length === 1 && /e2e/.test(violations(two)[0].message) && !/Смоук/.test(violations(two)[0].message))
  // pro-review-2 #1: a line mentioning two gates skips only the one in the clause that holds `skip:`.
  closeWith('- Смоук failed, e2e skip: no staging 2026-10-20')
  const mixed = violations(two)
  check('ci-gates skip: a line naming two gates skips only the one before skip: — the other still blocks', mixed.length === 1 && /Смоук/.test(mixed[0].message) && !/e2e/.test(mixed[0].message), JSON.stringify(mixed.map((v) => v.message)))
  closeWith('- skip: e2e — no staging 2026-10-20')
  check('ci-gates skip: skip: <gate> — <reason> skips that gate, the other still blocks', violations(two).length === 1 && /Смоук/.test(violations(two)[0].message))
  closeWith('skip: Смоук — нужен стейджинг 2026-10-19')
  check('ci-gates skip: the single-gate form still passes (one-gate config)', violations().length === 0)
  // pro-review-2 #3: a dash before a bare date leaves the reason in front of it.
  closeWith('- Смоук skip: no staging — 2026-10-20')
  check('ci-gates skip: `<gate> skip: <reason> — <date>` is a skip', violations().length === 0)
  const lineConfig = `- task_path: .claude/tasks/\n- e2e: \`npm run e2e\`   # skip: нужен стейджинг 2026-10-19\n- smoke: \`npm run smoke\`\n`
  check('ci-gates skip: a mark on an `- e2e:` Commands line skips that line only', same(gates.gateCommands(lineConfig).map((gate) => [gate.name, Boolean(gate.skip)]), [['e2e', true], ['smoke', false]]))
  // m-4: a Force-block skip line names a gate as a whole word — `ci` / `build` are not found in "special" / "rebuild".
  const wordConfig = `- task_path: .claude/tasks/\n\n## CI gates\n| Gate | Command |\n|---|---|\n| ci | \`node -e "1"\` |\n| build | \`node -e "2"\` |\n`
  const skippedOf = (before) => gates.gateStatus(DATA, kApp, wordConfig, [{ reason: 'staging', date: '2026-10-19', before }]).map((gate) => `${gate.name}:${gate.status === 'skipped'}`)
  check('ci-gates skip: a line about "special" / "rebuild" skips neither `ci` nor `build`', same(skippedOf('a special rebuild of the stack '), ['ci:false', 'build:false']), skippedOf('a special rebuild of the stack ').join())
  check('ci-gates skip: a line naming `ci` as a word skips `ci` only', same(skippedOf('ci, '), ['ci:true', 'build:false']) && same(skippedOf('the build gate '), ['ci:false', 'build:true']))
  // m-3 + D-1: a skip of a gate that did not run on HEAD is accepted, but a gate whose last recorded run (on another tree) is red reads "skipped — last run red";
  // the digest counts skipped apart from green.
  gates.recordGate(DATA, kApp, 'node -e "process.exit(0)"', 1, 'deadbeef')
  closeWith('skip: Смоук — нужен стейджинг 2026-10-19')
  const redSkipped = gates.gateStatus(DATA, kApp, cfgBase, gates.forceSkips(kTask))[0]
  check('ci-gates skip: a skipped gate whose last run was red on another tree (stale on HEAD) is still accepted at close', redSkipped?.status === 'skipped' && redSkipped.lastRed === true && violations().length === 0, JSON.stringify(redSkipped))
  check('ci-gates skip: the listing says "skipped — last run red" (en and ru)', /skipped — last run red/.test(gates.describe(redSkipped)) && /пропущен — последний запуск красный/.test(gates.describe(redSkipped, 'ru')), gates.describe(redSkipped))
  const { runDigest: kDigest } = await import(join(PLUGIN, 'run-digest.mjs'))
  const kRepo = readPipelineState(kApp)
  const shortView = kDigest(kTask, DATA, kRepo, 'short')
  const fullView = kDigest(kTask, DATA, kRepo, 'full')
  check('digest: skipped gates are counted apart from green — short and full view', /\(0 из 1 зелёные, пропущено 1\)/.test(shortView) && /\(0 из 1 зелёные, пропущено 1\)/.test(fullView), shortView)
  check('digest: a skipped gate with a red last run is listed in the short view', /пропущен — последний запуск красный/.test(shortView), shortView)
  // VT-1 5a m-1: a run red on HEAD beats the Force block's own skip line — the skip stands only for a gate that cannot run here, the run that wrote it saw it fail.
  // The user's mark in the config row still counts.
  const headTree = git(kApp, 'rev-parse', 'HEAD^{tree}').trim()
  gates.recordGate(DATA, kApp, 'node -e "process.exit(0)"', 1, headTree)
  closeWith('skip: Смоук — нужен стейджинг 2026-10-19')
  const redHead = violations()
  check('ci-gates m-1: a gate red on HEAD with a Force-block skip still blocks "completed", and the message says the skip does not cover a red run', redHead.length === 1 && /— red, code 1/.test(redHead[0].message) && /does not cover it/.test(redHead[0].message), JSON.stringify(redHead.map(({ message }) => message)))
  check('ci-gates m-1: the same red gate is listed red, not skipped', gates.gateStatus(DATA, kApp, cfgBase, gates.forceSkips(kTask))[0]?.status === 'red')
  check('ci-gates m-1: the same red gate with the user\'s config-row skip — accepted', violations(withRow('skip: нужен стейджинг 2026-10-19')).length === 0)
  // R2: a green run on HEAD beats a skip, in the row and in the Force block — listed green, not skipped.
  gates.recordGate(DATA, kApp, 'node -e "process.exit(0)"', 0, headTree)
  const greenOverSkip = gates.gateStatus(DATA, kApp, withRow('skip: нужен стейджинг 2026-10-19'), gates.forceSkips(kTask))[0]
  check('ci-gates R2: a green run on HEAD beats a skip (row and Force block) — listed green, not skipped', greenOverSkip?.status === 'green' && !/skipped/.test(gates.describe(greenOverSkip)), JSON.stringify(greenOverSkip))
  gates.recordGate(DATA, kApp, 'node -e "process.exit(0)"', 1, 'deadbeef') // back to "never ran on HEAD" for the checks below
}
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
// AC-2.3: a commit that names the ticket in its title, landing after the close, is not "the task's own squash": only its SHA or patch-id in the journal clears it.
{
  // The titled rule applies to runs opened on or after the day the task snapshot recorded at the 0.18 migration (set here to 2026-10-20, none seen then):
  // the run here is dated that day at the earliest, its commits land after it.
  const closedFix = today >= '2026-10-20' ? today : '2026-10-20'
  const stagesFile = join(kTask, 'STAGES.md')
  writeFileSync(stagesFile, readFileSync(stagesFile, 'utf8').replaceAll(today, closedFix))
  setGate(kTask, '2026-10-20')
  const baseTs = Math.max(Date.now(), Date.parse(`${closedFix}T12:00:00Z`))
  const commitAt = (message, seconds, content) => {
    write(kApp, { 'src/Card.tsx': content })
    const at = new Date(baseTs + seconds * 1000).toISOString()
    execFileSync('git', ['commit', '-qam', message], { cwd: kApp, env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } })
    return git(kApp, 'rev-parse', 'HEAD').trim()
  }
  const titled = commitAt('Fix(T-12): карточка снова обрезалась', 240, 'export const Card = () => 1\n')
  const incident = runHook('session-start.mjs', { cwd: kApp }).text
  check('session-start: a ticket-titled commit after the force close, not in the journal — named', /T-12 \(closed /.test(incident) && /Fix\(T-12\): карточка снова обрезалась/.test(incident), incident)
  const stagesNow = readFileSync(join(kTask, 'STAGES.md'), 'utf8')
  write(kApp, { '.claude/tasks/T-12/STAGES.md': `${stagesNow}\n- догон: \`${titled.slice(0, 8)}\` Fix(T-12): карточка снова обрезалась, pro-review Approve\n` })
  check('session-start: the same commit recorded in the journal by SHA — not named', !/Fix\(T-12\)/.test(runHook('session-start.mjs', { cwd: kApp }).text))
  commitAt('Fix(T-12): ещё одна правка карточки (#15)', 360, 'export const Card = () => 2\n')
  check('session-start: the ticket-titled squash of a merged PR "(#15)" — not named', !/Fix\(T-12\): ещё одна правка/.test(runHook('session-start.mjs', { cwd: kApp }).text))
}
// M-2: the titled rule and the squash without "(#N)", on a repo with fixed commit dates (independent of today's date).
{
  const sqApp = join(kRoot, 'sq')
  repoAt(sqApp, 'main')
  const at = (iso, ...args) => execFileSync('git', args, { cwd: sqApp, env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso }, encoding: 'utf8' }).trim()
  const edit = (n) => write(sqApp, { 'src/Sq.tsx': `export const s = ${n}\n` })
  edit(0)
  at('2026-10-01T10:00:00Z', 'add', '-A')
  at('2026-10-01T10:00:00Z', 'commit', '-qm', 'base sq')
  edit(1)
  at('2026-10-11T10:00:00Z', 'commit', '-qam', 'T-31: шаг A')
  const shaA = at('2026-10-11T10:00:00Z', 'rev-parse', 'HEAD')
  edit(2)
  at('2026-10-11T10:01:00Z', 'commit', '-qam', 'T-31: шаг B')
  const shaB = at('2026-10-11T10:01:00Z', 'rev-parse', 'HEAD')
  const patch = at('2026-10-11T10:01:00Z', 'diff', `${shaA}^`, shaB)
  const stagesSq = (closedOn) =>
    `# T-31: задача\nВетка: \`T-31/feat/s\`\n\n## Статус: этап 1\n\n## Force-прогон ${closedOn} — завершён ${closedOn}\nПодтверждено: ${closedOn} — «да»\nБлокеры:\n\n## Этапы\n\n### Этап 1: шаг  [status: done]\n` +
    `- [x] commit: \`${shaA.slice(0, 8)}\` T-31: шаг A\n- [x] commit: \`${shaB.slice(0, 8)}\` T-31: шаг B\n`
  // The per-task gate: the 0.18 migration recorded 2026-10-20 and no Force run then (VT-1 5a m-2).
  const GATE = { since: '2026-10-20', seen: new Set() }
  const namedAfter = (closedOn, gate = GATE) => {
    write(sqApp, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n', '.claude/tasks/T-31/STAGES.md': stagesSq(closedOn) })
    const state = readPipelineState(sqApp)
    return unjournaled(state, state.tasks.find((task) => task.ticket === 'T-31'), { gate }).map(({ subject }) => subject)
  }
  const followUp = (iso) => {
    edit(3)
    at(iso, 'commit', '-qam', 'Fix(T-31): правка после закрытия')
  }
  followUp('2026-10-12T11:00:00Z')
  check('unjournaled: a ticket-titled follow-up on a block opened BEFORE the migration date of the snapshot (2026-10-20) — silent', !namedAfter('2026-10-10').some((subject) => /Fix\(T-31\)/.test(subject)), namedAfter('2026-10-10').join('|'))
  check('unjournaled m-2: the same block with no gate (no snapshot date) — named, the rule fails closed', namedAfter('2026-10-10', null).some((subject) => /Fix\(T-31\)/.test(subject)), namedAfter('2026-10-10', null).join('|'))
  at('2026-10-12T12:00:00Z', 'reset', '-q', '--hard', shaB)
  followUp('2026-10-26T11:00:00Z')
  check('unjournaled: the same ticket-titled follow-up on a block opened after the migration date — named', namedAfter('2026-10-25').some((subject) => /Fix\(T-31\)/.test(subject)), namedAfter('2026-10-25').join('|'))
  const seenGate = { since: '2026-10-20', seen: new Set(['## Force-прогон 2026-10-25']) }
  check('unjournaled m-2: a block already there at the migration (its heading in the snapshot) keeps the old rule whatever its date — silent', !namedAfter('2026-10-25', seenGate).some((subject) => /Fix\(T-31\)/.test(subject)), namedAfter('2026-10-25', seenGate).join('|'))
  // The squash of the stage commits without "(#N)" (GitLab): the same combined patch on top of the base.
  at('2026-10-26T12:00:00Z', 'reset', '-q', '--hard', `${shaA}^`)
  writeFileSync(join(sqApp, 'sq.patch'), `${patch}\n`)
  at('2026-10-26T12:00:00Z', 'apply', 'sq.patch')
  rmSync(join(sqApp, 'sq.patch'))
  at('2026-10-26T12:01:00Z', 'commit', '-qam', 'Feat(T-31): шаг A и B')
  check('unjournaled: a ticket-titled squash without "(#N)" equal to the combined stage patch — silent', !namedAfter('2026-10-25').some((subject) => /Feat\(T-31\)/.test(subject)), namedAfter('2026-10-25').join('|'))
  edit(9)
  at('2026-10-26T12:02:00Z', 'commit', '-qam', 'Feat(T-31): другой патч')
  check('unjournaled: a ticket-titled commit with a different patch after the close — named', namedAfter('2026-10-25').some((subject) => /Feat\(T-31\): другой патч/.test(subject)))
  // R3: a `Revert "…"` after the close is not task follow-up work, even though it touches the task's files.
  at('2026-10-26T12:03:00Z', 'revert', '--no-edit', 'HEAD')
  const withRevert = namedAfter('2026-10-25')
  check('unjournaled R3: a revert commit after the close is not named; the commit it reverts still is', !withRevert.some((subject) => /^Revert\s/.test(subject)) && withRevert.some((subject) => /Feat\(T-31\): другой патч/.test(subject)), withRevert.join('|'))
}
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
setGate(eTask, today, [`## Force run ${today}`]) // as in the Russian twin: a run open when 0.18 first saw the task
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
    const dataFor = (installed, known = null, { copyTo } = {}) => {
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
      // The script as a session of another version runs it: a copy under the home's plugin cache.
      let scripts = PLUGIN
      if (copyTo) {
        scripts = join(own, '.claude/plugins/cache', copyTo, 'scripts')
        cpSync(PLUGIN, scripts, { recursive: true })
      }
      const env = { ...process.env, HOME: own }
      delete env.CLAUDE_PLUGIN_DATA
      return spawnSync(process.execPath, ['--input-type=module', '-e', `import { pluginDataDir } from ${JSON.stringify(join(scripts, 'hooks/pipeline-state.mjs'))}; console.log(pluginDataDir())`], { env, encoding: 'utf8' }).stdout.trim()
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
    // AC-2.4: a script of an older cached version, or of the marketplace's source tree, from Bash resolves to the directory of the hooks of that install.
    check('data dir: a script of an older cached version (the install moved on) — the hooks\' directory, not -inline', dataFor({ 'stage-pipeline@magzhan': [{ installPath: '/elsewhere/cache/magzhan/stage-pipeline/0.16.0' }] }, null, { copyTo: 'magzhan/stage-pipeline/0.15.1' }).endsWith('/stage-pipeline-magzhan'))
    check('data dir: a cached copy of a marketplace that is not installed — -inline', dataFor({ 'stage-pipeline@magzhan': [{ installPath: '/elsewhere/x' }] }, null, { copyTo: 'other/stage-pipeline/0.15.1' }).endsWith('/stage-pipeline-inline'))
    check('data dir: the source tree of a directory marketplace — the hooks\' directory of its install', dataFor({ 'stage-pipeline@magzhan': [{ installPath: '/elsewhere/stage-pipeline/0.16.0' }] }, { magzhan: { installLocation: marketplaceDir } }).endsWith('/stage-pipeline-magzhan'))
    check('data dir: a worktree of that repo (a --plugin-dir run, not the install\'s tree) — -inline', dataFor({ 'stage-pipeline@magzhan': [{ installPath: '/elsewhere/stage-pipeline/0.16.0' }] }, { magzhan: { installLocation: `${marketplaceDir}-other` } }).endsWith('/stage-pipeline-inline'))
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
const lgAppend = bashGate(lgApp, 'cat >> report', () => appendFileSync(lgOld2, '\n'))
check('journal-gate: old EN report in a RU task, appended via Bash (changed during the call) — no language return', lgAppend.decision === 'allow', lgAppend.text)
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
// VT-3 branch review m-4: the flags are read in one pass, whatever their order; a valueless --firings is an error.
const retroLog = join(retroRoot, 'firings-test.jsonl')
writeFileSync(retroLog, JSON.stringify({ rule: 'agent-guard/review-model', task: 'T', repo: retroRoot, ts: 1, tool: 'Agent', event: 'PreToolUse', read: false }) + '\n')
const retroForward = spawnSync(process.execPath, [join(PLUGIN, 'retro.mjs'), retroRoot, '--firings', retroLog, '--all'], { encoding: 'utf8' })
const retroReversed = spawnSync(process.execPath, [join(PLUGIN, 'retro.mjs'), retroRoot, '--all', '--firings', retroLog], { encoding: 'utf8' })
check('retro: --firings <file> --all reads the file', /agent-guard\/review-model/.test(retroForward.stdout), retroForward.stderr.trim())
check('retro: --all before --firings <file> reads the same file', /agent-guard\/review-model/.test(retroReversed.stdout), retroReversed.stdout.slice(0, 200))
const retroBare = spawnSync(process.execPath, [join(PLUGIN, 'retro.mjs'), retroRoot, '--all', '--firings'], { encoding: 'utf8' })
check('retro: a valueless --firings exits 2 with a message', retroBare.status === 2 && /--firings needs a file/.test(retroBare.stderr), `${retroBare.status} ${retroBare.stderr.trim()}`)
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
    check('stripQuoted cuts backticks and the three kinds of quotes', markers.stripQuoted('a `b` "c" «d» “e” f').replace(/\s+/g, ' ') === 'a f')

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

// ── stage receipts (VT-1 stage 3): the force commit needs the stage's checkers, the close needs fresh final reviews ──
// Each rule: the live incident form that must be denied and the live legitimate form that must pass. The task snapshot records the 0.18 migration on
// 2026-10-20 with no Force run seen then (`setGate`), and the Force blocks are dated after it; report times and receipt times are set by hand.
{
  const rc = await import(join(PLUGIN, 'receipts.mjs'))
  const rRoot = mkdtempSync(join(tmpdir(), 'receipts-test-'))
  const T0 = Date.now() // the run scope drops reports older than the snapshot taken now; events sit at T0 + hours, so none is before it
  const at = (hours) => (T0 + hours * 3600_000) / 1000
  let rCalls = 0
  const REPORT = (checker) => `# ${checker}\nFindings: critical 0 · major 1 · minor 0\n### 🟠 M-1 a.ts:1 — x\n## Findings outcome\n- M-1 — fixed: a.ts:2\n`
  const fixture = (name, { force = '## Force run 2026-10-22', stages = '', ru = false, gate = true } = {}) => {
    const dir = join(rRoot, name)
    const ticket = `T-4${rCalls++}`
    repoAt(dir, 'main')
    const heading = ru ? '### Этап 1: карточка  [status: in-progress]' : '### Stage 1: card  [status: in-progress]'
    write(dir, {
      '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n',
      [`.claude/tasks/${ticket}/STAGES.md`]: `# ${ticket}: task\nBranch: \`${ticket}/feat/r\`\n\n## Status: stage 1\n\n${force}\nConfirmed: 22.10.2026\n\n## Stages\n\n${heading}\n${stages}\n`,
    })
    git(dir, 'checkout', '-qb', `${ticket}/feat/r`)
    runHook('session-start.mjs', { cwd: dir })
    const tdir = join(dir, '.claude/tasks', ticket)
    if (gate) setGate(tdir, '2026-10-20')
    return {
      dir,
      ticket,
      tdir,
      report: (file, checker, hours) => {
        write(dir, { [`.claude/tasks/${ticket}/checks/${file}`]: REPORT(checker) })
        utimesSync(join(tdir, 'checks', file), at(hours), at(hours))
      },
      journal: (stagesText) => write(dir, { [`.claude/tasks/${ticket}/STAGES.md`]: stagesText }),
      // Judge the commit with the pre-hook; if it passes, make it and let the post-hook write the receipt (time set by hand).
      commit: (files, hours, message = 'x') => {
        write(dir, files)
        const id = `toolu_rc_${rCalls++}`
        const call = { cwd: dir, tool_name: 'Bash', tool_use_id: id, tool_input: { command: `git add -A && git commit -m ${message}` } }
        const pre = runHook('git-guard.mjs', { ...call, hook_event_name: 'PreToolUse' })
        if (pre.decision === 'deny') return pre
        git(dir, 'add', '-A')
        git(dir, 'commit', '-qm', message)
        runHook('git-guard.mjs', { ...call, hook_event_name: 'PostToolUse' })
        const path = join(DATA, 'receipts', `${ticket}.jsonl`)
        if (existsSync(path)) {
          const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
          lines.at(-1).at = new Date(at(hours) * 1000).toISOString()
          writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
        }
        return pre
      },
      receipts: () => rc.readReceipts(DATA, ticket),
    }
  }

  // The incident: announcement-details — 17 UI stages, zero devtools-verify; every commit has a pro-review and a design report.
  const ann = fixture('announcement-details', { stages: '- [ ] figma-compare\n- [ ] devtools-verify (skip: MCP-Chrome busy)\n' })
  const denials = []
  for (let n = 1; n <= 17; n++) {
    ann.report(`pro-review-${n}.md`, 'pro-review', n * 2)
    ann.report(`figma-compare-${n}.md`, 'figma-compare', n * 2)
    denials.push(ann.commit({ [`src/Card${n}.vue`]: `<template>${n}</template>\n` }, n * 2 + 1))
  }
  check('receipts AC-3.2: 17 UI stages with zero devtools-verify — every commit denied, naming devtools-verify', denials.every((d) => d.decision === 'deny' && /devtools-verify/.test(d.text) && /legitimate skip/.test(d.text)), denials.find((d) => d.decision !== 'deny')?.text)
  check('receipts AC-3.2: a browser-reason skip line ("MCP-Chrome busy") is not a legitimate skip', /MCP busy/.test(denials[0].text) && ann.receipts().length === 0)
  // The legitimate forms: a devtools-verify report; a skip line with a legitimate reason (the receipt keeps the skip).
  ann.report('devtools-verify-1.md', 'devtools-verify', 40)
  check('receipts AC-3.2: devtools-verify report in the window — the UI commit passes', ann.commit({ 'src/Card1.vue': '<template>ok</template>\n' }, 41).decision === 'allow')
  check('receipts: the receipt keeps sha, tree, reports and counts', (() => {
    const [r] = ann.receipts()
    return r?.sha === git(ann.dir, 'rev-parse', 'HEAD').trim() && r.tree === git(ann.dir, 'rev-parse', 'HEAD^{tree}').trim() && r.reports.some((n) => n.startsWith('devtools-verify')) && r.counts.major >= 1 && r.ui === true && r.runtime === true
  })())
  const skipped = fixture('skip-legit', { stages: '- [ ] figma-compare (skip: no design source)\n- [x] devtools-verify (skip: logic-only — nothing visible changes)\n' })
  skipped.report('pro-review-1.md', 'pro-review', 2)
  check('receipts AC-3.2: legitimate skip lines (no design source / logic-only) — the UI commit passes', skipped.commit({ 'src/Card.css': '.a { color: red }\n' }, 3).decision === 'allow')
  check('receipts AC-3.2: the skip is in the receipt, the UI stage is listed as without runtime check', (() => {
    const [r] = skipped.receipts()
    return r?.skips.some((s) => s.checker === 'devtools-verify' && s.legit && /logic-only/.test(s.reason)) && r.runtime === false
  })())
  // Digest: the full view lists the stage, the short view shows the count.
  const digestFull = rc.stagesWithoutRuntime(DATA, skipped.tdir, 0)
  const { runDigest } = await import(join(PLUGIN, 'run-digest.mjs'))
  const full = runDigest(skipped.tdir, DATA, null, 'full')
  const short = runDigest(skipped.tdir, DATA, null, 'short')
  check('receipts AC-3.5: full digest lists "Stages without runtime check" with the skip', digestFull.length === 1 && /### Stages without runtime check \(1\)/.test(full) && /Card\.css/.test(full) && /logic-only/.test(full), full)
  check('receipts AC-3.5: the short view shows the count, not the lines', /### Stages without runtime check \(1\)/.test(short) && !/Card\.css/.test(short), short)

  // pro-review in the window.
  const pr = fixture('no-pro-review', { stages: '' })
  pr.report('dead-code-1.md', 'dead-code', 2)
  const noPro = pr.commit({ 'src/b.ts': 'export const b = 1\n' }, 3)
  check('receipts AC-3.1: a window without pro-review — denied, names pro-review stage mode', noPro.decision === 'deny' && /pro-review/.test(noPro.text) && /stage mode/.test(noPro.text), noPro.text)
  pr.report('pro-review-1.md', 'pro-review', 4)
  check('receipts AC-3.1: with a pro-review report in the window — passes (logic file, no UI rules)', pr.commit({ 'src/b.ts': 'export const b = 1\n' }, 5).decision === 'allow')
  // The window moves with the previous force commit: the old report does not carry the next stage.
  pr.journal(`# ${pr.ticket}: task\nBranch: \`${pr.ticket}/feat/r\`\n\n## Status: stage 2\n\n## Force run 2026-10-22\nConfirmed: 22.10.2026\n\n## Stages\n\n### Stage 2: next  [status: in-progress]\n`)
  check('receipts AC-3.1: the next stage commit does not reuse the previous stage report — denied', pr.commit({ 'src/c.ts': 'export const c = 1\n' }, 6).decision === 'deny')

  // Second force commit inside one stage (fix commit) and the final catch-up.
  const fx = fixture('fix-commit', { stages: '- [x] figma-compare (skip: no design source)\n- [x] devtools-verify (skip: logic-only)\n' })
  fx.report('pro-review-1.md', 'pro-review', 2)
  fx.commit({ 'src/Panel.vue': '<template>1</template>\n', 'src/x.ts': 'export const x = 1\n' }, 3)
  const fixSame = fx.commit({ 'src/Panel.vue': '<template>2</template>\n' }, 4, 'fix')
  check('receipts: a fix commit right after the stage commit (same files, no new reports) — continuation, passes', fixSame.decision === 'allow' && fx.receipts().length === 2 && fx.receipts()[1].continuation === true)
  const fixNew = fx.commit({ 'src/Other.vue': '<template>new</template>\n' }, 5, 'more')
  check('receipts: a commit that brings a new file after the stage commit is a stage of its own — denied', fixNew.decision === 'deny' && /pro-review/.test(fixNew.text), fixNew.text)
  fx.report('pro-review-branch.md', 'pro-review', 6)
  check('receipts: the final catch-up commit with a whole-branch pro-review report in the window — passes', fx.commit({ 'src/Other.vue': '<template>new</template>\n' }, 7, 'catch-up').decision === 'allow')

  // logic-only stage with UI files needs no design report.
  const lo = fixture('logic-only')
  lo.journal(`# ${lo.ticket}: task\nBranch: \`${lo.ticket}/feat/r\`\n\n## Status: stage 1\n\n## Force run 2026-10-22\nConfirmed: 22.10.2026\n\n## Stages\n\n### Stage 1: tooling  [status: in-progress]  logic-only\n- [x] devtools-verify (skip: logic-only)\n`)
  lo.report('pro-review-1.md', 'pro-review', 2)
  check('receipts: a logic-only stage needs no design report even when an .html file changes', lo.commit({ 'docs/deck.html': '<p>x</p>\n' }, 3).decision === 'allow')

  // Russian twin: the same incident in a Russian journal.
  const ru = fixture('ru', { ru: true, force: '## Force-прогон 2026-10-22', stages: '- [ ] figma-compare\n- [ ] devtools-verify (skip: браузер занят)\n' })
  ru.report('pro-review-1.md', 'pro-review', 2)
  ru.report('figma-compare-1.md', 'figma-compare', 2)
  const ruDenied = ru.commit({ 'src/Card.tsx': 'export const Card = () => null\n' }, 3)
  check('receipts RU: UI stage with no devtools-verify and a browser-reason skip — denied', ruDenied.decision === 'deny' && /devtools-verify/.test(ruDenied.text), ruDenied.text)

  // The date gate: a Force block before the release, and a task of another branch, are left alone.
  const old = fixture('old-block', { force: '## Force run 2026-10-19' })
  check('receipts: a Force block dated before the release — no new deny (UI commit, no reports)', old.commit({ 'src/Old.vue': '<template>o</template>\n' }, 3).decision === 'allow' && old.receipts().length === 0)
  // m-2 (VT-1 5a): the gate is the snapshot's migration day, not a guessed release date.
  const onDay = fixture('opened-on-migration-day', { force: '## Force run 2026-10-20' })
  check('receipts m-2: a block opened on the day the snapshot recorded — the rules apply (UI commit with no reports denied)', onDay.commit({ 'src/Day.vue': '<template>d</template>\n' }, 3).decision === 'deny')
  const unread = fixture('unreadable-date', { force: '## Force run Oct 23' })
  unread.journal(`# ${unread.ticket}: task\nBranch: \`${unread.ticket}/feat/r\`\n\n## Status: stage 1\n\n## Force run Oct 23\nConfirmed: Oct 23 — yes\n\n## Stages\n\n### Stage 1: card  [status: in-progress]\n`)
  const unreadDenied = unread.commit({ 'src/Unread.vue': '<template>u</template>\n' }, 3)
  check('receipts m-2: a new block whose heading and Confirmed dates do not parse ("Oct 23") — fails closed, the rules apply', unreadDenied.decision === 'deny' && /pro-review/.test(unreadDenied.text), unreadDenied.text)
  setGate(unread.tdir, '2026-10-20', ['## Force run Oct 23'])
  check('receipts m-2: the same block when it was already there at the migration — left alone', unread.commit({ 'src/Unread.vue': '<template>u2</template>\n' }, 4).decision === 'allow')
  // B1 containment: a block open when the plugin first sees the task on 0.18 and dated before that day (VT-1's own `## Force run 2026-10-19`, every live run) keeps the old rules.
  const natural = fixture('seen-at-migration', { force: '## Force run 2026-10-19', gate: false })
  const naturalGate = jc.releaseGate(DATA, natural.tdir)
  check('receipts m-2: the migration records its day and the open Force heading dated before it', /^\d{4}-\d{2}-\d{2}$/.test(naturalGate.since) && naturalGate.seen.has('## Force run 2026-10-19'), JSON.stringify({ since: naturalGate.since, seen: [...naturalGate.seen] }))
  check('receipts m-2: that block stays pre-release — a UI commit with no reports passes, no receipt', natural.commit({ 'src/Live.vue': '<template>l</template>\n' }, 3).decision === 'allow' && natural.receipts().length === 0)
  // M-1 (5a fix round 1): a block dated the migration day is not recorded as seen, even when it is in the text at the first look — it may be the very edit that opened it.
  const today = new Date()
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const sameDay = fixture('on-day-at-first-look', { force: `## Force run ${todayIso}`, gate: false })
  const sameDayGate = jc.releaseGate(DATA, sameDay.tdir)
  check('receipts M-1: a block dated the migration day, there at the first look — not seen, a UI commit with no reports is denied', sameDayGate.seen.size === 0 && sameDay.commit({ 'src/Day.vue': '<template>d</template>\n' }, 3).decision === 'deny', JSON.stringify({ since: sameDayGate.since, seen: [...sameDayGate.seen] }))
  const other = fixture('other-branch')
  git(other.dir, 'checkout', '-qb', 'unrelated/branch')
  check('receipts: a task that is not the current branch\'s is left alone', runHook('git-guard.mjs', { cwd: other.dir, tool_input: { command: 'git commit --allow-empty -m x' } }).decision === 'allow')

  // Close as completed: whole-branch pro-review and task-converge newer than the last code commit.
  const close = fixture('close', { stages: '' })
  close.report('pro-review-1.md', 'pro-review', 2)
  close.commit({ 'src/z.ts': 'export const z = 1\n' }, 3)
  const closed = (suffix = 'completed', body = '') => `# ${close.ticket}: task\nBranch: \`${close.ticket}/feat/r\`\n\n## Status: done\n\n## Force run 2026-10-22 — ${suffix}\nConfirmed: 22.10.2026\n${body}\n## Stages\n\n### Stage 1: card  [status: done]\n`
  const closeGate = () => runHook('journal-gate.mjs', { cwd: close.dir, tool_name: 'Write', tool_input: { file_path: join(close.tdir, 'STAGES.md') } })
  const REAL_STALE = Date.parse('2026-10-18T09:00:00') / 1000
  close.journal(closed())
  const noFinal = closeGate()
  check('receipts AC-3.3: completed with no whole-branch pro-review and no task-converge — rejected, both named', noFinal.decision === 'block' && /pro-review: no whole-task report/.test(noFinal.text) && /task-converge: no whole-task report/.test(noFinal.text), noFinal.text)
  close.report('pro-review-branch.md', 'pro-review', 8)
  close.report('task-converge.md', 'task-converge', 8)
  utimesSync(join(close.tdir, 'checks/task-converge.md'), REAL_STALE, REAL_STALE)
  const stale = closeGate()
  check('receipts AC-3.3: a task-converge report older than the last code commit — rejected', stale.decision === 'block' && /task-converge: no whole-task report/.test(stale.text) && !/pro-review: no whole-task/.test(stale.text), stale.text)
  check('receipts 5d AC-5d.1: the message shows the marker for a stale report', /`\[final: task-converge — stale\]`/.test(stale.text), stale.text)
  close.journal(closed('completed with blockers', 'Blockers: B1 — [final: task-converge — stale] no capacity after the catch-up commit\n'))
  const named = closeGate()
  check('receipts AC-3.3: completed with blockers naming the missing report by its marker — accepted', named.decision !== 'block', named.text)
  close.journal(closed('completed with blockers', 'Blockers: B1 — task-converge did not run: no capacity\n'))
  const prose = closeGate()
  check('receipts 5d AC-5d.1: an honest prose blocker does not count — rejected, the message quotes the line and shows the marker to add', prose.decision === 'block' && /names task-converge in prose/.test(prose.text) && /add `\[final: task-converge — stale\]`/.test(prose.text), prose.text)
  close.journal(closed('completed with blockers', 'Blockers: B1 — something unrelated\n'))
  check('receipts AC-3.3: completed with blockers that does not name the missing report — rejected', /task-converge: no whole-task report/.test(closeGate().text))
  close.report('task-converge.md', 'task-converge', 9)
  close.journal(closed())
  check('receipts AC-3.3: both reports fresh — the close is accepted', closeGate().decision !== 'block', closeGate().text)
  const oldClose = fixture('old-close', { force: '## Force run 2026-10-19 — completed' })
  check('receipts: a close of a pre-release Force block is not checked', runHook('journal-gate.mjs', { cwd: oldClose.dir, tool_name: 'Write', tool_input: { file_path: join(oldClose.tdir, 'STAGES.md') } }).decision !== 'block')

  // ── fix round 1 of stage 3 (pro-review-3) ──
  const stagesOf = (fx, body, heading = '### Stage 1: card  [status: in-progress]') =>
    `# ${fx.ticket}: task\nBranch: \`${fx.ticket}/feat/r\`\n\n## Status: stage 1\n\n## Force run 2026-10-22\nConfirmed: 22.10.2026\n\n## Stages\n\n${heading}\n${body}\n`
  const gitAt = (dir, hours, ...args) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: new Date(at(hours) * 1000).toISOString() }, stdio: 'ignore' })

  // M-1: the space form `[status: in progress]` is a live form; the stage keeps its skip lines.
  const sp = fixture('status-space')
  sp.journal(stagesOf(sp, '- [x] figma-compare (skip: no design source)\n- [x] devtools-verify (skip: logic-only — no visual change)\n', '### Stage 1: card  [status: in progress]'))
  sp.report('pro-review-1.md', 'pro-review', 2)
  check('receipts M-1: `[status: in progress]` (space form) — the stage skip lines are read, a .css commit passes', sp.commit({ 'src/Card.css': '.a { color: red }\n' }, 3).decision === 'allow')

  // m-1: a continuation inherits runtime (and skips) from the receipt it continues.
  const ct = fixture('continuation-runtime', { stages: '- [x] figma-compare (skip: no design source)\n' })
  ct.report('pro-review-1.md', 'pro-review', 2)
  ct.report('devtools-verify-1.md', 'devtools-verify', 2)
  ct.commit({ 'src/Panel.vue': '<template>1</template>\n' }, 3)
  ct.commit({ 'src/Panel.vue': '<template>2</template>\n' }, 4, 'fix')
  check('receipts m-1: a fix commit after a stage with devtools-verify keeps runtime:true, no "without runtime check" item', ct.receipts().length === 2 && ct.receipts()[1].continuation === true && ct.receipts()[1].runtime === true && rc.stagesWithoutRuntime(DATA, ct.tdir, 0).length === 0)
  const ctSkip = fixture('continuation-skips', { stages: '- [x] figma-compare (skip: no design source)\n- [x] devtools-verify (skip: logic-only)\n' })
  ctSkip.report('pro-review-1.md', 'pro-review', 2)
  ctSkip.commit({ 'src/Panel.css': '.a{}\n' }, 3)
  ctSkip.journal(stagesOf(ctSkip, '- [ ] commit\n'))
  ctSkip.commit({ 'src/Panel.css': '.a{color:red}\n' }, 4, 'fix')
  check('receipts m-1: a continuation inherits the skips of the receipt it continues', ctSkip.receipts()[1]?.continuation === true && ctSkip.receipts()[1].skips.some((x) => x.checker === 'devtools-verify' && x.legit))

  // m-2: an amend and a rebase rewrite the sha — the continuation is found by tree / patch-id.
  const am = fixture('amend', { stages: '- [x] figma-compare (skip: no design source)\n- [x] devtools-verify (skip: logic-only)\n' })
  am.report('pro-review-1.md', 'pro-review', 2)
  am.commit({ 'src/Panel.vue': '<template>1</template>\n' }, 3)
  git(am.dir, 'commit', '--amend', '-qm', 'reworded')
  check('receipts m-2: after an amend (new sha, same tree) a fix commit of the same file is a continuation', am.commit({ 'src/Panel.vue': '<template>2</template>\n' }, 4, 'fix').decision === 'allow' && am.receipts().at(-1).continuation === true)
  const rb = fixture('rebase', { stages: '- [x] figma-compare (skip: no design source)\n- [x] devtools-verify (skip: logic-only)\n' })
  rb.report('pro-review-1.md', 'pro-review', 2)
  rb.commit({ 'src/Panel.vue': '<template>1</template>\n' }, 3)
  git(rb.dir, 'checkout', '-q', 'main')
  write(rb.dir, { 'base.txt': 'moved base\n' })
  git(rb.dir, 'add', '-A')
  git(rb.dir, 'commit', '-qm', 'base moved')
  git(rb.dir, 'checkout', '-q', `${rb.ticket}/feat/r`)
  git(rb.dir, 'rebase', '-q', 'main')
  check('receipts m-2: after a rebase (new sha, new tree, same patch) a fix commit is a continuation', rb.commit({ 'src/Panel.vue': '<template>2</template>\n' }, 4, 'fix').decision === 'allow' && rb.receipts().at(-1).continuation === true)

  // m-3: freshness of the final reports is measured from when HEAD's tree appeared.
  const fr = fixture('fresh', { stages: '' })
  fr.report('pro-review-1.md', 'pro-review', 2)
  fr.commit({ 'src/z.ts': 'export const z = 1\n' }, 3)
  fr.report('pro-review-branch.md', 'pro-review', 8)
  fr.report('task-converge.md', 'task-converge', 8)
  const frClosed = `# ${fr.ticket}: task\nBranch: \`${fr.ticket}/feat/r\`\n\n## Status: done\n\n## Force run 2026-10-22 — completed\nConfirmed: 22.10.2026\n\n## Stages\n\n### Stage 1: card  [status: done]\n`
  fr.journal(frClosed)
  const frGate = () => runHook('journal-gate.mjs', { cwd: fr.dir, tool_name: 'Write', tool_input: { file_path: join(fr.tdir, 'STAGES.md') } })
  gitAt(fr.dir, 20, 'commit', '--amend', '--no-edit', '-q')
  check('receipts m-3: an amend that keeps HEAD\'s tree (committed after the reports) does not make them stale', frGate().decision !== 'block', frGate().text)
  write(fr.dir, { 'src/z.ts': 'export const z = 2\n' })
  const dirty = frGate()
  check('receipts m-3: an uncommitted edit of a tracked file outside the task dir makes the reports stale', dirty.decision === 'block' && /uncommitted/.test(dirty.text), dirty.text)
  git(fr.dir, 'checkout', '--', 'src/z.ts')
  write(fr.dir, { 'README.md': 'docs\n' })
  git(fr.dir, 'add', '-A')
  gitAt(fr.dir, 9, 'commit', '-qm', 'docs only')
  const docs = frGate()
  check('receipts m-3: a docs-only commit after the reports still counts as a change — rejected', docs.decision === 'block' && /no whole-task report/.test(docs.text), docs.text)

  // m-4, then 5d AC-5d.1 (B1): a missing final report is named by its marker `[final: <report> — not run | stale]`, never by prose.
  const bl = fixture('blocker-words', { stages: '' })
  bl.report('pro-review-1.md', 'pro-review', 2)
  bl.commit({ 'src/z.ts': 'export const z = 1\n' }, 3)
  bl.report('task-converge.md', 'task-converge', 8)
  const blClosed = (blockers) => `# ${bl.ticket}: task\nBranch: \`${bl.ticket}/feat/r\`\n\n## Status: done\n\n## Force run 2026-10-22 — completed with blockers\nConfirmed: 22.10.2026\n${blockers}\n## Stages\n\n### Stage 1: card  [status: done]\n`
  const blGate = () => runHook('journal-gate.mjs', { cwd: bl.dir, tool_name: 'Write', tool_input: { file_path: join(bl.tdir, 'STAGES.md') } })
  const rejected = (blockers) => {
    bl.journal(blClosed(blockers))
    const result = blGate()
    return result.decision === 'block' && /pro-review: no whole-task report/.test(result.text) && !/task-converge: no whole-task/.test(result.text)
  }
  const accepted = (blockers) => {
    bl.journal(blClosed(blockers))
    return blGate().decision !== 'block'
  }
  check('receipts m-4: a blocker that only mentions pro-review in passing does not cover the missing whole-branch review', rejected('Blockers: B1 — pro-review of stage 2 needs a backend answer\n'))
  // fresh-2 M-1: a finding blocker with a not-run phrase near the checker name (the required B6 probe and its kin) does not count.
  check('receipts 5d AC-5d.1: B6 "pro-review found a critical, fix-loop exhausted; report missing a recheck" does not count', rejected('Blockers: B6 — pro-review found a critical, fix-loop exhausted; report missing a recheck\n'))
  check('receipts 5d AC-5d.1: "pro-review M-2: the migration was not run on staging" does not count', rejected('Blockers: B4 — pro-review M-2: the migration was not run on staging; needs the user\n'))
  check('receipts 5d AC-5d.1 RU: the Russian twin of B6 does not count', rejected('Blockers: B6 — pro-review нашёл critical, fix-loop исчерпан; в отчёте нет перепроверки\n'))
  check('receipts 5d AC-5d.1 RU: the Russian twin of B4 (the migration was not run on staging) does not count', rejected('Blockers: B4 — pro-review M-2: миграция не запускалась на стейдже; решение пользователя\n'))
  // fresh-2 M-2: an honest prose line does not count either; the message quotes it and shows the marker to add.
  bl.journal(blClosed('Blockers: B1 — whole-branch pro-review was not run: no capacity\n'))
  const honest = blGate()
  check('receipts 5d AC-5d.1: an honest prose blocker ("whole-branch pro-review was not run") is rejected, the message shows `[final: pro-review — not run]`', honest.decision === 'block' && /The blocker "B1 — whole-branch pro-review was not run: no capacity" names pro-review in prose/.test(honest.text) && /add `\[final: pro-review — not run\]` to it/.test(honest.text), honest.text)
  check('receipts 5d AC-5d.1 RU: the honest Russian prose (whole-branch pro-review was not run) is rejected too', rejected('Blockers: B2 — pro-review по всей ветке не был запущен\n'))
  check('receipts 5d AC-5d.1: the marker line is accepted', accepted('Blockers: B1 — [final: pro-review — not run] no capacity after stage 5\n'))
  check('receipts 5d AC-5d.1: the marker in backticks is accepted', accepted('Blockers: B1 — `[final: pro-review — not run]` token limit\n'))
  check('receipts 5d AC-5d.1: either state names the report (`stale` for a review that never ran)', accepted('Blockers: B1 — [final: pro-review — stale] token limit\n'))
  check('receipts 5d AC-5d.1: the Russian marker counts in an English task (the hooks read both languages)', accepted('Blockers: B1 — [final: pro-review — не запускался] нет места\n'))
  check('receipts 5d AC-5d.1: a marker for the other report does not count', rejected('Blockers: B1 — [final: task-converge — not run] no capacity\n'))
  check('receipts 5d AC-5d.1: a lifted blocker with the marker does not count', rejected('Blockers: B1 — [final: pro-review — not run] no capacity — lifted by the user 2026-10-22\n'))
  check('receipts 5d AC-5d.1: the marker on the Blockers field line after another item counts', accepted('Blockers: B1 — backend contract; B2 — [final: pro-review — not run] token limit\n'))
  // The Russian task: the message shows the Russian marker, and the Russian marker line passes.
  const blRu = fixture('blocker-words-ru', { stages: '', ru: true })
  blRu.report('pro-review-1.md', 'pro-review', 2)
  blRu.commit({ 'src/z.ts': 'export const z = 1\n' }, 3)
  blRu.report('task-converge.md', 'task-converge', 8)
  const blRuClosed = (blockers) => `# ${blRu.ticket}: задача\nВетка: \`${blRu.ticket}/feat/r\`\n\n## Статус: готово\n\n## Force-прогон 2026-10-22 — завершён с блокерами\nПодтверждено: 22.10.2026\n${blockers}\n## Этапы\n\n### Этап 1: карточка  [status: done]\n`
  const blRuGate = () => runHook('journal-gate.mjs', { cwd: blRu.dir, tool_name: 'Write', tool_input: { file_path: join(blRu.tdir, 'STAGES.md') } })
  blRu.journal(blRuClosed('Блокеры: B1 — pro-review по всей ветке не запускался: нет места\n'))
  const ruProse = blRuGate()
  check('receipts 5d AC-5d.1 RU: in a Russian task the prose line is rejected and the message shows the Russian marker', ruProse.decision === 'block' && /add `\[final: pro-review — не запускался\]` to it/.test(ruProse.text), ruProse.text)
  blRu.journal(blRuClosed('Блокеры: B1 — [final: pro-review — не запускался] нет места\n'))
  check('receipts 5d AC-5d.1 RU: the Russian marker line is accepted', blRuGate().decision !== 'block', blRuGate().text)
  blRu.journal(blRuClosed('Блокеры: B1 — [final: task-converge — устарел] нет места\n'))
  check('receipts 5d AC-5d.1 RU: the Russian marker for the other report does not count', /pro-review: no whole-task report/.test(blRuGate().text), blRuGate().text)
  // pro-review r1 m-2: an honest marker blocker whose reason holds a lift word reads as lifted; the message says so instead of asking for the marker it has.
  const liftedMsg = (gate, journal, blockers, shown) => {
    journal(blockers)
    const result = gate()
    return result.decision === 'block' && /pro-review: no whole-task report/.test(result.text) && /has a marker but reads as lifted/.test(result.text) && /drop the lift word/.test(result.text) && shown.test(result.text)
  }
  check('receipts 5d AC-5d.1 m-2: "[final: pro-review — not run] skipped per user decision 2026-10-20" reads as lifted — the message says so', liftedMsg(blGate, (b) => bl.journal(blClosed(b)), 'Blockers: B1 — [final: pro-review — not run] skipped per user decision 2026-10-20 no capacity\n', /skipped per user decision/))
  check('receipts 5d AC-5d.1 m-2: "… closed by the token limit" reads as lifted — the message says so', liftedMsg(blGate, (b) => bl.journal(blClosed(b)), 'Blockers: B1 — [final: pro-review — not run] closed by the token limit\n', /closed by the token limit/))
  // 5e K3: the Russian noun for "closing" ("after the closing of stage 5") describes, it no longer lifts; the same message is now asked of the participle.
  check('receipts 5d AC-5d.1 m-2 RU: a reason with "closed by the user" reads as lifted — the message says so', liftedMsg(blRuGate, (b) => blRu.journal(blRuClosed(b)), 'Блокеры: B1 — [final: pro-review — не запускался] нет места, закрыт пользователем\n', /закрыт пользователем/))
  check('receipts 5d AC-5d.1 m-2 RU: a reason with "the limit was not lifted" reads as lifted — the message says so', liftedMsg(blRuGate, (b) => blRu.journal(blRuClosed(b)), 'Блокеры: B1 — [final: pro-review — не запускался] лимит снят не был, нет места\n', /лимит снят не был/))
  // 5e r1 m-3: in a block dated on or after the lift-field day the message names the field, not lift words.
  bl.journal(blClosed('Blockers: B1 — [final: pro-review — not run] x — Lifted: user 2026-10-27\n').replace('Force run 2026-10-22', 'Force run 2026-10-27').replace('Confirmed: 22.10.2026', 'Confirmed: 27.10.2026'))
  const newMsg = blGate()
  check('5e r1 m-3: in a new block the "reads as lifted" message names the Lifted: field and says to remove it, not to drop a lift word', newMsg.decision === 'block' && /has a marker but reads as lifted \(it carries the lift field/.test(newMsg.text) && /remove that field/.test(newMsg.text) && !/drop the lift word/.test(newMsg.text), newMsg.text)
  // The same close rule for the negated lift words: an open blocker stays open ("not closed by anyone"), the lifted one is lifted.
  const lifted = (line) => markers.BLOCKER_LIFTED.test(line)
  check('markers r1: Russian negated lift words stay open (not closed, was not closed, not lifted, unclosed, not resolved)', ['B1 — вопрос не закрыт', 'B1 — этап не был закрыт', 'B1 — лимит не снят', 'B1 — незакрытый вопрос', 'B1 — вопрос не решён'].every((line) => !lifted(line)))
  check('markers r1: Russian lift words lift (lifted by the user with a date, closed, resolved)', ['B1 — лимит снят пользователем 2026-10-20', 'B1 — вопрос закрыт', 'B1 — вопрос решён', 'B1 — вопрос о цене снят', 'B1 — баг на экране закрыт', 'B1 — вопрос в дизайне закрыт', 'B1 — вопрос о цене снят пользователем 2026-10-22'].every(lifted))
  check('markers r1: English negated lift words stay open, the plain ones lift', ['B1 — not lifted by the user', 'B1 — never closed by anyone', "B1 — isn't resolved by the team", 'B1 — un-closed by default', 'B2 — wasn’t closed by the user', 'B3 — isn’t resolved by the team'].every((line) => !lifted(line)) && ['B1 — lifted by the user 2026-10-20', 'B1 — resolved by the team', 'B1 — resolved: yes'].every(lifted))
  check('markers r1: openBlockers keeps a Russian "not closed" blocker open (so a "completed" close is stopped by it) and drops one lifted by the user with a date', jc.openBlockers('Blockers: B1 — вопрос не закрыт; B2 — лимит снят пользователем 2026-10-20\n').length === 1 && jc.openBlockers('B1 — вопрос не закрыт\nB2 — not closed by anyone\nB3 — closed by the user 2026-10-20\n').length === 2)
  check(
    'markers: finalMarkerReports reads both reports and both languages, finalMarker writes the task-language form',
    same([...markers.finalMarkerReports('B1 — [final: pro-review — not run]; B2 — [final: task-converge — устарел]')], ['pro-review', 'task-converge']) &&
      markers.finalMarker('task-converge', 'stale', 'ru') === '[final: task-converge — устарел]' &&
      markers.finalMarker('pro-review', 'missing', null) === '[final: pro-review — not run]' &&
      markers.finalMarkerReports('B1 — final: pro-review — not run').size === 0,
  )

  // m-5: a devtools-verify skip reason is a runtime reason, not a design-checker one.
  const ds = fixture('devtools-design-reason', { stages: '- [x] figma-compare (skip: no design source)\n- [x] devtools-verify (skip: no design source)\n' })
  ds.report('pro-review-1.md', 'pro-review', 2)
  const dsDenied = ds.commit({ 'src/Card.css': '.a { color: red }\n' }, 3)
  check('receipts m-5: `devtools-verify (skip: no design source)` is denied', dsDenied.decision === 'deny' && /devtools-verify/.test(dsDenied.text), dsDenied.text)
  ds.journal(stagesOf(ds, '- [x] figma-compare (skip: no design source)\n- [x] devtools-verify (skip: visuals unchanged)\n'))
  check('receipts m-5: `devtools-verify (skip: visuals unchanged)` passes', ds.commit({ 'src/Card.css': '.a { color: red }\n' }, 3).decision === 'allow')

  // m-6: a skip line under a later Journal heading is not the last stage's skip.
  const jl = fixture('journal-skip', { stages: '' })
  jl.report('pro-review-1.md', 'pro-review', 2)
  jl.journal(stagesOf(jl, '- [ ] devtools-verify\n') + '\n## Journal\n\n### 2026-10-22 check\n- [x] devtools-verify (skip: logic-only)\n- [x] figma-compare (skip: no design source)\n')
  check('receipts m-6: openStages ends the stage block at `## Journal`', rc.openStages(readFileSync(join(jl.tdir, 'STAGES.md'), 'utf8')).every((stage) => stage.skips.length === 0))
  check('receipts m-6: a skip line under the Journal does not let a .css commit through', jl.commit({ 'src/Card.css': '.a { color: red }\n' }, 3).decision === 'deny')

  // pro-review round 3 (M-1): a defect blocker that names the checker excuses nothing.
  check('receipts r3 M-1: a blocker that names pro-review but only says "missing"/"not fixed" about a defect does not cover the review', rejected('Blockers: B1 — pro-review: missing null check in cart; not fixed\n'))
  check('receipts r3 M-1 RU: a defect blocker with the bare Russian word for "missing" does not cover the review', rejected('Blockers: B1 — pro-review: отсутствует проверка null в корзине; не исправлено\n'))

  // pro-review round 3 (m-1): a manual commit (no receipt) that is amended later: the reports made after the first commit stay fresh.
  const am2 = fixture('amend-manual', { stages: '' })
  write(am2.dir, { 'src/m.ts': 'export const m = 1\n' })
  git(am2.dir, 'add', '-A')
  gitAt(am2.dir, 3, 'commit', '-qm', 'manual')
  am2.report('pro-review-branch.md', 'pro-review', 8)
  am2.report('task-converge.md', 'task-converge', 8)
  am2.journal(`# ${am2.ticket}: task\nBranch: \`${am2.ticket}/feat/r\`\n\n## Status: done\n\n## Force run 2026-10-22 — completed\nConfirmed: 22.10.2026\n\n## Stages\n\n### Stage 1: card  [status: done]\n`)
  const am2Gate = () => runHook('journal-gate.mjs', { cwd: am2.dir, tool_name: 'Write', tool_input: { file_path: join(am2.tdir, 'STAGES.md') } })
  gitAt(am2.dir, 20, 'commit', '--amend', '-qm', 'manual reworded')
  check('receipts r3 m-1: an amend of a manual commit (no receipt) that keeps the tree does not make the reports stale', am2Gate().decision !== 'block', am2Gate().text)
  am2.report('task-converge.md', 'task-converge', 1)
  check('receipts r3 m-1: a report older than the first appearance of the tree is still stale (the reflog does not make everything fresh)', /task-converge: no whole-task report/.test(am2Gate().text), am2Gate().text)

  // pro-review round 3 (m-2): "logic-only" counts only as the tag after the status bracket, not inside the title.
  const lt = fixture('logic-title')
  lt.journal(`# ${lt.ticket}: task\nBranch: \`${lt.ticket}/feat/r\`\n\n## Status: stage 1\n\n## Force run 2026-10-22\nConfirmed: 22.10.2026\n\n## Stages\n\n### Stage 1: logic-only helpers and the card  [status: in-progress]\n- [x] devtools-verify (skip: logic-only)\n`)
  lt.report('pro-review-1.md', 'pro-review', 2)
  check('receipts r3 m-2: a title that mentions "logic-only" does not waive the design report (.html commit denied)', lt.commit({ 'docs/deck.html': '<p>x</p>\n' }, 3).decision === 'deny')
  check('receipts r3 m-2: the tag after the status bracket is read as logic-only; the same word in the title is not', rc.openStages(`### Stage 1: a  [status: in-progress]  logic-only\n`)[0].logicOnly === true && rc.openStages(`### Stage 1: logic-only a  [status: in-progress]\n`)[0].logicOnly === false)

  // 5d AC-5d.4 (fresh-2 m-4): the live forms of the tag, taken verbatim from the STAGES.md headings on the author's machine; a title word or a negated tag is not one.
  const LOGIC_ONLY_LIVE = [
    '### Этап 1: каркас слоя  [logic-only]  [status: todo]',
    '### Этап 2: кит 0.4.x — то же в `AirbnbPhoneField`  `logic-only`  [status: done]',
    '### Этап 1: Город в профиле обновляется после одобрения заявки — logic-only  [status: done]',
    '### Этап 5: C2C-модалка в общие компоненты (B4)  logic-only  [status: done]',
    '### Этап 13 (догон, logic-only): Один словарь и одно вычисление тона цены  [status: done]',
    '### Этап 3: Фундамент — `useRefetchAt` в shared/lib — logic-only, рефакторинг  [status: done]',
    '### Этап 5: ИИН-валидатор в mycar-webview [logic-only] [репо: ../mycar-webview] [status: вынесен в отдельную задачу — решение пользователя 2026-08-18; ветку делать от webview dev]',
    '### Этап 27: ошибка «trim is not a function» — logic-only  [status: done — `c134337981`; AC-27.3 — `[live: user-side]`]',
    '### Этап 2: обычная деталка на общий composable  `logic-only` `refactor`  [status: done]',
    '### Этап 1: примитив скролла к якорю + аудит [status: done] [logic-only] — коммиты `9489a7e9`, упрощение `daf89fb0`',
    '### Этап 3: иконки — снять 13 MB из билда  [status: код влит в `dev` 2026-09-17, ждёт релиза пакета]  `logic-only`  ⚠ кросс-репо',
    '### Этап 38: Проверить, закрыто ли мерцание  [status: blocked — нужен логин] logic-only  `[live: user-side]`',
    '### Stage 1: past-review analysis — what human reviewers caught and the checkers did not  [status: done]  logic-only',
    '### Этап 1: базовая линия и гигиена зависимостей  [status: done]  `logic-only`',
  ]
  const LOGIC_ONLY_PROSE = [
    '### Stage 1: logic-only helpers and the card  [status: in-progress]',
    '### Stage 3: logic-only tests for the cart — then the card  [status: todo]',
    '### Stage 1: card  [status: in-progress] — not logic-only, the card changes',
    '### Stage 1: card — not `logic-only`  [status: todo]',
    '### Этап 1: карточка  [status: in-progress] — не logic-only, меняется карточка',
    "### Stage 3: the card isn't logic-only  [status: todo]",
    '### Stage 3: the card is no longer logic-only  [status: todo]',
    '### Stage 3: card — never logic-only  [status: todo]',
    '### Stage 3: card — logic-only, then the visual layer  [status: todo]',
    '### Этап 3: карточка — без logic-only  [status: todo]',
    '### Stage 3: the card isn’t logic-only  [status: todo]',
    '### Stage 3: card non-logic-only  [status: todo]',
    '### Stage 3: card — not-logic-only  [status: todo]',
  ]
  const misread = [...LOGIC_ONLY_LIVE.filter((heading) => !markers.logicOnlyTag(heading)), ...LOGIC_ONLY_PROSE.filter((heading) => markers.logicOnlyTag(heading))]
  check('receipts 5d AC-5d.4: every live form of the tag is read, before the status bracket too; title words and "not logic-only" are not', misread.length === 0, misread.join(' | '))
  // pro-review 5d fresh m-2: the tail check is bounded by the span up to the status bracket, so a long dash-led heading does not go quadratic.
  const adversarial = `### Stage 1: ${'a — logic-only, '.repeat(20000)}x  [status: todo]`
  const t0 = performance.now()
  markers.logicOnlyTag(adversarial)
  const spent = performance.now() - t0
  check('receipts 5d fresh m-2: a 300 KB heading of repeated "— logic-only," is read in under 100 ms', spent < 100, `${Math.round(spent)} ms`)
  const lb = fixture('logic-before-bracket')
  lb.journal(`# ${lb.ticket}: task\nBranch: \`${lb.ticket}/feat/r\`\n\n## Status: stage 1\n\n## Force run 2026-10-22\nConfirmed: 22.10.2026\n\n## Stages\n\n### Stage 1: layer skeleton  [logic-only]  [status: in-progress]\n- [x] devtools-verify (skip: logic-only)\n`)
  lb.report('pro-review-1.md', 'pro-review', 2)
  check('receipts 5d AC-5d.4: a stage tagged `[logic-only]` before the status bracket needs no design report (.html commit passes)', lb.commit({ 'docs/deck.html': '<p>x</p>\n' }, 3).decision === 'allow')
  const ln = fixture('logic-negated')
  ln.journal(`# ${ln.ticket}: task\nBranch: \`${ln.ticket}/feat/r\`\n\n## Status: stage 1\n\n## Force run 2026-10-22\nConfirmed: 22.10.2026\n\n## Stages\n\n### Stage 1: card  [status: in-progress] — not logic-only, the card changes\n- [x] devtools-verify (skip: logic-only)\n`)
  ln.report('pro-review-1.md', 'pro-review', 2)
  check('receipts 5d AC-5d.4: "[status: in-progress] — not logic-only" still needs the design report (.html commit denied)', ln.commit({ 'docs/deck.html': '<p>x</p>\n' }, 3).decision === 'deny')

  // 5d AC-5d.2 (fresh-2 m-1, m-2): freshness follows the branch's reflog. Manual commits A (h2) and B (h3) have no receipt; both reports are from h8.
  const gitWith = (dir, hours, env, ...args) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: new Date(at(hours) * 1000).toISOString(), ...env }, stdio: 'ignore' })
  const editor = join(rRoot, 'todo-editor.mjs')
  writeFileSync(
    editor,
    "import { readFileSync, writeFileSync } from 'node:fs'\nconst [mode, file] = process.argv.slice(2)\nconst text = readFileSync(file, 'utf8')\n" +
      "writeFileSync(file, mode === 'message' ? 'A reworded\\n' : mode === 'reword' ? text.replace(/^pick/m, 'reword') : text.replace(/^(pick .*\\n)pick/m, '$1fixup'))\n",
  )
  const todo = (mode) => ({ GIT_SEQUENCE_EDITOR: `node ${JSON.stringify(editor)} ${mode}`, GIT_EDITOR: `node ${JSON.stringify(editor)} message` })
  const manualClose = (name, { fix = false } = {}) => {
    const fx = fixture(name, { stages: '' })
    const files = [['src/m.ts', 2, 'A'], ['src/n.ts', 3, 'B'], ...(fix ? [['src/fix.ts', 5, 'fix']] : [])]
    for (const [file, hours, message] of files) {
      write(fx.dir, { [file]: `export const x = ${hours}\n` })
      git(fx.dir, 'add', '-A')
      gitAt(fx.dir, hours, 'commit', '-qm', message)
    }
    fx.report('pro-review-branch.md', 'pro-review', 8)
    fx.report('task-converge.md', 'task-converge', 8)
    fx.journal(`# ${fx.ticket}: task\nBranch: \`${fx.ticket}/feat/r\`\n\n## Status: done\n\n## Force run 2026-10-22 — completed\nConfirmed: 22.10.2026\n\n## Stages\n\n### Stage 1: card  [status: done]\n`)
    return { ...fx, gate: () => runHook('journal-gate.mjs', { cwd: fx.dir, tool_name: 'Write', tool_input: { file_path: join(fx.tdir, 'STAGES.md') } }) }
  }
  const treeOf = (dir) => git(dir, 'rev-parse', 'HEAD^{tree}').trim()
  const rbm = manualClose('rebase-manual')
  const keptTree = treeOf(rbm.dir)
  check('receipts 5d AC-5d.2: the manual-commit close with reports from h8 is accepted', rbm.gate().decision !== 'block', rbm.gate().text)
  gitWith(rbm.dir, 20, {}, 'rebase', '-q', '--force-rebase', 'main')
  check('receipts 5d AC-5d.2: `rebase --force-rebase` of manual commits that keeps the tree — the reports stay fresh', treeOf(rbm.dir) === keptTree && rbm.gate().decision !== 'block', rbm.gate().text)
  gitWith(rbm.dir, 21, todo('reword'), 'rebase', '-q', '-i', 'HEAD~2')
  check('receipts 5d AC-5d.2: `rebase -i` rewording A — the reports stay fresh', treeOf(rbm.dir) === keptTree && /A reworded/.test(git(rbm.dir, 'log', '--format=%s')) && rbm.gate().decision !== 'block', rbm.gate().text)
  gitWith(rbm.dir, 22, todo('fixup'), 'rebase', '-q', '-i', 'HEAD~2')
  check('receipts 5d AC-5d.2: `rebase -i` with B as a fixup of A — one commit, the same tree, the reports stay fresh', treeOf(rbm.dir) === keptTree && git(rbm.dir, 'rev-list', '--count', 'main..HEAD').trim() === '1' && rbm.gate().decision !== 'block', rbm.gate().text)
  git(rbm.dir, 'checkout', '-q', 'main')
  write(rbm.dir, { 'base.txt': 'moved base\n' })
  git(rbm.dir, 'add', '-A')
  gitAt(rbm.dir, 23, 'commit', '-qm', 'base moved')
  git(rbm.dir, 'checkout', '-q', `${rbm.ticket}/feat/r`)
  check('receipts 5d AC-5d.2: a checkout away and back leaves the reports fresh (the branch reflog has no entry for it)', rbm.gate().decision !== 'block', rbm.gate().text)
  gitWith(rbm.dir, 24, {}, 'rebase', '-q', 'main')
  check('receipts 5d AC-5d.2: a rebase onto a moved base changes the tree — the reports are stale', /pro-review: no whole-task report/.test(rbm.gate().text) && /task-converge: no whole-task report/.test(rbm.gate().text), rbm.gate().text)

  const ff = manualClose('ff-merge')
  git(ff.dir, 'checkout', '-qb', 'colleague')
  write(ff.dir, { 'src/colleague.ts': 'export const c = 1\n' })
  git(ff.dir, 'add', '-A')
  gitAt(ff.dir, 5, 'commit', '-qm', 'colleague')
  git(ff.dir, 'checkout', '-q', `${ff.ticket}/feat/r`)
  gitWith(ff.dir, 20, {}, 'merge', '-q', '--ff-only', 'colleague')
  check('receipts 5d AC-5d.2: a fast-forward at h20 onto a commit dated h5 — the reports from h8 are stale', /pro-review: no whole-task report/.test(ff.gate().text) && /task-converge: no whole-task report/.test(ff.gate().text), ff.gate().text)

  const rs = manualClose('reset', { fix: true })
  check('receipts 5d AC-5d.2: before the reset the close is accepted (the reports reviewed the fix)', rs.gate().decision !== 'block', rs.gate().text)
  gitWith(rs.dir, 20, {}, 'reset', '-q', '--hard', 'HEAD~1')
  check('receipts 5d AC-5d.2: `reset --hard HEAD~1` at h20 drops the fix — the reports from h8 are stale', /pro-review: no whole-task report/.test(rs.gate().text), rs.gate().text)

  // pro-review r1 m-1: B (h3) is a force commit with a receipt, a manual fix at h5, reports at h8; `reset --hard` onto B at h20 drops the reviewed fix. The receipt of B
  // (h3) must not win the minimum over the reflog's h20.
  const rr = manualClose('reset-receipt', { fix: true })
  mkdirSync(join(DATA, 'receipts'), { recursive: true })
  appendFileSync(join(DATA, 'receipts', `${rr.ticket}.jsonl`), `${JSON.stringify({ sha: git(rr.dir, 'rev-parse', 'HEAD~1').trim(), tree: git(rr.dir, 'rev-parse', 'HEAD~1^{tree}').trim(), at: new Date(at(3) * 1000).toISOString(), branch: `${rr.ticket}/feat/r` })}\n`)
  check('receipts 5d AC-5d.2 m-1: with a receipt on B and the fix reviewed at h8, the close is accepted', rr.gate().decision !== 'block', rr.gate().text)
  gitWith(rr.dir, 20, {}, 'reset', '-q', '--hard', 'HEAD~1')
  check('receipts 5d AC-5d.2 m-1: `reset --hard` onto B (it has a receipt from h3) at h20 drops the fix — the reports from h8 are stale', /pro-review: no whole-task report/.test(rr.gate().text) && /task-converge: no whole-task report/.test(rr.gate().text), rr.gate().text)

  const nr = manualClose('no-reflog')
  git(nr.dir, 'config', 'core.logAllRefUpdates', 'false')
  rmSync(join(nr.dir, '.git', 'logs'), { recursive: true, force: true })
  check('receipts 5d AC-5d.2: with no reflog the committer dates stand in — unchanged, accepted', nr.gate().decision !== 'block', nr.gate().text)
  gitAt(nr.dir, 20, 'commit', '--amend', '-qm', 'B amended')
  check('receipts 5d AC-5d.2: with no reflog an amend at h20 makes the reports stale (the previous behaviour)', /no whole-task report/.test(nr.gate().text), nr.gate().text)

  // 5d AC-5d.3 (fresh-2 m-3): a repo that tracks its task dir. The porcelain status is read with `-z`, untrimmed: ` M .claude/…/STAGES.md` is the task's own file.
  const tt = manualClose('tracked-task-dir')
  tt.journal(stagesOf(tt, ''))
  write(tt.dir, { '.gitignore': 'msg.txt\n', [`.claude/tasks/${tt.ticket}/notes.md`]: 'notes\n' })
  git(tt.dir, 'add', '-A', '.gitignore', `.claude/tasks/${tt.ticket}/STAGES.md`, `.claude/tasks/${tt.ticket}/notes.md`, '.claude/pipeline.config.md')
  gitAt(tt.dir, 4, 'commit', '-qm', 'track the task dir')
  tt.journal(`# ${tt.ticket}: task\nBranch: \`${tt.ticket}/feat/r\`\n\n## Status: done\n\n## Force run 2026-10-22 — completed\nConfirmed: 22.10.2026\n\n## Stages\n\n### Stage 1: card  [status: done]\n`)
  const ttStatus = git(tt.dir, 'status', '--porcelain', '--untracked-files=no')
  check('receipts 5d AC-5d.3: only the tracked journal is modified (unstaged, first status line)', ttStatus.startsWith(` M .claude/tasks/${tt.ticket}/STAGES.md`), JSON.stringify(ttStatus))
  check('receipts 5d AC-5d.3: an unstaged edit of the tracked journal is not a code edit — the close is accepted', tt.gate().decision !== 'block', tt.gate().text)
  git(tt.dir, 'mv', `.claude/tasks/${tt.ticket}/notes.md`, `.claude/tasks/${tt.ticket}/notes-old.md`)
  check('receipts 5d AC-5d.3: a staged rename inside the task dir is not a code edit (the source path of a rename is skipped)', tt.gate().decision !== 'block', tt.gate().text)
  git(tt.dir, 'mv', 'src/m.ts', 'src/moved.ts')
  check('receipts 5d AC-5d.3: a staged rename outside the task dir is named by its new path', /uncommitted edits \(src\/moved\.ts\)/.test(tt.gate().text), tt.gate().text)
}

// ── Stage 4 of VT-1: honest live form, verify-doctor, frames-guard before the first navigation ──────────────
{
  // AC-4.1: a bare `[live: user-side]` on a new line fails, the honest form passes, an older line raises nothing.
  const BARE = '- `AC-4.5` ⏳ — [verify: devtools-verify] [live: user-side]'
  const HONEST = '- `AC-4.5` ⏳ — [verify: devtools-verify] [live: user-side — the profile is not logged in; /orders → redirected to /login]'
  const HONEST_RU = '- `AC-4.5` ⏳ — [verify: devtools-verify] [live: user-side — профиль без входа; /orders → редирект на /login]'
  check('live form: a bare tag on a criterion line is rejected and the message shows the honest form', /live: user-side — <prerequisite>; <route> → <observed>/.test(jc.liveViolation(BARE)?.message ?? ''), JSON.stringify(jc.liveViolation(BARE)))
  check('live form: the honest form passes', jc.liveViolation(HONEST) === null, JSON.stringify(jc.liveViolation(HONEST)))
  check('live form RU: the honest form with Russian prose passes', jc.liveViolation(HONEST_RU) === null)
  check('live form: a reason without the route and the observation is still bare', jc.liveViolation('- `AC-4.5` ⏳ [live: user-side — no login]') !== null)
  check('live form: a quoted (backticked) mention is not a closure, with or without a criterion id', jc.liveViolation('The tag [live: user-side] is rejected when bare') !== null && jc.liveViolation('The tag `[live: user-side]` is rejected when bare') === null && jc.liveViolation('- `AC-4.1` ✅ — closing line quotes `[live: user-side]` as the bare tag') === null)
  check('live form: a line without an AC id ("Could not verify" shape) with a bare tag is rejected', jc.liveViolation('- /orders redirect — [live: user-side]') !== null)
  check('live form: content-free honest forms are bare', ['[live: user-side — n/a; n/a → n/a]', '[live: user-side — -; / → x]', '[live: user-side — no login; → x]', '[live: user-side — tbd; /a → ?]', '[live: user-side — no login; /a → —]', '[live: user-side — ?; /a → x]'].every((tag) => jc.liveViolation(`- \`AC-4.5\` ${tag}`) !== null))
  check('live form: the journal chain returns it (bare) and not the honest one', jc.journalViolations(BARE).some(({ rule }) => rule === 'live-bare') && !jc.journalViolations(HONEST).some(({ rule }) => rule === 'live-bare'))
  const liveData = mkdtempSync(join(tmpdir(), 'live-form-data-'))
  const liveTask = mkdtempSync(join(tmpdir(), 'live-form-task-'))
  writeFileSync(join(liveTask, 'STAGES.md'), `# T-50\nLanguage: en\n\n## Journal\n- 2026-10-01 old\n${BARE.replace('4.5', '1.1')}\n`)
  jc.baselineInfo(liveData, liveTask)
  check('live form: an older bare line (in the snapshot) raises nothing', jc.newJournalViolations(liveData, liveTask).length === 0, JSON.stringify(jc.newJournalViolations(liveData, liveTask)))
  appendFileSync(join(liveTask, 'STAGES.md'), `${BARE}\n`)
  check('live form: a new bare line after the snapshot is returned', jc.newJournalViolations(liveData, liveTask).some(({ rule }) => rule === 'live-bare'))
  writeFileSync(join(liveTask, 'STAGES.md'), `# T-50\nLanguage: en\n\n## Journal\n- 2026-10-01 old\n${BARE.replace('4.5', '1.1')}\n${HONEST}\n`)
  check('live form: a new honest line after the snapshot passes', jc.newJournalViolations(liveData, liveTask).length === 0, JSON.stringify(jc.newJournalViolations(liveData, liveTask)))
  // review round 2 (M-1): a v2 snapshot taken under 0.16 before the live-bare rule has no `liveSeen`: bare tags already in the journal are old, a new bare line still fails
  {
    const migData = mkdtempSync(join(tmpdir(), 'live-mig-data-'))
    const migTask = mkdtempSync(join(tmpdir(), 'live-mig-task-'))
    const migStages = join(migTask, 'STAGES.md')
    writeFileSync(migStages, `# T-51\nLanguage: en\n\n## Journal\n- 2026-10-01 old\n`)
    jc.baselineInfo(migData, migTask)
    const migDir = join(migData, 'journal-baseline')
    const migFile = join(migDir, readdirSync(migDir)[0])
    const migSnap = JSON.parse(readFileSync(migFile, 'utf8'))
    delete migSnap.liveSeen
    writeFileSync(migFile, JSON.stringify(migSnap))
    writeFileSync(migStages, `# T-51\nLanguage: en\n\n## Journal\n- 2026-10-01 old\n${BARE.replace('4.5', '1.1')}\n${HONEST}\n`)
    check('live form: a v2 snapshot without liveSeen, an old bare line + a new honest one — 0 violations', jc.newJournalViolations(migData, migTask).length === 0, JSON.stringify(jc.newJournalViolations(migData, migTask)))
    check('live form: the migration marks the snapshot', JSON.parse(readFileSync(migFile, 'utf8')).liveSeen === true)
    appendFileSync(migStages, `${BARE}\n`)
    check('live form: after the migration a NEW bare line is rejected', jc.newJournalViolations(migData, migTask).some(({ rule }) => rule === 'live-bare'))
  }
  check('live form: a root route `/` is content', jc.liveViolation('- `AC-9.8` [live: user-side — profile not logged in; / → redirected to /login]') === null && jc.liveViolation('- `AC-9.8` [live: user-side — profile not logged in; ? → redirected]') !== null)
  // reports: the rule is for reports written after the snapshot (`fresh`), old ones are not read for it.
  const liveReport = join(liveTask, 'checks', 'devtools-verify-4.md')
  mkdirSync(join(liveTask, 'checks'), { recursive: true })
  const reportBody = (verdict) => `# devtools-verify\nFindings: critical 0 · major 0 · minor 0\ndoctor: ok — http://localhost:3000 answers\nauth: not logged in — /orders → redirected to /login\n\ngeometry 1440: overflow 0 · zero-gap 0 · clipped 0\n\n## Could not verify\n${verdict}\n`
  writeFileSync(liveReport, reportBody('- `AC-4.5` — [live: user-side]'))
  check('live form: a fresh report with a bare tag is rejected', jc.reportViolations(liveReport, null, { fresh: true }).some(({ rule }) => rule === 'live-bare'))
  check('live form: the same report is old (not fresh) — nothing', !jc.reportViolations(liveReport).some(({ rule }) => rule === 'live-bare'))
  writeFileSync(liveReport, reportBody('- /orders redirect — [live: user-side]'))
  check('live form: a fresh report line without an AC id and a bare tag is rejected', jc.reportViolations(liveReport, null, { fresh: true }).some(({ rule }) => rule === 'live-bare'))
  writeFileSync(liveReport, reportBody('- `AC-4.5` — [live: user-side — the profile is not logged in; /orders → redirected to /login]'))
  check('live form: a fresh report with the honest form passes', !jc.reportViolations(liveReport, null, { fresh: true }).some(({ rule }) => rule === 'live-bare'))
  // the new report lines: doctor and auth (EN and RU keys), only for fresh reports
  const noLines = `# devtools-verify\nFindings: critical 0 · major 0 · minor 0\n\ngeometry 1440: overflow 0 · zero-gap 0 · clipped 0\n\n## Could not verify\n- nothing\n`
  writeFileSync(liveReport, noLines)
  check('doctor line: a fresh devtools-verify report without doctor: and auth: is returned twice', jc.reportViolations(liveReport, null, { fresh: true }).filter(({ rule }) => rule === 'no-doctor').length === 2)
  check('doctor line: the same report that is old is left alone', !jc.reportViolations(liveReport).some(({ rule }) => rule === 'no-doctor'))
  writeFileSync(liveReport, noLines.replace('\ngeometry', '\nокружение: ok — http://localhost:3000 answers\nвход: ок — /orders открылся без редиректа\n\ngeometry'))
  check('doctor line RU: the Russian keys count', !jc.reportViolations(liveReport, null, { fresh: true }).some(({ rule }) => rule === 'no-doctor'), JSON.stringify(jc.reportViolations(liveReport, null, { fresh: true })))
  rmSync(liveTask, { recursive: true, force: true })
  rmSync(liveData, { recursive: true, force: true })

  // AC-4.3: verify-doctor against a throwaway listener of our own on a free port, killed by its PID.
  const doctorScript = join(PLUGIN, 'verify-doctor.mjs')
  const mine = mkdtempSync(join(tmpdir(), 'doctor-wt-'))
  const other = mkdtempSync(join(tmpdir(), 'doctor-other-'))
  mkdirSync(join(mine, 'apps/web'), { recursive: true })
  const listen = (dir, body = '<html>app-marker-xyz</html>') =>
    new Promise((done) => {
      const child = spawn(process.execPath, ['-e', `const s=require('http').createServer((q,r)=>r.end(${JSON.stringify(body)})).listen(0,'127.0.0.1',()=>console.log(s.address().port))`], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout.once('data', (data) => done({ child, port: Number(String(data)) }))
    })
  const doctor = (port, ...extra) => spawnSync(process.execPath, [doctorScript, '--cwd', mine, '--url', `http://127.0.0.1:${port}`, ...extra], { encoding: 'utf8' })
  const lsofHere = !spawnSync('lsof', ['-v'], { encoding: 'utf8' }).error
  const foreign = await listen(other)
  const own = await listen(join(mine, 'apps/web'))
  try {
    const wrong = doctor(foreign.port, '--marker', 'app-marker-xyz')
    check('verify-doctor: a listener whose cwd is another directory — "doctor: wrong app", exit 1', !lsofHere || (/^doctor: wrong app — /.test(wrong.stdout) && wrong.status === 1), wrong.stdout)
    const right = doctor(own.port, '--marker', 'app-marker-xyz')
    check('verify-doctor: a listener inside the worktree with the marker — "doctor: ok", exit 0, one line', /^doctor: ok — /.test(right.stdout) && right.status === 0 && right.stdout.trim().split('\n').length === 1, right.stdout)
    const noMarker = doctor(own.port, '--marker', 'nothing-like-this')
    check('verify-doctor: the app marker missing on the route — "doctor: wrong app"', /^doctor: wrong app — marker/.test(noMarker.stdout) && noMarker.status === 1, noMarker.stdout)
  } finally {
    foreign.child.kill()
    own.child.kill()
  }
  const down = doctor(foreign.port)
  check('verify-doctor: nothing listens — "doctor: down", exit 1', /^doctor: down — /.test(down.stdout) && down.status === 1, down.stdout)
  // M-2 (VT-1 5a): no config at all is not a static target — the doctor does not know the url and says so; frames-guard does not accept it.
  const noConfig = spawnSync(process.execPath, [doctorScript, '--cwd', mine], { encoding: 'utf8' })
  check('verify-doctor M-2: no pipeline config here or in a main tree — "doctor: no config", exit 1, not "no dev url"', /^doctor: no config — /.test(noConfig.stdout) && noConfig.status === 1 && !/no dev url/.test(noConfig.stdout), noConfig.stdout + noConfig.stderr)
  write(mine, { '.claude/pipeline.config.md': '# C\n\n## Dev server\n- url: —   # a static deck\n' })
  const bare = spawnSync(process.execPath, [doctorScript, '--cwd', mine], { encoding: 'utf8' })
  check('verify-doctor: a config with no dev url (a static target) — a "doctor: no dev url" line with the reason, exit 0', /^doctor: no dev url — /.test(bare.stdout) && bare.status === 0, bare.stdout)
  // M-2: a linked worktree whose `.claude/` is excluded reads the main tree's config, as the hooks do — the incident printed "no dev url" there and frames-guard let every navigation through.
  {
    const mainRepo = mkdtempSync(join(tmpdir(), 'doctor-main-'))
    repoAt(mainRepo, 'main')
    write(mainRepo, { '.claude/pipeline.config.md': `# C\n- task_path: .claude/tasks/\n\n## Dev server\n- url: http://127.0.0.1:${foreign.port}\n` })
    const linked = join(mkdtempSync(join(tmpdir(), 'doctor-linked-')), 'wt')
    git(mainRepo, 'worktree', 'add', '-q', '-b', 'feat/x', linked)
    const fromLinked = spawnSync(process.execPath, [doctorScript, '--cwd', linked], { encoding: 'utf8' })
    check('verify-doctor M-2: from a linked worktree with `.claude/` excluded — the main tree\'s dev url is probed ("doctor: down", exit 1), not "no dev url"', /^doctor: down — http:\/\/127\.0\.0\.1:\d+\/ did not answer/.test(fromLinked.stdout) && fromLinked.status === 1, fromLinked.stdout + fromLinked.stderr)
    const fromMain = spawnSync(process.execPath, [doctorScript, '--cwd', mainRepo], { encoding: 'utf8' })
    check('verify-doctor M-2: the same from the main tree — the same verdict', /^doctor: down — /.test(fromMain.stdout) && fromMain.status === 1, fromMain.stdout)
    rmSync(mainRepo, { recursive: true, force: true })
    rmSync(dirname(linked), { recursive: true, force: true })
  }
  // S-3 (security): the doctor always ends with a `doctor:` line — a request it cannot make is `doctor: error`, a Location that does not parse is `doctor: down`.
  // A failure is forced by a preload that breaks `http.get`: thrown at once (the promise path) and thrown later in a callback (the uncaught path).
  const crashWith = (body) => spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(`import http from 'node:http'; http.get = () => { ${body} }`)}`, doctorScript, '--cwd', mine, '--url', 'http://127.0.0.1:9'], { encoding: 'utf8' })
  const crashNow = crashWith("throw new Error('boom now')")
  const crashLater = crashWith("setImmediate(() => { throw new Error('boom later') }); return { on() {} }")
  check('verify-doctor S-3: a failure inside the doctor prints "doctor: error — …", exit 1, no stack', /^doctor: error — boom now/.test(crashNow.stdout) && crashNow.status === 1 && !/at .*\.mjs:\d+/.test(crashNow.stderr), crashNow.stdout + crashNow.stderr)
  check('verify-doctor S-3: a failure thrown later in a callback — the same "doctor: error" line', /^doctor: error — boom later/.test(crashLater.stdout) && crashLater.status === 1, crashLater.stdout + crashLater.stderr)
  {
    const badRedirect = await new Promise((done) => {
      const child = spawn(process.execPath, ['-e', `const s=require('http').createServer((q,r)=>{r.statusCode=302;r.setHeader('location','http://[');r.end()}).listen(0,'127.0.0.1',()=>console.log(s.address().port))`], { cwd: other, stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout.once('data', (data) => done({ child, port: Number(String(data)) }))
    })
    try {
      const redirected = doctor(badRedirect.port)
      check('verify-doctor S-3: a redirect whose Location does not parse ("http://[") — "doctor: down", exit 1, not a crash with no verdict', /^doctor: down — .*does not parse/.test(redirected.stdout) && redirected.status === 1 && !redirected.stderr, redirected.stdout + redirected.stderr)
    } finally {
      badRedirect.child.kill()
    }
  }
  // review round 1: femo's «Dev server» line `- routes: <path to a file> — prose` is not a probe route; a url with a remark parses
  mkdirSync(join(mine, '.claude'), { recursive: true })
  const cfg = (lines) => writeFileSync(join(mine, '.claude', 'pipeline.config.md'), `# C\n\n## Dev server\n${lines}\n\n## Other\n`)
  const own2 = await listen(join(mine, 'apps/web'))
  try {
    cfg(`- url: http://127.0.0.1:${own2.port} (https via mkcert)\n- routes: src/shared/config/routes.ts — карта роутов по ролям (\`/admin/*\`)\n- marker: x`)
    const femo = spawnSync(process.execPath, [doctorScript, '--cwd', mine], { encoding: 'utf8' })
    check('verify-doctor: femo-style `routes:` prose and a url with a remark — no false down, no raw stack', /^doctor: ok — /.test(femo.stdout) && femo.status === 0 && !femo.stderr, femo.stdout + femo.stderr)
    cfg(`- url: http://127.0.0.1:${own2.port}\n- verify_routes: src/x.ts — prose, /\n- app_marker: app-marker-xyz`)
    const keyed = spawnSync(process.execPath, [doctorScript, '--cwd', mine], { encoding: 'utf8' })
    check('verify-doctor: verify_routes keeps the /paths, notes the prose; app_marker is read', /^doctor: ok — .*marker found.*ignored in the config/.test(keyed.stdout), keyed.stdout)
    const unparse = spawnSync(process.execPath, [doctorScript, '--cwd', mine, '--url', 'http://'], { encoding: 'utf8' })
    check('verify-doctor: an unparseable url — "doctor: no dev url — url not parseable", exit 0', /^doctor: no dev url — url not parseable/.test(unparse.stdout) && unparse.status === 0 && !unparse.stderr, unparse.stdout + unparse.stderr)
    // basePath app: 404 on `/`, 200 on the base route → not a wrong app
    const based = await new Promise((done) => {
      const child = spawn(process.execPath, ['-e', `const s=require('http').createServer((q,r)=>{if(q.url==='/app'){r.end('app-marker-xyz')}else{r.statusCode=404;r.end('nf')}}).listen(0,'127.0.0.1',()=>console.log(s.address().port))`], { cwd: join(mine, 'apps/web'), stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout.once('data', (data) => done({ child, port: Number(String(data)) }))
    })
    try {
      const withBase = doctor(based.port, '--route', '/', '--route', '/app', '--marker', 'app-marker-xyz')
      check('verify-doctor: basePath app (404 on /, 200 on /app) — ok', /^doctor: ok — /.test(withBase.stdout), withBase.stdout)
      const only404 = doctor(based.port, '--route', '/')
      check('verify-doctor: only 404 answers — wrong app', /^doctor: wrong app — /.test(only404.stdout) && only404.status === 1, only404.stdout)
    } finally {
      based.child.kill()
    }
  } finally {
    own2.child.kill()
  }
  // review round 2 (m-2): a cross-host redirect has an empty body — the marker is checked on 2xx only
  {
    const redirecting = await new Promise((done) => {
      const child = spawn(process.execPath, ['-e', `const s=require('http').createServer((q,r)=>{r.statusCode=302;r.setHeader('location','http://other.invalid/login');r.end()}).listen(0,'127.0.0.1',()=>console.log(s.address().port))`], { cwd: join(mine, 'apps/web'), stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout.once('data', (data) => done({ child, port: Number(String(data)) }))
    })
    try {
      const redirected = doctor(redirecting.port, '--marker', 'app-marker-xyz')
      check('verify-doctor: a cross-host redirect with an app marker — not "wrong app"', /^doctor: ok — /.test(redirected.stdout) && redirected.status === 0, redirected.stdout)
    } finally {
      redirecting.child.kill()
    }
  }
  // a front proxy runs with cwd `/` (a Docker / nginx front)
  if (lsofHere) {
    cfg('- url: —')
    const proxy = await new Promise((done) => {
      const child = spawn(process.execPath, ['-e', `process.chdir('/');const s=require('http').createServer((q,r)=>r.end('x')).listen(0,'127.0.0.1',()=>console.log(s.address().port))`], { cwd: other, stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout.once('data', (data) => done({ child, port: Number(String(data)) }))
    })
    try {
      const viaProxy = doctor(proxy.port)
      check('verify-doctor: a listener with cwd "/" — ok, front proxy, cwd not checked', /^doctor: ok — .*front proxy, cwd not checked/.test(viaProxy.stdout) && viaProxy.status === 0, viaProxy.stdout)
    } finally {
      proxy.child.kill()
    }
  }
  rmSync(mine, { recursive: true, force: true })
  rmSync(other, { recursive: true, force: true })

  // AC-4.4: frames-guard — the transcript without / with a verify-doctor call before the first navigation.
  const gRoot = mkdtempSync(join(tmpdir(), 'doctor-guard-'))
  const gRecord = (time, content, role = 'assistant') => JSON.stringify({ timestamp: new Date(time).toISOString(), message: { role, content } })
  const call = (name, input, id) => ({ type: 'tool_use', id, name, input })
  const answer = (id, text) => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] })
  const guard = (events, name) => {
    const path = join(gRoot, `${name}.jsonl`)
    const now = Date.now() - 100_000
    writeFileSync(path, events.map((content, i) => gRecord(now + i * 1000, content, content[0].type === 'tool_result' ? 'user' : 'assistant')).join('\n'))
    return runHook('frames-guard.mjs', { cwd: gRoot, agent_type: 'stage-pipeline:devtools-verify', agent_transcript_path: path })
  }
  const NAV = call('mcp__plugin_stage-pipeline_chrome-devtools__new_page', { url: 'http://localhost:3000/' }, 'n1')
  const DOC = call('Bash', { command: 'node /p/scripts/verify-doctor.mjs' }, 'd1')
  const blind = guard([[NAV]], 'blind')
  check('frames-guard: a navigation with no verify-doctor call before it — blocked, the message names verify-doctor', blind.decision === 'block' && /verify-doctor/.test(blind.text), blind.text)
  check('frames-guard: verify-doctor first, then the navigation — passes', guard([[DOC], [answer('d1', 'doctor: ok — http://localhost:3000 answers on / 200')], [NAV]], 'ok').decision === 'allow')
  check('frames-guard: navigation, then verify-doctor, no second navigation — still blocked', guard([[NAV], [DOC]], 'late').decision === 'block')
  check('frames-guard: navigation, verify-doctor, navigation again (the redo) — passes', guard([[NAV], [DOC], [answer('d1', 'doctor: ok — x')], [{ ...NAV, id: 'n2' }]], 'redo').decision === 'allow')
  const CAT = call('Bash', { command: 'cat /p/scripts/verify-doctor.mjs' }, 'c1')
  check('frames-guard: `cat verify-doctor.mjs` is not a doctor call — the navigation is still blind', guard([[CAT], [answer('c1', 'const x')], [NAV]], 'cat').decision === 'block')
  check('frames-guard: navigation (static file), then "doctor: no dev url" — passes', guard([[NAV], [DOC], [answer('d1', 'doctor: no dev url — static target')]], 'static-late').decision === 'allow')
  check('frames-guard: navigation, then "doctor: ok" with no second navigation — still blocked', guard([[NAV], [DOC], [answer('d1', 'doctor: ok — x')]], 'ok-late').decision === 'block')
  const refused = guard([[DOC], [answer('d1', 'doctor: wrong app — http://localhost:3000 is held by pid 1 with cwd /other')], [NAV]], 'refused')
  check('frames-guard: a navigation after "doctor: wrong app" — blocked', refused.decision === 'block' && /wrong app/.test(refused.text), refused.text)
  check('frames-guard: "doctor: no dev url" then a navigation to the static file — passes', guard([[DOC], [answer('d1', 'doctor: no dev url — static target')], [NAV]], 'static').decision === 'allow')
  // R10: the incident form after `down` (the code blocked it, no fixture held it).
  const afterDown = guard([[DOC], [answer('d1', 'doctor: down — http://localhost:3000/ did not answer: ECONNREFUSED')], [NAV]], 'down')
  check('frames-guard R10: a navigation after "doctor: down" — blocked', afterDown.decision === 'block' && /wrong app` \/ `down/.test(afterDown.text), afterDown.text)
  // M-2: "no config" is not a static target.
  const afterNoConfig = guard([[DOC], [answer('d1', 'doctor: no config — no .claude/pipeline.config.md in /w or in its main tree')], [NAV]], 'no-config')
  check('frames-guard M-2: a navigation after "doctor: no config" — blocked, the message asks for --url', afterNoConfig.decision === 'block' && /--url/.test(afterNoConfig.text), afterNoConfig.text)
  check('frames-guard M-2: a navigation before "doctor: no config" stays blind (not cleared as a static target)', guard([[NAV], [DOC], [answer('d1', 'doctor: no config — x')]], 'no-config-late').decision === 'block')
  // S-3: a doctor that gave no verdict (a crash with a stack, an `error` line) clears nothing; a record of an unexpected shape does not stop the checks.
  const afterCrash = guard([[DOC], [answer('d1', 'file:///p/scripts/verify-doctor.mjs:137\nTypeError: Invalid URL')], [NAV]], 'crash')
  check('frames-guard S-3: a navigation after a doctor run with no `doctor:` line (a crash) — blocked', afterCrash.decision === 'block' && /no verdict/.test(afterCrash.text), afterCrash.text)
  check('frames-guard S-3: a navigation after "doctor: error — …" — blocked', guard([[DOC], [answer('d1', 'doctor: error — Request path contains unescaped characters')], [NAV]], 'error').decision === 'block')
  const oddRecord = guard([[call('Read', { file_path: ['a.png'] }, 'r1')], [{ type: 'tool_use', id: 'r2', name: 'Read', input: { filePath: 12 } }], [NAV]], 'odd-record')
  check('frames-guard S-3: a Read with a non-string file_path does not stop the hook — the blind navigation is still blocked', oddRecord.decision === 'block' && /before running verify-doctor/.test(oddRecord.text), oddRecord.text)
  check('frames-guard: no navigation at all (a skip, the playwright fallback) is not judged', guard([[call('Bash', { command: 'ls' }, 'x1')]], 'none').decision === 'allow')
  rmSync(gRoot, { recursive: true, force: true })
}

// ── VT-1 stage 5: dismissal trail and evidence for decisions taken alone ──────
{
  const jcs = await import(join(PLUGIN, 'journal-check.mjs'))
  const { decisionViolations } = await import(join(PLUGIN, 'decisions.mjs'))
  const { weakForm, entrySeverity } = await import(join(PLUGIN, 'dismissals.mjs'))
  const { collectDigest, runDigest } = await import(join(PLUGIN, 'run-digest.mjs'))
  const weak = (line) => jcs.disposition(line, { strict: true }) === 'weak'
  const kept = (line) => jcs.disposition(line, { strict: true }) === 'false'
  // Live incident forms (analysis/dismissals.md, verbatim) and the live legitimate forms of the same forms.
  const FORMS = {
    'not-ours': {
      reject: '4, 5, 6 — ложная для ветки: в ките нет слота подписи у `UICheckbox`, действия у `UIInlineAlert` и адаптивной модалки — сборка из компонентов кита вынужденная; кандидаты K-1…K-3 — работа кита',
      pass: 'minor (`autocheckLead:consentLabel` повторяет видимую фразу) — ложная: предложенная альтернатива `aria-labelledby` не доходит до `<input>` в `UICheckbox` 0.0.184 — `node_modules/@mycar/ui-lib/dist/runtime/components/Checkbox.vue:9` (`:aria-label="ariaLabel ?? label ?? \'Checkbox\'"`, без `inheritAttrs: false`), подтверждено checks/ds-parity-branch.md M-2',
    },
    'data-seen': {
      reject: 'minor 2 — ложная для данных: на 60 публикациях dev-стенда `engine_power` только целые («80 л.с.», «600 л.с», «200 л.с.», «» — замер `scratchpad/live/det/*.json`), дробной и нулевой мощности нет; поведение `parseInt` совпадает с прежним отображением целого числа',
      pass: 'опасение из «Не удалось проверить» (протухший Bearer ломает анонимную заявку) — ложная: проверено оркестратором 2026-10-09: `POST /cars/api/credit/autocheck/leads/` с `Authorization: Bearer invalid.token.value` и пустым телом → 400 `{"code":"invalid_full_name",…}`, не 401 — ручка токен не проверяет',
    },
    untouched: {
      reject: 'K-1 — ложная: карточка повторяет образец — `page-components/marketplace/details/ConfigSummaryCard.vue:43` (`rounded-[20px] bg-neutral-base-container pb-2`), класс не менялся этим этапом',
      pass: 'F6 — ложная: воспроизводится 1:1 на базе origin/dev `bf3ac953` (worktree :3100, 2 из 2 прогонов, iPhone UA 390); строка `page-components/announcement/Price.vue:239` этапом не менялась',
    },
    deferred: {
      reject: '#3 (ключи автоотмен и `unknown` без потребителя) — ложная для этапа: потребитель — страница участника в этапе 13 (STAGES.md «Общие элементы»: справочник причин, владелец 12, потребитель 13; `specs/13.md`); финальный dead-code перепроверит',
      pass: 'minor AC-10.5 ветка «новый документ — blob» в новых спеках не проверяется — ложная: покрыта спеками скачивания этапа 3 — `tests/smoke/specs/admin.student-document-actions.spec.ts` (путь `…/file`, `suggestedFilename` = название + `.pdf`); полный прогон `student-document` 169 passed, красные только B2.',
    },
    'self-sourced': {
      reject: 'minor (общий `start_at` vs `first_start_date` у многослотовых очных) — ложная как дефект: сам отчёт — «сценарий слабый, поведение допустимо»; допущение записано в журнал этапа 20',
      pass: 'K-1 (тень поповера arbitrary value) — ложная: решение пользователя «вид как в прототипе» — запрос 05.10.2026 «здесь можешь посмотреть как выглядит CountrySelect»; значение снято с прототипа — `specs/stage-18-country-select-reference.md:31` (поповер: shadow `0 8px 24px rgba(3,7,18,.094)`)',
    },
    unrelated: {
      reject: '#6 — ложная для задачи: «Передний», «Автомат» — значения справочника dev-api на ru',
      pass: '2 — ложная: окружение — после повтора `curl https://dev-api.mycredit.kz/calculator/v1/configs/latest` → 200, SSR `/prime/26385` в 3 холодных загрузках отдаёт «579 000» и «112 599»; код прайма до/после ребейза идентичен (`git diff 902b60af 9ae24cbf -- store/prime page-components/prime pages/prime` пуст)',
    },
    'not-reproduced': {
      reject: '#2 — false: not reproduced',
      pass: '#2 — false: not reproduced (2 attempts, /root-cause): 2 cold loads on /orders and 2 on the base, no mismatch',
    },
    downgrade: {
      reject: '#3 — false: demoted to minor',
      pass: '#3 — false: demoted to minor at the re-check — the only caller passes a constant (`src/a.ts:12`), so the empty value never reaches it',
    },
  }
  for (const [form, { reject, pass }] of Object.entries(FORMS)) {
    check(`dismissal ${form}: the incident form is a weak dismissal under the new rule`, weak(reject) && weakForm(reject)?.form === form, JSON.stringify(weakForm(reject)))
    check(`dismissal ${form}: the legitimate form stays a dismissal`, kept(pass), JSON.stringify(weakForm(pass)))
    check(`dismissal ${form}: an old report (not strict) reads the incident form as before`, jcs.disposition(reject) === 'false')
  }
  const NOT_REPRO_RU = ['#2 — ложная: не воспроизвелось', '#2 — ложная: не воспроизвелось (2 попытки, /root-cause)']
  check('dismissal not-reproduced RU: no attempts is weak, two attempts and the route pass', weak(NOT_REPRO_RU[0]) && kept(NOT_REPRO_RU[1]))
  check('dismissal not-reproduced: one attempt is not two', weak('#2 — false: not reproduced (1 attempt, /root-cause)') && weak('#2 — false: not reproduced (2 attempts)'))
  check('dismissal not-ours: "the fix is impossible" alone is weak, in both languages', weak('#4 — false: the fix is impossible') && weak('#4 — ложная: исправить невозможно'))
  check('dismissal: the 17 live weak lines of the machine stay weak, the proof lines of the ledger scan are not touched (see the AC-5.5 scan)', Object.values(FORMS).every(({ reject }) => weak(reject)))

  // The ledger of a report: the hook rule (strict) and the old report (not strict).
  const critReportOf = (line) => `# pro-review\nFindings: critical 1 · major 0 · minor 0\n\n- C-1 critical: the token leaks\n\n## Findings outcome\n- ${line}\n`
  const ledgerOf = (lines) => `# devtools-verify\nFindings: critical 0 · major 2 · minor 0\n\n## Findings outcome\n${lines.join('\n')}\n`
  const weakLedger = ledgerOf([`- ${FORMS['not-ours'].reject}`, '- M-2 — fixed: a.ts:1'])
  check('AC-5.2: a new report with "the fix is impossible" / a weak dismissal is rejected, rule ledger-weak', jcs.ledgerViolations(weakLedger, 'pro-review-2.md', { strict: true }).some(({ rule }) => rule === 'ledger-weak'))
  check('AC-5.2: the same report as an old one (not strict) raises no weak rule', !jcs.ledgerViolations(weakLedger, 'pro-review-2.md').some(({ rule }) => rule === 'ledger-weak'))
  check('AC-5.2: "not reproduced (2 attempts, /route)" passes in a new report', jcs.ledgerViolations(ledgerOf(['- #1 — false: not reproduced (2 attempts, /route)', '- #2 — fixed: a.ts:1']), 'pro-review-2.md', { strict: true }).length === 0)
  check('AC-5.2: bare "not reproduced" in a new report is rejected', jcs.ledgerViolations(ledgerOf(['- #1 — false: not reproduced', '- #2 — fixed: a.ts:1']), 'pro-review-2.md', { strict: true }).some(({ rule }) => rule === 'ledger-weak'))
  check('AC-5.2: a weak dismissal does not count toward the outcome total (ledger-missing with complete)', jcs.ledgerViolations(weakLedger, 'pro-review-2.md', { strict: true, complete: true }).some(({ rule }) => rule === 'ledger-missing'))

  // AC-5.3: a dismissed critical needs the fresh report on disk.
  const critTask = mkdtempSync(join(tmpdir(), 'crit-task-'))
  mkdirSync(join(critTask, 'checks'), { recursive: true })
  const critReport = (line) => `# pro-review\nFindings: critical 1 · major 0 · minor 0\n\n- C-1 critical: the token leaks\n\n## Findings outcome\n- ${line}\n`
  const CRIT = 'C-1 — false: the token is hashed before the log call, `src/log.ts:14`'
  const rules = (line) => jcs.ledgerViolations(critReport(line), 'pro-review-3.md', { strict: true, taskDir: critTask }).map(({ rule }) => rule)
  check('AC-5.3: a critical dismissed with no fresh report is rejected', rules(CRIT).includes('ledger-critical-fresh'))
  check('AC-5.3: a cited fresh report that is not in checks/ is rejected, and the message names it', jcs.ledgerViolations(critReport(`${CRIT} — fresh report checks/pro-review-3-fresh.md`), 'pro-review-3.md', { strict: true, taskDir: critTask }).some(({ message }) => /pro-review-3-fresh\.md does not exist/.test(message)))
  writeFileSync(join(critTask, 'checks', 'pro-review-3-fresh.md'), '# pro-review\nFindings: critical 0 · major 0 · minor 0\n')
  check('AC-5.3: with the fresh report on disk and cited, the line passes', rules(`${CRIT} — fresh report checks/pro-review-3-fresh.md`).length === 0, JSON.stringify(rules(`${CRIT} — fresh report checks/pro-review-3-fresh.md`)))
  check('AC-5.3: a "fixed" critical needs no fresh report; an old report (not strict) is not asked', rules('C-1 — fixed: src/log.ts:14').length === 0 && jcs.ledgerViolations(critReport(CRIT), 'pro-review-3.md').length === 0)
  rmSync(critTask, { recursive: true, force: true })

  // Review round 1 of stage 5: paraphrases of the same forms, task-code proofs, negated "fixed", anchored ids, inline assumptions, rollback ranking.
  check('dismissal #1: "false: can\'t be fixed" / "cannot be fixed here" is weak, not fixed', ['M-1 — false: can\'t be fixed in this task', 'M-1 — false: cannot be fixed here', 'M-1 — ложная: не может быть исправлен в этой задаче'].every((line) => jcs.disposition(line, { strict: true }) === 'weak') && jcs.disposition('M-1 — false: can\'t be fixed in this task') === 'false')
  check('dismissal #1: a true "fixed: path:line" is still fixed; "fixed" before a later "false positive" stays fixed', jcs.disposition('M-1 — fixed: a.ts:3', { strict: true }) === 'fixed' && jcs.disposition('M-1 — fixed: a.ts:3 — not a false alarm', { strict: true }) === 'fixed')
  check('dismissal #1: the ledger of a new report with "false: can\'t be fixed" raises ledger-weak', jcs.ledgerViolations(ledgerOf(['- M-1 — false: cannot be fixed here', '- M-2 — fixed: a.ts:1']), 'pro-review-2.md', { strict: true }).some(({ rule }) => rule === 'ledger-weak'))
  for (const line of ['#4 — false: the backend owns this', '#4 — false: this is the backend\'s job', '#4 — false: the kit has no such slot', '#4 — false: can\'t fix', '#4 — false: not possible to fix', '#4 — false: infeasible', '#4 — false: unfixable', '#4 — false: by design', '#4 — false: not introduced by this change']) {
    check(`dismissal #3: English twin is weak — ${line.slice(12)}`, weak(line), JSON.stringify(weakForm(line)))
  }
  check('dismissal #3: the same wordings pass with their proof', kept('#4 — false: the backend owns this — `node_modules/@x/ui-lib/dist/a.vue:9`') && kept('#4 — false: by design — `src/a.ts:12` and the spec «the dialog stays open»') && kept('#4 — false: not introduced by this change — `git diff 902b60a -- src/a.ts` is empty'))
  check('dismissal #4: a task-code `path:line` settles impossible / forced / unavoidable', ['#4 — false: impossible state — the reducer at store.ts:40 never emits it', '#4 — false: forced-colors media query is handled at theme.css:44', '#4 — false: the tab is unavoidable only in Safari; Tab.vue:9 renders it'].every(kept))
  check('dismissal #4: "impossible" about the kit with a task-code line only is still weak', weak('#4 — false: impossible, the kit has no slot (see Card.vue:12)'))
  check('dismissal #4: a spec file path is the route of "not reproduced"', kept('#2 — false: not reproduced after 2 runs of the spec e2e/orders.spec.ts') && weak('#2 — false: not reproduced after 2 runs'))
  // Round 2, m-1: a task-code `path:line` settles "no such prop" and "can't be done / avoided" about the task's own code; the kit or the backend still needs its own proof.
  check('dismissal m-1: "no such prop" / "cannot be avoided" with a task-code `path:line` is a dismissal', ['#4 — false: there is no such prop on the component — packages/ui/Button.vue:12 declares only `size`', '#4 — false: this cannot be avoided — Tab.vue:9 renders it unconditionally', '#4 — false: can\'t be done twice, store.ts:40 returns early'].every(kept))
  check('dismissal m-1: the same wording without a line, or about the kit / backend, stays weak', ['#4 — false: there is no such prop on the component', '#4 — false: cannot be avoided', '#4 — false: there is no such prop in the kit — Button.vue:12', '#4 — false: the backend cannot be changed — api.ts:3'].every(weak))
  // Round 2, m-2: paraphrases of the same forms, each with the same proof escape.
  for (const line of ['#4 — false: the code was not touched by this change', '#4 — false: this stage did not change it', '#4 — ложная: этап этого не трогал', '#4 — false: we cannot do anything about it', '#4 — false: kit limitation', '#4 — false: backend returns it that way', '#4 — false: not our code, kit issue']) {
    check(`dismissal m-2: paraphrase is weak — ${line.slice(12)}`, weak(line), JSON.stringify(weakForm(line)))
  }
  check('dismissal m-2: the paraphrases pass with their proof', kept('#4 — false: this stage did not change it — `git diff 902b60a -- src/a.ts` is empty') && kept('#4 — ложная: этап этого не трогал — `git diff 902b60a -- src/a.ts` пуст') && kept('#4 — false: kit limitation — `node_modules/@x/ui-lib/dist/a.vue:9`') && kept('#4 — false: we cannot do anything about it — the reducer at store.ts:40 never emits it'))
  // Round 2, m-3: the manual CLI applies the stage 5 rules like the hook (a report outside `ledgerOld` is strict).
  {
    const cData = mkdtempSync(join(tmpdir(), 'cli-data-'))
    const cTask = mkdtempSync(join(tmpdir(), 'cli-task-'))
    mkdirSync(join(cTask, 'checks'), { recursive: true })
    writeFileSync(join(cTask, 'STAGES.md'), '# T-65\nLanguage: en\n\n## Journal\n- 2026-10-01 start\n')
    writeFileSync(join(cTask, 'checks', 'pro-review-2.md'), ledgerOf(['- M-1 — false: the fix is impossible', '- M-2 — fixed: a.ts:1']))
    const cli = () => spawnSync('node', [join(PLUGIN, 'journal-check.mjs'), cTask, '--ledger'], { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: cData } })
    const fresh = cli()
    check('m-3: the CLI rejects a weak dismissal in a report the snapshot has not seen', fresh.status === 1 && /impossible|proof|dismiss/i.test(fresh.stdout), fresh.stdout)
    jcs.baselineInfo(cData, cTask)
    const old = cli()
    check('m-3: the same report listed in `ledgerOld` is not judged strictly by the CLI', old.stdout !== fresh.stdout && !/impossible/i.test(old.stdout), old.stdout)
    rmSync(cData, { recursive: true, force: true })
    rmSync(cTask, { recursive: true, force: true })
  }
  // #6: bare numeric ids resolve severity only on an anchored row; the fresh report belongs to the same checker and stage.
  const NUM_REPORT = '# pro-review\nFindings: critical 1 · major 0 · minor 0\n\n### 🔴 Critical\n1. Race\n\n## Findings outcome\n- 1 — false: `Save.vue:12`\n'
  check('dismissal #6: a bare numeric id on an anchored row (`1.`, `| 1 |`, `#1`) gives the severity', entrySeverity('1 — false: `Save.vue:12`', NUM_REPORT) === 'critical' && entrySeverity('2 — false: x.ts:1', '### Major\n| 2 | a |\n\n## Findings outcome\n') === 'major' && entrySeverity('3 — false: x.ts:1', '### Minor\n#3 text\n\n## Findings outcome\n') === 'minor')
  check('dismissal #6: a stray line starting with the digit is not the row', entrySeverity('1 — false: x.ts:1', '### 🔴 Critical\n10 files changed\n\n## Findings outcome\n') === null)
  check('dismissal #6: a critical dismissed as "1 — false: …" needs the fresh report', jcs.ledgerViolations(NUM_REPORT, 'pro-review-3.md', { strict: true }).some(({ rule }) => rule === 'ledger-critical-fresh'))
  const freshTask = mkdtempSync(join(tmpdir(), 'fresh-task-'))
  mkdirSync(join(freshTask, 'checks'), { recursive: true })
  writeFileSync(join(freshTask, 'checks', 'ds-parity-1-fresh.md'), '# ds-parity\n')
  writeFileSync(join(freshTask, 'checks', 'pro-review-4-fresh.md'), '# pro-review\n')
  writeFileSync(join(freshTask, 'checks', 'pro-review-3-fresh-r2.md'), '# pro-review\n')
  const freshRules = (cite) => jcs.ledgerViolations(critReportOf(`C-1 — false: \`src/log.ts:14\` — fresh report ${cite}`), 'pro-review-3.md', { strict: true, taskDir: freshTask }).map(({ rule }) => rule)
  check('dismissal #6: a fresh report of another checker or another stage does not count; the same checker and stage does', freshRules('checks/ds-parity-1-fresh.md').includes('ledger-critical-fresh') && freshRules('checks/pro-review-4-fresh.md').includes('ledger-critical-fresh') && freshRules('checks/pro-review-3-fresh-r2.md').length === 0)
  rmSync(freshTask, { recursive: true, force: true })

  // AC-5.4: decisions taken alone carry a rollback cost and a basis.
  const AW_BAD = '- Stage 4: verify-doctor keys are `verify_routes:`. Where: any repo that adds these keys.'
  const AW_NO_BASIS = '- Stage 4: verify-doctor keys are `verify_routes:`. Where: any repo that adds these keys. Rollback is cheap: two key names.'
  const AW_NO_COST = '- Stage 4: verify-doctor keys are `verify_routes:`. Where: any repo that adds these keys. Basis: checks/pro-review-4.md #1.'
  const AW_OK = '- Stage 4: verify-doctor keys are `verify_routes:`. Where: any repo that adds these keys. Rollback is cheap: two key names. Basis: checks/pro-review-4.md #1.'
  const AW_GUESS = '- Stage 4: a default of 3 retries. Where: the doctor. Rollback is cheap: one constant. Basis: guess.'
  const journalWith = (...rows) => `# T-60\nLanguage: en\n\n## Journal\n- 2026-10-01 old\n\n## ⚠ Awaiting user confirmation\n${rows.join('\n')}\n`
  check('AC-5.4: an Awaiting line with neither cost nor basis is rejected, naming both', decisionViolations(journalWith(AW_BAD)).some(({ message }) => /rollback cost and no basis/.test(message)))
  check('AC-5.4: no basis — rejected; no cost — rejected', decisionViolations(journalWith(AW_NO_BASIS)).some(({ message }) => /no basis/.test(message)) && decisionViolations(journalWith(AW_NO_COST)).some(({ message }) => /no rollback cost/.test(message)))
  check('AC-5.4: cost and basis — passes; an explicit "Basis: guess" passes', decisionViolations(journalWith(AW_OK, AW_GUESS)).length === 0, JSON.stringify(decisionViolations(journalWith(AW_OK, AW_GUESS))))
  check('AC-5.4: a continuation line of the item carries the evidence', decisionViolations(journalWith('- Stage 4: a default of 3 retries. Where: the doctor.', '  Rollback is moderate: three texts. Basis: `a.ts:9`.')).length === 0)
  const forceBlock = (assumption) => `# T-61\nLanguage: en\n\n## Force run 2026-10-19\nMode: auto\nAssumptions:\n${assumption}\nBoundaries:\n- no push\nConfirmed: 2026-10-19 — interview\n`
  check('AC-5.4: a Force assumption without cost and basis is rejected; with both it passes', decisionViolations(forceBlock('- A1 This run covers stages 1-5 only.')).length === 1 && decisionViolations(forceBlock('- A1 This run covers stages 1-5 only. Rollback: none needed. Basis: interview answer 2.')).length === 0)
  check('AC-5.4: the Russian basis and rollback words count', decisionViolations(journalWith('- Этап 4: ключи doctor. Где: любой репо. Откат дешёвый: два имени ключей. Основание: checks/pro-review-4.md #1.')).length === 0)
  check('AC-5.4: the journal chain returns it for a new line, rule decision-evidence', jcs.journalViolations(journalWith(AW_BAD)).some(({ rule }) => rule === 'decision-evidence'))

  // Review round 1: the inline `Assumptions:` template form, and the rollback ranking.
  const inlineForce = (text) => `# T-63\nLanguage: en\n\n## Force run 2026-10-19\nMode: auto\nAssumptions: ${text}\nUnresolved: none\nBoundaries:\n- no push\nConfirmed: 2026-10-19 — interview\n`
  check('AC-5.4 #2: an inline `Assumptions:` line without rollback and basis is rejected, with both it passes', decisionViolations(inlineForce('use X as default — because the plan says so')).length === 1 && decisionViolations(inlineForce('use X as default — because Rollback: cheap, one constant — Basis: `a.ts:9`')).length === 0)
  check('AC-5.4 #2: an inline assumption with a rollback and no basis is rejected naming the basis; "none" is empty', /no basis/.test(decisionViolations(inlineForce('use X — Rollback: cheap'))[0]?.message ?? '') && decisionViolations(inlineForce('none')).length === 0)
  check('AC-5.4 #2: the bullet form under `Assumptions:` still works next to an inline first line', decisionViolations(forceBlock('- A1 This run covers stages 1-5 only.')).length === 1)
  // Round 2, M-1: the inline form keys on the journal line; a bold header is not an item.
  const boldHeader = (head, rest = '') => `# T-64\nLanguage: ru\n\n## Force-прогон 2026-10-19\nMode: auto\n${head}${rest}\nUnresolved: none\nBoundaries:\n- no push\nConfirmed: 2026-10-19 — interview\n`
  check('AC-5.5 M-1: a bold-colon header (RU or EN) is not an item', decisionViolations(boldHeader('**Допущения:**')).length === 0 && decisionViolations(boldHeader('**Assumptions:**')).length === 0 && decisionViolations(boldHeader('- **Assumptions**:')).length === 0)
  check('AC-5.5 M-1: a bold header with an inline remainder reads the remainder without the marks, `**none**` is empty', decisionViolations(boldHeader('**Допущения:** none')).length === 0 && decisionViolations(boldHeader('**Assumptions:** **none**')).length === 0 && decisionViolations(boldHeader('**Assumptions:** use X — Rollback: cheap — Basis: guess')).length === 0 && decisionViolations(boldHeader('**Assumptions:** use X'))[0]?.line === '**Assumptions:** use X')
  const oData = mkdtempSync(join(tmpdir(), 'inl-data-'))
  const oTask = mkdtempSync(join(tmpdir(), 'inl-task-'))
  writeFileSync(join(oTask, 'STAGES.md'), inlineForce('use 7 days — nothing else — visible at /settings'))
  jcs.baselineInfo(oData, oTask)
  check('AC-5.5 M-1: an old inline assumption is silent after the first snapshot', jcs.newJournalViolations(oData, oTask).length === 0, JSON.stringify(jcs.newJournalViolations(oData, oTask)))
  appendFileSync(join(oTask, 'STAGES.md'), '\n## Force run 2026-10-20\nMode: auto\nAssumptions: use 3 days — nothing else\nUnresolved: none\n')
  check('AC-5.5 M-1: a NEW inline assumption without a basis is rejected', jcs.newJournalViolations(oData, oTask).some(({ rule }) => rule === 'decision-evidence'))
  const oSnap = join(oData, 'journal-baseline', readdirSync(join(oData, 'journal-baseline'))[0])
  const oOld = JSON.parse(readFileSync(oSnap, 'utf8'))
  delete oOld.dismissSeen
  delete oOld.ledgerOld
  oOld.lines = oOld.lines.filter((fp) => fp !== jcs.fingerprint('Assumptions: use 7 days — nothing else — visible at /settings'))
  writeFileSync(oSnap, JSON.stringify(oOld))
  check('AC-5.5 M-1: the migration baselines the old inline assumptions by their journal lines', jcs.newJournalViolations(oData, oTask).length === 0, JSON.stringify(jcs.newJournalViolations(oData, oTask)))
  appendFileSync(join(oTask, 'STAGES.md'), '\n## Force run 2026-10-21\nMode: auto\nAssumptions: use 1 day — nothing else\nUnresolved: none\n')
  check('AC-5.5 M-1: after the migration a new inline assumption without a basis is rejected', jcs.newJournalViolations(oData, oTask).some(({ message }) => /1 day/.test(message)))
  rmSync(oData, { recursive: true, force: true })
  rmSync(oTask, { recursive: true, force: true })
  const { rollbackRank } = await import(join(PLUGIN, 'decisions.mjs'))
  check('AC-5.4 #5: the first non-negated cost word after "rollback" ranks, the Basis clause is cut', [
    ['Rollback: cheap — not expensive', 3],
    ['Rollback: cheap, no data migration needed', 3],
    ['Rollback is cheap. Basis: «costly to undo» checks/a.md', 3],
    ['Откат: дёшево, без миграции', 3],
    ['Rollback: expensive, a data migration', 0],
    ['Rollback: not cheap, a data migration', 0],
    ['Rollback: moderate, three skill texts', 2],
    ['Rollback: no data migration', 1],
  ].every(([text, rank]) => rollbackRank(text) === rank), JSON.stringify([['Rollback: cheap — not expensive'], ['Rollback: cheap, no data migration needed'], ['Откат: дёшево, без миграции'], ['Rollback: not cheap, a data migration'], ['Rollback: no data migration']].map(([t]) => rollbackRank(t))))

  // D7: the one-shot migration. A v2 snapshot from 0.18 before this release has no dismissSeen / ledgerOld.
  const mData = mkdtempSync(join(tmpdir(), 'dis-mig-data-'))
  const mTask = mkdtempSync(join(tmpdir(), 'dis-mig-task-'))
  mkdirSync(join(mTask, 'checks'), { recursive: true })
  writeFileSync(join(mTask, 'STAGES.md'), journalWith('- old row without evidence'))
  jcs.baselineInfo(mData, mTask)
  const mDir = join(mData, 'journal-baseline')
  const mFile = join(mDir, readdirSync(mDir)[0])
  const snap = JSON.parse(readFileSync(mFile, 'utf8'))
  check('D7: a fresh snapshot carries dismissSeen and ledgerOld', snap.dismissSeen === true && Array.isArray(snap.ledgerOld))
  delete snap.dismissSeen
  delete snap.ledgerOld
  snap.lines = snap.lines.filter((fp) => fp !== jcs.fingerprint('- old row without evidence'))
  writeFileSync(mFile, JSON.stringify(snap))
  writeFileSync(join(mTask, 'checks', 'pro-review-1.md'), weakLedger)
  writeFileSync(join(mTask, 'STAGES.md'), journalWith('- old row without evidence', AW_OK))
  check('D7: after the migration the old evidence-less row is not new', jcs.newJournalViolations(mData, mTask).length === 0, JSON.stringify(jcs.newJournalViolations(mData, mTask)))
  check('D7: the migration marks the snapshot and lists the existing reports as old', (() => { const now = JSON.parse(readFileSync(mFile, 'utf8')); return now.dismissSeen === true && now.ledgerOld.includes('pro-review-1.md') })())
  check('D7: the report that was there is old (not strict), a report written later is strict', jcs.baselineInfo(mData, mTask).ledgerOld.has('pro-review-1.md') && !jcs.baselineInfo(mData, mTask).ledgerOld.has('pro-review-9.md'))
  appendFileSync(join(mTask, 'STAGES.md'), `${AW_BAD}\n`)
  check('D7: after the migration a NEW evidence-less row is rejected', jcs.newJournalViolations(mData, mTask).some(({ rule }) => rule === 'decision-evidence'))
  rmSync(mData, { recursive: true, force: true })
  rmSync(mTask, { recursive: true, force: true })

  // AC-5.1 and the digest: dismissed as false in the full view, the count in the short one; Awaiting sorted by rollback cost.
  for (const language of ['en', 'ru']) {
    const dData = mkdtempSync(join(tmpdir(), 'dis-dig-data-'))
    const dTask = mkdtempSync(join(tmpdir(), 'dis-dig-task-'))
    mkdirSync(join(dTask, 'checks'), { recursive: true })
    const ru = language === 'ru'
    writeFileSync(join(dTask, 'STAGES.md'), `# T-62\n${ru ? 'Язык: ru' : 'Language: en'}\n`)
    jcs.baselineInfo(dData, dTask)
    const awaiting = ['- Cheap thing. Where: a. Rollback is cheap: one constant. Basis: guess.', '- Expensive thing. Where: b. Rollback is expensive: a data migration. Basis: guess.', '- Middle thing. Where: c. Rollback is moderate: three texts. Basis: guess.']
    writeFileSync(join(dTask, 'STAGES.md'), `# T-62\n${ru ? 'Язык: ru' : 'Language: en'}\n\n## Force run 2026-10-19\nMode: auto\nConfirmed: 2026-10-19 — x\n\n## ⚠ ${ru ? 'Ожидают подтверждения пользователя' : 'Awaiting user confirmation'}\n${awaiting.join('\n')}\n`)
    const head = ru ? '## Итог находок' : '## Findings outcome'
    const body = `# pro-review\nFindings: critical 0 · major 2 · minor 1\n\n| # | severity |\n|---|---|\n| M-1 | major |\n| M-2 | major |\n| m-1 | minor |\n\n${head}\n- M-1 — false: \`src/a.ts:12\` — the only caller passes a constant\n- M-2 — fixed: b.ts:3\n- m-1 — false: \`c.ts:4\` is dead\n`
    writeFileSync(join(dTask, 'checks', 'pro-review-1.md'), body)
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(dTask, 'checks', 'pro-review-1.md'), later, later)
    const d = collectDigest(dTask, dData, null)
    const full = runDigest(dTask, dData, null)
    const short = runDigest(dTask, dData, null, 'short', '/x/RUN-DIGEST.md')
    check(`AC-5.1 digest ${language}: the full view lists the major dismissal verbatim with its checker, not the minor one`, full.includes(d.text.dismissed(1)) && full.includes('[pro-review] pro-review-1.md (major): M-1 — false:') && !full.includes('m-1 — false'), full)
    check(`AC-5.1 digest ${language}: the short view gives the count and not the line`, short.includes(d.text.dismissedShort(1, 0)) && !short.includes('only caller passes'), short)
    const order = (view) => ['Expensive', 'Middle', 'Cheap'].map((word) => view.indexOf(`${word} thing`))
    check(`AC-5.4 digest ${language}: Awaiting rows come sorted by rollback cost, expensive first`, order(full).every((at, i, all) => at !== -1 && (i === 0 || at > all[i - 1])), order(full).join(','))
    rmSync(dData, { recursive: true, force: true })
    rmSync(dTask, { recursive: true, force: true })
  }
}

// ── VT-1 stage 5c: the digest's "Not ready for PR" reads a ledger the way journal-gate does ──
{
  const jcs = await import(join(PLUGIN, 'journal-check.mjs'))
  const { collectDigest } = await import(join(PLUGIN, 'run-digest.mjs'))
  const body = '# pro-review\nFindings: critical 1 · major 0 · minor 0\n\n- C-1 critical: the token leaks\n\n## Findings outcome\n- C-1 — false: impossible, the fix is impossible\n'
  for (const old of [false, true]) {
    const dData = mkdtempSync(join(tmpdir(), 'nr-data-'))
    const dTask = mkdtempSync(join(tmpdir(), 'nr-task-'))
    mkdirSync(join(dTask, 'checks'), { recursive: true })
    writeFileSync(join(dTask, 'STAGES.md'), '# T-63\nLanguage: en\n')
    jcs.baselineInfo(dData, dTask)
    const dir = join(dData, 'journal-baseline')
    const file = join(dir, readdirSync(dir)[0])
    writeFileSync(join(dTask, 'checks', 'pro-review-1.md'), body)
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(dTask, 'checks', 'pro-review-1.md'), later, later)
    if (old) {
      const snap = JSON.parse(readFileSync(file, 'utf8'))
      writeFileSync(file, JSON.stringify({ ...snap, ledgerOld: [...(snap.ledgerOld ?? []), 'pro-review-1.md'] }))
    }
    const d = collectDigest(dTask, dData, null)
    check(
      old
        ? '5c digest: an old report (in ledgerOld) whose only outcome is a weak false on its critical reads it as accepted — not "Not ready", as before'
        : '5c digest: a fresh report whose only outcome is a weak false on its critical has no accepted outcome (ledger-missing) — "Not ready for PR"',
      old ? !d.notReady.includes('pro-review-1.md') : d.notReady.includes('pro-review-1.md'),
      JSON.stringify(d.notReady),
    )
    rmSync(dData, { recursive: true, force: true })
    rmSync(dTask, { recursive: true, force: true })
  }

  // m-1 / m-2 (5c review): each outcome line is judged by the severity of its own finding, not by the number of outcome lines.
  const notReadyOf = (report, extra = {}) => {
    const dData = mkdtempSync(join(tmpdir(), 'nr-data-'))
    const dTask = mkdtempSync(join(tmpdir(), 'nr-task-'))
    mkdirSync(join(dTask, 'checks'), { recursive: true })
    writeFileSync(join(dTask, 'STAGES.md'), '# T-63\nLanguage: en\n')
    jcs.baselineInfo(dData, dTask)
    const later = new Date(Date.now() + 60_000)
    for (const [name, text] of Object.entries({ 'pro-review-1.md': report, ...extra })) {
      writeFileSync(join(dTask, 'checks', name), text)
      utimesSync(join(dTask, 'checks', name), later, later)
    }
    const { notReady } = collectDigest(dTask, dData, null)
    rmSync(dData, { recursive: true, force: true })
    rmSync(dTask, { recursive: true, force: true })
    return notReady
  }
  const TWO = (head, critical, minor) => `# pro-review\nFindings: ${head}\n\n- C-1 critical: the token leaks into the URL\n- M-1 major: the token leaks into the URL\n- m-1 minor: a stray log\n\n## Findings outcome\n${critical}\n${minor}\n`
  const weakCritical = notReadyOf(TWO('critical 1 · major 0 · minor 1', '- C-1 — false: the fix is impossible', '- m-1 — fixed: src/log.ts:3'))
  check('m-1: a weak false on a critical next to a fixed minor is "Not ready for PR" (2 outcome lines no longer stand for 1 critical + 1 minor)', weakCritical.includes('pro-review-1.md'), JSON.stringify(weakCritical))
  const weakMinor = notReadyOf(TWO('critical 1 · major 0 · minor 1', '- C-1 — fixed: src/log.ts:3', '- m-1 — false: the fix is impossible'))
  check('m-1: a weak false on a minor next to a fixed critical is ready (a minor without an outcome is counted under "Minor", not here)', weakMinor.length === 0, JSON.stringify(weakMinor))
  const parkedMajor = notReadyOf(TWO('critical 0 · major 1 · minor 1', '- m-1 — fixed: src/log.ts:3', '- M-1 — leaving it, accepted as a compromise'))
  check('m-1: a parked major next to a fixed minor (the 0.17.0 masking) is "Not ready for PR"', parkedMajor.includes('pro-review-1.md'), JSON.stringify(parkedMajor))
  const PROVEN = (cite = '') => `# pro-review\nFindings: critical 1 · major 0 · minor 0\n\n- C-1 critical: the token leaks\n\n## Findings outcome\n- C-1 — false: the token is never logged, src/log.ts:12 masks it${cite}\n`
  const FRESH = '# pro-review fresh pass on opus\nFindings: critical 0 · major 0 · minor 0\n\nC-1 re-checked: src/log.ts:12 masks the token.\n'
  const unconfirmed = notReadyOf(PROVEN())
  check('m-2: a proof-backed false on a critical with no fresh report (ledger-critical-fresh) is "Not ready for PR"', unconfirmed.includes('pro-review-1.md'), JSON.stringify(unconfirmed))
  const confirmed = notReadyOf(PROVEN(' — fresh report checks/pro-review-1-fresh.md'), { 'pro-review-1-fresh.md': FRESH })
  check('m-2: the same false citing an existing checks/pro-review-1-fresh.md is ready', confirmed.length === 0, JSON.stringify(confirmed))
  // m-4 (5c re-review): a `#N` id resolves to the row `| N |` of its own finding, so a parked major `#1` is not hidden by a fixed minor `#2`.
  const HASH = (outcome1, outcome2) => `# pro-review\nFindings: critical 0 · major 1 · minor 1\n\n| # | file | problem | severity |\n|---|---|---|---|\n| 1 | src/a.vue:3 | the button overlaps | ${outcome1[0]} |\n| 2 | src/b.vue:4 | a stray log | ${outcome2[0]} |\n\n## Findings outcome\n- #1 — ${outcome1[1]}\n- #2 — ${outcome2[1]}\n`
  const hashParked = notReadyOf(HASH(['major', 'leaving it, accepted as a compromise'], ['minor', 'fixed: src/b.vue:4']))
  check('m-4: a parked major `#1` next to a fixed minor `#2` is "Not ready for PR"', hashParked.includes('pro-review-1.md'), JSON.stringify(hashParked))
  const hashFalse = notReadyOf(HASH(['major', 'false: the fix is impossible'], ['minor', 'fixed: src/b.vue:4']))
  check('m-4: a weak false on a major `#1` next to a fixed minor `#2` is "Not ready for PR"', hashFalse.includes('pro-review-1.md'), JSON.stringify(hashFalse))
  const hashLegit = notReadyOf(HASH(['minor', 'leaving it, accepted as a compromise'], ['major', 'fixed: src/b.vue:4']))
  check('m-4 legit: a parked minor `#1` next to a fixed major `#2` is ready', hashLegit.length === 0, JSON.stringify(hashLegit))
}

// ── VT-1 stage 5a: final-check catch-up — old reports stay editable, one per-task date gate, linear time on long tokens, safe reads ──
{
  const { decisionViolations } = await import(join(PLUGIN, 'decisions.mjs'))
  const { weakForm } = await import(join(PLUGIN, 'dismissals.mjs'))
  const ps = await import(join(PLUGIN, 'hooks/pipeline-state.mjs'))

  // m-2: one helper decides whether a rule keyed on a Force block applies; it fails closed.
  const gate = { since: '2026-10-20', seen: new Set(['## Force run 2026-10-19']) }
  const applies = (heading, fallback = null, g = gate) => markers.ruleAppliesToBlock(g, heading, fallback)
  check('m-2 gate: a block opened before the recorded migration day — the rule does not apply', !applies('## Force run 2026-10-18'))
  check('m-2 gate: a block opened on or after that day — it applies', applies('## Force run 2026-10-20') && applies('## Force-прогон 21.10.2026'))
  check('m-2 gate: VT-1\'s own block, there at the migration, stays pre-release — also after its close', !applies('## Force run 2026-10-19') && !applies('## Force run 2026-10-19 — completed with blockers'))
  check('m-2 gate: an unreadable heading date ("Oct 21", "21.10.26") fails closed; a readable Confirmed date decides', applies('## Force run Oct 21') && applies('## Force run 21.10.26') && !applies('## Force run Oct 21', '2026-10-18'))
  check('m-2 gate: no gate at all, or an unreadable recorded day — the rule applies', applies('## Force run 2026-10-18', null, null) && applies('## Force run 2026-10-18', null, { since: 'garbage', seen: new Set() }))
  check('m-2 gate: the key of a heading drops its closing tail', markers.forceKey('## Force-прогон 2026-10-04 — завершён 2026-10-05') === '## Force-прогон 2026-10-04' && markers.forceKey('## Force run 2026-10-22: completed') === '## Force run 2026-10-22')

  // m-2 + D7: the migration records the day and the Force headings once; the earlier migrations are not run again (a new bare live line stays new).
  {
    const gData = mkdtempSync(join(tmpdir(), 'gate-mig-data-'))
    const gTask = mkdtempSync(join(tmpdir(), 'gate-mig-task-'))
    writeFileSync(join(gTask, 'STAGES.md'), '# T-71\nLanguage: en\n\n## Force run 2026-10-19\nConfirmed: 2026-10-19 — answers\n\n## Journal\n- 2026-10-19 start\n')
    jc.baselineInfo(gData, gTask)
    const file = snapshotFile(gData, gTask)
    const snap = JSON.parse(readFileSync(file, 'utf8'))
    delete snap.since018
    delete snap.forceSeen
    writeFileSync(file, JSON.stringify(snap))
    appendFileSync(join(gTask, 'STAGES.md'), '- `AC-1.1` ⏳ [live: user-side]\n')
    const migrated = jc.releaseGate(gData, gTask)
    check('m-2 migration: a snapshot of 0.18 before 5a gets the day and the Force headings there', /^\d{4}-\d{2}-\d{2}$/.test(migrated.since) && migrated.seen.has('## Force run 2026-10-19'), JSON.stringify({ since: migrated.since, seen: [...migrated.seen] }))
    check('m-2 migration: a bare live line written after the stage 4 migration stays new (that migration is not run again)', jc.newJournalViolations(gData, gTask).some(({ rule }) => rule === 'live-bare'))
    rmSync(gData, { recursive: true, force: true })
    rmSync(gTask, { recursive: true, force: true })
  }

  // M-1: the incident end to end through journal-gate.mjs — a v2 snapshot of 0.16 whose `reports` lacks a devtools-verify report written after the first look.
  {
    const mRoot = mkdtempSync(join(tmpdir(), 'm1-'))
    const mApp = join(mRoot, 'app')
    repoAt(mApp, 'main')
    const tdir = join(mApp, '.claude/tasks/T-70')
    write(mApp, {
      '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n',
      '.claude/tasks/T-70/STAGES.md': '# T-70: task\nLanguage: en\nBranch: `T-70/feat/a`\n\n## Status: stage 2\n\n## Stages\n\n### Stage 2: card  [status: in-progress]\n',
    })
    git(mApp, 'checkout', '-qb', 'T-70/feat/a')
    jc.baselineInfo(DATA, tdir)
    const file = snapshotFile(DATA, tdir)
    const old = JSON.parse(readFileSync(file, 'utf8'))
    for (const key of ['liveSeen', 'dismissSeen', 'ledgerOld', 'since018', 'forceSeen']) delete old[key]
    writeFileSync(file, JSON.stringify({ ...old, reports: [] })) // 0.16: the first look saw no report
    const REPORT_016 = '# devtools-verify, stage 2\nFindings: critical 0 · major 1 · minor 0\n\ngeometry 1440: overflow 0 · zero-gap 0 · clipped 0\n\n### 🟠 M-1 src/Card.vue:12 — the badge overlaps the title at 1280\n\n## Could not verify\n- /orders — [live: user-side]\n'
    write(mApp, { '.claude/tasks/T-70/checks/devtools-verify-2.md': REPORT_016 })
    const reportGate = (name) => runHook('journal-gate.mjs', { cwd: mApp, tool_name: 'Write', tool_input: { file_path: join(tdir, 'checks', name) } })
    // the mandated flow after the upgrade: the orchestrator appends the findings outcome to the old report
    appendFileSync(join(tdir, 'checks/devtools-verify-2.md'), '\n## Findings outcome\n- M-1 — fixed: src/Card.vue:12\n')
    const oldEdit = reportGate('devtools-verify-2.md')
    check('M-1: an old report (written under 0.16 after the first look) edited after the upgrade — no live-bare, no doctor:/auth: demand', oldEdit.decision !== 'block', oldEdit.text)
    check('M-1: the migration listed it in ledgerOld and recorded the day', (() => { const now = JSON.parse(readFileSync(file, 'utf8')); return now.ledgerOld.includes('devtools-verify-2.md') && /^\d{4}-\d{2}-\d{2}$/.test(now.since018) })())
    write(mApp, { '.claude/tasks/T-70/checks/devtools-verify-3.md': REPORT_016.replace('stage 2', 'stage 3') + '\n## Findings outcome\n- M-1 — fixed: src/Card.vue:12\n' })
    const newReport = reportGate('devtools-verify-3.md')
    check('M-1: a report written after the migration — the live-bare and both no-doctor rules fire (fresh/strict wiring of journal-gate)', newReport.decision === 'block' && /without a reason/.test(newReport.text) && /no `doctor:` line/.test(newReport.text) && /no `auth:` line/.test(newReport.text), newReport.text)
    // R8: the EN keys pass, end to end and on the report function.
    write(mApp, { '.claude/tasks/T-70/checks/devtools-verify-3.md': REPORT_016.replace('stage 2', 'stage 3').replace('\ngeometry', '\ndoctor: ok — http://localhost:3000 answers on / 200\nauth: not logged in — /orders → redirected to /login\n\ngeometry').replace('[live: user-side]', '[live: user-side — the profile is not logged in; /orders → redirected to /login]') + '\n## Findings outcome\n- M-1 — fixed: src/Card.vue:12 — re-run checks/devtools-verify-3-r1.md\n', '.claude/tasks/T-70/checks/devtools-verify-3-r1.md': '# devtools-verify, stage 3, recheck\n' })
    const enKeys = reportGate('devtools-verify-3.md')
    check('R8 EN: a fresh report with the English `doctor:` / `auth:` lines and the honest form passes journal-gate', enKeys.decision !== 'block', enKeys.text)
    check('R8 EN: reportViolations with fresh — no no-doctor for the English keys', !jc.reportViolations(join(tdir, 'checks/devtools-verify-3.md'), null, { fresh: true }).some(({ rule }) => rule === 'no-doctor'))
    rmSync(mRoot, { recursive: true, force: true })
  }

  // M-1 (5a fix round 1): the edit that writes `## Force run <today>` is the task's first look on 0.18 — a task planned under 0.16 (a v2 snapshot), the session on `main`,
  // so session-start does not take the snapshot (the task is not current), then `git checkout -b` and a UI force commit with no reports. The block is a run of this
  // version: the PreToolUse run of journal-gate takes the snapshot before the edit, and a heading dated the migration day is never recorded as seen (a write by Bash).
  {
    const now = new Date()
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    let looks = 0
    // The PreToolUse run happens only where hooks.json wires it: the fixture runs it as Claude Code would.
    const wiring = JSON.parse(readFileSync(join(PLUGIN, '../hooks/hooks.json'), 'utf8')).hooks
    const wired = (event, tool, script) => (wiring[event] ?? []).some((entry) => new RegExp(`^(?:${entry.matcher})$`).test(tool) && entry.hooks.some(({ command }) => command.includes(script)))
    check('M-1 first look: hooks.json runs journal-gate before an Edit, a Write and a MultiEdit', ['Edit', 'Write', 'MultiEdit'].every((tool) => wired('PreToolUse', tool, 'journal-gate.mjs')))
    const preRuns = []
    const firstLook = ({ snapshot = 'v2', pre = true, heading = `## Force run ${todayIso}`, confirmed = todayIso, extra = '' } = {}) => {
      const fRoot = mkdtempSync(join(tmpdir(), 'firstlook-'))
      const fApp = join(fRoot, 'app')
      const ticket = `T-9${looks++}`
      const tdir = join(fApp, '.claude/tasks', ticket)
      const plan = `# ${ticket}: task\nLanguage: en\nBranch: \`${ticket}/feat/a\`\n\n## Status: stage 1\n\n## Stages\n\n### Stage 1: card  [status: todo]\n`
      repoAt(fApp, 'main')
      write(fApp, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n', [`.claude/tasks/${ticket}/STAGES.md`]: plan })
      if (snapshot === 'v2') {
        jc.baselineInfo(DATA, tdir)
        const file = snapshotFile(DATA, tdir)
        const old = JSON.parse(readFileSync(file, 'utf8'))
        for (const key of ['liveSeen', 'dismissSeen', 'ledgerOld', 'since018', 'forceSeen']) delete old[key]
        writeFileSync(file, JSON.stringify(old))
      }
      runHook('session-start.mjs', { cwd: fApp })
      // /stage-force Step 0: the Force block is written by Edit, journal-gate runs around it
      const edit = { cwd: fApp, tool_name: 'Edit', tool_input: { file_path: join(tdir, 'STAGES.md') } }
      if (pre && wired('PreToolUse', 'Edit', 'journal-gate.mjs')) preRuns.push(runHook('journal-gate.mjs', { ...edit, hook_event_name: 'PreToolUse' }))
      write(fApp, { [`.claude/tasks/${ticket}/STAGES.md`]: plan.replace('## Stages', `${heading}\nMode: autonomous\nConfirmed: ${confirmed} — interview answers\n\n## Stages`).replace('[status: todo]', '[status: in-progress]') + extra })
      const post = runHook('journal-gate.mjs', { ...edit, hook_event_name: 'PostToolUse' })
      git(fApp, 'checkout', '-qb', `${ticket}/feat/a`)
      const gate = jc.releaseGate(DATA, tdir)
      write(fApp, { 'src/Card.vue': '<template>c</template>\n' })
      const verdict = runHook('git-guard.mjs', { cwd: fApp, tool_name: 'Bash', hook_event_name: 'PreToolUse', tool_use_id: `toolu_firstlook_${looks}`, tool_input: { command: 'git add -A && git commit -m stage1' } })
      rmSync(fRoot, { recursive: true, force: true })
      return { gate, verdict, post, shown: JSON.stringify({ since: gate.since, seen: [...gate.seen], verdict: verdict.decision, post: post.decision }) }
    }
    const viaEdit = firstLook()
    check('M-1 first look: the Edit that opens the Force run migrates a 0.16 snapshot before the edit — the block is not seen, the UI force commit with no reports is denied', viaEdit.gate.since === todayIso && viaEdit.gate.seen.size === 0 && viaEdit.verdict.decision === 'deny' && /pro-review/.test(viaEdit.verdict.text), viaEdit.shown)
    const noPre = firstLook({ pre: false })
    check('M-1 first look: the same write with no PreToolUse run (a write by Bash) — a heading dated the migration day is not seen, denied', noPre.gate.seen.size === 0 && noPre.verdict.decision === 'deny', noPre.shown)
    const fresh = firstLook({ snapshot: 'none', pre: false })
    check('M-1 first look: a task with no snapshot at all — the same, denied', fresh.gate.seen.size === 0 && fresh.verdict.decision === 'deny', fresh.shown)
    const undated = firstLook({ pre: false, heading: '## Force run (catch-up)' })
    check('M-1 first look: an undated heading is never seen — the Confirmed date decides, denied', undated.gate.seen.size === 0 && undated.verdict.decision === 'deny', undated.shown)
    // The PreToolUse run on its own: what the first-look edit writes is new whatever its date — a block dated the day before is not recorded as seen, a bare live line in it is judged.
    const back = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
    const yesterday = `${back.getFullYear()}-${String(back.getMonth() + 1).padStart(2, '0')}-${String(back.getDate()).padStart(2, '0')}`
    const pastDated = firstLook({ heading: `## Force run ${yesterday}`, confirmed: yesterday, extra: '- `AC-1.1` ⏳ [live: user-side]\n' })
    check('M-1 first look: the PreToolUse snapshot reads the journal before the edit — nothing the edit wrote is seen, its bare live line is returned', pastDated.gate.seen.size === 0 && pastDated.post.decision === 'block' && /\[live: user-side\]/.test(pastDated.post.text), `${pastDated.shown} ${pastDated.post.text.slice(0, 160)}`)
    check('M-1 first look: the PreToolUse run before the edit says nothing (it only takes the snapshot)', preRuns.length === 2 && preRuns.every(({ decision, text }) => decision === 'allow' && text === ''), JSON.stringify(preRuns))
    const pastNoPre = firstLook({ pre: false, heading: `## Force run ${yesterday}`, confirmed: yesterday })
    check('M-1 first look: with no PreToolUse run a block dated before the migration day is taken for an old run (the date filter alone keeps it)', pastNoPre.gate.seen.has(`## Force run ${yesterday}`) && pastNoPre.verdict.decision === 'allow', pastNoPre.shown)
  }

  // m-3: the assumption lines Step 0 of /stage-force shows pass the decision-evidence rule; the short form it used to show does not.
  {
    const skill = readFileSync(join(PLUGIN, '../skills/stage-force/SKILL.md'), 'utf8')
    const shown = skill.split('\n').filter((line) => /^\s*- (?:auth probe|login "not now")/.test(line)).map((line) => line.trim())
    const block = (lines) => `# T-72\n\n## Force run 2026-10-22\nAssumptions:\n${lines.join('\n')}\nConfirmed: 2026-10-22 — answers\n`
    check('m-3: Step 0 shows the three auth-probe assumption lines', shown.length === 3, shown.join(' | '))
    check('m-3: each shown line passes decision-evidence (Rollback and Basis)', decisionViolations(block(shown)).length === 0, JSON.stringify(decisionViolations(block(shown)).map(({ message }) => message)))
    check('m-3: the old short form ("auth probe: `/orders` opened without a redirect") is rejected', decisionViolations(block(['- auth probe: `/orders` opened without a redirect'])).length === 1)
  }

  // S-1, S-2, S-5 (security): 50 000 characters of the inputs that were cubic or quadratic — every pattern under 100 ms.
  {
    const N = 50_000
    const rep = (unit) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N)
    const TOKENS = {
      fresh: rep('fresh'), dotted: rep('a.'), 'dotted ext': rep('x.abcdefg'), alnum: rep('a'), spaces: ' '.repeat(N), 'spaces then x': `${' '.repeat(N)}x`,
      'dots and spaces': rep('. '), 'separators then x': `${rep(' ,;:()—-')}x`, guillemets: rep('«'), 'node_modules': rep('node_modules/'), 'blank lines': '\n'.repeat(N), 'dots then x': `${'.'.repeat(N)}x`,
    }
    const WORDINGS = ['demoted to minor', 'the next stage owns it, see', 'by design', 'the kit owns it', 'not reproduced', 'this stage did not change it', 'false for the data', 'not related to the task', 'the report itself']
    const CRIT = (line) => `# pro-review\nFindings: critical 1 · major 0 · minor 0\n\n- C-1 critical: src/a.ts:1 — x\n\n## Findings outcome\n- C-1 — false: src/a.ts:1 ${line}\n`
    const SUBJECTS = {
      'journal-check ledgerViolations (critical, fresh report)': (t) => jc.ledgerViolations(CRIT(t), 'pro-review-3.md', { strict: true, complete: true }),
      'journal-check disposition strict (no length cap), each dismissal wording': WORDINGS.map((w) => (t) => jc.disposition(`- M-1 — false: ${w} ${t}`, { strict: true })),
      'journal-check liveViolation': (t) => [jc.liveViolation(`- \`AC-1.1\` [live: user-side — profile; /a → ${t}]`), jc.liveViolation(`- [live: user-side — ${t}`)],
      'journal-check likeViolation': (t) => jc.likeViolation(`- \`AC-1.1\` WHEN x THEN like the old ${t}`),
      'dismissals weakForm, each dismissal wording': WORDINGS.map((w) => (t) => weakForm(`#1 — false: ${w} ${t}`)),
      'decisions decisionViolations': (t) => decisionViolations(`# T\n\n## Force run 2026-10-22\nAssumptions:\n- x — Rollback: cheap — Basis: ${t}\n\n## ⚠ Awaiting user confirmation\n- y — Rollback: cheap — Basis: ${t}\n`),
      'ci-gates parseSkip and gateCommands': (t) => [gates.parseSkip(`skip: a${t} 2026-10-19`), gates.gateCommands(`${t}\n- e2e: \`x\`\n`)],
      'pipeline-state taskDirFromConfig, reviewModel, main_branch': (t) => [ps.taskDirFromConfig(`${t}\n- other: 1\n`, '/r'), ps.reviewModel(`${t}\n- other: 1\n`)],
      'verify-doctor config (parseDevServer)': (t) => ps.parseDevServer([`# C\n\n## Dev server\n- url: http://localhost:3000${t}# comment\n- verify_routes: /${t}\n`]),
      'markers forceKey and config lines': (t) => [markers.forceKey(`## Force run ${t}`), markers.KIT_OVERRIDES_OFF.test(t), markers.CI_GATES_HEADING.test(`##${t}`)],
    }
    for (const [name, subject] of Object.entries(SUBJECTS)) {
      let worst = { ms: 0, input: '' }
      for (const run of [].concat(subject)) {
        for (const [input, text] of Object.entries(TOKENS)) {
          const start = performance.now()
          run(text)
          const ms = performance.now() - start
          if (ms > worst.ms) worst = { ms, input }
        }
      }
      check(`S-1/S-2/S-5: 50 000 characters — ${name} < 100 ms`, worst.ms < 100, `${worst.ms.toFixed(0)} ms on "${worst.input}"`)
    }
    // still finds the fresh report the old pattern found
    const cited = (cite) => jc.ledgerViolations(CRIT(`— fresh report ${cite}`), 'pro-review-3.md', { strict: true, taskDir: null }).some(({ rule }) => rule === 'ledger-critical-fresh')
    check('S-1: the fresh report is still found in "checks/pro-review-3-fresh.md.", "(checks/pro-review-3-fresh-opus.md)" and "report:checks/pro-review-3-fresh.md"', !cited('checks/pro-review-3-fresh.md.') && !cited('(checks/pro-review-3-fresh-opus.md)') && !cited('report:checks/pro-review-3-fresh.md') && cited('checks/pro-review-4-fresh.md'))
    // end to end: the report with a 10 KB fresh-token line, written through journal-gate, ends long before the 5 s timeout (36 s before)
    const eRoot = mkdtempSync(join(tmpdir(), 's1-'))
    const eApp = join(eRoot, 'app')
    repoAt(eApp, 'main')
    write(eApp, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n', '.claude/tasks/T-73/STAGES.md': '# T-73: task\nLanguage: en\nBranch: `T-73/feat/s`\n\n## Stages\n\n### Stage 1: a  [status: in-progress]\n' })
    git(eApp, 'checkout', '-qb', 'T-73/feat/s')
    jc.baselineInfo(DATA, join(eApp, '.claude/tasks/T-73'))
    write(eApp, { '.claude/tasks/T-73/checks/pro-review-1.md': CRIT('fresh'.repeat(2000)) })
    const start = performance.now()
    const slow = runHook('journal-gate.mjs', { cwd: eApp, tool_name: 'Write', tool_input: { file_path: join(eApp, '.claude/tasks/T-73/checks/pro-review-1.md') } })
    const ms = performance.now() - start
    check('S-1: journal-gate on a report with a 10 KB fresh-token line on a critical ends in < 1 s and still demands the fresh report', ms < 1000 && /fresh pass on review_model/.test(slow.text), `${ms.toFixed(0)} ms: ${slow.text.slice(0, 120)}`)
    rmSync(eRoot, { recursive: true, force: true })
  }

  // S-4: task files are read only as regular files of at most 4 MB (a symlink only inside the task directory).
  {
    const sTask = mkdtempSync(join(tmpdir(), 's4-task-'))
    const outside = mkdtempSync(join(tmpdir(), 's4-out-'))
    writeFileSync(join(outside, 'secret.md'), 'SECRET-LINE\n')
    writeFileSync(join(sTask, 'STAGES.md'), '# T-74\nLanguage: en\n- own line\n')
    mkdirSync(join(sTask, 'checks'), { recursive: true })
    symlinkSync('/dev/zero', join(sTask, 'STAGES-ARCHIVE.md'))
    const startDev = performance.now()
    const text = jc.journalText(sTask)
    check('S-4: STAGES-ARCHIVE.md -> /dev/zero is not read (no hang), STAGES.md still is', performance.now() - startDev < 1000 && text.includes('own line') && !text.includes('\0'))
    rmSync(join(sTask, 'STAGES-ARCHIVE.md'))
    symlinkSync(join(outside, 'secret.md'), join(sTask, 'STAGES-ARCHIVE.md'))
    check('S-4: a symlink out of the task directory is not read', !jc.journalText(sTask).includes('SECRET-LINE'))
    rmSync(join(sTask, 'STAGES-ARCHIVE.md'))
    writeFileSync(join(sTask, 'notes.md'), 'INSIDE-LINE\n')
    symlinkSync(join(sTask, 'notes.md'), join(sTask, 'STAGES-ARCHIVE.md'))
    check('S-4: a symlink inside the task directory is read', jc.journalText(sTask).includes('INSIDE-LINE'))
    rmSync(join(sTask, 'STAGES-ARCHIVE.md'))
    writeFileSync(join(sTask, 'STAGES-ARCHIVE.md'), `${'a'.repeat(1023)}\n`.repeat(4 * 1024 + 8))
    check('S-4: an oversized archive (> 4 MB) is skipped', jc.journalText(sTask) === readFileSync(join(sTask, 'STAGES.md'), 'utf8'))
    symlinkSync('/dev/zero', join(sTask, 'checks', 'pro-review-9.md'))
    symlinkSync(join(outside, 'secret.md'), join(sTask, 'checks', 'pro-review-8.md'))
    const linked = jc.reportViolations(join(sTask, 'checks', 'pro-review-8.md'))
    check(
      'S-4: reportNames lists regular files only; a report linked out of the task is not read — one violation that names it, none of its text',
      !jc.reportNames(sTask).includes('pro-review-9.md') && linked.length === 1 && linked[0].rule === 'file-unreadable' && /checks\/pro-review-8\.md cannot be read: its real path is outside the task directory/.test(linked[0].message) && !JSON.stringify(linked).includes('SECRET') && jc.readTaskFile(sTask, 'checks', 'pro-review-8.md') === null,
      JSON.stringify(linked),
    )
    rmSync(sTask, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    // end to end: session-start on a repo whose current task commits that symlink finishes at once
    const hRoot = mkdtempSync(join(tmpdir(), 's4-hook-'))
    const hApp = join(hRoot, 'app')
    repoAt(hApp, 'main')
    write(hApp, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n', '.claude/tasks/T-75/STAGES.md': '# T-75: task\nBranch: `T-75/feat/s`\n\n## Stages\n' })
    symlinkSync('/dev/zero', join(hApp, '.claude/tasks/T-75/STAGES-ARCHIVE.md'))
    git(hApp, 'checkout', '-qb', 'T-75/feat/s')
    const t0 = performance.now()
    const started = spawnSync(process.execPath, [join(PLUGIN, 'hooks/session-start.mjs')], { input: JSON.stringify({ cwd: hApp }), encoding: 'utf8', timeout: 10_000 })
    check('S-4: session-start with STAGES-ARCHIVE.md -> /dev/zero ends normally in < 3 s', started.status === 0 && performance.now() - t0 < 3000 && /T-75/.test(started.stdout), `${(performance.now() - t0).toFixed(0)} ms, status ${started.status}`)
    rmSync(hRoot, { recursive: true, force: true })
  }

  // m-4: outside a pipeline repo the PreToolUse run of journal-gate leaves without stamping (no git, no task reads); a linked worktree with the config only in the main tree is a pipeline repo.
  {
    const plain = mkdtempSync(join(tmpdir(), 'plain-'))
    const id = `toolu_plain_${Date.now()}`
    runHook('journal-gate.mjs', { cwd: plain, tool_name: 'Bash', tool_use_id: id, hook_event_name: 'PreToolUse', tool_input: { command: 'ls' } })
    check('m-4: journal-gate Pre in a directory without a pipeline config writes no stamp', !existsSync(join(DATA, 'bash-start', `${id}.json`)))
    check('m-4: hasPipelineConfig — no in a plain dir', !ps.hasPipelineConfig(plain))
    const mainTree = mkdtempSync(join(tmpdir(), 'has-config-'))
    repoAt(mainTree, 'main')
    write(mainTree, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n' })
    const linked = join(mkdtempSync(join(tmpdir(), 'has-config-wt-')), 'wt')
    git(mainTree, 'worktree', 'add', '-q', '-b', 'feat/y', linked)
    mkdirSync(join(linked, 'src/deep'), { recursive: true })
    check('m-4: hasPipelineConfig — yes in the main tree and in a linked worktree whose `.claude/` is excluded (from a subdirectory too)', ps.hasPipelineConfig(join(mainTree, 'src')) && ps.hasPipelineConfig(join(linked, 'src/deep')))
    rmSync(plain, { recursive: true, force: true })
    rmSync(mainTree, { recursive: true, force: true })
    rmSync(dirname(linked), { recursive: true, force: true })
  }

  // m-4, the cheap paths themselves: on a copy of the scripts whose journal-check.mjs throws at import, a Bash call that cannot have touched the journal
  // never loads the rules — journal-gate Pre outside a pipeline repo, journal-gate Post with an unchanged stamp in one, git-guard Pre / Post on `ls` exit 0, silent.
  {
    const copy = join(mkdtempSync(join(tmpdir(), 'lazy-scripts-')), 'scripts')
    cpSync(PLUGIN, copy, { recursive: true })
    writeFileSync(join(copy, 'journal-check.mjs'), "throw new Error('journal-check.mjs loaded on a cheap path')\n")
    const lazyHook = (name, input) => spawnSync(process.execPath, [join(copy, 'hooks', name)], { input: JSON.stringify(input), encoding: 'utf8' })
    const quiet = (run) => run.status === 0 && run.stderr === '' && run.stdout === ''
    const shown = (run) => `exit ${run.status}: ${(run.stderr || run.stdout).split('\n').find((line) => line.trim()) ?? ''}`
    const plain = mkdtempSync(join(tmpdir(), 'lazy-plain-'))
    const call = (cwd, id, event) => ({ cwd, tool_name: 'Bash', tool_use_id: id, hook_event_name: event, tool_input: { command: 'ls' } })
    const plainPre = lazyHook('journal-gate.mjs', call(plain, `toolu_lazy_plain_${Date.now()}`, 'PreToolUse'))
    check('m-4 lazy: journal-gate Pre in a plain dir does not load journal-check (exit 0, no stderr)', quiet(plainPre), shown(plainPre))
    const lRoot = mkdtempSync(join(tmpdir(), 'lazy-repo-'))
    const lApp = join(lRoot, 'app')
    repoAt(lApp, 'main')
    write(lApp, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n', '.claude/tasks/T-76/STAGES.md': '# T-76: task\nLanguage: en\nBranch: `T-76/feat/l`\n\n## Stages\n\n### Stage 1: a  [status: in-progress]\n', '.claude/tasks/T-76/checks/pro-review-1.md': '# pro-review\nFindings: critical 0 · major 0 · minor 0\n' })
    git(lApp, 'checkout', '-qb', 'T-76/feat/l')
    const id = `toolu_lazy_repo_${Date.now()}`
    const repoPre = lazyHook('journal-gate.mjs', call(lApp, id, 'PreToolUse'))
    const stamped = existsSync(join(DATA, 'bash-start', `${id}.json`))
    const repoPost = lazyHook('journal-gate.mjs', call(lApp, id, 'PostToolUse'))
    check('m-4 lazy: journal-gate Pre in a pipeline repo stamps the task without loading journal-check', quiet(repoPre) && stamped, `${shown(repoPre)}, stamp ${stamped}`)
    check('m-4 lazy: journal-gate Post with an unchanged stamp does not load journal-check (exit 0, no stderr)', quiet(repoPost), shown(repoPost))
    const guardPre = lazyHook('git-guard.mjs', call(lApp, `${id}_g`, 'PreToolUse'))
    const guardPost = lazyHook('git-guard.mjs', call(lApp, `${id}_g`, 'PostToolUse'))
    check('m-4 lazy: git-guard Pre and Post on `ls` do not load journal-check (exit 0, no stderr)', quiet(guardPre) && quiet(guardPost), `${shown(guardPre)} / ${shown(guardPost)}`)
    const edit = lazyHook('journal-gate.mjs', { cwd: lApp, tool_name: 'Edit', hook_event_name: 'PostToolUse', tool_input: { file_path: join(lApp, '.claude/tasks/T-76/STAGES.md') } })
    check('m-4 lazy: the copy is live — an edit of STAGES.md does load journal-check (the throwing module is reached)', edit.status !== 0 && /loaded on a cheap path/.test(edit.stderr), shown(edit))
    rmSync(dirname(copy), { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
    rmSync(lRoot, { recursive: true, force: true })
  }
}

// ── VT-1 stage 5c fix round 1: task files read bounded and fail closed, linear counts and ranking, the data dir on an old registry ──
// Each rule: the incident form (fails before the fix) and the legitimate form (passes), D7.
{
  const ps = await import(join(PLUGIN, 'hooks/pipeline-state.mjs'))
  const { collectDigest, publishDigest } = await import(join(PLUGIN, 'run-digest.mjs'))
  const { bulletTexts, rollbackRank } = await import(join(PLUGIN, 'decisions.mjs'))
  const timed = (run) => {
    const start = performance.now()
    const value = run()
    return { value, ms: performance.now() - start }
  }
  // A hook run with a timeout of its own: a regression must fail the check, not hang the suite.
  const hookTimed = (name, input) => {
    const start = performance.now()
    const run = spawnSync(process.execPath, [join(PLUGIN, 'hooks', name)], { input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000 })
    const ms = performance.now() - start
    let out = {}
    try {
      out = run.stdout.trim() ? JSON.parse(run.stdout) : {}
    } catch {
      out = { raw: run.stdout }
    }
    const decision = out.hookSpecificOutput?.permissionDecision ?? out.decision ?? (run.stdout.trim() ? 'message' : 'allow')
    const text = out.hookSpecificOutput?.permissionDecisionReason ?? out.reason ?? out.systemMessage ?? out.hookSpecificOutput?.additionalContext ?? run.stdout ?? ''
    return { decision, text, ms, status: run.status, stdout: run.stdout, stderr: run.stderr }
  }
  const PAD = `\n<!-- a pasted console log -->\n${`${'x'.repeat(1023)}\n`.repeat(4 * 1024 + 8)}`
  const OPEN_CRITICAL = (title = 'stage 1') => `# pro-review, ${title}\nFindings: critical 1 · major 0 · minor 0\n\n| ID | Severity | Where | What |\n|---|---|---|---|\n| K-1 | critical | src/a.ts:1 | the value is wrong |\n`
  const FIXED = '\n## Findings outcome\n- K-1 — fixed: src/a.ts:1\n'
  const ahead = (path, seconds = 5) => utimesSync(path, Date.now() / 1000 + seconds, Date.now() / 1000 + seconds)
  const day = (() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  })()
  let calls = 0
  // A repo with one current task: `force` — an open Force block dated today.
  const taskRepo = (ticket, { force = true, stagesText = null } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'r1-'))
    const app = join(root, 'app')
    repoAt(app, 'main')
    const text = stagesText ?? `# ${ticket}: task\nLanguage: en\nBranch: \`${ticket}/feat/x\`\n\n## Status: stage 1\n\n${force ? `## Force run ${day}\nConfirmed: ${day} — yes\nBlockers: none\n\n` : ''}## Stages\n\n### Stage 1: card  [status: in-progress]\n- [ ] pro-review\n`
    write(app, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n', [`.claude/tasks/${ticket}/STAGES.md`]: text })
    git(app, 'checkout', '-qb', `${ticket}/feat/x`)
    const task = join(app, '.claude/tasks', ticket)
    jc.baselineInfo(DATA, task)
    return { root, app, task, ticket }
  }
  const commit = (r, command = `git commit -am "${r.ticket}: card"`) => hookTimed('git-guard.mjs', { cwd: r.app, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: `toolu_r1_${calls++}`, tool_input: { command } })

  // S-1: the count patterns backtracked polynomially on a long run of spaces or digits; a line is now read flat and capped.
  {
    const N = 50_000
    const INPUTS = {
      'a table row "| 🔴" + spaces': `# pro-review\nFindings\n| 🔴${' '.repeat(N)}| src/a.ts:1 | x |\n`,
      'a 🟠 run + spaces then a digit': `Findings 🟠${' '.repeat(N)}x 1`,
      'a 🟡 run + spaces then a digit': `Findings 🟡${' '.repeat(N)}x 1`,
      'a summary + spaces': `Findings: 1${' '.repeat(N)}`,
      'a 50 000-digit run': `Findings ${'1'.repeat(N)}`,
      'a minor digit run': `Findings: minor ${'7'.repeat(N)}x`,
      'a heading + spaces': `## 🔴 critical${' '.repeat(N)}`,
      'spaces and asterisks': `Findings 🔴${' *'.repeat(N / 2)}x 1`,
    }
    let worst = { ms: 0, input: '' }
    for (const [input, text] of Object.entries(INPUTS)) {
      for (const name of ['pro-review-1.md', 'security-review-1.md', 'dead-code-1.md']) {
        const { ms } = timed(() => jc.findingCounts(text, name))
        if (ms > worst.ms) worst = { ms, input: `${input} (${name})` }
      }
    }
    check('S-1: findingCounts on 50 000 characters of each count-pattern input < 100 ms ("| 🔴" + 250 spaces took 80 s, a 50 000-digit run 8 s)', worst.ms < 100, `${worst.ms.toFixed(0)} ms on ${worst.input}`)
    const fails = timed(() => jc.failedCriteria(`- AC-1.1 was${' '.repeat(N)}x FAIL\n`))
    check('S-1: failedCriteria on "was" + 50 000 spaces + FAIL < 100 ms (1.3 s before), the criterion still counts', fails.ms < 100 && same(fails.value, ['AC-1.1']), `${fails.ms.toFixed(0)} ms ${JSON.stringify(fails.value)}`)
    // The live summary forms read as before; a bold count ("critical **2**") is now read too.
    const FORMS = [
      ['# pro-review\nFindings: critical 0 · major 2 · minor 1\n', 'pro-review-1.md', [0, 2, 1]],
      ['# figma\nVerdict: 0 critical / 2 major\n', 'figma-compare-1.md', [0, 2, 0]],
      ['# pro\nSummary: 🔴0 · 🟠2\n', 'pro-review-2.md', [0, 2, 0]],
      ['# pro\nSummary: 🔴 **critical**: 3 · 🟠 **major**: 1 · 🟡 minor 4\n', 'pro-review-3.md', [3, 1, 4]],
      ['# pro\nVerdict: Request changes (2 major)\n', 'pro-review-4.md', [0, 2, 0]],
      ['# pro\n## Summary\n- **Critical**: 1\n- **Major**:   0\n', 'pro-review-5.md', [1, 0, 0]],
      ['# pro\n**Findings:** critical **2** · major **0** · minor **1**\n', 'pro-review-6.md', [2, 0, 1]],
      ['# dead\nFindings: 1 remove / 2 to check\n', 'dead-code-1.md', [0, 1, 0]],
      ['# sec\nFindings: high 1 · medium 2 · low 3\n', 'security-review-1.md', [1, 2, 3]],
      ['# pro\nFindings\n| ID | Severity |\n|---|---|\n| K-1 | **critical** |\n| K-2 |   major   |\n- 🔴 K-3 the price\n## 🟠 Major (2)\n', 'pro-review-7.md', [2, 1, 0]],
      [`${OPEN_CRITICAL()}| 🔴${' '.repeat(300)}| src/a.ts:2 | padded |\n`, 'pro-review-8.md', [1, 0, 0]],
    ]
    const wrong = FORMS.filter(([text, name, want]) => {
      const got = jc.findingCounts(text, name)
      return !same([got.critical, got.major, got.minor], want)
    })
    check('S-1: the summary and row forms of live reports give their counts with the flat read (and a 300-space "| 🔴" row next to a summary)', wrong.length === 0, JSON.stringify(wrong.map(([, name]) => name)))
    // end to end: a report with that padded row, written and committed in force — judged, and long before the 5 s / 15 s timeouts.
    const r = taskRepo('T-81')
    const report = join(r.task, 'checks/pro-review-1.md')
    write(r.app, { '.claude/tasks/T-81/checks/pro-review-1.md': `${OPEN_CRITICAL()}| 🔴${' '.repeat(300)}| src/a.ts:1 | the price is ×100 |\n\n## Findings outcome\n- K-1 — leaving it as is\n`, 'src/a.ts': 'export const a = 2\n' })
    ahead(report)
    const written = hookTimed('journal-gate.mjs', { cwd: r.app, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: report } })
    check('S-1: journal-gate on a report with "| 🔴" + 300 spaces ends in < 1 s and still judges it (the parked outcome is returned)', written.ms < 1000 && written.decision === 'block' && /decision not to fix/.test(written.text), `${written.ms.toFixed(0)} ms ${written.decision}: ${written.text.slice(0, 120)}`)
    const committed = commit(r)
    check('S-1: git-guard on the force commit of that report ends in < 2 s and denies it (34.6 s at 250 spaces before, past the 15 s timeout)', committed.ms < 2000 && committed.decision === 'deny' && /decision not to fix/.test(committed.text), `${committed.ms.toFixed(0)} ms ${committed.decision}: ${committed.text.slice(0, 120)}`)
    rmSync(r.root, { recursive: true, force: true })
  }

  // S-6: a v1-shaped or broken installed_plugins.json is no registry, as on 0.17.0 — the scripts run from Bash do not crash on it.
  {
    const home = mkdtempSync(join(tmpdir(), 'r1-home-'))
    mkdirSync(join(home, '.claude/plugins'), { recursive: true })
    const task = join(home, 'tasks/T-82')
    mkdirSync(join(task, 'checks'), { recursive: true })
    writeFileSync(join(task, 'STAGES.md'), '# T-82: task\nLanguage: en\n')
    const env = { ...process.env, HOME: home }
    delete env.CLAUDE_PLUGIN_DATA
    for (const [label, registry] of [
      ['a v1 file (an object per plugin)', { version: 1, plugins: { 'stage-pipeline@magzhan': { version: '0.16.0', installPath: '/x' } } }],
      ['a null entry', { version: 2, plugins: { 'stage-pipeline@magzhan': [null] } }],
    ]) {
      writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify(registry))
      const dir = spawnSync(process.execPath, ['--input-type=module', '-e', `import { pluginDataDir } from ${JSON.stringify(join(PLUGIN, 'hooks/pipeline-state.mjs'))}; console.log(pluginDataDir())`], { env, encoding: 'utf8' })
      const digest = spawnSync(process.execPath, [join(PLUGIN, 'run-digest.mjs'), task, '--no-write'], { env, cwd: home, encoding: 'utf8' })
      const journal = spawnSync(process.execPath, [join(PLUGIN, 'journal-check.mjs'), task], { env, cwd: home, encoding: 'utf8' })
      check(
        `S-6: ${label} in installed_plugins.json — the data dir is -inline (0.17.0's result), run-digest and journal-check exit 0`,
        dir.status === 0 && dir.stdout.trim().endsWith('/stage-pipeline-inline') && digest.status === 0 && /Blockers/.test(digest.stdout) && journal.status === 0,
        `${dir.stdout.trim()} ${dir.stderr.split('\n')[0]} | digest ${digest.status} ${digest.stderr.split('\n').find((line) => /Error/.test(line)) ?? ''} | journal ${journal.status}`,
      )
    }
    rmSync(home, { recursive: true, force: true })
  }

  // S-2: a report or a STAGES.md over 4 MB is not "empty": the commit, the close and the digest refuse it, naming the file and the limit.
  {
    const r = taskRepo('T-83')
    const report = join(r.task, 'checks/pro-review-1.md')
    write(r.app, { '.claude/tasks/T-83/checks/pro-review-1.md': `${OPEN_CRITICAL()}${PAD}`, 'src/a.ts': 'export const a = 2\n' })
    ahead(report)
    const unreadable = jc.openLedgers(DATA, r.task)
    check('S-2: openLedgers — a report over 4 MB with an open critical is one violation naming the file, its size and the limit', unreadable.length === 1 && /checks\/pro-review-1\.md cannot be read: it is 4\.01 MB, over the 4 MB limit/.test(unreadable[0].message), JSON.stringify(unreadable))
    const denied = commit(r)
    check('S-2: the force commit with that report is denied (it was allowed: the critical read as none)', denied.decision === 'deny' && /pro-review-1\.md cannot be read: it is 4\.01 MB, over the 4 MB limit/.test(denied.text), `${denied.decision}: ${denied.text.slice(0, 200)}`)
    const d = collectDigest(r.task, DATA, null)
    const short = publishDigest(r.task, DATA, null, { write: false }).short
    check('S-2: the digest says "Not ready for PR" for that report, with its size (it was an all-clear)', d.unreadable.some(({ file }) => file === 'checks/pro-review-1.md') && short.includes('Not ready for PR — these files cannot be read, so their rules did not run: checks/pro-review-1.md (4.01 MB, over the 4 MB limit)'), short)
    writeFileSync(report, `${OPEN_CRITICAL()}${FIXED}`)
    ahead(report)
    const fixed = commit(r)
    check('S-2 legit: the same report under the cap with its critical fixed — no ledger violation, the commit passes', jc.openLedgers(DATA, r.task).length === 0 && fixed.decision === 'allow' && collectDigest(r.task, DATA, null).unreadable.length === 0, `${fixed.decision}: ${fixed.text.slice(0, 200)}`)
    // the close: whole-branch reports over the cap with an open critical — "completed" is rejected
    for (const name of ['pro-review-branch.md', 'task-converge.md']) {
      write(r.app, { [`.claude/tasks/T-83/checks/${name}`]: `${OPEN_CRITICAL('branch')}${PAD}` })
      ahead(join(r.task, 'checks', name), 10)
    }
    write(r.app, { '.claude/tasks/T-83/STAGES.md': readFileSync(join(r.task, 'STAGES.md'), 'utf8').replace(`## Force run ${day}`, `## Force run ${day} — completed`) })
    const close = jc.forceCloseViolations(DATA, r.task)
    const closed = hookTimed('journal-gate.mjs', { cwd: r.app, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(r.task, 'STAGES.md') } })
    check(
      'S-2: closing "completed" with the final reports over 4 MB is rejected, each named (it was accepted)',
      ['pro-review-branch.md', 'task-converge.md'].every((name) => close.some(({ message }) => message.startsWith(`checks/${name} cannot be read`))) && closed.decision === 'block' && /checks\/task-converge\.md cannot be read: it is 4\.01 MB/.test(closed.text),
      `${JSON.stringify(close.map(({ rule }) => rule))} ${closed.decision}: ${closed.text.slice(0, 200)}`,
    )
    for (const name of ['pro-review-branch.md', 'task-converge.md']) {
      writeFileSync(join(r.task, 'checks', name), `${OPEN_CRITICAL('branch')}${FIXED}`)
      ahead(join(r.task, 'checks', name), 10)
    }
    check('S-2 legit: the same final reports under the cap with the critical fixed — no unreadable or ledger violation at the close', !jc.forceCloseViolations(DATA, r.task).some(({ rule }) => rule === 'file-unreadable' || rule.startsWith('ledger-')))
    rmSync(r.root, { recursive: true, force: true })

    // STAGES.md over the cap: the task does not vanish (it did, and the branch's commits went through); its gates refuse, naming the file.
    const s = taskRepo('T-84', { force: false })
    const stagesPath = join(s.task, 'STAGES.md')
    const small = readFileSync(stagesPath, 'utf8')
    check('S-2 legit: a STAGES.md under the cap — the task is read, normal mode denies the agent\'s commit as before', commit(s, 'git commit -m x').decision === 'deny' && readPipelineState(s.app).tasks.some((task) => task.ticket === 'T-84' && task.unreadable === null && task.current))
    writeFileSync(stagesPath, `${small}${PAD}`)
    const state = readPipelineState(s.app)
    const task = state.tasks.find((candidate) => candidate.ticket === 'T-84')
    check('S-2: a STAGES.md over 4 MB keeps its task, current by the ticket in the branch, marked unreadable', Boolean(task?.current) && task.unreadable?.problem === 'too-large' && task.stages === '', JSON.stringify({ current: task?.current, unreadable: task?.unreadable?.problem }))
    const refused = commit(s, 'git commit -m x')
    check('S-2: a commit on that branch is denied with the journal named and the limit (it was allowed: the task vanished)', refused.decision === 'deny' && /STAGES\.md cannot be read: it is 4\.\d+ MB, over the 4 MB limit/.test(refused.text) && /archive-stages/.test(refused.text), `${refused.decision}: ${refused.text.slice(0, 200)}`)
    const edited = hookTimed('journal-gate.mjs', { cwd: s.app, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: stagesPath } })
    check('S-2: an edit of that STAGES.md gets the same message from journal-gate (it was silent)', edited.decision === 'block' && /STAGES\.md cannot be read: it is 4\.\d+ MB/.test(edited.text), `${edited.decision}: ${edited.text.slice(0, 160)}`)
    const listed = hookTimed('session-start.mjs', { cwd: s.app })
    check('S-2: session-start names the task and why its journal is not read', /T-84 \(branch T-84\/feat\/x\): STAGES\.md cannot be read: it is 4\.\d+ MB/.test(listed.stdout), listed.stdout.slice(0, 200))
    const stagesDigest = publishDigest(s.task, DATA, null, { write: false }).short
    check('S-2: the digest of that task says "Not ready for PR" for STAGES.md', /Not ready for PR — these files cannot be read, so their rules did not run: STAGES\.md \(4\.\d+ MB, over the 4 MB limit\)/.test(stagesDigest), stagesDigest.slice(0, 300))
    // n-2: no journal to take `Language:` from — English unless the config says `language: ru`, never the Russian default of an unknown task.
    const ruDigest = publishDigest(s.task, DATA, { worktree: s.app, config: '- language: ru\n' }, { write: false }).short
    check('n-2: with the journal unreadable the digest is English; the config\'s `language: ru` makes it Russian', /^Not ready for PR|\nNot ready for PR/.test(stagesDigest) && !/Не готово к PR/.test(stagesDigest) && /Не готово к PR — файлы не читаются/.test(ruDigest), ruDigest.slice(0, 200))
    // n-3: the deny keeps the hand-the-commit guidance and names archive-stages.mjs by its path.
    check('n-3: the unreadable-journal deny hands the commit to the user and names archive-stages.mjs by its full path', /hand the commit to the user/.test(refused.text) && refused.text.includes(join(PLUGIN, 'archive-stages.mjs')), refused.text.slice(0, 400))
    rmSync(s.root, { recursive: true, force: true })

    // m-5 (5c re-review): a config over 256 KB is read for its first 256 KB, not as empty; session-start names it. The keys at its top (task_path) keep the task found and the commit denied.
    const c = taskRepo('T-96', { force: false })
    const moved = join(c.app, '.claude/work/tasks')
    mkdirSync(dirname(moved), { recursive: true })
    renameSync(join(c.app, '.claude/tasks'), moved)
    const configPath = join(c.app, '.claude/pipeline.config.md')
    const configHead = '- task_path: .claude/work/tasks/\n- main_branch: main\n'
    writeFileSync(configPath, configHead)
    const normalCommit = commit(c, 'git commit -m x')
    const quiet = hookTimed('session-start.mjs', { cwd: c.app })
    check('m-5 legit: a small config — task found, commit denied, no oversize line', normalCommit.decision === 'deny' && /T-96/.test(quiet.stdout) && !/over the .* limit/.test(quiet.stdout), `${normalCommit.decision}: ${quiet.stdout.slice(0, 200)}`)
    writeFileSync(configPath, `${configHead}${'# padding line of a pasted dump\n'.repeat(Math.ceil((300 * 1024) / 32))}`)
    const bigCommit = commit(c, 'git commit -m x')
    const bigStart = hookTimed('session-start.mjs', { cwd: c.app })
    const bigState = readPipelineState(c.app)
    check(
      'm-5: a 300 KB config keeps its task_path (the task is found and the normal-mode commit denied) and session-start names the oversize with path, size and limit (it read as empty: task invisible, commit allowed)',
      bigState.tasks.some((task) => task.ticket === 'T-96' && task.current) && bigCommit.decision === 'deny' && /T-96/.test(bigStart.stdout) && /\.claude\/pipeline\.config\.md is 3\d\d KB, over the 256 KB limit/.test(bigStart.stdout),
      `${bigCommit.decision}: ${bigStart.stdout.slice(0, 300)}`,
    )
    rmSync(c.root, { recursive: true, force: true })
  }

  // S-3: containment by the real path of every component; the task reader and the rule reader agree.
  {
    const r = taskRepo('T-85')
    const outside = join(r.root, 'other-project/.claude/tasks/XYZ-9/checks')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'pro-review-9.md'), '# pro-review\nFindings: critical 0 · major 1 · minor 0\n\n| M-1 | major | api.ts:3 | token |\n\n## Findings outcome\n- M-1 major — false: the key sk_live_OUTSIDE_SECRET_123 in api.ts:3 is the staging key\n')
    ahead(join(outside, 'pro-review-9.md'))
    symlinkSync(outside, join(r.task, 'checks'))
    const run = spawnSync(process.execPath, [join(PLUGIN, 'run-digest.mjs'), r.task], { cwd: r.app, encoding: 'utf8' })
    const file = existsSync(join(r.task, 'RUN-DIGEST.md')) ? readFileSync(join(r.task, 'RUN-DIGEST.md'), 'utf8') : ''
    check(
      'S-3: a checks/ directory linked to another project — its report is not read into RUN-DIGEST.md, it is named as outside the task (the secret line was copied in)',
      run.status === 0 && file !== '' && !file.includes('sk_live_OUTSIDE_SECRET_123') && file.includes('checks/pro-review-9.md (its real path is outside the task directory)') && jc.readTaskFile(r.task, 'checks', 'pro-review-9.md') === null,
      `${run.status} ${file.slice(0, 300)}`,
    )
    rmSync(r.root, { recursive: true, force: true })

    // STAGES.md linked out of the task directory (a journal shared between two checkouts): the task fails closed, not rule-free.
    const s = taskRepo('T-86')
    write(s.app, { 'src/a.ts': 'export const a = 2\n' })
    const own = commit(s)
    mkdirSync(join(s.app, '.claude/shared'), { recursive: true })
    renameSync(join(s.task, 'STAGES.md'), join(s.app, '.claude/shared/T-86-STAGES.md'))
    symlinkSync('../../shared/T-86-STAGES.md', join(s.task, 'STAGES.md'))
    const linkedState = readPipelineState(s.app).tasks.find((task) => task.ticket === 'T-86')
    const viaLink = commit(s)
    check(
      'S-3: a force commit with no pro-review report — denied with a regular STAGES.md, and denied (not allowed) with STAGES.md linked out of the task, naming why',
      own.decision === 'deny' && /no pro-review report/.test(own.text) && linkedState?.unreadable?.problem === 'outside' && viaLink.decision === 'deny' && /STAGES\.md cannot be read: its real path is outside the task directory/.test(viaLink.text),
      `${own.decision} / ${linkedState?.unreadable?.problem} / ${viaLink.decision}: ${viaLink.text.slice(0, 200)}`,
    )
    rmSync(s.root, { recursive: true, force: true })

    // legit: the task root behind a symlink (`.claude/tasks` → a team directory outside the repo) reads as before, its rules apply.
    const t = mkdtempSync(join(tmpdir(), 'r1-team-'))
    const app = join(t, 'app')
    repoAt(app, 'main')
    const team = join(t, 'team-tasks')
    mkdirSync(join(team, 'T-87'), { recursive: true })
    writeFileSync(join(team, 'T-87/STAGES.md'), `# T-87: task\nLanguage: en\nBranch: \`T-87/feat/x\`\n\n## Status: stage 1\n\n## Stages\n\n### Stage 1: card  [status: in-progress]\n`)
    writeFileSync(join(team, 'T-87/STAGES-ARCHIVE.md'), '- an archived line\n')
    write(app, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n' })
    symlinkSync(team, join(app, '.claude/tasks'))
    git(app, 'checkout', '-qb', 'T-87/feat/x')
    const teamTask = readPipelineState(app).tasks.find((task) => task.ticket === 'T-87')
    const normal = hookTimed('git-guard.mjs', { cwd: app, tool_input: { command: 'git commit -m x' } })
    check(
      'S-3 legit: .claude/tasks linked to a team directory outside the repo — STAGES.md and the archive are read, the normal-mode rule applies',
      teamTask?.unreadable === null && teamTask.stages.includes('Stage 1: card') && jc.journalText(join(app, '.claude/tasks/T-87')).includes('an archived line') && normal.decision === 'deny' && /normal mode/.test(normal.text),
      `${teamTask?.unreadable?.problem} ${normal.decision}`,
    )
    rmSync(t, { recursive: true, force: true })
  }

  // S-4: one bounded reader for the files a hook takes from a repo — a link to a huge file costs a stat, not a read.
  {
    const r = mkdtempSync(join(tmpdir(), 'r1-big-'))
    const huge = join(r, 'huge.bin')
    writeFileSync(huge, '')
    truncateSync(huge, 64 * 1024 * 1024) // sparse: 64 MB on stat, no blocks on disk
    symlinkSync(huge, join(r, 'link.md'))
    symlinkSync('/dev/zero', join(r, 'zero.md'))
    const big = timed(() => ps.readBounded(join(r, 'link.md')))
    check('S-4: readBounded — a link to a 64 MB file is refused as too large by stat, in < 50 ms; a link to /dev/zero is not a regular file', big.value.problem === 'too-large' && big.value.size === 64 * 1024 * 1024 && big.ms < 50 && ps.readBounded(join(r, 'zero.md')).problem === 'not-file', `${JSON.stringify(big.value)} ${big.ms.toFixed(0)} ms`)
    const app = join(r, 'app')
    repoAt(app, 'main')
    mkdirSync(join(app, '.claude'), { recursive: true })
    symlinkSync(huge, join(app, '.claude/pipeline.config.md'))
    const config = timed(() => ps.readConfig(app))
    check('S-4: a config linked to a 64 MB file reads as its first 256 KB (the keys at the top apply) in < 50 ms, the dev server config as none; the repo is still a pipeline repo', config.value.length <= 256 * 1024 && config.ms < 50 && ps.devServerConfig(app) === null && ps.hasPipelineConfig(app) && readPipelineState(app) !== null, `${config.value.length} chars, ${config.ms.toFixed(0)} ms`)
    const pre = hookTimed('journal-gate.mjs', { cwd: app, tool_name: 'Bash', tool_use_id: `toolu_r1_big_${calls++}`, hook_event_name: 'PreToolUse', tool_input: { command: 'ls' } })
    check('S-4: journal-gate PreToolUse on `ls` in that repo exits 0 in < 2 s (exit 1 after 1.3 s and 1.5 GB on a 963 MB file before)', pre.status === 0 && pre.ms < 2000 && pre.stderr === '', `${pre.status} ${pre.ms.toFixed(0)} ms ${pre.stderr.split('\n')[0]}`)
    rmSync(join(app, '.claude/pipeline.config.md'))
    // a task whose STAGES-ARCHIVE.md is that file: session-start and the unjournaled-commits walk read the rest of the journal and go on
    write(app, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n', '.claude/tasks/T-88/STAGES.md': '# T-88: task\nBranch: `T-88/feat/x`\n\n## Force run 2026-10-01 — completed 2026-10-02\n\n## Stages\n' })
    // 600 MB: past the longest string Node makes, so a full read throws (exit 1, no output) — as the 963 MB system file did
    writeFileSync(join(app, '.claude/tasks/T-88/STAGES-ARCHIVE.md'), '')
    truncateSync(join(app, '.claude/tasks/T-88/STAGES-ARCHIVE.md'), 600 * 1024 * 1024)
    git(app, 'checkout', '-qb', 'T-88/feat/x')
    write(app, { 'src/a.ts': 'export const a = 3\n' })
    git(app, 'commit', '-qam', 'after the close')
    const started = hookTimed('session-start.mjs', { cwd: app })
    const walk = timed(() => ps.unjournaledCommits(readPipelineState(app), readPipelineState(app).tasks.find((task) => task.ticket === 'T-88')))
    check(
      'S-4: session-start with a 600 MB STAGES-ARCHIVE.md ends in < 3 s with the task line and names the commit the rest of the journal does not know',
      started.status === 0 && started.ms < 3000 && /T-88/.test(started.stdout) && /after the close/.test(started.stdout) && walk.value.some(({ subject }) => subject === 'after the close') && walk.ms < 1000,
      `${started.status} ${started.ms.toFixed(0)} ms ${started.stdout.slice(0, 200)} ${started.stderr.split('\n')[0]}`,
    )
    rmSync(r, { recursive: true, force: true })
  }

  // S-5: the digest ranks only bullet rows, each on its text built in one pass.
  {
    const lines = ['- default sort order — Rollback: expensive, a data migration — Basis: guess', ...Array.from({ length: 199_998 }, (_, index) => `  pasted log line ${index}`), '- the label text — Rollback: cheap, one constant — Basis: D2']
    const ranked = timed(() => [...bulletTexts(lines)].map(([index, text]) => [index, rollbackRank(text)]))
    check('S-5: 200 000 lines under one Awaiting bullet are ranked in < 100 ms, expensive first (0) and cheap (3)', ranked.ms < 100 && same(ranked.value, [[0, 0], [199_999, 3]]), `${ranked.ms.toFixed(0)} ms ${JSON.stringify(ranked.value)}`)
    // the same ranks as the per-line join it replaces, on sections with nested bullets, blank lines and the cost on a continuation line
    const joinOld = (section, index) => {
      let end = index + 1
      while (end < section.length && !/^\s*(?:[-*]|\d+\.)\s+\S/.test(section[end])) end++
      return section.slice(index, end).join(' ')
    }
    const SECTIONS = [
      ['- a', '  Rollback: moderate, three skill texts', '', '- b — Rollback: cheap', '  - nested — Rollback: expensive', '1. c — Basis: guess', '   Rollback: irreversible'],
      ['intro line', '- x — Rollback: not expensive, one line — Basis: D1', '- y — Откат: дорого, миграция — Основание: догадка'],
    ]
    const differs = SECTIONS.filter((section) => {
      const texts = bulletTexts(section)
      return section.some((line, index) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line) && rollbackRank(texts.get(index)) !== rollbackRank(joinOld(section, index)))
    })
    check('S-5 legit: the one-pass texts give the ranks of the per-line join (nested bullets, blank lines, a cost on a continuation line, the Russian words)', differs.length === 0, JSON.stringify(differs))
    // end to end: the close digest of a task with 20 000 lines under one Awaiting item (56 s before)
    const dData = mkdtempSync(join(tmpdir(), 'r1-await-data-'))
    const dTask = mkdtempSync(join(tmpdir(), 'r1-await-task-'))
    writeFileSync(join(dTask, 'STAGES.md'), '# T-89\nLanguage: en\n\n## Stages\n')
    jc.baselineInfo(dData, dTask)
    writeFileSync(join(dTask, 'STAGES.md'), `# T-89\nLanguage: en\n\n## Force run ${day} — completed\nBlockers: none\n\n## ⚠ Awaiting user confirmation\n- default sort order — Rollback: expensive, a data migration — Basis: guess\n${Array.from({ length: 20_000 }, (_, index) => `  pasted log line ${index}`).join('\n')}\n- the label — Rollback: cheap, one constant — Basis: D2\n\n## Stages\n`)
    const digest = timed(() => collectDigest(dTask, dData, null))
    check('S-5: the digest of a journal with 20 000 lines under one Awaiting item is built in < 2 s, the rows in rollback order', digest.ms < 2000 && digest.value.accepted.length === 2 && digest.value.accepted[0].startsWith('- default sort order'), `${digest.ms.toFixed(0)} ms ${JSON.stringify(digest.value.accepted.map((line) => line.slice(0, 30)))}`)
    rmSync(dData, { recursive: true, force: true })
    rmSync(dTask, { recursive: true, force: true })
  }
}

// ── VT-1 stage 5b (0.18.1): devtools-verify closes the pages and browsers it opened; browser-cleanup by session ──
// Each rule: the live incident form that must fail and the live legitimate form that must pass. Every process signalled here is a throwaway one this block
// spawns itself: node sleepers with a fake `--user-data-dir=` stand for Chrome, a node script whose arguments name `chrome-devtools-mcp` for the MCP server,
// a node process started with argv0 `claude` for a session. Real browsers on the machine are never touched: the kill paths run under a fake `claude` and with
// `--under <this block's directory>`, the hook path only after the fake session was proven to be the one the script sees. Each throwaway process exits by itself
// after two minutes, and the block kills what is left by PID, only processes whose command line holds its directory.
{
  const bc = await import(join(PLUGIN, 'browser-cleanup.mjs'))
  const proc = await import(join(PLUGIN, 'processes.mjs'))
  const bRoot = realpathSync(mkdtempSync(join(tmpdir(), 'browsers-test-')))
  const SCRIPT = join(PLUGIN, 'browser-cleanup.mjs')
  const started = new Set()
  const pause = (ms) => new Promise((done) => setTimeout(done, ms))
  const goneWithin = async (pid, ms = 3000) => {
    const deadline = Date.now() + ms
    while (proc.alive(pid) && Date.now() < deadline) await pause(50)
    return !proc.alive(pid)
  }
  const SELF_EXIT = 'setTimeout(() => process.exit(0), 120_000)'
  const script = (name, lines) => {
    const path = join(bRoot, name)
    writeFileSync(path, `${lines.join('\n')}\n`)
    return path
  }
  const SLEEPER = script('sleeper.mjs', ['setInterval(() => {}, 1000)', SELF_EXIT])
  // A fake Chrome that is one by its executable (S-1 / S-4): node with argv0 `<this block's dir>/Google Chrome` and inline code, so `ps` shows a command line
  // that starts with that path and ends with the profile switches. `extra` — code run first (a PID-reuse stand-in renames the process on a signal).
  const CHROME_EXE = join(bRoot, 'Google Chrome')
  const chromeArgv = (args, extra = '') => ['-e', `${extra}setTimeout(()=>process.exit(0),120000);setInterval(()=>{},1000)`, '--', ...args]
  const fakeChrome = (args, { extra = '', ...options } = {}) => {
    const child = spawn(process.execPath, chromeArgv(args, extra), { argv0: CHROME_EXE, stdio: 'ignore', ...options })
    started.add(child.pid)
    return child
  }
  const REUSED = (signalName) => `process.on('${signalName}',()=>{process.title='${bRoot}/another-process-on-that-pid'});`
  // A fake MCP server: it launches its "Chrome" (the sleeper) as a child, or as a grandchild through a node process titled like the real inner `chrome-devtools-mcp`.
  const WRAPPER = script('wrapper.mjs', [
    "import { spawn } from 'node:child_process'",
    'const chrome = JSON.parse(process.env.FAKE_CHROME)',
    `const child = spawn(process.execPath, [${JSON.stringify(SLEEPER)}, ...chrome.args], { stdio: 'ignore' })`,
    "process.stdout.write('chrome ' + child.pid + '\\n')",
    // the middle link leaves with its MCP server (the fake session kills the server and the browser by PID)
    'const parent = process.ppid',
    "setInterval(() => { try { process.kill(parent, 0) } catch { process.exit(0) } }, 200)",
    SELF_EXIT,
  ])
  const FAKE_MCP = script('fake-mcp.mjs', [
    "import { spawn } from 'node:child_process'",
    'const chrome = JSON.parse(process.env.FAKE_CHROME)',
    `const child = chrome.grandchild ? spawn(process.execPath, [${JSON.stringify(WRAPPER)}, 'chrome-devtools-mcp'], { stdio: ['ignore', 'pipe', 'inherit'] }) : spawn(process.execPath, [${JSON.stringify(SLEEPER)}, ...chrome.args], { stdio: 'ignore' })`,
    'if (chrome.grandchild) child.stdout.pipe(process.stdout)',
    "else process.stdout.write('chrome ' + child.pid + '\\n')",
    'setInterval(() => {}, 1000)',
    SELF_EXIT,
  ])
  // A fake Claude Code session (argv0 `claude`): it starts its MCP servers, runs the given commands as its own children, records which of its processes live after each.
  const FAKE_CLAUDE = script('fake-claude.mjs', [
    "import { spawn, spawnSync } from 'node:child_process'",
    "import { readFileSync, writeFileSync } from 'node:fs'",
    "const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'))",
    "const alive = (pid) => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }",
    'const tree = []',
    'for (const server of spec.servers) {',
    `  const mcp = spawn(process.execPath, [${JSON.stringify(FAKE_MCP)}, ...server.args], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, FAKE_CHROME: JSON.stringify(server.chrome) } })`,
    "  const chrome = await new Promise((done) => { let text = ''; mcp.stdout.on('data', (chunk) => { text += chunk; const found = /chrome (\\d+)/.exec(text); if (found) done(Number(found[1])) }) })",
    '  tree.push({ mcp: mcp.pid, chrome })',
    '}',
    'const pids = tree.flatMap(({ mcp, chrome }) => [mcp, chrome])',
    "writeFileSync(spec.out + '.tree', JSON.stringify({ claude: process.pid, tree }))",
    'const runs = []',
    'for (const run of spec.runs) {',
    "  const result = spawnSync(process.execPath, run.args, { input: run.input ?? '', encoding: 'utf8', env: { ...process.env, ...run.env }, timeout: 30_000 })",
    '  runs.push({ stdout: result.stdout, stderr: result.stderr, status: result.status, alive: Object.fromEntries(pids.map((pid) => [pid, alive(pid)])) })',
    '}',
    'writeFileSync(spec.out, JSON.stringify({ claude: process.pid, tree, runs }))',
    "if (spec.hold) await new Promise((done) => { process.stdin.on('end', done); process.stdin.resume(); setTimeout(done, 120_000) })",
    "for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }",
    'process.exit(0)',
  ])
  const session = async (name, servers, { runs = [], hold = false } = {}) => {
    const dir = join(bRoot, name)
    mkdirSync(dir, { recursive: true })
    const out = join(bRoot, `${name}.json`)
    const spec = join(bRoot, `${name}.spec.json`)
    writeFileSync(spec, JSON.stringify({ servers, runs, hold, out }))
    const child = spawn(process.execPath, [FAKE_CLAUDE, spec], { argv0: 'claude', cwd: dir, stdio: [hold ? 'pipe' : 'ignore', 'ignore', 'inherit'] })
    started.add(child.pid)
    const exited = new Promise((done) => child.on('exit', done))
    const file = hold ? `${out}.tree` : out
    const deadline = Date.now() + 60_000
    let result = null
    while (!result && Date.now() < deadline) {
      try {
        result = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        await pause(50)
      }
    }
    if (!result) return null
    for (const { mcp, chrome } of result.tree) started.add(mcp).add(chrome)
    if (!hold) await exited
    return { ...result, runs: result.runs ?? [], dir, end: async () => (child.stdin?.end(), exited) }
  }
  const temp = (name, extra = {}) => ({ args: [`--user-data-dir=${join(bRoot, `puppeteer_dev_chrome_profile-${name}`)}`, '--remote-debugging-pipe'], ...extra })
  const PERSISTENT = join(bRoot, 'stage-pipeline/chrome/app')
  const PROJECT = join(bRoot, '.cache/chrome-devtools-mcp/chrome-profile')

  try {
    // ── recognising the processes (a process table of the live forms, nothing signalled) ──
    const CLAUDES = [
      ['/Users/u/.vscode/extensions/anthropic.claude-code-2.1.304-darwin-arm64/resources/native-binary/claude --output-format stream-json --verbose', true],
      ['claude', true],
      ['node /Users/u/.nvm/versions/node/v22.11.0/bin/claude --resume', true],
      ['node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', true],
      ['/bin/zsh -c cd /tmp/claude && node browser-cleanup.mjs', false],
      ['node /Users/u/programming/claude-pipeline/scripts/x.mjs', false],
      ['/Applications/Claude.app/Contents/MacOS/Claude', false],
    ]
    const wrongClaude = CLAUDES.filter(([args, want]) => bc.isClaude(args) !== want)
    check('browser-cleanup: a Claude Code process is told by its executable (native, npm), not by a "claude" word in a shell command', !wrongClaude.length, JSON.stringify(wrongClaude))
    const SERVERS = [
      ['npm exec chrome-devtools-mcp@1.6.0 --isolated', true],
      ['chrome-devtools-mcp', true],
      ['/usr/local/bin/node /usr/local/lib/node_modules/chrome-devtools-mcp/build/src/telemetry/watchdog/main.js --parent-pid=111', false],
      ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/u/.cache/chrome-devtools-mcp/chrome-profile', false],
      ['claude --mcp-config {"chrome-devtools":{"command":"npx","args":["chrome-devtools-mcp@1.6.0"]}}', false],
    ]
    const wrongServer = SERVERS.filter(([args, want]) => bc.isMcpServer(args) !== want)
    check('browser-cleanup: an MCP server is the npm exec and its node process — not the watchdog, not a Chrome on the MCP profile, not a claude that names the server', !wrongServer.length, JSON.stringify(wrongServer))
    const UID = process.getuid()
    const row = (pid, ppid, args, age = 600, uid = UID) => [pid, { pid, ppid, uid, age, args }]
    const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --allow-pre-commit-input --disable-background-networking'
    const T = realpathSync(tmpdir())
    const table = new Map([
      row(1, 0, '/sbin/launchd'),
      row(50, 1, '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)'),
      row(100, 50, '/Users/u/.vscode/extensions/anthropic.claude-code-2.1.304-darwin-arm64/resources/native-binary/claude --output-format stream-json'),
      row(101, 100, '/bin/zsh -c cd /tmp/claude && node /p/scripts/browser-cleanup.mjs --session'),
      row(102, 101, 'node /p/scripts/browser-cleanup.mjs --session'),
      row(110, 100, 'npm exec chrome-devtools-mcp@1.6.0 --isolated'),
      row(111, 110, 'chrome-devtools-mcp'),
      row(112, 111, `${CHROME} --user-data-dir=${T}/puppeteer_dev_chrome_profile-AbC --remote-debugging-pipe`, 82_800),
      row(113, 112, `/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer) --type=renderer --user-data-dir=${T}/puppeteer_dev_chrome_profile-AbC`),
      row(114, 111, '/usr/local/bin/node /usr/local/lib/node_modules/chrome-devtools-mcp/build/src/telemetry/watchdog/main.js --parent-pid=111 --app-version=1.6.0'),
      row(120, 100, 'npm exec chrome-devtools-mcp@1.6.0 --userDataDir /Users/u/.cache/stage-pipeline/chrome/app'),
      row(121, 120, 'chrome-devtools-mcp'),
      row(122, 121, `${CHROME} --user-data-dir=/Users/u/.cache/stage-pipeline/chrome/app --remote-debugging-pipe`),
      row(130, 100, 'npm exec chrome-devtools-mcp@latest'),
      row(131, 130, 'chrome-devtools-mcp'),
      row(132, 131, `${CHROME} --user-data-dir=/Users/u/.cache/chrome-devtools-mcp/chrome-profile --remote-debugging-pipe`),
      row(200, 50, 'node /Users/u/.nvm/versions/node/v22.11.0/bin/claude'),
      row(210, 200, 'npm exec chrome-devtools-mcp@1.6.0 --isolated'),
      row(211, 210, 'chrome-devtools-mcp'),
      row(212, 211, `${CHROME} --user-data-dir=${T}/puppeteer_dev_chrome_profile-Other --remote-debugging-pipe`, 85_000),
      row(300, 1, `${CHROME} --user-data-dir=${T}/puppeteer_dev_chrome_profile-Lost --remote-debugging-pipe`),
      row(310, 101, 'node /scratch/journey.mjs'),
      row(311, 310, `${CHROME} --user-data-dir=${T}/puppeteer_dev_chrome_profile-Run --remote-debugging-pipe`),
      row(320, 1, `${CHROME} --user-data-dir=/Users/u/.cache/stage-pipeline/chrome/old --remote-debugging-pipe`),
      // S-4: a daemonized shell or script that names a puppeteer profile, a browser on such a profile outside the OS temp dir, another user's browser — none is an orphan
      row(330, 1, `/bin/sh -c sleep 120; : --user-data-dir=${T}/puppeteer_dev_chrome_profile-tmux`),
      row(331, 1, `node /scratch/e2e.js --user-data-dir=${T}/puppeteer_dev_chrome_profile-e2e --remote-debugging-pipe`),
      row(332, 1, `${CHROME} --user-data-dir=/Users/u/puppeteer_dev_chrome_profile-home --remote-debugging-pipe`),
      row(333, 1, `${CHROME} --user-data-dir=${T}/puppeteer_dev_chrome_profile-root --remote-debugging-pipe`, 600, UID + 1),
      // a profile path with a space is read whole
      row(334, 1, `${CHROME} --user-data-dir=${T}/puppeteer_dev_chrome_profile-Sp ace --remote-debugging-pipe`),
    ])
    const seen = bc.survey(table, { from: 102 })
    const pids = (list) => list.map(({ pid, kind }) => `${pid}:${kind}`)
    check('browser-cleanup AC-5b.3: the session is the nearest claude above the caller, its browsers are the Chrome mains below its MCP servers (child or grandchild), helpers and the watchdog are not browsers', seen.session?.pid === 100 && same(pids(seen.mine), ['112:temp', '122:persistent', '132:other']), JSON.stringify({ session: seen.session?.pid, mine: pids(seen.mine) }))
    check('browser-cleanup AC-5b.4: another session\'s MCP browser is listed as theirs, with its session', same(pids(seen.others), ['212:temp']) && seen.others[0].session?.pid === 200, JSON.stringify(pids(seen.others)))
    check('browser-cleanup AC-5b.4: an orphan is a temp-profile browser whose parent is gone; one with a live parent or a persistent profile is not', same(seen.orphans.map(({ pid }) => pid), [300, 334]), JSON.stringify(seen.orphans.map(({ pid }) => pid)))
    check('browser-cleanup S-4: a shell or a script that names a puppeteer profile, a browser on one outside the OS temp dir, another user\'s browser — not orphans', !seen.orphans.some(({ pid }) => pid >= 330 && pid <= 333), JSON.stringify(seen.orphans.map(({ pid }) => pid)))
    check('browser-cleanup m-4: a stage-pipeline-chrome browser whose MCP server is gone is listed as holding the profile, nothing else is', same(seen.held.map(({ pid }) => pid), [320]), JSON.stringify(seen.held.map(({ pid }) => pid)))
    // S-3: any process's `--user-data-dir=` is parsed in linear time — a 1 MB whitespace run took the old lazy regexp minutes and the force close past its 5 s
    const spaced = new Map([...table, row(400, 1, `node x --user-data-dir=x${' '.repeat(1_000_000)}y`)])
    const surveyStart = performance.now()
    bc.survey(spaced, { from: 102 })
    const surveyMs = performance.now() - surveyStart
    check(`browser-cleanup S-3: a 1 MB whitespace run in one process's --user-data-dir= — survey ${surveyMs.toFixed(1)} ms (< 100 ms)`, surveyMs < 100, `${surveyMs} ms`)
    check('browser-cleanup: no claude above the caller — no session, every MCP browser is someone else\'s', bc.survey(table, { from: 50 }).session === null && bc.survey(table, { from: 50 }).mine.length === 0)

    // ── AC-5b.3 / AC-5b.4 on live throwaway processes: two fake sessions ──
    const other = await session('session-b', [{ args: ['chrome-devtools-mcp@1.6.0', '--isolated'], chrome: temp('b') }], { hold: true })
    const mine = await session(
      'session-a',
      [
        { args: ['chrome-devtools-mcp@1.6.0', '--isolated'], chrome: temp('a', { grandchild: true }) },
        { args: ['chrome-devtools-mcp@1.6.0', '--userDataDir', PERSISTENT], chrome: { args: [`--user-data-dir=${PERSISTENT}`, '--remote-debugging-pipe'] } },
        { args: ['chrome-devtools-mcp@latest'], chrome: { args: [`--user-data-dir=${PROJECT}`, '--remote-debugging-pipe'] } },
      ],
      { runs: [{ args: [SCRIPT, '--under', bRoot] }, { args: [SCRIPT, '--session', '--persistent', '--under', bRoot] }, { args: [SCRIPT, '--session', '--under', bRoot] }] },
    )
    const [isolated, persistent, project] = mine?.tree ?? []
    const [listed, persistentRun, sessionRun] = mine?.runs ?? []
    const otherChrome = other?.tree[0]?.chrome
    const recognised = Boolean(mine && listed && listed.stdout.includes(`this session — claude ${mine.claude} in ${mine.dir}`))
    check('browser-cleanup (live): the fake session is the one the script sees, with its folder', recognised, listed?.stdout ?? 'no run')
    if (mine && other && listed) {
      check(
        'browser-cleanup AC-5b.4 (live): no flag lists this session\'s browsers with the close command and the other session\'s with age and folder, and kills none',
        new RegExp(`pid ${isolated.chrome} — temp profile.*age \\d+ min — close: node \\S+browser-cleanup\\.mjs --session$`, 'm').test(listed.stdout) &&
          new RegExp(`pid ${persistent.chrome} — stage-pipeline-chrome profile.*--session --persistent$`, 'm').test(listed.stdout) &&
          new RegExp(`pid ${project.chrome} — another profile.*left to its owner$`, 'm').test(listed.stdout) &&
          new RegExp(`pid ${otherChrome} — temp profile, chrome-devtools --isolated, MCP pid ${other.tree[0].mcp}, age \\d+ min — session claude ${other.claude} in ${other.dir}$`, 'm').test(listed.stdout) &&
          Object.values(listed.alive).every(Boolean),
        listed.stdout,
      )
      check(
        'browser-cleanup (live): --session --persistent closes only the stage-pipeline-chrome browser',
        !persistentRun.alive[persistent.chrome] && persistentRun.alive[isolated.chrome] && persistentRun.alive[project.chrome] && /closed 1 stage-pipeline-chrome browser\(s\)/.test(persistentRun.stdout),
        persistentRun.stdout + persistentRun.stderr,
      )
      check(
        'browser-cleanup AC-5b.3 (live): --session closes this session\'s temp-profile browser by PID, leaves the project-profile one and every MCP server running (the next MCP call relaunches)',
        !sessionRun.alive[isolated.chrome] && sessionRun.alive[project.chrome] && [isolated, persistent, project].every(({ mcp }) => sessionRun.alive[mcp]) &&
          new RegExp(`closed 1 browser\\(s\\) of this session \\(claude ${mine.claude}\\) by PID: ${isolated.chrome} `).test(sessionRun.stdout) && new RegExp(`left open: ${project.chrome} `).test(sessionRun.stdout),
        sessionRun.stdout + sessionRun.stderr,
      )
      check('browser-cleanup AC-5b.4 (live): the other session\'s browser is still running after this session\'s --session', proc.alive(otherChrome))
    }
    await other?.end()

    // ── AC-5b.4 --orphans on live throwaway processes ──
    // The maker starts the process detached and exits: the process is handed to launchd / init, as a browser whose MCP server died is.
    const ORPHAN_MAKER = script('orphan-maker.mjs', [
      "import { spawn } from 'node:child_process'",
      'const spec = JSON.parse(process.argv[2])',
      "const child = spawn(process.execPath, spec.args, { detached: true, stdio: 'ignore', ...(spec.argv0 ? { argv0: spec.argv0 } : {}) })",
      'child.unref()',
      'process.stdout.write(String(child.pid))',
    ])
    const orphan = (profile, { browser = true, extra = '' } = {}) => {
      const args = [`--user-data-dir=${join(bRoot, profile)}`, '--remote-debugging-pipe']
      const spec = browser ? { argv0: CHROME_EXE, args: chromeArgv(args, extra) } : { args: [SLEEPER, ...args] }
      const pid = Number(spawnSync(process.execPath, [ORPHAN_MAKER, JSON.stringify(spec)], { encoding: 'utf8' }).stdout)
      started.add(pid)
      return pid
    }
    const lost = orphan('puppeteer_dev_chrome_profile-lost')
    const keptProfile = orphan('stage-pipeline/chrome/old')
    // S-4 incident: a detached non-browser (a tmux server, a nohup'd e2e script) whose arguments name a puppeteer temp profile — 0.18.1's first draft closed it
    const notBrowser = orphan('puppeteer_dev_chrome_profile-tmux', { browser: false })
    const parented = fakeChrome([`--user-data-dir=${join(bRoot, 'puppeteer_dev_chrome_profile-parented')}`, '--remote-debugging-pipe'])
    await pause(300)
    const lostParent = proc.processTable()?.get(lost)?.ppid
    const heldList = spawnSync(process.execPath, [SCRIPT, '--under', bRoot], { encoding: 'utf8' })
    check(
      'browser-cleanup m-4 (live): the listing names the stage-pipeline-chrome browser whose MCP server is gone with its PID, profile and kill, counts no non-browser as an orphan, and kills nothing',
      new RegExp(`^- pid ${keptProfile} — age \\d+ min, profile ${join(bRoot, 'stage-pipeline/chrome/old')} — if no session of this repo uses it: kill ${keptProfile}$`, 'm').test(heldList.stdout) &&
        /orphaned temp-profile browsers \(MCP parent gone\) — 1 /.test(heldList.stdout) && !heldList.stdout.includes(`pid ${notBrowser} `) && [lost, keptProfile, notBrowser].every((pid) => proc.alive(pid)),
      heldList.stdout + heldList.stderr,
    )
    const swept = spawnSync(process.execPath, [SCRIPT, '--orphans', '--under', bRoot], { encoding: 'utf8' })
    check(
      'browser-cleanup AC-5b.4 (live): --orphans closes the temp-profile browser whose parent is gone, by PID',
      (await goneWithin(lost)) && new RegExp(`closed 1 orphaned temp-profile browser\\(s\\) by PID: ${lost}$`, 'm').test(swept.stdout),
      `${swept.stdout}${swept.stderr} (its parent after the maker exited: ${lostParent})`,
    )
    check('browser-cleanup AC-5b.4 (live): --orphans keeps an orphan on the persistent profile and a temp-profile browser whose parent lives', proc.alive(keptProfile) && proc.alive(parented.pid))
    check('browser-cleanup S-4 (live): --orphans leaves a detached non-browser whose arguments name a puppeteer temp profile', proc.alive(notBrowser), swept.stdout)
    // S-6: SIGKILL only to the process that got SIGTERM. The stand-in ignores SIGTERM and renames itself — to `ps` the PID is now another process — so after the wait
    // it must not get SIGKILL (0.18.1's first draft sent it with no second look).
    const reused = orphan('reuse/puppeteer_dev_chrome_profile-reuse', { extra: REUSED('SIGTERM') })
    await pause(300)
    const reuseSweep = spawnSync(process.execPath, [SCRIPT, '--orphans', '--under', join(bRoot, 'reuse')], { encoding: 'utf8' })
    check(
      'browser-cleanup S-6 (live): a PID that is another process by the SIGKILL time (start time / command line changed) gets no SIGKILL',
      proc.alive(reused) && /another-process-on-that-pid/.test(proc.commandOf(reused) ?? '') && /orphaned temp-profile browser/.test(reuseSweep.stdout),
      `${reuseSweep.stdout}${reuseSweep.stderr} alive ${proc.alive(reused)} — ${proc.commandOf(reused)}`,
    )
    // With no `ps` on the PATH the script can kill nothing: the usage forms run that way, so a parse that regressed (0.18.1's first draft dropped the first flag
    // when `--under` was absent, and `--session --orphans` ran `--orphans` machine-wide) fails this check instead of signalling anything.
    const noPs = { ...process.env, PATH: join(bRoot, 'no-such-dir') }
    const usage = ['--session --orphans', '--persistent', '--under', '--under --session'].map((flags) => spawnSync(process.execPath, [SCRIPT, ...flags.split(' ')], { encoding: 'utf8', env: noPs }))
    check('browser-cleanup: a flag set that does not parse (--session with --orphans, --persistent alone, --under with no directory) is a usage error, exit 2, nothing runs', usage.every((run) => run.status === 2 && /Usage/.test(run.stderr)), JSON.stringify(usage.map((run) => [run.status, run.stdout])))
    const blind = spawnSync(process.execPath, [SCRIPT, '--session', '--under', bRoot], { encoding: 'utf8', env: noPs })
    check('browser-cleanup: fail safe — no `ps`, nothing is killed, one line says why, exit 0', blind.status === 0 && /^browser-cleanup: skipped — `ps` is unavailable, nothing closed$/m.test(blind.stdout), blind.stdout + blind.stderr)

    // ── AC-5b.1: frames-guard — pages the agent opened, browsers it launched ──
    const fgRoot = join(bRoot, 'frames')
    mkdirSync(fgRoot)
    let fgCount = 0
    const call = (name, input, id) => ({ type: 'tool_use', id, name, input })
    const answer = (id, text, extra = {}) => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...extra })
    // `base` — the time of the first record (default: 100 s ago); `timestamps: false` — records with no timestamp at all
    const guard = (events, cwd = fgRoot, { base = Date.now() - 100_000, timestamps = true } = {}) => {
      const path = join(fgRoot, `t-${fgCount++}.jsonl`)
      writeFileSync(path, events.map((content, i) => JSON.stringify({ ...(timestamps ? { timestamp: new Date(base + i * 1000).toISOString() } : {}), message: { role: content[0].type === 'tool_result' ? 'user' : 'assistant', content } })).join('\n'))
      return runHook('frames-guard.mjs', { cwd, agent_type: 'stage-pipeline:devtools-verify', agent_transcript_path: path })
    }
    const MCP = 'mcp__plugin_stage-pipeline_chrome-devtools__'
    const DOC = [[call('Bash', { command: 'node /p/scripts/verify-doctor.mjs' }, 'd1')], [answer('d1', 'doctor: ok — http://localhost:3000 answers on / 200')]]
    const pageList = (...lines) => `# new_page response\n## Pages\n${lines.join('\n')}`
    const OPENED = [...DOC, [call(`${MCP}new_page`, { url: 'http://localhost:3000/orders' }, 'n1')], [answer('n1', pageList('1: about:blank', '2: Orders (http://localhost:3000/orders) [selected]'))]]
    const leftOpen = guard(OPENED)
    check('frames-guard AC-5b.1: a stop that leaves the page its new_page opened — blocked, the message names the page and close_page', leftOpen.decision === 'block' && /page 2 — http:\/\/localhost:3000\/orders/.test(leftOpen.text) && /close_page/.test(leftOpen.text), leftOpen.text)
    check('frames-guard AC-5b.1: the page closed with close_page — passes', guard([...OPENED, [call(`${MCP}close_page`, { pageId: 2 }, 'c1')], [answer('c1', pageList('1: about:blank [selected]'))]]).decision === 'allow')
    const ONLY = [
      ...DOC,
      [call(`${MCP}new_page`, { url: 'http://localhost:3000/' }, 'n1')],
      [answer('n1', pageList('2: http://localhost:3000/ [selected]'))],
      [call(`${MCP}close_page`, { pageId: 2 }, 'c1')],
      [answer('c1', `The last open page cannot be closed. It is fine to keep it open.\n${pageList('2: http://localhost:3000/ [selected]')}`)],
    ]
    const refusedOnly = guard(ONLY)
    check('frames-guard AC-5b.1: the last page refused by close_page and left on the app — blocked, the message says about:blank', refusedOnly.decision === 'block' && /about:blank/.test(refusedOnly.text), refusedOnly.text)
    check('frames-guard AC-5b.1: the last page refused by close_page, then navigated to about:blank — passes', guard([...ONLY, [call(`${MCP}navigate_page`, { type: 'url', url: 'about:blank' }, 'v1')], [answer('v1', `Successfully navigated to about:blank.\n${pageList('2: about:blank [selected]')}`)]]).decision === 'allow')
    const LOGIN = 'Login (http://localhost:3000/login)'
    check(
      'frames-guard AC-5b.1: the orchestrator\'s login page stays open, the agent closed its own — passes',
      guard([...DOC, [call(`${MCP}list_pages`, {}, 'l1')], [answer('l1', pageList(`1: ${LOGIN} [selected]`))], [call(`${MCP}new_page`, { url: 'http://localhost:3000/orders' }, 'n1')], [answer('n1', pageList(`1: ${LOGIN}`, '3: Orders (http://localhost:3000/orders) [selected]'))], [call(`${MCP}close_page`, { pageId: 3 }, 'c1')], [answer('c1', pageList(`1: ${LOGIN} [selected]`))]]).decision === 'allow',
    )
    const timedOut = guard([...DOC, [call(`${MCP}new_page`, { url: 'http://localhost:3000/orders' }, 'n1')], [answer('n1', 'Navigation timeout of 10000 ms exceeded', { is_error: true })], [call(`${MCP}list_pages`, {}, 'l1')], [answer('l1', pageList('1: about:blank', '2: http://localhost:3000/orders [selected]'))]])
    check('frames-guard AC-5b.1 (B8 a): a new_page that answered with an error may have made a tab — the guard does not attribute it, no URL match — passes, no page named', timedOut.decision === 'allow' && !/opened by your new_page/.test(timedOut.text) && !/page \d+ —/.test(timedOut.text), timedOut.text)
    check('frames-guard: a "## Pages" text in a Bash output is not a page list', guard([...DOC, [call('Bash', { command: 'cat notes.md' }, 'b1')], [answer('b1', pageList('2: http://localhost:3000/ [selected]'))]]).decision === 'allow')
    // m-1: the orchestrator's page 1 and the agent's page 2 on the same URL; the agent's new_page timed out; its tab is not attributed (B8 a), so closing page 2 passes and nothing is named
    const HOME = 'Home (http://localhost:3000/)'
    const SAME_URL = [...DOC, [call(`${MCP}new_page`, { url: 'http://localhost:3000/' }, 'n1')], [answer('n1', 'Navigation timeout of 10000 ms exceeded', { is_error: true })], [call(`${MCP}list_pages`, {}, 'l1')], [answer('l1', pageList(`1: ${HOME}`, `2: ${HOME} [selected]`))]]
    const sameUrlClosed = guard([...SAME_URL, [call(`${MCP}close_page`, { pageId: 2 }, 'c1')], [answer('c1', pageList(`1: ${HOME} [selected]`))]])
    check('frames-guard m-1: the orchestrator\'s page and the agent\'s timed-out new_page on the same URL, the agent closes its page 2 — passes', sameUrlClosed.decision === 'allow', sameUrlClosed.text)
    // m-1 (final check, run 4): the agent's tab closed itself on load; MCP 1.6.0 answers new_page with a note and re-selects page 1, the orchestrator's login page
    const FALLBACK = `Note: the previously selected page was closed. Page 1 is now selected.\n${pageList(`1: ${LOGIN} [selected]`)}`
    const closedSelf = guard([...DOC, [call(`${MCP}list_pages`, {}, 'l1')], [answer('l1', pageList(`1: ${LOGIN} [selected]`))], [call(`${MCP}new_page`, { url: 'http://localhost:3000/bye' }, 'n1')], [answer('n1', FALLBACK)]])
    check('frames-guard m-1 incident (run 4): new_page whose tab closed itself, answer re-selects the orchestrator\'s page 1 under the fallback note — passes, page 1 not attributed', closedSelf.decision === 'allow' && !/opened by your new_page/.test(closedSelf.text), closedSelf.text)
    const closedSelfErrored = guard([...DOC, [call(`${MCP}new_page`, { url: 'http://localhost:3000/login' }, 'n1')], [answer('n1', 'Error: Navigating frame was detached', { is_error: true })], [call(`${MCP}list_pages`, {}, 'l1')], [answer('l1', FALLBACK)]])
    check('frames-guard m-1 incident (run 4, final check 2): an errored new_page whose tab closed itself, then list_pages answers with the fallback note and the orchestrator\'s page 1 at the same URL — passes, page 1 not attributed', closedSelfErrored.decision === 'allow' && !/opened by your new_page/.test(closedSelfErrored.text), closedSelfErrored.text)
    const closedSelfFirst = guard([...DOC, [call(`${MCP}new_page`, { url: 'http://localhost:3000/login' }, 'n1')], [answer('n1', FALLBACK)]])
    check('frames-guard m-2 (final check 2): new_page as the first page call, its successful answer carries the fallback note and re-selects page 1 — passes, page 1 not attributed', closedSelfFirst.decision === 'allow' && !/opened by your new_page/.test(closedSelfFirst.text), closedSelfFirst.text)
    const normalNew = guard([...DOC, [call(`${MCP}list_pages`, {}, 'l1')], [answer('l1', pageList(`1: ${LOGIN} [selected]`))], [call(`${MCP}new_page`, { url: 'http://localhost:3000/orders' }, 'n1')], [answer('n1', pageList(`1: ${LOGIN}`, '2: Orders (http://localhost:3000/orders) [selected]'))]])
    check('frames-guard m-1 legit twin (run 4): list_pages, then a normal new_page creating page 2 left open — blocked, names page 2', normalNew.decision === 'block' && /page 2 —/.test(normalNew.text) && !/page 1 —/.test(normalNew.text), normalNew.text)
    // m-1 (branch 7): a successful new_page's own fallback note must not make the guard name the tab of an earlier errored new_page that stays open (B8 a: an errored new_page's tab is never attributed)
    const SLOW = 'Slow (http://localhost:3000/slow)'
    const own = guard([...DOC, [call(`${MCP}new_page`, { url: 'http://localhost:3000/slow' }, 'n1')], [answer('n1', 'Navigation timeout of 10000 ms exceeded', { is_error: true })], [call(`${MCP}new_page`, { url: 'http://localhost:3000/bye' }, 'n2')], [answer('n2', `Note: the previously selected page was closed. Page 1 is now selected.\n${pageList(`1: ${LOGIN} [selected]`, `2: ${SLOW}`)}`)]])
    check('frames-guard m-1 incident (branch 7, B8 a): errored new_page /slow leaves tab 2, a successful new_page /bye closes itself — the errored tab is not attributed — passes, no page named', own.decision === 'allow' && !/opened by your new_page/.test(own.text) && !/page \d+ —/.test(own.text), own.text)
    // m-2 (branch 7): two errored new_page at the orchestrator's URL, then a list with the note: page 1 is the orchestrator's
    const detached = [call(`${MCP}new_page`, { url: 'http://localhost:3000/login' }, 'n1')]
    const retried = guard([...DOC, detached, [answer('n1', 'Error: Navigating frame was detached', { is_error: true })], [call(`${MCP}new_page`, { url: 'http://localhost:3000/login' }, 'n2')], [answer('n2', 'Error: Navigating frame was detached', { is_error: true })], [call(`${MCP}list_pages`, {}, 'l1')], [answer('l1', FALLBACK)]])
    check('frames-guard m-2 incident (branch 7): a retried errored new_page at the login URL, then a list with the note — passes, page 1 not attributed', retried.decision === 'allow' && !/opened by your new_page/.test(retried.text), retried.text)
    const R2 = [...DOC, [call(`${MCP}list_pages`, {}, 'l1')], [answer('l1', pageList(`1: ${LOGIN} [selected]`))], detached, [answer('n1', 'Error: Navigating frame was detached', { is_error: true })], [call(`${MCP}new_page`, { url: 'http://localhost:3000/orders' }, 'n2')], [answer('n2', pageList(`1: ${LOGIN}`, '3: Orders (http://localhost:3000/orders) [selected]'))]]
    const r2Closed = guard([...R2, [call(`${MCP}close_page`, { pageId: 3 }, 'c1')], [answer('c1', `Note: the previously selected page was closed. Page 1 is now selected.\n${pageList(`1: ${LOGIN} [selected]`)}`)]])
    check('frames-guard m-2 legit (branch 7): list_pages first, an errored new_page, a new_page creating page 3, close_page 3 — passes', r2Closed.decision === 'allow', r2Closed.text)
    const r2Open = guard(R2)
    check('frames-guard m-2 incident twin (branch 7): the same with page 3 left open — blocked, names page 3 only', r2Open.decision === 'block' && /page 3 —/.test(r2Open.text) && !/page 1 —/.test(r2Open.text), r2Open.text)
    // m-1 (branch 8): resize_page answers with the full `## Pages` list too — the only list after a timed-out new_page (tab 2 stays open)
    const W2 = [...DOC, [call(`${MCP}list_pages`, {}, 'l1')], [answer('l1', pageList(`1: ${LOGIN} [selected]`))], [call(`${MCP}new_page`, { url: 'http://localhost:3000/orders' }, 'n1')], [answer('n1', 'Navigation timeout of 10000 ms exceeded', { is_error: true })], [call(`${MCP}resize_page`, { width: 1440, height: 900 }, 'r1')], [answer('r1', pageList(`1: ${LOGIN}`, '2: Orders (http://localhost:3000/orders) [selected]'))]]
    const w2 = guard(W2)
    check('frames-guard m-1 incident (branch 8, B8 a): a timed-out new_page, then resize_page lists its tab 2 — an errored new_page\'s tab is not attributed — passes, no page named', w2.decision === 'allow' && !/opened by your new_page/.test(w2.text) && !/page \d+ —/.test(w2.text), w2.text)
    const w2Closed = guard([...W2, [call(`${MCP}close_page`, { pageId: 2 }, 'c1')], [answer('c1', pageList(`1: ${LOGIN} [selected]`))]])
    check('frames-guard m-1 legit twin (branch 8): the same, then close_page 2 answered by a list without page 2 — passes', w2Closed.decision === 'allow', w2Closed.text)
    const w5NoList = guard([...DOC, [call(`${MCP}new_page`, { url: 'http://localhost:3000/login' }, 'n1')], [answer('n1', 'Error: Navigating frame was detached', { is_error: true })], [call(`${MCP}resize_page`, { width: 1440, height: 900 }, 'r1')], [answer('r1', FALLBACK)], [call(`${MCP}list_pages`, {}, 'l1')], [answer('l1', FALLBACK)]])
    check('frames-guard m-1 legit (branch 8): an errored self-closing new_page with no list first, resize_page takes the fallback note — passes, page 1 not attributed', w5NoList.decision === 'allow' && !/opened by your new_page/.test(w5NoList.text), w5NoList.text)
    // m-1 (branch 9): an errored new_page's tab is not attributed whatever its URL (`about:blank` before the server answered, an auth redirect): allow, no page named
    const ORD = 'http://localhost:3000/orders'
    const U1 = [...DOC, [call(`${MCP}list_pages`, {}, 'l1')], [answer('l1', pageList(`1: ${LOGIN} [selected]`))], [call(`${MCP}new_page`, { url: ORD }, 'n1')], [answer('n1', 'Navigation timeout of 10000 ms exceeded', { is_error: true })], [call(`${MCP}resize_page`, { width: 1440, height: 900 }, 'r1')], [answer('r1', pageList(`1: ${LOGIN}`, '2: about:blank [selected]'))], [call(`${MCP}list_pages`, {}, 'l2')], [answer('l2', pageList(`1: ${LOGIN}`, `2: Orders (${ORD}) [selected]`))]]
    const u1 = guard(U1)
    check('frames-guard m-1 incident (branch 9, B8 a): a timed-out new_page, resize_page lists its tab at about:blank, later at its URL — an errored new_page\'s tab is not attributed — passes, no page named', u1.decision === 'allow' && !/opened by your new_page/.test(u1.text) && !/page \d+ —/.test(u1.text), u1.text)
    const u1Closed = guard([...U1, [call(`${MCP}close_page`, { pageId: 2 }, 'c1')], [answer('c1', pageList(`1: ${LOGIN} [selected]`))]])
    check('frames-guard m-1 legit twin (branch 9): the same, then close_page 2 answered by a list without page 2 — passes', u1Closed.decision === 'allow', u1Closed.text)
    const u2 = guard([...DOC, [call(`${MCP}list_pages`, {}, 'l1')], [answer('l1', pageList(`1: ${LOGIN} [selected]`))], [call(`${MCP}new_page`, { url: ORD }, 'n1')], [answer('n1', 'Navigation timeout of 10000 ms exceeded', { is_error: true })], [call(`${MCP}list_pages`, {}, 'l2')], [answer('l2', pageList(`1: ${LOGIN}`, '2: Login (http://localhost:3000/login?next=%2Forders) [selected]'))], [call(`${MCP}list_pages`, {}, 'l3')], [answer('l3', pageList(`1: ${LOGIN}`, '2: Login (http://localhost:3000/login?next=%2Forders) [selected]'))]])
    check('frames-guard m-1 incident (branch 9, B8 a): the load hung after an auth redirect, tab 2 at /login?next=… in every list — an errored new_page\'s tab is not attributed — passes, no page named', u2.decision === 'allow' && !/opened by your new_page/.test(u2.text) && !/page \d+ —/.test(u2.text), u2.text)
    const u4 = guard([...DOC, [call(`${MCP}new_page`, { url: 'http://localhost:3000/login' }, 'n1')], [answer('n1', 'Navigation timeout of 10000 ms exceeded', { is_error: true })], [call(`${MCP}resize_page`, { width: 1440, height: 900 }, 'r1')], [answer('r1', pageList(`1: ${LOGIN}`, '2: about:blank [selected]'))], [call(`${MCP}close_page`, { pageId: 2 }, 'c1')], [answer('c1', pageList(`1: ${LOGIN} [selected]`))]])
    check('frames-guard m-1 legit (branch 9): no list first, a timed-out new_page at the orchestrator\'s URL, its tab 2 at about:blank, the agent closes it — passes, page 1 not named', u4.decision === 'allow' && !/page 1 —/.test(u4.text), u4.text)
    // errored new_page /a, then a successful new_page /b (its fresh selected page 3): the errored /a's tab 2 is never attributed, listed or not; only page 3, the successful new_page's fresh selected page, is the checker's
    const MIX = [...DOC, [call(`${MCP}list_pages`, {}, 'l1')], [answer('l1', pageList(`1: ${LOGIN} [selected]`))], [call(`${MCP}new_page`, { url: 'http://localhost:3000/a' }, 'n1')], [answer('n1', 'Navigation timeout of 10000 ms exceeded', { is_error: true })], [call(`${MCP}new_page`, { url: 'http://localhost:3000/b' }, 'n2')], [answer('n2', pageList(`1: ${LOGIN}`, '3: B (http://localhost:3000/b) [selected]'))]]
    const mixClosed = guard([...MIX, [call(`${MCP}close_page`, { pageId: 3 }, 'c1')], [answer('c1', pageList(`1: ${LOGIN} [selected]`))]])
    check('frames-guard m-1 legit (branch 9): errored new_page /a, a new_page /b creating page 3 is closed — passes, the errored /a is not attributed to page 3', mixClosed.decision === 'allow', mixClosed.text)
    const mixListed = guard([...MIX, [call(`${MCP}list_pages`, {}, 'l2')], [answer('l2', pageList(`1: ${LOGIN}`, '2: A (http://localhost:3000/a)', '3: B (http://localhost:3000/b) [selected]'))], [call(`${MCP}close_page`, { pageId: 3 }, 'c1')], [answer('c1', pageList(`1: ${LOGIN} [selected]`, '2: A (http://localhost:3000/a)'))]])
    check('frames-guard m-1 incident (branch 9, B8 a): errored /a then a successful /b closed; tab 2 at /a is listed later and left open — an errored new_page\'s tab is not attributed — passes, no page named', mixListed.decision === 'allow' && !/opened by your new_page/.test(mixListed.text) && !/page \d+ —/.test(mixListed.text), mixListed.text)
    // m-1 / m-2 (branch 10): the tab rule is for a call made since the last list, never the orchestrator's page; a retried errored new_page before any list attributes no tab (B8 a)
    const SETT = 'Settings (http://localhost:3000/settings)'
    const NEXT = 'Login (http://localhost:3000/login?next=%2Forders)'
    const TIMEOUT_ORD = [[call(`${MCP}new_page`, { url: ORD }, 'n1')], [answer('n1', 'Navigation timeout of 10000 ms exceeded', { is_error: true })]]
    const LIST_L1 = [[call(`${MCP}list_pages`, {}, 'l1')], [answer('l1', pageList(`1: ${LOGIN} [selected]`))]]
    const resizeAnswer = (...lines) => [[call(`${MCP}resize_page`, { width: 1440, height: 900 }, 'r1')], [answer('r1', pageList(...lines))]]
    const closeAnswer = (id, text) => [[call(`${MCP}close_page`, { pageId: id }, 'c1')], [answer('c1', text)]]
    const ra = [...DOC, ...LIST_L1, ...TIMEOUT_ORD, ...resizeAnswer(`1: ${LOGIN}`, `2: Orders (${ORD})`, `3: ${SETT} [selected]`)]
    const raRun = guard(ra)
    check('frames-guard m-1 incident (branch 10, B8 a): errored new_page, another agent opens /settings, one list shows both — nothing attributed — passes, no page named', raRun.decision === 'allow' && !/opened by your new_page/.test(raRun.text) && !/page \d+ —/.test(raRun.text), raRun.text)
    const raTwin = guard([...ra, ...closeAnswer(2, pageList(`1: ${LOGIN}`, `3: ${SETT} [selected]`))])
    check('frames-guard m-1 legit twin (branch 10): the same, the agent closes its page 2, the other agent\'s page 3 stays — passes, page 3 not named', raTwin.decision === 'allow' && !/page 3 —/.test(raTwin.text), raTwin.text)
    const rb2 = guard([...DOC, ...LIST_L1, [call(`${MCP}new_page`, { url: 'http://localhost:3000/bye' }, 'n0')], [answer('n0', 'Error: Navigating frame was detached', { is_error: true })], [call(`${MCP}new_page`, { url: ORD }, 'n1')], [answer('n1', pageList(`1: ${LOGIN}`, `3: Orders (${ORD}) [selected]`))], ...resizeAnswer(`1: ${LOGIN}`, `3: Orders (${ORD})`, `4: ${SETT} [selected]`), ...closeAnswer(3, pageList(`1: ${LOGIN}`, `4: ${SETT} [selected]`))])
    check('frames-guard m-1 legit (branch 10): an errored new_page /bye, then a good new_page (page 3) closed, another agent opened page 4 — passes, page 4 not named', rb2.decision === 'allow' && !/page 4 —/.test(rb2.text), rb2.text)
    const rc = guard([...DOC, [call(`${MCP}new_page`, { url: ORD, waitUntil: 'networkidle0' }, 'n0')], [answer('n0', 'Unknown arguments for tool "new_page": waitUntil. Known arguments: url, background, isolatedContext, timeout', { is_error: true })], ...LIST_L1, [call(`${MCP}new_page`, { url: ORD }, 'n1')], [answer('n1', pageList(`1: ${LOGIN}`, `2: Orders (${ORD}) [selected]`))], ...closeAnswer(2, FALLBACK)])
    check('frames-guard m-1 legit (branch 10): no list first, a refused new_page (no tab), list_pages shows the orchestrator\'s page 1 selected, a good new_page closed — passes, page 1 not named', rc.decision === 'allow' && !/page 1 —/.test(rc.text), rc.text)
    const t3Pages = [`1: ${LOGIN}`, '2: about:blank', '3: about:blank [selected]']
    const t3 = [...DOC, ...TIMEOUT_ORD, [call(`${MCP}new_page`, { url: ORD }, 'n2')], [answer('n2', 'Navigation timeout of 10000 ms exceeded', { is_error: true })], ...resizeAnswer(...t3Pages)]
    const t3Run = guard([...t3, [call(`${MCP}list_pages`, {}, 'l2')], [answer('l2', pageList(`1: ${LOGIN}`, `2: Orders (${ORD})`, `3: Orders (${ORD}) [selected]`))], ...closeAnswer(3, `Note: the previously selected page was closed. Page 1 is now selected.\n${pageList(`1: ${LOGIN} [selected]`, `2: Orders (${ORD})`)}`)])
    check('frames-guard m-2 incident (branch 10, B8 a): two timed-out new_pages, both tabs at about:blank, the agent closes only page 3 — errored tabs are not attributed — passes, no page named', t3Run.decision === 'allow' && !/opened by your new_page/.test(t3Run.text) && !/page \d+ —/.test(t3Run.text), t3Run.text)
    const t2r = [...DOC, ...LIST_L1, ...TIMEOUT_ORD, [call(`${MCP}new_page`, { url: ORD }, 'n2')], [answer('n2', pageList(`1: ${LOGIN}`, `2: ${NEXT}`, `3: ${NEXT} [selected]`))], ...closeAnswer(3, `Note: the previously selected page was closed. Page 1 is now selected.\n${pageList(`1: ${LOGIN} [selected]`, `2: ${NEXT}`)}`)]
    const t2rRun = guard(t2r)
    check('frames-guard m-2 incident (branch 10, B8 a): a timed-out new_page, the retry redirects the same way, page 3 closed — the errored tab 2 is not attributed — passes, no page named', t2rRun.decision === 'allow' && !/opened by your new_page/.test(t2rRun.text) && !/page \d+ —/.test(t2rRun.text), t2rRun.text)
    // pro-review branch 11 (m-1, m-2) and B8 (a): the guard names only a page a successful new_page returned. Where the old matching named a page the checker never opened
    // (the orchestrator's login in the force layout, a second agent's tab), the answer is now `passes`, and no page is named.
    const FORCE_LOGIN = 'Login (http://localhost:3000/login)'
    const noPageNamed = (run) => run.decision === 'allow' && !/opened by your new_page/.test(run.text) && !/page \d+ —/.test(run.text)
    // force layout: page 1 is about:blank, the orchestrator's login is page 2
    const Y1 = guard([...DOC, [call(`${MCP}list_pages`, {}, 'l1')], [answer('l1', pageList('1: about:blank', `2: ${FORCE_LOGIN} [selected]`))], [call(`${MCP}new_page`, { url: 'http://localhost:3000/login' }, 'n1')], [answer('n1', 'Navigation timeout of 10000 ms exceeded', { is_error: true })], [call(`${MCP}list_pages`, {}, 'l2')], [answer('l2', pageList('1: about:blank', `2: ${FORCE_LOGIN} [selected]`))]])
    check('frames-guard pro-review branch 11 Y1 (B8 a): force layout, an errored new_page at the login URL, the orchestrator\'s login is page 2 — passes, the foreign page 2 is not named', noPageNamed(Y1), Y1.text)
    const X1 = guard([...DOC, [call(`${MCP}new_page`, { url: 'http://localhost:3000/login' }, 'n1')], [answer('n1', 'Navigation timeout of 10000 ms exceeded', { is_error: true })], [call(`${MCP}list_pages`, {}, 'l1')], [answer('l1', pageList('1: about:blank', `2: ${FORCE_LOGIN} [selected]`))]])
    check('frames-guard pro-review branch 11 X1 (B8 a): force layout, an errored new_page as the first call, the first list shows the orchestrator\'s login as fresh page 2 — passes, page 2 not named', noPageNamed(X1), X1.text)
    const X1b = guard([...DOC, [call(`${MCP}new_page`, { url: 'http://localhost:3000/orders' }, 'n1')], [answer('n1', 'Error: Navigating frame was detached', { is_error: true })], [call(`${MCP}resize_page`, { width: 1440, height: 900 }, 'r1')], [answer('r1', pageList('1: about:blank', `2: ${FORCE_LOGIN} [selected]`))]])
    check('frames-guard pro-review branch 11 X1b (B8 a): force layout, an errored new_page at another URL, resize_page lists the orchestrator\'s login as fresh page 2 — passes, page 2 not named', noPageNamed(X1b), X1b.text)
    // a second agent's page appears in the same session
    const X2 = guard([...DOC, ...LIST_L1, ...TIMEOUT_ORD, [call(`${MCP}list_pages`, {}, 'l2')], [answer('l2', pageList(`1: ${LOGIN}`, `2: ${SETT} [selected]`))]])
    check('frames-guard pro-review branch 11 X2 (B8 a): an errored new_page, a second agent\'s /settings appears as the fresh selected page 2 — passes, page 2 not named', noPageNamed(X2), X2.text)
    const X2b = guard([...DOC, ...LIST_L1, ...TIMEOUT_ORD, ...resizeAnswer(`1: ${LOGIN}`, `2: ${SETT} [selected]`)])
    check('frames-guard pro-review branch 11 X2b (B8 a): the same through resize_page — passes, page 2 not named', noPageNamed(X2b), X2b.text)
    const X3 = guard([...DOC, ...LIST_L1, ...TIMEOUT_ORD, ...resizeAnswer(`1: ${LOGIN}`, `2: ${SETT}`, `3: about:blank [selected]`)])
    check('frames-guard pro-review branch 11 X3 (B8 a): an errored new_page, a second agent\'s two new tabs (one at about:blank) are listed — passes, no page named', noPageNamed(X3), X3.text)
    const Y2 = guard([...DOC, ...TIMEOUT_ORD, [call(`${MCP}new_page`, { url: ORD }, 'n2')], [answer('n2', 'Navigation timeout of 10000 ms exceeded', { is_error: true })], ...resizeAnswer('1: about:blank', `2: ${NEXT} [selected]`)])
    check('frames-guard pro-review branch 11 Y2 (B8 a): no list first, two errored new_pages (a retry), then a list with one fresh tab at the redirected URL — passes, page 2 not named', noPageNamed(Y2), Y2.text)
    // the successful new_page stays attributed even beside an errored one
    const SUCCESS_BESIDE = guard([...DOC, ...LIST_L1, ...TIMEOUT_ORD, [call(`${MCP}new_page`, { url: ORD }, 'n2')], [answer('n2', pageList(`1: ${LOGIN}`, `2: ${NEXT}`, `3: Orders (${ORD}) [selected]`))]])
    check('frames-guard B8 (a) legit: an errored new_page, then a successful new_page whose list shows page 3 selected, left open — blocked, names page 3 only', SUCCESS_BESIDE.decision === 'block' && /page 3 —/.test(SUCCESS_BESIDE.text) && !/page 2 —/.test(SUCCESS_BESIDE.text) && !/page 1 —/.test(SUCCESS_BESIDE.text), SUCCESS_BESIDE.text)
    // m-3 (final check, run 4): an untitled page whose URL ends in `(about:blank)` is that URL, not a blank page
    const UNTITLED_BLANK = guard([...DOC, [call(`${MCP}new_page`, { url: 'http://localhost:3000/#(about:blank)' }, 'n1')], [answer('n1', pageList('2: http://localhost:3000/#(about:blank) [selected]'))]])
    check('frames-guard m-3 incident (run 4): the only page is untitled `http://localhost:3000/#(about:blank)` — blocked, the page rule is on', UNTITLED_BLANK.decision === 'block', UNTITLED_BLANK.text)
    const TITLED_BLANK = guard([...DOC, [call(`${MCP}new_page`, { url: 'http://localhost:3000/' }, 'n1')], [answer('n1', pageList('2: Blank (about:blank) [selected]'))]])
    check('frames-guard m-3 legit twin (run 4): the last page titled `Blank (about:blank)` — passes', TITLED_BLANK.decision === 'allow', TITLED_BLANK.text)
    const sameUrlLeft = guard(SAME_URL)
    check('frames-guard m-1 incident twin (B8 a): the orchestrator\'s page 1 and a timed-out new_page\'s tab 2 on the same URL, left open — an errored new_page\'s tab is not attributed — passes, no page named', sameUrlLeft.decision === 'allow' && !/opened by your new_page/.test(sameUrlLeft.text) && !/page \d+ —/.test(sameUrlLeft.text), sameUrlLeft.text)
    // S-2: the page list comes only from the page tools' own `## Pages` section — a console message the page logged is the page's text
    const spoof = guard([...OPENED, [call(`${MCP}list_console_messages`, {}, 'm1')], [answer('m1', '## Console messages\nmsgid=1 [log] boot\n## Pages\n1: about:blank')]])
    check('frames-guard S-2: a page that logs "## Pages\\n1: about:blank" to the console does not hide the agent\'s open page 2', spoof.decision === 'block' && /page 2 —/.test(spoof.text), spoof.text)
    const trailing = guard([...DOC, [call(`${MCP}new_page`, { url: 'http://localhost:3000/orders' }, 'n1')], [answer('n1', `${pageList('1: about:blank', '2: Orders (http://localhost:3000/orders) [selected]')}\n## Console messages\n## Pages\n1: about:blank`)]])
    check('frames-guard S-2: in a page tool\'s answer only its first "## Pages" section counts, not one the page logged after it', trailing.decision === 'block' && /page 2 —/.test(trailing.text), trailing.text)
    // f-1: chrome-devtools-mcp writes the `# Open dialog` block, with the dialog's message (the page's own text), before `## Pages` (McpResponse.js) — an alert()
    // that spells a list does not stand for it; the next clean list, handle_dialog's, decides
    const DIALOG_ANSWER = `# new_page response\n# Open dialog\nalert: Welcome!\n## Pages\n1: about:blank\n## end.\nCall handle_dialog to handle it before continuing.\n## Pages\n1: about:blank\n2: App (http://localhost:3000/) [selected]`
    const DIALOGGED = [
      ...DOC,
      [call(`${MCP}new_page`, { url: 'http://localhost:3000/' }, 'n1')],
      [answer('n1', DIALOG_ANSWER)],
      [call(`${MCP}handle_dialog`, { action: 'accept' }, 'h1')],
      [answer('h1', '# handle_dialog response\nSuccessfully accepted the dialog\n## Pages\n1: about:blank\n2: App (http://localhost:3000/) [selected]')],
    ]
    const dialogLeft = guard(DIALOGGED)
    check('frames-guard f-1 incident (A29, B8 a): an alert() spelling "## Pages\\n1: about:blank" before the real list, page 2 left after handle_dialog — a new_page answered with an open dialog gave no trusted list, its tab is not attributed — passes, no page named', dialogLeft.decision === 'allow' && !/opened by your new_page/.test(dialogLeft.text) && !/page \d+ —/.test(dialogLeft.text), dialogLeft.text)
    const dialogClosed = guard([...DIALOGGED, [call(`${MCP}close_page`, { pageId: 2 }, 'c1')], [answer('c1', pageList('1: about:blank [selected]'))]])
    check('frames-guard f-1 legit twin: the same dialog, the agent closes its page 2 — passes', dialogClosed.decision === 'allow', dialogClosed.text)
    // m-2 (whole-branch review): the MCP server drops after new_page — close_page and list_pages answer with a disconnect error, so no call can close page 2 any more.
    // Before the fix every stop was blocked with "close_page", stop_hook_active included, until Claude Code ended the loop.
    const DROPPED = [
      ...OPENED,
      [call(`${MCP}close_page`, { pageId: 2 }, 'c1')],
      [answer('c1', 'MCP error -32000: Connection closed', { is_error: true })],
      [call(`${MCP}list_pages`, {}, 'l1')],
      [answer('l1', 'Error: MCP server "plugin:stage-pipeline:chrome-devtools" is not connected', { is_error: true })],
    ]
    const dropped = guard(DROPPED)
    check('frames-guard m-2 incident: the server dropped after new_page (close_page and list_pages answer "Connection closed" / "not connected") — the page rule is skipped, the stop passes', dropped.decision === 'allow', dropped.text)
    // the live-server twins: the same page left open while the server still answers — every one blocks on page 2
    const LIVE_TWINS = [
      ['a close_page error that is not a disconnect', [...OPENED, [call(`${MCP}close_page`, { pageId: 99 }, 'c1')], [answer('c1', 'No page found with id 99', { is_error: true })]]],
      ['a disconnect, then the server is back and its list still shows page 2', [...DROPPED, [call(`${MCP}list_pages`, {}, 'l2')], [answer('l2', pageList('1: about:blank', '2: Orders (http://localhost:3000/orders) [selected]'))]]],
      ['"not connected" in an error of a tool that is not a page tool', [...OPENED, [call(`${MCP}evaluate_script`, { function: '() => 1' }, 'e1')], [answer('e1', 'Error: socket not connected', { is_error: true })]]],
      ['"not connected" in a page tool\'s answer that is not an error (a dialog\'s text)', [...OPENED, [call(`${MCP}navigate_page`, { type: 'reload' }, 'v1')], [answer('v1', '# navigate_page response\n# Open dialog\nalert: MCP error -32000: Connection closed, not connected\nCall handle_dialog to handle it before continuing.')]]],
      ['a disconnect of another MCP server than the one whose list holds page 2', [...OPENED, [call('mcp__stage-pipeline-chrome__list_pages', {}, 'o1')], [answer('o1', 'Error: MCP server "stage-pipeline-chrome" is not connected', { is_error: true })]]],
      // m-4 (whole-branch review, run 4): MCP 1.6.0 writes the page's open dialog into a page tool's error answer, and a failed new_page's error repeats its URL —
      // the page's or the agent's words, not the transport's, so they never switch the page rule off
      [
        'an error answer of navigate_page that carries the app\'s alert "Not connected to the server" (m-4)',
        [...OPENED, [call(`${MCP}navigate_page`, {}, 'v2')], [answer('v2', '# navigate_page response\n# Open dialog\nalert: Not connected to the server. Retrying….\nCall handle_dialog to handle it before continuing.\nError: Either URL or a type is required.', { is_error: true })]],
      ],
      [
        'a failed new_page whose URL holds "-32000" (m-4)',
        [...OPENED, [call(`${MCP}new_page`, { url: 'http://localhost:3000/payments?amount=-32000' }, 'n2')], [answer('n2', 'Error: net::ERR_CONNECTION_REFUSED at http://localhost:3000/payments?amount=-32000', { is_error: true })]],
      ],
    ]
    const liveLeft = LIVE_TWINS.map(([name, events]) => [name, guard(events)]).filter(([, run]) => !(run.decision === 'block' && /page 2 — http:\/\/localhost:3000\/orders/.test(run.text)))
    check(
      'frames-guard m-2/m-4 live-server twins: page 2 left open while its server still answers — blocked (a non-disconnect error, a reconnect, another tool\'s or server\'s error, a dialog\'s text, a dialog or a URL in an error answer)',
      !liveLeft.length,
      JSON.stringify(liveLeft.map(([name, run]) => [name, run.decision, run.text.slice(0, 120)])),
    )
    const spaces = ' '.repeat(100_000)
    const timed = (events) => {
      const startedAt = performance.now()
      const result = guard(events)
      return { ...result, ms: performance.now() - startedAt }
    }
    const consoleFlood = timed([...OPENED, ...[1, 2, 3].flatMap((n) => [[call(`${MCP}list_console_messages`, {}, `f${n}`)], [answer(`f${n}`, `## Console messages\n## Pages\n1: ${spaces}x`)]])])
    check(`frames-guard S-2: three console results with a 100 000-space "## Pages" line — the hook runs in ${Math.round(consoleFlood.ms)} ms (< 2 000; 14 s before), still blocks on page 2`, consoleFlood.ms < 2000 && consoleFlood.decision === 'block', `${consoleFlood.ms} ms ${consoleFlood.text}`)
    const pageFlood = timed([...OPENED, [call(`${MCP}list_pages`, {}, 'l9')], [answer('l9', pageList('1: about:blank', `2: Orders (http://localhost:3000/orders) [selected]${' '.repeat(1_000_000)}x`, `3: T${spaces} (http://x/) [selected] isolatedContext=a`))]])
    check(`frames-guard S-2: a page tool's list with a 1 MB whitespace run in a line — parsed in linear time, the hook runs in ${Math.round(pageFlood.ms)} ms (< 2 000)`, pageFlood.ms < 2000, `${pageFlood.ms} ms`)

    const fakeBrowser = (name) => fakeChrome(temp(name).args)
    const journeyBrowser = fakeBrowser('journey')
    await pause(200)
    const JOURNEY_RAN = (pid) => [...DOC, [call('Bash', { command: 'node /scratch/journey.mjs' }, 'j1')], [answer('j1', `journey: browser pid ${pid}\nError: step 3 failed midway`)]]
    const running = guard(JOURNEY_RAN(journeyBrowser.pid))
    check(
      'frames-guard AC-5b.1: the browser a journey launched still runs at the stop — blocked, the message names its PID, the executable and kill, not the command line',
      running.decision === 'block' && new RegExp(`pid ${journeyBrowser.pid} — a browser you launched \\(Google Chrome\\), still running`).test(running.text) && /kill <pid>/.test(running.text) && !/user-data-dir|setInterval/.test(running.text),
      running.text,
    )
    journeyBrowser.kill('SIGKILL')
    await goneWithin(journeyBrowser.pid)
    check('frames-guard AC-5b.1: that browser stopped — passes', guard(JOURNEY_RAN(journeyBrowser.pid)).decision === 'allow')
    const bashChrome = fakeBrowser('bash')
    await pause(200)
    const echoed = guard([...DOC, [call('Bash', { command: '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --user-data-dir=/tmp/x > /tmp/chrome.log 2>&1 & echo $!' }, 'b1')], [answer('b1', String(bashChrome.pid))]])
    check('frames-guard AC-5b.1: a Chrome started from Bash with `& echo $!` and still running — blocked', echoed.decision === 'block' && new RegExp(`pid ${bashChrome.pid}`).test(echoed.text), echoed.text)
    const devServer = spawn(process.execPath, [SLEEPER], { stdio: 'ignore' })
    started.add(devServer.pid)
    await pause(200)
    check('frames-guard: a dev server started with `& echo $!` is not a browser — passes', guard([...DOC, [call('Bash', { command: 'yarn dev > /tmp/dev.log 2>&1 & echo $!' }, 'b2')], [answer('b2', String(devServer.pid))]]).decision === 'allow')
    // m-1 (whole-branch review): one list of browser names, browser-cleanup's, for the process table and for the backgrounded command's first word. frames-guard had
    // a list of its own that missed the Linux launchers: `google-chrome … & echo $!` left running did not block the stop.
    const NAMES = [
      ['google-chrome', true], ['/usr/bin/google-chrome-stable', true], ['chromium-browser', true], ['microsoft-edge', true], ['/usr/bin/microsoft-edge-beta', true],
      ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', true], ['chrome-headless-shell', true], ['msedge.exe', true],
      ['chromedriver', false], ['google-chrome-sync', false], ['chrome-devtools-mcp', false], ['node', false], ['yarn', false],
    ]
    const wrongName = NAMES.filter(([name, want]) => bc.isBrowserName(name) !== want)
    check('browser-cleanup m-1: isBrowserName knows the Linux launchers (google-chrome, -stable, chromium-browser, microsoft-edge) and the macOS app, not chromedriver or the MCP server', !wrongName.length && bc.isBrowserLike('/usr/bin/google-chrome --headless=new --user-data-dir=/tmp/x'), JSON.stringify(wrongName))
    const linuxChrome = spawn(process.execPath, chromeArgv(temp('linux').args), { argv0: join(bRoot, 'google-chrome'), stdio: 'ignore' })
    started.add(linuxChrome.pid)
    await pause(200)
    const LINUX_LAUNCHES = [
      'google-chrome --headless=new --user-data-dir=/tmp/x > /tmp/chrome.log 2>&1 & echo $!',
      '/usr/bin/google-chrome-stable --headless=new > /tmp/chrome.log 2>&1 & echo $!',
      'chromium-browser --headless=new > /tmp/chrome.log 2>&1 & echo $!',
      'nohup microsoft-edge --headless=new > /tmp/edge.log 2>&1 & echo $!',
      'CHROME_LOG=1 /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --headless=new > /tmp/chrome.log 2>&1 & echo $!',
    ]
    const linuxMissed = LINUX_LAUNCHES.map((command) => [command, guard([...DOC, [call('Bash', { command }, 'g1')], [answer('g1', `${linuxChrome.pid}\n`)]])]).filter(([, run]) => !(run.decision === 'block' && new RegExp(`pid ${linuxChrome.pid} — a browser you launched \\(google-chrome\\)`).test(run.text)))
    check('frames-guard m-1 incident: `google-chrome … & echo $!` (and -stable, chromium-browser, nohup microsoft-edge, an escaped macOS path), the browser still running — blocked, names its PID', !linuxMissed.length, JSON.stringify(linuxMissed.map(([command, run]) => [command, run.decision, run.text.slice(0, 160)])))
    // the legit twin: a program that is not a browser or a script runner launches nothing of the agent's, even when the one number it printed is a live browser's
    const NOT_BROWSERS = ['chromedriver --port=9515 > /tmp/driver.log 2>&1 & echo $!', 'tail -f /tmp/google-chrome.log > /tmp/tail.log 2>&1 & echo $!']
    const notBrowserBlocked = NOT_BROWSERS.map((command) => [command, guard([...DOC, [call('Bash', { command }, 'g2')], [answer('g2', `${linuxChrome.pid}\n`)]])]).filter(([, run]) => run.decision !== 'allow')
    check('frames-guard m-1 legit twin: a non-browser launch (`chromedriver`, `tail … google-chrome.log`) with `& echo $!` — passes', !notBrowserBlocked.length, JSON.stringify(notBrowserBlocked.map(([command, run]) => [command, run.text.slice(0, 160)])))
    // m-5 (whole-branch review, run 4): `$!` is the wrapper's PID, the browser it launched runs below it. Reading only the backgrounded command's first word let
    // these stops through with the browser still running; every word counts, a `bash -c "…"` string's too, and a lone `&` starts the next job.
    const LAUNCHER_BG = script('launcher-bg.mjs', [
      "import { spawn } from 'node:child_process'",
      `spawn(process.execPath, ${JSON.stringify(chromeArgv([`--user-data-dir=${join(bRoot, 'launcher-profile')}`, '--headless=new']))}, { argv0: ${JSON.stringify(join(bRoot, 'google-chrome'))}, stdio: 'ignore' })`,
      'setInterval(() => {}, 1000)',
      SELF_EXIT,
    ])
    const launcherBg = spawn(process.execPath, [LAUNCHER_BG], { stdio: 'ignore' })
    started.add(launcherBg.pid)
    await pause(400)
    const launcherChrome = proc.descendants(proc.processTable() ?? new Map(), launcherBg.pid, { depth: 1 })[0]?.pid
    if (launcherChrome) started.add(launcherChrome)
    const WRAPPED = [
      ['timeout 600 node /tmp/journey.mjs > /tmp/j.log 2>&1 & echo $!', launcherBg.pid],
      ['/usr/bin/env node /tmp/journey.mjs > /tmp/j.log 2>&1 & echo $!', launcherBg.pid],
      ['env -i PATH=/usr/bin:/bin node /tmp/journey.mjs > /tmp/j.log 2>&1 & echo $!', launcherBg.pid],
      ['nice -n 10 node /tmp/journey.mjs > /tmp/j.log 2>&1 & echo $!', launcherBg.pid],
      ['caffeinate -i node /tmp/journey.mjs > /tmp/j.log 2>&1 & echo $!', launcherBg.pid],
      ['bash -c "node /tmp/journey.mjs" > /tmp/j.log 2>&1 & echo $!', launcherBg.pid],
      ['yarn dev > /tmp/d.log 2>&1 & chromium --headless=new > /tmp/c.log 2>&1 & echo $!', linuxChrome.pid],
      ['yarn playwright test e2e/login.spec.ts > /tmp/j.log 2>&1 & echo $!', launcherBg.pid],
      ['pnpm exec playwright test > /tmp/j.log 2>&1 & echo $!', launcherBg.pid],
      ['npm run journey > /tmp/j.log 2>&1 & echo $!', launcherBg.pid],
    ]
    const named = (pid) => (pid === linuxChrome.pid ? `pid ${pid} — a browser you launched \\(google-chrome\\)` : `pid ${pid} — launched browser pid ${launcherChrome} \\(google-chrome\\)`)
    const wrappedMissed = WRAPPED.map(([command, pid]) => [command, guard([...DOC, [call('Bash', { command }, 'w1')], [answer('w1', `${pid}\n`)]]), pid]).filter(([, run, pid]) => !(run.decision === 'block' && new RegExp(named(pid)).test(run.text)))
    check(
      'frames-guard m-5 incident: `timeout 600 node …`, `/usr/bin/env node …`, `env -i PATH=… node …`, `nice -n 10 node …`, `caffeinate -i node …`, `bash -c "node …"` and `yarn dev … & chromium … & echo $!`, the browser still running — blocked, names the PIDs',
      Boolean(launcherChrome) && !wrappedMissed.length,
      `${launcherChrome} ${JSON.stringify(wrappedMissed.map(([command, run]) => [command, run.decision, run.text.slice(0, 160)]))}`,
    )
    // m-2 (final check, run 4): a package-manager launch names the PID too; the PID counts only with a young browser below it, so a dev server stays unnamed
    const yarnDev = guard([...DOC, [call('Bash', { command: 'yarn dev > /tmp/d.log 2>&1 & echo $!' }, 'y1')], [answer('y1', `${devServer.pid}\n`)]])
    check('frames-guard m-2 legit twin: `yarn dev … & echo $!` whose PID has no browser below it — passes', yarnDev.decision === 'allow', yarnDev.text)
    // S-1: a PID is the agent's only from its own Bash call — the incident forms of the security review must not block, the legit one must
    const otherChrome5b = fakeBrowser('another-session')
    await pause(200)
    const pgrep = guard([...DOC, [call('Bash', { command: 'npx serve out > /tmp/serve.log 2>&1 & echo $!; sleep 1; pgrep -f "Google Chrome"' }, 'p1')], [answer('p1', `${devServer.pid}\n${otherChrome5b.pid}\n${bashChrome.pid}`)]])
    check('frames-guard S-1 incident: a `pgrep` listing after `& echo $!` names no browser as the agent\'s — passes', pgrep.decision === 'allow', pgrep.text)
    // f-2: the single number counts only as the echo's own output — an echo redirected, piped or inside a group whose output goes elsewhere prints nothing,
    // and the `pgrep -n` after it prints another session's young Chrome
    const UNPRINTED = [
      'node server.js > /tmp/s.log 2>&1 & echo $! > /tmp/s.pid; sleep 1; pgrep -n -f "Google Chrome"',
      'node server.js > /tmp/s.log 2>&1 & echo "$!" >> /tmp/s.pid; pgrep -n -f "Google Chrome"',
      'node server.js > /tmp/s.log 2>&1 & echo $! 1>&2 2>/dev/null; pgrep -n -f "Google Chrome"',
      'node server.js > /tmp/s.log 2>&1 & echo $! | tee /tmp/s.pid > /dev/null; pgrep -n -f "Google Chrome"',
      '{ node server.js > /tmp/s.log 2>&1 & echo $!; } > /tmp/s.pid; pgrep -n -f "Google Chrome"',
      '(node server.js > /tmp/s.log 2>&1 & echo $!; sleep 1) > /tmp/s.pid; pgrep -n -f "Google Chrome"',
    ]
    const unprinted = UNPRINTED.map((command) => [command, guard([...DOC, [call('Bash', { command }, 'r1')], [answer('r1', `${otherChrome5b.pid}\n`)]])]).filter(([, run]) => run.decision !== 'allow')
    check('frames-guard f-2 incident: `echo $!` redirected, piped or in a redirected group, then `pgrep -n` prints another session\'s young Chrome — not the agent\'s launch, passes', !unprinted.length, JSON.stringify(unprinted.map(([command, run]) => [command, run.text])))
    const printedThenSleep = guard([...DOC, [call('Bash', { command: '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new > /tmp/chrome.log 2>&1 & echo $!; sleep 1' }, 'b3')], [answer('b3', `${bashChrome.pid}\n`)]])
    check('frames-guard f-2 legit twin: a Chrome started with a printed `& echo $!` (a silent `sleep` after it), still running — blocked, names its PID', printedThenSleep.decision === 'block' && new RegExp(`pid ${bashChrome.pid}`).test(printedThenSleep.text), printedThenSleep.text)
    const consolePid = guard([...DOC, [call(`${MCP}list_console_messages`, {}, 'm1')], [answer('m1', `## Console messages\nmsgid=1 [log] x\njourney: browser pid ${otherChrome5b.pid} (1 args)`)]])
    check('frames-guard S-1 incident: a `journey: browser pid N` line a page logged to the console is not the agent\'s launch — passes', consolePid.decision === 'allow', consolePid.text)
    const ECHOED_CHROME = [...DOC, [call('Bash', { command: '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new > /tmp/chrome.log 2>&1 & echo $!' }, 'b1')], [answer('b1', String(bashChrome.pid))]]
    const noTimes = guard(ECHOED_CHROME, fgRoot, { timestamps: false })
    check('frames-guard S-1 incident: a transcript with no timestamps attributes no PID (fail open) — passes', noTimes.decision === 'allow', noTimes.text)
    const older = guard(ECHOED_CHROME, fgRoot, { base: Date.now() + 5000 })
    check('frames-guard S-1: a browser that started before the agent\'s first transcript record is not its launch — passes', older.decision === 'allow', older.text)
    // the legit background form: a journey script started by the agent with `& echo $!`, its browser still alive below it
    const JOURNEY_BG = script('journey-bg.mjs', [
      "import { spawn } from 'node:child_process'",
      `spawn(process.execPath, ${JSON.stringify(chromeArgv(temp('journey-bg').args))}, { argv0: ${JSON.stringify(CHROME_EXE)}, stdio: 'ignore' })`,
      'setInterval(() => {}, 1000)',
      SELF_EXIT,
    ])
    const journeyBg = spawn(process.execPath, [JOURNEY_BG], { stdio: 'ignore' })
    started.add(journeyBg.pid)
    await pause(400)
    const bgChrome = proc.descendants(proc.processTable() ?? new Map(), journeyBg.pid, { depth: 1 })[0]?.pid
    if (bgChrome) started.add(bgChrome)
    const background = guard([...DOC, [call('Bash', { command: `node ${JOURNEY_BG} > /tmp/journey.log 2>&1 & echo $!` }, 'j2')], [answer('j2', `${journeyBg.pid}\n`)]])
    check(
      'frames-guard S-1 legit: a journey the agent started with `& echo $!`, its browser still running below it — blocked, the message names both PIDs and the executable',
      background.decision === 'block' && new RegExp(`pid ${journeyBg.pid} — launched browser pid ${bgChrome} \\(Google Chrome\\), still running`).test(background.text),
      background.text,
    )

    // D7 of VT-1: a force run already open when this plugin version first saw the task keeps the rules it started with.
    const dApp = join(bRoot, 'd7')
    repoAt(dApp, 'main')
    const dStages = (heading) => `# T-95: task\nLanguage: en\nBranch: \`T-95/feat/b\`\n\n## Status: stage 1\n\n${heading}\nConfirmed: 2026-10-18 — answers\n\n## Stages\n\n### Stage 1: page  [status: in-progress]\n`
    write(dApp, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n', '.claude/tasks/T-95/STAGES.md': dStages('## Force run 2026-10-18') })
    git(dApp, 'checkout', '-qb', 'T-95/feat/b')
    setGate(join(dApp, '.claude/tasks/T-95'), '2026-10-20', ['## Force run 2026-10-18'])
    check('frames-guard 5b D7: in a force run open before this version first saw the task, a page left open does not block', guard(OPENED, dApp).decision === 'allow', guard(OPENED, dApp).text)
    write(dApp, { '.claude/tasks/T-95/STAGES.md': dStages('## Force run 2026-10-22') })
    check('frames-guard 5b D7: in a force run opened after it, the same stop is blocked', guard(OPENED, dApp).decision === 'block')
    // nit (whole-branch review): a heading with no date counts from its `Confirmed:` line, as the receipts rules count it
    write(dApp, { '.claude/tasks/T-95/STAGES.md': dStages('## Force run') })
    const undatedOld = guard(OPENED, dApp)
    check('frames-guard 5b D7: an undated Force heading confirmed 2026-10-18, before the gate (2026-10-20) — counted from Confirmed:, a page left open does not block', undatedOld.decision === 'allow', undatedOld.text)
    write(dApp, { '.claude/tasks/T-95/STAGES.md': dStages('## Force run').replace('Confirmed: 2026-10-18', 'Confirmed: 2026-10-22') })
    check('frames-guard 5b D7: the same undated heading confirmed 2026-10-22 — the stop is blocked', guard(OPENED, dApp).decision === 'block')

    // ── AC-5b.2: the playwright fallback's journey throws midway — its browser is gone after the run ──
    const JOURNEY_LIB = join(PLUGIN, '../skills/devtools-verify/references/journey.mjs')
    const launchFake = (profile) => `spawn(process.execPath, [${JSON.stringify(SLEEPER)}, ${JSON.stringify(`--user-data-dir=${join(bRoot, profile)}`)}, '--remote-debugging-pipe'], { stdio: 'ignore' })`
    const runJourney = (name, lines) => {
      const run = spawnSync(process.execPath, [script(`${name}.mjs`, lines)], { encoding: 'utf8', timeout: 30_000 })
      const pid = Number(/^journey: browser pid (\d+)/m.exec(run.stdout)?.[1] ?? 0)
      if (pid) started.add(pid)
      return { ...run, pid }
    }
    const plain = runJourney('journey-plain', ["import { spawn } from 'node:child_process'", `const child = ${launchFake('puppeteer_dev_chrome_profile-plain')}`, "console.log('journey: browser pid ' + child.pid)", "throw new Error('step 3 failed midway')"])
    check('journey AC-5b.2 incident: a journey that throws midway with no close of its own leaves its browser running', plain.status !== 0 && plain.pid > 0 && proc.alive(plain.pid), plain.stdout + plain.stderr)
    const playwrightShaped = runJourney('journey-playwright', [
      "import { spawn } from 'node:child_process'",
      `import { withBrowser } from ${JSON.stringify(JOURNEY_LIB)}`,
      `await withBrowser(async () => { ${launchFake('puppeteer_dev_chrome_profile-pw')}; return { close: () => new Promise(() => {}) } }, async () => { throw new Error('step 3 failed midway') }, { closeTimeoutMs: 300 })`,
    ])
    check(
      'journey AC-5b.2: withBrowser, a playwright-shaped browser (no process(), a close() that hangs), the journey throws midway — the browser is found below the script and killed by its PID',
      playwrightShaped.status !== 0 && playwrightShaped.pid > 0 && (await goneWithin(playwrightShaped.pid)) && new RegExp(`journey: browser killed \\(pid ${playwrightShaped.pid}\\)`).test(playwrightShaped.stdout) && /step 3 failed midway/.test(playwrightShaped.stderr),
      playwrightShaped.stdout + playwrightShaped.stderr,
    )
    const puppeteerShaped = runJourney('journey-puppeteer', [
      "import { spawn } from 'node:child_process'",
      `import { withBrowser } from ${JSON.stringify(JOURNEY_LIB)}`,
      `await withBrowser(async () => { const child = ${launchFake('puppeteer_dev_chrome_profile-pp')}; return { process: () => child, close: async () => { child.kill() } } }, async () => { throw new Error('step 3 failed midway') })`,
    ])
    check(
      'journey AC-5b.2: withBrowser, a puppeteer-shaped browser (process(), a working close()), the journey throws midway — closed in the finally',
      puppeteerShaped.status !== 0 && puppeteerShaped.pid > 0 && (await goneWithin(puppeteerShaped.pid)) && new RegExp(`journey: browser closed \\(pid ${puppeteerShaped.pid}\\)`).test(puppeteerShaped.stdout),
      puppeteerShaped.stdout + puppeteerShaped.stderr,
    )
    // S-6: the browser crashed early and its PID is another process by the end — close() resolves at once, as a crashed browser's does; no SIGKILL may follow
    const reusedJourney = runJourney('journey-reused', [
      "import { spawn } from 'node:child_process'",
      `import { withBrowser } from ${JSON.stringify(JOURNEY_LIB)}`,
      `const child = spawn(process.execPath, ${JSON.stringify(chromeArgv([`--user-data-dir=${join(bRoot, 'puppeteer_dev_chrome_profile-crashed')}`, '--remote-debugging-pipe'], REUSED('SIGUSR2')))}, { argv0: ${JSON.stringify(CHROME_EXE)}, stdio: 'ignore', detached: true })`,
      'child.unref()',
      "await withBrowser(async () => ({ process: () => child, close: async () => {} }), async () => { process.kill(child.pid, 'SIGUSR2'); await new Promise((done) => setTimeout(done, 300)); throw new Error('step 3 failed midway') }, { closeTimeoutMs: 300 })",
    ])
    check(
      'journey S-6: a PID that is another process by the close (start time / command line changed) gets no SIGKILL',
      reusedJourney.pid > 0 && proc.alive(reusedJourney.pid) && /another-process-on-that-pid/.test(proc.commandOf(reusedJourney.pid) ?? '') && new RegExp(`journey: pid ${reusedJourney.pid} is not the browser launched here any more`).test(reusedJourney.stdout) && !/browser killed/.test(reusedJourney.stdout),
      `${reusedJourney.stdout}${reusedJourney.stderr} alive ${proc.alive(reusedJourney.pid)}`,
    )
    const hung = spawn(process.execPath, [script('journey-sigterm.mjs', [
      "import { spawn } from 'node:child_process'",
      `import { withBrowser } from ${JSON.stringify(JOURNEY_LIB)}`,
      `await withBrowser(async () => { ${launchFake('puppeteer_dev_chrome_profile-term')}; return { close: () => new Promise(() => {}) } }, () => new Promise(() => setInterval(() => {}, 1000)))`,
    ])], { stdio: ['ignore', 'pipe', 'inherit'] })
    started.add(hung.pid)
    const hungExit = new Promise((done) => hung.on('exit', (code, signalName) => done(code ?? signalName)))
    const hungPid = await new Promise((done) => {
      let text = ''
      hung.stdout.on('data', (chunk) => {
        text += chunk
        const found = /journey: browser pid (\d+)/.exec(text)
        if (found) done(Number(found[1]))
      })
      setTimeout(() => done(0), 20_000)
    })
    if (hungPid) started.add(hungPid)
    hung.kill('SIGTERM')
    const hungCode = await hungExit
    check('journey AC-5b.2: a journey stopped by SIGTERM (a Bash timeout) — its browser is killed by PID on the way out', hungPid > 0 && (await goneWithin(hungPid)) && hungCode === 143, `pid ${hungPid}, exit ${hungCode}`)

    // ── AC-5b.5 / m-2 / m-3 / S-5: only the call that closes the Force block closes its session's MCP browser, and the digest says what happened ──
    if (!recognised) check('journal-gate AC-5b.5: skipped — the fake session was not recognised, so the hook could reach a real one', false)
    else {
      const cApp = join(bRoot, 'close-app')
      repoAt(cApp, 'main')
      const OPEN = '## Force run 2026-10-04'
      const CLOSED = '## Force run 2026-10-04 — completed 2026-10-04'
      const WITH_BLOCKERS = '## Force run 2026-10-04 — completed with blockers 2026-10-04'
      const BLOCKER = 'B1 — CI gate red (AC-1) — no runner here — run it on CI — rerun after the merge — nothing else'
      const cStages = (ticket, heading, blockers = 'none') =>
        `# ${ticket}: task\nLanguage: en\nBranch: \`${ticket}/feat/c\`\n\n## Status: stage 1\n\n${heading}\nConfirmed: 2026-10-04 — answers\nBlockers: ${blockers}\n\n## Stages\n\n### Stage 1: page  [status: done]\n`
      const TICKETS = ['T-91', 'T-92', 'T-93', 'T-94', 'T-96', 'T-97', 'T-98', 'T-99']
      write(cApp, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n', ...Object.fromEntries(TICKETS.map((ticket) => [`.claude/tasks/${ticket}/STAGES.md`, cStages(ticket, OPEN)])) })
      git(cApp, 'checkout', '-qb', 'T-96/feat/c')
      for (const ticket of TICKETS) setGate(join(cApp, '.claude/tasks', ticket), '2026-10-20')
      const stagesOf = (ticket) => join(cApp, '.claude/tasks', ticket, 'STAGES.md')
      // A run of the fake session that writes the journal as a tool call would; the hook runs after it judge the file as it is then.
      const writeRun = (ticket, heading, blockers) => ({ args: ['-e', `require('fs').writeFileSync(${JSON.stringify(stagesOf(ticket))}, ${JSON.stringify(cStages(ticket, heading, blockers))})`] })
      const HOOK = join(PLUGIN, 'hooks/journal-gate.mjs')
      let callNo = 0
      const hookRun = (tool, event, session, toolInput, { id = `call-${callNo++}`, env = {} } = {}) => ({
        args: [HOOK],
        input: JSON.stringify({ cwd: cApp, tool_name: tool, hook_event_name: event, session_id: session, tool_use_id: id, tool_input: toolInput }),
        env: { STAGE_PIPELINE_BROWSER_CLEANUP: '', ...env },
      })
      const edit = (ticket, session, from, to, options) => hookRun('Edit', 'PostToolUse', session, { file_path: stagesOf(ticket), old_string: from, new_string: to }, options)
      const contextOf = (run) => {
        try {
          return JSON.parse(run?.stdout || '{}').hookSpecificOutput?.additionalContext ?? ''
        } catch {
          return run?.stdout ?? ''
        }
      }
      const decisionOf = (run) => {
        try {
          return JSON.parse(run?.stdout || '{}').decision ?? 'allow'
        } catch {
          return 'unparsed'
        }
      }
      const LEFT_OPEN_CMD = 'close: `node \\S+browser-cleanup\\.mjs --session`'

      // Session C: the off switch, a heading closed by hand, a close that was rejected and then fixed — by another session, then by C itself.
      const gate = await session('session-gate', [{ args: ['chrome-devtools-mcp@1.6.0', '--isolated'], chrome: temp('gate') }], {
        runs: [
          writeRun('T-97', CLOSED),
          edit('T-97', 'C', OPEN, CLOSED, { env: { STAGE_PIPELINE_BROWSER_CLEANUP: 'off' } }),
          writeRun('T-98', CLOSED),
          edit('T-98', 'C', '### Stage 1: page', '### Stage 1: page'),
          writeRun('T-99', CLOSED, BLOCKER),
          edit('T-99', 'C', OPEN, CLOSED),
          writeRun('T-99', WITH_BLOCKERS, BLOCKER),
          edit('T-99', 'D', CLOSED, WITH_BLOCKERS),
          edit('T-99', 'C', '### Stage 1: page', '### Stage 1: page'),
        ],
      })
      const gChrome = gate?.tree[0]?.chrome
      const [, offRun, , byHand, , rejected, , otherFix, ownFix] = gate?.runs ?? []
      check(
        'journal-gate m-3: with STAGE_PIPELINE_BROWSER_CLEANUP=off the closing edit leaves the browser, and the digest says "left open — …=off" with the close command',
        Boolean(offRun) && offRun.alive[gChrome] && /force run T-97 is closed/.test(contextOf(offRun)) && new RegExp(`Session browser: left open — STAGE_PIPELINE_BROWSER_CLEANUP=off; ${LEFT_OPEN_CMD}\\.`).test(contextOf(offRun)),
        `${contextOf(offRun).slice(-400)} ${offRun?.stderr ?? ''}`,
      )
      check(
        'journal-gate m-2: a normal-mode edit after the block was closed elsewhere (by hand) closes nothing; the digest records "left open" with the close command',
        Boolean(byHand) && byHand.alive[gChrome] && /force run T-98 is closed/.test(contextOf(byHand)) && new RegExp(`Session browser: left open — the Force block was not closed by a call of this session [^\\n]*; ${LEFT_OPEN_CMD}\\.`).test(contextOf(byHand)),
        `${contextOf(byHand).slice(-400)} ${byHand?.stderr ?? ''}`,
      )
      check('journal-gate m-2: a closing edit the hook rejects (an open blocker) closes nothing yet', Boolean(rejected) && decisionOf(rejected) === 'block' && rejected.alive[gChrome], `${rejected?.stdout ?? ''}`.slice(0, 400))
      check(
        'journal-gate S-5: another session that fixes that close does not close its browser here (only the closing session\'s calls count)',
        Boolean(otherFix) && otherFix.alive[gChrome] && /Session browser: left open — the Force block was not closed by a call of this session/.test(contextOf(otherFix)),
        `${contextOf(otherFix).slice(-400)} ${otherFix?.stderr ?? ''}`,
      )
      check(
        'journal-gate m-2: the closing session\'s next edit after its rejected close closes its browser by PID and shows the digest again',
        Boolean(ownFix) && !ownFix.alive[gChrome] && new RegExp(`Session browser: closed by PID ${gChrome} — the next MCP call opens a fresh one\\.`).test(contextOf(ownFix)),
        `${contextOf(ownFix).slice(-400)} ${ownFix?.stderr ?? ''}`,
      )

      // f-3: a rejected close is forgotten once its block is open again. C2's close is rejected, C2 reopens the block, the heading is closed by hand with the
      // blocker cleared, and C2's later no-op edit closes nothing: the digest and the record say "left open" (`skipped: not this call`).
      const { browserCleanupOf } = await import(join(PLUGIN, 'run-digest.mjs'))
      const reopen = await session('session-reopen', [{ args: ['chrome-devtools-mcp@1.6.0', '--isolated'], chrome: temp('reopen') }], {
        runs: [
          writeRun('T-92', CLOSED, BLOCKER),
          edit('T-92', 'C2', OPEN, CLOSED),
          writeRun('T-92', OPEN, BLOCKER),
          edit('T-92', 'C2', CLOSED, OPEN),
          writeRun('T-92', CLOSED),
          edit('T-92', 'C2', '### Stage 1: page', '### Stage 1: page'),
        ],
      })
      const rChrome = reopen?.tree[0]?.chrome
      const [, reRejected, , reOpened, , reNoop] = reopen?.runs ?? []
      check(
        'journal-gate f-3 incident: close rejected → reopened by the same session → closed by hand → that session\'s no-op edit leaves its browser open, "left open" recorded',
        Boolean(reNoop) &&
          decisionOf(reRejected) === 'block' &&
          decisionOf(reOpened) === 'allow' &&
          reNoop.alive[rChrome] &&
          /force run T-92 is closed/.test(contextOf(reNoop)) &&
          /Session browser: left open — the Force block was not closed by a call of this session/.test(contextOf(reNoop)) &&
          browserCleanupOf(DATA, join(cApp, '.claude/tasks/T-92'), CLOSED)?.skipped === 'not this call',
        `${decisionOf(reRejected)} ${decisionOf(reOpened)} ${contextOf(reNoop).slice(-400)} ${reNoop?.stderr ?? ''}`,
      )
      // f-3: an entry older than 7 days is not read — C3's no-op edit after a hand close leaves its browser open.
      const rejectedFile = join(DATA, 'browser-close-rejected.json')
      let rejectedNow = {}
      try {
        rejectedNow = JSON.parse(readFileSync(rejectedFile, 'utf8'))
      } catch {
        // no entries yet
      }
      writeFileSync(rejectedFile, JSON.stringify({ ...rejectedNow, [`${join(cApp, '.claude/tasks/T-91')}::${OPEN}`]: { session: 'C3', at: new Date(Date.now() - 8 * 86_400_000).toISOString() } }))
      const stale = await session('session-stale', [{ args: ['chrome-devtools-mcp@1.6.0', '--isolated'], chrome: temp('stale') }], {
        runs: [writeRun('T-91', CLOSED), edit('T-91', 'C3', '### Stage 1: page', '### Stage 1: page')],
      })
      const sChrome = stale?.tree[0]?.chrome
      const [, staleNoop] = stale?.runs ?? []
      check(
        'journal-gate f-3: a rejected-close entry 8 days old is ignored — the session\'s no-op edit after a hand close leaves its browser open',
        Boolean(staleNoop) && staleNoop.alive[sChrome] && /Session browser: left open — the Force block was not closed by a call of this session/.test(contextOf(staleNoop)),
        `${contextOf(staleNoop).slice(-400)} ${staleNoop?.stderr ?? ''}`,
      )

      // S-5 with two sessions on one task: B's unrelated Bash call runs while A's edit closes the block, then A's closing edit is judged.
      const sessionB = await session('session-b5', [{ args: ['chrome-devtools-mcp@1.6.0', '--isolated'], chrome: temp('b5') }], {
        runs: [
          hookRun('Bash', 'PreToolUse', 'B', { command: 'npm test' }, { id: 'b5-npm' }),
          writeRun('T-96', CLOSED),
          hookRun('Bash', 'PostToolUse', 'B', { command: 'npm test' }, { id: 'b5-npm' }),
          // B's own close of another task by a Bash call that names it: the PreToolUse stamp held the open heading
          hookRun('Bash', 'PreToolUse', 'B', { command: `perl -pi -e 's/x/y/' ${stagesOf('T-94')}` }, { id: 'b5-close' }),
          writeRun('T-94', CLOSED),
          hookRun('Bash', 'PostToolUse', 'B', { command: `perl -pi -e 's/x/y/' ${stagesOf('T-94')}` }, { id: 'b5-close' }),
        ],
      })
      const bChrome = sessionB?.tree[0]?.chrome
      const [, , bUnrelated, , , bClose] = sessionB?.runs ?? []
      check(
        'journal-gate S-5 incident: B\'s unrelated Bash call during which another session closed the block — B\'s browser is untouched, the digest says "left open"',
        Boolean(bUnrelated) && bUnrelated.alive[bChrome] && /Session browser: left open — the Force block was not closed by a call of this session/.test(contextOf(bUnrelated)),
        `${contextOf(bUnrelated).slice(-400)} ${bUnrelated?.stderr ?? ''}`,
      )
      check(
        'journal-gate m-2: a Bash call that names the task and turns its heading from open to closed closes its own session\'s browser',
        Boolean(bClose) && !bClose.alive[bChrome] && new RegExp(`force run T-94 is closed[\\s\\S]*Session browser: closed by PID ${bChrome}`).test(contextOf(bClose)),
        `${contextOf(bClose).slice(-400)} ${bClose?.stderr ?? ''}`,
      )
      const sessionA = await session('session-a5', [{ args: ['chrome-devtools-mcp@1.6.0', '--isolated'], chrome: temp('a5') }], { runs: [edit('T-96', 'A', OPEN, CLOSED)] })
      const [{ mcp: aMcp, chrome: aChrome } = {}] = sessionA?.tree ?? []
      const [aClose] = sessionA?.runs ?? []
      check(
        'journal-gate AC-5b.5 / S-5: A\'s closing edit closes A\'s MCP browser by PID before the summary, keeps the MCP server, and A gets the digest that says so',
        Boolean(aClose) && !aClose.alive[aChrome] && aClose.alive[aMcp] && /force run T-96 is closed/.test(contextOf(aClose)) && new RegExp(`Session browser: closed by PID ${aChrome} — the next MCP call opens a fresh one\\.`).test(contextOf(aClose)),
        `${contextOf(aClose).slice(-600)} ${aClose?.stderr ?? ''}`,
      )
      const digestFile = join(cApp, '.claude/tasks/T-96/RUN-DIGEST.md')
      check('journal-gate AC-5b.5: RUN-DIGEST.md carries the browser line', existsSync(digestFile) && new RegExp(`Session browser: closed by PID ${aChrome}`).test(readFileSync(digestFile, 'utf8')))
      const again = spawnSync(process.execPath, [join(PLUGIN, 'run-digest.mjs'), join(cApp, '.claude/tasks/T-96'), '--no-write'], { cwd: cApp, encoding: 'utf8' })
      check('journal-gate AC-5b.5: the orchestrator\'s own run-digest.mjs for the summary keeps the line (recorded for that Force block)', new RegExp(`Session browser: closed by PID ${aChrome}`).test(again.stdout), again.stdout + again.stderr)

      // m-2, Write: the PreToolUse run stamps the heading the Write replaces; open before, closed in the content — this Write closed the block.
      const writer = await session('session-w5', [{ args: ['chrome-devtools-mcp@1.6.0', '--isolated'], chrome: temp('w5') }], {
        runs: [
          hookRun('Write', 'PreToolUse', 'W', { file_path: stagesOf('T-93'), content: cStages('T-93', CLOSED) }, { id: 'w5' }),
          writeRun('T-93', CLOSED),
          hookRun('Write', 'PostToolUse', 'W', { file_path: stagesOf('T-93'), content: cStages('T-93', CLOSED) }, { id: 'w5' }),
        ],
      })
      const wChrome = writer?.tree[0]?.chrome
      const [, , wClose] = writer?.runs ?? []
      check(
        'journal-gate m-2: a Write whose file held the open heading and whose content closes it closes its session\'s browser',
        Boolean(wClose) && !wClose.alive[wChrome] && new RegExp(`Session browser: closed by PID ${wChrome}`).test(contextOf(wClose)),
        `${contextOf(wClose).slice(-400)} ${wClose?.stderr ?? ''}`,
      )

      // m-3 (whole-branch review): the pre-Write stamp reads STAGES.md through R1's bounded reader. A 300 MB journal (sparse) whose first lines hold the open heading:
      // the bare read cost every Write 0.4–0.7 s and 1.3–1.5 GB. Bounded, the pre-hook stays fast and small and stamps no heading; the Write is then refused as R1
      // refuses any edit of an unreadable journal, and the session's browser is left alone.
      const bigStages = join(cApp, '.claude/tasks/T-90/STAGES.md')
      write(cApp, { '.claude/tasks/T-90/STAGES.md': cStages('T-90', OPEN) })
      truncateSync(bigStages, 300 * 1024 * 1024)
      const RSS = script('max-rss.mjs', ["import { writeFileSync } from 'node:fs'", "process.on('exit', () => writeFileSync(process.env.RSS_OUT, String(process.resourceUsage().maxRSS)))"])
      const rssOut = join(bRoot, 'max-rss.out')
      const bigWrite = { cwd: cApp, tool_name: 'Write', session_id: 'W9', tool_use_id: 'w9-big', tool_input: { file_path: bigStages, content: cStages('T-90', CLOSED) } }
      const preStart = performance.now()
      const preBig = spawnSync(process.execPath, ['--import', RSS, HOOK], { input: JSON.stringify({ ...bigWrite, hook_event_name: 'PreToolUse' }), encoding: 'utf8', env: { ...process.env, RSS_OUT: rssOut }, timeout: 30_000 })
      const preMs = performance.now() - preStart
      const rssMb = Number(existsSync(rssOut) ? readFileSync(rssOut, 'utf8') : NaN) / 1024
      let bigStamp = null
      try {
        bigStamp = JSON.parse(readFileSync(join(DATA, 'write-start', 'w9-big.json'), 'utf8'))
      } catch {
        // no stamp — the check below says so
      }
      check(
        `journal-gate m-3: the pre-Write stamp of a 300 MB STAGES.md — ${Math.round(preMs)} ms, max RSS ${Math.round(rssMb)} MB (< 2 000 ms, < 200 MB; 1.3–1.5 GB before), no heading stamped although the file opens with one`,
        preBig.status === 0 && preMs < 2000 && rssMb < 200 && bigStamp?.file === realpathSync(bigStages) && bigStamp.heading === null,
        `${preBig.status} ${preMs.toFixed(0)} ms ${rssMb.toFixed(0)} MB ${JSON.stringify(bigStamp)} ${preBig.stderr.split('\n')[0]}`,
      )
      const bigRun = await session('session-w9', [{ args: ['chrome-devtools-mcp@1.6.0', '--isolated'], chrome: temp('w9') }], {
        runs: [hookRun('Write', 'PostToolUse', 'W9', bigWrite.tool_input, { id: 'w9-big' })],
      })
      const bigChrome = bigRun?.tree[0]?.chrome
      const [bigPost] = bigRun?.runs ?? []
      check(
        'journal-gate m-3: the Write of that STAGES.md is refused as R1 refuses an unreadable journal (the file and the limit named), and the session\'s browser stays open',
        Boolean(bigPost) && decisionOf(bigPost) === 'block' && /STAGES\.md cannot be read: it is 300 MB, over the 4 MB limit/.test(bigPost.stdout) && bigPost.alive[bigChrome],
        `${decisionOf(bigPost)} ${(bigPost?.stdout ?? '').slice(0, 300)} ${bigPost?.stderr ?? ''}`,
      )
    }
  } finally {
    for (const pid of started) {
      if (pid > 0 && proc.alive(pid) && proc.commandOf(pid)?.includes(bRoot)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // gone in between
        }
      }
    }
    rmSync(bRoot, { recursive: true, force: true })
  }
}

// ── VT-1 stage 5e (0.18.2): the run summary is plain markdown; a blocker is lifted only by a fixed field; a carried blocker keeps its run ──
{
  const { collectDigest, runDigest } = await import(join(PLUGIN, 'run-digest.mjs'))
  // The three live lines of announcement-details, verbatim: run 9's B1 (STAGES.md:258), run 8's B1 carried in run 9's assumptions (:247), an interview answer of run 11 (:298).
  const LIVE_B1 = "- B1 — гидрация `/profile/my-publications` (AC-54.2, этап 54) — причина доказана: флаг `classified_create_enabled` (Unleash) на сервере не готов (`flagsReady` стартует в `onMounted` провайдера), а к гидрации страницы на клиенте уже готов, поэтому вкладки `pages/profile.vue` расходятся (`checks/devtools-verify-54.md`: до — 6 из 6, с закрытием флага на сервере — 0 из 10); закрытие флага на сервере убрало «Найдено N» из SSR `/cars` (CLS 0.094) и откатено — нужно: решение, делать ли подстановку флагов Unleash на SSR (запрос флагов на сервере и передача в клиент) — рекомендация: отдельной задачей, это уберёт такие расхождения на всех страницах с флагом — зависит: ничего"
  const LIVE_CARRIED = "- B1 (8) открыт, волну не блокирует: район выключен константой (D17)."
  const LIVE_ANSWER = "- B1 (10) — принять рекомендацию: расхождение гидрации профиля при «холодном» входе — отдельной задачей вне KC-635 после проверки на живом dev с настоящим входом; проверка достижимости состояния «`access_token` без `user`» — наблюдение `AC-60.5` в живом проходе, без правок кода."
  const LIVE_LABEL = "Ответы интервью (2026-10-23, Lavish — пачка «Ответы на 2 блокера», сессия `run10.html` закрыта пользователем):"
  const LIVE_ANSWER_3 = "- B3 (10) и B8 (9) сняты: 2026-10-23 10:06 dev.mycar.kz отвечает 200, dev-api `cars/api/publications/{89182,83533,88660}/` — 200 → этапы 60 и 67 разблокированы; порядок — 69 → 60 → финальные проверки (10) → 67 → отчёт lavish (решение 2026-10-22: сравнение последним)."
  const run9 = (date, extra = '') =>
    `## Force-прогон ${date} (9) — волна «Обновлённый макет деталки» — завершён с блокерами ${date}\nРежим: автономный.\nОтветы интервью (${date}):\n- удаление файла — согласовано;\nДопущения:\n${LIVE_CARRIED}\n- другое допущение.\nПодтверждено: ${date} — ответы интервью\nБлокеры:\n${LIVE_B1}\n${extra}\n`
  const openOf = (heading, body) => jc.openBlockers({ heading, body })
  const bodyOf = (stages) => jc.lastForceBlock(stages)
  const OLD = '2026-10-21'
  const NEW = '2026-10-27'
  const head = (date) => `## Force-прогон ${date} (9) — x — завершён с блокерами ${date}`

  check('5e: the gate constant is the day after the run (K1)', markers.BLOCKER_FIELD_SINCE === '2026-10-26')
  // incident: the live lines come out OPEN, in the old block (the Russian noun for "closing" no longer lifts) and in a new one
  for (const [label, date] of [['old block 2026-10-21', OLD], ['new block 2026-10-27', NEW]]) {
    const open = jc.openBlockers(bodyOf(run9(date)))
    check(`5e incident (${label}): run 9's B1 and the carried "B1 (8)" are both open`, open.length === 2 && open.some((line) => line.startsWith('- B1 — гидрация')) && open.some((line) => line.startsWith('- B1 (8) открыт')), JSON.stringify(open.map((line) => line.slice(0, 30))))
  }
  check('5e incident: the interview answer "B1 (10) — accept the recommendation" (ru) is not a blocker (old and new block)', [OLD, NEW].every((date) => openOf(head(date), `Ответы интервью (${date}):\n${LIVE_ANSWER}\n- B2 (10) — принять рекомендацию: x\nДопущения:\n- ok\n`).length === 0))
  check('5e incident: the live run 11 field label (long, with a parenthesis) still opens the interview answers field', [OLD, NEW].every((date) => openOf(head(date), `${LIVE_LABEL}\n${LIVE_ANSWER}\n${LIVE_ANSWER_3}\nДопущения:\n- ok\n`).length === 0))
  check('5e: the plain "B<n> —" in the interview answers still counts (K4: today\'s reading in the whole block)', openOf(head(NEW), 'Ответы интервью:\n- B3 — нужен ответ\nДопущения:\n- ok\n').length === 1)
  check('5e: the carried form counts in every field but the interview answers, and the field ends at the next field line', openOf(head(NEW), 'Ответы интервью:\n- B1 (10) — ответ\nДопущения:\n- B1 (8) открыт\nГраницы:\n- B2 (8) — открыт\n').length === 2)
  check('5e: "B1 (8)" with no text after the run, and "B1 (see below) …", are not blockers', openOf(head(NEW), '- B1 (8)\n- B2 (см. ниже) открыт\n- B3 (8 файлов) открыт\n').length === 0)
  // legitimate: the fixed field lifts, in both languages, in the three places
  check('5e legit (new block): the Lifted: field and its Russian form after the ID (with its run, a real blocker line), after a dash, after a semicolon lift the blocker', openOf(head(NEW), '- B1 (8) Lifted: user 2026-10-27\n- B2 — x — Lifted: user decision 2026-10-27\n- B3 — y; Снят: пользователь 2026-10-27 — ответ\n- B4 (8) — Снят: пользователь 2026-10-27\n- **B5** — **Lifted:** user 2026-10-27\n').length === 0, JSON.stringify(openOf(head(NEW), '- B1 (8) Lifted: user 2026-10-27\n- B2 — x — Lifted: user decision 2026-10-27\n- B3 — y; Снят: пользователь 2026-10-27 — ответ\n- B4 (8) — Снят: пользователь 2026-10-27\n- **B5** — **Lifted:** user 2026-10-27\n')))
  check('5e legit (new block): the field on an indented sub-item lifts only its own blocker (the VT-1 B7 form)', same(openOf(head(NEW), '- B1 — x\n  - Lifted: user 2026-10-27\n- B2 — y\n  - note\n- B3 — z\n    Снят: пользователь 2026-10-27\n').map((line) => line.slice(0, 4)), ['- B2']))
  check('5e: the lift on the Blockers field line is read per item', same(openOf(head(NEW), 'Blockers: B1 — a — Lifted: user 2026-10-27. B2 — b').map((line) => line.slice(0, 2)), ['B2']))
  // incident: words never lift in a new block
  for (const word of ['с закрытием флага', 'снят с релиза', 'resolved in the draft', 'closed issues reopened', 'closed by the user 2026-10-27', 'снят пользователем', 'решение пользователя 2026-10-27', 'user decision 2026-10-27', 'закрыт 2026-10-27']) {
    check(`5e incident (new block): "${word}" in the description lifts nothing`, openOf(head(NEW), `- B1 — x ${word} — y\n`).length === 1, word)
  }
  check('5e incident (new block): "Lifted:" with no text after it, "Lifted: no" and its Russian form, a bare word "lifted" and a field that opens no segment lift nothing', openOf(head(NEW), '- B1 — x — Lifted:\n- B2 — x — Lifted: no\n- B3 — x — Снят: нет\n- B4 — x — lifted\n- B5 — x Lifted: user\n').length === 5)
  check('5e incident (new block): a field-wide mark lifts no item ("both lifted" and its Russian form)', openOf(head(NEW), 'Blockers: B1 — a; B2 — b — both lifted by the user 2026-10-27.\n').length === 2 && openOf(head(NEW), 'Блокеры: все сняты 2026-10-27. B1 — a; B2 — b\n').length === 2)
  check('5e incident (new block): a field in the middle of a word or of a link ("unlifted:", "x.lifted:y") lifts nothing', openOf(head(NEW), '- B1 — a unlifted: yes\n- B2 — see foo.lifted:bar\n').length === 2)
  // legitimate: old blocks keep today's matcher
  check('5e legit (old block 2026-10-21): a bold Russian "closed <date>", "lifted by the user" and the Russian "lifted by the user" and a field-wide mark still lift', openOf(head(OLD), '- B1 — x **закрыт 2026-10-19**\n- B2 — y снят пользователем\n- B3 — z lifted by the user\nBlockers: B4 — a; B5 — b — both lifted by the user 2026-10-19.\n').length === 0)
  check('5e legit (undated block): no date keeps the word matcher, with the field-wide mark too', jc.openBlockers('- B1 — x снят пользователем\nBlockers: B2 — a; B3 — b — both lifted by the user 2026-10-19.\n').length === 0)
  check('5e K3 (old block): the noun forms of "closing" and "lifting" no longer lift; the participles and "closed by" still do', openOf(head(OLD), '- B1 — с закрытием флага\n- B2 — закрытие флага\n- B3 — закрытия\n- B4 — закрытию\n- B5 — снятие лимита\n- B6 — снятия\n- B7 — в закрытии\n').length === 7 && openOf(head(OLD), '- B1 — закрыт\n- B2 — снят\n- B3 — closed by the user\n').length === 0)
  // r1 m-1: the lift field needs a date; r1 m-2: the inline split accepts the carried form
  check('5e r1 m-1 (new block): "Lifted:" with no date ("pending user", "<who> <date>", "TBD", "—", "awaiting answer") lifts nothing', openOf(head(NEW), '- B1 — a — Lifted: pending user\n- B2 — a — Lifted: <who> <date>\n- B3 — a — Lifted: TBD\n- B4 — a — Lifted: —\n- B5 — a — Lifted: awaiting answer\n').length === 5)
  check('5e r1 m-1 (new block): a date in either form lifts, in the line and on the sub-item', openOf(head(NEW), '- B1 — a — Lifted: user decision 2026-10-27 «yes»\n- B2 — a — Снят: решение пользователя 27.10.2026\n- B3 — a\n  - Lifted: user 2026-10-27\n- B4 — a\n  - Снят: пользователь 27.10.2026\n- B5 — a\n  - Lifted: pending user\n').length === 1)
  check('5e r1 m-1: a date farther than 120 characters from the field does not lift', openOf(head(NEW), `- B1 — a — Lifted: ${'x'.repeat(130)} 2026-10-27\n`).length === 1)
  // round 3 (final checks): S1 — a denied value cannot be skipped by a date after it; S3 — items of a one-line field split at a bold ID and a comma; m-2 — the field on the blocker's own line lifts on the word path too;
  // m-3 — an inline field with one blocker reads its sub-item, `B1:` / `B1 -` openers, a real "after the ID" blocker line; m-4 — the Russian form is capitalised and does not open after `(`.
  {
    const DENIED = ['no (asked the user 2026-10-27)', 'none, 2026-10-27', 'not yet, asked 2026-10-27', 'never 2026-10-27', 'pending, asked the user 2026-10-27', 'TBD 2026-10-27', 'tbd 2026-10-27', 'waiting for the user 2026-10-27', 'awaiting answer 2026-10-27', '— 2026-10-27', '<who> 2026-10-27', '**no** — 2026-10-27']
    const DENIED_RU = ['нет (27.10.2026)', 'не снят, 27.10.2026', 'ждём ответа 27.10.2026', 'ожидает ответа 27.10.2026', 'не получен 27.10.2026']
    const lineOf = (label, value) => `- B1 — CI e2e red — needs the token — ${label}: ${value}\n`
    const subOf = (label, value) => `- B1 — CI e2e red\n  - ${label}: ${value}\n`
    check('5e S1 (new block): a denied value followed by a date lifts nothing, on the line', DENIED.every((value) => openOf(head(NEW), lineOf('Lifted', value)).length === 1) && DENIED_RU.every((value) => openOf(head(NEW), lineOf('Снят', value)).length === 1), JSON.stringify([...DENIED.filter((value) => openOf(head(NEW), lineOf('Lifted', value)).length !== 1), ...DENIED_RU.filter((value) => openOf(head(NEW), lineOf('Снят', value)).length !== 1)]))
    check('5e S1 (new block): a denied value followed by a date lifts nothing, on the sub-item', DENIED.every((value) => openOf(head(NEW), subOf('Lifted', value)).length === 1) && DENIED_RU.every((value) => openOf(head(NEW), subOf('Снят', value)).length === 1), JSON.stringify(DENIED.filter((value) => openOf(head(NEW), subOf('Lifted', value)).length !== 1)))
    check('5e S1 (new block): a bold label and a bold value are read too ("**Lifted:** no 2026-10-27", "Lifted:** no")', openOf(head(NEW), '- B1 — a — **Lifted:** no 2026-10-27\n- B2 — a — **Lifted:** **no** 2026-10-27\n').length === 2)
    check('5e S1 (old block): the same denied English values on the blocker line lift nothing by the field (the Russian lift word itself still lifts there, by words)', DENIED.slice(0, 5).every((value) => openOf(head(OLD), lineOf('Lifted', value)).length === 1) )
    check('5e S1: a real name or a value that only starts like a denied word still lifts ("nobody", "Nora", "notary", a Russian name)', openOf(head(NEW), '- B1 — a — Lifted: nobody 2026-10-27\n- B2 — a — Lifted: Nora 2026-10-27\n- B3 — a — Lifted: notary 2026-10-27\n- B4 — a — Снят: Нестор 27.10.2026\n').length === 0)
    for (const [label, date] of [['new block', NEW], ['old block', OLD]]) {
      check(`5e S3 (${label}): "Blockers: **B1** — … (Lifted: …). **B2** — …" lifts B1 only`, same(openOf(head(date), 'Blockers: **B1** — token (Lifted: user 2026-10-27). **B2** — CI e2e red').map((line) => line.slice(0, 6)), ['**B2**']), JSON.stringify(openOf(head(date), 'Blockers: **B1** — token (Lifted: user 2026-10-27). **B2** — CI e2e red')))
      check(`5e S3 (${label}): a comma before "B2 —" separates the items`, same(openOf(head(date), 'Blockers: B1 — token — Lifted: user 2026-10-27, B2 — CI e2e red').map((line) => line.slice(0, 2)), ['B2']))
      check(`5e S3 (${label}): a comma inside one item's text (no "B<n> —" after it) keeps it one item`, openOf(head(date), 'Blockers: B1 — token, rate limit, and the cache').length === 1 && jc.blockerLines({ heading: head(date), body: 'Blockers: B1 — token, rate limit, and the cache' }).length === 1)
    }
    check('5e S3 incident (KC-619 run 2 shape, old and new block): a comma inside prose that opens no blocker ("— (B1–B3 lifted: B1 — done, B2 — stage 7, B3 — stage 6)") splits nothing: 0 blockers', [OLD, NEW].every((date) => jc.blockerLines({ heading: head(date), body: 'Blockers: — (B1–B3 of run 1 lifted by the interview 2026-10-12: B1 — done, B2 — stage 7, B3 — stage 6)\n' }).length === 0))
    check('5e m-2 (old block): the field on the blocker\'s own line lifts on the word path, a denied value does not', same(openOf(head(OLD), '- B1 — x — Lifted: user 2026-10-28\n- B2 — x — Снят: решение пользователя 28.10.2026\n- B3 — x (lifted: user 2026-10-28)\n- B4 — x — Lifted: no 2026-10-28\n- B5 — x — Lifted: user\n').map((line) => line.slice(0, 4)), ['- B4', '- B5']))
    const B5 = '## Force run 2026-10-25 — x'
    check('5e m-2 (old block): an indented sub-item is NOT read on the word path (VT-1 B5: still open)', openOf(B5, '- B5 — x\n  - Lifted: user decision 2026-10-25 «do recommended one»\n').length === 1 && openOf(head(OLD), '- B1 — x\n  - Снят: пользователь 2026-10-28\n').length === 1)
    check('5e m-3a (new block): an inline "Blockers: B1 — …" field with one blocker reads the sub-item on the next line', openOf(head(NEW), 'Blockers: B1 — x\n  Lifted: user 2026-10-27\n').length === 0 && openOf(head(NEW), 'Blockers: B1 — x\n  - Снят: пользователь 27.10.2026\nГраницы:\n- y\n').length === 0)
    check('5e m-3a (new block): the sub-item of a field with two blockers lifts neither, and a sub-item with no date lifts nothing', openOf(head(NEW), 'Blockers: B1 — x; B2 — y\n  - Lifted: user 2026-10-27\n').length === 2 && openOf(head(NEW), 'Blockers: B1 — x\n  - Lifted: pending\n').length === 1)
    check('5e m-3b (new block): "B1: Lifted: …", "B2 - Lifted: …", "B3: x - Lifted: …" and "B4 (8): …" lift', openOf(head(NEW), '- B1: Lifted: user 2026-10-28\n- B2 - Lifted: user 2026-10-28\n- B3: x - Lifted: user 2026-10-28\n- B4 (8): Снят: пользователь 28.10.2026\n').length === 0 && jc.blockerLines({ heading: head(NEW), body: '- B1: Lifted: user 2026-10-28\n- B2 - Lifted: user 2026-10-28\n- B3: x - Lifted: user 2026-10-28\n- B4 (8): Снят: пользователь 28.10.2026\n' }).length === 4)
    const AFTER_ID = '- B1 (8) Lifted: user 2026-10-27\n- **B2** (9) **Lifted:** user 2026-10-27\n'
    check('5e m-3c (new block): "after the ID" is a real blocker line ("B1 (8) Lifted: …") and lifts', jc.blockerLines({ heading: head(NEW), body: AFTER_ID }).length === 2 && openOf(head(NEW), AFTER_ID).length === 0 && openOf(head(NEW), '- B1 (8) Lifted: no 2026-10-27\n').length === 1)
    check('5e m-4 incident (new block): the Russian measurement idiom "(<lift word>: …)" lifts nothing, with a date or without', openOf(head(NEW), '- B1 — `AC-2.7` бандл сверх бюджета (снят: 2026-10-28, `pnpm bundle-size` 540 КБ при бюджете 500) — нужно: решение\n- B2 — metrics-baseline (снят: yarn type-check = 218 ошибок)\n- B3 — CLS 0.094 на /cars; снят: замер devtools-verify 28.10.2026 — нужно: решение\n').length === 3)
    check('5e m-4 legit (new block): the capitalised Russian field after a dash lifts; the English label lifts in either case and after "("', openOf(head(NEW), '- B1 — x — Снят: решение пользователя 28.10.2026\n- B2 — x (lifted: user 2026-10-28)\n- B3 — x — lifted: user 2026-10-28\n- B4 — x (Lifted: user 2026-10-28)\n').length === 0)
    check('5e m-4: a Russian field after "(" does not lift (a parenthesis is not a segment for it)', openOf(head(NEW), '- B1 — x (Снят: пользователь 28.10.2026)\n').length === 1)
  }
  for (const [label, date] of [['new block', NEW], ['old block', OLD]]) {
    const items = openOf(head(date), 'Blockers: B1 — a; B1 (8) open still')
    check(`5e r1 m-2 (${label}): "B1 — a; B1 (8) open still" is two open items`, items.length === 2 && items[0].startsWith('B1 — a') && items[1].startsWith('B1 (8) open still'), JSON.stringify(items))
  }
  // one reader for every caller, the close rule agrees with the digest
  const setup = (language, date, extra) => {
    const dir = mkdtempSync(join(tmpdir(), 'blockers-5e-'))
    const task = join(dir, 'T-5E')
    const data = mkdtempSync(join(tmpdir(), 'blockers-5e-data-'))
    mkdirSync(join(task, 'checks'), { recursive: true })
    writeFileSync(join(task, 'STAGES.md'), `# T-5E: task\nЯзык: ru\n`)
    jc.baselineInfo(data, task)
    const open = run9(date, extra).replace(' — завершён с блокерами', ' —')
    writeFileSync(join(task, 'STAGES.md'), `# T-5E: task\nЯзык: ru\n\n${open.replace(/\n$/, '')}\n\n## Этапы\n\n### Этап 1: a  [status: done]\n`)
    return { dir, task, data }
  }
  for (const [label, date] of [['old block', OLD], ['new block', NEW]]) {
    const { dir, task, data } = setup('ru', date, '')
    const stages = readFileSync(join(task, 'STAGES.md'), 'utf8')
    // the close "completed" with no "with blockers" while both blockers are open
    writeFileSync(join(task, 'STAGES.md'), stages.replace(/^(## Force-прогон .*?) —\s*$/m, '$1 — завершён'))
    const closeText = readFileSync(join(task, 'STAGES.md'), 'utf8')
    writeFileSync(join(task, 'STAGES.md'), closeText.replace(/^(## Force-прогон \S+ \(9\).*?)(?: — завершён)?$/m, `## Force-прогон ${date} (9) — волна — завершён ${date}`))
    const violation = jc.forceCloseViolations(data, task).find(({ rule }) => rule === 'force-blockers')
    const short = runDigest(task, data, null, 'short')
    const listed = short.split('\n').filter((line) => /^- B\d/.test(line))
    check(`5e (${label}): the digest lists "B1 (8)" next to the current run's "B1", neither dropped`, listed.length === 2 && listed.some((line) => line.startsWith('- B1 (8) открыт')) && listed.some((line) => line.startsWith('- B1 — гидрация')), JSON.stringify(listed.map((line) => line.slice(0, 30))))
    check(`5e (${label}): the close rule counts the blockers the digest lists`, violation && violation.message.includes(`${listed.length} open blockers`), violation?.message)
    rmSync(dir, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  }
  {
    // legitimate: with the field on both lines of a new block the digest lists none and the close passes
    const { dir, task, data } = setup('ru', NEW, '')
    const lifted = readFileSync(join(task, 'STAGES.md'), 'utf8').replace(LIVE_B1, `${LIVE_B1} — Снят: пользователь 2026-10-27`).replace(LIVE_CARRIED, `${LIVE_CARRIED} Lifted: user 2026-10-27`)
    writeFileSync(join(task, 'STAGES.md'), lifted.replace(/^(## Force-прогон \S+ \(9\)).*$/m, `## Force-прогон ${NEW} (9) — волна — завершён ${NEW}`))
    check('5e legit (new block): both blockers carry the field — the digest lists none and the close passes', !runDigest(task, data, null, 'short').split('\n').some((line) => /^- B\d/.test(line)) && !jc.forceCloseViolations(data, task).some(({ rule }) => rule === 'force-blockers'), JSON.stringify(jc.forceCloseViolations(data, task)))
    rmSync(dir, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  }
  // K5: no caller reads blocker state from a bare body any more; K9: every caller passes the task gate along with the block
  for (const file of ['run-digest.mjs', 'ci-gates.mjs', 'receipts.mjs', 'journal-check.mjs']) {
    const text = readFileSync(join(PLUGIN, file), 'utf8')
    check(`5e K5: ${file} passes the Force block, with its date, to the blocker reader`, !/(?:openBlockers|blockerLines)\((?:[\w.]*\.)?body\)/.test(text))
    check(`5e K9: ${file} passes the task gate along with the block (no one-argument call of the blocker reader)`, !/(?:openBlockers|blockerLines)\(\s*[^(),]+\)/.test(text) && /blockerGate\(|bGate/.test(text))
  }
  // K9: the per-task gate of the fixed field. The femo-shaped incident block (the old plugin wrote it dated 2026-10-26, its prose lifts stay) and the legitimate block opened after the first look.
  {
    const dir = mkdtempSync(join(tmpdir(), 'blockers-k9-'))
    const task = join(dir, 'T-K9')
    const data = mkdtempSync(join(tmpdir(), 'blockers-k9-data-'))
    mkdirSync(join(task, 'checks'), { recursive: true })
    const FEMO = '## Force-прогон 2026-10-26 — завершён с блокерами 2026-10-26'
    const FEMO_BODY = 'Блокеры:\n- B1 — x — снят 2026-10-26 коммитом этапа 3 `656cc1e`\n- B2 — y — снят 2026-10-26 коммитом `abc1234`\n- B5 — z — открыт\n'
    writeFileSync(join(task, 'STAGES.md'), `# T-K9: task\nЯзык: ru\n\n${FEMO}\n${FEMO_BODY}`)
    jc.baselineInfo(data, task)
    const file = snapshotFile(data, task)
    // the first look of 0.18.2 was on 2026-10-27, the femo block was already there
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), since0182: '2026-10-27', blockerSeen: [markers.forceKey(FEMO)] }))
    const gate = jc.blockerGate(data, task)
    check('5e K9 incident (femo): a block dated 2026-10-26 that the snapshot held at the first look keeps its prose lifts: 1 open', same(jc.openBlockers({ heading: FEMO, body: FEMO_BODY }, gate).map((line) => line.slice(0, 4)), ['- B5']), JSON.stringify(jc.openBlockers({ heading: FEMO, body: FEMO_BODY }, gate)))
    check('5e K9: with no gate the reading is by the date alone (the prose lifts do not lift: 3 open)', jc.openBlockers({ heading: FEMO, body: FEMO_BODY }).length === 3)
    const NEWH = '## Force-прогон 2026-10-27 — x'
    const NEWB = '- B1 — a — снят 2026-10-27 коммитом `abc`\n- B2 — b — Lifted: user 2026-10-27\n- B3 — c\n'
    check('5e K9 legit: a block opened after the first look and dated on or after the floor is read by the fixed field (prose does not lift, `Lifted:` does)', same(jc.openBlockers({ heading: NEWH, body: NEWB }, gate).map((line) => line.slice(0, 4)), ['- B1', '- B3']))
    check('5e K9: the gate does not move a block dated before the floor (word matcher either way)', jc.openBlockers({ heading: '## Force-прогон 2026-10-20 — x', body: '- B1 — x снят пользователем\n' }, gate).length === 0)
    check('5e K9: blockerLines gets the same gate', jc.blockerLines({ heading: FEMO, body: FEMO_BODY }, gate).length === 3 && jc.blockerGate(data, task).since === '2026-10-27')
    // a snapshot from the 0.18 migration (since018 / forceSeen, no new mark) is migrated lazily and keeps its 0.18 marks
    const old = JSON.parse(readFileSync(file, 'utf8'))
    delete old.since0182
    delete old.blockerSeen
    writeFileSync(file, JSON.stringify({ ...old, since018: '2026-10-20', forceSeen: ['## Force-прогон 2026-10-19'] }))
    const migrated = jc.baselineInfo(data, task)
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    check('5e K9: a snapshot with the 0.18 marks and no new one gets only the new one; since018 and forceSeen stay', disk.since018 === '2026-10-20' && same(disk.forceSeen, ['## Force-прогон 2026-10-19']) && /^\d{4}-\d{2}-\d{2}$/.test(disk.since0182) && Array.isArray(disk.blockerSeen) && migrated.since === '2026-10-20' && migrated.since0182 === disk.since0182)
    // 5h (replaces K10, withdrawn): every block present at the first look is held, open or closed, whatever its date. A block written after it is read by the field.
    {
      const OPEN = '## Force run 2026-10-29'
      const OPEN_BODY = '- B1 — the CI gate hooks-test is red, closed by the token limit before the rerun — needed: rerun it\n'
      writeFileSync(join(task, 'STAGES.md'), `# T-K9: task\n\n${FEMO}\n${FEMO_BODY}\n${OPEN}\n${OPEN_BODY}`)
      const stale = JSON.parse(readFileSync(file, 'utf8'))
      delete stale.blockerSeen
      writeFileSync(file, JSON.stringify({ ...stale, since0182: '2026-11-03' }))
      const later = jc.blockerGate(data, task)
      const seen = JSON.parse(readFileSync(file, 'utf8')).blockerSeen
      check('5h (was K10, rewritten): a 0.18 snapshot migrates to every Force block present, the closed femo block and the open one alike', same([...seen].sort(), [markers.forceKey(FEMO), markers.forceKey(OPEN)].sort()), JSON.stringify(seen))
      check('5e K10 incident (femo shape): the closed block 2026-10-26 is held at a later first look: 1 open', same(jc.openBlockers({ heading: FEMO, body: FEMO_BODY }, later).map((line) => line.slice(0, 4)), ['- B5']))
      check('5h (was K10 m-1, rewritten: documents the cost): a block open at a later first look (2026-10-29, first look 2026-11-03) is held and read by words, so "closed by" lifts B1 (a second data dir that first reads a block 0.18.2 wrote does this)', jc.openBlockers({ heading: OPEN, body: OPEN_BODY }, later).length === 0 && jc.openBlockers({ heading: `${OPEN} — completed 2026-10-29`, body: OPEN_BODY }, later).length === 0)
      // a block written after the first look is not in the set: it is read by the field
      const NEW_AFTER = '## Force run 2026-10-30'
      check('5h legit: a block written after the first look is read by the field: prose does not lift, `Lifted: <who> <date> — <answer>` does', same(jc.openBlockers({ heading: NEW_AFTER, body: '- B1 — a — снят 2026-10-30 коммитом `abc`\n- B2 — b — Lifted: user 2026-10-30 — ok\n- B3 — c — closed by the user\n' }, later).map((line) => line.slice(0, 4)), ['- B1', '- B3']))
      writeFileSync(join(task, 'STAGES.md'), `# T-K9: task\n\n${FEMO}\n${FEMO_BODY}\n${OPEN}\n${OPEN_BODY}\n${NEW_AFTER} — completed 2026-10-30\nConfirmed: 2026-10-30 — x\n- B1 — the CI gate is red, closed by the token limit\n`)
      check('5h legit: the "completed" close of a block written after the first look over an open blocker is refused (force-blockers)', jc.forceCloseViolations(data, task).some(({ rule }) => rule === 'force-blockers'), JSON.stringify(jc.forceCloseViolations(data, task)))
      check('5e round 4 m-2: the force-blockers refusal of a block read by the field names the shape `Lifted: <who> <date> — <answer>` and the Russian form (5f: shape in the message)', jc.forceCloseViolations(data, task).some(({ rule, message }) => rule === 'force-blockers' && message.includes('`Lifted: <who> <date> — <answer>`') && message.includes('Russian form')), JSON.stringify(jc.forceCloseViolations(data, task).map(({ message }) => message.slice(-120))))
      check('5e K11 (m-2): in a held block the field on the blocker\'s own line lifts, the indented sub-item does not', same(jc.openBlockers({ heading: FEMO, body: 'Блокеры:\n- B1 — x — Lifted: user 2026-10-26\n- B2 — y\n  - Lifted: user 2026-10-26\n' }, later).map((line) => line.slice(0, 4)), ['- B2']))
      check('5e S4: the snapshot is written through a temp file and a rename: no temp file is left in the directory', existsSync(file) && !readdirSync(dirname(file)).some((name) => name.endsWith('.tmp')) && /renameSync\(temp, target\)/.test(readFileSync(join(PLUGIN, 'journal-check.mjs'), 'utf8')))
    }
    rmSync(dir, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  }
  // 5h incident: announcement-details run 12 (the 0.18.1 orchestrator writes it while 0.18.2 first reads the task): an OPEN block dated 2026-10-27 with Russian prose lifts keeps them, at a first look on its own day and on a later day
  {
    const RUN12 = '## Force-прогон 2026-10-27 (12)'
    const RUN12_BODY = 'Блокеры:\n- B1 — dev-api недоступен — ждём DevOps\n- B2 — dev-api отвечает 500 — **снят 2026-10-27**: пользователь сменил подключение, dev-api отвечает 200\n- B3 — (решение пользователя 2026-10-27) нужны данные бэкенда\n- B4 — лишний файл — **снят 2026-10-27**: пользователь согласился, файл удалён `git rm`\n'
    const open12 = (gate) => jc.openBlockers({ heading: RUN12, body: RUN12_BODY }, gate).map((line) => line.slice(0, 4))
    for (const [label, since] of [['own day', '2026-10-27'], ['later day', '2026-10-28']]) {
      const dir = mkdtempSync(join(tmpdir(), 'blockers-5h-'))
      const data = mkdtempSync(join(tmpdir(), 'blockers-5h-data-'))
      const task = join(dir, 'T-5H')
      mkdirSync(join(task, 'checks'), { recursive: true })
      writeFileSync(join(task, 'STAGES.md'), `# T-5H: task\nЯзык: ru\n\n${RUN12}\n${RUN12_BODY}`)
      jc.baselineInfo(data, task)
      const file = snapshotFile(data, task)
      // a 0.18 snapshot (no 0.18.2 mark) is migrated at the first look of the given day
      const old = JSON.parse(readFileSync(file, 'utf8'))
      delete old.blockerSeen
      writeFileSync(file, JSON.stringify({ ...old, since0182: since }))
      const gate = jc.blockerGate(data, task)
      check(`5h incident (run 12, ${label}): an open block dated 2026-10-27 with prose lifts keeps them at a first look on ${since}: only B1 stays open, B2, B3 and B4 lift by words, as on the base`, same(open12(gate), ['- B1']) && JSON.parse(readFileSync(file, 'utf8')).blockerSeen.includes(markers.forceKey(RUN12)), JSON.stringify(open12(gate)))
      rmSync(dir, { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    }
    // no snapshot at all: the first look is today, whatever today is
    const dir = mkdtempSync(join(tmpdir(), 'blockers-5h-'))
    const data = mkdtempSync(join(tmpdir(), 'blockers-5h-data-'))
    const task = join(dir, 'T-5H')
    mkdirSync(join(task, 'checks'), { recursive: true })
    writeFileSync(join(task, 'STAGES.md'), `# T-5H: task\nЯзык: ru\n\n${RUN12}\n${RUN12_BODY}`)
    check('5h incident (run 12, a fresh snapshot): the first look holds the open block of 2026-10-27 whatever the day of the look is', same(open12(jc.blockerGate(data, task)), ['- B1']))
    // a block written after that first look is read by the field
    writeFileSync(join(task, 'STAGES.md'), `# T-5H: task\nЯзык: ru\n\n${RUN12}\n${RUN12_BODY}\n## Force-прогон 2026-10-27 (13)\n- B1 — a — снят 2026-10-27 коммитом\n- B2 — b — Lifted: Mako 2026-10-27 — ok\n`)
    check('5h legit: the block (13) written after the first look is read by the field (prose does not lift, the field does), run 12 stays held', same(jc.openBlockers({ heading: '## Force-прогон 2026-10-27 (13)', body: '- B1 — a — снят 2026-10-27 коммитом\n- B2 — b — Lifted: Mako 2026-10-27 — ok\n' }, jc.blockerGate(data, task)).map((line) => line.slice(0, 4)), ['- B1']) && same(open12(jc.blockerGate(data, task)), ['- B1']))
    rmSync(dir, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  }
  // the summary template: no fence in the Output section, and the close message says plain markdown
  {
    const skill = readFileSync(join(PLUGIN, '../skills/stage-force/SKILL.md'), 'utf8')
    const output = skill.slice(skill.search(/^## Output/m))
    check('5e AC-5e.1: the stage-force "Output" section has no fenced block and says plain markdown, never inside a code block', !/^\s*(?:```|~~~)/m.test(output) && /plain markdown, never inside a code block/.test(output))
    const gate = readFileSync(join(PLUGIN, 'hooks/journal-gate.mjs'), 'utf8')
    check('5e AC-5e.1: the journal-gate close message says plain markdown, never inside a code block', /as plain markdown and never inside a code block/.test(gate))
    check('5e: the stage-force skill names the lift field and the carried form (K7)', /`Lifted: <who> <date>/.test(skill) && /B<n> \(<run>\)/.test(skill))
    const lang = readFileSync(join(PLUGIN, '../references/language.md'), 'utf8')
    check('5e A4: language.md has the marker row for the lift field in both languages', /`Lifted: <who> <date>[^|]*\| `Снят: /.test(lang))
  }
  // round 4 (final checks): M-1 — the value of the field is checked whole (K13); every probe line stays open in an old and a new block, the legitimate forms still lift
  {
    const PROBES = [
      '- B1 — CI e2e red — needs the token — Lifted: still pending (asked the user 2026-10-27)',
      '- B1 — CI e2e red — needs the token — Lifted: (pending, asked the user 2026-10-27)',
      '- B1 — CI e2e red — needs the token — Lifted: ⏳ asked the user 2026-10-27',
      '- B1 — CI e2e red — needs the token — Lifted: NO, asked 2026-10-27',
      '- B1 — CI e2e red — needs the token — Lifted: `no` (asked 2026-10-27)',
      '- B1 — CI e2e red — needs the token — Lifted: open, asked 2026-10-27',
      '- B1 — CI e2e red — needs the token — Lifted: false, 2026-10-27',
      '- B1 — CI e2e red — needs the token — Lifted: not needed, user 2026-10-27',
      '- B1 — CI e2e red — needs the token — Lifted: user? 2026-10-27',
      '- B1 — CI e2e red — needs the token — Lifted: ❌ 2026-10-27',
      '- B1 — CI e2e red — needs the token — Снят: пока нет (спросил 27.10.2026)',
      '- B1 — CI e2e red — needs the token — Снят: ещё нет, 27.10.2026',
      '- B2 — stage 7 waits for B1 (lifted: user 2026-10-27) and the token — needed: the token',
      '- B2 — stage 7 waits for B1 (lifted: user 2026-10-27), then the token',
    ]
    for (const [label, date] of [['old block', OLD], ['new block', NEW]]) {
      const still = PROBES.filter((line) => openOf(head(date), `${line}\n`).length !== 1)
      check(`5e round 4 M-1 (${label}): a value that says "not lifted" (a second word, upper case, a backtick, ⏳, ?, ❌, a Russian "not yet", another blocker's status in parentheses) keeps the blocker open on the line`, still.length === 0, JSON.stringify(still))
      const sub = PROBES.filter((line) => /Lifted|Снят/.test(line) && !line.includes('waits for') && openOf(head(date), `- B1 — a\n  - ${line.replace(/^.*?— (Lifted|Снят)/, '$1')}\n`).length !== 1)
      check(`5e round 4 M-1 (${label}): the same values on an indented sub-item${date === OLD ? ' (not read in an old block: open either way)' : ''}`, sub.length === 0, JSON.stringify(sub))
      check(`5e round 4 M-1 (${label}): the legitimate forms still lift (VT-1 B7 quote, the sub-item with a quote, the Russian decision, S3's closing parenthesis)`,
        openOf(head(date), '- B1 — x — Lifted: user decision 2026-10-20 «go with your suggestion». Done in run 6\n- B2 — y — Снят: решение пользователя 28.10.2026\n- B3 — a — token (Lifted: user 2026-10-27).\n').length === 0 &&
        (date === OLD || openOf(head(date), '- B4 — z\n  - Lifted: user decision 2026-10-23 «B7, yes»; fixed in run 6\n').length === 0))
    }
    check('5e round 4 M-1: a second lift field later on the line still lifts when its own value is real ("Lifted: no 2026-10-27 — Lifted: user 2026-10-27")', openOf(head(NEW), '- B1 — x — Lifted: no 2026-10-27 — Lifted: user 2026-10-27\n').length === 0)
  }
  // ── stage 5f (B1 and B2 of run 2026-10-25): the value of the lift field has a shape ──
  {
    const lineOf = (field) => `- B1 — CI e2e red — ${field}\n`
    const subOf = (field) => `- B1 — CI e2e red\n  - ${field}\n`
    const field = (line) => line.replace(/^.*? — (Lifted|Снят)/, '$1')
    // Incident: every probe line of the reviews stays open, in an old (2026-10-25) and a new (2026-10-29) block
    const INCIDENT = [
      // pro-review-branch-3 M-1 and security-review-branch-2 #2: another blocker's parenthesised field followed by a dash, `.` or `;`
      '- B2 — stage 7 waits for B1 (Lifted: user 2026-10-27) — needed: the token — recommend setting it',
      '- B2 — stage 7 waits for B1 (lifted: user 2026-10-27).',
      '- B2 — stage 7 waits for B1 (lifted: user 2026-10-27); needs the token',
      '- B3 — CI e2e red — depends on B2 (lifted: user 2026-10-27) — still red, needs the token',
      '- B3 — CI e2e red — see B2 (lifted: user 2026-10-27) — still red',
      '- B3 — CI e2e red — same root cause as B2 (lifted: user 2026-10-27).',
      // M-2: a condition or a request in the value
      '- B1 — CI e2e red — Lifted: once the user sets the token (asked 2026-10-27)',
      '- B1 — CI e2e red — Lifted: after the user answers, asked 2026-10-27',
      '- B1 — CI e2e red — Lifted: when the token is set (asked the user 2026-10-27)',
      '- B1 — CI e2e red — Lifted: needs the token from the user, asked 2026-10-27',
      '- B1 — CI e2e red — Lifted: to be confirmed by the user, asked 2026-10-27',
      '- B1 — CI e2e red — Lifted: unresolved, asked the user 2026-10-27',
      // security #1: requests and statuses, and a "no" after the date
      '- B1 — CI e2e red — Lifted: needs a user decision 2026-10-27',
      '- B1 — CI e2e red — Lifted: requires a user decision 2026-10-27',
      '- B1 — CI e2e red — Lifted: waits for user 2026-10-27',
      '- B1 — CI e2e red — Lifted: asked the user 2026-10-27, no answer yet',
      '- B1 — CI e2e red — Lifted: blocked until 2026-10-30',
      '- B1 — CI e2e red — Lifted: unresolved 2026-10-27',
      '- B1 — CI e2e red — Lifted: awaits the user, asked 2026-10-27',
      '- B1 — CI e2e red — Lifted: user will decide after 2026-10-30',
      '- B1 — CI e2e red — Lifted: user 2026-10-27 until the token is set',
      '- B1 — CI e2e red — Lifted: user decision of the whole team in the call 2026-10-27',
      '- B1 — CI e2e red — Снят: нужно решение пользователя 27.10.2026',
      '- B1 — CI e2e red — Снят: после ответа пользователя 27.10.2026',
      '- B1 — CI e2e red — Снят: когда токен будет задан, спросил 27.10.2026',
      // B2 m-2: a dateless Russian "not yet"
      '- B1 — e2e — Снят: пока нет',
      '- B1 — e2e — Снят: нет, ждём токен',
      // 5g, M-1 (pro-review-branch-4): a value that is only a quote has no who, and a quote is not a letter
      '- B1 — CI e2e red — Lifted: "no" 2026-10-27',
      '- B1 — CI e2e red — Lifted: "not yet" 2026-10-27',
      '- B1 — CI e2e red — Lifted: «pending» (2026-10-27)',
      '- B1 — CI e2e red — Lifted: "waiting for the user" 2026-10-27',
      '- B1 — CI e2e red — Lifted: “still open” 2026-10-27',
      '- B1 — CI e2e red — Lifted: "needs a user decision" 2026-10-27',
      '- B1 — CI e2e red — Снят: «нет» 27.10.2026',
      // 5g, M-2: a refused field after "user decision" or "user answer" (the word path of an old block must not bridge the blank to the date)
      '- B1 — CI e2e red — what is needed from you: a user decision. Lifted: 2026-10-27, pending the token',
      '- B1 — CI e2e red — user answer — Lifted: 2026-10-27 needs a retry',
      '- B1 — CI e2e red — user decision; Lifted: 2026-10-27, waiting for the token',
      '- B1 — CI e2e red — user answer — Lifted: "pending" until 2026-10-30',
      '- B1 — CI e2e red — user decision (lifted: 2026-10-27) and more',
    ]
    for (const [label, date] of [['old block', '2026-10-25'], ['new block', '2026-10-29']]) {
      const still = INCIDENT.filter((line) => openOf(head(date), `${line}\n`).length !== 1)
      check(`5f incident (${label}): every probe line of M-1, M-2, #1, #2 and the dateless "not yet" keeps the blocker open`, still.length === 0, JSON.stringify(still))
      const sub = INCIDENT.filter((line) => /Lifted|Снят/.test(line) && !/^- B\d — (?:stage|CI e2e red — (?:depends|see|same))/.test(line) && openOf(head(date), subOf(field(line))).length !== 1)
      check(`5f incident (${label}): the field-value probes on an indented sub-item stay open${date === '2026-10-25' ? ' (not read in an old block: open either way)' : ''}`, sub.length === 0, JSON.stringify(sub))
    }
    // Legitimate: VT-1's live lifts (the blocker lines and the sub-items), the user's own form, the quoted answers, the Russian decision, the closing parenthesis
    const vt1 = [
      '- B1 — what is blocked: stage 3 `AC-3.3`, the «completed with blockers» half, plus the receipts edge cases (checks/pro-review-3-fresh-2.md M-1, M-2, m-1…m-4). Why: the fix loop is exhausted (2 rounds plus the fresh opus check). Lifted: user decision 2026-10-20 «go with your suggestion». Done in the 2026-10-20 run, stage 5d.',
      '- B2 — what is blocked: both PRs of this run (`fix/audit-hooks` 0.16.3 and `feat/verified-runs` 0.18.0); no stage. Why: main got two squash merges. Lifted: user decision 2026-10-20 «rebase both»; done in run 4.',
      '- B3 — what is blocked: stage 5c, the rebase onto `origin/main`. Why: the permission layer denied `git rebase`. Lifted: user decision 2026-10-20 «go»; the user ran it.',
      '- B4 — what is blocked: three minor findings of the fresh whole-branch review. Why: the final-check loop is exhausted. Lifted: user decision 2026-10-23 «ok»; fixed in run 4 (`c2534bf`), and what that round left is B6 of run 5.',
      '- B6 — what is blocked: `AC-5b.1` on one input. Why: the final-check loop of this run is exhausted. Lifted: user decision 2026-10-23 «B6 yes»; fixed in run 5 (`31e3e40`), and what run 5 left is its B7.',
    ]
    const VT1_SUB = [
      ['- B7 — what is blocked: three minor findings', '  - Lifted: user decision 2026-10-23 «B7, yes»; fixed in run 6 (`b366edc`, `5d1b57d`), and what run 6 left is its B8.'],
      ['- B8 — what is blocked: one input', '  - Lifted: user decision 2026-10-25 «a»; done in run 7 (`0494f32`, `b7cff0e`), and the one input left (a multi-word `isolatedContext`) is deferred to 0.18.2 under the stopping rule.'],
      ['- B9 — what is blocked: the rebase', '  - Lifted: user decision 2026-10-25 «do recommended one»; PR #12 squash-merged 2026-10-26 as `68c1bf1`, and the live tree fast-forwarded to it.'],
    ]
    const LEGIT = [
      'Lifted: Mako 2026-10-27 — yes, fold all four into B1\'s round. The minors are: x',
      'Lifted: user decision «no e2e for now» 2026-10-27',
      'Снят: решение «не делать» 27.10.2026',
      'Снят: 27.10.2026 пользователем',
      'Lifted: 2026-10-27 user decision «no»',
      'Снят: решение пользователя 28.10.2026',
      'Lifted: Mako in chat 2026-10-27 — needs nothing more, no further answer is open',
      'Lifted: user decision 2026-10-27 «no, keep v1» — done in stage 3',
    ]
    for (const [label, date] of [['old block', '2026-10-25'], ['new block', '2026-10-29']]) {
      const closed = vt1.filter((line) => openOf(head(date), `${line}\n`).length !== 0)
      check(`5f legit (${label}): VT-1's live lift lines (B1-B4, B6) lift`, closed.length === 0, JSON.stringify(closed.map((line) => line.slice(0, 6))))
      const lifted = LEGIT.filter((line) => openOf(head(date), lineOf(line)).length !== 0)
      check(`5f legit (${label}): the user's own form, the quoted answers with "no" / "не", a date first, the Russian decision lift`, lifted.length === 0, JSON.stringify(lifted))
      check(`5f legit (${label}): "(Lifted: user 2026-10-27)." and "(Lifted: user 2026-10-27);" at the line end lift`, openOf(head(date), '- B1 — token (Lifted: user 2026-10-27).\n- B2 — token (Lifted: user 2026-10-27)\n- B3 — token; (Lifted: user 2026-10-27);\n').length === 0)
    }
    const subLifted = VT1_SUB.filter(([a, b]) => openOf(head('2026-10-29'), `${a}\n${b}\n`).length !== 0)
    check('5f legit (new block): VT-1\'s live sub-item lifts (B7, B8, B9 shape) lift', subLifted.length === 0, JSON.stringify(subLifted.map(([a]) => a.slice(0, 6))))
    const subLegit = LEGIT.filter((line) => openOf(head('2026-10-29'), subOf(line)).length !== 0)
    check('5f legit (new block): the user\'s forms lift on an indented sub-item too', subLegit.length === 0, JSON.stringify(subLegit))
    check('5f shape: a who of five words does not lift, four do; a date first needs no who', openOf(head('2026-10-29'), '- B1 — x — Lifted: one two three four five 2026-10-27\n- B2 — x — Lifted: one two three four 2026-10-27\n- B3 — x — Lifted: 2026-10-27\n').length === 1)
    check('5f shape: the request words are read in the segment only; the answer after a dash is free text', openOf(head('2026-10-29'), '- B1 — x — Lifted: user 2026-10-27 — needs nothing, will not return\n- B2 — x — Lifted: user 2026-10-27; waits for nobody\n').length === 0 && openOf(head('2026-10-29'), '- B1 — x — Lifted: user 2026-10-27 will return\n').length === 1)
    check('5f shape: a quoted request word does not refuse ("«once the token is set» 2026-10-27" is the answer), a backtick stays in the value', openOf(head('2026-10-29'), '- B1 — x — Lifted: user decision «once the token is set» 2026-10-27\n').length === 0 && openOf(head('2026-10-29'), '- B1 — x — Lifted: `no` 2026-10-27\n').length === 1)
    check('5g M-1: a quote may stand in the who after a who word or after the date, and a quote-only value reads open', openOf(head('2026-10-29'), '- B1 — x — Lifted: user «no» 2026-10-27\n- B2 — x — Lifted: 2026-10-27 «no»\n').length === 0 && openOf(head('2026-10-29'), '- B1 — x — Lifted: «no» 2026-10-27\n').length === 1)
    check('5f #2: a "(" opener lifts only when its ")" ends the line: a second parenthesis or text after it keeps the blocker open', openOf(head('2026-10-29'), '- B1 — x (Lifted: user 2026-10-27) (see B2)\n- B2 — x (Lifted: user 2026-10-27) done\n- B3 — x (Lifted: user 2026-10-27\n').length === 3)
    // the refusal says the shape
    {
      const dir = mkdtempSync(join(tmpdir(), 'blockers-5f-'))
      const data = mkdtempSync(join(tmpdir(), 'blockers-5f-data-'))
      const task = join(dir, 'T-5F')
      mkdirSync(join(task, 'checks'), { recursive: true })
      writeFileSync(join(task, 'STAGES.md'), '# T-5F: task\nLanguage: en\n')
      jc.baselineInfo(data, task)
      writeFileSync(join(task, 'STAGES.md'), '# T-5F: task\nLanguage: en\n\n## Force run 2026-10-29 — completed 2026-10-29\nConfirmed: 2026-10-29 — x\nBlockers:\n- B1 — CI red — Lifted: needs a user decision 2026-10-29\n')
      const violation = jc.forceCloseViolations(data, task).find(({ rule }) => rule === 'force-blockers')
      check('5f m-3: the refusal names the shape `Lifted: <who> <date> — <answer>`, the 4-word who and the answer after the date', !!violation && violation.message.includes('`Lifted: <who> <date> — <answer>`') && /at most 4 words/.test(violation.message) && /answer comes after the date/.test(violation.message), violation?.message.slice(-300))
      rmSync(dir, { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    }
    // A11 (rewritten by 5h; its 5f form held a block that was already in the file, and under 5h every block present at the first look is held, so it no longer told a snapshot taken before the call from one taken after):
    // a Bash call that writes a whole closed block dated before the first-look day is read by the field, because the snapshot was taken before the call and the block was not in it.
    {
      const bApp = join(gRoot, 'bash-first-look')
      repoAt(bApp, 'main')
      const bTask = join(bApp, '.claude/tasks/T-9F')
      const empty = '# T-9F: task\nBranch: `T-9F/feat/g`\n\n## Stages\n\n### Stage 1: a  [status: done]\n'
      const block = '## Force run 2026-10-26 — completed 2026-10-26\nConfirmed: 2026-10-26 — x\nBlockers:\n- B1 — CI e2e red — resolved by a retry, per the log\n\n'
      write(bApp, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n', '.claude/tasks/T-9F/STAGES.md': empty })
      git(bApp, 'checkout', '-qb', 'T-9F/feat/g')
      const close = bashGate(bApp, `python3 close.py ${join(bTask, 'STAGES.md')}`, () => writeFileSync(join(bTask, 'STAGES.md'), empty.replace('## Stages', `${block}## Stages`)))
      check('5f A11 (5h): a Bash call that writes a closed block dated before the first-look day over an open blocker is refused (the snapshot was taken before the call, so the block was not held)', close.decision === 'block' && /open blockers/.test(close.text), `${close.decision} ${close.text.slice(0, 200)}`)
    }
  }
  // linear time: the new patterns on 50 000 characters of pathological input
  {
    const pad = (unit) => unit.repeat(Math.ceil(50_000 / unit.length))
    const inputs = [`- B1 — ${pad(';  ')}`, `- B1 — ${pad('. ')}x`, `- B1 — ${pad('(')}`, `- B1 — ${pad(';*')}`, `- B1 — x ${' '.repeat(50_000)}Lifted:`, `- B1 ${' '.repeat(50_000)}(8)${' '.repeat(50_000)}`, `- B1 (1)${pad('*')}`, `- B1${'*'.repeat(100_000)} — x`, `- B1 (8)${'*'.repeat(100_000)} — x`, `- B1 — x${'*'.repeat(100_000)}Lifted: user`, `- B1 — x — Lifted:${'*'.repeat(100_000)} 2026-10-27`, `- B1 — x${pad(' - ')}Lifted:`, `Blockers: ${pad('**B1** — x, ')}`, `- B1 (${pad('1')}`, `- B1 — x\n${pad('  - ')}\n`, `- B1 — x\n${pad('  \n')}  - Lifted:`, `Blockers: ${pad('B1 (8) ')}`, Array.from({ length: 2000 }, (_, i) => `${' '.repeat(i)}Blockers: B${i} — x`).join('\n'), `Blockers: ${pad('B1 — x. ')}`, `${pad('- B1 — x\n  - y\n')}`, `${pad('- B1 (8) x\n')}`, `Ответы интервью:\n${pad('- B1 (8) — x\n')}`, `- B1 — x Lifted: ${' '.repeat(50_000)}`, `- B1 — x Lifted: ${pad('x ')}`, `- B1 — ${pad('Lifted: x ')}`, `- B1 — x\n${pad('  - Lifted: ')}`, `Blockers: ${pad('B1 (8) x; ')}`, `Blockers: ${pad('B1 (8')}`]
    const worst = { ms: 0, input: '' }
    for (const body of inputs) for (const heading of [head(OLD), head(NEW)]) {
      const t0 = performance.now()
      jc.openBlockers({ heading, body })
      const ms = performance.now() - t0
      if (ms > worst.ms) Object.assign(worst, { ms, input: body.slice(0, 24) })
    }
    check('5e: openBlockers on 50 000 characters of pathological input (the lift field, the carried form, sub-items, the interview field) < 100 ms', worst.ms < 100, `${worst.ms.toFixed(0)} ms on "${worst.input}"`)
  }
  // 5f (B2 m-1, security #3) and 5g (M-3, A15): one blocker line of 1 MB of lift fields, in an old block and a new one, one read under 250 ms
  {
    const worst = { ms: 0, input: '' }
    for (const unit of ['; Lifted: no 2026-10-27', ' — Снят: пока нет 27.10.2026', '(lifted: a 2026-10-27 ', '. Lifted: user 2026-10-27 needs', '. Снят: пока нет ', '; Lifted: x', '; Снят: ']) {
      const body = `- B1 — x ${unit.repeat(Math.ceil(1_000_000 / unit.length))}\n`
      for (const heading of [head('2026-10-20'), head('2026-10-29')]) {
        const t0 = performance.now()
        jc.openBlockers({ heading, body })
        const ms = performance.now() - t0
        if (ms > worst.ms) Object.assign(worst, { ms, input: unit })
      }
    }
    check('5f: openBlockers on one 1 MB line of lift fields (refused values, a parenthesis that never closes, request words), old and new block, the units `; Lifted: x` and the Russian label unit included, < 250 ms per read', worst.ms < 250, `${worst.ms.toFixed(0)} ms on "${worst.input}"`)
  }
}

// ── VT-3 stage 6: the eval harness isolates the plugin data dir ──────────────
{
  // Claude Code overwrites CLAUDE_PLUGIN_DATA for hooks, so the harness needs a variable of its own that wins over it.
  const a = mkdtempSync(join(tmpdir(), 'pd-override-'))
  const b = mkdtempSync(join(tmpdir(), 'pd-claude-'))
  const dirOf = (extra) => {
    const env = { ...process.env, ...extra }
    for (const key of ['STAGE_PIPELINE_DATA_DIR', 'CLAUDE_PLUGIN_DATA']) if (extra[key] === undefined) delete env[key]
    return spawnSync(process.execPath, ['--input-type=module', '-e', `import { pluginDataDir } from ${JSON.stringify(join(PLUGIN, 'hooks/pipeline-state.mjs'))}; console.log(pluginDataDir())`], { env, encoding: 'utf8' }).stdout.trim()
  }
  check('data dir: STAGE_PIPELINE_DATA_DIR wins over CLAUDE_PLUGIN_DATA', dirOf({ STAGE_PIPELINE_DATA_DIR: a, CLAUDE_PLUGIN_DATA: b }) === a, dirOf({ STAGE_PIPELINE_DATA_DIR: a, CLAUDE_PLUGIN_DATA: b }))
  check('data dir legit: without the override CLAUDE_PLUGIN_DATA is used as before', dirOf({ CLAUDE_PLUGIN_DATA: b }) === b, dirOf({ CLAUDE_PLUGIN_DATA: b }))
  check('data dir: a relative or empty override is ignored', dirOf({ STAGE_PIPELINE_DATA_DIR: 'relative/dir', CLAUDE_PLUGIN_DATA: b }) === b && dirOf({ STAGE_PIPELINE_DATA_DIR: '', CLAUDE_PLUGIN_DATA: b }) === b)
  rmSync(a, { recursive: true, force: true })
  rmSync(b, { recursive: true, force: true })
}

// ── VT-3 stage 7a: hook firings log (AC-7.2) ─────────────────────────────────
// Every block or deny of the five hooks appends {rule, task, repo, ts, tool, read} to <plugin data>/firings.jsonl: IDs and paths only, rotated, and a failing write never changes the verdict.
{
  const { isRead, readOnlyBash } = await import(join(PLUGIN, 'hooks/firing.mjs'))
  const iso = mkdtempSync(join(tmpdir(), 'firings-iso-'))
  const fx = mkdtempSync(join(tmpdir(), 'firings-fx-'))
  const fxApp = join(fx, 'app')
  const fxHome = join(fx, 'home')
  repoAt(fxApp, 'main')
  write(fxHome, { '.claude/settings.json': JSON.stringify({ permissions: { ask: ['Bash(pkill *)', 'Bash(git push *)'] } }) })
  write(fxApp, {
    '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n',
    '.claude/tasks/T-9/STAGES.md': stages('T-9', 'T-9/feat/f', { force: '## Force-прогон 2026-10-03\nПодтверждено: 03.10.2026 — да\n\n' }),
    '.claude/tasks/T-10/STAGES.md': stages('T-10', 'T-10/feat/n'),
    '.claude/tasks/T-11/STAGES.md': stages('T-11', 'T-11/feat/u', { force: '## Force-прогон 2026-10-20\nРежим: автономный.\n\n' }),
  })
  const hookRun = (name, input, env = {}) =>
    spawnSync(process.execPath, [join(PLUGIN, 'hooks', name)], {
      input: JSON.stringify({ cwd: fxApp, ...input }),
      encoding: 'utf8',
      env: { ...process.env, HOME: fxHome, CLAUDE_PROJECT_DIR: fxApp, STAGE_PIPELINE_DATA_DIR: iso, ...env },
    })
  const rowsIn = (dir, name = 'firings.jsonl') => {
    try {
      return readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  const bash = (command) => ({ tool_name: 'Bash', hook_event_name: 'PreToolUse', tool_input: { command } })
  const agent = (subagent_type, prompt, model) => ({ tool_name: 'Agent', hook_event_name: 'PreToolUse', tool_input: { subagent_type, prompt, ...(model ? { model } : {}) } })
  const last = () => rowsIn(iso).at(-1)
  const top = realpathSync(fxApp)

  git(fxApp, 'checkout', '-qb', 'T-9/feat/f')
  const killed = hookRun('force-guard.mjs', bash('pkill -f vite'))
  check('firings AC-7.2: pkill in force — denied as before and a row force-guard/kill-by-name with task, repo, ts, tool', killed.stdout.includes('permissionDecision":"deny"') && last()?.rule === 'force-guard/kill-by-name' && last().task === 'T-9' && last().repo === top && last().tool === 'Bash' && last().read === false && !Number.isNaN(Date.parse(last().ts)), JSON.stringify(last()))
  hookRun('force-guard.mjs', bash('git push origin T-9/feat/f'))
  check('firings AC-7.2: git push under an ask rule — force-guard/ask-rule', last()?.rule === 'force-guard/ask-rule' && last().task === 'T-9', JSON.stringify(last()))
  hookRun('git-guard.mjs', bash('git commit -am "x\n\nCo-Authored-By: C <c@d.e>"'))
  check('firings AC-7.2: a signature in a force commit — git-guard/service-trailer', last()?.rule === 'git-guard/service-trailer' && last().task === 'T-9', JSON.stringify(last()))
  hookRun('agent-guard.mjs', agent('stage-pipeline:pro-review', 'Ticket T-9, whole-branch mode.', 'sonnet'))
  check('firings AC-7.2: whole-branch pro-review off review_model — agent-guard/review-model, tool Agent', last()?.rule === 'agent-guard/review-model' && last().tool === 'Agent', JSON.stringify(last()))
  git(fxApp, 'checkout', '-q', 'main')
  git(fxApp, 'checkout', '-qb', 'T-10/feat/n')
  hookRun('git-guard.mjs', bash('git add -A'))
  check('firings AC-7.2: git add in normal mode — git-guard/normal-mode', last()?.rule === 'git-guard/normal-mode' && last().task === 'T-10', JSON.stringify(last()))
  git(fxApp, 'checkout', '-q', 'main')
  git(fxApp, 'checkout', '-qb', 'T-11/feat/u')
  hookRun('agent-guard.mjs', agent('stage-pipeline:stage-implement', 'Ticket T-11, stage 1, implement mode'))
  check('firings AC-7.2: stage-implement before the interview is confirmed — agent-guard/no-confirmed', last()?.rule === 'agent-guard/no-confirmed' && last().task === 'T-11', JSON.stringify(last()))
  git(fxApp, 'checkout', '-q', 'main')
  git(fxApp, 'checkout', '-q', 'T-9/feat/f')

  // IDs and paths only: neither a command nor a reason text reaches the log
  const raw = readFileSync(join(iso, 'firings.jsonl'), 'utf8')
  check('firings: no command text, message or file content in the log', !/pkill|vite|git push|Co-Authored|noreply|stage-pipeline:|review_model/.test(raw), raw.slice(0, 300))
  check('firings legit: an allowed call (a clean read-only command in force) writes no row', (() => {
    const before = rowsIn(iso).length
    hookRun('force-guard.mjs', bash('ls -la'))
    hookRun('git-guard.mjs', bash('git status'))
    return rowsIn(iso).length === before
  })())

  // the verdict does not depend on the log: a data directory that cannot be created gives the same denial
  const blocker = join(fx, 'not-a-dir')
  writeFileSync(blocker, 'x')
  const withLog = hookRun('force-guard.mjs', bash('pkill -f vite'))
  const noLog = hookRun('force-guard.mjs', bash('pkill -f vite'), { STAGE_PIPELINE_DATA_DIR: join(blocker, 'sub') })
  check('firings AC-7.2: a log that cannot be written keeps the verdict (same stdout, exit 0)', noLog.status === 0 && noLog.stdout === withLog.stdout && noLog.stdout.includes('"deny"'), noLog.stdout.slice(0, 120) + noLog.stderr.slice(0, 120))
  const noLogAgent = hookRun('agent-guard.mjs', agent('stage-pipeline:pro-review', 'Ticket T-9, whole-branch mode.', 'sonnet'), { STAGE_PIPELINE_DATA_DIR: join(blocker, 'sub') })
  check('firings: a log that cannot be written keeps the agent-guard denial too', noLogAgent.status === 0 && noLogAgent.stdout.includes('"deny"'), noLogAgent.stdout.slice(0, 120))

  // rotation: past the cap the file becomes .1 and a new one starts; nothing grows without a bound
  const small = mkdtempSync(join(tmpdir(), 'firings-rot-'))
  for (let n = 0; n < 12; n++) hookRun('force-guard.mjs', bash('pkill -f vite'), { STAGE_PIPELINE_DATA_DIR: small, STAGE_PIPELINE_FIRINGS_MAX: '700' })
  const live = rowsIn(small)
  const old = rowsIn(small, 'firings.jsonl.1')
  const size = (name) => {
    try {
      return statSync(join(small, name)).size
    } catch {
      return 0
    }
  }
  check('firings AC-7.2: rotation - past the size cap the log becomes firings.jsonl.1 and a new file starts', old.length > 0 && live.length > 0 && size('firings.jsonl') < 700 + 400 && size('firings.jsonl.1') < 700 + 400, `live ${live.length} (${size('firings.jsonl')} B), old ${old.length} (${size('firings.jsonl.1')} B)`)
  check('firings: rotation keeps one older generation only', !existsSync(join(small, 'firings.jsonl.2')) && live.length + old.length <= 12)

  // retro.mjs prints the counts per rule, the repeats per task and the firings on reads, from the rows the hooks wrote
  const retroTask = join(fx, 'retro-task')
  write(retroTask, { 'STAGES.md': stages('T-9', 'T-9/feat/f') })
  const reads = [{ rule: 'journal-gate/journal', task: 'T-3', repo: '/r', ts: new Date().toISOString(), tool: 'Bash', read: true, event: 'PostToolUse' }]
  appendFileSync(join(iso, 'firings.jsonl'), `${reads.map((row) => JSON.stringify(row)).join('\n')}\nnot json\n`)
  const printed = spawnSync(process.execPath, [join(PLUGIN, 'retro.mjs'), retroTask], { encoding: 'utf8', env: { ...process.env, STAGE_PIPELINE_DATA_DIR: iso } }).stdout
  check('firings AC-7.2: retro prints firings per rule', /## Hook firings/.test(printed) && /\| force-guard\/kill-by-name \| 2 \| 1 \| 0 \|/.test(printed) && /\| force-guard\/ask-rule \| 1 \| 1 \| 0 \|/.test(printed), printed.split('## Hook firings')[1])
  check('firings AC-7.2: retro prints repeats per task (same rule, same task, more than once)', /- T-9 \/ force-guard\/kill-by-name: 2/.test(printed) && !/- T-9 \/ force-guard\/ask-rule/.test(printed), printed.split('Repeats per task')[1])
  check('firings AC-7.2: retro prints firings on reads', /- journal-gate\/journal: 1 of 1/.test(printed), printed.split('Firings on reads')[1])
  check('firings legit: retro on an empty data directory says none logged and keeps the other sections', (() => {
    const out = spawnSync(process.execPath, [join(PLUGIN, 'retro.mjs'), retroTask], { encoding: 'utf8', env: { ...process.env, STAGE_PIPELINE_DATA_DIR: join(fx, 'empty') } }).stdout
    return /- none logged/.test(out) && /## Fix-loop/.test(out) && /## Checkers/.test(out)
  })())
  check('firings: retro --firings reads another file', /\| journal-gate\/journal \| 1 \|/.test(spawnSync(process.execPath, [join(PLUGIN, 'retro.mjs'), retroTask, '--firings', join(iso, 'firings.jsonl')], { encoding: 'utf8' }).stdout))

  // what counts as a read: the call changes nothing, judged from the input only
  check('firings: Read, Grep and Glob are reads', ['Read', 'Grep', 'Glob'].every((tool_name) => isRead({ tool_name })) && !isRead({ tool_name: 'Edit' }) && !isRead({ tool_name: 'Agent' }))
  check('firings: read-only Bash is a read (cat, ls | wc, git status/log/diff, sed -n, a /dev/null redirect)', ['cat a.md', 'ls -la | wc -l', 'git status', 'git log --oneline -5', 'git diff HEAD', "sed -n '1,5p' f", 'grep -rn x . 2>/dev/null', 'git status && git diff'].every(readOnlyBash))
  check('firings legit: Bash that writes or runs code is not a read (git commit, rm, a redirect, sed -i, node, a subshell, tee)', ['git commit -m x', 'git add -A', 'rm -rf x', 'cat a > b', 'sed -i s/a/b/ f', 'node x.mjs', 'echo $(rm x)', 'ls | tee out', 'cat a && rm a', ''].every((command) => !readOnlyBash(command)))
  check('firings: git branch, remote, config, worktree and stash are reads only in a listing form', ['git branch', 'git branch --list', 'git branch -a', 'git branch -vv', 'git stash list', 'git stash show -p', 'git config --get user.name', 'git config --list', 'git remote -v', 'git remote show origin', 'git worktree list', 'find . -name x', 'sort a'].every(readOnlyBash))
  check('firings legit: git branch NAME, branch -D, stash, stash pop, config KEY VALUE, remote add, worktree add, find -delete/-exec/-fprint and sort -o are not reads', ['git branch feature', 'git branch -D x', 'git stash', 'git stash push', 'git stash pop', 'git config user.name x', 'git remote add o u', 'git remote remove o', 'git worktree add ../x', 'git worktree remove x', 'find . -delete', 'find . -exec rm {} \\;', 'find . -name x -execdir ls \\;', 'find . -ok rm {} \\;', 'find . -fprint out', 'sort -o out a', 'sort a -o out', 'sort --output=out a'].every((command) => !readOnlyBash(command)))

  // every rule ID of the hooks wrote a row somewhere in this suite (the fixtures above and all the earlier ones ran against the one data directory)
  const suiteDir = process.env.STAGE_PIPELINE_DATA_DIR?.startsWith('/') ? process.env.STAGE_PIPELINE_DATA_DIR : DATA
  const written = new Set([...rowsIn(suiteDir, 'firings.jsonl.1'), ...rowsIn(suiteDir)].map((row) => row.rule))
  const ids = new Set()
  for (const hookName of ['journal-gate', 'git-guard', 'agent-guard', 'force-guard', 'frames-guard']) {
    for (const m of readFileSync(join(PLUGIN, 'hooks', `${hookName}.mjs`), 'utf8').matchAll(new RegExp(`'(${hookName}/[a-z0-9-]+)'`, 'g'))) ids.add(m[1])
  }
  for (const id of [...ids].sort()) check(`firings AC-7.2: ${id} wrote a row in this suite`, written.has(id))
  check('firings: the suite found the rule IDs it should (21 at this stage, never fewer)', ids.size >= 21, `${ids.size}`)
  check('firings: every row of the suite has the fields retro needs', [...rowsIn(suiteDir)].every((row) => typeof row.rule === 'string' && 'task' in row && typeof row.repo === 'string' && typeof row.ts === 'string' && typeof row.tool === 'string' && typeof row.read === 'boolean'))

  for (const dir of [iso, fx, small]) rmSync(dir, { recursive: true, force: true })
}

// ── VT-3 final checks: retro's «Hook firings» is scoped to the retro targets and counts blocks (appended: D3) ──────────────────────────────────
{
  const scope = mkdtempSync(join(tmpdir(), 'retro-scope-'))
  const repoA = join(scope, 'repo-a')
  const repoB = join(scope, 'repo-b')
  mkdirSync(join(repoA, '.git'), { recursive: true })
  mkdirSync(join(repoB, '.git'), { recursive: true })
  write(repoA, { 'T-1/STAGES.md': stages('T-1', 'T-1/feat/a') })
  const at = '2026-10-27T10:00:00.000Z'
  const row = (rule, repo, ts, extra = {}) => JSON.stringify({ rule, task: 'T-1', repo, ts, tool: 'Bash', read: false, event: 'PostToolUse', ...extra })
  const logFile = join(scope, 'firings.jsonl')
  // repo A: one journal-gate block naming three rules (one moment) and one force-guard denial; repo B: a block that must not be counted for A
  writeFileSync(logFile, [
    row('journal-gate/close', repoA, at), row('journal-gate/journal', repoA, at), row('journal-gate/report', repoA, at),
    row('force-guard/ask-rule', repoA, '2026-10-27T10:05:00.000Z', { event: 'PreToolUse' }),
    row('git-guard/normal-mode', repoB, at, { event: 'PreToolUse' }),
  ].join('\n') + '\n')
  const retroOf = (...extra) => spawnSync(process.execPath, [join(PLUGIN, 'retro.mjs'), repoA, '--firings', logFile, ...extra], { encoding: 'utf8' }).stdout
  const scoped = retroOf()
  check('firings m-6: retro counts only the rows under the retro target', /- scope: rows under .*repo-a \(4 of 5 rows/.test(scoped) && !/git-guard\/normal-mode/.test(scoped), scoped.split('## Hook firings')[1])
  check('firings m-6: a block that names three rules counts once in the headline (2 blocks, 4 rule rows) and once per rule in the table', /- blocks: 2 \(4 rule rows/.test(scoped) && /\| journal-gate\/close \| 1 \| 1 \| 0 \|/.test(scoped), scoped.split('## Hook firings')[1])
  const machine = retroOf('--all')
  check('firings m-6: --all is the machine view and counts the other repo too', /- scope: the whole machine \(--all\), 5 rows/.test(machine) && /git-guard\/normal-mode/.test(machine) && /- blocks: 3 \(5 rule rows/.test(machine), machine.split('## Hook firings')[1])
  const bare = join(scope, 'bare')
  write(bare, { 'T-2/STAGES.md': stages('T-2', 'T-2/feat/b') })
  const unscoped = spawnSync(process.execPath, [join(PLUGIN, 'retro.mjs'), join(bare, 'T-2'), '--firings', logFile], { encoding: 'utf8' }).stdout
  check('firings m-6: a task dir outside any git repo cannot say which repo it is: nothing is filtered and the section says so', /- scope: all 5 rows of the log/.test(unscoped), unscoped.split('## Hook firings')[1])
  // the rows of a block written by the hook itself share one moment
  const shared = mkdtempSync(join(tmpdir(), 'firings-block-'))
  spawnSync(process.execPath, ['--input-type=module', '-e', `const { blockWith } = await import(${JSON.stringify(join(PLUGIN, 'hooks/firing.mjs'))}); blockWith(['journal-gate/close', 'journal-gate/journal', 'journal-gate/report'], 'x', { input: { tool_name: 'Bash', hook_event_name: 'PostToolUse' }, task: 'T-1', repo: '/r' })`], { encoding: 'utf8', env: { ...process.env, STAGE_PIPELINE_DATA_DIR: shared } })
  const written = readFileSync(join(shared, 'firings.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  check('firings m-6: blockWith stamps the three rows of one block with one moment', written.length === 3 && new Set(written.map((r) => r.ts)).size === 1, JSON.stringify(written.map((r) => r.ts)))
  for (const dir of [scope, shared]) rmSync(dir, { recursive: true, force: true })
}

// ── VT-3 branch review m-4: the real journal-gate hook stamps the rows of one block with one moment (appended: D3) ─────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'jg-block-'))
  const jApp = join(dir, 'app')
  const dataDir = join(dir, 'data')
  repoAt(jApp, 'main')
  const jStages = (extra = '') => journal(extra).replace(/^# T-7:[^\n]*\n/, '# T-7: task\nLanguage: en\n')
  const jReport = join(jApp, '.claude/tasks/T-7/checks/pro-review-1.md')
  write(jApp, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n', '.claude/tasks/T-7/STAGES.md': jStages() })
  git(jApp, 'checkout', '-qb', 'T-7/feat/g')
  const jRun = (name, input) => spawnSync(process.execPath, [join(PLUGIN, 'hooks', name)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, STAGE_PIPELINE_DATA_DIR: dataDir } })
  jRun('session-start.mjs', { cwd: jApp })
  // one edit that breaks two kinds: a new unproven tick on a devtools criterion (journal) and a Russian report in an English task (report)
  write(jApp, { '.claude/tasks/T-7/STAGES.md': jStages(BAD_LINE), '.claude/tasks/T-7/checks/pro-review-1.md': RU_REPORT })
  const blocked = jRun('journal-gate.mjs', { cwd: jApp, tool_name: 'Write', tool_input: { file_path: jReport } })
  const rows = existsSync(join(dataDir, 'firings.jsonl')) ? readFileSync(join(dataDir, 'firings.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
  check('firings m-4: the real journal-gate hook blocks an edit that breaks two kinds', blocked.stdout.includes('"decision":"block"'), blocked.stdout.slice(0, 200) + blocked.stderr.slice(0, 200))
  check('firings m-4: its rows for the two kinds share one ts (retro counts them as one block)', rows.length >= 2 && new Set(rows.map((r) => r.rule)).size >= 2 && new Set(rows.map((r) => r.ts)).size === 1, JSON.stringify(rows.map((r) => [r.rule, r.ts])))
  rmSync(dir, { recursive: true, force: true })
}

// ── VT-3 branch review m-6: rows a linked worktree of the retro target wrote are the target's (appended: D3) ─────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'retro-wt-'))
  const main = join(dir, 'repo')
  const lane = join(dir, 'repo-lane')
  const other = join(dir, 'other')
  repoAt(main, 'main')
  repoAt(other, 'main')
  write(main, { 'T-1/STAGES.md': stages('T-1', 'T-1/feat/a') })
  git(main, 'worktree', 'add', '-q', '-b', 'T-1/feat/a', lane)
  const row = (rule, repo, ts) => JSON.stringify({ rule, task: 'T-1', repo, ts, tool: 'Bash', read: false, event: 'PostToolUse' })
  const logFile = join(dir, 'firings.jsonl')
  writeFileSync(logFile, [
    row('git-guard/normal-mode', main, '2026-10-27T10:00:00.000Z'),
    row('force-guard/ask-rule', lane, '2026-10-27T10:01:00.000Z'),
    row('force-guard/kill-by-name', lane, '2026-10-27T10:02:00.000Z'),
    row('agent-guard/review-model', other, '2026-10-27T10:03:00.000Z'),
    row('agent-guard/no-confirmed', join(dir, 'gone-worktree'), '2026-10-27T10:04:00.000Z'),
  ].join('\n') + '\n')
  const printed = spawnSync(process.execPath, [join(PLUGIN, 'retro.mjs'), main, '--firings', logFile], { encoding: 'utf8' }).stdout
  check('firings m-6: the rows of a linked worktree of the target are counted (3 of 5), another repo and an unresolvable path are not', /\(3 of 5 rows/.test(printed) && /force-guard\/ask-rule/.test(printed) && /force-guard\/kill-by-name/.test(printed) && !/agent-guard\//.test(printed), printed.split('## Hook firings')[1])
  rmSync(dir, { recursive: true, force: true })
}

// ── stage 8 (VT-4): the verify map — verify-map.mjs and the `map:` report rule ───────────────────────────────────────────────
{
  const VM = join(PLUGIN, 'verify-map.mjs')
  const vm = (cwd, ...args) => spawnSync(process.execPath, [VM, '--cwd', cwd, ...args], { encoding: 'utf8', timeout: 30_000 })
  const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' })
  const put = (root, file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  const mkRepo = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'verify-map-'))
    gitIn(root, 'init', '-q')
    for (const [file, text] of Object.entries(files)) put(root, file, text)
    gitIn(root, 'add', '-A')
    gitIn(root, 'commit', '-q', '-m', 'base')
    return root
  }
  const CONFIG = '# Pipeline config — fx\n## Project\n- slug: fx\n## Task state\n- task_path: .claude/tasks/\n## Dev server\n- url: http://localhost:3000   # the dev server\n- app_marker: <title>Fx</title>\n- verify_routes: /, /orders\n## Design sources of truth\n- breakpoints: 1440, 1280\n'
  const README = '# Verify map — fx\nBase: abc (main) · Updated: 2026-10-25\n## Features (sweep order)\n- [orders](features/orders.md) — /orders/:orderId\n- [cart](features/cart.md) — /cart\n'
  const FEATURE = (id, route, extra = '') =>
    `# ${id}\nRoutes: ${route} · Auth: yes · Platforms: desktop · Status: draft\nThe user can use ${id}.\n## Sub-features\n- \`${id}-open\`\n## How to get to it (user POV)\n- Header → «Orders»${extra}\n## Driving it with Chrome DevTools MCP\nPreconditions: doctor ok, auth ok.\n- **Header entry.** click \`link "Orders"\` → URL /orders, \`heading "Orders"\`.\n## Gotchas\n- Store created on SSR: assert after hydration.\n`
  const mapFiles = { '.claude/pipeline.config.md': CONFIG, '.claude/verify/README.md': README, '.claude/verify/features/orders.md': FEATURE('orders', '/orders/:orderId'), '.claude/verify/features/cart.md': FEATURE('cart', '/cart') }
  const dirs = []

  // AC-8.5: a new Nuxt page is listed as unmapped; a changed mapped page is mapped (params of any spelling are one form)
  const nuxt = mkRepo({ ...mapFiles, 'nuxt.config.ts': 'export default {}\n', 'pages/index.vue': '<template/>', 'pages/orders/[id].vue': '<template/>', 'components/Foo.vue': '<template/>' })
  dirs.push(nuxt)
  put(nuxt, 'pages/new.vue', '<template/>')
  put(nuxt, 'pages/orders/[id].vue', '<template>x</template>')
  put(nuxt, 'components/Foo.vue', '<template>x</template>')
  const nuxtOut = vm(nuxt, '--changed')
  check('verify-map --changed, Nuxt fixture: the new page pages/new.vue is listed as an unmapped route', /^route \/new — unmapped$/m.test(nuxtOut.stdout), nuxtOut.stdout + nuxtOut.stderr)
  check('verify-map --changed, Nuxt: [id] and the map\'s :orderId are one form — the changed order page is mapped: orders', /^route \/orders\/:id — mapped: orders$/m.test(nuxtOut.stdout), nuxtOut.stdout)
  check('verify-map --changed, Nuxt: a component is not a route, no warning for it', !/Foo\.vue|^warning/m.test(nuxtOut.stdout) && nuxtOut.status === 0, nuxtOut.stdout)
  put(nuxt, '.claude/verify/features/cart.md', FEATURE('cart', '/cart', ' · deep link /cart?from=push'))
  check('verify-map --changed: a touched feature file is listed', /^feature touched: cart$/m.test(vm(nuxt, '--changed').stdout), vm(nuxt, '--changed').stdout)
  gitIn(nuxt, 'add', '-A')
  gitIn(nuxt, 'commit', '-q', '-m', 'stage')
  check('verify-map --changed --base: against the first commit the committed page is still found', /^route \/new — unmapped$/m.test(vm(nuxt, '--changed', '--base', 'HEAD~1').stdout) && !/route \/new/.test(vm(nuxt, '--changed').stdout))

  // K8.3: Next app router, a route group is dropped; a route with no map entry is unmapped
  const next = mkRepo({ ...mapFiles, 'next.config.js': 'module.exports = {}\n', 'app/page.tsx': 'export default 1\n' })
  dirs.push(next)
  put(next, 'app/(shop)/cart/page.tsx', 'export default 1\n')
  put(next, 'app/(shop)/[slug]/page.tsx', 'export default 1\n')
  put(next, 'app/(shop)/layout.tsx', 'export default 1\n')
  put(next, 'pages/api/hello.ts', 'export default 1\n')
  const nextOut = vm(next, '--changed')
  check('verify-map --changed, Next app router: the route group (shop) is dropped — /cart is mapped: cart', /^route \/cart — mapped: cart$/m.test(nextOut.stdout), nextOut.stdout)
  check('verify-map --changed, Next: [slug] is a parameter and has no map entry — unmapped', /^route \/:slug — unmapped$/m.test(nextOut.stdout), nextOut.stdout)
  check('verify-map --changed, Next: a layout and an API file are not routes', !/layout|hello/.test(nextOut.stdout), nextOut.stdout)

  // A4: another router is a warning, never a guess; React Router routes come from the FEATURE-MAP rows
  const plain = mkRepo({ ...mapFiles, 'package.json': '{"dependencies":{"react-router-dom":"6"}}\n', 'src/App.tsx': 'export default 1\n' })
  dirs.push(plain)
  put(plain, 'src/App.tsx', 'export default 2\n')
  const plainOut = vm(plain, '--changed')
  check('verify-map --changed, a repo that is neither Nuxt nor Next: a warning line, no route is guessed', /^warning: src\/App\.tsx/m.test(plainOut.stdout) && !/^route /m.test(plainOut.stdout), plainOut.stdout)
  const fm = join(plain, 'FEATURE-MAP.md')
  writeFileSync(fm, '# Feature map: x\n## Entry points\n| ID | Platform | Route/screen | Files |\n|---|---|---|---|\n| cart | desktop | /cart | src/App.tsx:12 |\n\n## Data architecture\n')
  const rrOut = vm(plain, '--changed', '--feature-map', fm)
  check('verify-map --changed, React Router: the FEATURE-MAP row that names the changed file gives the route (mapped by the ID column)', /^route \/cart — mapped: cart$/m.test(rrOut.stdout) && !/^warning/m.test(rrOut.stdout), rrOut.stdout)

  // AC-8.1: no README — one line, nothing else
  const bare = mkRepo({ '.claude/pipeline.config.md': CONFIG, 'nuxt.config.ts': 'export default {}\n', 'pages/index.vue': '<template/>' })
  dirs.push(bare)
  put(bare, 'pages/new.vue', '<template/>')
  const bareOut = vm(bare, '--changed')
  check('AC-8.1 verify-map --changed, no .claude/verify/README.md: the single "no map" line, exit 0, no route listed', bareOut.status === 0 && /^verify-map: no map/.test(bareOut.stdout) && bareOut.stdout.trim().split('\n').length === 1, bareOut.stdout + bareOut.stderr)
  const outside = vm(bare, '--changed')
  check('AC-8.1 verify_map: a path outside the repo is refused (exit 2)', (() => {
    writeFileSync(join(bare, '.claude/pipeline.config.md'), `${CONFIG}- verify_map: ../elsewhere/\n`)
    const result = vm(bare, '--changed')
    return result.status === 2 && /must be a path inside the repo/.test(result.stdout)
  })(), outside.stdout)

  // AC-8.2: --init writes the README from config values only, and never overwrites
  const init = mkRepo({ '.claude/pipeline.config.md': CONFIG })
  dirs.push(init)
  const initOut = vm(init, '--init')
  const initText = existsSync(join(init, '.claude/verify/README.md')) ? readFileSync(join(init, '.claude/verify/README.md'), 'utf8') : ''
  check('AC-8.2 verify-map --init: the README is written', initOut.status === 0 && /# Verify map — fx/.test(initText), initOut.stdout + initOut.stderr)
  check('AC-8.2 --init: the config values are in it (dev url, marker, baseline routes, breakpoints)', initText.includes('- Dev: http://localhost:3000\n') && initText.includes('<title>Fx</title>') && initText.includes('Baseline routes: /, /orders') && initText.includes('desktop widths: 1440, 1280'), initText)
  check('AC-8.2 --init: what the config lacks is "not set" (auth, data, stand writes, theme, playwright, webview), nothing invented', ['Auth', 'Playwright / storageState', 'Data', 'Stand writes', 'Theme'].every((label) => initText.includes(`- ${label}: not set`)) && initText.includes('webview: not set'), initText)
  check('AC-8.2 --init: no URL, port or path that the config does not hold', [...initText.matchAll(/https?:\/\/[^\s)]+|localhost:\d+/g)].every(([url]) => CONFIG.includes(url)), initText)
  check('AC-8.2 --init: only the README, no feature files', !existsSync(join(init, '.claude/verify/features')))
  writeFileSync(join(init, '.claude/verify/README.md'), 'HAND WRITTEN\n')
  const again = vm(init, '--init')
  check('AC-8.2 --init: an existing README is left as it is', readFileSync(join(init, '.claude/verify/README.md'), 'utf8') === 'HAND WRITTEN\n' && /left as it is/.test(again.stdout), again.stdout)
  const initRu = mkRepo({ '.claude/pipeline.config.md': CONFIG.replace('## Task state', '- language: ru\n## Task state') })
  dirs.push(initRu)
  vm(initRu, '--init')
  check('AC-8.2 --init: a ru config gives the Russian headings and the Russian "not set"', /^# Карта проверки — fx/.test(readFileSync(join(initRu, '.claude/verify/README.md'), 'utf8')) && /Вход: не задано/.test(readFileSync(join(initRu, '.claude/verify/README.md'), 'utf8')))
  const initBare = mkRepo({ '.claude/pipeline.config.md': '## Project\n- slug: z\n## Dev server\n- url: —\n' })
  dirs.push(initBare)
  vm(initBare, '--init')
  const bareText = readFileSync(join(initBare, '.claude/verify/README.md'), 'utf8')
  check('AC-8.2 --init: a config with no dev server values gives "not set" for url, marker and routes', /- Dev: not set/.test(bareText) && /- App marker: not set/.test(bareText) && /- Baseline routes: not set/.test(bareText), bareText)

  // AC-8.3: --lint — the draft a feature-checker writes passes; a file path or a missing part fails
  const lintFile = join(init, 'f.md')
  const lint = (text) => {
    writeFileSync(lintFile, text)
    return vm(init, '--lint', lintFile)
  }
  check('AC-8.3 --lint: a feature file with the header line and the four sections passes', lint(FEATURE('orders', '/orders')).status === 0, lint(FEATURE('orders', '/orders')).stdout)
  const withPath = lint(FEATURE('orders', '/orders', ' · see components/orders/OrderList.vue:12'))
  check('AC-8.3 --lint: a file path inside the file fails, with its line', withPath.status === 1 && /f\.md:\d+ — file path "components\/orders\/OrderList\.vue/.test(withPath.stdout), withPath.stdout)
  check('AC-8.3 --lint: a bare file name with a source extension fails too', lint(FEATURE('orders', '/orders', ' · OrderList.vue')).status === 1)
  check('AC-8.3 --lint: routes and request paths are not file paths (an absolute URL is flagged since 9a, see AC-9a.7)', lint(FEATURE('orders', '/orders/[id]', ' · POST /api/orders 201 · /app/orders · Next.js')).status === 0, lint(FEATURE('orders', '/orders/[id]', ' · POST /api/orders 201 · /app/orders · Next.js')).stdout)
  const noSection = lint(FEATURE('orders', '/orders').replace('## Gotchas\n- Store created on SSR: assert after hydration.\n', ''))
  check('AC-8.3 --lint: a missing section fails and is named', noSection.status === 1 && /no "## Gotchas" section/.test(noSection.stdout), noSection.stdout)
  const noHeader = lint(FEATURE('orders', '/orders').replace(/Routes:.*\n/, ''))
  check('AC-8.3 --lint: no header line fails', noHeader.status === 1 && /no header line/.test(noHeader.stdout), noHeader.stdout)
  const verified = lint(FEATURE('orders', '/orders').replace('Status: draft', 'Status: verified 2026-10-25 abc1234'))
  check('AC-8.3 --lint: Status: verified <date> <sha> passes', verified.status === 0, verified.stdout)
  const ruFeature = '# Заказы\nМаршруты: /orders · Вход: да · Платформы: desktop · Статус: черновик\nТекст.\n## Подфункции\n- `orders-open`\n## Как дойти (глазами пользователя)\n- Шапка\n## Управление через Chrome DevTools MCP\n- шаг\n## Подводные камни\n- нет\n'
  check('AC-8.3 --lint: the Russian header and headings pass', lint(ruFeature).status === 0, lint(ruFeature).stdout)

  // K8.4: the `map:` report rule — gated like the doctor:/auth: lines (fresh reports only), and only in a repo with the README
  const mapBody = (mapLine) => `# devtools-verify — stage 3\nFindings: critical 0 · major 0 · minor 0\ndoctor: ok — http://localhost:3000 answers\nauth: not needed — no auth-gated criteria\n${mapLine}\ngeometry 1440: overflow 0 · zero-gap 0 · clipped 0\n\n## Could not verify\n- nothing\n`
  const noMap = (text, fresh = true, map = true) => jc.runtimeViolations(text, 'devtools-verify-3.md', null, fresh, map).filter(({ rule }) => rule === 'no-map')
  check('map rule, incident: README present, a new report without the map: line is rejected', noMap(mapBody('')).length === 1, JSON.stringify(noMap(mapBody(''))))
  check('map rule, legitimate: README present, `map: orders · entries 2/3 · drift 1` passes', noMap(mapBody('map: orders · entries 2/3 · drift 1')).length === 0)
  check('map rule, legitimate: README present, `map: none — /new unmapped` passes', noMap(mapBody('map: none — /new unmapped')).length === 0)
  check('map rule, legitimate: README present, the Russian key (karta:) passes', noMap(mapBody('\u043a\u0430\u0440\u0442\u0430: orders \u00b7 2/3 \u00b7 0')).length === 0)
  check('map rule, legitimate: no README (no map) — a report without map: is left alone', noMap(mapBody(''), true, false).length === 0)
  check('map rule, release gate: a report already on disk (not fresh) is left alone even with the README', noMap(mapBody(''), false, true).length === 0)
  check('map rule: a skipped report needs no map: line', jc.runtimeViolations('# devtools-verify\nskip: MCP unavailable\n', 'devtools-verify-3.md', null, true, true).length === 0)
  const mapTask = mkdtempSync(join(tmpdir(), 'verify-map-task-'))
  dirs.push(mapTask)
  put(mapTask, 'checks/devtools-verify-3.md', mapBody(''))
  check('map rule through reportViolations: a fresh report with map:true is rejected, without map:true it is not', jc.reportViolations(join(mapTask, 'checks/devtools-verify-3.md'), null, { fresh: true, map: true }).some(({ rule }) => rule === 'no-map') && !jc.reportViolations(join(mapTask, 'checks/devtools-verify-3.md'), null, { fresh: true }).some(({ rule }) => rule === 'no-map'))
  const { mapReadme } = await import(join(PLUGIN, 'verify-map.mjs'))
  check('map rule: the hook finds the README by verify_map: (default and custom dir), and no README is null', Boolean(mapReadme([nuxt], CONFIG)) && mapReadme([bare], CONFIG) === null && (put(bare, 'docs/vm/README.md', '# x\n'), Boolean(mapReadme([bare], `${CONFIG}- verify_map: docs/vm/\n`))))

  // VT-4 stage 8 fix round 1: M1 the main tree's README, M2 the E2E label, M3 whole-path match
  {
    const main = mkRepo({ '.claude/pipeline.config.md': CONFIG, 'nuxt.config.ts': 'export default {}\n', 'pages/index.vue': '<template/>' })
    dirs.push(main)
    writeFileSync(join(main, '.git/info/exclude'), '.claude/\n')
    put(main, '.claude/verify/README.md', README)
    const wt = `${main}-wt`
    dirs.push(wt)
    gitIn(main, 'worktree', 'add', '-q', wt, '-b', 'wt-branch')
    put(wt, 'pages/new.vue', '<template/>')
    const wtOut = vm(wt, '--changed')
    check('M1 verify-map --changed, worktree whose README lives only in the main tree: the map is found', !existsSync(join(wt, '.claude/verify/README.md')) && /^map: /m.test(wtOut.stdout) && !/no map/.test(wtOut.stdout) && /^route \/new — unmapped$/m.test(wtOut.stdout), wtOut.stdout + wtOut.stderr)
  }
  const e2eRepo = mkRepo({ '.claude/pipeline.config.md': `${CONFIG}- e2e: pnpm test:e2e\n` })
  dirs.push(e2eRepo)
  vm(e2eRepo, '--init')
  const e2eText = readFileSync(join(e2eRepo, '.claude/verify/README.md'), 'utf8')
  check('M2 --init: the config e2e value is labeled "E2E command", the Playwright slot stays "not set"', e2eText.includes('- E2E command: pnpm test:e2e\n') && e2eText.includes('- Playwright / storageState: not set\n') && !/- Playwright[^\n]*pnpm/.test(e2eText), e2eText)
  const rrShort = mkRepo({ ...mapFiles, 'package.json': '{"dependencies":{"react-router-dom":"6"}}\n', 'pages/a.tsx': 'export default 1\n' })
  dirs.push(rrShort)
  put(rrShort, 'pages/a.tsx', 'export default 2\n')
  const fmShort = join(rrShort, 'FEATURE-MAP.md')
  writeFileSync(fmShort, '# Feature map: x\n## Entry points\n| ID | Platform | Route/screen | Files |\n|---|---|---|---|\n| cart | desktop | /cart | src/pages/a.tsx.bak, src/xpages/a.tsx |\n\n## Data architecture\n')
  const shortOut = vm(rrShort, '--changed', '--feature-map', fmShort)
  check('M3 verify-map --changed: a short path does not match a longer row path (substring)', !/^route \/cart/m.test(shortOut.stdout) && /^warning: pages\/a\.tsx/m.test(shortOut.stdout), shortOut.stdout)
  writeFileSync(fmShort, '# Feature map: x\n## Entry points\n| ID | Platform | Route/screen | Files |\n|---|---|---|---|\n| cart | desktop | /cart | src/pages/a.tsx:3 |\n\n## Data architecture\n')
  check('M3 verify-map --changed: a row path ending with the changed file on a segment boundary matches', /^route \/cart — mapped: cart$/m.test(vm(rrShort, '--changed', '--feature-map', fmShort).stdout))

  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

// ── stage 9 (VT-4): proof of effects, re-observation, live radius — the three 0.20 report rules behind `runtimeOld` ──────────────
{
  const dirs = []
  const put = (root, file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  const JOURNAL = '# T-90: task\nLanguage: en\nBranch: `T-90/feat/a`\n\n## Status: stage 9\n\n## Stages\n\n### Stage 9: effects  [status: in-progress]\n- `AC-9.1` WHEN the contract is signed THEN POST /api/contracts saves it — [verify: devtools-verify] [effect]\n- `AC-9.2` WHEN the page opens THEN the title shows — [verify: devtools-verify]\n- `AC-9.3` WHEN the status changes THEN it persists — [verify: devtools-verify] [эффект]\n'
  const head = '# devtools-verify — stage 9\nFindings: critical 0 · major 0 · minor 0\ndoctor: ok — http://localhost:3000 answers\nauth: not needed — no auth-gated criteria\ngeometry 1440: overflow 0 · zero-gap 0 · clipped 0\n\n## Stage criteria\n'
  const tail9 = '\n## Could not verify\n- nothing\n'
  const taskA = mkdtempSync(join(tmpdir(), 'effects-task-'))
  dirs.push(taskA)
  put(taskA, 'STAGES.md', JOURNAL)
  const eff = (criteria) => jc.effectViolations(`${head}${criteria}${tail9}`, 'devtools-verify-9.md', taskA).filter(({ rule }) => rule === 'no-effect-proof')

  // AC-9.1 incident: the screen showed the new state, no request, no read-back
  check('AC-9.1 incident: a PASS on an [effect] criterion with neither a request nor a read-back is rejected', eff('- `AC-9.1` — PASS, the card shows «Signed» (screenshot `checks/screens/a.png`)\n').length === 1)
  const noReadback = eff('- `AC-9.1` — PASS, `POST /api/contracts → 201 {status: signed}`\n')
  check('AC-9.1 incident: a request without a read-back is rejected and the message names the read-back', noReadback.length === 1 && /read-back/.test(noReadback[0].message) && !/no the request/.test(noReadback[0].message), JSON.stringify(noReadback))
  const noRequest = eff('- `AC-9.1` — PASS, read-back after reload: the card shows «Signed»\n')
  check('AC-9.1 incident: a read-back without a request is rejected and the message names the request', noRequest.length === 1 && /the request/.test(noRequest[0].message))
  check('AC-9.1 legitimate: a PASS with the request and a read-back after a reload passes', eff('- `AC-9.1` — PASS, `POST /api/contracts → 201 {status: signed}`; read-back after reload: the card shows «Signed»\n').length === 0)
  check('AC-9.1 legitimate: the proof may sit in detail lines under the PASS, a second view is a read-back', eff('- `AC-9.1` — PASS\n  - POST /api/contracts 201, body status=signed\n  - read from a second view: /contracts lists it as signed\n').length === 0)
  check('AC-9.1 legitimate: the Russian read-back (\u0447\u0442\u0435\u043d\u0438\u0435 \u043f\u043e\u0441\u043b\u0435 \u043f\u0435\u0440\u0435\u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0438) passes', eff('- `AC-9.1` — PASS, `POST /api/contracts → 201`; \u0447\u0442\u0435\u043d\u0438\u0435 \u043f\u043e\u0441\u043b\u0435 \u043f\u0435\u0440\u0435\u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0438: \u00ab\u041f\u043e\u0434\u043f\u0438\u0441\u0430\u043d\u00bb\n').length === 0)
  check('AC-9.1 legitimate: the Russian tag [effect] of AC-9.3 is read too — a bare PASS on it is rejected', eff('- `AC-9.3` — PASS, the status is shown\n').length === 1)
  check('AC-9.1: FAIL, not checked and a PASS on an untagged criterion are not touched', eff('- `AC-9.1` — FAIL, no request after the click\n- `AC-9.3` — not checked, no stand\n- `AC-9.2` — PASS, title «Contracts» at 1440\n').length === 0)
  check('AC-9.1: two tagged criteria are judged apart — one proven, one bare', eff('- `AC-9.1` — PASS, `POST /api/contracts → 201`; read-back after reload: signed\n- `AC-9.3` — PASS, the status is shown\n').length === 1)
  put(taskA, 'STAGES-ARCHIVE.md', '### Stage 8: old  [status: done]\n- `AC-8.1` WHEN saved THEN PUT /api/x — [verify: devtools-verify] [effect]\n')
  check('AC-9.1: a tag in STAGES-ARCHIVE.md counts too', jc.effectViolations(`${head}- \`AC-8.1\` — PASS, the form closed\n${tail9}`, 'devtools-verify-9.md', taskA).length === 1)
  check('AC-9.1: a task without any [effect] tag is left alone', (() => { const t = mkdtempSync(join(tmpdir(), 'effects-none-')); dirs.push(t); put(t, 'STAGES.md', JOURNAL.replace(/ \[effect\]| \[эффект\]/g, '')); return jc.effectViolations(`${head}- \`AC-9.1\` — PASS, bare\n${tail9}`, 'devtools-verify-9.md', t).length === 0 })())
  check('AC-9.1: a skipped report and a non-devtools-verify report are left alone', jc.effectViolations('# devtools-verify\nskip: MCP unavailable\n- `AC-9.1` — PASS\n', 'devtools-verify-9.md', taskA).length === 0 && jc.effectViolations(`${head}- \`AC-9.1\` — PASS\n`, 'pro-review-9.md', taskA).length === 0)
  put(taskA, 'checks/devtools-verify-9.md', `${head}- \`AC-9.1\` — PASS, the card shows «Signed»\n${tail9}`)
  const rv = (options) => jc.reportViolations(join(taskA, 'checks/devtools-verify-9.md'), null, options).filter(({ rule }) => rule === 'no-effect-proof')
  check('AC-9.1 gate: through reportViolations the rule fires with v020 and is silent without it (old report)', rv({ fresh: true, v020: true }).length === 1 && rv({ fresh: true }).length === 0)

  // AC-9.2: a runtime `fixed` cites a re-run artifact that exists
  const fixedReport = (line) => `${head}- \`AC-9.2\` — PASS, title «Contracts»\n${tail9}\n## Findings outcome\n${line}\n`
  const rerun = (line, task = taskA) => jc.rerunViolations(fixedReport(line), 'devtools-verify-9.md', task).filter(({ rule }) => rule === 'no-rerun')
  put(taskA, 'checks/devtools-verify-9-r1.md', '# devtools-verify — stage 9, recheck\n')
  put(taskA, 'checks/screens/after-fix.png', 'png')
  check('AC-9.2 incident: `fixed: file:line` alone in a devtools-verify ledger is rejected', rerun('- M-1 — fixed: src/Card.vue:12').length === 1)
  check('AC-9.2 incident: a cited recheck report that does not exist is rejected', rerun('- M-1 — fixed: src/Card.vue:12 — re-run checks/devtools-verify-9-r7.md').length === 1)
  check('AC-9.2 incident: the report citing itself is not a re-run', rerun('- M-1 — fixed: src/Card.vue:12 — re-run checks/devtools-verify-9.md').length === 1)
  check('AC-9.2 legitimate: `fixed: file:line — re-run checks/devtools-verify-9-r1.md` passes', rerun('- M-1 — fixed: src/Card.vue:12 — re-run checks/devtools-verify-9-r1.md').length === 0)
  check('AC-9.2 legitimate: a `-fresh.md` report that exists passes', (() => { put(taskA, 'checks/devtools-verify-9-fresh.md', '# fresh\n'); return rerun('- M-1 — fixed: src/Card.vue:12, rechecked in devtools-verify-9-fresh.md').length === 0 })())
  check('AC-9.2 legitimate: a `checks/screens/` path that exists passes', rerun('- M-1 — fixed: src/Card.vue:12 — after the fix: checks/screens/after-fix.png').length === 0)
  check('AC-9.2 legitimate: the Russian outcome with the recheck report passes', rerun('- M-1 — исправлено: src/Card.vue:12 — перепроверка checks/devtools-verify-9-r1.md').length === 0)
  check('AC-9.2: false / blocker outcomes and a pro-review `fixed` are not touched', rerun('- M-1 — false: measured 12px at 1440, src/Card.vue:12\n- M-2 — B1: needs the stand').length === 0 && jc.rerunViolations(fixedReport('- M-1 — fixed: src/Card.vue:12'), 'pro-review-9.md', taskA).length === 0)
  put(taskA, 'checks/devtools-verify-9.md', fixedReport('- M-1 — fixed: src/Card.vue:12'))
  const rr = (options) => jc.reportViolations(join(taskA, 'checks/devtools-verify-9.md'), null, options).filter(({ rule }) => rule === 'no-rerun')
  check('AC-9.2 gate: through reportViolations the rule fires with v020 and is silent without it (old report)', rr({ v020: true }).length === 1 && rr({}).length === 0)

  // the mark: a fresh snapshot lists the reports on disk in runtimeOld; a 0.18 snapshot without it is migrated lazily and the reports there stay old
  const mData = mkdtempSync(join(tmpdir(), 'v020-data-'))
  dirs.push(mData)
  const info = jc.baselineInfo(mData, taskA)
  check('0.20 mark: a fresh snapshot carries runtimeOld with the reports already on disk', info.runtimeOld.has('devtools-verify-9.md') && !info.runtimeOld.has('devtools-verify-10.md'))
  const mFile = snapshotFile(mData, taskA)
  const snap = JSON.parse(readFileSync(mFile, 'utf8'))
  delete snap.runtimeOld
  snap.ledgerOld = ['marker.md']
  writeFileSync(mFile, JSON.stringify(snap))
  put(taskA, 'checks/devtools-verify-11.md', '# later\n')
  const migrated = jc.baselineInfo(mData, taskA)
  check('0.20 mark: a 0.18 snapshot (no runtimeOld) is migrated — reports on disk then are old, ledgerOld keeps its own set', migrated.runtimeOld.has('devtools-verify-11.md') && migrated.ledgerOld.has('marker.md') && !migrated.ledgerOld.has('devtools-verify-11.md'))
  put(taskA, 'checks/devtools-verify-12.md', '# newer\n')
  check('0.20 mark: a report written after the migration is new for the 0.20 rules (the set does not grow)', !jc.baselineInfo(mData, taskA).runtimeOld.has('devtools-verify-12.md'))

  // end to end through journal-gate: old report stays valid, a new one is judged; the stage 8 `map:` rule sits behind the same mark
  {
    const mRoot = mkdtempSync(join(tmpdir(), 'v020-'))
    dirs.push(mRoot)
    const mApp = join(mRoot, 'app')
    repoAt(mApp, 'main')
    const tdir = join(mApp, '.claude/tasks/T-90')
    write(mApp, {
      '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n',
      '.claude/tasks/T-90/STAGES.md': JOURNAL,
      '.claude/verify/README.md': '# Verify map — fx\nBase: abc · Updated: 2026-10-25\n## Features (sweep order)\n- [orders](features/orders.md) — /orders\n',
    })
    git(mApp, 'checkout', '-qb', 'T-90/feat/a')
    jc.baselineInfo(DATA, tdir)
    const file = snapshotFile(DATA, tdir)
    const old = JSON.parse(readFileSync(file, 'utf8'))
    delete old.runtimeOld
    writeFileSync(file, JSON.stringify(old))
    const BAD = `${head}- \`AC-9.1\` — PASS, the card shows «Signed»\n${tail9}\n## Findings outcome\n- M-1 — fixed: src/Card.vue:12\n`
    write(mApp, { '.claude/tasks/T-90/checks/devtools-verify-8.md': BAD })
    const reportGate = (name) => runHook('journal-gate.mjs', { cwd: mApp, tool_name: 'Write', tool_input: { file_path: join(tdir, 'checks', name) } })
    const oldEdit = reportGate('devtools-verify-8.md')
    check('0.20 gate, old report stays valid: a report already on disk at the first look of 0.20 is not rejected for the effect proof, the re-run artifact or the map: line', !/\[effect\]|re-run artifact|`map:` line/.test(oldEdit.text), oldEdit.text)
    check('0.20 gate: the migration listed it in runtimeOld', JSON.parse(readFileSync(file, 'utf8')).runtimeOld.includes('devtools-verify-8.md'))
    write(mApp, { '.claude/tasks/T-90/checks/devtools-verify-9.md': BAD })
    const fresh = reportGate('devtools-verify-9.md')
    check('0.20 gate, incident: a new report with an [effect] PASS without proof, a bare fixed and no map: line is rejected for all three rules', fresh.decision === 'block' && /\[effect\]/.test(fresh.text) && /re-run artifact/.test(fresh.text) && /`map:` line/.test(fresh.text), fresh.text)
    write(mApp, { '.claude/tasks/T-90/checks/devtools-verify-9-r1.md': '# devtools-verify — stage 9, recheck\n' })
    const GOOD = BAD.replace('the card shows «Signed»', '`POST /api/contracts → 201`; read-back after reload: «Signed»').replace('geometry 1440', 'map: orders · entries 1/1 · drift 0\ngeometry 1440').replace('fixed: src/Card.vue:12', 'fixed: src/Card.vue:12 — re-run checks/devtools-verify-9-r1.md')
    write(mApp, { '.claude/tasks/T-90/checks/devtools-verify-9.md': GOOD })
    const legit = reportGate('devtools-verify-9.md')
    check('0.20 gate, legitimate: the same report with the request, the read-back, the re-run artifact and the map: line passes', !/\[effect\]|re-run artifact|`map:` line/.test(legit.text), legit.text)
  }

  // AC-9.4 support: verify-map.mjs --radius
  {
    const VM = join(PLUGIN, 'verify-map.mjs')
    const vm = (cwd, ...args) => spawnSync(process.execPath, [VM, '--cwd', cwd, ...args], { encoding: 'utf8', timeout: 30_000 })
    const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' })
    const CONFIG = '# Pipeline config — fx\n## Project\n- slug: fx\n## Task state\n- task_path: .claude/tasks/\n'
    const FEATURE = '# orders\nRoutes: /orders/:orderId · Auth: yes · Platforms: desktop · Status: draft\nThe user can use orders.\n## Sub-features\n- `orders-open`\n## How to get to it (user POV)\n- Header → «Orders» → open an order\n- Deep link from push\n## Driving it with Chrome DevTools MCP\n- **Header entry.** click `link "Orders"`.\n## Gotchas\n- none\n'
    const mk = (withMap) => {
      const root = mkdtempSync(join(tmpdir(), 'radius-'))
      dirs.push(root)
      gitIn(root, 'init', '-q')
      const files = {
        '.claude/pipeline.config.md': CONFIG,
        'nuxt.config.ts': 'export default {}\n',
        'components/shared/InfoBlock.vue': '<template><div/></template>\n',
        'components/shared/Wrapper.vue': '<template><InfoBlock/></template>\n<script setup>import InfoBlock from "./InfoBlock.vue"</script>\n',
        'pages/orders/[id].vue': '<script setup>import Wrapper from "@/components/shared/Wrapper.vue"</script>\n<template><Wrapper/></template>\n',
        'pages/legacy.vue': '<script setup>import InfoBlock from "~/components/shared/InfoBlock.vue"</script>\n<template><InfoBlock/></template>\n',
        'pages/unrelated.vue': '<template><p>x</p></template>\n',
      }
      if (withMap) Object.assign(files, { '.claude/verify/README.md': '# Verify map — fx\n## Features (sweep order)\n- [orders](features/orders.md) — /orders/:orderId\n', '.claude/verify/features/orders.md': FEATURE })
      for (const [file, text] of Object.entries(files)) put(root, file, text)
      gitIn(root, 'add', '-A')
      gitIn(root, 'commit', '-q', '-m', 'base')
      return root
    }
    const mapped = mk(true)
    const out = vm(mapped, '--radius', 'components/shared/InfoBlock.vue')
    check('radius: a shared module imported by two pages (one mapped, one not) lists both routes, through a nested shared module and an alias', /^route \/orders\/:id — mapped: orders \(via pages\/orders\/\[id\]\.vue\)$/m.test(out.stdout) && /^route \/legacy — unmapped \(via pages\/legacy\.vue\)$/m.test(out.stdout) && !/unrelated/.test(out.stdout), out.stdout + out.stderr)
    check('radius: the mapped feature is listed once with its primary path (the first entry of "How to get to it")', /^feature orders — primary path: Header → «Orders» → open an order \(features\/orders\.md\)$/m.test(out.stdout) && (out.stdout.match(/^feature /gm) ?? []).length === 1, out.stdout)
    check('radius: the first line counts modules and importer files and names the map', /^radius: 1 module → \d+ importer files?, depth <= 4 · \.claude\/verify · README \/\S+\/\.claude\/verify\/README\.md$/m.test(out.stdout) && out.status === 0, out.stdout)
    const bare = mk(false)
    const bareOut = vm(bare, '--radius', 'components/shared/InfoBlock.vue')
    check('radius: no map — the routes only, no mapped / feature lines, exit 0', bareOut.status === 0 && /^radius: .*no map — routes only$/m.test(bareOut.stdout) && /^route \/orders\/:id — no map/m.test(bareOut.stdout) && /^route \/legacy — no map/m.test(bareOut.stdout) && !/^feature |mapped/m.test(bareOut.stdout), bareOut.stdout)
    const deep = vm(mapped, '--radius', 'components/shared/InfoBlock.vue', '--depth', '1')
    check('radius: --depth bounds the climb — at depth 1 the page behind Wrapper is not reached', /^route \/legacy/m.test(deep.stdout) && !/^route \/orders/m.test(deep.stdout), deep.stdout)
    check('radius: a page file given directly is its own route', /^route \/legacy — unmapped \(via pages\/legacy\.vue\)$/m.test(vm(mapped, '--radius', 'pages/legacy.vue').stdout))
    const none = vm(mapped, '--radius', 'pages/unrelated.vue', 'components/shared/Missing.vue')
    check('radius: several files; a module nobody imports gives no extra route', none.status === 0 && /^route \/unrelated/m.test(none.stdout) && !/^route \/orders/m.test(none.stdout), none.stdout)
    check('radius: no file given is exit 2', vm(mapped, '--radius').status === 2)
  }

  // pro-review round 1: a digit in the path is not the status; the verdict is the word right after the id
  const reqOnly = (line) => eff(`- \`AC-9.1\` — PASS, ${line}; read-back after reload: signed\n`).length
  check('AC-9.1 round 1: a digit run inside the path is not the status', reqOnly('POST /api/x/123 sent, no status') === 1 && reqOnly('GET /api/v1/items?limit=100 returned list') === 1)
  check('AC-9.1 round 1: the status after the whole path counts', reqOnly('POST /api/x/123 → 201') === 0 && reqOnly('GET /api/v1/items?limit=100 200') === 0)
  check('AC-9.1 round 1: not checked and Could not verify wordings with the word PASS are not a PASS', eff('- `AC-9.1` — not checked: no PASS possible without a stand\n').length === 0 && jc.effectViolations(`${head}## Could not verify\n- AC-9.1: cannot give PASS, the stand has no API\n`, 'devtools-verify-9.md', taskA).length === 0)
  check('AC-9.1 round 1: AC-9.1 — PASS and AC-9.1: PASS without proof still fail', eff('- AC-9.1 — PASS\n').length === 1 && eff('- AC-9.1: PASS\n').length === 1)
  // round 2: only a criterion definition line carries the tag, outside backticks, next to the verifier
  const tagged = (text) => { const t = mkdtempSync(join(tmpdir(), 'effects-tag-')); dirs.push(t); put(t, 'STAGES.md', text); return [...jc.effectCriteria(t)].sort().join(',') }
  check('AC-9.1 round 2: the quoted tag in a criterion prose tags nothing', tagged('- `AC-9.1` WHEN an `[effect]` AC gets a PASS without a request THEN the hook rejects it \u2014 [verify: pro-review]\n') === '')
  check('AC-9.1 round 2: a decision line and a journal line with the tag tag nothing', tagged('- K9.2 Both new report rules (AC-9.1 the `[effect]` PASS, AC-9.2 the re-run)\nAC-3.1 \u2705 done; AC-3.4 [effect] deferred\n') === '')
  check('AC-9.1 round 2: a criterion line with the tag next to the verifier is tagged, either order', tagged('- `AC-3.2` WHEN saved THEN POST /api/x \u2014 [verify: devtools-verify] [effect]\n- AC-3.3 WHEN saved THEN PUT /api/y \u2014 [effect] [verify: devtools-verify]\n') === '3.2,3.3')
  check('AC-9.1 round 2: the Russian tag is tagged', tagged('- `AC-3.5` WHEN saved THEN POST /api/z \u2014 [verify: devtools-verify] [\u044d\u0444\u0444\u0435\u043a\u0442]\n') === '3.5')

  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

// ── stage 9a (VT-4): the final-check catch-up — route groups, one radius and one map-root reader, map as untrusted input, hardened rules ──
{
  const VM = join(PLUGIN, 'verify-map.mjs')
  const vm = (cwd, ...args) => spawnSync(process.execPath, [VM, '--cwd', cwd, ...args], { encoding: 'utf8', timeout: 30_000 })
  const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' })
  const dirs = []
  const put = (root, file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  const mkRepo = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'v9a-'))
    dirs.push(root)
    gitIn(root, 'init', '-q')
    for (const [file, text] of Object.entries(files)) put(root, file, text)
    gitIn(root, 'add', '-A')
    gitIn(root, 'commit', '-q', '-m', 'base')
    return root
  }
  const CONFIG = '# Pipeline config — fx\n## Project\n- slug: fx\n## Task state\n- task_path: .claude/tasks/\n## Dev server\n- url: http://localhost:3000\n- verify_routes: /, /orders\n'
  const README = '# Verify map — fx\nBase: abc (main) · Updated: 2026-10-25\n## Features (sweep order)\n- [orders](features/orders.md) — /orders/:orderId\n'
  const FEATURE = (extra = '', header = 'Routes: /orders/:orderId · Auth: yes · Platforms: desktop · Status: draft') =>
    `# orders\n${header}\nThe user can use orders.\n## Sub-features\n- \`orders-open\`\n## How to get to it (user POV)\n- Header → «Orders»${extra}\n## Driving it with Chrome DevTools MCP\n- **Header entry.** click \`link "Orders"\`.\n## Gotchas\n- none\n`
  const mapFiles = { '.claude/pipeline.config.md': CONFIG, '.claude/verify/README.md': README, '.claude/verify/features/orders.md': FEATURE() }

  // AC-9a.1 (K9a.1): Nuxt route groups are dropped, as Next's are; R5: Nuxt [[id]] / [...slug] and the Next pages router
  const nuxt = mkRepo({ ...mapFiles, 'nuxt.config.ts': 'export default {}\n', 'pages/index.vue': '<template/>', 'components/Info.vue': '<template/>' })
  put(nuxt, 'pages/(shop)/(auth)/orders/[id].vue', '<script setup>import Info from "~/components/Info.vue"</script><template><Info/></template>')
  put(nuxt, 'pages/(shop)/index.vue', '<template/>')
  put(nuxt, 'pages/items/[[id]].vue', '<template/>')
  put(nuxt, 'pages/docs/[...slug].vue', '<template/>')
  const nuxtOut = vm(nuxt, '--changed')
  check('AC-9a.1 incident: --changed, Nuxt pages under route groups — /orders/:id is mapped: orders, no (group) in any route', /^route \/orders\/:id — mapped: orders$/m.test(nuxtOut.stdout) && !/\(shop\)|\(auth\)/.test(nuxtOut.stdout), nuxtOut.stdout)
  check('AC-9a.1 legitimate: a group-only index is the root; Nuxt [[id]] and [...slug] are parameters', /^route \/ — unmapped$/m.test(nuxtOut.stdout) && /^route \/items\/:id — unmapped$/m.test(nuxtOut.stdout) && /^route \/docs\/:slug — unmapped$/m.test(nuxtOut.stdout), nuxtOut.stdout)
  const nuxtRadius = vm(nuxt, '--radius', 'components/Info.vue')
  check('AC-9a.1 incident: --radius gives the same route for a page under route groups', /^route \/orders\/:id — mapped: orders \(via pages\/\(shop\)\/\(auth\)\/orders\/\[id\]\.vue\)$/m.test(nuxtRadius.stdout), nuxtRadius.stdout)
  const nextPages = mkRepo({ ...mapFiles, 'next.config.js': 'module.exports = {}\n', 'pages/index.tsx': 'export default 1\n' })
  put(nextPages, 'pages/about.tsx', 'export default 1\n')
  put(nextPages, 'pages/blog/[slug].tsx', 'export default 1\n')
  put(nextPages, 'pages/_app.tsx', 'export default 1\n')
  put(nextPages, 'pages/api/x.ts', 'export default 1\n')
  const nextPagesOut = vm(nextPages, '--changed')
  check('R5 verify-map --changed, Next pages router: /about and /blog/:slug are routes, _app and api are not', /^route \/about — unmapped$/m.test(nextPagesOut.stdout) && /^route \/blog\/:slug — unmapped$/m.test(nextPagesOut.stdout) && !/_app|api/.test(nextPagesOut.stdout), nextPagesOut.stdout)

  // AC-9a.2 (K9a.2): --radius names every importer it cannot route, with or without FEATURE-MAP rows
  const rr = mkRepo({
    ...mapFiles,
    'package.json': '{"dependencies":{"react-router-dom":"6"}}\n',
    'src/shared/Info.tsx': 'export const Info = () => null\n',
    'src/components/Panel.tsx': 'import { Info } from "../shared/Info"\nexport const Panel = () => null\n',
    'src/pages/Cart.tsx': 'import { Panel } from "../components/Panel"\nimport { Info } from "../shared/Info"\nexport default 1\n',
    'src/pages/Legacy.tsx': 'import { Info } from "../shared/Info"\nexport default 2\n',
  })
  const fm = join(rr, 'FEATURE-MAP.md')
  writeFileSync(fm, '# Feature map: x\n## Entry points\n| ID | Platform | Route/screen | Files |\n|---|---|---|---|\n| cart | desktop | /cart | src/pages/Cart.tsx:3 |\n\n## Data architecture\n')
  const withRows = vm(rr, '--radius', 'src/shared/Info.tsx', '--feature-map', fm)
  check('AC-9a.2 incident: one FEATURE-MAP row matched, the legacy importer without a row is still named in a warning', /^route \/cart /m.test(withRows.stdout) && /^warning: .*src\/pages\/Legacy\.tsx/m.test(withRows.stdout), withRows.stdout)
  check('AC-9a.2 legitimate: an intermediate component under a routed page is not named', !/Panel\.tsx/.test(withRows.stdout.split('\n').filter((line) => /^warning/.test(line)).join('\n')), withRows.stdout)
  const noRows = vm(rr, '--radius', 'src/shared/Info.tsx')
  check('AC-9a.2: without rows both unrouted importers are named', /^warning: .*src\/pages\/Cart\.tsx/m.test(noRows.stdout) && /src\/pages\/Legacy\.tsx/.test(noRows.stdout), noRows.stdout)
  writeFileSync(fm, '# Feature map: x\n## Entry points\n| ID | Platform | Route/screen | Files |\n|---|---|---|---|\n| cart | desktop | /cart | src/pages/Cart.tsx:3 |\n| legacy | desktop | /legacy | src/pages/Legacy.tsx |\n')
  check('AC-9a.2 legitimate: every importer has a row — no warning', !/^warning/m.test(vm(rr, '--radius', 'src/shared/Info.tsx', '--feature-map', fm).stdout))

  // AC-9a.3 (K9a.3): one map-root reader — a worktree with its own config, the README only in the main tree
  const { mapReadme, mapRoots, mapDir } = await import(join(PLUGIN, 'verify-map.mjs'))
  {
    const main = mkdtempSync(join(tmpdir(), 'v9a-main-'))
    dirs.push(main)
    repoAt(main, 'main')
    write(main, { '.claude/pipeline.config.md': CONFIG, '.claude/verify/README.md': README })
    const wt = `${main}-wt`
    dirs.push(wt)
    git(main, 'worktree', 'add', '-q', wt, '-b', 'T-91/feat/a')
    write(wt, { '.claude/pipeline.config.md': CONFIG })
    const roots = mapRoots(wt)
    check('AC-9a.3 incident: mapRoots of a worktree with its own config lists the worktree and the main tree, deduplicated', roots.length === 2 && roots[0] === realpathSync(wt) && roots.includes(realpathSync(main)) && new Set(roots).size === roots.length, JSON.stringify(roots))
    check('AC-9a.3 incident: the README that lives only in the main tree is found through mapRoots (what the hook asks)', Boolean(mapReadme(roots, CONFIG)) && mapReadme([wt], CONFIG) === null)
    const wtOut = vm(wt, '--changed')
    check('AC-9a.3: --changed in that worktree finds the map and prints the README absolute path', new RegExp(`^map: \\.claude/verify · 1 feature · README ${realpathSync(main).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.claude/verify/README\\.md$`, 'm').test(wtOut.stdout), wtOut.stdout + wtOut.stderr)
    check('AC-9a.3 legitimate: a plain repo gives one root', mapRoots(nuxt).length === 1)
    // the hook side, end to end: the worktree's own task, a new devtools-verify report without map:
    const tdir = join(wt, '.claude/tasks/T-91')
    write(wt, { '.claude/tasks/T-91/STAGES.md': '# T-91: task\nLanguage: en\nBranch: `T-91/feat/a`\n\n## Status: stage 1\n\n## Stages\n\n### Stage 1: x  [status: in-progress]\n- `AC-1.1` WHEN opened THEN the title shows — [verify: devtools-verify]\n' })
    jc.baselineInfo(DATA, tdir)
    const REPORT = '# devtools-verify — stage 1\nFindings: critical 0 · major 0 · minor 0\ndoctor: ok — http://localhost:3000 answers\nauth: not needed — no auth-gated criteria\ngeometry 1440: overflow 0 · zero-gap 0 · clipped 0\n\n## Stage criteria\n- `AC-1.1` — PASS, title «Orders» at 1440, `h1` 32px\n\n## Could not verify\n- nothing\n'
    write(wt, { '.claude/tasks/T-91/checks/devtools-verify-1.md': REPORT })
    const gateOut = runHook('journal-gate.mjs', { cwd: wt, tool_name: 'Write', tool_input: { file_path: join(tdir, 'checks/devtools-verify-1.md') } })
    check('AC-9a.3 incident (hook): the worktree\'s new devtools-verify report without map: is rejected — the hook sees the main tree\'s README', gateOut.decision === 'block' && /`map:` line/.test(gateOut.text), gateOut.text)
    write(wt, { '.claude/tasks/T-91/checks/devtools-verify-1.md': REPORT.replace('geometry 1440', 'map: orders · entries 1/1 · drift 0\ngeometry 1440') })
    const gateOk = runHook('journal-gate.mjs', { cwd: wt, tool_name: 'Write', tool_input: { file_path: join(tdir, 'checks/devtools-verify-1.md') } })
    check('AC-9a.3 legitimate (hook): the same report with the map: line passes', !/`map:` line/.test(gateOk.text), gateOk.text)
  }

  // K9a.4: `verify_map: —` turns the map off
  check('K9a.4 incident: README present and `verify_map: —` — mapReadme is null and mapDir says off', mapReadme([nuxt], `${CONFIG}- verify_map: —\n`) === null && mapDir(`${CONFIG}- verify_map: —\n`) === null && mapDir(`${CONFIG}- verify_map: none\n`) === null)
  check('K9a.4 legitimate: no key and a custom directory still resolve', mapDir(CONFIG) === '.claude/verify' && mapDir(`${CONFIG}- verify_map: docs/vm/\n`) === 'docs/vm')
  const offRepo = mkRepo({ ...mapFiles, '.claude/pipeline.config.md': `${CONFIG}- verify_map: —\n`, 'nuxt.config.ts': 'export default {}\n' })
  put(offRepo, 'pages/new.vue', '<template/>')
  const offOut = vm(offRepo, '--changed')
  check('K9a.4: --changed with the map off prints the single no-map line, --init writes nothing', offOut.status === 0 && /^verify-map: no map/.test(offOut.stdout) && offOut.stdout.trim().split('\n').length === 1 && /off/.test(vm(offRepo, '--init').stdout) && readFileSync(join(offRepo, '.claude/verify/README.md'), 'utf8') === README, offOut.stdout)

  // AC-9a.4 (K9a.5): the re-run citation names the same checker and stage, or a screen inside this task's checks/screens/
  {
    const task = mkdtempSync(join(tmpdir(), 'v9a-task-'))
    dirs.push(task)
    for (const file of ['devtools-verify-3-r1.md', 'devtools-verify-5-r1.md', 'devtools-verify-5-fresh.md', 'devtools-verify-5-recheck.md', 'devtools-verify-5-recheck-2.md', 'devtools-verify-5-repro.md', 'pro-review-5-r1.md']) put(task, `checks/${file}`, '# recheck\n')
    put(task, 'checks/screens/ok.png', 'png')
    const outside = mkdtempSync(join(tmpdir(), 'v9a-outside-'))
    dirs.push(outside)
    put(outside, 'screens/old.png', 'png')
    symlinkSync(join(outside, 'screens/old.png'), join(task, 'checks/screens/link.png'))
    const body = (line) => `# devtools-verify — stage 5\nFindings: critical 0 · major 1 · minor 0\n\n## Findings outcome\n${line}\n`
    const bad = (line, name = 'devtools-verify-5.md') => jc.rerunViolations(body(line), name, task).filter(({ rule }) => rule === 'no-rerun').length
    check('AC-9a.4 incident: a stage 5 report citing the stage 3 recheck is rejected', bad('- M-1 — fixed: src/Card.vue:12 — re-run checks/devtools-verify-3-r1.md') === 1)
    check('AC-9a.4 incident: another checker\'s r1 report (pro-review-5-r1.md) is not a devtools-verify re-run', bad('- M-1 — fixed: src/Card.vue:12 — re-run checks/pro-review-5-r1.md') === 1)
    check('AC-9a.4 incident: a screen that does not exist, one outside checks/, an absolute one and a ../ one are rejected', bad('- M-1 — fixed: a.vue:12 — checks/screens/none.png') === 1 && bad('- M-1 — fixed: a.vue:12 — screens/../../x/screens/old.png') === 1 && bad(`- M-1 — fixed: a.vue:12 — ${join(outside, 'screens/old.png')}`) === 1 && bad('- M-1 — fixed: a.vue:12 — ../elsewhere/screens/old.png') === 1)
    check('AC-9a.4 incident: a screen that is a symlink out of checks/screens/ is rejected', bad('- M-1 — fixed: a.vue:12 — checks/screens/link.png') === 1)
    check('AC-9a.4 incident: a -recheck citation that does not exist is rejected', bad('- M-1 — fixed: a.vue:12 — checks/devtools-verify-5-recheck-9.md') === 1)
    check('AC-9a.4 legitimate: r1, fresh, recheck, recheck-2 of the same stage and a screen of this task pass', ['devtools-verify-5-r1.md', 'devtools-verify-5-fresh.md', 'devtools-verify-5-recheck.md', 'devtools-verify-5-recheck-2.md'].every((name) => bad(`- M-1 — fixed: a.vue:12 — re-run checks/${name}`) === 0) && bad('- M-1 — fixed: a.vue:12 — checks/screens/ok.png') === 0 && bad('- M-1 — fixed: a.vue:12 — screens/ok.png') === 0)
    check('AC-9a.4 legitimate: the Russian outcome with the same stage recheck passes (\u0438\u0441\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e)', bad('- M-1 — \u0438\u0441\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e: src/Card.vue:12 — \u043f\u0435\u0440\u0435\u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 checks/devtools-verify-5-recheck.md') === 0)
    check('AC-9a.4: -repro is not a re-run artifact (it is the before-fix observation)', bad('- M-1 — fixed: a.vue:12 — checks/devtools-verify-5-repro.md') === 1)
    check('AC-9a.4: the report itself (a -r1 report citing itself) is not its own re-run', bad('- M-1 — fixed: a.vue:12 — checks/devtools-verify-5-r1.md', 'devtools-verify-5-r1.md') === 1)
  }

  // K9a.6: -r<k> and -repro reports are partial runs — no geometry / style-diff rules; doctor: and auth: stay
  {
    const task = mkdtempSync(join(tmpdir(), 'v9a-partial-'))
    dirs.push(task)
    put(task, 'STAGES.md', '# T-92: task\n\n## Stages\n\n### Stage 5: x  [status: in-progress]\nVisual reference: prototype/orders.html\n- `AC-5.1` WHEN opened THEN shown — [verify: devtools-verify]\n')
    const hasGeometry = (text, name, fresh = true) => jc.runtimeViolations(text, name, task, fresh).map(({ rule }) => rule)
    const repro = '# devtools-verify — stage 5, repro\nFindings: critical 0 · major 0 · minor 0\ndoctor: ok — http://localhost:3000 answers\nauth: ok\n\n## Readings\n- before: 12px · after: 12px\n'
    check('K9a.6 incident: a -r1 and a -repro report without geometry or style-diff lines pass the runtime rules', !hasGeometry(repro, 'devtools-verify-5-r1.md').length && !hasGeometry(repro, 'devtools-verify-5-repro.md').length, JSON.stringify(hasGeometry(repro, 'devtools-verify-5-r1.md')))
    check('K9a.6 legitimate: the full report of the same stage still needs geometry and style-diff', ['no-geometry', 'no-style-diff'].every((rule) => hasGeometry(repro, 'devtools-verify-5.md').includes(rule)))
    check('K9a.6: doctor: and auth: still apply to a -r1 report', hasGeometry('# devtools-verify — stage 5, recheck\nFindings: critical 0 · major 0 · minor 0\n', 'devtools-verify-5-r1.md').filter((rule) => rule === 'no-doctor').length === 2)
    check('K9a.6: -fresh is not a partial run by name (the fresh pass is a full one)', hasGeometry(repro, 'devtools-verify-5-fresh.md').includes('no-geometry'))
  }

  // AC-9a.5 (K9a.8): --base resolves to a commit before it reaches git diff
  {
    const base = mkRepo({ ...mapFiles, 'nuxt.config.ts': 'export default {}\n', 'pages/index.vue': '<template/>' })
    const victim = join(base, 'pwned.txt')
    const opt = vm(base, '--changed', '--base', `--output=${victim}`)
    check('AC-9a.5 incident: an option-like --base exits 2, names the base and writes nothing', opt.status === 2 && /is not a commit/.test(opt.stdout) && !existsSync(victim), opt.stdout + opt.stderr)
    check('AC-9a.5: a dash-leading and an unknown --base both exit 2', vm(base, '--changed', '--base', '-p').status === 2 && vm(base, '--changed', '--base', 'no-such-ref').status === 2)
    check('AC-9a.5 legitimate: HEAD and a branch name still work as --base', vm(base, '--changed', '--base', 'HEAD').status === 0 && vm(base, '--changed', '--base', git(base, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).status === 0)
  }

  // K9a.9: --init from the shared config only, no credentials, no write through a symlink out of the repo
  {
    const initRepo = mkRepo({ '.claude/pipeline.config.md': `${CONFIG.replace('http://localhost:3000', 'https://user:pw@stand.example')}- e2e: E2E_TOKEN=tok_shared pnpm test:e2e\n` })
    put(initRepo, '.claude/pipeline.config.local.md', '## Dev server\n- url: https://admin:s3cret@staging.internal.example\n- e2e: E2E_TOKEN=tok_live_123 pnpm e2e:local\n')
    check('K9a.9 incident: --init exits 0', vm(initRepo, '--init').status === 0)
    const text = readFileSync(join(initRepo, '.claude/verify/README.md'), 'utf8')
    check('K9a.9 incident: the README holds nothing of the gitignored local config and no userinfo or leading KEY=value', !/s3cret|tok_live|staging\.internal|pw@|E2E_TOKEN|tok_shared/.test(text) && text.includes('- Dev: https://stand.example\n') && text.includes('- E2E command: pnpm test:e2e\n'), text)
    const linked = mkRepo({ '.claude/pipeline.config.md': CONFIG })
    const away = mkdtempSync(join(tmpdir(), 'v9a-away-'))
    dirs.push(away)
    symlinkSync(away, join(linked, '.claude/verify'))
    const linkOut = vm(linked, '--init')
    check('K9a.9 incident: --init refuses a map directory that is a symlink out of the repo and writes nothing there', linkOut.status === 2 && /symlink that leaves the repo/.test(linkOut.stdout) && !existsSync(join(away, 'README.md')), linkOut.stdout + linkOut.stderr)
    const broken = mkRepo({ '.claude/pipeline.config.md': CONFIG })
    mkdirSync(join(broken, '.claude/verify'), { recursive: true })
    symlinkSync(join(broken, 'nowhere.md'), join(broken, '.claude/verify/README.md'))
    const brokenOut = vm(broken, '--init')
    check('K9a.9 incident: a broken README symlink is one line, no stack trace', brokenOut.status === 2 && /broken symlink/.test(brokenOut.stdout) && brokenOut.stdout.trim().split('\n').length === 1 && !/\n\s+at /.test(brokenOut.stderr), brokenOut.stdout + brokenOut.stderr)
    const plain = mkRepo({ '.claude/pipeline.config.md': CONFIG })
    check('K9a.9 legitimate: a plain repo gets its README, a second --init leaves it', vm(plain, '--init').status === 0 && /left as it is/.test(vm(plain, '--init').stdout))
  }

  // AC-9a.6 / K9a.7: the map is repo data — --radius caps the primary path and drops absolute URLs, --lint flags them
  {
    const evil = `${' very long step'.repeat(30)} https://evil.example/other-site open it`
    const rad = mkRepo({ ...mapFiles, '.claude/verify/features/orders.md': FEATURE().replace('- Header → «Orders»', `- Header → «Orders» ${evil}`), 'nuxt.config.ts': 'export default {}\n', 'components/Info.vue': '<template/>', 'pages/orders/[id].vue': '<script setup>import Info from "~/components/Info.vue"</script><template><Info/></template>' })
    const out = vm(rad, '--radius', 'components/Info.vue')
    const feature = out.stdout.split('\n').find((line) => line.startsWith('feature orders'))
    check('K9a.7 incident: the primary path printed by --radius has no absolute URL and is at most 200 characters plus the ellipsis', Boolean(feature) && !/https?:\/\//.test(feature) && feature.replace(/^feature orders — primary path: /, '').replace(/ \(features\/orders\.md\)$/, '').length <= 201, feature)
    check('K9a.7 legitimate: a short plain primary path is printed as it is', /primary path: Header → «Orders» \(features\/orders\.md\)$/m.test(vm(mkRepo({ ...mapFiles, 'nuxt.config.ts': 'export default {}\n', 'components/Info.vue': '<template/>', 'pages/orders/[id].vue': '<script setup>import Info from "~/components/Info.vue"</script><template><Info/></template>' }), '--radius', 'components/Info.vue').stdout))
    const lintFile = join(rad, 'f.md')
    writeFileSync(lintFile, FEATURE(' · open https://evil.example/x'))
    const lint = spawnSync(process.execPath, [VM, '--lint', lintFile], { encoding: 'utf8', timeout: 30_000 })
    check('K9a.7 incident: --lint flags an absolute http(s) URL with its line', lint.status === 1 && /absolute URL "https:\/\/evil\.example\/x"/.test(lint.stdout), lint.stdout)
    writeFileSync(lintFile, FEATURE(' · deep link /orders?from=push'))
    check('K9a.7 legitimate: --lint passes a route with a query', spawnSync(process.execPath, [VM, '--lint', lintFile], { encoding: 'utf8' }).status === 0)
    // R7: a header without Status, a header without a route
    writeFileSync(lintFile, FEATURE('', 'Routes: /orders · Auth: yes · Platforms: desktop'))
    const noStatus = spawnSync(process.execPath, [VM, '--lint', lintFile], { encoding: 'utf8' })
    check('R7 --lint: a header line without Status: is named', noStatus.status === 1 && /no "Status: draft \| verified/.test(noStatus.stdout), noStatus.stdout)
    writeFileSync(lintFile, FEATURE('', 'Routes: orders · Auth: yes · Platforms: desktop · Status: draft'))
    const noRoute = spawnSync(process.execPath, [VM, '--lint', lintFile], { encoding: 'utf8' })
    check('R7 --lint: a header line without a route (no leading /) is named', noRoute.status === 1 && /names no route/.test(noRoute.stdout), noRoute.stdout)
    // K9a.10: a very long line is cut before the path regex
    writeFileSync(lintFile, FEATURE(` ${'[a]'.repeat(30000)}`))
    const started = Date.now()
    const longLint = spawnSync(process.execPath, [VM, '--lint', lintFile], { encoding: 'utf8', timeout: 30_000 })
    check('K9a.10 --lint: a feature line of 90 000 characters is read in well under 5 s (8 s+ before)', longLint.status !== null && Date.now() - started < 5000, `${Date.now() - started} ms`)
  }

  // K9a.10: CLI hardening of the radius walk — a file name with regex characters, a FIFO, an import-less file with no semicolons
  {
    const hard = mkRepo({ 'nuxt.config.ts': 'export default {}\n', 'components/B(.vue': '<template/>', 'components/A(x+x+)+y.vue': '<template/>', 'pages/p.vue': `<template><B( /><A(x+x+)+y /><Axxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx!</template>`, 'shared.ts': 'export const s = 1\n' })
    const hardOut = vm(hard, '--radius', 'shared.ts')
    check('K9a.10 incident: component files named B(.vue and A(x+x+)+y.vue do not break or stall --radius', hardOut.status === 0, hardOut.stdout + hardOut.stderr)
    const fifo = join(tmpdir(), `v9a-fifo-${process.pid}`)
    const made = spawnSync('mkfifo', [fifo])
    if (made.status === 0) {
      symlinkSync(fifo, join(hard, 'evil.ts'))
      const began = Date.now()
      const fifoOut = vm(hard, '--radius', 'shared.ts')
      check('K9a.10 incident: a symlink to a FIFO is skipped, --radius does not block', fifoOut.status === 0 && Date.now() - began < 10_000, `${fifoOut.status} ${Date.now() - began} ms ${fifoOut.stderr}`)
      rmSync(fifo, { force: true })
    }
    const flat = mkRepo({ 'nuxt.config.ts': 'export default {}\n', 'shared.ts': 'export const s = 1\n', 'big.ts': 'export const a = 1\n'.repeat(27_000) })
    const began = Date.now()
    const flatOut = vm(flat, '--radius', 'shared.ts')
    check('K9a.10 incident: a 513 KB file with no semicolon and no quote is scanned in a bounded time (more than 8 s before)', flatOut.status === 0 && Date.now() - began < 8000, `${flatOut.status} ${Date.now() - began} ms`)
  }

  // K9a.10 / R2 / R3: the report rules of the hook — CRLF, long lines, table-row verdicts, the 22-date line
  {
    const task = mkdtempSync(join(tmpdir(), 'v9a-rules-'))
    dirs.push(task)
    const JOURNAL = '# T-93: task\nLanguage: en\n\n## Stages\n\n### Stage 9: effects  [status: in-progress]\n- `AC-9.1` WHEN signed THEN POST /api/contracts saves it — [verify: devtools-verify] [effect]\n'
    put(task, 'STAGES.md', JOURNAL)
    const head = '# devtools-verify — stage 9\nFindings: critical 0 · major 0 · minor 0\n\n## Stage criteria\n'
    const eff = (criteria, journal) => {
      if (journal) put(task, 'STAGES.md', journal)
      const found = jc.effectViolations(`${head}${criteria}`, 'devtools-verify-9.md', task).length
      put(task, 'STAGES.md', JOURNAL)
      return found
    }
    check('K9a.10 incident: a CRLF journal and a CRLF report still apply the [effect] rule', eff('- `AC-9.1` — PASS, the card shows signed\r\n', JOURNAL.replace(/\n/g, '\r\n')) === 1)
    check('K9a.10 legitimate: the CRLF report with the request and the read-back passes', eff('- `AC-9.1` — PASS, `POST /api/contracts → 201`; read-back after reload: signed\r\n', JOURNAL.replace(/\n/g, '\r\n')) === 0)
    check('R2 incident: a table row `| AC-9.1 | PASS |` without proof is rejected', eff('| Criterion | Verdict | Evidence |\n|---|---|---|\n| AC-9.1 | PASS | the card shows signed |\n') === 1)
    check('R2 legitimate: the table row with the request and the read-back passes', eff('| Criterion | Verdict | Evidence |\n|---|---|---|\n| AC-9.1 | PASS | POST /api/contracts → 201; read-back after reload: signed |\n') === 0)
    let began = Date.now()
    const dates = Array.from({ length: 24 }, (_, i) => `${String((i % 28) + 1).padStart(2, '0')}.10.2026`).join(' ')
    const dated = `- AC-9.1 PASS — the table lists rows dated ${dates}\n`
    jc.barePasses(dated)
    eff(dated)
    check('K9a.10 incident: a PASS line with 24 dotted dates is read in under 1 s by both readers (about 10 s each before)', Date.now() - began < 1000, `${Date.now() - began} ms`)
    began = Date.now()
    eff(`- AC-9.1 ${' *'.repeat(50_000)}x PASS\n`)
    put(task, 'STAGES.md', `${JOURNAL}- AC-9.2 x${' [verify:'.repeat(30_000)}\n`)
    jc.effectCriteria(task)
    put(task, 'STAGES.md', JOURNAL)
    check('K9a.10 incident: a 100 KB line of "*" and a 270 KB line of "[verify:" cost the hook less than 1 s', Date.now() - began < 1000, `${Date.now() - began} ms`)
    const bare = jc.barePasses('- AC-3.1 PASS\n- AC-3.2 PASS, `a.ts:12` measured 12px\n')
    check('K9a.10 legitimate: PASS_RUN still reads ids — a bare PASS is found, a measured one is not', bare.length === 1 && bare[0] === 'AC-3.1', JSON.stringify(bare))
    check('K9a.12: the [effect] message reads "does not name the request", not "names no the request"', (() => { const message = jc.effectViolations(`${head}- \`AC-9.1\` — PASS, shown\n`, 'devtools-verify-9.md', task)[0]?.message ?? ''; return /does not name the request/.test(message) && !/no the/.test(message) })())
    check('K9a.12: EFFECT_TAG is gone from markers.mjs', !('EFFECT_TAG' in markers))
    // R3: a missing checks/screens/ file and a -recheck citation through the full ledger reader
    put(task, 'checks/devtools-verify-9-recheck.md', '# recheck\n')
    const rerun = (line) => jc.rerunViolations(`# devtools-verify — stage 9\nFindings: critical 0 · major 1 · minor 0\n\n## Findings outcome\n${line}\n`, 'devtools-verify-9.md', task).length
    check('R3 incident: a fixed that cites a checks/screens/ file that is not on disk is rejected', rerun('- M-1 — fixed: a.vue:12 — checks/screens/missing.png') === 1)
    check('R3 legitimate: a fixed that cites an existing -recheck report passes', rerun('- M-1 — fixed: a.vue:12 — checks/devtools-verify-9-recheck.md') === 0)
  }

  // review item: an -r1 report written through the hook is not bounced for geometry it was not asked for
  {
    const mRoot = mkdtempSync(join(tmpdir(), 'v9a-hook-'))
    dirs.push(mRoot)
    const mApp = join(mRoot, 'app')
    repoAt(mApp, 'main')
    const tdir = join(mApp, '.claude/tasks/T-94')
    write(mApp, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n', '.claude/tasks/T-94/STAGES.md': '# T-94: task\nLanguage: en\nBranch: `T-94/feat/a`\n\n## Status: stage 1\n\n## Stages\n\n### Stage 1: x  [status: in-progress]\n- `AC-1.1` WHEN opened THEN the title shows — [verify: devtools-verify]\n' })
    git(mApp, 'checkout', '-qb', 'T-94/feat/a')
    jc.baselineInfo(DATA, tdir)
    write(mApp, { '.claude/tasks/T-94/checks/devtools-verify-1-r1.md': '# devtools-verify — stage 1, recheck\nFindings: critical 0 · major 0 · minor 0\ndoctor: ok — http://localhost:3000 answers\nauth: not needed — no auth-gated criteria\n\n## Stage criteria\n- `AC-1.1` — PASS, title «Orders» at 1440, `h1` 32px\n\n## Could not verify\n- nothing\n' })
    const r1 = runHook('journal-gate.mjs', { cwd: mApp, tool_name: 'Write', tool_input: { file_path: join(tdir, 'checks/devtools-verify-1-r1.md') } })
    check('K9a.6 gate: a new -r1 report with doctor:, auth: and no geometry lines passes the hook', !/geometry/.test(r1.text), r1.text)
    write(mApp, { '.claude/tasks/T-94/checks/devtools-verify-1.md': '# devtools-verify — stage 1\nFindings: critical 0 · major 0 · minor 0\ndoctor: ok — http://localhost:3000 answers\nauth: not needed — no auth-gated criteria\n\n## Stage criteria\n- `AC-1.1` — PASS, title «Orders» at 1440, `h1` 32px\n\n## Could not verify\n- nothing\n' })
    const full = runHook('journal-gate.mjs', { cwd: mApp, tool_name: 'Write', tool_input: { file_path: join(tdir, 'checks/devtools-verify-1.md') } })
    check('K9a.6 gate: the full report of the same stage without geometry is still rejected', full.decision === 'block' && /geometry/.test(full.text), full.text)
  }

  // round 2 (final check): the radius names every importer without a route, -recheck is partial, stage-<N>-devtools-verify naming, bare citations, local verify_map in --init
  {
    const rrLayout = mkRepo({
      ...mapFiles,
      'package.json': '{"dependencies":{"react-router-dom":"6"}}\n',
      'src/shared/Info.tsx': 'export const Info = () => null\n',
      'src/pages/Cart.tsx': 'import { Info } from "../shared/Info"\nexport default 1\n',
      'src/pages/Legacy.tsx': 'import { Info } from "../shared/Info"\nexport default 2\n',
      'src/App.tsx': 'import Cart from "./pages/Cart"\nimport Legacy from "./pages/Legacy"\nexport const routes = [{ path: "/cart", element: Cart }, { path: "/old", element: Legacy }]\n',
      'src/main.tsx': 'import { routes } from "./App"\nconsole.log(routes)\n',
    })
    const fmL = join(rrLayout, 'FEATURE-MAP.md')
    writeFileSync(fmL, '# Feature map: x\n## Entry points\n| ID | Platform | Route/screen | Files |\n|---|---|---|---|\n| cart | desktop | /cart | src/pages/Cart.tsx:3 |\n')
    const outL = vm(rrLayout, '--radius', 'src/shared/Info.tsx', '--feature-map', fmL)
    check('round 2 M-1 incident: React Router route table (App imports every page, main imports App) — the unrouted Legacy.tsx is named, not only main.tsx', /^warning: .*src\/pages\/Legacy\.tsx/m.test(outL.stdout), outL.stdout)
    check('round 2 M-1: with rows given the warning does not advise passing --feature-map; the routed Cart.tsx is not named', !/pass --feature-map/.test(outL.stdout) && !/^warning: .*src\/pages\/Cart\.tsx/m.test(outL.stdout), outL.stdout)
    check('round 2 M-1: without rows the advice stays', /pass --feature-map/.test(vm(rrLayout, '--radius', 'src/shared/Info.tsx').stdout))
    const nuxtLayout = mkRepo({ ...mapFiles, 'nuxt.config.ts': 'export default {}\n', 'components/Info.vue': '<template/>' })
    put(nuxtLayout, 'layouts/default.vue', '<script setup>import Info from "~/components/Info.vue"</script><template><Info/></template>')
    put(nuxtLayout, 'pages/orders/[id].vue', '<script setup>import Info from "~/components/Info.vue"</script><template><Info/></template>')
    const outN = vm(nuxtLayout, '--radius', 'components/Info.vue')
    check('round 2 M-1 incident: a Nuxt layout importing the shared module is named in a warning, as a layout', /^warning: .*layouts\/default\.vue \(a layout or root file, not a page\)/m.test(outN.stdout) && !/^warning: .*pages\/orders/m.test(outN.stdout), outN.stdout)

    // C3: a verify_map set only in the local config is read by --init as it is by --changed
    const localMap = mkRepo({ '.claude/pipeline.config.md': CONFIG, 'nuxt.config.ts': 'export default {}\n' })
    put(localMap, '.claude/pipeline.config.local.md', '## Task state\n- verify_map: docs/verify/\n')
    const initLocal = vm(localMap, '--init')
    check('round 2 C3 incident: --init writes the README into the local verify_map directory, not .claude/verify/', initLocal.status === 0 && existsSync(join(localMap, 'docs/verify/README.md')) && !existsSync(join(localMap, '.claude/verify/README.md')), initLocal.stdout + initLocal.stderr)
    check('round 2 C3: --changed then finds that map', /^map: docs\/verify/m.test(vm(localMap, '--changed').stdout), vm(localMap, '--changed').stdout)

    // m-4: the README lists the routes the doctor uses
    const { readmeText } = await import(join(PLUGIN, 'verify-map.mjs'))
    const readme = readmeText({ config: `${CONFIG.replace('/, /orders', '/, orders, /cart?x=1')}`, language: 'en', base: 'abc', branch: 'main', date: '2026-10-27' })
    check('round 2 m-4 incident: verify_routes "/, orders, /cart?x=1" — the README lists the doctor\'s routes (/, /cart?x=1), not the raw value', readme.includes('/, /cart?x=1') && !readme.includes('orders'), readme)

    // m-1 / m-2 / C2: the citation of a stage-<N>-devtools-verify report, bare names, -recheck as a partial run
    const task = mkdtempSync(join(tmpdir(), 'v9a2-task-'))
    dirs.push(task)
    for (const file of ['devtools-verify-3-r1.md', 'stage-3-devtools-verify-r1.md', 'devtools-verify-5-r1.md']) put(task, `checks/${file}`, '# recheck\n')
    const elsewhere = mkdtempSync(join(tmpdir(), 'v9a2-else-'))
    dirs.push(elsewhere)
    put(elsewhere, 'checks/devtools-verify-5-r1.md', '# recheck\n')
    const body = (line) => `# devtools-verify — stage 3\nFindings: critical 0 · major 1 · minor 0\n\n## Findings outcome\n${line}\n`
    const bad = (line, name) => jc.rerunViolations(body(line), name, task).filter(({ rule }) => rule === 'no-rerun').length
    check('round 2 m-1 legitimate: a stage-3-devtools-verify.md report may cite devtools-verify-3-r1.md and stage-3-devtools-verify-r1.md', ['devtools-verify-3-r1.md', 'stage-3-devtools-verify-r1.md'].every((cited) => bad(`- M-1 — fixed: a.vue:12 — re-run checks/${cited}`, 'stage-3-devtools-verify.md') === 0))
    check('round 2 m-1 incident: the same report citing the stage 5 recheck is rejected', bad('- M-1 — fixed: a.vue:12 — checks/devtools-verify-5-r1.md', 'stage-3-devtools-verify.md') === 1)
    check('round 2 C2 legitimate: a bare name and checks/<name> both pass', bad('- M-1 — fixed: a.vue:12 — devtools-verify-3-r1.md', 'devtools-verify-3.md') === 0 && bad('- M-1 — fixed: a.vue:12 — checks/devtools-verify-3-r1.md', 'devtools-verify-3.md') === 0)
    check('round 2 C2 incident: ../../other/checks/<name> and /etc/passwd/<name> are rejected although a same-named report exists here', bad('- M-1 — fixed: a.vue:12 — ../../other/checks/devtools-verify-3-r1.md', 'devtools-verify-3.md') === 1 && bad('- M-1 — fixed: a.vue:12 — /etc/passwd/devtools-verify-3-r1.md', 'devtools-verify-3.md') === 1 && bad(`- M-1 — fixed: a.vue:12 — ${join(elsewhere, 'checks/devtools-verify-5-r1.md')}`, 'devtools-verify-5.md') === 1)
    const full = '# devtools-verify — stage 5, recheck\nFindings: critical 0 · major 0 · minor 0\ndoctor: ok — http://localhost:3000 answers\nauth: ok\n'
    const rules = (name, map = false) => jc.runtimeViolations(full, name, task, true, map).map(({ rule }) => rule)
    check('round 2 m-2 incident: -recheck, -recheck-2 and stage-5-devtools-verify-r1.md are partial runs (no geometry rule)', ['devtools-verify-5-recheck.md', 'devtools-verify-5-recheck-2.md', 'stage-5-devtools-verify-r1.md'].every((name) => !rules(name).includes('no-geometry')))
    check('round 2 m-2 legitimate: -fresh and the plain stage-5 report still need geometry', rules('devtools-verify-5-fresh.md').includes('no-geometry') && rules('stage-5-devtools-verify.md').includes('no-geometry'))
    check('round 2 m-3 incident: in a mapped repo a -r1 report without map: is not rejected, the full report is', !rules('devtools-verify-5-r1.md', true).includes('no-map') && !rules('devtools-verify-5-repro.md', true).includes('no-map') && rules('devtools-verify-5.md', true).includes('no-map'))
  }

  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

// ── stage 9b (VT-4): the radius note, real FEATURE-MAP rows, more [effect] PASS shapes, own-stem re-run names, bounded map files ───────
{
  const VM = join(PLUGIN, 'verify-map.mjs')
  const vm = (cwd, ...args) => spawnSync(process.execPath, [VM, '--cwd', cwd, ...args], { encoding: 'utf8', timeout: 30_000 })
  const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' })
  const put = (root, file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  const dirs = []
  const mkRepo = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'v9b-'))
    dirs.push(root)
    gitIn(root, 'init', '-q')
    for (const [file, text] of Object.entries(files)) put(root, file, text)
    gitIn(root, 'add', '-A')
    gitIn(root, 'commit', '-q', '-m', 'base')
    return root
  }
  const CONFIG = '# Pipeline config — fx\n## Project\n- slug: fx\n## Task state\n- task_path: .claude/tasks/\n'
  const README = '# Verify map — fx\nBase: abc (main) · Updated: 2026-10-27\n## Features (sweep order)\n- [orders](features/orders.md) — /orders/:orderId\n'
  const FEATURE = '# orders\nRoutes: /orders/:orderId · Auth: yes · Platforms: desktop · Status: draft\nThe user can use orders.\n## Sub-features\n- `orders-open`\n## How to get to it (user POV)\n- Header → «Orders»\n## Driving it with Chrome DevTools MCP\n- **Header entry.** click `link "Orders"`.\n## Gotchas\n- none\n'
  const mapFiles = { '.claude/pipeline.config.md': CONFIG, '.claude/verify/README.md': README, '.claude/verify/features/orders.md': FEATURE }
  const { featureMapRows } = await import(join(PLUGIN, 'verify-map.mjs'))

  // AC-9b.1 (K9b.1, M-1, C1): a page behind a routed route table is named on a `note:` line, not dropped and not a warning
  const rr = mkRepo({
    ...mapFiles,
    'package.json': '{"dependencies":{"react-router-dom":"6"}}\n',
    'src/shared/Info.tsx': 'export const Info = () => null\n',
    'src/pages/Cart.tsx': 'import { Info } from "../shared/Info"\nexport default 1\n',
    'src/pages/Legacy.tsx': 'import { Info } from "../shared/Info"\nexport default 2\n',
    'src/App.tsx': 'import Cart from "./pages/Cart"\nimport Legacy from "./pages/Legacy"\nexport const routes = [{ path: "/", element: null }, { path: "/cart", element: Cart }, { path: "/old", element: Legacy }]\n',
    'src/main.tsx': 'import { routes } from "./App"\nconsole.log(routes)\n',
  })
  const fm = join(rr, 'FEATURE-MAP.md')
  writeFileSync(fm, '# Feature map: x\n## Entry points\n| ID | Platform | Route/screen | Files |\n|---|---|---|---|\n| home | desktop | / | src/App.tsx:3 |\n| cart | desktop | /cart | src/pages/Cart.tsx:3 |\n\n## Data architecture\n')
  const hidden = vm(rr, '--radius', 'src/shared/Info.tsx', '--feature-map', fm)
  const hiddenLines = hidden.stdout.split('\n')
  check('AC-9b.1 incident: a row names the route table; the page it imports is named on a note: line, and both routes are listed', /^route \/ /m.test(hidden.stdout) && /^route \/cart /m.test(hidden.stdout) && hiddenLines.some((line) => /^note: .*src\/pages\/Legacy\.tsx.*behind a routed importer \(src\/App\.tsx\) — check whether it is a route of its own/.test(line)), hidden.stdout)
  check('AC-9b.1: the note is not a warning, and the unrouted root file still is one (the 9a rule stays)', !hiddenLines.some((line) => /^warning:.*Legacy/.test(line)) && hiddenLines.some((line) => /^warning: .*src\/main\.tsx/.test(line)), hidden.stdout)
  check('AC-9b.1 legitimate: a routed page (a row names it) is on neither a note nor a warning', !/Cart\.tsx.*behind/.test(hidden.stdout) && !hiddenLines.some((line) => /^(?:warning|note):.*Cart\.tsx/.test(line)), hidden.stdout)
  const nuxtNote = mkRepo({ ...mapFiles, 'nuxt.config.ts': 'export default {}\n', 'utils/fmt.ts': 'export const f = 1\n', 'components/A.vue': '<script setup>import { f } from "~/utils/fmt"</script><template/>', 'pages/p.vue': '<script setup>import A from "~/components/A.vue"</script><template><A/></template>' })
  const nuxtNoteOut = vm(nuxtNote, '--radius', 'utils/fmt.ts')
  check('AC-9b.1: a Nuxt component under a routed page is a note naming the page, not a warning', /^route \/p /m.test(nuxtNoteOut.stdout) && /^note: components\/A\.vue: behind a routed importer \(pages\/p\.vue\)/m.test(nuxtNoteOut.stdout) && !/^warning/m.test(nuxtNoteOut.stdout), nuxtNoteOut.stdout)
  put(nuxtNote, 'components/B.vue', '<script setup>import { f } from "~/utils/fmt"</script><template/>')
  const nuxtTwo = vm(nuxtNote, '--radius', 'utils/fmt.ts')
  check('AC-9b.1 legitimate: a component with an unrouted importer too is still a warning (9a)', /^warning: .*components\/B\.vue/m.test(nuxtTwo.stdout), nuxtTwo.stdout)

  // AC-9b.2 (K9b.2, M-2): rows as feature-checker writes them — a shape of a real dashboard row, synthetic names
  const REAL = '# \u041a\u0430\u0440\u0442\u0430 \u0444\u0438\u0447\u0438: guest\n## \u0422\u043e\u0447\u043a\u0438 \u0432\u0445\u043e\u0434\u0430\n| \u041f\u043b\u0430\u0442\u0444\u043e\u0440\u043c\u0430 | \u0420\u043e\u0443\u0442/\u044d\u043a\u0440\u0430\u043d | \u0424\u0430\u0439\u043b |\n|---|---|---|\n| desktop | `/bookings/:id/guest/:guestId` | [getRoutes.tsx:73](apps/dashboard/src/apps/getRoutes.tsx#L73), pages/Guest.tsx:3 |\n| desktop | `/trips` (\u0441\u043f\u0438\u0441\u043e\u043a) | [Trips.tsx](apps/dashboard/src/pages/Trips.tsx#L12-L40) |\n| desktop | `/misc` | s/Other.tsx |\n\n## \u0410\u0440\u0445\u0438\u0442\u0435\u043a\u0442\u0443\u0440\u0430 \u0434\u0430\u043d\u043d\u044b\u0445\n'
  const rows = featureMapRows(REAL)
  check('AC-9b.2: the \u0420\u043e\u0443\u0442/\u044d\u043a\u0440\u0430\u043d and \u0424\u0430\u0439\u043b columns are read', rows.length === 3 && rows[0].route.includes('/bookings') && rows[0].files.includes('Guest.tsx'), JSON.stringify(rows))
  const real = mkRepo({ ...mapFiles, 'package.json': '{"dependencies":{"react-router-dom":"6"}}\n', 'apps/dashboard/src/pages/Guest.tsx': 'export default 1\n', 'apps/dashboard/src/pages/Trips.tsx': 'export default 1\n', 'apps/dashboard/src/pages/Other.tsx': 'export default 1\n' })
  const realFm = join(real, 'FEATURE-MAP.md')
  writeFileSync(realFm, REAL)
  for (const file of ['Guest', 'Trips', 'Other']) put(real, `apps/dashboard/src/pages/${file}.tsx`, 'export default 2\n')
  const realOut = vm(real, '--changed', '--feature-map', realFm)
  check('AC-9b.2 incident: a backticked route, a #L anchor and an app-relative path (pages/Guest.tsx) give routes, no warning for them', /^route \/bookings\/:id\/guest\/:guestId /m.test(realOut.stdout) && /^route \/trips /m.test(realOut.stdout) && !/warning: .*(?:Guest|Trips)\.tsx/.test(realOut.stdout), realOut.stdout)
  check('AC-9b.2 legitimate: a path that is not on a segment boundary (s/Other.tsx for .../pages/Other.tsx) is not a match', !/^route \/misc /m.test(realOut.stdout) && /^warning: .*Other\.tsx/m.test(realOut.stdout), realOut.stdout)
  const english = featureMapRows('## Entry points\n| ID | Platform | Route/screen | Files |\n|---|---|---|---|\n| a | web | /a | src/a.tsx |\n')
  check('AC-9b.2 legitimate: the English Route/screen and Files columns still read', english.length === 1 && english[0].route === '/a' && english[0].files === 'src/a.tsx', JSON.stringify(english))

  // AC-9b.3 (K9b.3, m-3, m-4): the [effect] PASS shapes
  {
    const task = mkdtempSync(join(tmpdir(), 'v9b-task-'))
    dirs.push(task)
    put(task, 'STAGES.md', '# T-95: task\nLanguage: en\nBranch: `T-95/feat/a`\n\n## Stages\n\n### Stage 9: effects  [status: in-progress]\n- `AC-9.1` WHEN the contract is signed THEN POST /api/contracts saves it — [verify: devtools-verify] [effect]\n')
    const head = '# devtools-verify — stage 9\nFindings: critical 0 · major 0 · minor 0\ndoctor: ok — http://localhost:3000 answers\nauth: not needed — no auth-gated criteria\ngeometry 1440: overflow 0 · zero-gap 0 · clipped 0\n\n## Stage criteria\n'
    const eff = (criteria) => jc.effectViolations(`${head}${criteria}\n## Could not verify\n- nothing\n`, 'devtools-verify-9.md', task).filter(({ rule }) => rule === 'no-effect-proof').length
    const PROOF = '`POST /api/contracts → 201`; read-back after reload: signed'
    for (const [label, line] of [['a parenthetical', '- `AC-9.1` (1440) — PASS'], ['a check mark', '- AC-9.1 ✅ PASS'], ['a bare id', '- 9.1 PASS']]) {
      check(`AC-9b.3 incident: ${label} PASS without proof is rejected`, eff(`${line}, the card shows signed\n`) === 1)
      check(`AC-9b.3 legitimate: ${label} PASS with the request and the read-back on the line passes`, eff(`${line} — ${PROOF}\n`) === 0)
    }
    check('AC-9b.3 legitimate: the evidence under a bare-id PASS line counts', eff(`- 9.1 PASS\n  - ${PROOF}\n`) === 0)
    check('AC-9b.3: a parenthetical longer than 60 characters is not a verdict position; FAIL with a qualifier is not a PASS', eff(`- \`AC-9.1\` (${'x'.repeat(70)}) — PASS\n`) === 0 && eff('- `AC-9.1` (1440) — FAIL: no request\n') === 0)
  }

  // m-2 (K9b.4): re-run names from the report's own stem
  {
    const task = mkdtempSync(join(tmpdir(), 'v9b-rerun-'))
    dirs.push(task)
    const etap = '\u044d\u0442\u0430\u043f'
    for (const file of ['devtools-verify-branch-r1.md', 'devtools-verify-branch-fresh.md', 'devtools-verify-r1.md', `${etap}-5-devtools-verify-r1.md`, 'devtools-verify-5-r1.md']) put(task, `checks/${file}`, '# recheck\n')
    const bad = (cited, name) => jc.rerunViolations(`# devtools-verify\nFindings: critical 0 · major 1 · minor 0\n\n## Findings outcome\n- M-1 — fixed: a.vue:12 — re-run ${cited}\n`, name, task).filter(({ rule }) => rule === 'no-rerun').length
    check('m-2 incident: devtools-verify-branch.md cites its own -r1 and -fresh reports', bad('checks/devtools-verify-branch-r1.md', 'devtools-verify-branch.md') === 0 && bad('devtools-verify-branch-fresh.md', 'devtools-verify-branch.md') === 0)
    check('m-2 incident: the report of a Russian stage name cites its -r1', bad(`checks/${etap}-5-devtools-verify-r1.md`, `${etap}-5-devtools-verify.md`) === 0 && bad('devtools-verify-5-r1.md', `${etap}-5-devtools-verify.md`) === 0)
    check('m-2 legitimate: an unrelated devtools-verify-r1.md is not accepted for devtools-verify-branch.md; the numbered pair still works', bad('devtools-verify-r1.md', 'devtools-verify-branch.md') === 1 && bad('devtools-verify-5-r1.md', 'devtools-verify-5.md') === 0)
    const { PARTIAL_RUN } = await import(join(PLUGIN, 'markers.mjs'))
    check('m-2: PARTIAL_RUN agrees with the citable names', ['devtools-verify-branch-r1.md', `${etap}-5-devtools-verify-r1.md`, 'devtools-verify-5-shared-radius-r1.md'].every((file) => PARTIAL_RUN.test(file)) && !PARTIAL_RUN.test('devtools-verify-branch-fresh.md'))
  }

  // m-5 (K9b.5): a feature file that is a symlink to a FIFO, or leaves the map directory, does not hang or leak
  {
    const mapped = mkRepo({ ...mapFiles, 'package.json': '{}\n' })
    put(mapped, 'outside.md', '# outside\nRoutes: /leak · Status: draft\n')
    symlinkSync(join(mapped, 'outside.md'), join(mapped, '.claude/verify/features/leak.md'))
    put(mapped, 'src/x.tsx', 'export default 1\n')
    const out = vm(mapped, '--changed')
    check('m-5 incident: a feature file linked out of the map directory is not read (the map has one feature)', out.status === 0 && /· 1 feature ·/.test(out.stdout) && !/^route \/leak/m.test(out.stdout), out.stdout + out.stderr)
    const fifo = join(tmpdir(), `v9b-fifo-${process.pid}`)
    if (spawnSync('mkfifo', [fifo]).status === 0) {
      symlinkSync(fifo, join(mapped, '.claude/verify/features/evil.md'))
      const began = Date.now()
      const fifoOut = vm(mapped, '--changed')
      check('m-5 incident: a feature file that is a symlink to a FIFO does not hang --changed', fifoOut.status === 0 && Date.now() - began < 10_000, `${fifoOut.status} ${Date.now() - began} ms ${fifoOut.stderr}`)
      rmSync(fifo, { force: true })
    }
  }

  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

// ── stage 9c (VT-4): B3 Nuxt component names, B4 non-component chains, workspace imports ──
{
  const VM = join(PLUGIN, 'verify-map.mjs')
  const vm = (cwd, ...args) => spawnSync(process.execPath, [VM, '--cwd', cwd, ...args], { encoding: 'utf8', timeout: 30_000 })
  const dirs = []
  const mk = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'v9c-'))
    dirs.push(root)
    const g = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' })
    g('init', '-q')
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), text)
    }
    g('add', '-A')
    g('commit', '-q', '-m', 'base')
    return root
  }
  const CFG = '# Pipeline config — fx\n## Project\n- slug: fx\n## Task state\n- task_path: .claude/tasks/\n## Dev server\n- url: http://localhost:3000\n'

  // AC-9c.1: every Nuxt name of a component
  const nuxt = mk({
    '.claude/pipeline.config.md': CFG,
    'nuxt.config.ts': 'export default {}\n',
    'components/base/Spinner.vue': '<template/>',
    'components/base/BaseButton.vue': '<template/>',
    'pages/a.vue': '<template><BaseSpinner/></template>',
    'pages/b.vue': '<template><base-spinner/></template>',
    'pages/c.vue': '<template><LazyBaseSpinner/></template>',
    'pages/d.vue': '<template><BaseButton/></template>',
    'pages/e.vue': '<template><lazy-base-spinner /></template>',
    'pages/f.vue': '<template><BaseSpinnerX/></template>',
  })
  const names = vm(nuxt, '--radius', 'components/base/Spinner.vue').stdout
  check('AC-9c.1: BaseSpinner, base-spinner, LazyBaseSpinner and lazy-base-spinner all reach components/base/Spinner.vue', ['/a', '/b', '/c', '/e'].every((route) => new RegExp(`^route ${route} `, 'm').test(names)), names)
  check('AC-9c.1 legitimate: BaseSpinnerX is another component, BaseButton is not Spinner', !/^route \/(?:d|f) /m.test(names), names)
  check('AC-9c.1: prefix dedupe — components/base/BaseButton.vue is <BaseButton/>, not <BaseBaseButton/>', /^route \/d /m.test(vm(nuxt, '--radius', 'components/base/BaseButton.vue').stdout))

  // AC-9c.2: a FEATURE-MAP row whose files are .ts is matched by --changed
  const ts = mk({
    '.claude/pipeline.config.md': CFG,
    '.claude/verify/README.md': '# Verify map — fx\nBase: abc (main) · Updated: 2026-10-25\n## Features (sweep order)\n- [orders](features/orders.md) — /orders\n',
    '.claude/verify/features/orders.md': '# orders\nRoutes: /orders · Auth: yes · Platforms: desktop · Status: draft\nx\n## Sub-features\n- `a`\n## How to get to it (user POV)\n- Header\n## Driving it with Chrome DevTools MCP\n- x\n## Gotchas\n- none\n',
    'src/router.ts': 'export default []\n',
  })
  writeFileSync(join(ts, 'src/router.ts'), 'export default [1]\n')
  writeFileSync(join(ts, 'src/router.test.ts'), 'export {}\n')
  const tsFm = join(ts, 'FEATURE-MAP.md')
  writeFileSync(tsFm, '# Feature map: x\n## Entry points\n| ID | Platform | Route/screen | Files |\n|---|---|---|---|\n| orders | desktop | /orders | src/router.ts:3 |\n')
  const tsOut = vm(ts, '--changed', '--feature-map', tsFm).stdout
  check('AC-9c.2: --changed matches a FEATURE-MAP row whose files are .ts', /^route \/orders — mapped: orders$/m.test(tsOut) && !/^warning/m.test(tsOut), tsOut)

  // AC-9c.3 and AC-9c.4: a .ts chain names where it stopped; workspace imports resolve through package.json names
  const chain = mk({
    '.claude/pipeline.config.md': CFG,
    'src/util.ts': 'export const u = 1\n',
    'src/api.ts': 'import { u } from "./util"\nexport const a = u\n',
    'src/router.ts': 'import { a } from "./api"\nexport default a\n',
  })
  const chainOut = vm(chain, '--radius', 'src/util.ts').stdout
  check('AC-9c.3: a .ts chain with no page names the file it stopped at, not "no page imports"', /^warning: src\/router\.ts/m.test(chainOut) && !/src\/api\.ts/.test(chainOut) && !/no page imports/.test(chainOut), chainOut)
  const ws = mk({
    '.claude/pipeline.config.md': CFG,
    'packages/shared/package.json': '{"name":"@scope/shared","main":"dist/index.js"}\n',
    'packages/shared/src/index.ts': 'export * from "./utils/x"\n',
    'packages/shared/src/utils/x.ts': 'export const x = 1\n',
    'packages/shared/src/utils/y.ts': 'export const y = 1\n',
    'apps/web/src/pages/P.tsx': 'import { x } from "@scope/shared"\nexport default x\n',
    'apps/web/src/pages/Q.tsx': 'import { y } from "@scope/shared/utils/y"\nexport default y\n',
    'apps/web/src/pages/R.tsx': 'import { z } from "@other/shared"\nexport default z\n',
  })
  const wsOut = vm(ws, '--radius', 'packages/shared/src/utils/x.ts').stdout
  check('AC-9c.4: a bare workspace import resolves to the package entry and through its re-export to P.tsx', /apps\/web\/src\/pages\/P\.tsx/.test(wsOut) && !/R\.tsx/.test(wsOut), wsOut)
  check('AC-9c.4: a sub-path import (@scope/shared/utils/y) resolves under src/', /Q\.tsx/.test(vm(ws, '--radius', 'packages/shared/src/utils/y.ts').stdout))

  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

// ── VT-5 stage 10: plan-check and the stage-implement spawn ──────────────────
{
  const { checkPlan, stageForSpawn } = await import(join(PLUGIN, 'plan-check.mjs'))
  const pcRoot = mkdtempSync(join(tmpdir(), 'plan-check-test-'))
  const pc = join(pcRoot, 'app')
  repoAt(pc, 'main')
  git(pc, 'checkout', '-qb', 'P-1/feat/x')
  const TODAY = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  const CATEGORIES = 'Screens and states — Clear; Copy and i18n — Clear; Permissions and gating — Clear; Breakpoints — Clear; Motion — Clear; A11y — Clear; Data — Clear; Platform parity — Clear; Look — Clear; Terminology — Clear; Boundaries — Clear; Environment and access — Clear'
  const force = (heading, { deps = true, taxonomy = true } = {}) =>
    `${heading}\nMode: autonomous.\nInterview answers: none\nAssumptions:\n- accepted X — Rollback: cheap, revert the line — Basis: guess\n` +
    `${deps ? 'Stage dependencies: none\n' : ''}${taxonomy ? `Taxonomy: ${CATEGORIES}\n` : ''}Boundaries: none\nConfirmed: ${TODAY} — no questions\n\n`
  const plan = ({ acs, extra = '', forceBlock = force(`## Force run ${TODAY}`), earlier = '' }) =>
    `# P-1: task\nBranch: \`P-1/feat/x\`\nLanguage: en\n\n## Status: stage 1\n${earlier}\n${forceBlock}## Stages\n\n### Stage 1: logic  [status: in-progress]  logic-only\nWhat exists:\n${extra}Acceptance criteria:\n${acs}\n`
  const GOOD_AC = '- `AC-1.1` WHEN a is read THEN it is 1 — [verify: pro-review]\n- `AC-1.2` WHEN b THEN c — [verify: devtools-verify]\n'
  const setPlan = (text) => write(pc, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n', '.claude/tasks/P-1/STAGES.md': text })
  const opts = (dataDir) => ({ taskDir: join(pc, '.claude/tasks/P-1'), dataDir, roots: [pc], config: '' })
  const messages = (result) => result.problems.map((finding) => finding.message).join('\n')
  // A data dir whose first look already happened on a plan with no Force block yet: a block written after that is a new run (a block present at the first look is a run in progress, D7).
  const primed = () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-check-data-'))
    checkPlan('# P-1: task\n\n### Stage 9: other  [status: todo]  logic-only\nAcceptance criteria:\n', opts(dir))
    return dir
  }
  const spawn = (prompt) => runHook('agent-guard.mjs', { cwd: pc, tool_name: 'Agent', tool_input: { subagent_type: 'stage-pipeline:stage-implement', prompt } })

  // AC-10.2: an AC without a verifier and a path:line that does not resolve — both listed, the spawn for that stage denied.
  const badPlan = plan({ acs: '- `AC-1.1` WHEN a is read THEN it is 1\n' + GOOD_AC.split('\n')[1] + '\n', extra: '- the old handler lives at src/missing.ts:12\n' })
  const bad = checkPlan(badPlan, opts(primed()))
  check('plan-check: a new stage with an AC without a verifier and an unresolved path:line — both are problems', /AC-1\.1: no `\[verify/.test(messages(bad)) && /src\/missing\.ts:12/.test(messages(bad)), messages(bad))
  check('plan-check: the summary line carries AC count and references resolved 0/1', bad.stages.length === 1 && bad.stages[0].summary.acs === 2 && bad.stages[0].summary.refs.join('/') === '0/1', JSON.stringify(bad.stages))
  // The first look of the task comes before the stage is written (a stage already in the plan at the first look of a running run is old, D7).
  setPlan('# P-1: task\nBranch: `P-1/feat/x`\n\n## Stages\n\n### Stage 9: other  [status: done]  logic-only\nAcceptance criteria:\n')
  spawn('Ticket P-1, stage 9, mode implement')
  setPlan(badPlan)
  const denied = spawn('Ticket P-1, stage 1, mode implement')
  check('agent-guard: stage-implement for a stage with plan-check problems — denied, both named', denied.decision === 'deny' && /AC-1\.1/.test(denied.text) && /src\/missing\.ts:12/.test(denied.text) && /Awaiting user confirmation/.test(denied.text) && /\[blocked: B<n>\]/.test(denied.text), denied.text)
  check('agent-guard: a fix-mode spawn for the same stage — allowed (fix mode is not checked)', spawn('Ticket P-1, stage 1, mode: fix\nFindings: AC-1.1 a.ts:3').decision === 'allow')
  setPlan(plan({ acs: GOOD_AC, extra: '- reads src/a.ts:1\n' }))
  check('agent-guard: a clean plan — allowed', spawn('Ticket P-1, stage 1, mode implement').decision === 'allow')
  check('stageForSpawn: "stage number: 3" and no number → the first open stage', stageForSpawn('### Stage 2: a  [status: done]\n### Stage 3: b  [status: todo]\n', 'stage number: 3') === '3' && stageForSpawn('### Stage 2: a  [status: done]\n### Stage 3: b  [status: todo]\n', 'implement it') === '3')
  // A plan the hook cannot read as a plan never denies (fail open).
  setPlan('# P-1: task\nBranch: `P-1/feat/x`\n\nno stages here\n')
  check('agent-guard: no stage to check — allowed', spawn('Ticket P-1, stage 1, mode implement').decision === 'allow')

  // AC-10.3: a new Force block without `Stage dependencies:` is a problem; an old block gets a warning only.
  const noDeps = checkPlan(plan({ acs: GOOD_AC, forceBlock: force(`## Force run ${TODAY}`, { deps: false }) }), opts(primed()))
  check('plan-check: a new Force block without `Stage dependencies:` — reported as a problem', noDeps.problems.some((finding) => finding.rule === 'force-no-dependencies'), messages(noDeps))
  const noTax = checkPlan(plan({ acs: GOOD_AC, forceBlock: force(`## Force run ${TODAY}`).replace('Environment and access — Clear', '') }), opts(primed()))
  check('plan-check: a `Taxonomy:` line missing a category — reported with the category named', noTax.problems.some((finding) => finding.rule === 'force-taxonomy' && /Environment and access/.test(finding.message)), messages(noTax))
  check('plan-check: a new Force block with every field — no Force problem', !noDeps.problems.some((finding) => finding.rule === 'force-taxonomy') && !checkPlan(plan({ acs: GOOD_AC }), opts(primed())).problems.some((finding) => finding.scope === 'force'))
  // The first look at an old plan (a dated line from before today) writes the snapshot; the old Force block (a date before the first sight) gets warnings only.
  const oldData = mkdtempSync(join(tmpdir(), 'plan-check-data-'))
  const oldPlan = plan({ acs: '- `AC-1.1` WHEN a THEN b\n', earlier: '- 2026-09-01 plan written\n', forceBlock: force('## Force run 2026-09-02', { deps: false, taxonomy: false }) })
  const old = checkPlan(oldPlan, opts(oldData))
  check('plan-check: an old plan — no problems, the same findings as warnings', old.problems.length === 0 && old.warnings.some((finding) => finding.rule === 'ac-no-verifier') && old.warnings.some((finding) => finding.rule === 'force-no-dependencies'), `${messages(old)}\n${JSON.stringify(old.warnings.map((finding) => finding.rule))}`)
  const again = checkPlan(oldPlan + '\n### Stage 2: later  [status: todo]  logic-only\nAcceptance criteria:\n- `AC-2.1` WHEN x THEN y\n', opts(oldData))
  check('plan-check: a stage added after the first look is new — its missing verifier is a problem, the old stage stays a warning', again.problems.some((finding) => finding.stage === '2' && finding.rule === 'ac-no-verifier') && !again.problems.some((finding) => finding.stage === '1'), messages(again))
  rmSync(pcRoot, { recursive: true, force: true })
}

// ── VT-5 stage 10, fix round 1: D7 incident + legitimate pairs for the plan-check rules ──────────────────────────────────────────────────
{
  const { checkPlan, stageForSpawn, siblingRepos } = await import(join(PLUGIN, 'plan-check.mjs'))
  const fxRoot = mkdtempSync(join(tmpdir(), 'plan-check-fx-'))
  const fx = join(fxRoot, 'app')
  repoAt(fx, 'main')
  git(fx, 'checkout', '-qb', 'P-2/feat/x')
  const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('')
  write(fx, {
    'packages/shared/src/guests-information/utils/guestSourceCell.ts': lines(98),
    'plugins/p/scripts/j.mjs': lines(40),
    'p1/x/util.ts': lines(5),
    'p2/x/util.ts': lines(5),
    '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n',
  })
  git(fx, 'add', '-A')
  git(fx, 'commit', '-qm', 'files')
  const D = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  const EN = 'Screens and states — Clear; Copy and i18n — Clear; Permissions and gating — Clear; Breakpoints — Clear; Motion — Clear; A11y — Clear; Data — Clear; Platform parity — Clear; Look — Clear; Terminology — Clear; Boundaries — Clear; Environment and access — Clear'
  const RU = 'Экраны и состояния — ясно; Тексты и i18n — ясно; Доступы и гейтинг — ясно; Брейкпоинты — ясно; Анимация — ясно; A11y — ясно; Данные — ясно; Паритет платформ — ясно; Вид — ясно; Терминология — ясно; Границы — ясно; Окружение и доступ — ясно'
  const taskDir = join(fx, '.claude/tasks/P-2')
  const fresh = () => mkdtempSync(join(tmpdir(), 'plan-check-fxdata-'))
  const opts = (extra = {}) => ({ taskDir, dataDir: null, roots: [fx], config: '', ...extra })
  const rules = (result, level = 'problems') => result[level].map((finding) => finding.rule)
  const msgs = (result, level = 'problems') => result[level].map((finding) => finding.message).join('\n')
  const forceEn = (heading, body = '') => `${heading}\nMode: autonomous.\nAssumptions:\n- accepted X — Rollback: cheap — Basis: guess\n${body}Stage dependencies: none\nTaxonomy: ${EN}\nConfirmed: ${D} — no questions\n\n`
  const mk = ({ stages, sections = '', force = forceEn(`## Force run ${D}`), earlier = '' }) => `# P-2: task\nBranch: \`P-2/feat/x\`\n\n## Status: stage 1\n${earlier}\n${force}${sections}## Stages\n\n${stages}`
  const logicStage = (n, acs, extra = '') => `### Stage ${n}: s${n}  [status: todo]  logic-only\nWhat exists:\n${extra}Acceptance criteria:\n${acs}\n`
  const ac = (id, tag = ' — [verify: pro-review]') => `- \`AC-${id}\` WHEN a THEN b${tag}\n`

  // M-1: a run already going at the first look is old whatever its date; a block or a stage added after the first look is new.
  {
    const dataDir = fresh()
    const live = mk({ stages: logicStage(1, ac('1.1', '')), force: `## Force run ${D}\nMode: autonomous.\nAssumptions:\n- accepted X — Rollback: cheap — Basis: guess\nConfirmed: ${D} — no questions\n\n` })
    const first = checkPlan(live, opts({ dataDir }))
    check('plan-check D7: a run in progress at the first look (open, confirmed, dated the same day, no new fields) — no problems, the same findings as warnings', first.problems.length === 0 && rules(first, 'warnings').includes('force-no-dependencies') && rules(first, 'warnings').includes('ac-no-verifier'), msgs(first))
    const second = checkPlan(`${live}\n### Stage 2: later  [status: todo]  logic-only\nAcceptance criteria:\n${ac('2.1', '')}`, opts({ dataDir }))
    check('plan-check D7: a stage added after the first look of a running plan is new — its missing verifier is a problem, stage 1 stays a warning', rules(second).join() === 'ac-no-verifier' && second.problems[0].stage === '2', msgs(second))
    const third = checkPlan(live.replace(`## Stages`, `## Force run ${D} (2)\nMode: autonomous.\nConfirmed: ${D} — no questions\n\n## Stages`), opts({ dataDir }))
    check('plan-check D7: a second Force block written after the first look is a new run — no `Stage dependencies:` is a problem', rules(third).includes('force-no-dependencies') && rules(third).includes('force-no-taxonomy'), msgs(third))
  }

  // M-2: catch-up stage ids and the wording of the fix mode.
  {
    const text = `### Stage 1: a  [status: done]\n### Stage 2c: catch-up  [status: todo]\n### Stage 3: c  [status: todo]\n`
    check('stageForSpawn: "stage 2c" keeps the letter', stageForSpawn(text, 'Ticket P-2, stage 2c, mode: implement') === '2c' && stageForSpawn(text, 'Stage 2c.') === '2c')
    check('stageForSpawn: a closed stage named first does not win over the open one named next', stageForSpawn(text, 'Stage 1 is closed; now implement stage 3') === '3' && stageForSpawn(text, 'Stage 9 does not exist') === null)
    const dataDir = fresh()
    const base = mk({ stages: logicStage(1, ac('1.1')) })
    checkPlan(base, opts({ dataDir }))
    const withCatchUp = `${base}### Stage 1c: catch-up  [status: todo]  logic-only\nAcceptance criteria:\n${ac('1c.1', '')}`
    const caught = checkPlan(withCatchUp, opts({ dataDir, stage: '1c' }))
    check('plan-check: a catch-up stage "1c" added after the first look — its missing verifier is a problem', rules(caught).join() === 'ac-no-verifier' && caught.problems[0].stage === '1c', msgs(caught))
    // the hook: the spawn for the catch-up stage is denied, a fix-mode spawn in any wording is not
    const hookRepo = join(fxRoot, 'hook')
    repoAt(hookRepo, 'main')
    git(hookRepo, 'checkout', '-qb', 'P-2/feat/x')
    const setHook = (stagesText) => write(hookRepo, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n', '.claude/tasks/P-2/STAGES.md': stagesText })
    const spawnHook = (prompt) => runHook('agent-guard.mjs', { cwd: hookRepo, tool_name: 'Agent', tool_input: { subagent_type: 'stage-pipeline:stage-implement', prompt } })
    setHook(base)
    check('agent-guard: a clean first stage — allowed (the first look is taken)', spawnHook('Ticket P-2, stage 1, mode: implement').decision === 'allow')
    setHook(withCatchUp)
    const denied = spawnHook('Ticket P-2, stage 1c, mode: implement')
    check('agent-guard: a spawn for catch-up stage "1c" with a criterion without a verifier — denied', denied.decision === 'deny' && /AC-1c\.1/.test(denied.text), denied.text)
    for (const prompt of ['Fix mode. Ticket P-2, stage 1c', 'Ticket P-2, stage 1c. In fix mode, findings: AC-1c.1', 'Mode: fix (round 2)\nTicket P-2 stage 1c', 'Режим: fix. Этап 1c']) {
      check(`agent-guard: fix-mode wording "${prompt.slice(0, 24).replace(/\n/g, ' ')}" — not checked`, spawnHook(prompt).decision === 'allow')
    }
  }

  // M-3: the new Force fields end the Assumptions list; a bullet Taxonomy keeps its "Boundaries" category.
  {
    const cats = EN.split('; ').map((entry) => `- ${entry.replace(' — ', ': ')}\n`).join('')
    const block = `## Force run ${D}\nMode: autonomous.\nAssumptions:\n- accepted X — Rollback: cheap — Basis: guess\nChecked before start:\n- the \`status\` field is on dev — GET /api/orders/1 → 200\nNot proven:\n- the stand is writable — not observable\nBlocker forecast:\n- stage 1 — none\nStage dependencies: none\nTaxonomy:\n${cats}Confirmed: ${D} — no questions\n\n`
    const result = checkPlan(mk({ stages: logicStage(1, ac('1.1')), force: block }), opts())
    check('plan-check/decisions: probe bullets (`Checked before start:`, `Not proven:`, `Blocker forecast:`) after `Assumptions:` are not assumptions; a bullet Taxonomy naming Boundaries is complete', result.problems.length === 0, msgs(result))
    const bare = block.replace(' — Rollback: cheap', '')
    check('plan-check: an assumption without a rollback cost is still a problem (incident)', rules(checkPlan(mk({ stages: logicStage(1, ac('1.1')), force: bare }), opts())).join() === 'assumption-no-rollback')
  }

  // M-4: references in the live forms.
  {
    const ref = (path, line) => checkPlan(mk({ stages: logicStage(1, ac('1.1'), `- see ${path}:${line}\n`) }), opts())
    const pkg = ref('guests-information/utils/guestSourceCell.ts', 19)
    check('plan-check refs: a package-relative path resolves by its unique suffix among tracked files', pkg.problems.length === 0 && pkg.stages[0].summary.refs.join('/') === '1/1', msgs(pkg))
    const plug = ref('scripts/j.mjs', 3)
    check('plan-check refs: a plugin-relative path resolves by its unique suffix', plug.problems.length === 0 && plug.stages[0].summary.refs.join('/') === '1/1', msgs(plug))
    check('plan-check refs: a missing file with the right directories is still a problem', rules(ref('guests-information/utils/nope.ts', 3)).join() === 'unresolved-ref')
    check('plan-check refs: a line beyond the end of the file found by suffix is a problem', rules(ref('guests-information/utils/guestSourceCell.ts', 999)).join() === 'unresolved-ref')
    const elided = ref('apps/dashboard/.../X.tsx', 8)
    check('plan-check refs: an elided path (`...`) is a warning, not a problem', elided.problems.length === 0 && rules(elided, 'warnings').includes('ref-unverifiable'), msgs(elided, 'warnings'))
    const ambiguous = ref('x/util.ts', 2)
    check('plan-check refs: an ambiguous suffix is a warning, not a problem', ambiguous.problems.length === 0 && rules(ambiguous, 'warnings').includes('ref-unverifiable'), msgs(ambiguous, 'warnings'))
  }

  // M-5 / m-1: duplicate ids, open forks and their closing forms.
  {
    const dup = checkPlan(mk({ stages: logicStage(1, ac('1.1')) + logicStage(2, ac('1.1')) }), opts())
    check('plan-check: the same AC id in two stages — duplicate-ac', rules(dup).includes('duplicate-ac'), msgs(dup))
    check('plan-check: distinct ids — no duplicate-ac', !rules(checkPlan(mk({ stages: logicStage(1, ac('1.1')) + logicStage(2, ac('2.1')) }), opts())).includes('duplicate-ac'))
    const forkRules = (line) => rules(checkPlan(mk({ stages: logicStage(1, ac('1.1'), `${line}\n`) }), opts()))
    for (const open of ['[Gap] what does the screen show, e.g. a placeholder?', '[Gap] raised at kickoff 2026-10-28: empty list state?', '[Ambiguity] copy of the header (A1 says nothing)', '[Gap] see Header.tsx for the layout']) {
      check(`plan-check open-fork incident: "${open.slice(0, 44)}"`, forkRules(open).join() === 'open-fork', forkRules(open).join())
    }
    for (const closed of ['[Gap] empty state → closed by src/a.ts:1', '[Ambiguity] header copy — resolved: decided in the interview batch', '~~[Gap] empty state~~', '[Gap] empty state → A3', '[Gap] skin — closed by node-id 12:34', '[Gap] retry — out of stage', '[Gap] empty state [blocked: B1]', '[Gap] пустое состояние — закрыт интервью', '[Ambiguity] текст — решён: допущение A2']) {
      check(`plan-check open-fork legitimate (closing form): "${closed.slice(0, 44)}"`, forkRules(closed).length === 0, forkRules(closed).join())
    }
  }

  // M-5: UI stage without a visual reference.
  {
    const ui = (extra) => `### Stage 1: card  [status: todo]\nWhat exists:\n${extra}Acceptance criteria:\n${ac('1.1')}`
    check('plan-check: a UI stage without `Visual reference:` — no-visual-reference', rules(checkPlan(mk({ stages: ui('') }), opts())).includes('no-visual-reference'))
    check('plan-check: a UI stage with `Visual reference:` — no problem; a logic-only stage without it — no problem', !rules(checkPlan(mk({ stages: ui('Visual reference: apps/web/Card.tsx (section Header)\n') }), opts())).includes('no-visual-reference') && !rules(checkPlan(mk({ stages: logicStage(1, ac('1.1')) }), opts())).includes('no-visual-reference'))
    check('plan-check: `Visual reference: —` on a UI stage — no-visual-reference', rules(checkPlan(mk({ stages: ui('Visual reference: —\n') }), opts())).includes('no-visual-reference'))
  }

  // M-5: Force block fields.
  {
    const noTax = checkPlan(mk({ stages: logicStage(1, ac('1.1')), force: forceEn(`## Force run ${D}`).replace(/Taxonomy:[^\n]*\n/, '') }), opts())
    check('plan-check: a Force block with no `Taxonomy:` line — force-no-taxonomy', rules(noTax).join() === 'force-no-taxonomy', msgs(noTax))
    check('plan-check: a Force block with all fields — no problem', checkPlan(mk({ stages: logicStage(1, ac('1.1')) }), opts()).problems.length === 0)
    const ru = (drop = '') => mk({
      stages: `### Этап 1: первый  [status: todo]  logic-only\nЧто есть:\nКритерии приёмки:\n${ac('1.1')}`,
      force: `## Force-прогон ${D}\nРежим: автономный.\nДопущения:\n- принято X — Откат: дёшево, одна строка — Основание: догадка\n${drop.includes('deps') ? '' : 'Зависимости этапов: нет\n'}${drop.includes('tax') ? '' : `Таксономия: ${RU}\n`}Подтверждено: ${D} — без вопросов\n\n`,
    })
    const okRu = checkPlan(ru(), opts())
    check('plan-check ru: a Russian plan (Force block, dependencies, taxonomy and criteria fields in Russian) — no problems, the stage is read', okRu.problems.length === 0 && okRu.stages.length === 1 && okRu.stages[0].summary.acs === 1, msgs(okRu))
    const badRu = checkPlan(ru('deps tax'), opts())
    check('plan-check ru: a Russian Force block without the dependencies and taxonomy fields — both reported', rules(badRu).includes('force-no-dependencies') && rules(badRu).includes('force-no-taxonomy'), msgs(badRu))
    const noRollRu = checkPlan(ru().replace(' — Откат: дёшево, одна строка', ''), opts())
    check('plan-check ru: a Russian assumption without a rollback cost — assumption-no-rollback', rules(noRollRu).join() === 'assumption-no-rollback', msgs(noRollRu))
  }

  // M-5 / m-4: plan-level tables.
  {
    const coverage = (cell) => `## Design source coverage\n| Item | Stage |\n|---|---|\n| header | ${cell} |\n| footer | 1 |\n\n`
    const sharedEmpty = '## Shared elements\n| Element | Stages | Owner | Where |\n|---|---|---|---|\n\n'
    const stages = logicStage(1, ac('1.1'))
    check('plan-check: an empty Stage cell in "Design source coverage" — coverage-empty-stage', rules(checkPlan(mk({ stages, sections: coverage('') }), opts())).join() === 'coverage-empty-stage')
    check('plan-check: a filled Stage cell — no problem', checkPlan(mk({ stages, sections: coverage('1') }), opts()).problems.length === 0)
    check('plan-check: "Shared elements" with no rows and no `Pairs checked:` — shared-elements-empty', rules(checkPlan(mk({ stages, sections: sharedEmpty }), opts())).join() === 'shared-elements-empty')
    check('plan-check: an empty "Shared elements" with `Pairs checked: 6` (and the Russian form) — no problem', checkPlan(mk({ stages, sections: `${sharedEmpty}Pairs checked: 6\n\n` }), opts()).problems.length === 0 && checkPlan(mk({ stages, sections: `${sharedEmpty}Проверено пар: 6\n\n` }), opts()).problems.length === 0)
    check('plan-check: "Shared elements" with a row — no problem', checkPlan(mk({ stages, sections: '## Shared elements\n| Element | Stages | Owner | Where |\n|---|---|---|---|\n| wrapper | 1, 2 | 1 | src/a.ts |\n\n' }), opts()).problems.length === 0)
    // m-4: one catch-up stage in an old plan does not make its old sections hard
    const dataDir = fresh()
    const oldText = mk({ stages, sections: coverage(''), earlier: '- 2026-09-01 plan written\n', force: forceEn('## Force run 2026-09-02') })
    checkPlan(oldText, opts({ dataDir }))
    const grown = checkPlan(`${oldText}### Stage 2: catch-up  [status: todo]  logic-only\nAcceptance criteria:\n${ac('2.1')}`, opts({ dataDir }))
    check('plan-check: a catch-up stage in an old plan — the old coverage row stays a warning', grown.problems.length === 0 && rules(grown, 'warnings').includes('coverage-empty-stage'), msgs(grown))
  }

  // M-5 / m-3: a sibling repo missing on this machine.
  {
    const cfg = '- ui kit: `../ui-kit`\n- playground: `../src/module`\n'
    check('siblingRepos reads the names in the config', siblingRepos(cfg, fx).length === 2)
    const refs = (path) => checkPlan(mk({ stages: logicStage(1, ac('1.1'), `- see ${path}:3\n`) }), opts({ config: cfg }))
    const into = refs('ui-kit/src/x.ts')
    check('plan-check A4: a ref into a missing sibling repo (`ui-kit/…`) is a warning, with the sibling-missing note', into.problems.length === 0 && rules(into, 'warnings').includes('unresolved-ref') && rules(into, 'warnings').includes('sibling-missing'), msgs(into))
    const own = refs('src/missing.ts')
    check('plan-check A4: a missing file of THIS repo stays a problem though a sibling is missing, and `../src/module` is no sibling', rules(own).join() === 'unresolved-ref' && !rules(own, 'warnings').some((rule) => rule === 'sibling-missing' && /\/src\b/.test(msgs(own, 'warnings'))), msgs(own))
    check('plan-check A4: no sibling in the config — an unresolved ref is a problem', rules(checkPlan(mk({ stages: logicStage(1, ac('1.1'), '- see ui-kit/src/x.ts:3\n') }), opts())).join() === 'unresolved-ref')
  }

  // m-5: the whole JSON report reaches a pipe.
  {
    const bigPlan = mk({ stages: logicStage(1, Array.from({ length: 1500 }, (_, i) => ac(`1.${i + 1}`, '')).join('')) })
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(join(taskDir, 'STAGES.md'), bigPlan)
    const run = spawnSync(process.execPath, [join(PLUGIN, 'plan-check.mjs'), join(taskDir, 'STAGES.md'), '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CLAUDE_PLUGIN_DATA: fresh() } })
    let parsed = null
    try {
      parsed = JSON.parse(run.stdout)
    } catch {
      // cut output
    }
    check('plan-check CLI: a piped --json report over 64 KB is whole', run.stdout.length > 70000 && parsed?.stages?.[0]?.summary?.acs === 1500, `${run.stdout.length} bytes, status ${run.status}`)
  }
  rmSync(fxRoot, { recursive: true, force: true })
}

// ── VT-5 stage 10, fix round 2 (O-1): the plan snapshot is taken by journal-gate before the edit lands, never at whichever call reaches plan-check first ──────────
{
  const root = mkdtempSync(join(tmpdir(), 'plan-check-o1-'))
  const app = join(root, 'app')
  repoAt(app, 'main')
  git(app, 'checkout', '-qb', 'P-3/feat/x')
  write(app, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n', 'src/a.ts': 'x\n' })
  git(app, 'add', '-A')
  git(app, 'commit', '-qm', 'files')
  const day = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  const tax = 'Screens and states — Clear; Copy and i18n — Clear; Permissions and gating — Clear; Breakpoints — Clear; Motion — Clear; A11y — Clear; Data — Clear; Platform parity — Clear; Look — Clear; Terminology — Clear; Boundaries — Clear; Environment and access — Clear'
  const header = '# P-3: task\nBranch: `P-3/feat/x`\nLanguage: en\n\n## Status: stage 1\n\n'
  const stages = '## Stages\n\n### Stage 1: s  [status: todo]  logic-only\nWhat exists:\n- reads src/a.ts:1\nAcceptance criteria:\n- `AC-1.1` WHEN a THEN b — [verify: pro-review]\n'
  const forceOld = `## Force run ${day}\nMode: autonomous.\nAssumptions:\n- accepted X — Rollback: cheap — Basis: guess\nConfirmed: ${day} — no questions\n\n`
  const pre = (tool_name, file) => runHook('journal-gate.mjs', { cwd: app, tool_name, hook_event_name: 'PreToolUse', tool_input: { file_path: file } })
  const spawn = (prompt) => runHook('agent-guard.mjs', { cwd: app, tool_name: 'Agent', tool_input: { subagent_type: 'stage-pipeline:stage-implement', prompt } })

  // Incident: a new task — Write creates STAGES.md, an Edit adds an open confirmed Force block without `Stage dependencies:`, the first plan-check call is the spawn.
  const newFile = join(app, '.claude/tasks/P-3/STAGES.md')
  pre('Write', newFile) // the file is absent: an empty plan is snapshotted
  write(app, { '.claude/tasks/P-3/STAGES.md': `${header}${stages}` })
  pre('Edit', newFile)
  write(app, { '.claude/tasks/P-3/STAGES.md': `${header}${forceOld}${stages}` })
  const denied = spawn('Ticket P-3, stage 1, mode implement')
  check('plan-check O-1 incident: a new task (Write creates STAGES.md, then an Edit adds an open Force block without `Stage dependencies:`) — the spawn is denied', denied.decision === 'deny' && /Stage dependencies/.test(denied.text), denied.text)

  // Legitimate (M-1 form): the confirmed open block was in STAGES.md before any hook call; the first post-install Edit takes the snapshot, so the spawn is allowed.
  git(app, 'checkout', '-qb', 'P-4/feat/x')
  write(app, { '.claude/tasks/P-4/STAGES.md': `${header.replaceAll('P-3', 'P-4')}${forceOld}${stages}` })
  pre('Edit', join(app, '.claude/tasks/P-4/STAGES.md'))
  write(app, { '.claude/tasks/P-4/STAGES.md': `${header.replaceAll('P-3', 'P-4')}${forceOld}## Journal\n- ${day} a line\n\n${stages}` })
  const allowed = spawn('Ticket P-4, stage 1, mode implement')
  check('plan-check O-1 legitimate: a running confirmed block already in STAGES.md before the first hook call — the first Edit snapshots it, the spawn is allowed', allowed.decision === 'allow', allowed.text)
  rmSync(root, { recursive: true, force: true })
}

// ── VT-5 stage 11 (VT-1 stage 11): maker receipts — the hand-back contract at SubagentStop, the maker snapshot at the spawn, the force commit that carries code nobody made ──
// Each rule: the live incident form that must fail and the live legitimate form that must pass. The hand-back below is the stage 10 implement hand-back of this very
// task (trimmed); the over-length form adds the "Per finding" block of its fix round 1 (5381 characters live). The Force blocks are new by the first-sight gates (the plan snapshot was taken before the block was written) unless a fixture says `planSeen`.
{
  const mk = await import(join(PLUGIN, 'maker.mjs'))
  process.env.STAGE_PIPELINE_MAKER_RECEIPTS = 'on'
  const mRoot = mkdtempSync(join(tmpdir(), 'maker-test-'))
  const REL = '2026-10-27'
  const pc = await import(join(PLUGIN, 'plan-check.mjs'))
  let mN = 0
  const MREPORT = '# pro-review\nFindings: critical 0 · major 1 · minor 0\n### 🟠 M-1 a.ts:1 — x\n## Findings outcome\n- M-1 — fixed: a.ts:2\n'
  const SECTION = {
    changed: (files) => `Changed:\n${files.map((file) => `- M ${file}`).join('\n')}\n- A /Users/someone/.claude/tasks/VT-5/checks/plan-check-live-scan.md (outside the repo: the task directory)\n`,
    decisions: 'Decisions:\n- AC regex fix: the draft cut `AC-10.1` to `AC-10`, which made every AC a duplicate. Now `AC-[\\w.]*\\w`.\n- "New" means after plan-check\'s own first look. Reason: the journal gate alone made every run dated 10-22..10-27 "new".\n',
    product: 'Product-visible:\n- stage-implement spawns are now denied on new plan problems. Where: agent-guard deny, `hooks/agent-guard.mjs:49-76`. Rollback: delete the `planVerdict` block.\n',
    checks: 'tests (CI gates have no lint/type_check here):\n- validate.mjs: exit 0 after and at HEAD\n- hooks-test: 1442 ✔ before, 1454 ✔ after, 0 ✘\n- floor-guard: +614 −1 lines in 9 files, 0 violations on the first run\n',
    notdone: 'Not done / blocker:\n- AC-10.4 (eval decision case) is `[blocked: B1]`. No eval case was built and eval.mjs was not run.\n- No version bump and no CHANGELOG entry (stage 11 does them).\n',
    acs: 'ACs without implementation: AC-10.4 (blocked B1), AC-10.5 (user-review).\n',
  }
  const PER_FINDING = '- M-4: fixed. A ref that does not join to a file falls back to a unique suffix match over `git ls-files`, cached per `checkPlan` run, only for roots with a `.git`. An ambiguous suffix or a `...` path becomes a new `ref-unverifiable` warning.\n'
  const handback = (files, { drop = [], long = false, checks = SECTION.checks, changed = SECTION.changed(files) } = {}) =>
    `Stage 10 is done except AC-10.4 (blocked B1) and AC-10.5 (user-review). The four CI gates are green.\n${Object.entries({ ...SECTION, changed, checks })
      .filter(([id]) => !drop.includes(id))
      .map(([, text]) => text)
      .join('')}${long ? `\nPer finding:\n${PER_FINDING.repeat(14)}` : ''}`
  const fixture = (name, { heading = `## Force run ${REL}`, body = '', typeCheck = false, typeCheckLine = null, seen = false, planSeen = false, since = '2026-10-20' } = {}) => {
    const ticket = `MK-${60 + mN++}`
    const dir = join(mRoot, name)
    repoAt(dir, 'main')
    write(dir, {
      'src/legacy.ts': 'export const legacy = 1\n',
      'src/other.ts': 'export const other = 1\n',
      '.claude/pipeline.config.md': `- task_path: .claude/tasks/\n- main_branch: main\n- type_check: ${typeCheckLine ?? (typeCheck ? 'npx tsc --noEmit' : '—')}\n`,
      [`.claude/tasks/${ticket}/STAGES.md`]: `# ${ticket}: task\nLanguage: en\nBranch: \`${ticket}/feat/m\`\n\n## Status: stage 1\n\n${heading}\nConfirmed: ${REL} — no questions\n${body}\n## Stages\n\n### Stage 1: logic  [status: in-progress]  logic-only\n`,
    })
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'files')
    git(dir, 'checkout', '-qb', `${ticket}/feat/m`)
    const tdir = join(dir, '.claude/tasks', ticket)
    setGate(tdir, since, seen ? [markers.forceKey(heading)] : [])
    // The plan snapshot of the first look (stage 10): taken before the Force block was written (a new run) or with it there (a run already going when the version landed).
    pc.takePlanSnapshot(DATA, tdir, planSeen ? readFileSync(join(tdir, 'STAGES.md'), 'utf8') : '')
    const report = join(tdir, 'checks/pro-review-1.md')
    mkdirSync(dirname(report), { recursive: true })
    writeFileSync(report, MREPORT)
    utimesSync(report, Date.now() / 1000 + 600, Date.now() / 1000 + 600)
    const session = `sess-${name}`
    return {
      dir,
      ticket,
      tdir,
      spawn: (id = session) => runHook('agent-guard.mjs', { cwd: dir, session_id: id, tool_name: 'Agent', tool_input: { subagent_type: 'stage-pipeline:stage-implement', prompt: `Mode: fix (round 1). Ticket: ${ticket}. Stage: 1. Language: en.` } }),
      stop: (text, { id = session, agent = `agent-${name}`, type = 'stage-pipeline:stage-implement' } = {}) => {
        const transcript = join(mRoot, `tx-${mN++}.jsonl`)
        const call = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_hb', name: 'SubagentHandback', input: { message: text } }] } }
        writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Mode: fix' } })}\n${JSON.stringify(call)}\n`)
        return runHook('maker-guard.mjs', { cwd: dir, session_id: id, agent_type: type, agent_id: agent, agent_transcript_path: transcript, stop_hook_active: false })
      },
      commit: (command = 'git add -A && git commit -m x', cwd = dir) => runHook('git-guard.mjs', { cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: `toolu_mk_${mN++}`, tool_input: { command } }),
      land: () => {
        git(dir, 'add', '-A')
        git(dir, 'commit', '-qm', 'stage')
      },
      records: () => mk.readMakerRecords(DATA, ticket),
    }
  }

  // AC-11.1 — the hand-back at SubagentStop.
  {
    const f = fixture('handback')
    check('maker K11.1: the spawn of stage-implement is allowed and records the tree (a denied spawn records nothing)', f.spawn().decision === 'allow' && mk.readSnapshot(DATA, 'sess-handback')?.root === realpathSync(f.dir), JSON.stringify(mk.readSnapshot(DATA, 'sess-handback')))
    write(f.dir, { 'src/a.ts': 'export const a = 2\n', 'src/new.ts': 'export const n = 1\n' })
    const files = ['src/a.ts', 'src/new.ts']
    const missing = f.stop(handback(files, { drop: ['product'] }))
    check('maker AC-11.1 incident: a hand-back without `Product-visible:` — the stop is blocked, the section named', missing.decision === 'block' && /Product-visible/.test(missing.text) && /block 1 of 3/.test(missing.text), missing.text)
    const long = handback(files, { long: true })
    const over = f.stop(long, { agent: 'agent-long' })
    check('maker AC-11.1 incident: a hand-back over 4000 characters (the live fix round 1 was 5381) — blocked, with its length', long.length > 4000 && over.decision === 'block' && new RegExp(`${long.length} characters`).test(over.text), `${long.length}: ${over.text}`)
    const phantom = f.stop(handback([...files, 'src/ghost.ts']), { agent: 'agent-ghost' })
    check('maker AC-11.1 incident: `Changed:` names a file that did not change — blocked, the file named', phantom.decision === 'block' && /did not change/.test(phantom.text) && /src\/ghost\.ts/.test(phantom.text), phantom.text)
    const forgotten = f.stop(handback(['src/a.ts']), { agent: 'agent-forgot' })
    check('maker AC-11.1 incident: a changed file missing from `Changed:` — blocked, the file named', forgotten.decision === 'block' && /does not name/.test(forgotten.text) && /src\/new\.ts/.test(forgotten.text) && !/src\/a\.ts/.test(forgotten.text), forgotten.text)
    const absolute = f.stop(handback(files.map((file) => join(f.dir, file))), { agent: 'agent-abs' })
    check('maker AC-11.1 legitimate: the live hand-back — A/M prefixes, absolute repo paths, a note in the checks section, a task-directory path outside the repo — stops, and the stop is stored', absolute.decision === 'allow' && f.records().length === 1, `${absolute.text} ${f.records().length}`)
    const [stored] = f.records()
    check('maker K11.4: the stop stores the post-run blobs of the change set and the items', Object.keys(stored.blobs).sort().join() === 'src/a.ts,src/new.ts' && stored.blobs['src/a.ts'] === execFileSync('git', ['hash-object', 'src/a.ts'], { cwd: f.dir, encoding: 'utf8' }).trim() && stored.items.some((item) => item.kind === 'notdone' && /eval decision case/.test(item.text)), JSON.stringify(stored))
    check('maker AC-11.1: a different agent type is not judged', f.stop('garbage', { type: 'stage-pipeline:pro-review', agent: 'agent-other' }).decision === 'allow')
    check('maker AC-11.1: no spawn snapshot for the session (started before the release) — not judged', f.stop('garbage', { id: 'sess-unknown', agent: 'agent-nosnap' }).decision === 'allow')
  }
  // K11.4 — at most three blocks, then the stop goes through with a stored item.
  {
    const f = fixture('giveup')
    f.spawn()
    write(f.dir, { 'src/x.ts': 'export const x = 1\n' })
    const bad = handback(['src/x.ts'], { drop: ['acs'] })
    const rounds = [1, 2, 3].map(() => f.stop(bad, { agent: 'agent-giveup' }).decision)
    const fourth = f.stop(bad, { agent: 'agent-giveup' })
    check('maker AC-11.1 / K11.4: three blocks, the fourth stop is let through (Claude Code caps at 8)', rounds.join() === 'block,block,block' && fourth.decision === 'allow', `${rounds} ${fourth.decision}`)
    const items = f.records().flatMap((record) => record.items)
    check('maker K11.4: the give-up stores a "hand-back not fixed" item and the blobs', items.some((item) => item.kind === 'unfixed' && /hand-back not fixed: missing section/.test(item.text)) && f.records()[0]?.blobs['src/x.ts'], JSON.stringify(f.records()))
    const g = fixture('typecheck', { typeCheck: true })
    g.spawn()
    write(g.dir, { 'src/y.ts': 'export const y = 1\n' })
    const green = g.stop(handback(['src/y.ts'], { checks: 'lint / type_check / floor-guard: all green\n' }))
    check('maker K11.2: with a type_check command in the config a checks line without numbers is blocked', green.decision === 'block' && /no numbers/.test(green.text), green.text)
    check('maker K11.2: the same checks line with numbers stops', g.stop(handback(['src/y.ts'], { checks: 'lint / type_check / floor-guard: lint 0 · type_check: 193 = baseline 193 · floor-guard: 0 violations\n' }), { agent: 'agent-g2' }).decision === 'allow')
  }
  // AC-11.2 — the force commit.
  {
    const f = fixture('commit', { body: 'Remove src/legacy.ts after the move.\n' })
    f.spawn()
    write(f.dir, { 'src/m1.ts': 'export const m1 = 1\n' })
    f.stop(handback(['src/m1.ts']))
    check('maker AC-11.2 legitimate: a code file the maker wrote and recorded — the force commit passes', f.commit().decision === 'allow', f.commit().text)
    f.land()
    write(f.dir, { 'src/o1.ts': 'export const o1 = 1\n' })
    const mine = f.commit()
    check('maker AC-11.2 incident: a code file written by the orchestrator, no maker record — denied, "code not written by stage-implement", the path named', mine.decision === 'deny' && /code not written by stage-implement — hand it to a fix round/.test(mine.text) && /src\/o1\.ts/.test(mine.text), mine.text)
    rmSync(join(f.dir, 'src/o1.ts'))
    f.spawn()
    write(f.dir, { 'src/m2.ts': 'export const m2 = 1\n' })
    f.stop(handback(['src/m2.ts']), { agent: 'agent-commit-2' })
    writeFileSync(join(f.dir, 'src/m2.ts'), 'export const m2 = 2 // edited after the maker\n')
    const edited = f.commit()
    check('maker AC-11.2 incident: a maker-written file edited again after the maker stop — denied', edited.decision === 'deny' && /src\/m2\.ts/.test(edited.text), edited.text)
    writeFileSync(join(f.dir, 'src/m2.ts'), 'export const m2 = 1\n')
    write(f.dir, { 'pnpm-lock.yaml': 'lockfileVersion: 9\n', 'dist/bundle.js': 'var a=1\n', 'src/api.generated.ts': 'export type Api = {}\n', 'src/a.min.js': 'var a=1\n', 'notes.md': '# n\n', 'tsconfig.json': '{}\n' })
    const rest = f.commit()
    check('maker AC-11.2 legitimate: a lockfile, a generated file (dist/, .generated., .min.), markdown and JSON are not code — they pass beside a maker file', rest.decision === 'allow', rest.text)
    f.land()
    rmSync(join(f.dir, 'src/legacy.ts'))
    check('maker AC-11.2 legitimate: a deletion the Force block names passes', f.commit().decision === 'allow', f.commit().text)
    f.land()
    rmSync(join(f.dir, 'src/other.ts'))
    const gone = f.commit()
    check('maker AC-11.2 incident: a deletion the Force block does not name is a code change nobody made — denied', gone.decision === 'deny' && /src\/other\.ts/.test(gone.text), gone.text)
  }
  // D7 — a run that began before the release keeps its rules.
  {
    const old = fixture('old-block', { heading: '## Force run 2026-10-22', planSeen: true })
    write(old.dir, { 'src/o.ts': 'export const o = 1\n' })
    check('maker D7: a Force block dated before the release — the orchestrator\'s code file passes (no retrofitting)', old.commit().decision === 'allow', old.commit().text)
    const seen = fixture('seen-block', { seen: true })
    write(seen.dir, { 'src/o.ts': 'export const o = 1\n' })
    check('maker D7: a block dated after the release but already there when the plugin first saw the task — passes', seen.commit().decision === 'allow', seen.commit().text)
    const fresh = fixture('new-block')
    write(fresh.dir, { 'src/o.ts': 'export const o = 1\n' })
    check('maker D7: the same code file under a new block — denied (the rule is not off by accident)', fresh.commit().decision === 'deny')
    process.env.STAGE_PIPELINE_MAKER_RECEIPTS = 'off'
    check('maker: STAGE_PIPELINE_MAKER_RECEIPTS=off switches the commit rule off', fresh.commit().decision === 'allow')
    process.env.STAGE_PIPELINE_MAKER_RECEIPTS = 'on'
  }
  // Fix round 1 of stage 11 (pro-review-11.md): the first-sight gate, the committed blob, a maker that died, two repos, a session without maker-guard, batching.
  {
    // M-1 / D7: a run opened between the old fixed date and the release, going when 0.21.0 lands (the plan snapshot has its block), is never judged.
    const running = fixture('m1-running', { planSeen: true })
    write(running.dir, { 'src/o.ts': 'export const o = 1\n' })
    check('maker M-1 legitimate (D7): a block dated after the 0.18 gate but present at the plan snapshot of the first look, code from a pre-release maker — the commit passes', running.commit().decision === 'allow', running.commit().text)
    const late = fixture('m1-late')
    write(late.dir, { 'src/o.ts': 'export const o = 1\n' })
    rmSync(join(DATA, pc.planSnapshotName(late.tdir)))
    check('maker M-1: no plan snapshot yet — it is taken at the commit, with the block in it: an old run, the commit passes', late.commit().decision === 'allow', late.commit().text)
    const brand = fixture('m1-new')
    write(brand.dir, { 'src/o.ts': 'export const o = 1\n' })
    check('maker M-1 incident: the same file under a block the snapshot has not seen — denied (the gate is not off by accident)', brand.commit().decision === 'deny', brand.commit().text)
    // m-1: the hand-back rule is under the same gate
    const resumed = fixture('m1-handback', { planSeen: true })
    resumed.spawn()
    write(resumed.dir, { 'src/r.ts': 'export const r = 1\n' })
    const stopped = resumed.stop('garbage', { agent: 'agent-resumed' })
    check('maker m-1 legitimate (D7): a run resumed after the release — a garbage hand-back is not blocked and nothing is stored', stopped.decision === 'allow' && resumed.records().length === 0, `${stopped.text} ${resumed.records().length}`)
    const fresh = fixture('m1-handback-new')
    fresh.spawn()
    write(fresh.dir, { 'src/r.ts': 'export const r = 1\n' })
    check('maker m-1 incident: the same garbage hand-back under a new block — blocked', fresh.stop('garbage', { agent: 'agent-fresh' }).decision === 'block')
  }
  {
    // M-2: the blob that will be committed, not "working tree or index".
    const f = fixture('m2')
    f.spawn()
    write(f.dir, { 'src/m.ts': 'export const m = 1\n' })
    f.stop(handback(['src/m.ts']))
    git(f.dir, 'add', 'src/m.ts')
    check('maker M-2 legitimate: the maker blob staged, a plain `git commit` — passes', f.commit('git commit -m x').decision === 'allow', f.commit('git commit -m x').text)
    check('maker M-2 legitimate: the same with `git add -A &&` — passes', f.commit('git add -A && git commit -m x').decision === 'allow')
    writeFileSync(join(f.dir, 'src/m.ts'), 'export const m = 2 // the orchestrator edit\n')
    for (const command of ['git add src/m.ts && git commit -m x', 'git add -A && git commit -m x', 'git commit -am x']) {
      const denied = f.commit(command)
      check(`maker M-2 incident: an orchestrator edit over the staged maker blob, \`${command}\` — denied, the path named`, denied.decision === 'deny' && /src\/m\.ts/.test(denied.text), denied.text)
    }
    check('maker M-2 legitimate: the edit stays in the working tree and the command stages nothing — the committed blob is the maker one, passes', f.commit('git commit -m x').decision === 'allow', f.commit('git commit -m x').text)
  }
  {
    // M-3: a maker that died before its stop; the continuation starts from its baseline.
    const f = fixture('m3')
    f.spawn('sess-dead')
    write(f.dir, { 'src/c.ts': 'export const c = 1\n' })
    f.spawn('sess-continuation')
    write(f.dir, { 'src/d.ts': 'export const d = 1\n' })
    const only = f.stop(handback(['src/d.ts']), { id: 'sess-continuation', agent: 'agent-cont-1' })
    check('maker M-3 incident: the continuation names only its own file — blocked, the dead maker file named as not named', only.decision === 'block' && /does not name/.test(only.text) && /src\/c\.ts/.test(only.text), only.text)
    const both = f.stop(handback(['src/c.ts', 'src/d.ts']), { id: 'sess-continuation', agent: 'agent-cont-2' })
    check('maker M-3 legitimate: the continuation names the dead maker file and its own — the stop records both', both.decision === 'allow' && Object.keys(f.records().at(-1)?.blobs ?? {}).sort().join() === 'src/c.ts,src/d.ts', `${both.text} ${JSON.stringify(f.records())}`)
    check('maker M-3 legitimate: the commit of both files passes', f.commit().decision === 'allow', f.commit().text)
    f.spawn('sess-next')
    write(f.dir, { 'src/e.ts': 'export const e = 1\n' })
    check('maker M-3: after a stop the baseline is closed — the next maker names only its own file', f.stop(handback(['src/e.ts']), { id: 'sess-next', agent: 'agent-cont-3' }).decision === 'allow')
  }
  {
    // M-4: a task over core and a sibling repo.
    const core = fixture('m4-core')
    const web = join(mRoot, 'm4-web')
    repoAt(web, 'main')
    write(web, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n- type_check: —\n' })
    git(web, 'checkout', '-qb', `${core.ticket}/feat/m`)
    write(core.dir, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n- type_check: —\n- webview: ../m4-web\n' })
    writeFileSync(join(core.tdir, 'STAGES.md'), `${readFileSync(join(core.tdir, 'STAGES.md'), 'utf8')}Repos: m4-web\n`)
    const { registerTaskDir } = await import(join(PLUGIN, 'hooks/pipeline-state.mjs'))
    registerTaskDir(dirname(core.tdir))
    core.spawn()
    write(core.dir, { 'src/c.ts': 'export const c = 1\n' })
    write(web, { 'src/w.ts': 'export const w = 2\n' })
    const two = core.stop(handback(['src/c.ts', join(web, 'src/w.ts')]), { agent: 'agent-m4' })
    check('maker M-4 legitimate: the maker named a file of each repo (the second one absolute) — the stop is stored per repo', two.decision === 'allow' && core.records().at(-1)?.others?.[0]?.blobs?.['src/w.ts'], `${two.text} ${JSON.stringify(core.records())}`)
    check('maker M-4 incident (was denied): the commit in the second repo with the maker file — passes', core.commit('git add -A && git commit -m x', web).decision === 'allow', core.commit('git add -A && git commit -m x', web).text)
    write(web, { 'src/orch.ts': 'export const orch = 1\n' })
    const mine = core.commit('git add -A && git commit -m x', web)
    check('maker M-4 incident: the orchestrator file in the second repo — still denied', mine.decision === 'deny' && /src\/orch\.ts/.test(mine.text), mine.text)
    // a repo the config does not name has no snapshot in this run: the rule does not apply there
    const lone = fixture('m4-lone')
    lone.spawn()
    write(lone.dir, { 'src/c.ts': 'export const c = 1\n' })
    lone.stop(handback(['src/c.ts']), { agent: 'agent-lone' })
    const elsewhere = join(mRoot, 'm4-elsewhere')
    repoAt(elsewhere, 'main')
    git(elsewhere, 'checkout', '-qb', `${lone.ticket}/feat/m`)
    write(elsewhere, { 'src/z.ts': 'export const z = 1\n', '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n- type_check: —\n' })
    writeFileSync(join(lone.tdir, 'STAGES.md'), `${readFileSync(join(lone.tdir, 'STAGES.md'), 'utf8')}Repos: m4-elsewhere\n`)
    registerTaskDir(dirname(lone.tdir))
    check('maker M-4: a repo with no spawn snapshot in the run (not named by the config) — the rule does not apply there', lone.commit('git add -A && git commit -m x', elsewhere).decision === 'allow', lone.commit('git add -A && git commit -m x', elsewhere).text)
  }
  {
    // O-3: a session that loaded hooks.json before the release has the spawn hook but not maker-guard.
    const f = fixture('o3')
    f.spawn()
    write(f.dir, { 'src/m.ts': 'export const m = 1\n' })
    check('maker O-3 legitimate: spawn snapshots but no stop record in the run (maker-guard not registered) — the maker code is not denied', f.commit().decision === 'allow', f.commit().text)
    const none = fixture('o3-none')
    write(none.dir, { 'src/m.ts': 'export const m = 1\n' })
    check('maker O-3 incident: no spawn at all under a new block — the orchestrator wrote the code, denied', none.commit().decision === 'deny')
    f.stop(handback(['src/m.ts']))
    write(f.dir, { 'src/o.ts': 'export const o = 1\n' })
    check('maker O-3: once a stop is recorded the rule is on — the orchestrator file beside it is denied', f.commit().decision === 'deny')
  }
  {
    // m-2: the config's own words for "no type_check command".
    for (const [index, [line, want]] of [['НЕТ  # skip', false], ['нет', false], ['`none` # later', false], ['npx tsc --noEmit  # slow', true]].entries()) {
      const f = fixture(`m2-tc${index}`, { typeCheckLine: line })
      f.spawn()
      const got = mk.readSnapshot(DATA, `sess-m2-tc${index}`)?.typeCheck
      check(`maker m-2: \`- type_check: ${line}\` is ${want ? 'a command' : 'no command'}`, got === want, `${got}`)
    }
  }
  {
    // m-3: one git call for all paths, not one per path.
    const f = fixture('m3-batch')
    f.spawn()
    const many = {}
    for (let i = 0; i < 300; i++) many[`src/gen/file-${i}.ts`] = `export const v${i} = ${i}\n`
    write(f.dir, many)
    const snapshot = mk.readSnapshot(DATA, 'sess-m3-batch')
    const started = Date.now()
    const changes = mk.changeSet(snapshot)
    const change = Date.now() - started
    mk.storeStop(DATA, snapshot, '', changes)
    const committed = Date.now()
    const verdict = f.commit()
    check('maker m-3: 300 maker files — the change set in under 1.5 s and the force commit in under 4 s (was 4.0 s and 6.8 s)', changes.size === 300 && change < 1500 && verdict.decision === 'allow' && Date.now() - committed < 4000, `${changes.size} ${change} ms, commit ${Date.now() - committed} ms ${verdict.text}`)
  }
  {
    // m-4: the deletion exemption is the whole path, and it holds when the maker has a record for the path.
    const sub = fixture('m4-sub', { body: 'Remove src/legacy.tsx after the move.\n' })
    rmSync(join(sub.dir, 'src/legacy.ts'))
    const denied = sub.commit()
    check('maker m-4 incident: the block names `src/legacy.tsx`, the commit deletes `src/legacy.ts` — denied (not a substring match)', denied.decision === 'deny' && /src\/legacy\.ts/.test(denied.text), denied.text)
    const rec = fixture('m4-record', { body: 'Remove src/legacy.ts after the move.\n' })
    rec.spawn()
    writeFileSync(join(rec.dir, 'src/legacy.ts'), 'export const legacy = 2 // the maker touched it first\n')
    rec.stop(handback(['src/legacy.ts']))
    rmSync(join(rec.dir, 'src/legacy.ts'))
    check('maker m-4 legitimate: the maker has a record for the path and the Force block names its deletion — passes', rec.commit().decision === 'allow', rec.commit().text)
  }
  // AC-11.3 — the digest.
  {
    const f = fixture('digest')
    f.spawn()
    write(f.dir, { 'src/d.ts': 'export const d = 1\n' })
    f.stop(handback(['src/d.ts']))
    const { publishDigest } = await import(join(PLUGIN, 'run-digest.mjs'))
    const digest = publishDigest(f.tdir, DATA, null, { write: false })
    check('maker AC-11.3: the full digest prints the stored «Not done» items verbatim under «From the maker\'s hand-backs»', /### From the maker's hand-backs \(\d+\)/.test(digest.full) && digest.full.includes('- [stage 1 · Not done / blocker] AC-10.4 (eval decision case) is `[blocked: B1]`. No eval case was built and eval.mjs was not run.'), digest.full)
    check('maker AC-11.3: the short view shows the count, not the lines', /### From the maker's hand-backs: \d+/.test(digest.short) && !digest.short.includes('No eval case was built'), digest.short)
    writeFileSync(join(f.tdir, 'STAGES.md'), readFileSync(join(f.tdir, 'STAGES.md'), 'utf8').replace('Language: en', 'Language: ru'))
    const ru = publishDigest(f.tdir, DATA, null, { write: false })
    check('maker AC-11.3: a ru task gets the ru heading, the item verbatim', /### Из отчётов исполнителя \(\d+\)/.test(ru.full) && ru.full.includes('No eval case was built'), ru.full)
    const none = fixture('digest-none')
    check('maker AC-11.3: a run with no maker stop has no category (an old run\'s digest is unchanged)', !/maker's hand-backs/.test(publishDigest(none.tdir, DATA, null, { write: false }).short))
  }
  process.env.STAGE_PIPELINE_MAKER_RECEIPTS = 'off'
  rmSync(mRoot, { recursive: true, force: true })
}

// ── VT-5 stage 11 part B (K11.7, AC-11.4): the resume point after /compact in an open force run ──
// A fixture repo with an open force run; session-start with `source: compact` names the state on disk and ONE next action. `startup` and a closed run print what they always did.
{
  const mk = await import(join(PLUGIN, 'maker.mjs'))
  const rRoot = mkdtempSync(join(tmpdir(), 'resume-test-'))
  const today = (() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()
  const OPEN_REPORT = '# pro-review\nFindings: critical 0 · major 1 · minor 0\n### 🟠 M-1 a.ts:1 — x\n'
  const DONE_REPORT = `${OPEN_REPORT}## Findings outcome\n- M-1 — fixed: a.ts:2\n`
  let rN = 0
  const resumeFixture = (name, { heading = `## Force run ${today}`, body = '', stageLines = '### Stage 1: logic  [status: in-progress]  logic-only\n' } = {}) => {
    const ticket = `RS-${70 + rN++}`
    const dir = join(rRoot, name)
    repoAt(dir, 'main')
    write(dir, {
      'src/legacy.ts': 'export const legacy = 1\n',
      '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n- type_check: —\n',
      [`.claude/tasks/${ticket}/STAGES.md`]: `# ${ticket}: task\nLanguage: en\nBranch: \`${ticket}/feat/r\`\n\n## Status: stage 1\n\n${heading}\nConfirmed: ${today} — no questions\n${body}\n## Stages\n\n${stageLines}`,
    })
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'files')
    git(dir, 'checkout', '-qb', `${ticket}/feat/r`)
    const tdir = join(dir, '.claude/tasks', ticket)
    const report = (file, text, offset = 600) => {
      mkdirSync(join(tdir, 'checks'), { recursive: true })
      writeFileSync(join(tdir, 'checks', file), text)
      utimesSync(join(tdir, 'checks', file), Date.now() / 1000 + offset, Date.now() / 1000 + offset)
    }
    const makerStop = (paths) => {
      const root = realpathSync(dir)
      const blobs = new Map(paths.map((path) => [path, execFileSync('git', ['hash-object', path], { cwd: dir, encoding: 'utf8' }).trim()]))
      mk.storeStop(DATA, { session: `s-${name}`, root, branch: `${ticket}/feat/r`, ticket, stage: '1' }, 'Changed:\n- M src/a.ts\n', blobs)
    }
    const start = (source) => runHook('session-start.mjs', { cwd: dir, source, session_id: `ss-${name}` }).text
    return { dir, ticket, tdir, report, makerStop, start }
  }

  {
    const f = resumeFixture('maker-stopped')
    write(f.dir, { 'src/a.ts': 'export const a = 2\n', 'src/b.ts': 'export const b = 1\n' })
    f.makerStop(['src/a.ts', 'src/b.ts'])
    const out = f.start('compact')
    check('resume AC-11.4: maker stopped, no report — names the stage, the tree as the maker left it and "run the checkers"', /Resume point \(force run, RS-/.test(out) && /Stage in progress: Stage 1/.test(out) && /2 paths as the maker left them, 0 changed since/.test(out) && /Next action: run the checkers for Stage 1/.test(out), out)
    check('resume AC-11.4: the status line stays above the resume point', out.indexOf('tasks in this repo') < out.indexOf('Resume point'), out)
    check('resume AC-11.4: a resume (not only a compact) prints it too', /Next action: run the checkers/.test(f.start('resume')))
    check('resume AC-11.4: a startup prints no resume point', !/Resume point/.test(f.start('startup')) && /tasks in this repo/.test(f.start('startup')))
    check('resume AC-11.4: no source (an old Claude Code) prints no resume point', !/Resume point/.test(runHook('session-start.mjs', { cwd: f.dir }).text))
  }
  {
    const f = resumeFixture('no-maker')
    const out = f.start('compact')
    check('resume AC-11.4: stage open, no maker record — "spawn stage-implement"', /Next action: spawn stage-implement for Stage 1/.test(out), out)
  }
  {
    const f = resumeFixture('major')
    write(f.dir, { 'src/a.ts': 'export const a = 2\n' })
    f.makerStop(['src/a.ts'])
    f.report('pro-review-1.md', OPEN_REPORT)
    const out = f.start('compact')
    check('resume AC-11.4: a report with a major and no Findings outcome — the report named, a fix round and the outcome', /pro-review-1\.md: critical 0, major 1 — no complete Findings outcome/.test(out) && /Next action: fix round for the findings of checks\/pro-review-1\.md/.test(out), out)
    f.report('pro-review-1.md', DONE_REPORT)
    check('resume AC-11.4: the outcome written, tree = maker snapshot — "commit"', /outcome complete/.test(f.start('compact')) && /Next action: commit stage 1/.test(f.start('compact')), f.start('compact'))
    write(f.dir, { 'src/a.ts': 'export const a = 3 // after the maker\n' })
    const changed = f.start('compact')
    check('resume AC-11.4: code edited after the maker stop — the path named, no "commit"', /1 changed since: src\/a\.ts/.test(changed) && /Next action: code changed since the maker/.test(changed) && !/Next action: commit/.test(changed), changed)
  }
  {
    const f = resumeFixture('minor-report')
    write(f.dir, { 'src/a.ts': 'export const a = 2\n' })
    f.makerStop(['src/a.ts'])
    f.report('pro-review-1.md', '# pro-review\nFindings: critical 0 · major 0 · minor 0\n')
    check('resume AC-11.4: a report without findings needs no outcome — "commit"', /Next action: commit stage 1/.test(f.start('compact')), f.start('compact'))
  }
  {
    const f = resumeFixture('no-stage', { stageLines: '### Stage 1: logic  [status: done]\n### Stage 2: more  [status: todo]\n' })
    check('resume AC-11.4: nothing in progress, a todo stage — "kickoff Stage 2"', /Next action: kickoff Stage 2/.test(f.start('compact')), f.start('compact'))
    const g = resumeFixture('all-done', { stageLines: '### Stage 1: logic  [status: done]\n### Stage 2: more  [status: blocked]\n' })
    check('resume AC-11.4: every stage done or blocked — "final checks"', /Next action: final checks/.test(g.start('compact')), g.start('compact'))
  }
  {
    // M-5: the whole status bracket is read.
    const live = resumeFixture('status-live', { stageLines: '### Stage 10: plan  [status: done]  logic-only\n### Stage 11: maker receipts and the resume point — R3 release  [status: in progress]  logic-only\n' })
    const out = live.start('compact')
    check('resume M-5 (the form of VT-5 own journal): `[status: in progress]` is the stage in progress, not "kickoff"', /Stage in progress: Stage 11/.test(out) && !/kickoff/.test(out) && /Next action: spawn stage-implement for Stage 11/.test(out), out)
    const blocked = resumeFixture('status-blocked', { stageLines: '### Stage 1: logic  [status: done]\n### Stage 2: more  [status: todo — blocked: B2]\n' })
    check('resume M-5: `[status: todo — blocked: B2]` is blocked — "final checks", not "kickoff Stage 2"', /Next action: final checks/.test(blocked.start('compact')), blocked.start('compact'))
  }
  {
    // M-6: by time, not by what exists.
    const f = resumeFixture('after-fix')
    write(f.dir, { 'src/a.ts': 'export const a = 2\n' })
    f.report('pro-review-1.md', OPEN_REPORT, 0)
    await new Promise((done) => setTimeout(done, 60))
    f.makerStop(['src/a.ts'])
    const out = f.start('compact')
    check('resume M-6: a report with a major, then a fix round (the maker stopped after the report) — "recheck the fixed items", not "fix round" again', /Next action: the maker stopped after checks\/pro-review-1\.md: recheck the fixed items/.test(out) && !/Next action: fix round/.test(out), out)
    const g = resumeFixture('reports-no-maker')
    g.report('pro-review-1.md', OPEN_REPORT)
    const ng = g.start('compact')
    check('resume M-6: reports in the window but no maker record (a pre-release run, or a stop that failed open) — no "spawn stage-implement"', !/Next action: spawn stage-implement/.test(ng) && /Next action: fix round for the findings of checks\/pro-review-1\.md \(stage-implement, fix mode\)/.test(ng), ng)
    g.report('pro-review-1.md', DONE_REPORT)
    check('resume M-6: reports with their outcome and no maker record — "commit", the missing record said', /Next action: commit stage 1: every report has its outcome \(no maker record/.test(g.start('compact')), g.start('compact'))
  }
  {
    const blockers = Array.from({ length: 400 }, (_, i) => `B${i + 1} — ${'a long blocker description '.repeat(30)}`).join('\n')
    const f = resumeFixture('huge', { body: `Blockers:\n${blockers}\n` })
    const many = {}
    for (let i = 0; i < 300; i++) many[`src/gen/file-with-a-long-name-${i}.ts`] = `export const v${i} = ${i}\n`
    write(f.dir, many)
    f.makerStop(['src/a.ts'])
    const out = f.start('compact')
    check('resume AC-11.4: a huge blocker list and 300 dirty files — the whole output within 10,000 characters, the next action intact, the lists cut with "+N more"', out.length <= 10000 && /Next action: /.test(out) && /\+\d+ more/.test(out), `${out.length}`)
  }
  {
    const f = resumeFixture('closed', { heading: `## Force run ${today} — completed` })
    check('resume AC-11.4: a closed force run — no resume point', !/Resume point/.test(f.start('compact')), f.start('compact'))
  }
  {
    const f = resumeFixture('no-snapshot', { body: '- B1 — a bulleted blocker\n' })
    write(f.dir, { 'src/a.ts': 'export const a = 2\n', 'src/b.ts': 'export const b = 1\n' })
    const out = f.start('compact')
    check('resume O-4: no maker record — "no maker snapshot", no "changed since" split', /no maker snapshot in this run — 2 uncommitted code paths: /.test(out) && !/changed since|as the maker left/.test(out), out)
    check('resume O-5: a blocker that is itself a bullet prints one dash', /\n    - B1 — a bulleted blocker/.test(out) && !/- - B1/.test(out), out)
    f.makerStop(['src/a.ts'])
    check('resume O-4: with a record the "as the maker left them / changed since" split stays', /1 path as the maker left them, 1 changed since: src\/b\.ts/.test(f.start('compact')), f.start('compact'))
  }
  rmSync(rRoot, { recursive: true, force: true })
}

// ── VT-5 stage 11a, round A (K11a.1-K11a.6): the security review of 0.21.0 — the orchestrator's routes round the maker receipt, a slow hash, cubic and quadratic regexes ──
// Each rule: the incident form that must fail and the legitimate form that must pass. No fixture above is adapted: the premises of VT-5 stage 11 hold.
{
  const mk = await import(join(PLUGIN, 'maker.mjs'))
  const pa = await import(join(PLUGIN, 'plan-check.mjs'))
  const gcm = await import(join(PLUGIN, 'hooks/git-command.mjs'))
  const rc = await import(join(PLUGIN, 'receipts.mjs'))
  process.env.STAGE_PIPELINE_MAKER_RECEIPTS = 'on'
  const aRoot = mkdtempSync(join(tmpdir(), 'maker-a-test-'))
  const AREL = '2026-10-27'
  let aN = 0
  const handback = (files, { notdone = '- none', changed = null } = {}) =>
    `${changed ?? `Changed:\n${files.map((file) => `- M ${file}`).join('\n')}\n`}Decisions:\n- d\nProduct-visible:\n- none\nlint / type_check / floor-guard:\n- tests: 1 ✔\nNot done / blocker:\n${notdone}\nACs without implementation: none\n`
  const fixture = (name, { heading = `## Force run ${AREL}`, planSeen = false, withBlock = true } = {}) => {
    const ticket = `MA-${70 + aN++}`
    const dir = join(aRoot, name)
    repoAt(dir, 'main')
    const block = `${heading}\nConfirmed: ${AREL} — no questions\n\n`
    write(dir, {
      'src/legacy.ts': 'export const legacy = 1\n',
      '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n- type_check: —\n',
      [`.claude/tasks/${ticket}/STAGES.md`]: `# ${ticket}: task\nLanguage: en\nBranch: \`${ticket}/feat/m\`\n\n## Status: stage 1\n\n${withBlock ? block : ''}## Stages\n\n### Stage 1: logic  [status: in-progress]  logic-only\n`,
    })
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'files')
    git(dir, 'checkout', '-qb', `${ticket}/feat/m`)
    const tdir = join(dir, '.claude/tasks', ticket)
    setGate(tdir, '2026-10-20', [])
    const full = readFileSync(join(tdir, 'STAGES.md'), 'utf8')
    pa.takePlanSnapshot(DATA, tdir, planSeen ? full : '')
    const report = join(tdir, 'checks/pro-review-1.md')
    mkdirSync(dirname(report), { recursive: true })
    writeFileSync(report, '# pro-review\nFindings: critical 0 · major 1 · minor 0\n### 🟠 M-1 a.ts:1 — x\n## Findings outcome\n- M-1 — fixed: a.ts:2\n')
    utimesSync(report, Date.now() / 1000 + 600, Date.now() / 1000 + 600)
    const session = `sess-a-${name}`
    return {
      dir,
      ticket,
      tdir,
      full,
      block,
      session,
      spawn: (id = session, prompt = `Mode: fix (round 1). Ticket: ${ticket}. Stage: 1. Language: en.`) => runHook('agent-guard.mjs', { cwd: dir, session_id: id, tool_name: 'Agent', tool_input: { subagent_type: 'stage-pipeline:stage-implement', prompt } }),
      stop: (text, { id = session, agent = `agent-a-${name}` } = {}) => {
        const transcript = join(aRoot, `tx-${aN++}.jsonl`)
        const call = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_hb', name: 'SubagentHandback', input: { message: text } }] } }
        writeFileSync(transcript, `${JSON.stringify(call)}\n`)
        return runHook('maker-guard.mjs', { cwd: dir, session_id: id, agent_type: 'stage-pipeline:stage-implement', agent_id: agent, agent_transcript_path: transcript, stop_hook_active: false })
      },
      commit: (command = 'git add -A && git commit -m x') => runHook('git-guard.mjs', { cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: `toolu_ma_${aN++}`, tool_input: { command } }),
      forceGuard: (command) => runHook('force-guard.mjs', { cwd: dir, tool_input: { command } }),
      records: () => mk.readMakerRecords(DATA, ticket),
    }
  }
  const same2 = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  // AC-11a.1 / K11a.1 — a broken line in a data file is skipped, and a throw in one rule never skips the rest.
  {
    const f = fixture('a-tolerant')
    f.spawn()
    write(f.dir, { 'src/t.ts': `// @ts${'-'}ignore\nexport const t: number = "x"\n` })
    f.stop(handback(['src/t.ts']))
    mkdirSync(join(DATA, 'receipts'), { recursive: true })
    appendFileSync(join(DATA, 'maker', `${f.ticket}.jsonl`), 'null\n7\n[1]\n"x"\n{"root": 3, "blobs": "zz", "others": 5, "items": 4}\n')
    appendFileSync(join(DATA, 'maker', `${f.ticket}.spawns.jsonl`), 'null\n9\n')
    appendFileSync(join(DATA, 'receipts', `${f.ticket}.jsonl`), 'null\n[]\n"x"\n')
    const records = mk.readMakerRecords(DATA, f.ticket)
    check('maker K11a.1: a `null`, a number, an array and a string line in the records file are skipped; an object of another shape stays', records.length === 2 && records.every((record) => record && typeof record === 'object' && !Array.isArray(record)), JSON.stringify(records).slice(0, 300))
    let thrown = null
    try {
      mk.lastMakerBlobs(DATA, f.ticket, realpathSync(f.dir))
      mk.makerItems(DATA, f.ticket, 0)
      rc.readReceipts(DATA, f.ticket)
    } catch (error) {
      thrown = error
    }
    check('maker K11a.1: lastMakerBlobs, makerItems (run-digest) and readReceipts do not throw on those lines (receipts.mjs had the same crash since 0.18)', thrown === null && same2(rc.readReceipts(DATA, f.ticket), []), `${thrown}`)
    const denied = f.commit('git add src/t.ts && git commit -m x')
    check('maker K11a.1 incident: a `null` line in the records file used to make git-guard exit 1 before floor-guard — the `@ts-ignore` commit is denied by floor-guard', denied.decision === 'deny' && /floor-guard/.test(denied.text), `${denied.decision} ${denied.text}`)
    const clean = fixture('a-tolerant-ok')
    clean.spawn()
    write(clean.dir, { 'src/t.ts': 'export const t = 1\n' })
    clean.stop(handback(['src/t.ts']))
    appendFileSync(join(DATA, 'maker', `${clean.ticket}.jsonl`), 'null\n')
    check('maker K11a.1 legitimate: the same broken line beside a clean maker file — the commit passes', clean.commit('git add src/t.ts && git commit -m x').decision === 'allow', clean.commit('git add src/t.ts && git commit -m x').text)
  }

  // K11a.1 — force-guard: a Bash command that names the plugin data directory in an open force run.
  {
    const f = fixture('a-forceguard')
    const forged = f.forceGuard(`node -e "require('fs').appendFileSync('${DATA}/maker/${f.ticket}.jsonl', '{}')"`)
    check('force K11a.1 incident: a command naming the plugin data directory — denied, "written by the hooks only" and "not a reason for a workaround"', forged.decision === 'deny' && /written by the hooks only/.test(forged.text) && /not a reason to look for a workaround/.test(forged.text), `${forged.decision} ${forged.text}`)
    check('force K11a.1 incident: the `plugins/data/stage-pipeline…` form and `$CLAUDE_PLUGIN_DATA` are named too', f.forceGuard('cat ~/.claude/plugins/data/stage-pipeline-inline/maker/x.jsonl').decision === 'deny' && f.forceGuard('echo {} >> "$CLAUDE_PLUGIN_DATA/plan-baseline/x.json"').decision === 'deny')
    for (const script of ['run-digest.mjs', 'archive-stages.mjs', 'ci-gates.mjs', 'browser-cleanup.mjs', 'plan-check.mjs']) {
      check(`force K11a.1 legitimate: the plugin's own ${script}, run by \${CLAUDE_PLUGIN_ROOT}, names no data directory — passes`, f.forceGuard(`node "\${CLAUDE_PLUGIN_ROOT}/scripts/${script}" .claude/tasks/${f.ticket}/STAGES.md --stage 1`).decision === 'allow')
    }
    const closed = fixture('a-forceguard-closed', { heading: `## Force run ${AREL} — completed ${AREL}` })
    check('force K11a.1: no open force run (the user is nearby) — the data directory is not guarded', closed.forceGuard(`ls ${DATA}/maker`).decision === 'allow')
  }

  // AC-11a.1 / K11a.2 — a commit command that also changes the index other than by `git add`.
  {
    const table = [
      ['git update-index --add src/o.ts && git commit -m x', ['update-index']],
      ['GIT_INDEX_FILE=/tmp/i git commit -m x', ['GIT_INDEX_FILE=']],
      ['export GIT_INDEX_FILE=/tmp/i; git commit -m x', ['GIT_INDEX_FILE=']],
      ['env GIT_INDEX_FILE=/tmp/i git commit -m x', ['GIT_INDEX_FILE=']],
      ['git apply --cached p.diff && git commit -m x', ['apply --cached']],
      ['git mv a.ts b.ts && git commit -m x', ['mv']],
      ['git rm --cached a.ts && git commit -m x', ['rm']],
      ['git checkout HEAD~1 -- src/o.ts && git commit -m x', ['checkout -- <path>']],
      ['git restore --staged src/o.ts && git commit -m x', ['restore --staged']],
      ['git read-tree HEAD && git commit -m x', ['read-tree']],
      ['git reset -- src/o.ts && git commit -m x', ['reset']],
      ['git add src/m.ts && git commit -m x', []],
      ['git add -A && git commit -am "git update-index and GIT_INDEX_FILE=x in the message"', []],
      ['git checkout -b feat/x && git commit -m x', []],
      ['git restore src/o.ts && git commit -m x', []],
    ]
    for (const [command, want] of table) check(`git K11a.2: indexChangers(${JSON.stringify(command).slice(0, 62)}) → [${want}]`, same2(gcm.indexChangers(command), want), JSON.stringify(gcm.indexChangers(command)))
    const f = fixture('a-index')
    f.spawn()
    write(f.dir, { 'src/m.ts': 'export const m = 1\n' })
    f.stop(handback(['src/m.ts']))
    write(f.dir, { 'src/o.ts': 'export const o = 1 // the orchestrator\n' })
    check('maker K11a.2 control: `git add src/o.ts && git commit` — denied, the path named (the premise of the incident)', f.commit('git add src/o.ts && git commit -m x').decision === 'deny')
    const viaIndex = f.commit('git update-index --add src/o.ts && git commit -m x')
    check('maker K11a.2 incident: `git update-index --add src/o.ts && git commit` — denied, "stage with `git add` in its own call"', viaIndex.decision === 'deny' && /stage with `git add` in its own call, then commit/.test(viaIndex.text) && /update-index/.test(viaIndex.text), `${viaIndex.decision} ${viaIndex.text}`)
    check('maker K11a.2 incident: a `GIT_INDEX_FILE=` prefix — denied', /own call/.test(f.commit('GIT_INDEX_FILE=/tmp/i git commit -m x').text))
    git(f.dir, 'add', 'src/m.ts')
    check('maker K11a.2 legitimate: `git add src/m.ts` in its own call, then `git commit` — passes', f.commit('git commit -m x').decision === 'allow', f.commit('git commit -m x').text)
    git(f.dir, 'update-index', '--add', 'src/o.ts')
    const later = f.commit('git commit -m x')
    check('maker K11a.2: the same staging in its own earlier call — judged by the index blob, denied, the path named', later.decision === 'deny' && /src\/o\.ts/.test(later.text) && !/own call/.test(later.text), `${later.decision} ${later.text}`)
    const old = fixture('a-index-old', { planSeen: true })
    write(old.dir, { 'src/o.ts': 'export const o = 1\n' })
    check('maker K11a.2 D7: a run already going at the first look is never denied by the new rule', old.commit('git update-index --add src/o.ts && git commit -m x').decision === 'allow', old.commit('git update-index --add src/o.ts && git commit -m x').text)
  }

  // AC-11a.1 / K11a.3 — a plan written only through Bash is looked at before the command runs.
  {
    const incident = fixture('a-bash-plan', { withBlock: false })
    const bashPre = (f, command) => runHook('journal-gate.mjs', { cwd: f.dir, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: `toolu_mb_${aN++}`, tool_input: { command } })
    rmSync(join(DATA, pa.planSnapshotName(incident.tdir)), { force: true })
    bashPre(incident, `cat >> ${join(incident.tdir, 'STAGES.md')} <<'EOF'\n## Force run ${AREL}\nEOF`)
    check('journal K11a.3: the Bash call that names a task STAGES.md takes the plan snapshot before it runs (no Force block in it yet)', Array.isArray(pa.readPlanSnapshot(DATA, incident.tdir)?.forceSeen) && pa.readPlanSnapshot(DATA, incident.tdir).forceSeen.length === 0, JSON.stringify(pa.readPlanSnapshot(DATA, incident.tdir)))
    writeFileSync(join(incident.tdir, 'STAGES.md'), incident.full.replace('## Stages', `${incident.block}## Stages`))
    write(incident.dir, { 'src/o.ts': 'export const o = 1 // written by the orchestrator\n' })
    const denied = incident.commit('git add -A && git commit -m x')
    check('maker K11a.3 incident: plan and confirmed Force block written only through Bash, code by the orchestrator — denied (the snapshot was taken first)', denied.decision === 'deny' && /code not written by stage-implement/.test(denied.text), `${denied.decision} ${denied.text}`)
    const control = fixture('a-bash-plan-control', { withBlock: false })
    rmSync(join(DATA, pa.planSnapshotName(control.tdir)), { force: true })
    writeFileSync(join(control.tdir, 'STAGES.md'), control.full.replace('## Stages', `${control.block}## Stages`))
    write(control.dir, { 'src/o.ts': 'export const o = 1\n' })
    check('maker K11a.3 control: with no Pre look the first sight finds the confirmed block and calls the run old — the same commit passes (the premise of the incident)', control.commit('git add -A && git commit -m x').decision === 'allow')
    const fresh = fixture('a-bash-new-task')
    const newDir = join(fresh.dir, '.claude/tasks/NEW-9')
    bashPre(fresh, `mkdir -p ${newDir} && cat > ${newDir}/STAGES.md <<'EOF'\n## Force run ${AREL}\nEOF`)
    const realNew = join(realpathSync(dirname(newDir)), 'NEW-9')
    check('journal K11a.3: a task directory the command is about to create gets an empty plan snapshot', same2(pa.readPlanSnapshot(DATA, realNew)?.stages, []) && same2(pa.readPlanSnapshot(DATA, realNew)?.forceSeen, []), JSON.stringify(pa.readPlanSnapshot(DATA, realNew)))
    const before = readdirSync(join(DATA, 'plan-baseline')).length
    bashPre(fresh, 'cat STAGES.md README.md && ls /tmp/elsewhere/STAGES.md')
    check('journal K11a.3 legitimate: a read of a STAGES.md that belongs to no task writes no snapshot', readdirSync(join(DATA, 'plan-baseline')).length === before)
  }

  // AC-11a.1 / K11a.4 — a file the orchestrator edited while the maker ran is not laundered into the maker's record.
  {
    const f = fixture('a-notmine')
    f.spawn()
    write(f.dir, { 'src/m.ts': 'export const m = 1\n', 'src/o.ts': 'export const o = 1 // edited by the orchestrator while the maker ran\n' })
    const blocked = f.stop(handback(['src/m.ts']))
    check('maker K11a.4: a changed file the hand-back does not name — blocked, and the message offers `not mine: <path>`, not adoption', blocked.decision === 'block' && /does not name/.test(blocked.text) && /src\/o\.ts/.test(blocked.text) && /not mine: <path>/.test(blocked.text), blocked.text)
    const disowned = f.stop(handback(['src/m.ts'], { notdone: '- not mine: src/o.ts (edited in the shared tree while I ran)' }))
    check('maker K11a.4 legitimate: `not mine: src/o.ts` under `Not done / blocker:` — the stop goes through', disowned.decision === 'allow', disowned.text)
    const stored = f.records().at(-1)
    check('maker K11a.4: the disowned path is not recorded as the maker\'s blob, the maker\'s own is; the line is kept as a Not done item', Object.keys(stored?.blobs ?? {}).join() === 'src/m.ts' && stored.items.some((item) => item.kind === 'notdone' && /not mine: src\/o\.ts/.test(item.text)), JSON.stringify(stored))
    const denied = f.commit('git add -A && git commit -m x')
    check('maker K11a.4 incident: the commit of the orchestrator\'s file — denied, the path named; the maker\'s file alone is not', denied.decision === 'deny' && /src\/o\.ts/.test(denied.text) && !/src\/m\.ts/.test(denied.text), `${denied.decision} ${denied.text}`)
    check('maker K11a.4 legitimate: the maker\'s own file staged alone — the commit passes', f.commit('git add src/m.ts && git commit -m x').decision === 'allow', f.commit('git add src/m.ts && git commit -m x').text)
    check('maker K11a.4: `Changed:` naming a file that did not change is still blocked (the old rule stands)', (() => {
      const g = fixture('a-notmine-phantom')
      g.spawn()
      write(g.dir, { 'src/m.ts': 'export const m = 1\n' })
      return g.stop(handback(['src/m.ts', 'src/ghost.ts'], { notdone: '- not mine: src/ghost.ts' })).decision === 'block'
    })())
  }

  // AC-11a.2 / K11a.5 — a slow or failed snapshot never denies the maker's own code.
  {
    const f = fixture('a-s2-skip')
    const fifo = join(aRoot, 'a-s2.fifo')
    execFileSync('mkfifo', [fifo])
    write(f.dir, { 'src/placeholder.txt': 'x\n' })
    symlinkSync(fifo, join(f.dir, 'src/pipe.ts'))
    writeFileSync(join(f.dir, 'src/dump.js'), '')
    truncateSync(join(f.dir, 'src/dump.js'), 6 * 1024 * 1024)
    const started = Date.now()
    const spawned = f.spawn()
    const took = Date.now() - started
    const snapshot = mk.readSnapshot(DATA, f.session)
    check('maker K11a.5: a dirty symlink to a FIFO and a 6 MB untracked file — the spawn is allowed fast (the hash used to block on the FIFO), the snapshot holds neither', spawned.decision === 'allow' && took < 2500 && snapshot && !('src/pipe.ts' in (snapshot.blobs ?? {})) && !('src/dump.js' in (snapshot.blobs ?? {})) && 'src/placeholder.txt' in (snapshot.blobs ?? {}), `${spawned.decision} ${took} ms ${JSON.stringify(snapshot?.blobs)}`)
    write(f.dir, { 'src/m.ts': 'export const m = 1\n' })
    const stopped = f.stop(handback(['src/m.ts']))
    check('maker K11a.5 legitimate: the maker\'s hand-back is judged without the unhashed paths — the stop goes through', stopped.decision === 'allow', stopped.text)
    check('maker K11a.5 legitimate: the maker\'s own file is committed, the symlink and the dump are not judged', f.commit('git add src/m.ts && git commit -m x').decision === 'allow', f.commit('git add src/m.ts && git commit -m x').text)
    check('maker K11a.5: the unit — dirtyBlobs leaves out the symlink and the over-5 MB untracked file', (() => {
      const blobs = mk.dirtyBlobs(f.dir)
      return blobs && blobs.has('src/placeholder.txt') && !blobs.has('src/pipe.ts') && !blobs.has('src/dump.js')
    })())
    check('maker K11a.5: a timed-out `git status` is not a clean tree — dirtyBlobs gives null (unknown), never an empty map', mk.dirtyBlobs(f.dir, { deadline: Date.now() - 1 }) === null)
  }
  {
    const f = fixture('a-s2-pending')
    for (let i = 0; i < 4001; i++) writeFileSync(join(f.dir, `gen-${i}.txt`), `${i}\n`)
    check('maker K11a.5 unit: 4001 dirty paths — the tree is not listed (null)', mk.dirtyBlobs(f.dir) === null)
    f.spawn()
    const lines = readFileSync(join(DATA, 'maker', `${f.ticket}.spawns.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    check('maker K11a.5: the spawn line is written (pending) and no `done` line follows an unfinished snapshot', lines.length === 1 && lines[0].pending === true && !lines.some((line) => line.done), JSON.stringify(lines))
    write(f.dir, { 'src/m.ts': 'export const m = 1\n' })
    f.stop(handback(['src/m.ts']))
    check('maker K11a.5 incident (S-2): an unfinished snapshot used to leave the maker\'s own file "not written by stage-implement" — the commit passes (the rule fails open for the run)', f.commit('git add src/m.ts && git commit -m x').decision === 'allow', f.commit('git add src/m.ts && git commit -m x').text)
    const ok = fixture('a-s2-done')
    ok.spawn()
    write(ok.dir, { 'src/m.ts': 'export const m = 1\n' })
    ok.stop(handback(['src/m.ts']))
    const done = readFileSync(join(DATA, 'maker', `${ok.ticket}.spawns.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    check('maker K11a.5: a finished snapshot writes the pending line and then the done line', done.length === 2 && done[0].pending === true && done[1].done === true, JSON.stringify(done))
    write(ok.dir, { 'src/o.ts': 'export const o = 1\n' })
    check('maker K11a.5 control: with a finished snapshot the orchestrator\'s file is still denied (the rule is not off by accident)', ok.commit('git add src/o.ts && git commit -m x').decision === 'deny')
  }

  // AC-11a.3 / K11a.6 — S-3: the label parser is linear.
  {
    const OLD = /^ {0,1}(?<bullet>[-*]\s+)?[`*_]*(?<label>[^\n:]*?)[`*_]*:[`*_]*(?<rest>.*)$/
    const oldOpened = (line) => {
      const found = OLD.exec(line)
      if (!found) return null
      const { bullet, label, rest } = found.groups
      for (const id of ['Changed', 'Decisions', 'Product-visible', 'Not done']) {
        if (new RegExp(`^${id.replace('-', '[- ]')}\\b`, 'i').test(label.trim()) && label.trim().length <= 90 && !(bullet && false)) return { id, rest }
      }
      return null
    }
    const lines = ['Changed:', 'Changed: a.ts, b.ts', '**Changed:** a.ts', '- Changed: a.ts', '* **Decisions:** one', ' Not done / blocker: x', '`Product-visible:` y', 'Changed (worktree x, all uncommitted):', 'changed: z', 'Decisions', 'Not done / blocker:**', '__Changed__: q', 'Changed:: two', '  Changed: indented', 'The Changed: later in a sentence', `${'x'.repeat(100)} Changed: tail`, 'Changed:'.padEnd(5000, ' ')]
    const idOf = (line) => {
      const { sections } = mk.parseHandback(line)
      const [id] = Object.keys(sections)
      const names = { changed: 'Changed', decisions: 'Decisions', product: 'Product-visible', notdone: 'Not done' }
      return id && names[id] ? { id: names[id], rest: sections[id] } : null
    }
    check('maker K11a.6 S-3: the linear label parser agrees with the old regex on the live forms (bullets, markers, long labels, indents)', lines.every((line) => same2(idOf(line), oldOpened(line))), lines.filter((line) => !same2(idOf(line), oldOpened(line))).map((line) => `${JSON.stringify(line.slice(0, 40))}: ${JSON.stringify(idOf(line))} vs ${JSON.stringify(oldOpened(line))}`).join(' | '))
    const adversarial = ['_', '*', '`'].map((char) => char.repeat(3200)).join('\n')
    const started = Date.now()
    const parsed = mk.parseHandback(`Changed:\n- M src/a.ts\n${adversarial}\n${adversarial}\n`)
    check('maker K11a.6 S-3 incident: three 3200-character runs of `_`, `*`, backticks (5.6 s per run before) — parsed in under 100 ms', Date.now() - started < 100 && 'changed' in parsed.sections, `${Date.now() - started} ms`)
    const f = fixture('a-s3')
    f.spawn()
    write(f.dir, { 'src/a.ts': 'export const a = 1\n' })
    const begun = Date.now()
    const long = f.stop(`${handback(['src/a.ts'])}${adversarial}\n${adversarial}\n${adversarial}\n`)
    check('maker K11a.6 S-3 incident: the over-length hand-back with those runs is blocked for its length, inside 3 s (the hook used to be killed at 15 s and let it through)', long.decision === 'block' && /characters, over the limit/.test(long.text) && Date.now() - begun < 3000, `${long.decision} ${Date.now() - begun} ms ${long.text}`)
  }

  // AC-11a.3 / K11a.6 — S-4: a 100 KB adversarial plan, prompt and hand-back finish well inside each hook's timeout (agent-guard 5 s, git-guard 15 s, maker-guard 15 s, session-start 10 s).
  {
    const pad = ' '.repeat(100_000)
    const plan = `\n## Shared elements\nPairs checked:${pad}x\n\n## Notes\n- AC-9.9 x [verify:${pad}\n${'- AC-9.8 y [verify: '.repeat(5000)}\n- AC-9.7 see ${'…'.repeat(100_000)}\n\n### Stage 9: ${pad.slice(0, 50_000)} [status:${pad.slice(0, 50_000)}\nAC-${'.'.repeat(50_000)}x\n## Force run ${AREL} ${':'.repeat(50_000)}x\n`
    const f = fixture('a-s4')
    f.spawn()
    write(f.dir, { 'src/a.ts': 'export const a = 1\n' })
    writeFileSync(join(f.tdir, 'STAGES.md'), f.full + plan)
    const timed = (run) => {
      const begun = Date.now()
      const out = run()
      return { ...out, ms: Date.now() - begun }
    }
    const prompt = `Stage${pad}Mode:${pad}Stage${' '.repeat(50_000)}x ${'Mode      '.repeat(5000)}fix`
    const spawned = timed(() => f.spawn('sess-a-s4-b', prompt))
    check('agent-guard K11a.6 S-4: a 100 KB plan and a 100 KB prompt — the spawn is judged in under 2.5 s (hook timeout 5 s; it was killed at 5 s before)', spawned.ms < 2500, `${spawned.ms} ms ${spawned.decision}`)
    const wholeBranch = timed(() => runHook('agent-guard.mjs', { cwd: f.dir, session_id: 'sess-a-s4-c', tool_name: 'Agent', tool_input: { subagent_type: 'stage-pipeline:pro-review', model: 'opus', prompt: `${'Mode      '.repeat(8000)}whole-branch mode` } }))
    check('agent-guard K11a.6 S-4: a long prompt of `Mode` + spaces for the whole-branch test — under 2.5 s', wholeBranch.ms < 2500, `${wholeBranch.ms} ms`)
    const committed = timed(() => f.commit('git add src/a.ts && git commit -m x'))
    check('git-guard K11a.6 S-4: a force commit with that plan — judged in under 7 s (hook timeout 15 s)', committed.ms < 7000, `${committed.ms} ms ${committed.decision}`)
    const resumed = timed(() => runHook('session-start.mjs', { cwd: f.dir, source: 'compact', session_id: 'sess-a-s4-d' }))
    check('session-start K11a.6 S-4: the resume point of that plan — under 5 s (hook timeout 10 s)', resumed.ms < 5000, `${resumed.ms} ms`)
    const stopped = timed(() => f.stop(`${handback(['src/a.ts'])}${'. ,'.repeat(40_000)}x\n${' '.repeat(100_000)}x\n${'_'.repeat(3000)}\n`))
    check('maker-guard K11a.6 S-4: a 100 KB hand-back over that plan — judged in under 5 s (hook timeout 15 s)', stopped.ms < 5000, `${stopped.ms} ms ${stopped.decision}`)
    check('plan-check K11a.6 S-4: the stage-id parser on `stage` + 100 KB of spaces', (() => {
      const begun = Date.now()
      pa.stageForSpawn(f.full, `stage${pad}x stage${pad}`)
      return Date.now() - begun < 500
    })())
  }
  // Round B (K11a.7, K11a.8; VT-5 stage 11a): refs resolve in the worktree, one stage parser, one stage-list reader, the give-up records only what `Changed:` names, the data dir under Edit/Write.
  {
    // M-1: a linked worktree without a config of its own; the plan names a file the branch added. D7 pair: a ref to a file nobody has is still a problem.
    const base = join(aRoot, 'b-wt')
    const wt = join(aRoot, 'b-wt-t1')
    repoAt(base, 'main')
    write(base, { '.claude/pipeline.config.md': '- task_path: .claude/tasks/\n- main_branch: main\n' })
    git(base, 'worktree', 'add', '-q', wt, '-b', 'MW-1/feat')
    write(wt, { 'src/new.ts': `${Array.from({ length: 20 }, (_, i) => `export const n${i} = ${i}`).join('\n')}\n` })
    git(wt, 'add', '-A')
    git(wt, 'commit', '-qm', 'stage 1')
    const cats = 'Screens and states — Clear; Copy and i18n — Clear; Permissions and gating — Clear; Breakpoints — Clear; Motion — Clear; A11y — Clear; Data — Clear; Platform parity — Clear; Look — Clear; Terminology — Clear; Boundaries — Clear; Environment and access — Clear'
    const head = '# MW-1: task\nBranch: `MW-1/feat`\nLanguage: en\n\n## Status: stage 2\n\n'
    const force = `## Force run ${AREL}\nMode: autonomous.\nInterview answers: none\nAssumptions:\n- accepted X — Rollback: cheap, revert the line — Basis: guess\nStage dependencies: none\nTaxonomy: ${cats}\nBoundaries: none\nConfirmed: ${AREL} — no questions\n\n`
    const stage1 = '## Stages\n\n### Stage 1: model  [status: done]  logic-only\nAcceptance criteria:\n- `AC-1.1` WHEN a THEN b — [verify: pro-review]\n\n'
    const stage2 = (ref) => `### Stage 2: use it  [status: todo]  logic-only\nReuse: the helper at ${ref} (written in stage 1)\nAcceptance criteria:\n- \`AC-2.1\` WHEN c THEN d — [verify: pro-review]\n`
    const tdir = join(base, '.claude/tasks/MW-1')
    write(base, { '.claude/tasks/MW-1/STAGES.md': head + stage1 })
    pa.checkPlan(head + stage1, { taskDir: tdir, dataDir: DATA, roots: [base], config: '' })
    const spawnWt = (session) => runHook('agent-guard.mjs', { cwd: wt, session_id: session, tool_name: 'Agent', tool_input: { subagent_type: 'stage-pipeline:stage-implement', prompt: 'Ticket MW-1, stage 2, mode: implement' } })
    write(base, { '.claude/tasks/MW-1/STAGES.md': head + force + stage1 + stage2('src/new.ts:12') })
    const added = spawnWt('sess-b-wt-1')
    check('plan-check M-1 incident: a ref to a file the branch added, in a linked worktree with no config of its own — resolves in the worktree, the spawn is allowed (it was `unresolved-ref`)', added.decision === 'allow', added.text)
    write(base, { '.claude/tasks/MW-1/STAGES.md': head + force + stage1 + stage2('src/ghost.ts:12') })
    const ghost = spawnWt('sess-b-wt-2')
    check('plan-check M-1 legitimate: a ref to a file neither the worktree nor the config repo has — still an `unresolved-ref`, denied', ghost.decision === 'deny' && /ghost\.ts/.test(ghost.text), ghost.text)
    write(base, { '.claude/tasks/MW-1/STAGES.md': head + force + stage1 + stage2('src/a.ts:1') })
    check('plan-check M-1 legitimate: a ref to a file of the config repo — resolves as before', spawnWt('sess-b-wt-3').decision === 'allow')
    const roots = (stage) => pa.checkPlan(head + force + stage1 + stage, { taskDir: tdir, dataDir: DATA, roots: [wt, base], config: '' }).problems.length
    check('plan-check M-1: `roots` lists the worktree first, then the config root — the same plan has no problem with both and one with the config root alone', roots(stage2('src/new.ts:12')) === 0 && pa.checkPlan(head + force + stage1 + stage2('src/new.ts:12'), { taskDir: tdir, dataDir: DATA, roots: [base], config: '' }).problems.length === 1)

    // M-2: one stage parser — a Russian prompt carries its stage into the maker record.
    const f = fixture('b-stage')
    const stageOfSpawn = (prompt, id) => (f.spawn(id, prompt), mk.readSnapshot(DATA, id)?.stage)
    check('agent-guard M-2 incident: a Russian prompt naming the stage after the ticket — the record carries stage 1 (the second parser knew only `Stage` and gave null)', stageOfSpawn(`Режим: fix. Тикет ${f.ticket}, этап 1.`, 'sess-b-ru-1') === '1')
    check('agent-guard M-2 incident: a Russian stage field — stage 1', stageOfSpawn(`Режим: fix. Этап: 1.`, 'sess-b-ru-2') === '1')
    check('agent-guard M-2 legitimate: `Stage: 1` (English) — stage 1, as before', stageOfSpawn(`Mode: fix. Stage: 1.`, 'sess-b-ru-3') === '1')
    check('agent-guard M-2: "Stage 10 is closed; now implement stage 1" — the stage the plan has, 1 (the first number was taken before)', stageOfSpawn(`Mode: fix. Stage 10 is closed; now implement stage 1`, 'sess-b-ru-4') === '1')

    // m-1: the resume point reads stage headings with the shared readers.
    const rp = await import(join(PLUGIN, 'resume-point.mjs'))
    const list = rp.stageList('### Этап 3 [status: ОТМЕНЁН — dropped]\n\n### Stage 4: next  [status: todo]\n\n## Stage 5: second level  [status: in-progress]\n')
    check('resume-point m-1 incident: a cancelled Russian stage is closed, so the next stage is the todo one (it said to kick off the cancelled one)', list.length === 3 && list[0].done === true && list[1].done === false && list[1].heading === 'Stage 4: next', JSON.stringify(list))
    check('resume-point m-1 legitimate: a `##` heading and an in-progress status read as before', list[2].status === 'in-progress' && list[2].done === false, JSON.stringify(list))

    // R-1: a maker that never complies is not an authority over the tree.
    const g = fixture('b-giveup')
    g.spawn()
    write(g.dir, { 'src/mine.ts': 'export const mine = 1\n', 'src/orch.ts': 'export const orch = 1\n' })
    const partial = handback(['src/mine.ts'])
    const rounds = [1, 2, 3].map(() => g.stop(partial, { agent: 'agent-b-giveup' }).decision)
    const fourth = g.stop(partial, { agent: 'agent-b-giveup' })
    const [given] = g.records()
    check('maker R-1 incident: the give-up stop records the files `Changed:` names only — the orchestrator\'s src/orch.ts is not recorded (it used to be)', rounds.join() === 'block,block,block' && fourth.decision === 'allow' && given && Object.keys(given.blobs).join() === 'src/mine.ts', `${rounds} ${fourth.decision} ${JSON.stringify(given?.blobs)}`)
    check('maker R-1: the "hand-back not fixed" item names the path that was not recorded', given.items.some((item) => item.kind === 'unfixed' && /not recorded as the maker's/.test(item.text) && /src\/orch\.ts/.test(item.text)), JSON.stringify(given.items))
    check('maker R-1 consequence: the orchestrator\'s file is refused at commit', g.commit('git add src/orch.ts && git commit -m x').decision === 'deny')
    const h = fixture('b-giveup-ok')
    h.spawn()
    write(h.dir, { 'src/p.ts': 'export const p = 1\n', 'src/q.ts': 'export const q = 1\n' })
    const bothNamed = handback(['src/p.ts', 'src/q.ts']).replace('ACs without implementation: none\n', '')
    for (let round = 0; round < 4; round++) h.stop(bothNamed, { agent: 'agent-b-giveup-ok' })
    check('maker R-1 legitimate: a give-up whose `Changed:` names both files records both', Object.keys(h.records()[0]?.blobs ?? {}).sort().join() === 'src/p.ts,src/q.ts', JSON.stringify(h.records()))

    // R-2: an Edit / Write / MultiEdit straight into the plugin data directory.
    const d = fixture('b-datadir')
    const edit = (cwd, tool, file) => runHook('journal-gate.mjs', { cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file } })
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const forged = edit(d.dir, tool, join(DATA, 'maker', `${d.ticket}.jsonl`))
      check(`journal-gate R-2 incident: ${tool} into the plugin data directory in an open force run — denied, "written by the hooks only"`, forged.decision === 'deny' && /written by the hooks only/.test(forged.text), forged.text)
    }
    check('journal-gate R-2 incident: the `plugins/data/stage-pipeline-…` form of the path is denied too', edit(d.dir, 'Write', join(homedir(), '.claude/plugins/data/stage-pipeline-inline/maker/x.jsonl')).decision === 'deny')
    check('journal-gate R-2 legitimate: Write of a code file and of the task journal — passes', edit(d.dir, 'Write', join(d.dir, 'src/a.ts')).decision === 'allow' && edit(d.dir, 'Edit', join(d.tdir, 'STAGES.md')).decision === 'allow')
    check('journal-gate R-2 legitimate: the plugin\'s own source (a path with `stage-pipeline` in it) is not the data directory', edit(d.dir, 'Edit', join(PLUGIN, 'maker.mjs')).decision === 'allow')
    const done = fixture('b-datadir-closed', { heading: `## Force run ${AREL} — completed ${AREL}` })
    check('journal-gate R-2 legitimate: no open force run (the user is nearby) — the data directory is not guarded', edit(done.dir, 'Write', join(DATA, 'maker', `${done.ticket}.jsonl`)).decision === 'allow')
  }
  process.env.STAGE_PIPELINE_MAKER_RECEIPTS = 'off'
  rmSync(aRoot, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
