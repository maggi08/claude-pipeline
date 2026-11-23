#!/usr/bin/env node
/**
 * The machine's snapshot for people (VT-17 stage 3): every task of the registry with its stage and next step, every Claude Code session with the load of its process tree
 * split by kind of work, the balancer's state and the machine's memory.
 *
 *   node monitor.mjs          # a compact table
 *   node monitor.mjs --json   # the snapshot, for the page (stage 5)
 *
 * Read-only: it signals nothing and writes nothing (the registry reads drop only dead entries, as `heavy-queue.mjs status` does). One `ps` call for the whole table and at most one
 * `lsof` per session (through `cwdOf`). Without `ps`, or when it does not answer in time, the snapshot has the tasks, no processes and a `problem` line; the exit code stays 0.
 * Stages 4–6 import `sessionRows`, `classifyTree` and `balanceRows` from here: the session ↔ process link and the process kinds live in this file only.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { cpus, homedir, totalmem } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isBrowserMain, isClaude, isMcpServer } from './browser-cleanup.mjs'
import { isMain } from './main-guard.mjs'
import { descendants, processStats, cwdOf as readCwd } from './processes.mjs'
import { placeOf, readLoad, readMemory, readPriorities, readRunning, readWaiting, taskInfo } from './heavy-queue.mjs'
import { STATUS_LINE } from './markers.mjs'
import { nextAction, resumeState, stageList } from './resume-point.mjs'
import { WAIT_STATE_MAX_AGE_MS } from './hooks/session-wait.mjs'
import { devServerConfig, findConfigRoot, forceActive, knownTaskDirs, OPEN_STATUS, pluginDataDir, readPipelineState, taskFile, unreadableMessage } from './hooks/pipeline-state.mjs'

const GB = 1024 ** 3
export const SUBAGENT_FRESH_MS = 60_000
export const KINDS = ['check', 'browser', 'dev-server', 'other']
export const WAIT_TRANSCRIPT_GRACE_MS = 5000 // a transcript that changed later than this after the state was written: the session went on (D11)

// ── tasks ────────────────────────────────────────────────────────────────────

/** The repo root of a task directory: the directory whose config serves it, else the parent of `.claude/`. The key then matches `taskInfo(cwd).key` of a session in that repo. */
function rootOfTaskDir(dir) {
  return findConfigRoot(dir) ?? (/[\\/]\.claude[\\/]/.test(dir) ? dir.split(/[\\/]\.claude[\\/]/)[0] : dirname(dir))
}

const stageNo = (stage) => stage.heading.replace(/:.*$/, '')

/** The next pipeline item: the resume point for a live force run (the journal, receipts and the tree), else what the stage list alone says. */
function nextItem(root, ticket, list, stages) {
  const running = list.filter((stage) => /^in[-\s]?progress\b/.test(stage.status) && !/\bblocked\b/.test(stage.status))
  const next = list.find((stage) => !stage.done && !/\bblocked\b/.test(stage.status) && !running.includes(stage))
  if (forceActive(stages)) {
    try {
      const state = readPipelineState(root)
      const task = state?.tasks.find((item) => item.ticket === ticket)
      const resume = task ? resumeState({ dataDir: pluginDataDir(), state, task }) : null
      if (resume) return nextAction(resume)
    } catch {
      // the light answer below
    }
  }
  if (running[0]) return `${stageNo(running[0])} in progress`
  return nextAction({ stage: null, next })
}

/** Every `<TICKET>/STAGES.md` of the given task directories; an unreadable one stays in the list with `problem`. Newest journal first. */
export function taskRows(dirs = knownTaskDirs()) {
  const rows = []
  for (const dir of dirs) {
    let tickets = []
    try {
      tickets = readdirSync(dir)
    } catch {
      continue
    }
    const root = rootOfTaskDir(dir)
    for (const ticket of tickets) {
      const taskDir = join(dir, ticket)
      let read
      try {
        if (!statSync(taskDir).isDirectory()) continue
        read = taskFile(taskDir, 'STAGES.md')
      } catch {
        continue
      }
      if (read.problem === 'missing') continue
      const base = { key: `${root}#${ticket}`, root, repo: basename(root), ticket, dir: taskDir, status: null, stages: [], stageNumber: null, stageTotal: 0, next: null, registered: true }
      if (read.problem) {
        rows.push({ ...base, problem: unreadableMessage('STAGES.md', read), mtime: 0 })
        continue
      }
      const stages = read.text
      const list = stageList(stages)
      const current = list.findIndex((stage) => /^in[-\s]?progress\b/.test(stage.status))
      const index = current >= 0 ? current : list.findIndex((stage) => !stage.done && !/\bblocked\b/.test(stage.status))
      let mtime = 0
      try {
        mtime = statSync(join(taskDir, 'STAGES.md')).mtimeMs
      } catch {
        // gone between the two reads
      }
      rows.push({
        ...base,
        status: stages.match(STATUS_LINE)?.[1]?.trim() ?? null,
        stages: list,
        stageNumber: index >= 0 ? index + 1 : null,
        stageTotal: list.length,
        next: nextItem(root, ticket, list, stages),
        open: OPEN_STATUS.test(stages),
        forceActive: forceActive(stages),
        problem: null,
        mtime,
      })
    }
  }
  return rows.sort((a, b) => b.mtime - a.mtime)
}

// ── processes: the tree of a session and its kinds ───────────────────────────

const RUN_CHECK = /(?:^|[\s/])run-check\.mjs(?:\s|$)/
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])
const PACKAGE_MANAGERS = new Set(['npm', 'yarn', 'pnpm', 'bun'])
const SCRIPT = /^(?:dev|serve|start|preview)(?::.+)?$/
/** The subcommands after which a launcher is a server (`undefined` = none given is a server too: `vite`, `vite --port 3000`). */
const LAUNCHERS = {
  nuxi: ['dev', 'preview'], nuxt: ['dev', 'preview'], next: ['dev', 'start'], astro: ['dev', 'preview'], storybook: ['dev'], 'webpack-dev-server': null, webpack: ['serve'],
  vite: ['dev', 'serve', 'preview', undefined],
}
const wordOf = (token) => basename(token ?? '').replace(/\.(?:[cm]?js|ts)$/, '')

/** The words of a command line without leading `VAR=value` words; a shell's `-c <command>` is the command itself. */
function commandWords(args) {
  let words = args.trim().split(/\s+/)
  for (;;) {
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1)
    const cIndex = SHELLS.has(wordOf(words[0])) ? words.indexOf('-c') : -1
    if (cIndex < 0 || !words[cIndex + 1]) return words
    words = words.slice(cIndex + 1).join(' ').replace(/^['"]|['"]$/g, '').split(/\s+/)
  }
}

/** Whether a command line launches a dev server: the launcher is the command word (through `node`, `npx`, `yarn`/`pnpm`/`bun`/`npm run`) and its subcommand serves. A word elsewhere in the line (`rg next src/dev`) is not one. */
function launchesDevServer(args) {
  let words = commandWords(args)
  if (wordOf(words[0]) === 'node') {
    words = words.slice(1)
    while (words[0]?.startsWith('-')) words = words.slice(1)
  }
  let name = wordOf(words[0])
  let rest = words.slice(1)
  if (name === 'npx' || name === 'bunx' || name === 'pnpx' || (PACKAGE_MANAGERS.has(name) && ['exec', 'dlx', 'x'].includes(rest[0]))) {
    if (name !== 'npx' && name !== 'bunx' && name !== 'pnpx') rest = rest.slice(1)
    while (rest[0]?.startsWith('-')) rest = rest.slice(1)
    name = wordOf(rest[0])
    rest = rest.slice(1)
  } else if (PACKAGE_MANAGERS.has(name)) {
    const script = rest[0] === 'run' ? rest[1] : rest[0]
    if (SCRIPT.test(script ?? '')) return true
    if (name === 'yarn' || name === 'pnpm' || name === 'bun') {
      name = wordOf(rest[0])
      rest = rest.slice(1)
    } else return false
  }
  if (!Object.hasOwn(LAUNCHERS, name)) return false
  const allowed = LAUNCHERS[name]
  if (allowed === null) return true
  const sub = rest[0]?.startsWith('-') ? undefined : rest[0]
  return allowed.includes(sub)
}

/** The port on a command line: `--port N`, `--port=N`, `-p N`, `-pN`, `PORT=N`; a URL or any other number is not one. */
function portsOf(args) {
  const ports = []
  for (const match of args.matchAll(/(?:^|\s)(?:--port[= ]|-p[= ]?|PORT=)(\d+)(?=\s|$)/g)) ports.push(match[1])
  return ports
}

/** Whether a command line is the project's dev server: the config's dev port given as `--port`/`-p`/`PORT=`, or a dev-server launcher as the command word. */
export function isDevServer(args, port = null) {
  if (port && portsOf(args).includes(String(port))) return true
  return launchesDevServer(args)
}

/**
 * The descendants of a Claude process with the kind of each: `check` (run-check and everything under it), `browser` (a Chrome main under a DevTools MCP server and its helpers),
 * `dev-server` (the dev server and its children), `other`. A nested Claude process is another session: the walk stops there.
 */
export function treeOf(table, pid, { devPort = null } = {}) {
  const children = new Map()
  for (const entry of table.values()) {
    if (!children.has(entry.ppid)) children.set(entry.ppid, [])
    children.get(entry.ppid).push(entry)
  }
  const found = []
  const seen = new Set([pid])
  const walk = (parent, inherited, underMcp, depth) => {
    if (depth > 12) return
    for (const entry of children.get(parent) ?? []) {
      if (seen.has(entry.pid) || isClaude(entry.args)) continue
      seen.add(entry.pid)
      const mcp = underMcp || isMcpServer(entry.args)
      let kind = 'other'
      if (RUN_CHECK.test(entry.args)) kind = 'check'
      else if (inherited !== 'other') kind = inherited
      else if (mcp && isBrowserMain(entry.args)) kind = 'browser'
      else if (isDevServer(entry.args, devPort)) kind = 'dev-server'
      found.push({ entry, kind })
      walk(entry.pid, kind, mcp, depth + 1)
    }
  }
  walk(pid, 'other', false, 0)
  return found
}

/**
 * The load of one session's tree: `cpu` (the %CPU `ps` reports — a decaying recent value on macOS, a lifetime average on Linux) and `cpuSeconds` (cumulative CPU time, the base of a live load:
 * stage 5's server takes the delta between two samples) and resident bytes, in total and per kind; `procs` lists `{ pid, kind, age, cpuSeconds }` per process — a sample pair of a pid is the same
 * process while its `age` did not fall. `nice` of the session, background (macOS band PRI 4) and stopped (every live process `T`).
 */
export function classifyTree(table, pid, { devPort = null, platform = process.platform } = {}) {
  const head = table.get(pid)
  const tree = treeOf(table, pid, { devPort })
  const members = [{ entry: head, kind: 'other' }, ...tree].filter((item) => item.entry)
  const kinds = Object.fromEntries(KINDS.map((kind) => [kind, { count: 0, cpu: 0, cpuSeconds: 0, rssBytes: 0, background: false }]))
  const bg = (entry) => platform === 'darwin' && entry.uid !== 0 && entry.pri === 4
  const allBackground = Object.fromEntries(KINDS.map((kind) => [kind, true]))
  for (const { entry, kind } of members) {
    const slot = kinds[kind]
    slot.count++
    slot.cpu += entry.cpu
    slot.cpuSeconds += entry.cpuSeconds ?? 0
    slot.rssBytes += entry.rssKb * 1024
    if (!bg(entry)) allBackground[kind] = false
  }
  for (const kind of KINDS) {
    kinds[kind].cpu = Math.round(kinds[kind].cpu * 10) / 10
    kinds[kind].cpuSeconds = Math.round(kinds[kind].cpuSeconds * 100) / 100
    kinds[kind].background = kinds[kind].count > 0 && allBackground[kind]
  }
  const live = members.filter(({ entry }) => !entry.stat.startsWith('Z'))
  return {
    cpu: Math.round(members.reduce((sum, { entry }) => sum + entry.cpu, 0) * 10) / 10,
    cpuSeconds: Math.round(members.reduce((sum, { entry }) => sum + (entry.cpuSeconds ?? 0), 0) * 100) / 100,
    rssBytes: members.reduce((sum, { entry }) => sum + entry.rssKb * 1024, 0),
    processes: members.length,
    nice: head?.nice ?? null,
    background: head ? bg(head) : false,
    stopped: live.length > 0 && live.every(({ entry }) => entry.stat.startsWith('T')),
    kinds,
    pids: members.map(({ entry }) => entry.pid),
    procs: members.map(({ entry, kind }) => ({ pid: entry.pid, kind, age: entry.age ?? null, cpuSeconds: entry.cpuSeconds ?? null })),
  }
}

// ── sessions ─────────────────────────────────────────────────────────────────

/** The session id from `--resume <uuid>` / `--resume=<uuid>`; null without one (`attachWaiting` takes it from the hook-recorded state then). */
export function sessionIdOf(args) {
  return /(?:^|\s)--resume[= ]([0-9a-f]{8}-[0-9a-f-]{27})(?:\s|$)/i.exec(args)?.[1] ?? null
}

const slugOf = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

/** Subagents of a session that wrote a transcript within the last 60 s: `~/.claude/projects/<slug>/<session>/subagents/*.jsonl`. Zero when the id or the folder is not known. */
export function activeSubagents(sessionId, cwd, { projectsDir = join(homedir(), '.claude', 'projects'), now = Date.now() } = {}) {
  if (!sessionId) return 0
  let dir = cwd ? join(projectsDir, slugOf(cwd), sessionId, 'subagents') : null
  try {
    if (!dir || !existsSync(dir)) {
      const slug = readdirSync(projectsDir).find((name) => existsSync(join(projectsDir, name, sessionId, 'subagents')))
      dir = slug ? join(projectsDir, slug, sessionId, 'subagents') : null
    }
    if (!dir) return 0
    return readdirSync(dir).filter((name) => name.endsWith('.jsonl') && now - statSync(join(dir, name)).mtimeMs < SUBAGENT_FRESH_MS).length
  } catch {
    return 0
  }
}

/** The `HEAD` file of the checkout that holds `cwd`: `.git/HEAD`, or, in a linked worktree (`.git` is a file `gitdir: <path>`), the `HEAD` of that gitdir. Null off a checkout. */
export function headFileOf(cwd) {
  for (let dir = cwd; dir; dir = dirname(dir) === dir ? null : dirname(dir)) {
    const dot = join(dir, '.git')
    try {
      const stat = statSync(dot)
      if (stat.isDirectory()) return join(dot, 'HEAD')
      const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'))?.[1]?.trim()
      return target ? join(isAbsolute(target) ? target : resolve(dir, target), 'HEAD') : null
    } catch {
      // no .git here — one level up
    }
  }
  return null
}

/** The branch of a folder, read from `HEAD` (no `git` process); null when detached or not a checkout. Cheap enough per poll; stage 5 may cache it by `headFileOf` mtime. */
export function branchOfCwd(cwd) {
  try {
    const file = headFileOf(cwd)
    return file ? /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(file, 'utf8'))?.[1]?.trim() ?? null : null
  } catch {
    return null
  }
}

const devPortIn = (cwd) => {
  try {
    const root = cwd ? findConfigRoot(cwd) : null
    const url = root ? devServerConfig(root)?.url : null
    return url ? new URL(url).port || null : null
  } catch {
    return null
  }
}

/**
 * Every Claude Code session of a process table (`claude --chrome-native-host` is the browser extension's helper, not a session). `cwdOf` is called once per session — it is the only `lsof`.
 * The seams (`cwdOf`, `taskOf`, `branchOf`, `devPortOf`, `projectsDir`, `now`) let a test run on a fake table without touching the machine.
 */
export function sessionRows(table, { cwdOf = readCwd, taskOf = taskInfo, branchOf = branchOfCwd, devPortOf = devPortIn, projectsDir, now = Date.now(), platform } = {}) {
  const rows = []
  const perCwd = new Map() // the task, the branch and the dev port of a folder are read once per distinct folder
  const about = (cwd) => {
    if (!perCwd.has(cwd)) {
      let task = { key: null, task: false }
      try {
        task = taskOf(cwd)
      } catch {
        // a folder that is not a repo: no task
      }
      perCwd.set(cwd, { task, branch: branchOf(cwd), devPort: devPortOf(cwd) })
    }
    return perCwd.get(cwd)
  }
  for (const entry of table.values()) {
    if (!isClaude(entry.args) || /--chrome-native-host\b/.test(entry.args)) continue
    const cwd = cwdOf(entry.pid) ?? null
    const { task, branch, devPort } = cwd ? about(cwd) : { task: { key: null, task: false }, branch: null, devPort: devPortOf(cwd) }
    const sessionId = sessionIdOf(entry.args)
    rows.push({
      pid: entry.pid,
      cwd,
      branch,
      task: cwd && task.task ? task.key : null,
      ticket: cwd && task.task ? task.ticket ?? null : null,
      taskDir: cwd && task.task ? task.taskDir ?? null : null,
      root: cwd ? task.root ?? (task.task ? null : task.key ?? null) : null,
      sessionId,
      age: entry.age,
      subagents: activeSubagents(sessionId, cwd, { projectsDir, now }),
      load: classifyTree(table, entry.pid, { devPort, platform }),
    })
  }
  return rows.sort((a, b) => a.pid - b.pid)
}

/** The state files of the session-wait hook (stage 4): `sessions/<id>.json` of the data dir, each with its `sessionId` (the file name). Unreadable files and files untouched for 7 days are skipped; nothing is deleted here. */
export function readWaitStates(dir = join(pluginDataDir(), 'sessions'), { now = Date.now() } = {}) {
  const states = []
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        if (now - statSync(join(dir, name)).mtimeMs > WAIT_STATE_MAX_AGE_MS) continue // a killed session never sent SessionEnd; the hook deletes such files
        const value = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        if (value && typeof value === 'object') states.push({ ...value, sessionId: name.slice(0, -5) })
      } catch {
        // a half-written or foreign file
      }
    }
  } catch {
    // no directory: no state
  }
  return states
}

const transcriptMoved = (state, mtimeOf) => {
  if (!state.transcript) return false
  try {
    return mtimeOf(state.transcript) > state.since + WAIT_TRANSCRIPT_GRACE_MS
  } catch {
    return false
  }
}

/** An approved permission whose command runs: the Bash tool's shell (its args carry `shell-snapshots/snapshot-`) started after `since` is in the session's process tree; PostToolUse comes only when the command ends. */
const approvedAndRunning = (state, session, table, now) =>
  state.kind === 'permission' && Boolean(table) && descendants(table, session.pid).some((entry) => /shell-snapshots\/snapshot-/.test(entry.args) && now - (entry.age ?? 0) * 1000 >= state.since - 1000)

/**
 * Gives every session `waiting` ({ kind, text, options, since } or null) from the hook's state files (AC-4.5, D11). A state belongs to a session when its id is the session's
 * `--resume` id, or when its `claudePid` is the session's process and it was written after that process started (a reused pid keeps no old state). The newest state of a session wins and
 * its id becomes the session's `sessionId` when the session has none (no `--resume`) or an older one. A state is dropped when its transcript changed more than 5 s after `since`; a state
 * of a process that is not in the table (a dead session) matches nothing. Returns the waiting list too, oldest `since` first (the page's "waiting for you" block).
 */
export function attachWaiting(sessions, states, { now = Date.now(), mtimeOf = (path) => statSync(path).mtimeMs, table = null } = {}) {
  const waiting = []
  for (const session of sessions) {
    const started = now - (session.age ?? 0) * 1000 - 2000
    const own = states
      .filter((state) => (session.sessionId && state.sessionId === session.sessionId) || (state.claudePid === session.pid && state.since >= started))
      .sort((a, b) => b.since - a.since)
    const latest = own[0]
    if (latest && latest.sessionId !== session.sessionId && (!session.sessionId || latest.claudePid === session.pid)) session.sessionId = latest.sessionId
    const state = own.find((item) => item.sessionId === session.sessionId) ?? latest
    session.waiting = state?.kind && !transcriptMoved(state, mtimeOf) && !approvedAndRunning(state, session, table, now) ? { kind: state.kind, text: state.text ?? '', options: state.options ?? [], since: state.since } : null
    if (session.waiting) {
      waiting.push({ ...session.waiting, sessionId: session.sessionId, pid: session.pid, cwd: session.cwd, task: session.task, ticket: session.ticket, root: session.root })
    }
  }
  return waiting.sort((a, b) => a.since - b.since)
}

// ── the balancer and the machine ─────────────────────────────────────────────

/** The place of a task key in the balancer's order, 1 first; null when it is not in the order (`placeOf` of heavy-queue.mjs answers `length + 1` there, which is a `nice` rule, not a place). */
export const placeIn = (order, key) => (order.includes(key) ? placeOf(order, key) : null)

/**
 * Running and waiting heavy commands with a state — `running`, `waiting` (not admitted yet, with the balancer's reason), `throttled` (in the background under load), `paused` — and the reason.
 * `session` is the pid of the Claude session whose tree holds the command (null when it is not in the table).
 */
export function balanceRows({ running, waiting, priorities, load, sessions = [], now = Date.now(), platform = process.platform }) {
  const pauseSupported = platform !== 'win32' // D16: no pause on Windows, so none is shown
  const pausedKeys = pauseSupported ? priorities.paused : []
  const owner = (pid) => sessions.find((session) => session.load.pids.includes(pid))?.pid ?? null
  const row = (entry, state, reason) => ({
    pid: entry.pid, key: entry.key, command: entry.command, kind: entry.kind ?? 'check', state, reason, place: placeIn(priorities.order, entry.key), session: owner(entry.pid),
    expectedBytes: entry.expectedBytes ?? null, waitedSeconds: entry.since ? Math.round((now - entry.since) / 1000) : null,
  })
  const loadText = `cpu: load ${Number(load?.load ?? 0).toFixed(1)} of ${load?.cores ?? cpus().length}`
  return {
    heavy: [
      ...running.map((entry) => {
        if ((pauseSupported && entry.paused) || pausedKeys.includes(entry.key)) return row(entry, 'paused', 'paused by the user')
        if (entry.background) return row(entry, 'throttled', loadText)
        return row(entry, 'running', '')
      }),
      ...waiting.map((entry) => (pausedKeys.includes(entry.key) ? row(entry, 'paused', 'paused by the user') : row(entry, 'waiting', entry.reason || 'looking'))),
    ],
    paused: pausedKeys,
    pauseSupported,
    order: priorities.order,
  }
}

/** `{ used, total }` of swap in bytes; null where the machine does not say. */
export function readSwap() {
  try {
    if (process.platform === 'darwin') {
      const text = spawnSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).stdout
      const mb = (name) => Number(new RegExp(`${name} = ([\\d.]+)M`).exec(text)?.[1])
      return Number.isFinite(mb('used')) ? { used: mb('used') * 1024 ** 2, total: mb('total') * 1024 ** 2 } : null
    }
    if (process.platform === 'linux') {
      const text = readFileSync('/proc/meminfo', 'utf8')
      const kb = (name) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text)?.[1])
      return Number.isFinite(kb('SwapTotal')) ? { used: (kb('SwapTotal') - kb('SwapFree')) * 1024, total: kb('SwapTotal') * 1024 } : null
    }
  } catch {
    // no reading
  }
  return null
}

export function machineRow({ memory = readMemory(), load = readLoad(), swap = readSwap() } = {}) {
  return {
    pressure: memory?.pressure ?? null,
    availableBytes: memory?.availableBytes ?? null,
    totalBytes: totalmem(),
    swapUsedBytes: swap?.used ?? null,
    swapTotalBytes: swap?.total ?? null,
    load: load?.load ?? null,
    cores: load?.cores || cpus().length,
  }
}

// ── the snapshot ─────────────────────────────────────────────────────────────

/**
 * Rows for the tasks that sessions work on but the registry does not list (a repo outside `knownTaskDirs`, e.g. a repo whose task directory no session of this plugin has registered): the task directory comes
 * from the session's own config (`taskInfo`), the row has `registered: false`. Their key and root are the session's, so the table and the balancer match them.
 */
function unregisteredRows(sessions, tasks) {
  const known = new Set(tasks.map((task) => task.key))
  const extra = []
  for (const session of sessions) {
    if (!session.task || !session.taskDir || known.has(session.task)) continue
    const row = taskRows([session.taskDir]).find((item) => item.ticket === session.ticket)
    if (!row) continue
    known.add(session.task)
    extra.push({ ...row, key: session.task, root: session.root ?? row.root, repo: basename(session.root ?? row.root), registered: false })
  }
  return extra
}

/** Never throws: a failed part becomes a `problem` line, the rest of the snapshot stays. */
export function collect({ table, ...seams } = {}) {
  const problems = []
  const guarded = (name, fn, fallback) => {
    try {
      return fn()
    } catch (error) {
      problems.push(`${name}: ${error?.message ?? error}`)
      return fallback
    }
  }
  const tasks = guarded('tasks', () => taskRows(seams.taskDirs), [])
  const processes = table === undefined ? processStats() : table
  let sessions = []
  let waiting = []
  if (processes === null) problems.push('ps is missing or did not answer in time: no processes in the snapshot')
  else {
    sessions = guarded('sessions', () => sessionRows(processes, seams), [])
    const known = new Map(sessions.map((session) => [session, session.sessionId]))
    waiting = guarded('waiting', () => attachWaiting(sessions, seams.waitStates ?? readWaitStates(), { now: seams.now, mtimeOf: seams.mtimeOf, table: processes }), [])
    for (const session of sessions) {
      if (session.sessionId !== known.get(session)) session.subagents = activeSubagents(session.sessionId, session.cwd, { projectsDir: seams.projectsDir, now: seams.now })
    }
    if (sessions.some((session) => session.cwd === null)) problems.push('lsof is missing or did not answer: the folder of some sessions is unknown')
  }
  tasks.push(...guarded('session tasks', () => unregisteredRows(sessions, tasks), []))
  const priorities = guarded('priorities', () => readPriorities(), { version: 1, order: [], paused: [] })
  const noLoad = { load: 0, cores: cpus().length }
  const load = seams.machine && 'load' in seams.machine ? seams.machine.load ?? noLoad : guarded('load', () => readLoad(), noLoad)
  const balance = guarded('balance', () => balanceRows({ running: readRunning(), waiting: readWaiting(), priorities, load, sessions, platform: seams.platform }), { heavy: [], paused: [], pauseSupported: true, order: [] })
  const machine = guarded('machine', () => machineRow({ load: seams.machine && 'load' in seams.machine ? seams.machine.load : load, ...seams.machine }), null)
  return { at: new Date().toISOString(), tasks, sessions, waiting, balance, machine, problem: problems.length ? problems.join('; ') : null }
}

// ── the table ────────────────────────────────────────────────────────────────

const gb = (bytes) => (bytes === null || bytes === undefined ? '?' : `${(bytes / GB).toFixed(1)} GB`)
const pad = (text, width) => String(text).padEnd(width)

/** The compact table: one row per session (task, stage N/M, session, heavy now, CPU, memory, place, pause) and a machine line. */
export function renderTable(snapshot) {
  const byKey = new Map(snapshot.tasks.map((task) => [task.key, task]))
  const rows = snapshot.sessions.map((session) => {
    const task = session.task ? byKey.get(session.task) : null
    const heavy = snapshot.balance.heavy.filter((item) => item.session === session.pid)
    const key = session.task ?? session.root
    return [
      task ? `${task.repo}#${task.ticket}` : session.cwd ? basename(session.cwd) : '?',
      task?.stageNumber ? `${task.stageNumber}/${task.stageTotal}` : '-',
      String(session.pid),
      heavy.length ? heavy.map((item) => `${item.kind}:${item.state}`).join(',') : '-',
      `${session.load.cpu}%`,
      gb(session.load.rssBytes),
      String(key ? placeIn(snapshot.balance.order, key) ?? '-' : '-'),
      snapshot.balance.pauseSupported === false ? '' : snapshot.balance.paused.includes(key) ? 'paused' : session.load.stopped ? 'stopped' : '',
    ]
  })
  const head = ['TASK', 'STAGE', 'SESSION', 'HEAVY NOW', 'CPU', 'MEMORY', 'PLACE', 'PAUSE']
  const widths = head.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)))
  const lines = [head, ...rows].map((row) => row.map((cell, index) => pad(cell, widths[index])).join('  ').trimEnd())
  const waiting = snapshot.balance.heavy.filter((item) => item.state === 'waiting' || item.state === 'throttled')
  for (const item of waiting) lines.push(`  ${item.state}: ${item.key} ${item.command} — ${item.reason}`)
  const machine = snapshot.machine
  if (machine) {
    lines.push(
      `machine: memory ${machine.pressure ?? 'no readings'}, available ${gb(machine.availableBytes)} of ${gb(machine.totalBytes)}; swap ${gb(machine.swapUsedBytes)} of ${gb(machine.swapTotalBytes)}; load ${Number(machine.load).toFixed(1)} on ${machine.cores} cores`,
    )
  }
  const open = snapshot.tasks.filter((task) => task.open || task.problem).length
  lines.push(`tasks: ${snapshot.tasks.length} in the registry, ${open} open${snapshot.tasks.some((task) => task.problem) ? ', some unreadable' : ''}`)
  if (snapshot.problem) lines.push(`problem: ${snapshot.problem}`)
  return lines.join('\n')
}

if (isMain(import.meta.url)) {
  const json = process.argv.includes('--json')
  let snapshot
  try {
    snapshot = collect()
  } catch (error) {
    snapshot = { at: new Date().toISOString(), tasks: [], sessions: [], balance: { heavy: [], paused: [], pauseSupported: true, order: [] }, machine: null, problem: `monitor: ${error?.message ?? error}` }
  }
  console.log(json ? JSON.stringify(snapshot, null, 2) : renderTable(snapshot))
}
