import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandSegments } from './git-command.mjs'
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
  freshestForceHeading,
  headingDate,
  ruleAppliesToBlock,
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

  return { root, worktree, branch, config, taskDir, tasks, oversize: oversizeConfigs(root) }
}

function readTasks(taskDir, branch) {
  if (!isDir(taskDir)) return []
  return readdirSync(taskDir)
    .map((ticket) => ({ ticket, dir: join(taskDir, ticket), stagesPath: join(taskDir, ticket, 'STAGES.md') }))
    .filter(({ dir }) => isDir(dir))
    .flatMap(({ ticket, dir, stagesPath }) => {
      // STAGES.md through the task file rule: a journal that is there but cannot be read (over the cap, a link out of the task, not a regular file)
      // keeps its task — current by the ticket in the branch — with `unreadable`, so the gates refuse instead of finding no rules.
      const read = taskFile(dir, 'STAGES.md')
      if (read.problem === 'missing') return []
      const stages = read.text ?? ''
      const { mtimeMs, size } = statOf(stagesPath) ?? { mtimeMs: 0, size: read.size ?? 0 }
      const branches = taskBranches(stages)
      return [{
        ticket,
        dir,
        stagesPath,
        stages,
        unreadable: read.problem ? { file: 'STAGES.md', ...read, message: unreadableMessage('STAGES.md', read) } : null,
        mtime: mtimeMs,
        sizeKb: Math.round(size / 1024),
        status: stages.match(STATUS_LINE)?.[1]?.trim() ?? null,
        language: taskLanguage(stages),
        branches,
        // A task untouched for longer than STALE_DAYS guards nothing: an abandoned status must not
        // block a branch forever, and a task that returns to work updates STAGES.md at its first kickoff/check.
        current: Date.now() - mtimeMs < STALE_DAYS * DAY && isCurrentTask(ticket, branches, branch),
        open: OPEN_STATUS.test(stages),
        forceActive: forceActive(stages),
      }]
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
 * The plugin data directory: `STAGE_PIPELINE_DATA_DIR` (an absolute path) wins when set — the eval harness points a run at a throwaway directory with it, because Claude Code overwrites CLAUDE_PLUGIN_DATA for the hooks of a session. Else Claude Code gives it to hooks in CLAUDE_PLUGIN_DATA (`stage-pipeline-<marketplace>`; `stage-pipeline-inline`
 * for a `--plugin-dir` session). A script run from Bash has no such variable and used to fall back to a bare `stage-pipeline`
 * directory — a different one, so the snapshots and the gate runs of the two never met. Now the name comes from where the script itself lies:
 * the `installPath` of a `stage-pipeline@<marketplace>` entry in `~/.claude/plugins/installed_plugins.json` that contains it (or a cached older version of that install) gives
 * `stage-pipeline-<marketplace>`; else the `installLocation` / `source.path` of a marketplace in `known_marketplaces.json` that contains it (a marketplace connected as a directory) gives `stage-pipeline-<marketplace>`; a script outside both (a `--plugin-dir` run) gives `stage-pipeline-inline`, as the hooks of that session do.
 */
export function pluginDataDir() {
  // The override wins over CLAUDE_PLUGIN_DATA: Claude Code sets that variable itself for the hooks of a session, so a harness that sets only it
  // never reaches them (the eval runs wrote into the live directory). Only an absolute path counts.
  const override = process.env.STAGE_PIPELINE_DATA_DIR
  if (override && isAbsolute(override)) return override
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA
  const here = dirname(fileURLToPath(import.meta.url))
  const root = join(homedir(), '.claude/plugins/data')
  const under = (dir) => typeof dir === 'string' && dir !== '' && (here === dir || here.startsWith(dir.replace(/[/\\]+$/, '') + sep))
  const named = (marketplace) => join(root, `stage-pipeline-${marketplace.replace(/[^\w.-]/g, '-')}`)
  const readJson = (name) => {
    try {
      return JSON.parse(readFileSync(join(homedir(), '.claude/plugins', name), 'utf8'))
    } catch {
      return null
    }
  }
  // An entry of another shape (a v1 file's object, a `null` in the list) is skipped, and a registry that cannot be read is none, as on 0.17.0: then the marketplaces, then `-inline`.
  let installed = []
  try {
    installed = Object.entries(readJson('installed_plugins.json')?.plugins ?? {}).flatMap(([key, entries]) => {
      const match = key.match(/^stage-pipeline@(.+)$/)
      if (!match || !Array.isArray(entries) || !entries.every((entry) => entry !== null && typeof entry === 'object')) return []
      return [{ marketplace: match[1], paths: entries.map(({ installPath }) => installPath) }]
    })
  } catch {
    installed = []
  }
  // The current install, then any cached version of it: a session that started before an update still runs `cache/<marketplace>/stage-pipeline/<old version>`,
  // and its hooks get the same `stage-pipeline-<marketplace>`.
  for (const { marketplace, paths } of installed) if (paths.some(under)) return named(marketplace)
  const cached = here.match(/[/\\]plugins[/\\]cache[/\\]([^/\\]+)[/\\]stage-pipeline[/\\]/)
  if (cached && installed.some(({ marketplace }) => marketplace === cached[1])) return named(cached[1])
  // A marketplace connected as a directory runs the plugin from its working tree while `installPath` points into the cache:
  // the script lies in the marketplace's source directory, and that marketplace's name is the hooks' one.
  try {
    for (const [name, entry] of Object.entries(readJson('known_marketplaces.json') ?? {})) {
      if ([entry?.installLocation, entry?.source?.path].some(under)) return named(name)
    }
  } catch {
    // no list of marketplaces of a shape we read
  }
  // A script outside every install and marketplace (a `--plugin-dir` run, a worktree): the hooks of that session get `-inline`.
  return join(root, 'stage-pipeline-inline')
}

/** The bare `…/stage-pipeline` directory next to a `stage-pipeline-<marketplace>` one: where scripts from Bash used to write. Read after the main one, so nothing written earlier is lost. */
export function legacyDataDir(dataDir) {
  return basename(dataDir).startsWith('stage-pipeline-') ? join(dirname(dataDir), 'stage-pipeline') : null
}

/**
 * The text of the plugin data directory a command or a file path names, else null: the directory itself (as given, real, legacy), its `plugins/data/stage-pipeline…` form,
 * `CLAUDE_PLUGIN_DATA`. Shared by force-guard (Bash) and journal-gate (Edit / Write / MultiEdit): those files are written by the hooks only (K11a.1, R-2).
 */
export function namesDataDir(text) {
  const dirs = []
  try {
    const dir = pluginDataDir().replace(/[/\\]+$/, '')
    for (const candidate of [dir, legacyDataDir(dir)]) {
      if (!candidate) continue
      dirs.push(candidate)
      try {
        dirs.push(realpathSync(candidate))
      } catch {
        // not there yet
      }
    }
  } catch {
    // no resolvable directory: the generic forms below still apply
  }
  for (const dir of dirs) if (dir.length > 8 && text.includes(dir)) return dir
  const generic = /plugins\/data\/stage-pipeline[\w.-]*|CLAUDE_PLUGIN_DATA/.exec(text)
  return generic ? generic[0] : null
}

/** The plugin data directories a command can name, as text: the directory itself (as given, real, legacy). */
function dataDirTexts() {
  const dirs = []
  try {
    const dir = pluginDataDir().replace(/[/\\]+$/, '')
    for (const candidate of [dir, legacyDataDir(dir)]) {
      if (!candidate) continue
      dirs.push(candidate)
      try {
        dirs.push(realpathSync(candidate))
      } catch {
        // not there yet
      }
    }
  } catch {
    // no resolvable directory: the generic forms still apply
  }
  return dirs.filter((dir) => dir.length > 8)
}

const WRITE_COPIERS = new Set(['cp', 'rsync', 'install', 'ln']) // the data dir as the destination (the last operand, or `-t`)
const WRITE_ANY_OPERAND = new Set(['rm', 'unlink', 'shred', 'truncate', 'tee']) // any operand in the data dir
const COMMAND_WRAPPERS = new Set(['command', 'time', 'nice', 'nohup', 'env', 'export', 'sudo', 'exec'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'eval'])
// A write form in inline code (K11c.3, M-1): any mutating or executing primitive as a word (write, append, unlink, rm, rename, copy, symlink, mkdir, chmod, system, exec*, spawn*, subprocess, shutil, Popen, File.delete …)
// or an `open(` / `.open(` / `openSync(` call with a mode literal containing w, a, x or + (or a `mode=` keyword). A word scan, no backtracking: every pattern is a flat alternation or a bounded window.
const INLINE_MUTATE = /write|append|unlink|remove|rename|copy|symlink|truncate|mkdir|makedirs|chmod|chown|utime|delete|spawn|popen|subprocess|child_process|shutil|exec|system|move|\b(?:rm|cp|mv|ln|link|dd|tee)(?:Sync|dir|\b)/i
const INLINE_OPEN = /\bopen\w*\s*\(/g
const INLINE_MODE = /,\s*['"][rbt]{0,3}[wax+][rwabxt+]{0,3}['"]\s*[,)]|\bmode\s*=/
// a read call naming the directory (`readFileSync('<dir>/x')`): its argument is a read of the data dir, not a write (a copy out)
const INLINE_READ_CALL = /\b(?:readFileSync|readFile|readdirSync|readdir|statSync|existsSync|read_text|read_bytes|listdir|load)\s*\([^)]{0,300}\)?/g
function inlineWrites(code) {
  if (INLINE_MUTATE.test(code)) return true
  for (const match of code.matchAll(INLINE_OPEN)) {
    const window = code.slice(match.index, match.index + 200)
    const close = window.search(/\)\s*(?:[;.\n]|$)/)
    if (INLINE_MODE.test(close > 0 ? window.slice(0, close + 1) : window)) return true
  }
  return false
}
/** The file operands of a `sed` command: its script and the values of `-e` / `-f` are not paths. */
function sedFiles(words) {
  const files = []
  let scripted = false
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (/^(?:-e|-f|--expression|--file)$/.test(word)) {
      scripted = true
      i++
    } else if (/^(?:--expression|--file)=/.test(word) || /^-[A-Za-z]*[ef]./.test(word)) scripted = true
    else if (word && !word.startsWith('-')) files.push(word)
  }
  return scripted ? files : files.slice(1)
}
const INLINE_CODE = /^(?:node|nodejs|bun|deno|python[\d.]*|ruby|perl)$/

/**
 * K11b.2 (VT-5 B3): the text of the plugin data directory a Bash command WRITES into, else null. Only write forms: a redirect (`>`, `>>`), `tee`, `cp`/`rsync`/`install`/`ln`
 * with the directory as the destination, `mv` with it as an operand, `rm`/`unlink`/`shred`/`truncate`/`sed -i` on a path in it, `dd of=`, and an inline `node -e` / `python -c` that names a path in it with a write form (K11c.3)
 * (A11: deleting a maker record turns the commit rule off for the run, so a delete is a write). The bare word `CLAUDE_PLUGIN_DATA`, `cat`/`grep`/`ls`, `cp -R <data dir> <scratch>` (a copy out)
 * and `CLAUDE_PLUGIN_DATA=<temp dir> node …` name no write into it. One linear pass over the lexer's words; a `bash -c '…'` string is read the same way, three levels deep.
 * The guard catches the habit, not a determined workaround: a path built at run time still reaches the files.
 */
export function writesDataDir(command, depth = 0) {
  const dirs = dataDirTexts()
  // cheap exit for nearly every call: no directory, no `plugins/data/stage-pipeline`, no variable in the text
  if (!dirs.some((dir) => command.includes(dir)) && !command.includes('plugins/data/stage-pipeline') && !command.includes('CLAUDE_PLUGIN_DATA')) return null
  const segments = commandSegments(command)
  // an own `CLAUDE_PLUGIN_DATA=<dir>` in the command points the variable somewhere else: `$CLAUDE_PLUGIN_DATA` and the bare word then name that directory, not the hooks' one
  const overridden = segments.some((words) => words.some((word) => /^(?:CLAUDE_PLUGIN_DATA)=/.test(word)))
  const names = (word) => {
    for (const dir of dirs) if (word.includes(dir)) return dir
    const generic = /plugins\/data\/stage-pipeline[\w.-]*/.exec(word)
    if (generic) return generic[0]
    if (!overridden && /\$\{?CLAUDE_PLUGIN_DATA\b/.test(word)) return 'CLAUDE_PLUGIN_DATA'
    return null
  }
  const firstNamed = (words) => {
    for (const word of words) {
      const dir = names(word)
      if (dir) return dir
    }
    return null
  }
  for (const words of segments) {
    // a redirect: `> file`, `>> file`, `2>file`, `>|file` — the target is the rest of the word or the next one (`&1` is a descriptor)
    for (let i = 0; i < words.length; i++) {
      const found = /^\d*>[>|]?(.*)$/.exec(words[i])
      if (!found || found[1].startsWith('&')) continue
      const dir = names(found[1] || words[i + 1] || '')
      if (dir) return dir
    }
    let i = 0
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || COMMAND_WRAPPERS.has(words[i]))) i++
    const name = (words[i] ?? '').split('/').at(-1)
    const rest = words.slice(i + 1)
    const operands = rest.filter((word) => !/^-/.test(word) && !/^\d*[<>]/.test(word))
    if (SHELLS.has(name) && depth < 3) {
      const inner = name === 'eval' ? rest.join(' ') : rest[rest.indexOf('-c') + 1]
      const dir = inner && (name === 'eval' || rest.includes('-c')) ? writesDataDir(inner, depth + 1) : null
      if (dir) return dir
    } else if (INLINE_CODE.test(name) && rest.some((word) => /^(?:-e|-p|-pe|-c|--eval|--print|-E)$/.test(word))) {
      // K11c.3 (B6): inline code is denied for a write form on a path in the directory — the bare word `CLAUDE_PLUGIN_DATA` is not one (the variable is not set in the Bash tool)
      const code = rest.filter((word) => !/^-/.test(word)).join('\n')
      const masked = code.replace(INLINE_READ_CALL, '')
      const named = dirs.find((dir) => masked.includes(dir)) ?? /plugins\/data\/stage-pipeline[\w.-]*/.exec(masked)?.[0]
      if (named && inlineWrites(masked)) return named
    } else if (WRITE_ANY_OPERAND.has(name) || (name === 'sed' && rest.some((word) => word === '--in-place' || /^-[A-Za-z]*i/.test(word)))) {
      // K11c.3 (B6): sed's script (the first operand, or the value of `-e` / `-f`) is text, not a path — only its file operands are judged
      const dir = firstNamed(name === 'sed' ? sedFiles(rest) : operands)
      if (dir) return dir
    } else if (name === 'mv') {
      const dir = firstNamed(operands)
      if (dir) return dir
    } else if (WRITE_COPIERS.has(name)) {
      const target = rest.find((word) => word.startsWith('--target-directory='))?.slice(18) ?? (rest.includes('-t') ? rest[rest.indexOf('-t') + 1] : operands.at(-1))
      const dir = target ? names(target) : null
      if (dir) return dir
    } else if (name === 'dd') {
      const dir = firstNamed(rest.filter((word) => word.startsWith('of=')))
      if (dir) return dir
    }
  }
  return null
}

/** The denial text for a call that writes into the plugin data directory in a force run. */
export const dataDirReason = (ticket, dir) =>
  `stage-pipeline: force run ${ticket} — the call writes into the plugin data directory (\`${dir}\`). The maker records, plan snapshots and receipts there are written by the hooks only; ` +
  'a record written by hand stands in for a stage-implement run that did not happen. A rejection is not a reason to look for a workaround (stage-force, Step 2): ' +
  'if the state there is wrong, put it into `Blockers:` of the Force run block and carry on with what does not depend on it.'

/** The texts of a data file in the main directory and in the legacy one, main first; a missing file is skipped. */
export function readDataFiles(dataDir, ...path) {
  return [dataDir, legacyDataDir(dataDir)].flatMap((dir) => {
    if (!dir) return []
    try {
      return [readFileSync(join(dir, ...path), 'utf8')]
    } catch {
      return []
    }
  })
}

/**
 * The records of a JSONL data file, oldest first (the legacy directory's lines before the main one's): only lines that parse to an object. A blank line, a broken one, `null`,
 * a number or an array is skipped, never a crash: the files under the plugin data directory are written by the hooks, but a line that is not an object must not take a hook down.
 */
export function readDataJsonl(dataDir, ...path) {
  return readDataFiles(dataDir, ...path)
    .reverse()
    .flatMap((text) => text.split('\n'))
    .flatMap((line) => {
      try {
        const record = line.trim() ? JSON.parse(line) : null
        return record && typeof record === 'object' && !Array.isArray(record) ? [record] : []
      } catch {
        return []
      }
    })
}

const registryPath = () => join(pluginDataDir(), 'task-dirs.json')

export function knownTaskDirs() {
  const dirs = readDataFiles(pluginDataDir(), 'task-dirs.json').flatMap((text) => {
    try {
      const list = JSON.parse(text)
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  })
  return [...new Set(dirs)].filter((dir) => typeof dir === 'string' && isDir(dir))
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
  const raw = config.match(/^[ \t]*-[ \t]*review_model:[ \t]*[`*]*([\w.-]+)/m)?.[1]
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
  const unreadDate = date === null && UNREAD_DATE.test(last[0])
  return { heading: last[0], date, unreadDate, body: end === -1 ? rest : rest.slice(0, end) }
}

// Something that looks like a date, not any digits and not a month-like word ("deck", "may need a rebase", "stages 4-6" are not dates):
// a year, d/m/y, d.m, "17 October", "17th of Oct", "Oct 17th", "Oct. 17", "Oct-17". "17-10" is not flagged: it is a range of stages as often as a date.
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const UNREAD_DATE = new RegExp(
  `\\b(?:19|20)\\d{2}\\b|\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b|\\b\\d{1,2}[/.]\\d{1,2}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?(?:\\s+of)?[\\s-]+${MONTH}\\b|\\b${MONTH}\\.?[\\s-]+\\d{1,2}(?:st|nd|rd|th)?\\b`,
  'i',
)

/**
 * The integration refs of a repo, `origin/` first: `main_branch` of the config, then dev, develop, development, main, master — the ones that exist.
 * Not only `main_branch`: in live configs it can be `main` with PRs into dev, and then other people's merged PRs would fall into "work bypassing the journal".
 */
export function integrationRefs(cwd, configText) {
  const configured = (configText ?? '').match(/^[ \t]*-[ \t]*main_branch:[ \t]*[`*]*([\w./-]+)/m)?.[1]
  const names = [...new Set([configured, 'dev', 'develop', 'development', 'main', 'master'].filter(Boolean))]
  return names.flatMap((name) => [`origin/${name}`, name]).filter((ref) => isCommit(cwd, ref))
}

/** The nearest integration ref to `ref` (the fewest commits `base..ref`; `origin/` wins a tie): `{ ref, ahead }`, or undefined when the repo has none. The one base rule of the hooks and of the retro. */
export function integrationBase(cwd, configText, ref) {
  return integrationRefs(cwd, configText)
    .map((base) => ({ ref: base, ahead: Number(git(cwd, 'rev-list', '--count', `${base}..${ref}`) ?? Infinity) }))
    .sort((a, b) => a.ahead - b.ahead)[0]
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
export function unjournaledCommits(state, task, { limit = 50, gate = null } = {}) {
  const cwd = state.worktree
  // The base is the nearest of the integration branches, not only `main_branch` (see `integrationBase`).
  if (!integrationRefs(cwd, state.config).length) return []
  const nearest = (ref) => integrationBase(cwd, state.config, ref)
  // Through the task file rule: a journal file that cannot be read knows no commit, so its commits are named (a warning, never a stall).
  const journal = ['STAGES.md', 'STAGES-ARCHIVE.md', 'PR.md']
    .map((name) => readTaskFile(task.dir, name))
    .filter((text) => text !== null)
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

  const titled = new Set()
  let ownCommits = []
  const closed = closedForceDate(task.stages)
  // The ticket-titled rule (0.18.0) is for runs opened after this plugin version first saw the task (`gate` — `releaseGate` of the task snapshot); without a gate it applies.
  const titledRule = closed && ruleAppliesToBlock(gate, freshestForceHeading(task.stages)?.[0] ?? '', closed)
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
    ownCommits = own
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
    // A revert of someone else's commit is not task follow-up. A commit that names the ticket stays: the squash of the task's PR carries "(#17)" and was dropped above,
    // anything else with the ticket in its title that lands after the close is exactly the work that bypassed the journal; only its SHA or its patch-id can clear it.
    for (const [sha, commit] of candidates) {
      if (before.has(sha)) continue
      if (/^Revert\s/.test(commit.subject) || (ticket.test(commit.subject) && !titledRule)) candidates.delete(sha)
      else if (ticket.test(commit.subject)) titled.add(sha)
    }
  }

  const left = [...candidates.values()].filter(({ sha, subject }) => !journal.includes(sha.slice(0, 7)) && (titled.has(sha) || !(subject.length >= 12 && journal.includes(subject))))
  if (!left.length) return []
  const journaled = new Set(patchIds(cwd, known).values())
  // A squash of the stage commits without "(#N)" (GitLab: "Feat(KC-1): …") has the patch of their combined diff.
  const combined = combinedPatchId(cwd, ownCommits)
  if (combined) journaled.add(combined)
  const ids = patchIds(cwd, left.map(({ sha }) => sha))
  return left.filter(({ sha }) => !journaled.has(ids.get(sha)))
}

/** The closing date of the last force run — from a "completed …" heading or a status line; null — not closed. */
export function closedForceDate(stages) {
  const heading = freshestForceHeading(stages)?.[0]
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

// The patch-id of the combined diff of the task's own commits: from the parent of the oldest to the newest one.
function combinedPatchId(cwd, own) {
  if (!own?.length) return null
  const sorted = [...own].sort((a, b) => a.time - b.time)
  const first = sorted[0].sha
  const last = sorted[sorted.length - 1].sha
  if (!isCommit(cwd, `${first}^`)) return null
  const diff = gitInput(cwd, '', 'diff', '--no-color', '--no-ext-diff', `${first}^`, last)
  if (!diff) return null
  return gitInput(cwd, diff, 'patch-id', '--stable').split(' ')[0] || null
}

export function patchIds(cwd, shas) {
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
  const raw = config.match(/^[ \t]*-[ \t]*task_path:[ \t]*(.+)$/m)?.[1]
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
  // local goes over shared: a field missing in local is taken from the shared config. A config over CONFIG_FILE_MAX is read up to its first CONFIG_FILE_MAX bytes (every key the hooks read sits at the top).
  return [local, shared].map((path) => readConfigPart(path).text ?? null).filter((text) => text !== null).join('\n')
}

/** The configs that are over CONFIG_FILE_MAX: `{ path, size, max }` each. They are read in part, and session-start says so. */
export function oversizeConfigs(root) {
  return ['.claude/pipeline.config.local.md', '.claude/pipeline.config.md'].map((name) => join(root, name)).flatMap((path) => {
    const { size } = readConfigPart(path)
    return size === undefined ? [] : [{ path, size, max: CONFIG_FILE_MAX }]
  })
}

/** A pointer or a small file's text, or null: a regular file (a link to one is followed) of at most CONFIG_FILE_MAX bytes. */
const readConfigFile = (path) => readBounded(path, { max: CONFIG_FILE_MAX }).text ?? null

/**
 * A config file: `{ text }` of a regular file (a link to one is followed); of one over CONFIG_FILE_MAX bytes the first CONFIG_FILE_MAX bytes with its `size`; `{}` for a file
 * that is not there, not a regular file or cannot be opened. Presence is `isFile`, so a config is never silently empty: it is read in part, and the size is kept.
 */
function readConfigPart(path) {
  const read = readBounded(path, { max: CONFIG_FILE_MAX })
  if (read.problem !== 'too-large') return read
  let fd
  try {
    fd = openSync(realpathSync(path), 'r')
    const buffer = Buffer.alloc(CONFIG_FILE_MAX)
    const got = readSync(fd, buffer, 0, CONFIG_FILE_MAX, 0)
    return { text: buffer.toString('utf8', 0, got), size: read.size }
  } catch {
    return {}
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Task branches — from the `Branch:`/`Branches:` line in the STAGES.md header: names in backticks,
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

/** A stage heading that is not finished. Live forms: `[status: in-progress]`, `[status: in-progress — waiting for user-review]`, `[status: in progress; …]`; group 1 is `todo` or `in-progress` / `in progress`. */
export const OPEN_STATUS = /\[status:\s*(todo|in[-\s]progress)\b/i
const DAY = 24 * 60 * 60 * 1000
export const STALE_DAYS = 21
export const AFTER_CLOSE_DAYS = 14
/** Task files larger than this are not read: a STAGES.md or a report is kilobytes, a symlink to a device or a runaway file would stall every hook. */
export const TASK_FILE_MAX = 4 * 1024 * 1024
/** Config files (and the `.git` / `commondir` pointers) larger than this are not read: a config is a few kilobytes. */
export const CONFIG_FILE_MAX = 256 * 1024

/**
 * The one bounded reader for files a hook takes from a repo: `{ text }`, or `{ problem, size?, max? }` and no text. Only a regular file (a link is followed to its target)
 * of at most `max` bytes; with `within`, only when the real path of the file — every component resolved — lies inside the real `within` directory.
 * `problem`: `missing` (nothing there, or a dangling link), `outside`, `not-file` (a directory, a device, a FIFO), `too-large`, `unreadable` (no permission).
 * Precedents: a committed `STAGES-ARCHIVE.md -> /dev/random` made every hook read until it was killed; a link to a 963 MB system file cost 1.5–2 GB and an exit 1
 * on every Bash call; a `checks/` directory linked to another project put that project's report into the run digest.
 */
export function readBounded(path, { max = TASK_FILE_MAX, within = null } = {}) {
  let real
  try {
    real = realpathSync(path)
  } catch (error) {
    return { problem: error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing' : 'unreadable' }
  }
  if (within !== null) {
    const base = realPath(within)
    if (!base) return { problem: 'missing' }
    if (!real.startsWith(base.endsWith(sep) ? base : base + sep)) return { problem: 'outside' }
  }
  let stat
  try {
    stat = statSync(real)
  } catch {
    return { problem: 'unreadable' }
  }
  if (!stat.isFile()) return { problem: 'not-file' }
  if (stat.size > max) return { problem: 'too-large', size: stat.size, max }
  try {
    return { text: readFileSync(real, 'utf8') }
  } catch {
    return { problem: 'unreadable' }
  }
}

/** A file of a task directory through `readBounded`: inside the real task directory, at most TASK_FILE_MAX bytes. The task directory itself may sit behind a symlink (`.claude/tasks` → `~/.claude/team-tasks`). */
export const taskFile = (taskDir, ...segments) => readBounded(join(taskDir, ...segments), { within: taskDir })

/** The text of a task file, or null (missing or refused: see `taskFile` for why). */
export const readTaskFile = (taskDir, ...segments) => taskFile(taskDir, ...segments).text ?? null

const megabytes = (bytes) => `${Number((bytes / 1024 / 1024).toFixed(2))} MB`
/** What a refused task file says: the file, why it is refused (the size and the limit), and that its rules count it as open. `file` is as the message shows it (`STAGES.md`, `checks/x.md`). */
export function unreadableMessage(file, { problem, size, max = TASK_FILE_MAX }) {
  const why = {
    'too-large': `it is ${megabytes(size)}, over the ${megabytes(max)} limit of a task file`,
    outside: 'its real path is outside the task directory (a symlink in the path)',
    'not-file': 'it is not a regular file',
    unreadable: 'it cannot be opened',
  }[problem]
  const fix = file === 'STAGES.md' ? 'fold the closed stages (archive-stages.mjs) or move the pasted text out of it' : 'move the pasted log or dump out of it'
  return `${file} cannot be read: ${why}. The rules cannot run on it, so it counts as open — ${problem === 'outside' ? 'put the file itself in the task directory' : fix}.`
}

/** The reports of a task: regular `.md` files in `checks/` (a symlink or a directory named `*.md` is not a report). Here, not in journal-check, so journal-gate stamps them without loading the rules. */
export function reportNames(taskDir) {
  try {
    return readdirSync(join(taskDir, 'checks'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * The repo root with the pipeline config. In a worktree `.claude/` may be uncommitted
 * (excluded via .git/info/exclude) — then the config is looked for in the main working tree.
 */
export function configRoot(cwd, worktree) {
  if (isFile(join(worktree, '.claude/pipeline.config.md'))) return worktree
  const main = mainRoot(cwd)
  return main && main !== worktree && isFile(join(main, '.claude/pipeline.config.md')) ? main : null
}

// The main working tree: for a worktree `webview-abc12` the repo is still called `webview`.
export function mainRoot(cwd) {
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  return common && basename(common) === '.git' ? dirname(common) : null
}

/**
 * Whether `readPipelineState` can find a config from here — from the file system alone, without spawning git: the hooks of every Bash call in every repo
 * ask this first and leave at once outside the pipeline. Walks up to the repository root (the first `.git`) and, in a linked worktree, reads its `.git` file
 * to check the main tree as `configRoot` does. A config above the repo root says "maybe" — `readPipelineState` decides; never "no" where it would find one.
 */
export function hasPipelineConfig(cwd) {
  let dir = resolve(cwd)
  for (;;) {
    if (isFile(join(dir, '.claude/pipeline.config.md'))) return true
    const dotGit = join(dir, '.git')
    if (isDir(dotGit)) return false
    if (isFile(dotGit)) {
      // Both are one-line pointers: read bounded, as a config is.
      const pointer = readConfigFile(dotGit)
      const gitDir = resolve(dir, pointer?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim() ?? '')
      const commondir = pointer === null ? null : readConfigFile(join(gitDir, 'commondir'))
      // a submodule or a broken link: no main tree to look at, as in configRoot
      if (commondir === null) return false
      const common = resolve(gitDir, commondir.trim())
      return basename(common) === '.git' && isFile(join(dirname(common), '.claude/pipeline.config.md'))
    }
    const up = dirname(dir)
    if (up === dir) return false
    dir = up
  }
}

/**
 * The "Dev server" section of the config: `url`, `verify_routes:` (comma separated, each `^/\S*$`) and `app_marker:` (one line); the local config overrides the shared one.
 * The key names are specific on purpose: `routes:` / `marker:` already mean something else in live configs (a path to a routes file). Values that do not fit are ignored and noted.
 * `null` — no config at `root`.
 */
export function devServerConfig(root) {
  if (!root) return null
  const texts = ['pipeline.config.md', 'pipeline.config.local.md'].map((name) => readConfigFile(join(root, '.claude', name))).filter((text) => text !== null)
  return texts.length ? parseDevServer(texts) : null
}

/** The fields of the "Dev server" sections of the config texts, the later text over the earlier one. Line by line: no regexp runs across lines or backtracks on a long one. */
export function parseDevServer(texts) {
  const found = { url: undefined, routes: [], marker: undefined, notes: [] }
  for (const text of texts) {
    let inSection = false
    for (const line of text.split('\n')) {
      if (/^##[ \t]/.test(line)) {
        inSection = /^##[ \t]+Dev server/i.test(line)
        continue
      }
      if (!inSection) continue
      const field = line.match(/^[ \t]*-[ \t]*(url|verify_routes|app_marker)[ \t]*:(.*)$/i)
      if (!field) continue
      const key = field[1].toLowerCase()
      const value = field[2].split(/\s#/)[0].trim().replace(/^`|`$/g, '').trim()
      if (!value || value === '—') continue
      if (key === 'url') found.url = value
      else if (key === 'app_marker') found.marker = value
      else {
        const items = value.split(',').map((item) => item.trim().replace(/^`|`$/g, '')).filter(Boolean)
        const good = items.filter((item) => /^\/\S*$/.test(item))
        if (good.length !== items.length) found.notes.push(`verify_routes: ${items.length - good.length} value(s) are not a /path`)
        if (good.length) found.routes = good
      }
    }
  }
  return found
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

function statOf(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

export { readHookInput } from './hook-input.mjs'
