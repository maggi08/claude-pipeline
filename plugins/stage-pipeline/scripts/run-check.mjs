#!/usr/bin/env node
/**
 * A heavy stage check (lint / test / type_check / build) — scoped by the diff and without fighting for the machine's resources.
 *
 *   node run-check.mjs -- yarn eslint {files}             # only changed code files; if there are none — skipped
 *   node run-check.mjs -- yarn vitest related --run {files:ts+tsx+vue}
 *   node run-check.mjs -- yarn type-check                 # without {files} — the command as is
 *   node run-check.mjs -- docker compose run --rm app pytest {files:rel+py}   # repo-relative paths: the container sees the repo elsewhere (`/app`)
 *   node run-check.mjs --base origin/dev -- yarn eslint {files}   # changed over the branch, not only in the working tree
 *   node run-check.mjs --mode                             # low | normal and why
 *
 * Commands from the config run over the whole repository: at a stage that is minutes of CPU and gigabytes of memory, and on a weak machine
 * or with 3–4 parallel projects there is also competition for them. The script does three things:
 * - `{files}` — changed and new code files against HEAD (or the merge-base with `--base`) as absolute paths;
 *   `{files:ts+vue}` — only these extensions (joined with `+`: a comma in braces would be expanded by the shell);
 *   the token `rel` among them (`{files:rel}`, `{files:rel+py}`) — paths relative to the repo root instead of absolute ones.
 *   No files — the command is not run, code 0.
 * - `low` mode (`resources: low` in pipeline.config.local.md, otherwise automatically at RAM ≤ 16 GB) — a command of any project is admitted by
 *   the machine's memory (heavy-queue.mjs): it starts at once while the expected memory fits, otherwise it waits (at most 5 minutes) and the task
 *   with the higher priority goes first; at least one command always runs. `nice` by the task's place goes in both modes.
 * - the time and exit code in the last line — for the stage journal.
 * - the whole command (without `{files}` and `--base`) on a clean tree — the result is written by the commit tree:
 *   by it the force-run closing hook sees whether the CI gates are green on the current HEAD (`ci-gates.mjs`).
 * Exit code is the command's code; 2 — the script itself could not run (not a git repo, no command).
 */
import { execFileSync, spawn } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { UNRECORDED, isGateCommand, recordGate, shellQuote, treeState } from './ci-gates.mjs'
import { configRoot, pathList, pluginDataDir, readConfig, worktreeTwinDataDir } from './hooks/pipeline-state.mjs'
import { FILES_PLACEHOLDER } from './markers.mjs'
import { admit, dropEntries, recordSessionTask, resourceMode, taskInfo } from './heavy-queue.mjs'

const args = process.argv.slice(2)
const baseIndex = args.indexOf('--base')
const base = baseIndex === -1 ? null : args[baseIndex + 1]
const separator = args.indexOf('--')
// A single argument after `--` is a ready shell string (`'a && b'`); several are an argv from which the caller's shell has already removed
// the quotes: each word is escaped again, otherwise `'%s|'` or `'a|b'` would turn into a pipeline.
const rest = separator === -1 ? [] : args.slice(separator + 1)
const command = rest.length === 1 ? rest[0] : rest.map((word) => (/^[\w@%+=:,./{}-]+$/.test(word) ? word : shellQuote(word))).join(' ')

const git = (...cmd) => execFileSync('git', ['-c', 'core.quotePath=false', ...cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
let root
try {
  root = git('rev-parse', '--show-toplevel').trim()
} catch {
  fail('not a git repository')
}

const mode = resourceMode(root)
if (args.includes('--mode')) {
  console.log(`${mode.name} — ${mode.why}`)
  process.exit(0)
}
if (!command) fail('no command: node run-check.mjs [--base <ref>] -- <a command with or without {files}>')
// A wrapper only for checks: git inside it is not seen by the git-guard hook, which looks at the whole command.
if (/(^|[;&|(]\s*|\s)git\s/.test(` ${command}`)) fail('run-check is only for checks (lint/test/type_check/build); run git commands directly')

const CODE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|astro|py|go|rb|kt|swift|java|php|rs|cs)$/
const SKIP_PATH = /(^|\/)(node_modules|dist|build|\.next|\.nuxt|\.output|coverage|vendor|__generated__)\//
const placeholder = command.match(FILES_PLACEHOLDER)
let finalCommand = command
if (placeholder) {
  const tokens = placeholder[1]?.split('+').map((ext) => ext.replace(/^\./, ''))
  const relative = Boolean(tokens?.includes('rel'))
  const extensions = tokens?.filter((token) => token !== 'rel')
  const matches = extensions?.length ? (path) => extensions.some((ext) => path.endsWith(`.${ext}`)) : (path) => CODE.test(path)
  const files = changedFiles().filter((path) => matches(path) && !SKIP_PATH.test(path))
  if (!files.length) {
    console.log(`run-check: no changed files for "${command}" — skipped`)
    process.exit(0)
  }
  finalCommand = command.replace(placeholder[0], files.map((path) => shellQuote(relative ? path : join(root, path))).join(' '))
  console.log(`run-check: ${mode.name} · ${files.length} changed files · ${command}`)
} else {
  console.log(`run-check: ${mode.name} · ${command}`)
}

// The signals are taken before the wait for admission: a kill during it leaves no waiting entry. A command stopped by the pause is continued first,
// otherwise the signal stays pending on a stopped orphan; a run cut short by a signal does not write its (partial) peak.
let slot = null
let child = null
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }
for (const [signal, number] of Object.entries(SIGNALS)) {
  process.on(signal, () => {
    if (slot) {
      slot.terminate(child, signal)
      settle({ record: false })
    } else safely(dropEntries)
    process.exit(128 + number)
  })
}
// The machine's files (the lock and the data directories) may be unwritable (read-only, a full disk): the balancer is a courtesy, so the command then starts without admission.
const place = taskInfo(process.cwd())
safely(() => recordSessionTask(place)) // the session ↔ task pair: this folder's task for the Claude session above (the tracker and the browser hook read it)
try {
  // the peak is kept under the config root, not the worktree: every worktree of the repo shares what the command needed
  slot = await admit({ cwd: process.cwd(), repo: taskInfo(root).root, command, mode })
} catch (error) {
  safely(dropEntries)
  console.log(`balance: admission unavailable (${error?.code ?? error?.message ?? 'error'}), starting without admission`)
  slot = { key: place.key, nice: null, watch() {}, unstop() {}, terminate: (proc, signal) => proc?.kill(signal), finish() {} }
}
const started = Date.now()
// A run of the whole repo on a clean tree is evidence for the CI gates; a run by diff or with edits in progress is not.
const whole = !placeholder && !base
const before = whole ? treeState(root) : null
// `nice` by the task's place in priorities.json (10 for place 1, +1 per place, at most 19), in both modes: it works only while the cores are busy.
child = spawn('/bin/sh', ['-c', slot.nice === null ? finalCommand : `nice -n ${slot.nice} /bin/sh -c ${shellQuote(finalCommand)}`], { stdio: 'inherit' })
safely(() => slot.watch(child))
// A linked worktree whose `.claude/` is excluded reads the main tree's config, the way the hooks find it.
const isGate = () => isGateCommand(readConfig(configRoot(root, root) ?? root), command)
child.on('exit', (code, signal) => {
  settle({ record: signal === null && code === 0 }) // a failed run often stops early: its partial peak would lower the recorded one
  const seconds = ((Date.now() - started) / 1000).toFixed(0)
  console.log(`run-check: code ${code ?? signal} in ${seconds} s`)
  if (before?.clean && before.tree) {
    const after = treeState(root)
    if (after.clean && after.tree === before.tree) {
      recordGate(pluginDataDir(), root, command, code ?? 1, before.tree)
      // 0.29.3: this copy lies in a linked worktree of an installed marketplace repo — the sessions that run the installed plugin read the other directory
      const twin = worktreeTwinDataDir()
      if (twin) {
        recordGate(twin, root, command, code ?? 1, before.tree)
        if (isGate()) console.log(`run-check: recorded in ${pluginDataDir()} and ${twin} — this copy of the scripts lies in a linked worktree of the installed plugin's repo`)
      }
    }
    else if (isGate()) console.log('run-check: not recorded for the CI gates — tracked files or HEAD changed during the run')
  } else if (before?.dirty?.length && isGate()) {
    // Said only for a gate: a whole type_check of an uncommitted stage is not one, and the line would be noise there.
    console.log(`run-check: not recorded for the CI gates — tracked files differ from HEAD (${pathList(before.dirty)}); ${UNRECORDED}`)
  }
  process.exit(code ?? 1)
})

/** `finish` of the slot that never changes the command's result: its files may not be writable. */
function settle(options) {
  safely(() => slot.finish(options))
}

function safely(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/** Changed and new files (without deleted ones) against HEAD or the merge-base with `--base`, from the repo root. */
function changedFiles() {
  let against = 'HEAD'
  if (base) {
    try {
      against = git('merge-base', base, 'HEAD').trim()
    } catch {
      fail(`no merge-base with ${base}`)
    }
  }
  const tracked = git('diff', '--name-only', '--diff-filter=ACMR', '--no-renames', '-z', against, '--').split('\0')
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0')
  return [...new Set([...tracked, ...untracked])].filter((path) => path && isFile(join(root, path)))
}

function isFile(path) {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

function fail(message) {
  console.error(`run-check: ${message}`)
  process.exit(2)
}
