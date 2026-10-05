import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
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
  const tasks = readTasks(taskDir, branch)
  if (!tasks.some((task) => task.current)) tasks.push(...foreignTasks(taskDir, mainRoot(cwd) ?? root, branch))

  return { root, worktree, branch, config, taskDir, tasks }
}

function readTasks(taskDir, branch) {
  if (!isDir(taskDir)) return []
  return readdirSync(taskDir)
    .map((ticket) => ({ ticket, dir: join(taskDir, ticket), stagesPath: join(taskDir, ticket, 'STAGES.md') }))
    .filter(({ dir, stagesPath }) => isDir(dir) && isFile(stagesPath))
    .map(({ ticket, dir, stagesPath }) => {
      const stages = readFileSync(stagesPath, 'utf8')
      const { mtimeMs, size } = statSync(stagesPath)
      const branches = taskBranches(stages)
      return {
        ticket,
        dir,
        stagesPath,
        stages,
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
}

/**
 * Задача на несколько репо живёт в каталоге одного из них: задача правит core и вебвью, а STAGES.md лежит
 * в `task_path` core. Без этого во втором репо хуки задачу не видели — коммиты оркестратора шли мимо
 * обычного режима и мимо floor-guard. Каталоги задач других репо берутся из реестра (его пополняет
 * session-start), и чужая задача считается своей только при двух условиях сразу: тикет вида `ABC-12`
 * стоит в имени ветки и STAGES.md называет этот репо по имени. По одной строке `Ветка:` — нельзя:
 * `Ветка: master` задачи из соседнего проекта захватила бы master любого репо.
 */
function foreignTasks(ownTaskDir, root, branch) {
  if (!branch) return []
  const own = realPath(ownTaskDir)
  const repoName = basename(root)
  return knownTaskDirs()
    .filter((dir) => dir !== own)
    .flatMap((dir) => readTasks(dir, branch))
    .filter((task) => task.current && /^[A-Z][A-Z0-9]*-\d+$/.test(task.ticket) && isCurrentTask(task.ticket, [], branch))
    .filter((task) => new RegExp(`(^|[^\\w-])${escapeRegExp(repoName)}([^\\w-]|$)`).test(task.stages))
    .map((task) => ({ ...task, foreign: true }))
}

/**
 * Каталог данных плагина: Claude Code отдаёт его хукам в CLAUDE_PLUGIN_DATA. Запасной путь — тот же
 * каталог, что Claude Code заводит плагину сам, чтобы скрипты, запущенные руками, видели те же данные.
 */
export function pluginDataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude/plugins/data/stage-pipeline')
}

const registryPath = () => join(pluginDataDir(), 'task-dirs.json')

export function knownTaskDirs() {
  try {
    const dirs = JSON.parse(readFileSync(registryPath(), 'utf8'))
    return Array.isArray(dirs) ? dirs.filter((dir) => typeof dir === 'string' && isDir(dir)) : []
  } catch {
    return []
  }
}

export function registerTaskDir(dir) {
  const real = realPath(dir)
  if (!real || !isDir(real)) return
  const dirs = knownTaskDirs()
  if (dirs.includes(real)) return
  try {
    mkdirSync(pluginDataDir(), { recursive: true })
    writeFileSync(registryPath(), JSON.stringify([...dirs, real], null, 2))
  } catch {
    // Реестр — подсказка для соседних репо; не записался — хук этого репо работает как раньше.
  }
}

/** `review_model` из конфига: модель whole-branch ревью и свежего прогона чекера (stage-check, Шаг 3.3). */
export function reviewModel(config) {
  const raw = config.match(/^\s*-\s*review_model:\s*[`*]*([\w.-]+)/m)?.[1]
  return raw ? raw.toLowerCase() : 'opus'
}

/**
 * Открытый блок «Force-прогон» (последний без «завершён» в заголовке): заголовок, дата из него
 * (`2026-09-30`, `2026-09-30b`, `28.09.2026`) и текст до следующего раздела `## `.
 */
export function openForceBlock(stages) {
  if (!forceActive(stages)) return null
  const blocks = [...stages.matchAll(/^## Force-прогон.*$/gm)].filter(([heading]) => !/заверш/i.test(heading))
  const last = blocks.at(-1)
  if (!last) return null
  const rest = stages.slice(last.index + last[0].length)
  const end = rest.search(/^## /m)
  return { heading: last[0], date: headingDate(last[0]), body: end === -1 ? rest : rest.slice(0, end) }
}

function headingDate(heading) {
  const iso = heading.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return iso[0]
  const ru = heading.match(/(\d{2})\.(\d{2})\.(\d{4})/)
  return ru ? `${ru[3]}-${ru[2]}-${ru[1]}` : null
}

/**
 * Коммиты задачи, о которых журнал не знает: ни SHA, ни заголовок, ни содержимое не встречаются в STAGES.md,
 * STAGES-ARCHIVE.md и PR.md. Так выглядит работа после закрытия force — правки в главном контексте
 * и коммиты пользователя, которые не прошли ни один чекер. Где искать:
 * - все ветки задачи из строки `Ветка:` (локальные и origin/) и текущая, если она ветка задачи: после
 *   сквош-мержа вечерние коммиты остаются только на старой ветке, а новая ветка от dev их не видит;
 * - интеграционная ветка после закрытия force — только коммиты автора этого репо (`user.email`) в файлах
 *   задачи, которые не называют её тикет: фикс задачи под чужим тикетом прямо в dev — та же работа мимо журнала.
 * Пересобранный без подписи коммит — тот же коммит: журнал узнаёт его по заголовку или по patch-id.
 */
export function unjournaledCommits(state, task, limit = 50) {
  const cwd = state.worktree
  // База — ближайшая из интеграционных веток, а не только `main_branch`: в живых конфигах он бывает
  // `main` при PR в dev, и тогда в «работу мимо журнала» попали бы чужие смёрженные PR.
  const configured = state.config.match(/^\s*-\s*main_branch:\s*[`*]*([\w./-]+)/m)?.[1]
  const names = [...new Set([configured, 'dev', 'develop', 'development', 'main', 'master'].filter(Boolean))]
  const integration = names.flatMap((name) => [`origin/${name}`, name]).filter((ref) => isCommit(cwd, ref))
  if (!integration.length) return []
  const nearest = (ref) =>
    integration
      .map((base) => ({ ref: base, ahead: Number(git(cwd, 'rev-list', '--count', `${base}..${ref}`) ?? Infinity) }))
      .sort((a, b) => a.ahead - b.ahead)[0]
  const journal = ['STAGES.md', 'STAGES-ARCHIVE.md', 'PR.md']
    .map((name) => join(task.dir, name))
    .filter(isFile)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')

  const candidates = new Map()
  const add = (where, ...args) => {
    for (const line of (git(cwd, 'log', '--no-merges', `--max-count=${limit}`, '--format=%H%x09%s', ...args) ?? '').split('\n').filter(Boolean)) {
      const [sha, ...subject] = line.split('\t')
      // Мерж-коммиты и сквош смёрженного PR («… (#17)») — не работа задачи мимо журнала.
      if (!candidates.has(sha) && !/\(#\d+\)\s*$/.test(subject.join('\t'))) candidates.set(sha, { sha, subject: subject.join('\t'), where })
    }
  }
  // Ветки задачи — из шапки и по тикету в имени: шапку переписывают на новую ветку, старая с вечерними коммитами остаётся.
  const named = (git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin') ?? '')
    .split('\n')
    .filter((ref) => ref && isCurrentTask(task.ticket, [], ref.replace(/^origin\//, '')))
  const refs = [...new Set([...(task.current ? ['HEAD'] : []), ...task.branches.flatMap((branch) => [branch, `origin/${branch}`]), ...named])]
    .filter((ref) => isCommit(cwd, ref))
    .slice(0, 12)
  const bases = new Set()
  for (const ref of refs) {
    const base = nearest(ref)
    bases.add(base.ref)
    // Ветка уже влита сквошем («Feat(ABC-1): … (#17)» в базе позже её последнего коммита) — её работа в базе, напоминать не о чем.
    const merged = Number(git(cwd, 'log', '-1', '--format=%ct', '-F', '-i', `--grep=${task.ticket}`, base.ref) ?? 0)
    if (base.ahead && !(merged && merged >= Number(git(cwd, 'log', '-1', '--format=%ct', ref) ?? Infinity))) add('branch', `${base.ref}..${ref}`)
  }

  const closed = closedForceDate(task.stages)
  const me = git(cwd, 'config', 'user.email')
  const known = journalCommits(cwd, journal)
  if (closed && me && known.length) {
    const ticket = new RegExp(`(^|[^\\w-])${escapeRegExp(task.ticket)}([^\\w-]|$)`, 'i')
    // Коммиты задачи из журнала — с тикетом в заголовке: журнал ссылается и на базу («на базе 422729d0»), её файлы не задача.
    const info = (git(cwd, 'log', '--no-walk=unsorted', '--format=%H %ct %s', ...known) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, time, ...subject] = line.split(' ')
        return { sha, time: Number(time) * 1000, subject: subject.join(' ') }
      })
    const own = info.some(({ subject }) => ticket.test(subject)) ? info.filter(({ subject }) => ticket.test(subject)) : info
    const files = [...new Set((git(cwd, 'show', '--name-only', '--format=', ...own.map(({ sha }) => sha)) ?? '').split('\n').filter(Boolean))]
    const before = new Set(candidates.keys())
    // После закрытия — после последнего коммита прогона, а не с начала дня: утренний хотфикс до прогона — не доработка.
    // Доработка после «готово» идёт в первые дни; дальше те же файлы правят уже другие задачи.
    const since = Math.max(Date.parse(`${closed}T00:00:00`), ...own.map(({ time }) => time + 1000))
    const until = Date.parse(`${closed}T00:00:00`) + AFTER_CLOSE_DAYS * DAY
    const iso = (time) => new Date(time).toISOString().replace(/\.\d+Z$/, 'Z')
    for (const ref of bases.size ? bases : [nearest('HEAD').ref]) {
      if (files.length) add(ref, `--since=${iso(since)}`, `--until=${iso(until)}`, `--author=${escapeRegExp(me)}`, ref, '--', ...files.slice(0, 400))
    }
    // Свой сквош задачи в dev («Feat(KC-1): …») — не работа мимо журнала; откат чужого коммита — тоже не доработка задачи.
    for (const [sha, commit] of candidates) if (!before.has(sha) && (ticket.test(commit.subject) || /^Revert\s/.test(commit.subject))) candidates.delete(sha)
  }

  const left = [...candidates.values()].filter(({ sha, subject }) => !journal.includes(sha.slice(0, 7)) && !(subject.length >= 12 && journal.includes(subject)))
  if (!left.length) return []
  const journaled = new Set(patchIds(cwd, known).values())
  const ids = patchIds(cwd, left.map(({ sha }) => sha))
  return left.filter(({ sha }) => !journaled.has(ids.get(sha)))
}

/** Дата закрытия последнего force-прогона — из заголовка «завершён …» или строки статуса; null — не закрыт. */
export function closedForceDate(stages) {
  const heading = [...stages.matchAll(/^## Force-прогон.*$/gm)].at(-1)?.[0]
  const status = stages.match(/^## Статус:\s*(.+)$/m)?.[1]?.match(/force-прогон[^.;\n]{0,40}?завершён[^.;\n]{0,20}/i)?.[0]
  const closed = heading && /заверш/i.test(heading) ? heading : status
  if (!closed) return null
  return headingDate(closed.slice(closed.search(/заверш/i))) ?? headingDate(closed)
}

// SHA из журнала, которые есть в репо как коммиты: по ним журнал узнаёт пересобранный коммит и файлы задачи.
function journalCommits(cwd, journal) {
  const words = [...new Set(journal.match(/\b[0-9a-f]{7,40}\b/g) ?? [])].slice(0, 400)
  if (!words.length) return []
  const out = gitInput(cwd, words.map((word) => `${word}^{commit}`).join('\n'), 'cat-file', '--batch-check=%(objectname) %(objecttype)')
  return [...new Set(out.split('\n').filter((line) => / commit$/.test(line)).map((line) => line.split(' ')[0]))]
}

function patchIds(cwd, shas) {
  if (!shas.length) return new Map()
  const diff = gitInput(cwd, '', 'log', '--no-walk=unsorted', '-p', '--no-color', '--no-ext-diff', '--format=commit %H', ...shas)
  if (!diff) return new Map()
  const out = gitInput(cwd, diff, 'patch-id', '--stable')
  return new Map(out.split('\n').filter(Boolean).map((line) => line.split(' ').reverse()))
}

const isCommit = (cwd, ref) => Boolean(git(cwd, 'rev-parse', '-q', '--verify', `${ref}^{commit}`))

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
  return new RegExp(`(^|[/_.-])${escapeRegExp(ticket)}($|[/_.-])`, 'i').test(branch)
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
export const AFTER_CLOSE_DAYS = 14

/**
 * Корень репо с конфигом пайплайна. В worktree `.claude/` может быть не закоммичен
 * (исключён через .git/info/exclude) — тогда конфиг ищется в основном рабочем дереве.
 */
function configRoot(cwd, worktree) {
  if (isFile(join(worktree, '.claude/pipeline.config.md'))) return worktree
  const main = mainRoot(cwd)
  return main && main !== worktree && isFile(join(main, '.claude/pipeline.config.md')) ? main : null
}

// Основное рабочее дерево: у worktree `webview-abc12` репо всё равно называется `webview`.
function mainRoot(cwd) {
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  return common && basename(common) === '.git' ? dirname(common) : null
}

function realPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function git(cwd, ...args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

function gitInput(cwd, input, ...args) {
  try {
    return execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 })
  } catch {
    return ''
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
