/**
 * Maker receipts (VT-1 stage 11, VT-5 lane): proof that the code of a force run was written by `stage-implement`, and the hand-back contract as a post-condition.
 *
 * The 0.11 audit found the orchestrator writing code itself five times, hand-backs of 16-18k characters, and maker items that reach the journal only if the
 * orchestrator copies them. Prose did not hold any of it, so three hooks share this module:
 *
 *  - agent-guard, at the spawn of `stage-implement` (implement and fix mode): `takeSnapshot` records the repo root, HEAD, the branch and the blob of every dirty
 *    or untracked path under `<plugin data>/maker/spawn/<session>.json` (K11.1);
 *  - maker-guard, at the SubagentStop of `stage-implement`: the hand-back must carry its sections, fit `HANDBACK_MAX` characters and name exactly the files
 *    that changed since the spawn (K11.2, K11.3); it blocks at most `MAX_BLOCKS` times per agent, then lets the stop go with a "hand-back not fixed" item (K11.4).
 *    A stop that goes through stores the post-run blobs and the items under `<plugin data>/maker/<TICKET>.jsonl` (K11.6);
 *  - git-guard, at a force commit: `commitMakerVerdict` denies a code path whose blob is not the last one a maker stop recorded (K11.5).
 *
 * The rules apply only to a Force block that is new by two first-sight gates (`makerRun`, D7): the 0.18 receipts gate (`receiptRun`) and stage 10's plan snapshot
 * (`plan-check.mjs`, `takePlanSnapshot`): a Force block the snapshot saw when this version first looked at the plan belongs to a run already going, and keeps the rules
 * it started with. Beyond the gate every rule fails open where the record is missing: a repo with no spawn snapshot in the run, a run whose spawns left no stop record
 * (a session that loaded hooks.json before the release has no maker-guard), a session with no spawn snapshot, a spawn whose snapshot did not finish (K11a.5).
 * The records are written by the hooks only (K11a.1): a line of a data file that is not an object is skipped, and force-guard denies a Bash command that names the data directory.
 * A maker that died before its stop leaves its baseline open for the ticket (`maker/open/<ticket>.json`); the next spawn on the same HEAD starts from it, so the
 * continuation's change set holds the dead maker's files too. A task over two repos snapshots the cwd repo and the sibling repos the config names (`others`).
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute, resolve, sep } from 'node:path'
import { readDataFiles, readDataJsonl } from './hooks/pipeline-state.mjs'
import { forceKey } from './markers.mjs'
import { siblingRepos, takePlanSnapshot } from './plan-check.mjs'
import { receiptRun } from './receipts.mjs'

/** A7 of VT-5: the hand-back limit, in characters. */
export const HANDBACK_MAX = 4000
/** K11.4: well under Claude Code's own cap of 8 continuations. */
export const MAX_BLOCKS = 3
const DIRTY_MAX = 4000
const ITEM_MAX = 2000

// Code is an explicit extension list (K11.5, A6): markdown, JSON, YAML and lockfiles are not code, and neither is generated output.
const CODE_FILE = /\.(?:mjs|cjs|js|jsx|mts|cts|ts|tsx|vue|svelte|astro|css|scss|sass|less|html?|py|rb|go|rs|java|kt|swift|php|c|cc|cpp|h|hpp|cs|sh)$/i
const GENERATED = /(?:^|\/)(?:dist|build|out|coverage|node_modules|\.next|\.nuxt|\.svelte-kit|__snapshots__|generated)\/|\.min\.\w+$|\.generated\.\w+$|\.snap$|\.d\.ts$/i
export const isCodeFile = (path) => CODE_FILE.test(path) && !GENERATED.test(path)

const safe = (name) => String(name).replace(/[^\w.-]/g, '_')
const spawnPath = (dataDir, session) => join(dataDir, 'maker', 'spawn', `${safe(session)}.json`)
const blocksPath = (dataDir, key) => join(dataDir, 'maker', 'blocks', `${safe(key)}.json`)
const openPath = (dataDir, ticket) => join(dataDir, 'maker', 'open', `${safe(ticket ?? '_')}.json`)
const recordsName = (ticket) => join('maker', `${safe(ticket)}.jsonl`)
const spawnsName = (ticket) => join('maker', `${safe(ticket ?? '_')}.spawns.jsonl`)

/** One git call; `null` on any failure, a timeout included. `deadline` (ms epoch) caps the call by what is left of an overall budget: nothing is left — no call. */
function git(cwd, args, { input, timeout = 3000, deadline = null } = {}) {
  let limit = timeout
  if (deadline !== null) {
    limit = Math.min(timeout, deadline - Date.now())
    if (limit < 50) return null
  }
  const run = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', input, timeout: limit, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] })
  return run.status === 0 ? run.stdout : null
}

/** The real path (symlinks resolved: `/var` → `/private/var`), the path itself when it does not exist. Shared with the resume point. */
export const real = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Blob hashes of paths at a revision in one git call: `Map<path, blob | null>` (null — the path is not there, or is no blob). */
function revBlobs(root, rev, paths) {
  const out = new Map()
  const usable = [...new Set(paths)].filter((path) => !path.includes('\n'))
  for (const path of paths) out.set(path, null)
  if (!usable.length || !rev) return out
  const answer = git(root, ['cat-file', '--batch-check'], { input: `${usable.map((path) => `${rev}:${path}`).join('\n')}\n`, timeout: 5000 })
  if (answer === null) return out
  answer
    .split('\n')
    .filter(Boolean)
    .forEach((line, index) => {
      const found = /^([0-9a-f]{40,64}) blob /.exec(line)
      if (found && usable[index] !== undefined) out.set(usable[index], found[1])
    })
  return out
}

/** K11a.5: an untracked file over this size is not hashed and not judged (a DB dump, a recording, a .har). */
const UNTRACKED_MAX_BYTES = 5 * 1024 * 1024
/** K11a.5: the budget of the spawn side, well under agent-guard's 5 s hook timeout. */
const SNAPSHOT_BUDGET_MS = 3000

/**
 * Working-tree blob hashes of dirty or untracked paths: `Map<path, blob | null>` (null — deleted). `null` is "unknown", never "clean": the tree has more than `DIRTY_MAX`
 * such paths, or `git status` / `hash-object` failed or ran past the deadline (K11a.5, S-2). Files that are not regular by lstat (symlinks, FIFOs, devices) and untracked
 * files over `UNTRACKED_MAX_BYTES` are left out: they are neither hashed nor judged.
 */
export function dirtyBlobs(root, { deadline = Date.now() + 8000 } = {}) {
  const status = git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'], { deadline })
  if (status === null) return null
  const entries = status.split('\0').filter((entry) => entry.length > 3)
  if (entries.length > DIRTY_MAX) return null
  const map = new Map()
  const present = []
  for (const entry of entries) {
    const path = entry.slice(3)
    let stat = null
    try {
      stat = lstatSync(join(root, path))
    } catch {
      // gone from the working tree: a deletion
    }
    if (!stat) map.set(path, null)
    else if (stat.isFile() && !path.includes('\n') && !(entry.startsWith('??') && stat.size > UNTRACKED_MAX_BYTES)) present.push(path)
  }
  if (present.length) {
    const answer = git(root, ['hash-object', '--stdin-paths'], { input: `${present.join('\n')}\n`, timeout: 60_000, deadline })
    if (answer === null) return null
    const hashed = answer.split('\n').filter(Boolean)
    if (hashed.length !== present.length) return null
    present.forEach((path, index) => map.set(path, hashed[index]))
  }
  return map
}

const readJson = (dataDir, ...path) => {
  for (const text of readDataFiles(dataDir, ...path)) {
    try {
      return JSON.parse(text)
    } catch {
      // a broken file: none
    }
  }
  return null
}

/** The baselines of makers that have not stopped yet, by repo root: `{ [root]: { head, branch, blobs, at } }`. */
function readOpen(dataDir, ticket) {
  const data = readJson(dataDir, 'maker', 'open', `${safe(ticket ?? '_')}.json`)
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

function clearOpen(dataDir, ticket) {
  try {
    rmSync(openPath(dataDir, ticket), { force: true })
  } catch {
    // a leftover baseline: the next spawn on the same HEAD starts from it
  }
}

/** The repos of a snapshot, the cwd repo first: `[{ root, head, branch, blobs }]`. */
export const reposOf = (snapshot) => [{ root: snapshot.root, head: snapshot.head, branch: snapshot.branch, blobs: snapshot.blobs }, ...(Array.isArray(snapshot.others) ? snapshot.others : [])]

/** The sibling repos the config names that are there and are git roots of their own, other than `primary`: real root paths. */
function siblingRoots(config, primary) {
  const roots = []
  for (const dir of siblingRepos(config, primary)) {
    if (!existsSync(dir)) continue
    const top = git(dir, ['rev-parse', '--show-toplevel'])?.trim()
    const root = top ? real(top) : null
    if (root && root === real(dir) && root !== primary && !roots.includes(root)) roots.push(root)
  }
  return roots
}

/**
 * K11.1: the state of the tree at the spawn of a maker, for the stop to compare against. Never throws. Returns the snapshot, or null when nothing was recorded.
 * The cwd repo is the primary one; the sibling repos the config names (`config`) are snapshotted too (`others`). When an earlier maker of the ticket never stopped and
 * HEAD has not moved, its baseline is carried over: the files the dead maker changed belong to the change set of the maker that continues its work.
 * K11a.5: the spawn line is written BEFORE the tree is hashed, marked `pending`, and a `done` line follows only when every repo's snapshot finished inside `SNAPSHOT_BUDGET_MS`.
 * A spawn left `pending` (the hook was killed, a `git status` or `hash-object` failed or ran past the budget) makes the commit rule fail open for the run: the rule cannot
 * tell the maker's files from the others without the baseline, and a missing proof is not a reason to deny the maker's own code.
 */
export function takeSnapshot(dataDir, { session, cwd, ticket = null, stage = null, taskDir = null, typeCheck = false, config = null, spawn = null }) {
  try {
    if (!session) return null
    const deadline = Date.now() + SNAPSHOT_BUDGET_MS
    // M-1 (K11b.1): agent-guard writes the `pending` line first, before plan-check (`startSpawn`); a direct call writes it here
    const started = spawn ?? startSpawn(dataDir, { session, cwd, ticket, config })
    if (!started) return null
    const { id, roots, at } = started
    const root = roots[0]
    const open = readOpen(dataDir, ticket)
    const one = (repoRoot) => {
      const head = git(repoRoot, ['rev-parse', 'HEAD'], { deadline })?.trim() ?? null
      const branch = git(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD'], { deadline })?.trim() ?? null
      const carried = open[repoRoot]
      if (carried && carried.head === head && carried.branch === branch && carried.blobs && typeof carried.blobs === 'object') return { root: repoRoot, head, branch, blobs: carried.blobs, at: carried.at ?? at }
      const blobs = dirtyBlobs(repoRoot, { deadline })
      return { root: repoRoot, head, branch, blobs: blobs ? Object.fromEntries(blobs) : null, at }
    }
    const [primary, ...others] = roots.map(one)
    let taskRel = null
    if (taskDir) {
      const rel = relative(root, real(taskDir)).split(sep).join('/')
      taskRel = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null
    }
    const snapshot = { session, at, root, head: primary.head, branch: primary.branch, ticket, stage, taskRel, taskDir: taskDir ? real(taskDir) : null, typeCheck, blobs: primary.blobs, others }
    mkdirSync(join(dataDir, 'maker', 'spawn'), { recursive: true })
    writeFileSync(spawnPath(dataDir, session), JSON.stringify(snapshot))
    mkdirSync(join(dataDir, 'maker', 'open'), { recursive: true })
    writeFileSync(openPath(dataDir, ticket), JSON.stringify(Object.fromEntries([primary, ...others].map(({ root: key, head, branch, blobs, at: since }) => [key, { head, branch, blobs, at: since }]))))
    if ([primary, ...others].every((repo) => repo.blobs)) appendFileSync(join(dataDir, spawnsName(ticket)), `${JSON.stringify({ at, id, session, roots, done: true })}\n`)
    return snapshot
  } catch {
    return null
  }
}

/**
 * K11b.1 (B2): the first line of a maker spawn. Every `stage-implement` spawn gets an id of its own; the `pending` line carries it and is written before plan-check
 * and before the tree is hashed, so a hook killed anywhere after it leaves a spawn with no `done` line (the commit rule then fails open). The orchestrator's session is
 * the same for every spawn of a run, so pairing by session let a finished spawn hide a later unfinished one. Never throws; null when no line could be written.
 */
export function startSpawn(dataDir, { session, cwd, ticket = null, config = null }) {
  try {
    const top = git(cwd, ['rev-parse', '--show-toplevel'], { deadline: Date.now() + SNAPSHOT_BUDGET_MS })?.trim()
    if (!top) return null
    const root = real(top)
    const roots = [root, ...siblingRoots(config, root)]
    const spawn = { id: randomUUID(), roots, at: new Date().toISOString() }
    mkdirSync(join(dataDir, 'maker'), { recursive: true })
    appendFileSync(join(dataDir, spawnsName(ticket)), `${JSON.stringify({ at: spawn.at, id: spawn.id, session, roots, pending: true })}\n`)
    return spawn
  } catch {
    return null
  }
}

/** K11b.1: a spawn that plan-check (or the `Confirmed:` check) denied: the same id, so it is not an unfinished spawn. Never throws. */
export function denySpawn(dataDir, { spawn, session, ticket = null }) {
  try {
    appendFileSync(join(dataDir, spawnsName(ticket)), `${JSON.stringify({ at: new Date().toISOString(), id: spawn.id, session, roots: spawn.roots, denied: true })}\n`)
  } catch {
    // no line: the spawn stays pending and the commit rule fails open, the safe side
  }
}

export function readSnapshot(dataDir, session) {
  return readJson(dataDir, 'maker', 'spawn', `${safe(session)}.json`)
}

/** The spawn lines of a ticket since a moment (ms), oldest first: `{ at, id?, session, roots, pending?, done?, denied? }` (`startSpawn` writes `pending` first, `takeSnapshot` `done` when it finished, `denySpawn` `denied`). */
function readSpawns(dataDir, ticket, sinceMs = 0) {
  return readDataJsonl(dataDir, spawnsName(ticket)).filter((spawn) => (Date.parse(spawn.at) || 0) >= sinceMs && Array.isArray(spawn.roots))
}

const inTask = (snapshot, path) => Boolean(snapshot.taskRel) && (path === snapshot.taskRel || path.startsWith(`${snapshot.taskRel}/`))

/**
 * K11.3: the paths whose blob differs between the spawn snapshot and now: `Map<path, blob after | null>` (null — deleted). A path of the cwd repo is repo-relative, a path
 * of a sibling repo is absolute. The task directory is not code and is left out. `null` when the snapshot could not list the cwd tree (too many dirty paths): nothing to compare.
 */
export function changeSet(snapshot) {
  if (!snapshot?.blobs) return null
  const changes = new Map()
  for (const [index, repo] of reposOf(snapshot).entries()) {
    if (!repo.blobs) {
      if (index === 0) return null
      continue
    }
    const now = dirtyBlobs(repo.root)
    if (!now) {
      if (index === 0) return null
      continue
    }
    const paths = [...new Set([...Object.keys(repo.blobs), ...now.keys()])].filter((path) => index !== 0 || !inTask(snapshot, path))
    const before = revBlobs(repo.root, repo.head, paths.filter((path) => !(path in repo.blobs)))
    const after = revBlobs(repo.root, 'HEAD', paths.filter((path) => !now.has(path)))
    for (const path of paths) {
      const was = path in repo.blobs ? repo.blobs[path] : (before.get(path) ?? null)
      const is = now.has(path) ? now.get(path) : (after.get(path) ?? null)
      if (was !== is) changes.set(index === 0 ? path : join(repo.root, path), is)
    }
  }
  return changes
}

// ── the hand-back ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The sections of the contract (agents/stage-implement.md). `bulleted`: the label may also stand as a list item (`- Changed: …`); the checks line has aliases and never does. */
const SECTIONS = [
  { id: 'changed', name: 'Changed:', label: /^Changed\b/i, bulleted: true },
  { id: 'decisions', name: 'Decisions:', label: /^Decisions?\b/i, bulleted: true },
  { id: 'product', name: 'Product-visible:', label: /^Product[- ]visible\b/i, bulleted: true },
  { id: 'checks', name: 'lint / type_check / floor-guard:', label: /^(?:lint|type[_ ]check|floor-guard|tests?|checks?|gates?)\b/i, bulleted: false },
  { id: 'notdone', name: 'Not done / blocker:', label: /^Not done\b/i, bulleted: true },
  { id: 'acs', name: 'ACs without implementation:', label: /^ACs?\s+without\s+implementation\b/i, bulleted: true },
]

/** The section a line opens: `{ section, rest }` (rest — the text after the colon), else null. Labels stand at the start of a line; indented lines are the section's own. */
function openedBy(line) {
  // Linear by construction (S-3): the label ends at the first colon, and the marker runs are stripped by index, never by a regex that backtracks over them.
  let start = 0
  let bullet = false
  if (line[0] === ' ') start = 1
  if ((line[start] === '-' || line[start] === '*') && /\s/.test(line[start + 1] ?? '')) {
    bullet = true
    start++
    while (start < line.length && /\s/.test(line[start])) start++
  }
  const colon = line.indexOf(':', start)
  if (colon === -1 || colon - start > LABEL_SCAN_MAX) return null
  const isMarker = (char) => char === '`' || char === '*' || char === '_'
  let from = start
  let to = colon
  while (from < to && isMarker(line[from])) from++
  while (to > from && isMarker(line[to - 1])) to--
  const label = line.slice(from, to).trim()
  // the label is the head of the line: `Changed (worktree x, all uncommitted):`, `lint / type_check / floor-guard:`, `Not done / blocker:`; not a sentence that happens to contain a colon later
  if (label.length > 90) return null
  let restFrom = colon + 1
  while (restFrom < line.length && isMarker(line[restFrom])) restFrom++
  for (const section of SECTIONS) {
    if (!section.label.test(label) || (bullet && !section.bulleted)) continue
    return { section, rest: line.slice(restFrom) }
  }
  return null
}

/** `{ sections: { id: text }, length }` of a hand-back. A repeated label adds to its section. */
export function parseHandback(text) {
  const sections = {}
  let current = null
  for (const line of String(text).split('\n')) {
    const opened = openedBy(line)
    if (opened) {
      current = opened.section.id
      sections[current] = current in sections ? `${sections[current]}\n${opened.rest}` : opened.rest
      continue
    }
    if (current !== null) sections[current] += `\n${line}`
  }
  return { sections, length: String(text).length }
}

/** Where a label's colon can stand: a label is at most 90 characters, the rest is the bullet and the markers around it. */
const LABEL_SCAN_MAX = 200
const PATH_TOKEN = /^[\w@.+\-/~[\]()]+$/

/**
 * The paths a `Changed:` section names (K11.3): repo-relative for the cwd repo, absolute for a sibling repo (`others` — their roots), the same keys `changeSet` uses.
 * Each list item (and each comma-separated entry after the label) is `[A|M|D] <path> …`; the prefix is dropped, a `../` path is resolved against the repo, an absolute
 * path is made relative to the repo it is in and a path in no known repo is ignored (the task directory), a trailing punctuation mark is cut, and a first word that is
 * no path (`Outside the worktree, overwritten:`) names nothing.
 */
export function namedPaths(section, root, others = []) {
  const out = new Set()
  const lines = String(section ?? '').split('\n')
  const entries = [...(lines[0] ?? '').split(/[;,]/), ...lines.slice(1)]
  for (const entry of entries) {
    // only the top level of the list: a nested line is a note on its item
    if (/^\s{2,}\S/.test(entry) && entry !== lines[0]) continue
    // a word of a path is short: a longer one names nothing (and is not fed to the trailing-punctuation regex, which backtracks over a long run)
    const words = entry.trim().replace(/^[-*]\s+/, '').split(/\s+/, 3).map((word) => (word.length > 400 ? '' : word.replace(/^`|`[.,;:]*$|[.,;:]+$/g, '')))
    let word = words[0] ?? ''
    if (/^[AMD]$/.test(word) && words[1]) word = words[1]
    if (!word || !PATH_TOKEN.test(word) || !/[/.]/.test(word) || /^\d+(?:\.\d+)*$/.test(word)) continue
    let path = word
    if (!isAbsolute(path) && path.startsWith('../')) path = resolve(root, path)
    if (isAbsolute(path)) {
      let hit = null
      for (const repo of [root, ...others]) {
        const inside = [path, real(path)].map((candidate) => relative(repo, candidate).split(sep).join('/')).find((candidate) => candidate && !candidate.startsWith('..') && !isAbsolute(candidate))
        if (inside) {
          hit = repo === root ? inside : join(repo, inside)
          break
        }
      }
      if (!hit) continue
      path = hit
    }
    out.add(path.replace(/^\.\//, ''))
  }
  return out
}

/** The text of the hand-back in an agent transcript: the input of the last `SubagentHandback` call, else the last assistant text. `null` — none found. */
export function readHandback(transcript) {
  let handback = null
  let lastText = null
  for (const line of readFileSync(transcript, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      const content = record?.message?.content
      if (record?.message?.role !== 'assistant' || !Array.isArray(content)) continue
      const text = content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
      if (text.trim()) lastText = text
      for (const block of content) {
        if (block?.type === 'tool_use' && /(?:^|__)SubagentHandback$/.test(String(block.name)) && typeof block.input?.message === 'string') handback = block.input.message
      }
    } catch {
      // not JSON or an unexpected shape: the next record
    }
  }
  return handback ?? lastText
}

/**
 * K11a.4: the paths the maker disowns — `not mine: <path>` lines of `Not done / blocker:` (several paths may follow, comma-separated). A file that changed while the maker ran
 * but that it did not write (the orchestrator's edit in the shared tree) is listed there instead of in `Changed:`. Such a path is neither demanded in `Changed:` nor recorded as
 * the maker's blob, so the commit rule still judges it as code nobody made. Keys as in `namedPaths`.
 */
export function notMinePaths(section, root, others = []) {
  const out = new Set()
  for (const line of String(section ?? '').split('\n')) {
    const at = line.toLowerCase().indexOf('not mine:')
    if (at === -1) continue
    const entries = line.slice(at + 'not mine:'.length).split(/[;,]/).map((entry) => `- ${entry.trim()}`)
    for (const path of namedPaths(entries.join('\n'), root, others)) out.add(path)
  }
  return out
}

/** What is wrong with a hand-back, as lines for the maker: missing sections, the length, the numbers of the checks line, the change set. `[]` — a valid one. */
export function handbackProblems(text, snapshot, changes) {
  const { sections, length } = parseHandback(text)
  const problems = []
  const missing = SECTIONS.filter((section) => !(section.id in sections)).map((section) => `\`${section.name}\``)
  if (missing.length) problems.push(`missing section(s): ${missing.join(', ')}`)
  if (snapshot.typeCheck && 'checks' in sections && !/\d/.test(sections.checks)) problems.push('the checks line has no numbers (`type_check: 193 = baseline 193`, not "green")')
  if (length > HANDBACK_MAX) problems.push(`the hand-back is ${length} characters, over the limit of ${HANDBACK_MAX} — keep the fixed sections, one line per item, and put the long text into the task's checks/ if it must be kept`)
  if ('changed' in sections && changes) {
    const named = namedPaths(sections.changed, snapshot.root, (snapshot.others ?? []).map((repo) => repo.root))
    const actual = new Set(changes.keys())
    const notChanged = [...named].filter((path) => !actual.has(path) && !(snapshot.taskRel && (path === snapshot.taskRel || path.startsWith(`${snapshot.taskRel}/`))))
    const disowned = notMinePaths(sections.notdone, snapshot.root, (snapshot.others ?? []).map((repo) => repo.root))
    const unnamed = [...actual].filter((path) => !named.has(path) && !disowned.has(path))
    const shown = (list) => `${list.slice(0, 8).join(', ')}${list.length > 8 ? ` and ${list.length - 8} more` : ''}`
    if (notChanged.length) problems.push(`\`Changed:\` names file(s) that did not change since the spawn: ${shown(notChanged)}`)
    if (unnamed.length) problems.push(`\`Changed:\` does not name file(s) that changed: ${shown(unnamed)} — name a file only if you wrote it; one you did not write goes under \`Not done / blocker:\` as \`not mine: <path>\``)
  }
  return problems
}

export const blocksSoFar = (dataDir, key) => {
  try {
    return Number(JSON.parse(readFileSync(blocksPath(dataDir, key), 'utf8')).n) || 0
  } catch {
    return 0
  }
}

export function setBlocks(dataDir, key, n) {
  try {
    mkdirSync(join(dataDir, 'maker', 'blocks'), { recursive: true })
    if (n) writeFileSync(blocksPath(dataDir, key), JSON.stringify({ n }))
    else rmSync(blocksPath(dataDir, key), { force: true })
  } catch {
    // a lost counter: the stop is judged again from zero
  }
}

// ── the items and the receipts ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const NOTHING = /^(?:none|nothing|n\/a|no|—|-)[\s.]*$/i

/** The items of a section: one per top-level list item with its notes, else the whole text; "none" is no item. Verbatim, capped at `ITEM_MAX` characters. */
export function sectionItems(text) {
  const lines = String(text ?? '').split('\n')
  const items = []
  for (const line of lines) {
    if (!line.trim()) continue
    if (/^\s{0,1}(?:[-*]|\d+\.)\s+\S/.test(line) || !items.length) items.push(line.trim())
    else items[items.length - 1] += `\n${line.trimEnd()}`
  }
  return items.filter((item) => !NOTHING.test(item.replace(/^(?:[-*]|\d+\.)\s+/, ''))).map((item) => (item.length > ITEM_MAX ? `${item.slice(0, ITEM_MAX)}…` : item))
}

/** K11.4 / K11.6: a stop that goes through (valid, or given up on): the post-run blobs of the change set and the maker's items, appended to the ticket's record file. */
export function storeStop(dataDir, snapshot, text, changes, { unfixed = null, agent = null } = {}) {
  try {
    const { sections } = parseHandback(text ?? '')
    const rootsOf = (snapshot.others ?? []).map((repo) => repo.root)
    // R-1: a hand-back given up on is not an authority over the tree. Only the paths its `Changed:` names are recorded as the maker's; a maker that never complies
    // cannot launder the orchestrator's edits into receipts. The paths left out are named in the digest item.
    const named = unfixed ? namedPaths(sections.changed, snapshot.root, rootsOf) : null
    const left = []
    const items = [
      ...sectionItems(sections.product).map((item) => ({ kind: 'product', text: item })),
      ...sectionItems(sections.notdone).map((item) => ({ kind: 'notdone', text: item })),
      ...sectionItems(sections.acs).map((item) => ({ kind: 'acs', text: item })),
    ]
    // the cwd repo's paths are repo-relative, a sibling repo's are absolute (`changeSet`): the blobs are stored per repo
    const mine = {}
    const others = (snapshot.others ?? []).map((repo) => ({ root: repo.root, branch: repo.branch, blobs: {} }))
    const disowned = notMinePaths(sections.notdone, snapshot.root, rootsOf)
    for (const [path, blob] of changes ?? []) {
      if (disowned.has(path)) continue
      if (named && !named.has(path)) {
        left.push(path)
        continue
      }
      const owner = isAbsolute(path) ? others.find((repo) => path.startsWith(`${repo.root}${sep}`)) : null
      if (owner) owner.blobs[relative(owner.root, path).split(sep).join('/')] = blob
      else if (!isAbsolute(path)) mine[path] = blob
    }
    if (unfixed) items.push({ kind: 'unfixed', text: `hand-back not fixed: ${unfixed}${left.length ? ` — not recorded as the maker's (not named in \`Changed:\`): ${left.slice(0, 8).join(', ')}${left.length > 8 ? ` and ${left.length - 8} more` : ''}` : ''}` })
    const record = { at: new Date().toISOString(), session: snapshot.session, agent, ticket: snapshot.ticket, stage: snapshot.stage, root: snapshot.root, branch: snapshot.branch, blobs: mine, others, items }
    mkdirSync(join(dataDir, 'maker'), { recursive: true })
    appendFileSync(join(dataDir, recordsName(snapshot.ticket ?? '_')), `${JSON.stringify(record)}\n`)
    // the maker has stopped: its baseline is no longer open for the next spawn to continue from
    clearOpen(dataDir, snapshot.ticket)
    return record
  } catch {
    return null
  }
}

/** Every maker record of a ticket, oldest first (K11a.1: a line that is not an object is skipped). */
export function readMakerRecords(dataDir, ticket) {
  return readDataJsonl(dataDir, recordsName(ticket))
}

/** For the run digest: the maker stops of a ticket since a moment (ms) and their items, `{ stops, items: [{ at, stage, kind, text }] }`. */
export function makerItems(dataDir, ticket, sinceMs = 0) {
  const records = readMakerRecords(dataDir, ticket).filter((record) => (Date.parse(record.at) || 0) >= sinceMs)
  return { stops: records.length, items: records.flatMap((record) => (Array.isArray(record.items) ? record.items : []).filter((item) => item && typeof item === 'object').map((item) => ({ at: record.at, stage: record.stage ?? null, kind: item.kind, text: item.text }))) }
}

/** The blobs a record holds for a repo (`root`), or null when the record is not about that repo. */
export function recordBlobs(record, root) {
  const plain = (blobs) => (blobs && typeof blobs === 'object' && !Array.isArray(blobs) ? blobs : null)
  if (record.root === root) return plain(record.blobs) ?? {}
  const others = Array.isArray(record.others) ? record.others : []
  return plain(others.find((repo) => repo && repo.root === root)?.blobs)
}

/** The last blob a maker stop recorded for each path of a repo: `Map<path, blob | null>`. */
export function lastMakerBlobs(dataDir, ticket, root) {
  const map = new Map()
  for (const record of readMakerRecords(dataDir, ticket)) {
    for (const [path, blob] of Object.entries(recordBlobs(record, root) ?? {})) map.set(path, blob)
  }
  return map
}

/**
 * The Force block of the task when the maker rules apply to it (`receiptRun`, D7), else null. Two first-sight gates: the 0.18 receipts gate, and the plan snapshot of stage 10
 * (the snapshot is taken now when none exists yet, like plan-check's own fallback): a Force block the snapshot saw at the first look is a run already going.
 */
export function makerRun(dataDir, taskDir) {
  try {
    const run = receiptRun(dataDir, taskDir)
    if (!run) return null
    const snapshot = takePlanSnapshot(dataDir, taskDir, run.stages)
    if (Array.isArray(snapshot?.forceSeen) && snapshot.forceSeen.includes(forceKey(run.block.heading))) return null
    return run
  } catch {
    return null
  }
}

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Whether the Force block names the path as a whole token (`src/legacy.ts` is not named by `src/legacy.tsx`). */
const namesPath = (body, path) => new RegExp(`(?<![\\w@./-])(?:\\./)?${escaped(path)}(?![\\w@/-]|\\.\\w)`).test(body)

/**
 * The index entries (`stage 0`) of the given paths: `Map<path, blob>`, or null when a read failed (K11b.1: the caller fails open — a failed read is not "every path is foreign").
 * Only the commit's own paths are read, in literal pathspecs and in chunks, so the call does not grow with the repository.
 */
function indexBlobs(root, paths) {
  const map = new Map()
  for (let from = 0; from < paths.length; from += 200) {
    const out = git(root, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...paths.slice(from, from + 200)], { timeout: 10_000 })
    if (out === null) return null
    for (const entry of out.split('\0')) {
      const found = /^\d+ ([0-9a-f]{40,64}) 0\t([\s\S]+)$/.exec(entry)
      if (found) map.set(found[2], found[1])
    }
  }
  return map
}

/**
 * Whether the maker rules judge a force commit in `worktree`, and for which run: `{ run, root }`, else null. No Force block, a block the first-sight gates call old (`makerRun`),
 * a repo no maker was spawned in, a spawn whose snapshot never finished (K11a.5), a run whose spawns left no stop record, or `STAGE_PIPELINE_MAKER_RECEIPTS=off`: null.
 */
function makerGate({ dataDir, taskDir, ticket, worktree }) {
  if (process.env.STAGE_PIPELINE_MAKER_RECEIPTS === 'off') return null
  const run = makerRun(dataDir, taskDir)
  if (!run) return null
  const root = real(worktree)
  const lines = readSpawns(dataDir, ticket, run.start)
  // K11b.1: the lines pair by the spawn id (a line of an older version has none: its session stands for it)
  const idOf = (line) => line.id ?? line.session
  const closed = new Set(lines.filter((line) => line.done || line.denied).map(idOf))
  const denied = new Set(lines.filter((line) => line.denied).map(idOf))
  const spawns = lines.filter((line) => line.pending && !denied.has(idOf(line)))
  if (spawns.length) {
    if (!spawns.some((spawn) => spawn.roots.includes(root))) return null
    // K11a.5: a spawn whose snapshot never finished (no `done` line: killed, timed out, a failed git call) leaves no baseline to judge against — the rule fails open for the run
    if (spawns.some((spawn) => !closed.has(idOf(spawn)) && spawn.roots.includes(root))) return null
    if (!readMakerRecords(dataDir, ticket).some((record) => (Date.parse(record.at) || 0) >= run.start)) return null
  }
  return { run, root }
}

/** K11a.2: whether a force commit command that changes the index other than by `git add` is judged by the maker rules (the run is new and a maker was spawned in the repo). */
export const makerRuleApplies = (args) => makerGate(args) !== null

/**
 * K11.5: the code paths of a force commit that the maker did not write. `changed` — the files of the commit (paths from the worktree root). `staged` — what the command
 * itself stages before it commits: `null` for the whole tree (`git add -A`), else a Set of paths (`git add x`, `commit -a`, `commit x`; empty for a plain `git commit`).
 * The blob judged is the one that will be committed: the working-tree blob of a staged path, the index blob of the rest (a path the index leaves as HEAD is not committed
 * and is not judged). `null` — the rule does not apply: no Force block, a block the first-sight gates call old (`makerRun`), a repo no maker was spawned in, a run whose
 * spawns left no stop record (maker-guard was not registered in that session). `STAGE_PIPELINE_MAKER_RECEIPTS=off` switches the rule off (hooks-test turns it on only for the
 * fixtures of this rule). A path passes when its committed blob equals the last blob a maker stop recorded for it, or when it is a deletion the Force block names.
 */
export function commitMakerVerdict({ dataDir, taskDir, ticket, worktree, changed, staged = null }) {
  const gate = makerGate({ dataDir, taskDir, ticket, worktree })
  if (!gate) return null
  const { run, root } = gate
  let taskRel = null
  try {
    taskRel = relative(root, real(taskDir)).split(sep).join('/')
  } catch {
    // no task directory in the repo
  }
  const named = changed.filter((path) => isCodeFile(path) && !(taskRel && !taskRel.startsWith('..') && (path === taskRel || path.startsWith(`${taskRel}/`))))
  if (!named.length) return []
  const index = indexBlobs(root, named)
  if (index === null) return null
  // K11a.5: what the snapshot does not hash it does not judge either — a file that is not regular by lstat (a symlink, a FIFO) and an untracked file over the size cap
  const judgeable = (path) => {
    try {
      const stat = lstatSync(join(root, path))
      return stat.isFile() && !(stat.size > UNTRACKED_MAX_BYTES && !index.has(path))
    } catch {
      return true // gone: a deletion
    }
  }
  const candidates = named.filter(judgeable)
  if (!candidates.length) return []
  const recorded = lastMakerBlobs(dataDir, ticket, root)
  const cached = new Set((git(root, ['diff', '--cached', '--name-only', '--no-renames', '-z']) ?? '').split('\0').filter(Boolean))
  const stagedHere = (path) => staged === null || staged.has(path)
  const present = candidates.filter((path) => stagedHere(path) && !path.includes('\n') && existsSync(join(root, path)))
  let hashed = []
  if (present.length) {
    // a hash that failed or timed out is not "every path is foreign": the rule cannot judge, and fails open (S-2)
    const answer = git(root, ['hash-object', '--stdin-paths'], { input: `${present.join('\n')}\n`, timeout: 10_000 })
    hashed = (answer ?? '').split('\n').filter(Boolean)
    if (answer === null || hashed.length !== present.length) return null
  }
  const working = new Map(present.map((path, position) => [path, hashed[position] ?? null]))
  const offending = []
  for (const path of candidates) {
    let committed
    if (stagedHere(path)) committed = working.get(path) ?? null
    else if (cached.has(path)) committed = index.get(path) ?? null
    else continue // the index leaves the path as HEAD (or the file is untracked and not added): nothing of it is committed
    if (committed === null && namesPath(run.block.body, path)) continue
    if (recorded.has(path) && recorded.get(path) === committed) continue
    offending.push(path)
  }
  return offending
}
