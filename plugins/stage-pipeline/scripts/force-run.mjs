#!/usr/bin/env node
/**
 * One headless force run of one task — no human at the screen.
 *
 *   node force-run.mjs <repo> <TICKET>
 *
 * What it does: checks the task is ready (an open Force block with the `Confirmed:` line), finds the task's worktree or creates it next to the repo from the
 * branch in the STAGES.md header (the main copy's HEAD and status are not touched; a task branch checked out in the main copy is refused), starts a fresh `claude -p "/stage-pipeline:stage-force <TICKET> …"` session
 * there, writes the raw stream-json to a log file in the task folder, writes every `rate_limit_event` and exactly one outcome into the run record
 * `force-runs/<TICKET>.jsonl` of the plugin data directory. On macOS the machine is kept awake with `caffeinate -i -w <pid>`.
 *
 * Outcomes (the record's `outcome`, the exit code): completed 0 · error 1 · not ready or no binary 2 · limit 3 · stopped 4.  The loop adds: weekly limit 5 · spend limit 6 · gave up 7.
 *   completed  the session ended and the Force block heading is closed
 *   limit      `usage_limit_reached` (an assistant message with `apiError`, or an error `result`): the window and `resetsAt` come with it
 *   stopped    the session ended (or was interrupted) and the block is still open
 *   error      a non-zero exit code, an error `result` or another API error, with the text
 *
 * `runLoop` is the one-task loop (the default of the CLI; `--once` runs one session): after `limit` of the `five_hour` window it waits until `resetsAt` plus a margin (holding
 * `caffeinate -i -w <launcher pid>`) and starts a NEW session of the same task in the same worktree (never `--resume`); the weekly limit, a monthly spend limit of the organization,
 * a second short failure in a row (`computer_slept`, `connection_failed`), any other error and N new sessions in a row without a newly closed stage stop the task with a status.
 *
 *   node force-run.mjs <repo> <TICKET> [--once] [--margin-min 5] [--max-sessions 3] [--retries 1]
 *
 * Tests shrink the wait with the env `FORCE_RUN_WAIT_SCALE` (a multiplier of the wait; 0 skips it). The queue of tasks is not here: it imports `prepareRun`, `prepareWorktree`, `runLoop`, `taskReadiness`, `acquirePidLock`, `ticketLockFile`, `waitUntil` and the helpers `EXIT`, `TICKET`, `findOnPath`, `gitOk`, `numberFlag`.
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lastForceBlock } from './journal-check.mjs'
import { taskWorktree } from './ci-gates.mjs'
import { CLOSED_WORD, CONFIRMED_LINE } from './markers.mjs'
import { alive } from './processes.mjs'
import { resumePoint, stageList } from './resume-point.mjs'
import { mainRoot, pluginDataDir, readPipelineState, readTaskFile, realOr } from './hooks/pipeline-state.mjs'

export const EXIT = { completed: 0, error: 1, notReady: 2, limit: 3, stopped: 4, weekly: 5, spend: 6, gaveUp: 7 }
const FIVE_HOURS_S = 5 * 3600
const WINDOWS = ['five_hour', 'seven_day']
export const TICKET = /^[\w.-]+$/

const say = (text) => console.log(`force-run: ${text}`)

// ── the stream ───────────────────────────────────────────────────────────────

/** One line of the stream-json output → the event object, or null for a line that is not JSON (a stderr echo, a banner). */
function parseStreamLine(line) {
  const text = String(line).trim()
  if (!text.startsWith('{')) return null
  try {
    const event = JSON.parse(text)
    return event && typeof event === 'object' ? event : null
  } catch {
    return null
  }
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const windowOf = (raw) => (raw && typeof raw === 'object' ? { utilization: num(raw.utilization), resetsAt: num(raw.resetsAt), status: typeof raw.status === 'string' ? raw.status : null } : null)

/**
 * A `rate_limit_event` → `{ five_hour, seven_day }` with `utilization`, `resetsAt`, `status` (null for a window the event does not carry), or null for another event.
 * The windows come in `unifiedWindows` (on the event or in its `rate_limit_info`); an event that names one window by `rateLimitType` carries just that one.
 */
function rateLimitWindows(event) {
  if (event?.type !== 'rate_limit_event') return null
  const info = event.rate_limit_info ?? event
  const unified = info.unifiedWindows ?? event.unifiedWindows ?? {}
  const out = {}
  for (const name of WINDOWS) out[name] = windowOf(unified[name]) ?? (info.rateLimitType === name ? windowOf(info) : null)
  return out
}

const textOf = (event) => (typeof event.result === 'string' ? event.result : (event.message?.content ?? []).find?.((part) => part?.type === 'text')?.text ?? '')
const WINDOW_NAMES = { five_hour: /session|5.?hour|five/i, seven_day: /week|7.?day|seven/i }
const windowFromText = (text) => WINDOWS.find((name) => WINDOW_NAMES[name].test(text ?? '')) ?? null

/**
 * A usage limit in an event: the assistant message with `apiError: "usage_limit_reached"` (`apiErrorParams.rate_limit_info`), or an error `result` that says so
 * (`apiError` / `api_error_status` 429 / the "hit your … limit" text). `{ window, resetsAt, reason, spend, text }` — the window and `resetsAt` are null when the event does not carry them;
 * `reason` is `overageDisabledReason`, `spend` says the text is about a spend limit.
 */
function limitInfo(event) {
  if (!event || typeof event !== 'object') return null
  const apiError = event.apiError ?? event.message?.apiError
  const text = textOf(event)
  const hitLimit = /hit your .*limit|usage limit reached|usage_limit_reached/i.test(text)
  const isLimit =
    (event.type === 'assistant' && apiError === 'usage_limit_reached') ||
    (event.type === 'result' && event.is_error === true && (apiError === 'usage_limit_reached' || hitLimit || (event.api_error_status === 429 && /limit/i.test(text))))
  if (!isLimit) return null
  const info = event.apiErrorParams?.rate_limit_info ?? event.message?.apiErrorParams?.rate_limit_info ?? {}
  return {
    window: WINDOWS.includes(info.rateLimitType) ? info.rateLimitType : windowFromText(text),
    resetsAt: num(info.resetsAt),
    reason: typeof info.overageDisabledReason === 'string' ? info.overageDisabledReason : null,
    spend: /spend limit/i.test(text),
    text: String(text).slice(0, 300),
  }
}

/**
 * What a `limit` outcome is for the loop: `five_hour` (wait), `seven_day` (stop), `spend` (a monthly spend limit of the organization: stop) or `unknown` (stop).
 * A real five-hour limit can carry `overageDisabledReason: "out_of_credits"` too, so the reason alone is not a sign: the text, an `org_level_disabled…` reason, or a `resetsAt`
 * further than the five hours (and a quarter hour) from `nowS` decide.
 */
function limitKind({ window, resetsAt, reason, spend }, nowS = Date.now() / 1000) {
  if (spend || /^org_level_disabled/.test(reason ?? '')) return 'spend'
  if (window === 'five_hour' && resetsAt !== null && resetsAt - nowS > FIVE_HOURS_S + 900) return 'spend'
  return window ?? 'unknown'
}

const TRANSIENT = /computer[_ ]slept|connection[_ ]failed/i
/**
 * A short failure that a new session may survive: `computer_slept` or `connection_failed`, as `apiError` of an assistant message or in the text of an error `result`.
 * `{ name, source: 'apiError' | 'result' }` or null.
 */
function transientInfo(event) {
  if (!event || typeof event !== 'object') return null
  const apiError = event.apiError ?? event.message?.apiError
  if (event.type === 'assistant' && TRANSIENT.test(apiError ?? '')) return { name: apiError.toLowerCase().replace(' ', '_'), source: 'apiError' }
  if (event.type === 'result' && event.is_error === true) {
    const found = TRANSIENT.exec(`${apiError ?? ''} ${textOf(event)}`)
    if (found) return { name: found[0].toLowerCase().replace(' ', '_'), source: 'result' }
  }
  return null
}

// ── the record ───────────────────────────────────────────────────────────────

const recordFile = (ticket, dataDir = pluginDataDir()) => join(dataDir, 'force-runs', `${ticket}.jsonl`)

/** One line of the run record `force-runs/<TICKET>.jsonl`: `{ ts, ticket, session, type, … }` — types `start`, `rate_limit`, `outcome`. */
function recordRun(ticket, entry, dataDir = pluginDataDir()) {
  if (!TICKET.test(ticket)) throw new Error(`not a ticket: ${ticket}`)
  const file = recordFile(ticket, dataDir)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ticket, ...entry })}\n`)
}

// ── the machine ──────────────────────────────────────────────────────────────

/**
 * macOS: `caffeinate -i -w <pid>` keeps the machine awake while the process lives. The child, or null (not macOS, no binary, no pid); `notice` gets the one line that says why it does not run.
 * `caffeinate -i` stops idle sleep only: a closed lid still sleeps the machine.
 */
function keepAwake(pid, pathEnv, what, notice) {
  if (process.platform !== 'darwin' || !pid) return null
  const caffeinate = findOnPath('caffeinate', pathEnv)
  if (!caffeinate) {
    notice(`caffeinate not found, the machine may sleep during this ${what}`)
    return null
  }
  const awake = spawn(caffeinate, ['-i', '-w', String(pid)], { stdio: 'ignore' })
  awake.on('error', () => notice(`caffeinate could not start — the machine may sleep during this ${what}`))
  return awake
}

/** A binary on the PATH (an executable regular file), or null. */
export function findOnPath(name, pathEnv = process.env.PATH ?? '') {
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const file = join(dir, name)
    try {
      if (statSync(file).isFile()) {
        accessSync(file, constants.X_OK)
        return file
      }
    } catch {
      // not here
    }
  }
  return null
}

const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
export const gitOk = (cwd, ...args) => {
  try {
    return gitIn(cwd, ...args)
  } catch {
    return null
  }
}

/**
 * The worktree of the task: the one where one of the header's branches is checked out, or a new one next to the repo (`<repo>-<ticket>`) made from the first branch that exists
 * (local, else `origin/`). Only `git worktree add` runs: the HEAD, the index and the status of the repo it is called on stay as they were.
 * `{ path, created }` or `{ problem }`.
 */
function ensureWorktree(repo, task) {
  const branches = task.branches ?? []
  if (!branches.length) return { problem: `no branch in the header of ${task.stagesPath} (a "Branch:" line) — nothing to make a worktree from` }
  // `current: false`: the caller may be the task worktree itself, and a "current" task would make `taskWorktree` answer with the caller whatever is checked out there
  const found = taskWorktree(repo, { ...task, current: false })
  const main = realOr(mainRoot(repo) ?? repo)
  const at = gitOk(found, 'symbolic-ref', '--short', '-q', 'HEAD')
  if (at && branches.includes(at)) {
    if (realOr(found) === main) return { problem: `the task branch ${at} is checked out in the main copy (${main}) — switch the main copy to another branch; the run needs its own worktree and does not touch the main copy` }
    return { path: found, created: false }
  }
  const path = join(dirname(main), `${basename(main)}-${task.ticket.toLowerCase()}`)
  if (existsSync(path)) return { problem: `${path} exists but does not have ${branches.join(' / ')} checked out — remove it or check the branch out there` }
  for (const branch of branches) {
    try {
      if (gitOk(repo, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`)) gitIn(repo, 'worktree', 'add', path, branch)
      else if (gitOk(repo, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`)) gitIn(repo, 'worktree', 'add', '--track', '-b', branch, path, `origin/${branch}`)
      else continue
      return { path, created: true }
    } catch (error) {
      return { problem: `git worktree add ${path} ${branch} failed: ${gitError(error, 300)}` }
    }
  }
  return { problem: `branch ${branches.join(' / ')} exists neither locally nor on origin — nothing to make a worktree from` }
}

/** The text of a failed git call, trimmed to `max` characters. */
const gitError = (error, max) => String(error.stderr ?? error.message).trim().slice(0, max)
const fetchLine = (error) => gitError(error, 400).split('\n')[0].slice(0, 200)

/**
 * `git fetch origin <branch>` for each branch of the task, from the main copy (only the remote-tracking refs move). True when at least one fetch worked; otherwise ONE line
 * says why (no origin, no network, a branch that is not on origin) and the run goes on with the local branch.
 */
function fetchBranches(repo, branches, ticket) {
  if (!gitOk(repo, 'remote', 'get-url', 'origin')) {
    say(`${ticket}: no origin remote — going on with the local branch`)
    return false
  }
  let failure = null
  let worked = false
  // A night fetch never waits on a prompt: no terminal prompt, no SSH password question. The person's own GIT_SSH_COMMAND or GIT_SSH stands as it is. The env variable overrides the
  // repo's `core.sshCommand` (a key of a second account, say), so that command is the base of ours.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (!process.env.GIT_SSH_COMMAND && !process.env.GIT_SSH) env.GIT_SSH_COMMAND = `${gitOk(repo, 'config', '--get', 'core.sshCommand') || 'ssh'} -o BatchMode=yes`
  for (const branch of branches) {
    try {
      // an explicit refspec: in a --single-branch or shallow clone a bare `git fetch origin <b>` writes only FETCH_HEAD, and origin/<b> would stay old
      execFileSync('git', ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, env })
      worked = true
    } catch (error) {
      failure ??= fetchLine(error)
    }
  }
  if (!worked) say(`${ticket}: git fetch origin ${branches.join(' / ')} failed (${failure}) — going on with the local branch`)
  return worked
}

/** The worktree's branch against `origin/<branch>` after a fetch: behind and clean → `merge --ff-only`; ahead or equal → as it is; diverged (or behind with edits) → `{ problem }` naming both SHAs. */
function syncBranch(worktree, ticket) {
  const branch = gitOk(worktree, 'symbolic-ref', '--short', '-q', 'HEAD')
  const local = gitOk(worktree, 'rev-parse', 'HEAD')
  const remote = branch ? gitOk(worktree, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`) : null
  if (!local || !remote || local === remote) return {}
  if (gitOk(worktree, 'merge-base', '--is-ancestor', remote, local) !== null) return {}
  const shas = `local ${local.slice(0, 12)}, origin/${branch} ${remote.slice(0, 12)}`
  if (gitOk(worktree, 'merge-base', '--is-ancestor', local, remote) === null) return { problem: `${branch} has diverged from origin (${shas}) in ${worktree} — merge or rebase it by hand, then start again` }
  if (gitOk(worktree, 'status', '--porcelain', '--untracked-files=no') !== '') return { problem: `${branch} is behind origin (${shas}) and ${worktree} has uncommitted changes — commit or discard them, then start again` }
  try {
    gitIn(worktree, 'merge', '--ff-only', '-q', remote)
  } catch (error) {
    return { problem: `git merge --ff-only origin/${branch} failed in ${worktree}: ${fetchLine(error)}` }
  }
  say(`${ticket}: ${branch} fast-forwarded to origin (${local.slice(0, 12)} → ${remote.slice(0, 12)})`)
  return {}
}

/**
 * The hooks of a session in the worktree must see the task, or git-guard, floor-guard and journal-gate stay silent all night: a committed config with a relative `task_path`
 * makes the worktree read its own empty tasks folder. A problem text with the remedy (the local config is the person's to write), or null.
 */
function hiddenFromHooks(worktree, task, taskDir) {
  let seen = null
  try {
    seen = readPipelineState(worktree)?.tasks.find((item) => item.ticket === task.ticket) ?? null
  } catch {
    // unreadable: treated as not seen
  }
  // The copy comes first: for the task's own folder an open run is already checked by `taskReadiness`, so a closed one seen here is a stale copy's.
  if (seen?.current && realOr(seen.dir) !== realOr(task.dir)) {
    return `${worktree} has its own copy of the task folder (${seen.dir}) and the hooks of a session there would read that stale copy, not ${task.dir}. Remove the copy or point the worktree at ${taskDir} with a line in ${join(worktree, '.claude/pipeline.config.local.md')}:\n- task_path: ${taskDir}`
  }
  if (seen?.current && seen.forceActive) return null
  return `the hooks of a session in ${worktree} do not see ${task.ticket} as the current task with an open Force block (the worktree reads its own task folder), so the commit and journal guards would be silent all night. Create ${join(worktree, '.claude/pipeline.config.local.md')} with the line:\n- task_path: ${taskDir}`
}

/**
 * The worktree a night run can start in: the branch is fetched, the worktree is found or made (`ensureWorktree`), fast-forwarded to origin, and its hooks see the task.
 * `taskDir` is the task folder of the main copy. `{ path, created }` or `{ problem }`; `fetch: false` skips the fetch and the fast-forward (the second call of one run).
 */
export function prepareWorktree(repo, task, taskDir, { fetch = true } = {}) {
  const branches = task.branches ?? []
  const fetched = fetch && branches.length ? fetchBranches(repo, branches, task.ticket) : false
  const tree = ensureWorktree(repo, task)
  if (tree.problem) return tree
  if (fetched) {
    const synced = syncBranch(tree.path, task.ticket)
    if (synced.problem) return synced
  }
  const hidden = hiddenFromHooks(tree.path, task, taskDir)
  return hidden ? { problem: hidden } : tree
}

/** The part of `prepareRun` that touches nothing: the task exists and has an open, confirmed Force block. `{ ok: true, state, task }` or `{ ok: false, code, message }`. */
export function taskReadiness(repo, ticket) {
  const fail = (message) => ({ ok: false, code: EXIT.notReady, message })
  if (!TICKET.test(ticket ?? '')) return fail(`not a ticket: ${ticket}`)
  const state = readPipelineState(resolve(repo))
  if (!state) return fail(`${repo} has no .claude/pipeline.config.md — not a stage-pipeline repo`)
  const task = state.tasks.find((item) => item.ticket === ticket)
  if (!task) return fail(`no task ${ticket} in ${state.taskDir}`)
  if (task.unreadable) return fail(`${task.stagesPath} cannot be read: ${task.unreadable.message}`)
  const block = lastForceBlock(task.stages)
  if (!block || CLOSED_WORD.test(block.heading) || !CONFIRMED_LINE.test(block.body)) {
    return fail(`${ticket} has no open Force block with a "Confirmed:" line — nothing was started. Ask the questions first: /stage-force ${ticket} --interview-only`)
  }
  if (!task.forceActive) {
    const status = task.status ? `"${task.status.slice(0, 80)}"` : '(none)'
    return fail(`the hooks do not count the Force run of ${ticket} as open: the status line of ${task.stagesPath} says ${status} — a run that is completed (with blockers) is closed. Update the "## Status:" line to say the run is in progress, then start again`)
  }
  return { ok: true, state, task }
}

/**
 * A lock by PID in a file made atomically (`wx`): `{ ok: true, release }`, or `{ ok: false, owner }` while the PID in it is alive. A file of a dead PID is taken over.
 * The file also goes when this process exits (`process.exit` included).
 */
export function acquirePidLock(file, label = '') {
  mkdirSync(dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, label, started: new Date().toISOString() }), { flag: 'wx' })
      const release = () => {
        process.removeListener('exit', release)
        try {
          if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) rmSync(file, { force: true })
        } catch {
          // already gone
        }
      }
      process.on('exit', release)
      return { ok: true, release }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    let owner = null
    try {
      owner = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      // being written by its owner right now, or garbage
    }
    if (owner && alive(owner.pid)) return { ok: false, owner }
    if (!owner) {
      try {
        if (Date.now() - statSync(file).mtimeMs < 2000) return { ok: false, owner: { pid: null, label: 'being created' } }
      } catch {
        continue
      }
    }
    // re-read right before removing: only the file of the same dead PID goes (a fresh file of a racing taker stays), and the `wx` create decides
    try {
      const again = JSON.parse(readFileSync(file, 'utf8'))
      if (owner && again.pid !== owner.pid) continue
    } catch {
      if (owner) continue
    }
    rmSync(file, { force: true })
  }
  return { ok: false, owner: { pid: null, label: 'could not take the lock' } }
}
export const ticketLockFile = (ticket, dataDir = pluginDataDir()) => join(dataDir, 'locks', `ticket-${ticket}.lock`)

/**
 * The rule of a print-mode session (B1): `claude -p` stops background agents about 10 minutes after the last turn, so a checker started in the background is lost
 * and the session ends `stopped`. stage-force says it too (Step 1); the prompt carries it so that the night does not hang on one line of a long skill.
 */
const HEADLESS =
  'This is a headless session (claude -p), nobody is at the screen: start every subagent with run_in_background: false (several in one message are fine) and end a turn only after they have returned — print mode stops background agents about 10 minutes after the last turn.'
const RESUME_MAX = 4000

/**
 * The prompt of one session (B2): the base prompt, how the previous session of this run ended, and the resume point of the state on disk. A new `claude -p` starts as
 * `startup`, and session-start prints the resume point only after a compact or a resume, so a session after a limit, a short failure or last night's stop would start
 * a half-done stage again over a dirty tree. No resume point (nothing to say, an unreadable journal) — the base prompt alone.
 */
function sessionPrompt(ctx, { dataDir = pluginDataDir(), previous = null } = {}) {
  let resume = null
  try {
    const state = readPipelineState(ctx.worktree)
    const task = state?.tasks.find((item) => item.ticket === ctx.ticket && !item.unreadable)
    resume = task ? resumePoint({ dataDir, state, task, budget: RESUME_MAX }) : null
  } catch {
    // no resume point: the base prompt stands
  }
  const ended = previous ? `The previous session of this run ended: ${previous.outcome}${previous.text ? ` (${previous.text})` : ''}.` : null
  return [ctx.prompt, ended, resume].filter(Boolean).join('\n\n')
}

/**
 * Everything before the session: the task is found, its Force block is open and confirmed, `claude` and `node` are on the PATH, the worktree is there.
 * `{ ok: true, ticket, repo, task, worktree, created, claude, node, prompt, env }` or `{ ok: false, code, message }` (code 2: the person has something to do first).
 */
export function prepareRun(repo, ticket, { pathEnv = process.env.PATH ?? '', fetch = true } = {}) {
  const ready = taskReadiness(repo, ticket)
  if (!ready.ok) return ready
  const { state, task } = ready
  const fail = (message) => ({ ok: false, code: EXIT.notReady, message })
  const claude = findOnPath('claude', pathEnv)
  if (!claude) return fail('`claude` is not on the PATH — nothing was started')
  const node = findOnPath('node', pathEnv) ?? process.execPath
  const tree = prepareWorktree(state.root, task, state.taskDir, { fetch })
  if (tree.problem) return fail(tree.problem)
  // A session of a worktree of the product repo may not find the journal of the main copy: the prompt carries its absolute path (A1).
  const prompt = `/stage-pipeline:stage-force ${ticket} — the journal of the task is ${task.stagesPath}; the Force block there is already confirmed, continue the run without asking questions. ${HEADLESS}`
  const dirs = [dirname(node), dirname(claude), process.env.HOME ? join(process.env.HOME, '.local/bin') : null].filter(Boolean)
  const env = { ...process.env, PATH: [...new Set([...dirs, ...pathEnv.split(delimiter).filter(Boolean)])].join(delimiter) }
  return { ok: true, ticket, repo: state.root, task, worktree: tree.path, created: tree.created, claude, node, prompt, env }
}

const stagesOf = (task) => readTaskFile(task.dir, 'STAGES.md') ?? ''
const closedNow = (task) => {
  const block = lastForceBlock(stagesOf(task))
  return Boolean(block && CLOSED_WORD.test(block.heading))
}
/** How many stages of STAGES.md are closed (the one definition of a closed stage: `stageList`). */
const closedStages = (task) => stageList(stagesOf(task)).filter((stage) => stage.done).length

/**
 * One fresh session: spawns `claude -p` with `sessionPrompt` (`previous`: the outcome of the session before it in this run), logs the raw stream, records the rate-limit events,
 * and records and returns exactly one outcome.
 * `{ outcome, session, log, code, window?, resetsAt?, kind?, reason?, transient?, interrupted?, text?, windows }` — `windows` is the last `rate_limit_event` read; `kind` is `limitKind` of a `limit`.
 * A file error of the launcher (the log, the record) kills the child and ends as `error` with its text.
 */
function runSession(ctx, { dataDir = pluginDataDir(), previous = null } = {}) {
  const { ticket, task, worktree, claude, env } = ctx
  const prompt = sessionPrompt(ctx, { dataDir, previous })
  const session = randomUUID()
  const log = join(task.dir, `force-run-${session}.log`)
  const note = (text) => {
    try {
      appendFileSync(log, `${text}\n`)
    } catch {
      // the log is gone: the outcome still goes to the record
    }
  }
  try {
    // the raw stream carries the session's prompts and tool output: the owner only
    appendFileSync(log, `session ${session} started ${new Date().toISOString()} in ${worktree}\n`, { mode: 0o600 })
    recordRun(ticket, { type: 'start', session, worktree, log }, dataDir)
  } catch (error) {
    return Promise.resolve({ outcome: 'error', session, log, code: null, windows: null, text: `launcher could not write its files: ${error.message}`.slice(0, 500) })
  }
  say(`${ticket}: session ${session} in ${worktree}, raw stream in ${log}`)
  const args = ['-p', prompt, '--session-id', session, '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose']

  return new Promise((done) => {
    let limit = null
    let result = null
    let windows = null
    let transient = null
    let spawnError = null
    let fileError = null
    let stderrTail = ''
    let carry = ''
    let interrupted = false
    let awake = null
    let hardKill = null

    const child = spawn(claude, args, { cwd: worktree, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const kill = () => {
      child.kill('SIGTERM')
      hardKill ??= setTimeout(() => child.kill('SIGKILL'), 5000)
    }
    // The first signal asks the child to end; a repeated one inside the grace window ends it at once, so no `claude` outlives the launcher.
    const stop = () => {
      if (interrupted) {
        clearTimeout(hardKill)
        child.kill('SIGKILL')
        return
      }
      interrupted = true
      kill()
    }
    // A file error in a handler: the child must not run on without anyone watching it.
    const guarded = (fn) => (...a) => {
      try {
        fn(...a)
      } catch (error) {
        fileError ??= error
        kill()
      }
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)

    awake = keepAwake(child.pid, env.PATH, 'run', (text) => {
      note(text)
      say(text)
    })

    const take = (line) => {
      const event = parseStreamLine(line)
      if (!event) return
      const rates = rateLimitWindows(event)
      if (rates) {
        windows = rates
        recordRun(ticket, { type: 'rate_limit', session, ...rates }, dataDir)
      }
      const hit = limitInfo(event)
      if (hit) {
        limit = {
          window: hit.window ?? limit?.window ?? null,
          resetsAt: hit.resetsAt ?? limit?.resetsAt ?? null,
          reason: hit.reason ?? limit?.reason ?? null,
          spend: hit.spend || Boolean(limit?.spend),
          text: hit.text || limit?.text || '',
        }
      }
      const short = transientInfo(event)
      if (short && (!transient || short.source === 'apiError')) transient = short
      // A later clean assistant message: the session survived the short failure, so it is no longer the cause of the end.
      else if (!short && transient && event.type === 'assistant' && !(event.apiError ?? event.message?.apiError)) transient = null
      if (event.type === 'result') result = event
    }
    const out8 = new StringDecoder('utf8')
    const err8 = new StringDecoder('utf8')
    child.stdout.on(
      'data',
      guarded((chunk) => {
        appendFileSync(log, chunk)
        const lines = (carry + out8.write(chunk)).split('\n')
        carry = lines.pop()
        lines.forEach(take)
      }),
    )
    child.stderr.on(
      'data',
      guarded((chunk) => {
        const text = err8.write(chunk)
        stderrTail = (stderrTail + text).slice(-2000)
        note(`[stderr] ${text.trimEnd()}`)
      }),
    )
    child.on('error', (error) => {
      spawnError = error
    })
    child.on('close', (code, signal) => {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
      clearTimeout(hardKill)
      guarded(() => {
        carry += out8.end()
        if (carry) take(carry)
      })()
      if (awake && awake.exitCode === null) awake.kill()
      let outcome
      const out = { session, log, code, windows, ...(interrupted ? { interrupted: true } : {}) }
      if (fileError) {
        Object.assign(out, { outcome: (outcome = 'error'), text: `launcher file error: ${fileError.message}`.slice(0, 500) })
      } else if (limit && !closedNow(task)) {
        // A closed Force block wins over a limit seen in the stream (a subagent's, say). The window comes with the event; when it does not, a rejected window of the last rate_limit_event names it.
        const rejected = windows && WINDOWS.find((name) => windows[name]?.status === 'rejected')
        const window = limit.window ?? rejected ?? null
        const resetsAt = limit.resetsAt ?? windows?.[window]?.resetsAt ?? null
        Object.assign(out, { outcome: (outcome = 'limit'), window, resetsAt, reason: limit.reason, kind: limitKind({ window, resetsAt, reason: limit.reason, spend: limit.spend }), text: limit.text })
        if (resetsAt !== null) out.resetsAtIso = new Date(resetsAt * 1000).toISOString()
      } else if (interrupted) {
        Object.assign(out, { outcome: (outcome = 'stopped'), interrupted: true, text: 'the launcher was interrupted' })
      } else if (transient && !closedNow(task)) {
        Object.assign(out, { outcome: (outcome = 'error'), transient: transient.name, transientSource: transient.source, text: `${transient.name} (in ${transient.source}): ${String(result?.result ?? stderrTail ?? '').trim().slice(0, 300)}` })
      } else if (spawnError || signal || code !== 0 || result?.is_error) {
        const reason = spawnError ? spawnError.message : result?.is_error ? String(result.result ?? result.subtype ?? 'error result') : signal ? `killed by ${signal}` : `exit code ${code}`
        Object.assign(out, { outcome: (outcome = 'error'), text: `${reason}${stderrTail && !result?.is_error ? ` — ${stderrTail.trim().slice(-300)}` : ''}`.slice(0, 500) })
      } else {
        outcome = closedNow(task) ? 'completed' : 'stopped'
        out.outcome = outcome
        if (outcome === 'stopped') out.text = 'the session ended with the Force block still open'
      }
      const { windows: _seen, ...entry } = out
      try {
        recordRun(ticket, { type: 'outcome', ...entry }, dataDir)
      } catch (error) {
        Object.assign(out, { outcome: 'error', text: `launcher could not record the outcome (${outcome}): ${error.message}`.slice(0, 500) })
      }
      note(`outcome ${out.outcome}${out.window ? ` ${out.window} resets ${out.resetsAtIso ?? '?'}` : ''}`)
      done(out)
    })
  })
}

/** Readiness, worktree, one session. `{ ok: false, code, message }` before the start, else the outcome of `runSession`. */
async function runForce(repo, ticket, options = {}) {
  const ctx = prepareRun(repo, ticket, options)
  if (!ctx.ok) return ctx
  if (ctx.created) say(`${ticket}: made worktree ${ctx.worktree}`)
  return { ok: true, ...(await runSession(ctx, options)) }
}

// ── the loop of one task ─────────────────────────────────────────────────────

/**
 * Holds until `targetMs` (wall clock), with `caffeinate -i -w <this pid>` on macOS so the machine does not sleep. Ctrl-C or SIGTERM ends it at once with `false`,
 * and the caffeinate goes with it. `true` when the time came.
 */
export function waitUntil(targetMs, pathEnv = process.env.PATH ?? '', now = Date.now) {
  return new Promise((done) => {
    let awake = null
    let timer = null
    const finish = (reached) => {
      clearTimeout(timer)
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
      if (awake && awake.exitCode === null) awake.kill()
      done(reached)
    }
    const onSignal = () => finish(false)
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    awake = keepAwake(process.pid, pathEnv, 'wait', say)
    // Short timers against the wall clock: a sleep of the machine or a clock jump does not leave a stale long timer.
    const tick = () => {
      const left = targetMs - now()
      if (left <= 0) finish(true)
      else timer = setTimeout(tick, Math.min(left, 30_000))
    }
    tick()
  })
}

/**
 * The loop of one task. Sessions of the same task run one after another in the same worktree, each a NEW `claude -p` (never `--resume`).
 * After `limit` of the `five_hour` window: wait until `resetsAt` + `marginMin`, then a new session. Stops (with `status`, `text`, `exit`): `completed`, `weekly_limit`, `spend_limit`,
 * `limit_unknown` (a limit with no usable window or time), `error` (also a second short failure in a row: more than `retries`), `stopped` (also an interrupt), `gave_up` (`maxSessions`
 * new sessions in a row without a newly closed stage). Every step lands in the run record (`type: 'status'`).
 * Returns `{ ok: false, code, message }` before the start, else `{ ok: true, status, text, exit, sessions, resetsAt?, last }`.
 */
export async function runLoop(repo, ticket, options = {}) {
  const { marginMin = 5, maxSessions = 3, retries = 1, dataDir = pluginDataDir(), now = Date.now } = options
  const scale = Number(options.scale ?? process.env.FORCE_RUN_WAIT_SCALE ?? 1)
  const ctx = prepareRun(repo, ticket, options)
  if (!ctx.ok) return ctx
  if (ctx.created) say(`${ticket}: made worktree ${ctx.worktree}`)
  let sessions = 0
  let fresh = 0 // new sessions in a row without a newly closed stage
  let shortFails = 0
  let closed = closedStages(ctx.task)
  let previous = null
  const status = (value, text, extra = {}) => {
    try {
      recordRun(ticket, { type: 'status', status: value, text, ...extra }, dataDir)
    } catch (error) {
      say(`could not record the status ${value}: ${error.message}`)
    }
  }
  const stopWith = (value, text, exit, last, extra = {}) => {
    status(value, text, extra)
    say(`${ticket}: ${value} — ${text}`)
    return { ok: true, status: value, text, exit, sessions, last, ...extra }
  }
  for (;;) {
    const out = await runSession(ctx, { ...options, dataDir, previous })
    previous = out
    sessions += 1
    const nowClosed = closedStages(ctx.task)
    if (nowClosed > closed) fresh = 0
    closed = nowClosed
    if (out.outcome === 'completed') return stopWith('completed', 'the Force block is closed', EXIT.completed, out)
    if (out.interrupted) return stopWith('stopped', 'the launcher was interrupted (Ctrl-C or SIGTERM)', EXIT.stopped, out, { interrupted: true })
    if (out.outcome === 'stopped') return stopWith('stopped', out.text, EXIT.stopped, out)
    const short = out.outcome === 'error' && out.transient
    shortFails = short ? shortFails + 1 : 0
    if (out.outcome === 'error' && !short) return stopWith('error', out.text, EXIT.error, out)
    if (short && shortFails > retries) return stopWith('error', `${out.text} — the same short failure again after ${retries} new session(s)`, EXIT.error, out)
    let waitUntilMs = null
    if (out.outcome === 'limit') {
      const when = out.resetsAtIso ? ` (resets ${out.resetsAtIso})` : ''
      if (out.kind === 'seven_day') return stopWith('weekly_limit', `stopped on the weekly limit${when}`, EXIT.weekly, out, { resetsAt: out.resetsAt })
      if (out.kind === 'spend') return stopWith('spend_limit', `stopped on a spend limit of the organization${when}: ${out.text}`, EXIT.spend, out, { resetsAt: out.resetsAt })
      if (out.kind !== 'five_hour' || out.resetsAt === null) return stopWith('limit_unknown', `a limit with no known window or reset time: ${out.text}`, EXIT.limit, out)
      waitUntilMs = out.resetsAt * 1000 + marginMin * 60_000
    }
    if (fresh >= maxSessions) {
      return stopWith('gave_up', `${maxSessions} new sessions in a row without a newly closed stage; last: ${out.outcome}${out.text ? ` — ${out.text}` : ''}`, EXIT.gaveUp, out)
    }
    if (waitUntilMs !== null) {
      const target = now() + Math.max(0, (waitUntilMs - now()) * scale)
      const iso = new Date(target).toISOString()
      status('waiting', `waiting until ${iso}`, { until: iso, window: out.window })
      say(`${ticket}: waiting until ${iso} (five_hour resets ${out.resetsAtIso} + ${marginMin} min margin)`)
      if (!(await waitUntil(target, ctx.env.PATH, now))) return stopWith('stopped', 'the launcher was interrupted while waiting for the reset', EXIT.stopped, out, { interrupted: true })
    }
    fresh += 1
    say(`${ticket}: new session ${sessions + 1} of the same task (${short ? `after ${out.transient}` : 'after the reset'})`)
    status('continuing', `new session ${sessions + 1}`)
  }
}

export const numberFlag = (argv, name, fallback) => {
  const at = argv.indexOf(name)
  if (at < 0) return fallback
  const value = Number(argv[at + 1])
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} needs a number >= 0`)
  argv.splice(at, 2)
  return value
}

async function main(argv) {
  const usage = () => {
    console.error('usage: force-run.mjs <repo> <TICKET> [--once] [--margin-min 5] [--max-sessions 3] [--retries 1]')
    process.exit(EXIT.notReady)
  }
  const args = [...argv]
  let options
  try {
    options = { marginMin: numberFlag(args, '--margin-min', 5), maxSessions: numberFlag(args, '--max-sessions', 3), retries: numberFlag(args, '--retries', 1) }
  } catch (error) {
    console.error(error.message)
    return usage()
  }
  const once = args.includes('--once')
  const rest = args.filter((arg) => arg !== '--once')
  if (rest.length !== 2 || rest.some((arg) => arg.startsWith('-'))) return usage()
  if (!TICKET.test(rest[1])) {
    say(`not a ticket: ${rest[1]}`)
    process.exit(EXIT.notReady)
  }
  try {
    const lock = acquirePidLock(ticketLockFile(rest[1]), 'force-run')
    if (!lock.ok) {
      say(`${rest[1]} is already being run (pid ${lock.owner.pid}, ${lock.owner.label}) — a second session in the same worktree is refused`)
      process.exit(EXIT.notReady)
    }
    if (!once) {
      const loop = await runLoop(rest[0], rest[1], options)
      if (!loop.ok) {
        say(loop.message)
        process.exit(loop.code)
      }
      process.exit(loop.exit)
    }
    const out = await runForce(rest[0], rest[1])
    if (!out.ok) {
      say(out.message)
      process.exit(out.code)
    }
    const detail = out.outcome === 'limit' ? ` — ${out.window ?? 'unknown window'}, resets ${out.resetsAtIso ?? 'at an unknown time'}` : out.text ? ` — ${out.text}` : ''
    say(`${rest[1]}: ${out.outcome}${detail}`)
    process.exit(EXIT[out.outcome] ?? EXIT.error)
  } catch (error) {
    say(`failed: ${error.message}`)
    process.exit(EXIT.error)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
