#!/usr/bin/env node
/**
 * Vendors the human-text plugin into stage-pipeline: the skill and the check agent are copied from the
 * human-text repo (the source of truth) and pinned in plugins/stage-pipeline/human-text.lock.json.
 *
 *   node scripts/sync-human-text.mjs                  # ../human-text, working tree
 *   node scripts/sync-human-text.mjs /path/to/human-text
 *   node scripts/sync-human-text.mjs v0.1.0           # a git ref (tag, branch, SHA) of ../human-text
 *   node scripts/sync-human-text.mjs --repo /path/to/human-text v0.1.0
 *
 * Only the plugin files travel: skills/human-text/** and agents/human-text-check.md. The README, CHANGELOG,
 * scripts and .github of the source stay there. The lock records the source commit and the sha256 of every
 * vendored file; scripts/validate.mjs fails when a vendored file no longer matches it, so an edit goes to the
 * human-text repo first and is brought here by this script. A second run over an unchanged source changes nothing.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(ROOT, 'plugins/stage-pipeline')
const LOCK = join(PLUGIN, 'human-text.lock.json')
// What is vendored, relative to the plugin root (both in the source repo and here).
const SKILL_DIR = 'skills/human-text'
const AGENT_FILE = 'agents/human-text-check.md'
const SOURCE_NAME = 'maggi08/human-text'

// fail() throws: the cleanup in finally runs, and the top-level handler prints the message and exits 1.
class SyncError extends Error {}
const fail = (message) => {
  throw new SyncError(message)
}
process.on('uncaughtException', (error) => {
  if (!(error instanceof SyncError)) throw error
  console.error(`✘ ${error.message}`)
  process.exit(1)
})
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** The vendored files, relative to the source root. Only tracked files travel; a link or any non-regular file is refused. */
function listSourceFiles(root, names) {
  const files = names.filter((rel) => existsSync(join(root, rel)) || isLink(join(root, rel)))
  for (const rel of files) {
    const kind = lstatSync(join(root, rel))
    if (kind.isSymbolicLink()) fail(`${rel} is a symbolic link — a link in the source could pull in files from outside it; replace it with a regular file`)
    if (!kind.isFile()) fail(`${rel} is not a regular file`)
  }
  return files
}
function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function parseArgs(argv) {
  const result = { repo: null, target: null, allowDirty: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') result.repo = argv[++i]
    else if (argv[i] === '--allow-dirty') result.allowDirty = true
    else if (result.target) fail(`unexpected argument ${argv[i]}`)
    else result.target = argv[i]
  }
  return result
}

const args = parseArgs(process.argv.slice(2))
const defaultRepo = resolve(ROOT, '../human-text')
// A target that is a directory is a local checkout; anything else is a git ref of the default (or --repo) checkout.
const targetIsDir = args.target && existsSync(resolve(args.target)) && statSync(resolve(args.target)).isDirectory()
const repo = resolve(targetIsDir ? args.target : args.repo ?? defaultRepo)
const ref = targetIsDir ? null : args.target
if (!existsSync(join(repo, '.git'))) fail(`${repo} is not a git checkout of the human-text repo (pass its path, or --repo <path> with a ref)`)

let sourceRoot = repo
let temp = null
let staging = null
let sha
try {
  if (ref) {
    if (ref.startsWith('-')) fail(`«${ref}» is not a git ref (a ref cannot start with «-»)`)
    try {
      sha = git(repo, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`)
    } catch {
      fail(`ref «${ref}» not found in ${repo}`)
    }
    // A tree entry with mode 120000 is a symlink (git archive would write it as one): refuse before extracting.
    const links = git(repo, 'ls-tree', '-r', sha, '--', SKILL_DIR, AGENT_FILE).split('\n').filter((line) => line.startsWith('120000 '))
    if (links.length) fail(`symbolic links in ${ref} (${sha.slice(0, 7)}): ${links.map((line) => line.split('\t')[1]).join(', ')}`)
    temp = mkdtempSync(join(tmpdir(), 'human-text-sync-'))
    // Two separate steps, so that the exit code of git archive is not lost behind a pipe.
    const tarball = join(temp, 'source.tar')
    const extracted = join(temp, 'tree')
    mkdirSync(extracted)
    try {
      execFileSync('git', ['archive', '-o', tarball, sha, '--', SKILL_DIR, AGENT_FILE, '.claude-plugin/plugin.json'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
      execFileSync('tar', ['-xf', tarball, '-C', extracted], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      fail(`could not export ${ref} (${sha.slice(0, 7)}): ${String(error.stderr ?? error.message).trim()}`)
    }
    sourceRoot = extracted
  } else {
    sha = git(repo, 'rev-parse', 'HEAD')
    // The lock names a commit, so the files must be that commit's files: a dirty tree would make the lock lie.
    const dirty = git(repo, 'status', '--porcelain', '--', SKILL_DIR, AGENT_FILE)
    if (dirty && !args.allowDirty) fail(`uncommitted changes in ${repo}:\n${dirty}\nCommit them in the human-text repo first (or pass --allow-dirty for a trial run — the lock would then not match the commit).`)
  }

  // Working-tree mode: the tracked files of the source (git ls-files), never a walk of the disk — ignored files
  // (.DS_Store, logs) are not in the commit the lock names. With --allow-dirty, untracked non-ignored files join them.
  // Ref mode: the exported tree holds tracked files only.
  const listed = ref
    ? git(repo, 'ls-tree', '-r', '--name-only', '-z', sha, '--', SKILL_DIR, AGENT_FILE)
    : git(repo, 'ls-files', '-z', ...(args.allowDirty ? ['--cached', '--others', '--exclude-standard'] : []), '--', SKILL_DIR, AGENT_FILE)
  const sourceFiles = listSourceFiles(sourceRoot, listed.split('\0').filter(Boolean).sort())
  if (!sourceFiles.includes(`${SKILL_DIR}/SKILL.md`)) fail(`${SKILL_DIR}/SKILL.md not found in the source`)
  if (!sourceFiles.includes(AGENT_FILE)) fail(`${AGENT_FILE} not found in the source`)

  // Build the new copy next to the old one, then swap: a failure while copying leaves the plugin as it was.
  // Stale vendored files (removed in the source) go away with the old directory: it is replaced, not merged.
  staging = mkdtempSync(join(PLUGIN, '.human-text-staging-'))
  for (const rel of sourceFiles) {
    mkdirSync(dirname(join(staging, rel)), { recursive: true })
    cpSync(join(sourceRoot, rel), join(staging, rel))
  }
  const backup = join(staging, '.old-skill')
  const hadSkill = existsSync(join(PLUGIN, SKILL_DIR))
  try {
    if (hadSkill) renameSync(join(PLUGIN, SKILL_DIR), backup)
    mkdirSync(dirname(join(PLUGIN, SKILL_DIR)), { recursive: true })
    renameSync(join(staging, SKILL_DIR), join(PLUGIN, SKILL_DIR))
    mkdirSync(dirname(join(PLUGIN, AGENT_FILE)), { recursive: true })
    renameSync(join(staging, AGENT_FILE), join(PLUGIN, AGENT_FILE))
  } catch (error) {
    if (hadSkill) {
      rmSync(join(PLUGIN, SKILL_DIR), { recursive: true, force: true })
      renameSync(backup, join(PLUGIN, SKILL_DIR))
    }
    throw error
  }

  const manifestPath = join(sourceRoot, '.claude-plugin/plugin.json')
  const version = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).version ?? null : null
  const files = Object.fromEntries([...sourceFiles].sort().map((rel) => [rel, sha256(join(PLUGIN, rel))]))
  const lock = { source: SOURCE_NAME, ref: sha, version, files }
  writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`)
  console.log(`✔ human-text ${version ?? '?'} @ ${sha.slice(0, 7)}: ${sourceFiles.length} files → plugins/stage-pipeline, lock written`)
} finally {
  if (temp) rmSync(temp, { recursive: true, force: true })
  if (staging) rmSync(staging, { recursive: true, force: true })
}
