import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * Общее состояние пайплайна для хуков и скриптов. Плагин включён во всех репозиториях,
 * поэтому всё, что не находит `.claude/pipeline.config.md`, возвращает null —
 * хук в чужом репо обязан молчать.
 *
 * Хуки смотрят только на задачи ТЕКУЩЕЙ ВЕТКИ (`current`). Задачи других веток — параллельная
 * работа в соседней сессии или worktree, брошенные и давно закрытые — на эту ветку не влияют:
 * иначе один забытый `[status: in-progress]` блокирует коммиты во всём репо, а блок
 * «Force-прогон» старой задачи разрешает их всем. Файлы задач читаются как есть: живые
 * конфиги и STAGES.md никто не обязан переписывать под новую версию плагина.
 */
export function readPipelineState(cwd) {
  const worktree = git(cwd, 'rev-parse', '--show-toplevel') ?? cwd
  const root = configRoot(cwd, worktree)
  if (!root) return null

  const config = readConfig(root)
  const taskDir = taskDirFromConfig(config, root)
  // Ветка — рабочего дерева, где идёт команда: у каждого worktree своя.
  const branch = git(worktree, 'symbolic-ref', '--short', '-q', 'HEAD')
  if (!existsSync(taskDir)) return { root, worktree, branch, tasks: [] }

  const tasks = readdirSync(taskDir)
    .map((ticket) => ({ ticket, dir: join(taskDir, ticket), stagesPath: join(taskDir, ticket, 'STAGES.md') }))
    .filter(({ dir, stagesPath }) => isDir(dir) && isFile(stagesPath))
    .map(({ ticket, stagesPath }) => {
      const stages = readFileSync(stagesPath, 'utf8')
      const { mtimeMs, size } = statSync(stagesPath)
      const branches = taskBranches(stages)
      return {
        ticket,
        stagesPath,
        mtime: mtimeMs,
        sizeKb: Math.round(size / 1024),
        status: stages.match(/^## Статус:\s*(.+)$/m)?.[1]?.trim() ?? null,
        branches,
        // Задача, которую не трогали дольше STALE_DAYS, ничего не охраняет: брошенный статус не должен
        // блокировать ветку навсегда, а вернувшаяся в работу задача обновит STAGES.md первым же kickoff/check.
        current: Date.now() - mtimeMs < STALE_DAYS * DAY && isCurrentTask(ticket, branches, branch),
        // Живые форматы: `[status: in-progress]`, `[status: in-progress — ждёт user-review]`, `[status: in progress; …]`.
        open: /\[status:\s*(todo|in[-\s]progress)\b/i.test(stages),
        forceActive: forceActive(stages),
      }
    })
    .sort((a, b) => b.mtime - a.mtime)

  return { root, worktree, branch, tasks }
}

/**
 * Каталог задач из строки `task_path` конфига. В живых конфигах путь бывает в бэктиках,
 * с `~`, с плейсхолдером `<ТИКЕТ>/` и с комментарием после — всё это один и тот же каталог.
 * `pipeline.config.local.md` (раскладка машины) перекрывает общий конфиг.
 */
export function taskDirFromConfig(config, root) {
  const raw = config.match(/^\s*-\s*task_path:\s*(.+)$/m)?.[1]
  if (!raw) return join(root, '.claude/tasks')
  let path = raw.trim().split(/\s+/)[0].replace(/^[`'"]+|[`'"]+$/g, '')
  path = path.split('<')[0]
  if (!path) return join(root, '.claude/tasks')
  if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(1))
  else if (path.startsWith('$HOME/')) path = join(homedir(), path.slice(5))
  return isAbsolute(path) ? path : resolve(root, path)
}

export function readConfig(root) {
  const local = join(root, '.claude/pipeline.config.local.md')
  const shared = join(root, '.claude/pipeline.config.md')
  // local — поверх shared: поле, которого нет в local, берётся из общего конфига.
  return [local, shared].filter(isFile).map((path) => readFileSync(path, 'utf8')).join('\n')
}

/**
 * Ветки задачи — из строки `Ветка:`/`Ветки:`/`Branch:` в шапке STAGES.md: имена в бэктиках,
 * а без бэктиков — первое слово, если оно похоже на имя ветки. Хвост строки — откуда ветка
 * отведена и куда идёт PR («влита в `dev`», «от `redesign-2.0`») — задаче не принадлежит:
 * иначе задача стала бы текущей для всех, кто сидит на базовой ветке. Явное `Ветка: master`
 * (репо без PR-флоу) — принадлежит.
 */
export function taskBranches(stages) {
  const head = stages.split(/^## /m)[0]
  // Рядом с веткой в шапке живут SHA коммитов, флаги (`--no-track`) и пути соседних репо — это не ветки.
  const own = (name) => !name.startsWith('origin/') && !/^[-.]|^[0-9a-f]{7,40}$/.test(name)
  const found = new Set()
  // Шаблон stage-plan пишет ветку посреди строки через два пробела: `Figma: <url>  Ветка: <branch>  Контексты: …`;
  // «База ветки:» — не ветка задачи.
  for (const [, line] of head.matchAll(/(?:^|\s{2,}|[·|]\s*)\**(?:Ветк[аи](?:\s+задачи)?|Branch(?:es)?)\**:\s*(.+)$/gimu)) {
    // Дальше по строке — откуда ветка отведена и куда идёт PR: `(срезана с …)`, `от \`redesign-2.0\``, `→ PR в …`.
    const rest = line.split(/\s+[·|]\s+|\s+(?=[\p{L}/]+:\s)|\s*\(|,?\s+(?:от|из|from|off|срезана|отведена|пересажена|база|base|влита|merged|→|PR\b)/iu)[0]
    const quoted = [...rest.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]).filter(own)
    const bare = rest.match(/^([\w.\-/]+)(?=[\s,;]|$)/)?.[1]
    const names = quoted.length ? quoted : bare && /^[a-z0-9]/i.test(bare) && own(bare) && !/^(TBD|нет|none|—)$/i.test(bare) ? [bare] : []
    for (const name of names) found.add(name)
  }
  return [...found]
}

// Тикет в имени ветки — отдельным сегментом: `KC-480/feat/x`, `feat/KC-480-x`, но не `KC-4801/…`.
export function isCurrentTask(ticket, branches, branch) {
  if (!branch || branch === 'HEAD') return false
  if (branches.includes(branch)) return true
  const escaped = ticket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[/_.-])${escaped}($|[/_.-])`, 'i').test(branch)
}

/**
 * Блок «Force-прогон» открыт, пока в строке его заголовка нет «завершён» (stage-force, Выход). Прогоны до 0.11
 * закрывали не заголовок, а строку статуса — «force-прогон 2026-09-23 завершён», «force-прогон завершён 16.09»:
 * это тоже конец прогона, и старую задачу ради хука никто не обязан переписывать. Признак «все этапы done»
 * не годится: после последнего этапа force ещё идёт — финальные проверки и догон коммитятся тем же прогоном.
 */
export function forceActive(stages) {
  const status = stages.match(/^## Статус:\s*(.+)$/m)?.[1] ?? ''
  const finished = status.match(/force-прогон[^.;\n]{0,40}?завершён/i)?.[0]
  if (finished && !/не\s+завершён/i.test(finished)) return false
  return [...stages.matchAll(/^## Force-прогон.*$/gm)].some(([heading]) => !/заверш/i.test(heading))
}

const DAY = 24 * 60 * 60 * 1000
export const STALE_DAYS = 21

/**
 * Корень репо с конфигом пайплайна. В worktree `.claude/` может быть не закоммичен
 * (исключён через .git/info/exclude) — тогда конфиг ищется в основном рабочем дереве.
 */
function configRoot(cwd, worktree) {
  if (isFile(join(worktree, '.claude/pipeline.config.md'))) return worktree
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const main = common && basename(common) === '.git' ? dirname(common) : null
  return main && main !== worktree && isFile(join(main, '.claude/pipeline.config.md')) ? main : null
}

function git(cwd, ...args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export async function readHookInput() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
