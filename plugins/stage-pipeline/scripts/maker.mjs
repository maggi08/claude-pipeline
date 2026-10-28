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
 * (a session that loaded hooks.json before the release has no maker-guard), a session with no spawn snapshot.
 * A maker that died before its stop leaves its baseline open for the ticket (`maker/open/<ticket>.json`); the next spawn on the same HEAD starts from it, so the
 * continuation's change set holds the dead maker's files too. A task over two repos snapshots the cwd repo and the sibling repos the config names (`others`).
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute, resolve, sep } from 'node:path'
import { readDataFiles } from './hooks/pipeline-state.mjs'
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

function git(cwd, args, { input, timeout = 3000 } = {}) {
  const run = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', input, timeout, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] })
  return run.status === 0 ? run.stdout : null
}

const real = (path) => {
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

/** Working-tree blob hashes of dirty or untracked paths: `Map<path, blob | null>` (null — deleted). `null` when the tree has more than `DIRTY_MAX` such paths. */
export function dirtyBlobs(root) {
  const status = git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'])
  if (status === null) return new Map()
  const paths = status.split('\0').filter((entry) => entry.length > 3).map((entry) => entry.slice(3))
  if (paths.length > DIRTY_MAX) return null
  const map = new Map()
  const present = []
  for (const path of paths) {
    let stat = null
    try {
      stat = lstatSync(join(root, path))
    } catch {
      // gone from the working tree: a deletion
    }
    if (!stat) map.set(path, null)
    else if ((stat.isFile() || stat.isSymbolicLink()) && !path.includes('\n')) present.push(path)
  }
  if (present.length) {
    const hashed = (git(root, ['hash-object', '--stdin-paths'], { input: `${present.join('\n')}\n`, timeout: 6000 }) ?? '').split('\n').filter(Boolean)
    present.forEach((path, index) => hashed[index] && map.set(path, hashed[index]))
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
 */
export function takeSnapshot(dataDir, { session, cwd, ticket = null, stage = null, taskDir = null, typeCheck = false, config = null }) {
  try {
    if (!session) return null
    const top = git(cwd, ['rev-parse', '--show-toplevel'])?.trim()
    if (!top) return null
    const root = real(top)
    const open = readOpen(dataDir, ticket)
    const at = new Date().toISOString()
    const one = (repoRoot) => {
      const head = git(repoRoot, ['rev-parse', 'HEAD'])?.trim() ?? null
      const branch = git(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD'])?.trim() ?? null
      const carried = open[repoRoot]
      if (carried && carried.head === head && carried.branch === branch && carried.blobs && typeof carried.blobs === 'object') return { root: repoRoot, head, branch, blobs: carried.blobs, at: carried.at ?? at }
      const blobs = dirtyBlobs(repoRoot)
      return { root: repoRoot, head, branch, blobs: blobs ? Object.fromEntries(blobs) : null, at }
    }
    const [primary, ...others] = [root, ...siblingRoots(config, root)].map(one)
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
    appendFileSync(join(dataDir, spawnsName(ticket)), `${JSON.stringify({ at, session, roots: [primary.root, ...others.map((repo) => repo.root)] })}\n`)
    return snapshot
  } catch {
    return null
  }
}

export function readSnapshot(dataDir, session) {
  return readJson(dataDir, 'maker', 'spawn', `${safe(session)}.json`)
}

/** The spawns of a ticket since a moment (ms), oldest first: `[{ at, session, roots }]`. */
function readSpawns(dataDir, ticket, sinceMs = 0) {
  return readDataFiles(dataDir, spawnsName(ticket))
    .reverse()
    .flatMap((text) => text.split('\n'))
    .flatMap((line) => {
      try {
        const spawn = line.trim() ? JSON.parse(line) : null
        return spawn && (Date.parse(spawn.at) || 0) >= sinceMs && Array.isArray(spawn.roots) ? [spawn] : []
      } catch {
        return []
      }
    })
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
  const found = /^ {0,1}(?<bullet>[-*]\s+)?[`*_]*(?<label>[^\n:]*?)[`*_]*:[`*_]*(?<rest>.*)$/.exec(line)
  if (!found) return null
  const { bullet, label, rest } = found.groups
  for (const section of SECTIONS) {
    if (!section.label.test(label.trim()) || (bullet && !section.bulleted)) continue
    // the label is the head of the line: `Changed (worktree x, all uncommitted):`, `lint / type_check / floor-guard:`, `Not done / blocker:`; not a sentence that happens to contain a colon later
    if (label.trim().length > 90) continue
    return { section, rest }
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
    const words = entry.trim().replace(/^[-*]\s+/, '').split(/\s+/).map((word) => word.replace(/^`|`[.,;:]*$|[.,;:]+$/g, ''))
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
    const unnamed = [...actual].filter((path) => !named.has(path))
    const shown = (list) => `${list.slice(0, 8).join(', ')}${list.length > 8 ? ` and ${list.length - 8} more` : ''}`
    if (notChanged.length) problems.push(`\`Changed:\` names file(s) that did not change since the spawn: ${shown(notChanged)}`)
    if (unnamed.length) problems.push(`\`Changed:\` does not name file(s) that changed: ${shown(unnamed)}`)
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
export const ITEM_KINDS = ['product', 'notdone', 'acs', 'unfixed']

/** The items of a section: one per top-level list item with its notes, else the whole text; "none" is no item. Verbatim, capped at `ITEM_MAX` characters. */
export function sectionItems(text) {
  const lines = String(text ?? '').split('\n')
  const items = []
  for (const line of lines) {
    if (!line.trim()) continue
    if (/^\s{0,1}(?:[-*]|\d+\.)\s+\S/.test(line) || !items.length) items.push(line.trim())
    else items[items.length - 1] += `\n${line.replace(/\s+$/, '')}`
  }
  return items.filter((item) => !NOTHING.test(item.replace(/^(?:[-*]|\d+\.)\s+/, ''))).map((item) => (item.length > ITEM_MAX ? `${item.slice(0, ITEM_MAX)}…` : item))
}

/** K11.4 / K11.6: a stop that goes through (valid, or given up on): the post-run blobs of the change set and the maker's items, appended to the ticket's record file. */
export function storeStop(dataDir, snapshot, text, changes, { unfixed = null, agent = null } = {}) {
  try {
    const { sections } = parseHandback(text ?? '')
    const items = [
      ...sectionItems(sections.product).map((item) => ({ kind: 'product', text: item })),
      ...sectionItems(sections.notdone).map((item) => ({ kind: 'notdone', text: item })),
      ...sectionItems(sections.acs).map((item) => ({ kind: 'acs', text: item })),
      ...(unfixed ? [{ kind: 'unfixed', text: `hand-back not fixed: ${unfixed}` }] : []),
    ]
    // the cwd repo's paths are repo-relative, a sibling repo's are absolute (`changeSet`): the blobs are stored per repo
    const mine = {}
    const others = (snapshot.others ?? []).map((repo) => ({ root: repo.root, branch: repo.branch, blobs: {} }))
    for (const [path, blob] of changes ?? []) {
      const owner = isAbsolute(path) ? others.find((repo) => path.startsWith(`${repo.root}${sep}`)) : null
      if (owner) owner.blobs[relative(owner.root, path).split(sep).join('/')] = blob
      else if (!isAbsolute(path)) mine[path] = blob
    }
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

/** Every maker record of a ticket, oldest first. */
export function readMakerRecords(dataDir, ticket) {
  return readDataFiles(dataDir, recordsName(ticket))
    .reverse()
    .flatMap((text) => text.split('\n'))
    .flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line)] : []
      } catch {
        return []
      }
    })
}

/** For the run digest: the maker stops of a ticket since a moment (ms) and their items, `{ stops, items: [{ at, stage, kind, text }] }`. */
export function makerItems(dataDir, ticket, sinceMs = 0) {
  const records = readMakerRecords(dataDir, ticket).filter((record) => (Date.parse(record.at) || 0) >= sinceMs)
  return { stops: records.length, items: records.flatMap((record) => (record.items ?? []).map((item) => ({ at: record.at, stage: record.stage ?? null, kind: item.kind, text: item.text }))) }
}

/** The blobs a record holds for a repo (`root`), or null when the record is not about that repo. */
export function recordBlobs(record, root) {
  if (record.root === root) return record.blobs ?? {}
  return (record.others ?? []).find((repo) => repo.root === root)?.blobs ?? null
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

/** The index entries (`stage 0`) of a repo: `Map<path, blob>`. */
function indexBlobs(root) {
  const map = new Map()
  for (const entry of (git(root, ['ls-files', '-s', '-z']) ?? '').split('\0')) {
    const found = /^\d+ ([0-9a-f]{40,64}) 0\t([\s\S]+)$/.exec(entry)
    if (found) map.set(found[2], found[1])
  }
  return map
}

/**
 * K11.5: the code paths of a force commit that the maker did not write. `changed` — the files of the commit (paths from the worktree root). `staged` — what the command
 * itself stages before it commits: `null` for the whole tree (`git add -A`), else a Set of paths (`git add x`, `commit -a`, `commit x`; empty for a plain `git commit`).
 * The blob judged is the one that will be committed: the working-tree blob of a staged path, the index blob of the rest (a path the index leaves as HEAD is not committed
 * and is not judged). `null` — the rule does not apply: no Force block, a block the first-sight gates call old (`makerRun`), a repo no maker was spawned in, a run whose
 * spawns left no stop record (maker-guard was not registered in that session). `STAGE_PIPELINE_MAKER_RECEIPTS=off` switches the rule off (hooks-test turns it on only for the
 * fixtures of this rule). A path passes when its committed blob equals the last blob a maker stop recorded for it, or when it is a deletion the Force block names.
 */
export function commitMakerVerdict({ dataDir, taskDir, ticket, worktree, changed, staged = null }) {
  if (process.env.STAGE_PIPELINE_MAKER_RECEIPTS === 'off') return null
  const run = makerRun(dataDir, taskDir)
  if (!run) return null
  const root = real(worktree)
  const spawns = readSpawns(dataDir, ticket, run.start)
  if (spawns.length) {
    if (!spawns.some((spawn) => spawn.roots.includes(root))) return null
    if (!readMakerRecords(dataDir, ticket).some((record) => (Date.parse(record.at) || 0) >= run.start)) return null
  }
  let taskRel = null
  try {
    taskRel = relative(root, real(taskDir)).split(sep).join('/')
  } catch {
    // no task directory in the repo
  }
  const candidates = changed.filter((path) => isCodeFile(path) && !(taskRel && !taskRel.startsWith('..') && (path === taskRel || path.startsWith(`${taskRel}/`))))
  if (!candidates.length) return []
  const recorded = lastMakerBlobs(dataDir, ticket, root)
  const index = indexBlobs(root)
  const cached = new Set((git(root, ['diff', '--cached', '--name-only', '--no-renames', '-z']) ?? '').split('\0').filter(Boolean))
  const stagedHere = (path) => staged === null || staged.has(path)
  const present = candidates.filter((path) => stagedHere(path) && !path.includes('\n') && existsSync(join(root, path)))
  const hashed = present.length ? (git(root, ['hash-object', '--stdin-paths'], { input: `${present.join('\n')}\n`, timeout: 10_000 }) ?? '').split('\n').filter(Boolean) : []
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

/** The spawn side for agent-guard: the stage out of the prompt (`Stage: 11`, `Stage 11`, `stage number: 2c`), else null. */
export function stageOf(prompt) {
  const found = /\b[Ss]tage(?:\s+number)?\s*[:#]?\s*([0-9]+[a-z]?|[A-Z][0-9]*)\b/.exec(String(prompt ?? ''))
  return found ? found[1] : null
}
