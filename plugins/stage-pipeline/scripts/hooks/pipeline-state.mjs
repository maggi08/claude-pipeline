import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  BRANCH_BOUNDARY,
  BRANCH_LABEL,
  CLOSED_WORD,
  EN_HEADINGS,
  LANGUAGE_LINE,
  NOT_CLOSED,
  NO_BRANCH,
  RU_HEADINGS,
  STATUS_FORCE_CLOSED,
  STATUS_FORCE_CLOSED_WITH_DATE,
  STATUS_LINE,
  forceHeadings,
} from '../markers.mjs'

/**
 * Shared pipeline state for hooks and scripts. The plugin is enabled in all repos,
 * so anything that does not find `.claude/pipeline.config.md` returns null —
 * a hook in a foreign repo must stay silent.
 *
 * Hooks look only at tasks of the CURRENT BRANCH (`current`). Tasks of other branches — parallel
 * work in a neighbouring session or worktree, abandoned and long-closed ones — do not affect this branch:
 * otherwise one forgotten `[status: in-progress]` blocks commits across the whole repo, and the
 * "Force run" block of an old task allows them for everyone. Task files are read as they are: live
 * configs and STAGES.md do not have to be rewritten for a new plugin version.
 */
export function readPipelineState(cwd) {
  const worktree = git(cwd, 'rev-parse', '--show-toplevel') ?? cwd
  const root = configRoot(cwd, worktree)
  if (!root) return null

  const config = readConfig(root)
  const taskDir = taskDirFromConfig(config, root)
  // The branch of the worktree where the command runs: each worktree has its own.
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
        status: stages.match(STATUS_LINE)?.[1]?.trim() ?? null,
        language: taskLanguage(stages),
        branches,
        // A task untouched for longer than STALE_DAYS guards nothing: an abandoned status must not
        // block a branch forever, and a task that returns to work updates STAGES.md at its first kickoff/check.
        current: Date.now() - mtimeMs < STALE_DAYS * DAY && isCurrentTask(ticket, branches, branch),
        // Live formats: `[status: in-progress]`, `[status: in-progress — waiting for user-review]`, `[status: in progress; …]`.
        open: /\[status:\s*(todo|in[-\s]progress)\b/i.test(stages),
        forceActive: forceActive(stages),
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

/**
 * A task over several repos lives in the task directory of one of them: the task edits core and the webview, and STAGES.md lies
 * in core's `task_path`. Without this the hooks did not see the task in the second repo — the orchestrator's commits bypassed
 * the normal mode and floor-guard. Task directories of other repos come from the registry (session-start
 * fills it), and a foreign task counts as own only under two conditions at once: a ticket like `ABC-12`
 * is in the branch name and STAGES.md names this repo. The `Branch:` line alone is not enough:
 * a `Branch: master` of a task from a neighbouring project would capture master of any repo.
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
 * The plugin data directory: Claude Code gives it to hooks in CLAUDE_PLUGIN_DATA. The fallback path is the same
 * directory Claude Code creates for the plugin itself, so scripts run by hand see the same data.
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
    // The registry is a hint for neighbouring repos; if it is not written, this repo's hook works as before.
  }
}

/** `review_model` from the config: the model of the whole-branch review and of the fresh checker run (stage-check, Step 3.3). */
export function reviewModel(config) {
  const raw = config.match(/^\s*-\s*review_model:\s*[`*]*([\w.-]+)/m)?.[1]
  return raw ? raw.toLowerCase() : 'opus'
}

/**
 * An open "Force run" block (the last one without "completed" in the heading): the heading, the date from it
 * (`2026-09-30`, `2026-09-30b`, `28.09.2026`; `unreadDate` — the heading has a date in another form) and the text up to the next `## ` section.
 */
export function openForceBlock(stages) {
  if (!forceActive(stages)) return null
  const blocks = forceHeadings(stages).filter(([heading]) => !CLOSED_WORD.test(heading))
  const last = blocks.at(-1)
  if (!last) return null
  const rest = stages.slice(last.index + last[0].length)
  const end = rest.search(/^## /m)
  const date = headingDate(last[0])
  // A date the parser did not understand ("Oct 17, 2026", "10/17/2026") is a new block, not an old one: fail closed, `Confirmed:` is required.
  const unreadDate = date === null && /\d{4}|\d{1,2}[/.-]\d{1,2}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(last[0])
  return { heading: last[0], date, unreadDate, body: end === -1 ? rest : rest.slice(0, end) }
}

function headingDate(heading) {
  const iso = heading.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return iso[0]
  const ru = heading.match(/(\d{2})\.(\d{2})\.(\d{4})/)
  return ru ? `${ru[3]}-${ru[2]}-${ru[1]}` : null
}

/**
 * Task commits the journal does not know: neither the SHA, nor the subject, nor the content appear in STAGES.md,
 * STAGES-ARCHIVE.md and PR.md. This is what work after a force run closed looks like — edits in the main context
 * and the user's commits that did not pass any checker. Where to look:
 * - all task branches from the `Branch:` line (local and origin/) and the current one if it is a task branch: after
 *   a squash merge the evening commits remain only on the old branch, and a new branch off dev does not see them;
 * - the integration branch after the force run closed — only commits by this repo's author (`user.email`) in task
 *   files that do not name its ticket: a task fix under someone else's ticket straight in dev is the same work bypassing the journal.
 * A commit rebuilt without a signature is the same commit: the journal recognises it by subject or by patch-id.
 */
export function unjournaledCommits(state, task, limit = 50) {
  const cwd = state.worktree
  // The base is the nearest of the integration branches, not only `main_branch`: in live configs it can be
  // `main` with PRs into dev, and then other people's merged PRs would fall into "work bypassing the journal".
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
      // Merge commits and the squash of a merged PR ("… (#17)") are not task work bypassing the journal.
      if (!candidates.has(sha) && !/\(#\d+\)\s*$/.test(subject.join('\t'))) candidates.set(sha, { sha, subject: subject.join('\t'), where })
    }
  }
  // Task branches come from the header and from the ticket in the name: the header is rewritten for a new branch, the old one with evening commits stays.
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
    // The branch is already merged by squash ("Feat(ABC-1): … (#17)" in the base after its last commit) — its work is in the base, nothing to remind about.
    const merged = Number(git(cwd, 'log', '-1', '--format=%ct', '-F', '-i', `--grep=${task.ticket}`, base.ref) ?? 0)
    if (base.ahead && !(merged && merged >= Number(git(cwd, 'log', '-1', '--format=%ct', ref) ?? Infinity))) add('branch', `${base.ref}..${ref}`)
  }

  const closed = closedForceDate(task.stages)
  const me = git(cwd, 'config', 'user.email')
  const known = journalCommits(cwd, journal)
  if (closed && me && known.length) {
    const ticket = new RegExp(`(^|[^\\w-])${escapeRegExp(task.ticket)}([^\\w-]|$)`, 'i')
    // Task commits from the journal are those with the ticket in the subject: the journal also refers to the base ("on base 422729d0"), its files are not the task.
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
    // After the close — after the last commit of the run, not from the start of the day: a morning hotfix before the run is not follow-up work.
    // Follow-up work after "done" happens in the first days; later the same files are edited by other tasks.
    const since = Math.max(Date.parse(`${closed}T00:00:00`), ...own.map(({ time }) => time + 1000))
    const until = Date.parse(`${closed}T00:00:00`) + AFTER_CLOSE_DAYS * DAY
    const iso = (time) => new Date(time).toISOString().replace(/\.\d+Z$/, 'Z')
    for (const ref of bases.size ? bases : [nearest('HEAD').ref]) {
      if (files.length) add(ref, `--since=${iso(since)}`, `--until=${iso(until)}`, `--author=${escapeRegExp(me)}`, ref, '--', ...files.slice(0, 400))
    }
    // The task's own squash into dev ("Feat(KC-1): …") is not work bypassing the journal; a revert of someone else's commit is not task follow-up either.
    for (const [sha, commit] of candidates) if (!before.has(sha) && (ticket.test(commit.subject) || /^Revert\s/.test(commit.subject))) candidates.delete(sha)
  }

  const left = [...candidates.values()].filter(({ sha, subject }) => !journal.includes(sha.slice(0, 7)) && !(subject.length >= 12 && journal.includes(subject)))
  if (!left.length) return []
  const journaled = new Set(patchIds(cwd, known).values())
  const ids = patchIds(cwd, left.map(({ sha }) => sha))
  return left.filter(({ sha }) => !journaled.has(ids.get(sha)))
}

/** The closing date of the last force run — from a "completed …" heading or a status line; null — not closed. */
export function closedForceDate(stages) {
  const heading = forceHeadings(stages).at(-1)?.[0]
  const status = stages.match(STATUS_LINE)?.[1]?.match(STATUS_FORCE_CLOSED_WITH_DATE)?.[0]
  const closed = heading && CLOSED_WORD.test(heading) ? heading : status
  if (!closed) return null
  return headingDate(closed.slice(closed.search(CLOSED_WORD))) ?? headingDate(closed)
}

// SHAs from the journal that exist in the repo as commits: through them the journal recognises a rebuilt commit and task files.
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
 * The task directory from the config's `task_path` line. In live configs the path may be in backticks,
 * with `~`, with a `<TICKET>/` placeholder and with a comment after it — all of these are the same directory.
 * `pipeline.config.local.md` (the machine's layout) overrides the shared config.
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
  // local goes over shared: a field missing in local is taken from the shared config.
  return [local, shared].filter(isFile).map((path) => readFileSync(path, 'utf8')).join('\n')
}

/**
 * Task branches — from the `Branch:`/`Branches:`/`Branch:` line in the STAGES.md header: names in backticks,
 * and without backticks the first word if it looks like a branch name. The tail of the line — where the branch
 * was cut from and where the PR goes ("merged into `dev`", "off `redesign-2.0`") — does not belong to the task:
 * otherwise the task would become current for everyone sitting on the base branch. An explicit `Branch: master`
 * (a repo without a PR flow) does belong.
 */
export function taskBranches(stages) {
  const head = stages.split(/^## /m)[0]
  // Next to the branch in the header live commit SHAs, flags (`--no-track`) and paths of neighbouring repos — these are not branches.
  const own = (name) => !name.startsWith('origin/') && !/^[-.]|^[0-9a-f]{7,40}$/.test(name)
  const found = new Set()
  // The stage-plan template writes the branch in the middle of a line after two spaces: `Figma: <url>  Branch: <branch>  Contexts: …`;
  // "Branch base:" is not the task branch.
  for (const [, line] of head.matchAll(new RegExp(`(?:^|\\s{2,}|[·|]\\s*)\\**(?:${BRANCH_LABEL})\\**:\\s*(.+)$`, 'gimu'))) {
    // Further along the line — where the branch was cut from and where the PR goes: `(cut from …)`, `off \`redesign-2.0\``, `→ PR into …`.
    const rest = line.split(new RegExp(`\\s+[·|]\\s+|\\s+(?=[\\p{L}/]+:\\s)|\\s*\\(|,?\\s+(?:${BRANCH_BOUNDARY})`, 'iu'))[0]
    const quoted = [...rest.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]).filter(own)
    const bare = rest.match(/^([\w.\-/]+)(?=[\s,;]|$)/)?.[1]
    const names = quoted.length ? quoted : bare && /^[a-z0-9]/i.test(bare) && own(bare) && !NO_BRANCH.test(bare) ? [bare] : []
    for (const name of names) found.add(name)
  }
  return [...found]
}

// A ticket in the branch name as a separate segment: `KC-480/feat/x`, `feat/KC-480-x`, but not `KC-4801/…`.
export function isCurrentTask(ticket, branches, branch) {
  if (!branch || branch === 'HEAD') return false
  if (branches.includes(branch)) return true
  return new RegExp(`(^|[/_.-])${escapeRegExp(ticket)}($|[/_.-])`, 'i').test(branch)
}

/**
 * The task language from the STAGES.md text: a `Language: en` line in the header (or its Russian form with `ru`); without it — by the headings
 * (`## Journal` / `### Stage` → en, their Russian forms → ru; with both — whichever comes first).
 * `null` — cannot be determined.
 */
export function taskLanguage(stages) {
  const head = stages.split(/^## /m)[0]
  const declared = head.match(LANGUAGE_LINE)?.[1]?.toLowerCase()
  if (declared) return declared
  const ru = stages.search(RU_HEADINGS)
  const en = stages.search(EN_HEADINGS)
  if (ru === -1 && en === -1) return null
  if (en === -1) return 'ru'
  if (ru === -1) return 'en'
  return ru < en ? 'ru' : 'en'
}

/**
 * A "Force run" block is open while there is no "completed" in its heading line (stage-force, Output). Runs before 0.11
 * were closed not by the heading but by the status line — "force run 2026-09-23 completed", "force run completed 16.09":
 * that is also the end of a run, and nobody has to rewrite an old task for the hook. The "all stages done" sign
 * does not work: after the last stage force is still going — the final checks and the catch-up are committed in the same run.
 */
export function forceActive(stages) {
  const status = stages.match(STATUS_LINE)?.[1] ?? ''
  const finished = status.match(STATUS_FORCE_CLOSED)?.[0]
  if (finished && !NOT_CLOSED.test(finished)) return false
  return forceHeadings(stages).some(([heading]) => !CLOSED_WORD.test(heading))
}

const DAY = 24 * 60 * 60 * 1000
export const STALE_DAYS = 21
export const AFTER_CLOSE_DAYS = 14

/**
 * The repo root with the pipeline config. In a worktree `.claude/` may be uncommitted
 * (excluded via .git/info/exclude) — then the config is looked for in the main working tree.
 */
function configRoot(cwd, worktree) {
  if (isFile(join(worktree, '.claude/pipeline.config.md'))) return worktree
  const main = mainRoot(cwd)
  return main && main !== worktree && isFile(join(main, '.claude/pipeline.config.md')) ? main : null
}

// The main working tree: for a worktree `webview-abc12` the repo is still called `webview`.
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
