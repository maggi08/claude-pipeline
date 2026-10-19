#!/usr/bin/env node
/**
 * A heavy stage check (lint / test / type_check / build) — scoped by the diff and without fighting for the machine's resources.
 *
 *   node run-check.mjs -- yarn eslint {files}             # only changed code files; if there are none — skipped
 *   node run-check.mjs -- yarn vitest related --run {files:ts+tsx+vue}
 *   node run-check.mjs -- yarn type-check                 # without {files} — the command as is
 *   node run-check.mjs --base origin/dev -- yarn eslint {files}   # changed over the branch, not only in the working tree
 *   node run-check.mjs --mode                             # low | normal and why
 *
 * Commands from the config run over the whole repository: at a stage that is minutes of CPU and gigabytes of memory, and on a weak machine
 * or with 3–4 parallel projects there is also competition for them. The script does three things:
 * - `{files}` — changed and new code files against HEAD (or the merge-base with `--base`) as absolute paths;
 *   `{files:ts+vue}` — only these extensions (joined with `+`: a comma in braces would be expanded by the shell).
 *   No files — the command is not run, code 0.
 * - `low` mode (`resources: low` in pipeline.config.local.md, otherwise automatically at RAM ≤ 16 GB) — runs
 *   of all the machine's projects go one by one through a shared lock and at a lower priority (`nice`): two type
 *   checks at once on 8 GB are swap, not parallelism.
 * - the time and exit code in the last line — for the stage journal.
 * - the whole command (without `{files}` and `--base`) on a clean tree — the result is written by the commit tree:
 *   by it the force-run closing hook sees whether the CI gates are green on the current HEAD (`ci-gates.mjs`).
 * Exit code is the command's code; 2 — the script itself could not run (not a git repo, no command).
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { join } from 'node:path'
import { recordGate, treeState } from './ci-gates.mjs'
import { pluginDataDir, readConfig } from './hooks/pipeline-state.mjs'

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

const mode = resourceMode()
if (args.includes('--mode')) {
  console.log(`${mode.name} — ${mode.why}`)
  process.exit(0)
}
if (!command) fail('no command: node run-check.mjs [--base <ref>] -- <a command with or without {files}>')
// A wrapper only for checks: git inside it is not seen by the git-guard hook, which looks at the whole command.
if (/(^|[;&|(]\s*|\s)git\s/.test(` ${command}`)) fail('run-check is only for checks (lint/test/type_check/build); run git commands directly')

const CODE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|astro|py|go|rb|kt|swift|java|php|rs|cs)$/
const SKIP_PATH = /(^|\/)(node_modules|dist|build|\.next|\.nuxt|\.output|coverage|vendor|__generated__)\//
const placeholder = command.match(/\{files(?::([\w+.]+))?\}/)
let finalCommand = command
if (placeholder) {
  const extensions = placeholder[1]?.split('+').map((ext) => ext.replace(/^\./, ''))
  const matches = extensions ? (path) => extensions.some((ext) => path.endsWith(`.${ext}`)) : (path) => CODE.test(path)
  const files = changedFiles().filter((path) => matches(path) && !SKIP_PATH.test(path))
  if (!files.length) {
    console.log(`run-check: no changed files for "${command}" — skipped`)
    process.exit(0)
  }
  finalCommand = command.replace(placeholder[0], files.map((path) => shellQuote(join(root, path))).join(' '))
  console.log(`run-check: ${mode.name} · ${files.length} changed files · ${command}`)
} else {
  console.log(`run-check: ${mode.name} · ${command}`)
}

const release = mode.name === 'low' ? await acquireLock() : () => {}
const started = Date.now()
// A run of the whole repo on a clean tree is evidence for the CI gates; a run by diff or with edits in progress is not.
const whole = !placeholder && !base
const before = whole ? treeState(root) : null
const lowPriority = mode.name === 'low' && process.platform !== 'win32'
const child = spawn('/bin/sh', ['-c', lowPriority ? `nice -n 10 /bin/sh -c ${shellQuote(finalCommand)}` : finalCommand], { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal)
    release()
    process.exit(130)
  })
}
child.on('exit', (code, signal) => {
  release()
  const seconds = ((Date.now() - started) / 1000).toFixed(0)
  console.log(`run-check: code ${code ?? signal} in ${seconds} s`)
  if (before?.clean && before.tree) {
    const after = treeState(root)
    if (after.clean && after.tree === before.tree) recordGate(pluginDataDir(), root, command, code ?? 1, before.tree)
  }
  process.exit(code ?? 1)
})

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

/**
 * `resources:` from pipeline.config.local.md / pipeline.config.md (the machine's layout goes in local), otherwise by memory:
 * at 16 GB and less the dev server, browser, IDE and Claude Code already share memory, and a second heavy check is swap.
 */
function resourceMode() {
  const override = process.env.STAGE_PIPELINE_RESOURCES
  if (override === 'low' || override === 'normal') return { name: override, why: 'STAGE_PIPELINE_RESOURCES' }
  const configured = readConfig(root).match(/^\s*-\s*resources:\s*`?(low|normal)\b/m)?.[1]
  if (configured) return { name: configured, why: 'resources in pipeline.config' }
  const gb = Math.round(totalmem() / 1024 ** 3)
  return gb <= 16 ? { name: 'low', why: `${gb} GB RAM (≤ 16) — heavy checks one by one` } : { name: 'normal', why: `${gb} GB RAM` }
}

/**
 * A lock per machine, not per repo: the queue is needed exactly between projects. The directory is created atomically;
 * if the owner is dead or holds the lock for more than 30 minutes, the lock is taken over. We wait at most 20 minutes, then go without a queue.
 */
async function acquireLock() {
  const dir = process.env.STAGE_PIPELINE_LOCK_DIR ?? join(homedir(), '.claude', 'stage-pipeline')
  const lock = join(dir, 'heavy.lock')
  mkdirSync(dir, { recursive: true })
  const deadline = Date.now() + 20 * 60 * 1000
  let announced = false
  while (Date.now() < deadline) {
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, repo: root, command, started: Date.now() }))
      return () => rmSync(lock, { recursive: true, force: true })
    } catch (error) {
      if (error.code !== 'EEXIST') return () => {}
    }
    const owner = readOwner(lock)
    if (!owner || !alive(owner.pid) || Date.now() - owner.started > 30 * 60 * 1000) {
      rmSync(lock, { recursive: true, force: true })
      continue
    }
    if (!announced) {
      console.log(`run-check: waiting in the queue — ${owner.repo}: ${owner.command}`)
      announced = true
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  console.log('run-check: the queue did not clear in 20 minutes — running without it')
  return () => {}
}

function readOwner(lock) {
  try {
    return JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))
  } catch {
    // The directory was just created, owner.json is still being written — count it as busy if the directory is fresh.
    try {
      return Date.now() - lstatSync(lock).mtimeMs < 5000 ? { pid: process.pid, repo: '?', command: '?', started: Date.now() } : null
    } catch {
      return null
    }
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function isFile(path) {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

function shellQuote(text) {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

function fail(message) {
  console.error(`run-check: ${message}`)
  process.exit(2)
}
