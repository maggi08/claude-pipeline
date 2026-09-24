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
const { gitInvocations } = await import(join(PLUGIN, 'hooks/git-command.mjs'))
const { taskDirFromConfig, taskBranches, isCurrentTask, forceActive } = await import(join(PLUGIN, 'hooks/pipeline-state.mjs'))
const { planArchive } = await import(join(PLUGIN, 'archive-stages.mjs'))

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
check('ветка T-1: grep "git add" не трогается', hook('git-guard.mjs', repo, 'grep -rn "git add" .') === 'allow')
check('session-start: задача текущей ветки первой', /^- T-1 \(ветка T-1\/feat\/a\)/m.test(hook('session-start.mjs', repo)))

git(repo, 'checkout', '-qb', 'T-2/feat/b')
check('ветка T-2, force: git add проходит', hook('git-guard.mjs', repo, 'git add -A') === 'allow')
check('ветка T-2, force: чистый коммит проходит', hook('git-guard.mjs', repo, 'git commit -m x') === 'allow')
// floor-ok: фикстура — хук обязан отклонить коммит с этим приведением
write(repo, { 'src/a.ts': 'export const a = 1 as any\n' })
check('ветка T-2, force: коммит с обходом типов отклонён floor-guard', hook('git-guard.mjs', repo, 'git commit -am x') === 'deny')
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
rmSync(root, { recursive: true, force: true })

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
