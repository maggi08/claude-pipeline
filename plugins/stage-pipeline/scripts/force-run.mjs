#!/usr/bin/env node
/**
 * One headless force run of one task — no human at the screen.
 *
 *   node force-run.mjs <repo> <TICKET>
 *
 * What it does: checks the task is ready (an open Force block with the `Confirmed:` line), finds the task's worktree or creates it next to the repo from the
 * branch in the STAGES.md header (the main copy's HEAD and status are not touched), starts a fresh `claude -p "/stage-pipeline:stage-force <TICKET> …"` session
 * there, writes the raw stream-json to a log file in the task folder, writes every `rate_limit_event` and exactly one outcome into the run record
 * `force-runs/<TICKET>.jsonl` of the plugin data directory. On macOS the machine is kept awake with `caffeinate -i -w <pid>`.
 *
 * Outcomes (the record's `outcome`, the exit code): completed 0 · error 1 · not ready or no binary 2 · limit 3 · stopped 4.
 *   completed  the session ended and the Force block heading is closed
 *   limit      `usage_limit_reached` (an assistant message with `apiError`, or an error `result`): the window and `resetsAt` come with it
 *   stopped    the session ended (or was interrupted) and the block is still open
 *   error      a non-zero exit code, an error `result` or another API error, with the text
 *
 * Waiting for a window to reset and the queue of tasks are not here: they import `prepareRun`, `runSession`, `parseStreamLine`, `recordRun`.
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lastForceBlock } from './journal-check.mjs'
import { taskWorktree } from './ci-gates.mjs'
import { CLOSED_WORD, CONFIRMED_LINE } from './markers.mjs'
import { pluginDataDir, readPipelineState, readTaskFile, realOr } from './hooks/pipeline-state.mjs'

export const EXIT = { completed: 0, error: 1, notReady: 2, limit: 3, stopped: 4 }
const WINDOWS = ['five_hour', 'seven_day']
const TICKET = /^[\w.-]+$/

const say = (text) => console.log(`force-run: ${text}`)

// ── the stream ───────────────────────────────────────────────────────────────

/** One line of the stream-json output → the event object, or null for a line that is not JSON (a stderr echo, a banner). */
export function parseStreamLine(line) {
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
export function rateLimitWindows(event) {
  if (event?.type !== 'rate_limit_event') return null
  const info = event.rate_limit_info ?? event
  const unified = info.unifiedWindows ?? event.unifiedWindows ?? {}
  const out = {}
  for (const name of WINDOWS) out[name] = windowOf(unified[name]) ?? (info.rateLimitType === name ? windowOf(info) : null)
  return out
}

const WINDOW_NAMES = { five_hour: /session|5.?hour|five/i, seven_day: /week|7.?day|seven/i }
const windowFromText = (text) => WINDOWS.find((name) => WINDOW_NAMES[name].test(text ?? '')) ?? null

/**
 * A usage limit in an event: the assistant message with `apiError: "usage_limit_reached"` (`apiErrorParams.rate_limit_info`), or an error `result` that says so
 * (`apiError` / `api_error_status` 429 / the "hit your … limit" text). `{ window, resetsAt, text }` — the window and `resetsAt` are null when the event does not carry them.
 */
export function limitInfo(event) {
  if (!event || typeof event !== 'object') return null
  const apiError = event.apiError ?? event.message?.apiError
  const text = typeof event.result === 'string' ? event.result : (event.message?.content ?? []).find?.((part) => part?.type === 'text')?.text ?? ''
  const hitLimit = /hit your .*limit|usage limit reached|usage_limit_reached/i.test(text)
  const isLimit =
    (event.type === 'assistant' && apiError === 'usage_limit_reached') ||
    (event.type === 'result' && event.is_error === true && (apiError === 'usage_limit_reached' || hitLimit || (event.api_error_status === 429 && /limit/i.test(text))))
  if (!isLimit) return null
  const info = event.apiErrorParams?.rate_limit_info ?? event.message?.apiErrorParams?.rate_limit_info ?? event.quotaLimits ?? {}
  return { window: WINDOWS.includes(info.rateLimitType) ? info.rateLimitType : windowFromText(text), resetsAt: num(info.resetsAt), text: String(text).slice(0, 300) }
}

// ── the record ───────────────────────────────────────────────────────────────

export const recordFile = (ticket, dataDir = pluginDataDir()) => join(dataDir, 'force-runs', `${ticket}.jsonl`)

/** One line of the run record `force-runs/<TICKET>.jsonl`: `{ ts, ticket, session, type, … }` — types `start`, `rate_limit`, `outcome`. */
export function recordRun(ticket, entry, dataDir = pluginDataDir()) {
  if (!TICKET.test(ticket)) throw new Error(`not a ticket: ${ticket}`)
  const file = recordFile(ticket, dataDir)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ticket, ...entry })}\n`)
}

// ── the machine ──────────────────────────────────────────────────────────────

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
const gitOk = (cwd, ...args) => {
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
export function ensureWorktree(repo, task) {
  const branches = task.branches ?? []
  if (!branches.length) return { problem: `no branch in the header of ${task.stagesPath} (a "Branch:" line) — nothing to make a worktree from` }
  const found = taskWorktree(repo, task)
  const at = gitOk(found, 'symbolic-ref', '--short', '-q', 'HEAD')
  if (at && branches.includes(at)) return { path: found, created: false }
  const path = join(dirname(realOr(repo)), `${basename(realOr(repo))}-${task.ticket.toLowerCase()}`)
  if (existsSync(path)) return { problem: `${path} exists but does not have ${branches.join(' / ')} checked out — remove it or check the branch out there` }
  for (const branch of branches) {
    try {
      if (gitOk(repo, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`)) gitIn(repo, 'worktree', 'add', path, branch)
      else if (gitOk(repo, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`)) gitIn(repo, 'worktree', 'add', '--track', '-b', branch, path, `origin/${branch}`)
      else continue
      return { path, created: true }
    } catch (error) {
      return { problem: `git worktree add ${path} ${branch} failed: ${String(error.stderr ?? error.message).trim().slice(0, 300)}` }
    }
  }
  return { problem: `branch ${branches.join(' / ')} of ${task.ticket} exists neither locally nor on origin — nothing to make a worktree from` }
}

/**
 * Everything before the session: the task is found, its Force block is open and confirmed, `claude` and `node` are on the PATH, the worktree is there.
 * `{ ok: true, ticket, repo, task, worktree, created, claude, node, prompt, env }` or `{ ok: false, code, message }` (code 2: the person has something to do first).
 */
export function prepareRun(repo, ticket, { pathEnv = process.env.PATH ?? '' } = {}) {
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
  const claude = findOnPath('claude', pathEnv)
  if (!claude) return fail('`claude` is not on the PATH — nothing was started')
  const node = findOnPath('node', pathEnv) ?? process.execPath
  const tree = ensureWorktree(state.root, task)
  if (tree.problem) return fail(tree.problem)
  // A session of a worktree of the product repo may not find the journal of the main copy: the prompt carries its absolute path (A1).
  const prompt = `/stage-pipeline:stage-force ${ticket} — the journal of the task is ${task.stagesPath}; the Force block there is already confirmed, continue the run without asking questions`
  const dirs = [dirname(node), dirname(claude), join(process.env.HOME ?? '', '.local/bin')].filter(Boolean)
  const env = { ...process.env, PATH: [...new Set([...dirs, ...pathEnv.split(delimiter).filter(Boolean)])].join(delimiter) }
  return { ok: true, ticket, repo: state.root, task, worktree: tree.path, created: tree.created, claude, node, prompt, env }
}

const closedNow = (task) => {
  const block = lastForceBlock(readTaskFile(task.dir, 'STAGES.md') ?? '')
  return Boolean(block && CLOSED_WORD.test(block.heading))
}

/**
 * One fresh session: spawns `claude -p`, logs the raw stream, records the rate-limit events, and records and returns exactly one outcome.
 * `{ outcome, session, log, code, window?, resetsAt?, text?, windows }` — `windows` is the last `rate_limit_event` read.
 */
export function runSession(ctx, { dataDir = pluginDataDir(), onEvent = null } = {}) {
  const { ticket, task, worktree, claude, prompt, env } = ctx
  const session = randomUUID()
  const log = join(task.dir, `force-run-${session}.log`)
  const note = (text) => appendFileSync(log, `${text}\n`)
  note(`session ${session} started ${new Date().toISOString()} in ${worktree}`)
  recordRun(ticket, { type: 'start', session, worktree, log }, dataDir)
  say(`${ticket}: session ${session} in ${worktree}, raw stream in ${log}`)
  const args = ['-p', prompt, '--session-id', session, '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose']

  return new Promise((done) => {
    let limit = null
    let result = null
    let windows = null
    let spawnError = null
    let stderrTail = ''
    let carry = ''
    let interrupted = false
    let awake = null

    const child = spawn(claude, args, { cwd: worktree, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stop = () => {
      interrupted = true
      child.kill('SIGTERM')
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)

    if (process.platform === 'darwin' && child.pid) {
      const caffeinate = findOnPath('caffeinate', env.PATH)
      if (caffeinate) {
        awake = spawn(caffeinate, ['-i', '-w', String(child.pid)], { stdio: 'ignore' })
        awake.on('error', () => note('caffeinate could not start — the machine may sleep during this run'))
      } else {
        note('caffeinate not found — the machine may sleep during this run')
        say('caffeinate not found, the machine may sleep during this run')
      }
    }

    const take = (line) => {
      const event = parseStreamLine(line)
      if (!event) return
      const rates = rateLimitWindows(event)
      if (rates) {
        windows = rates
        recordRun(ticket, { type: 'rate_limit', session, ...rates }, dataDir)
      }
      const hit = limitInfo(event)
      if (hit) limit = { window: hit.window ?? limit?.window ?? null, resetsAt: hit.resetsAt ?? limit?.resetsAt ?? null, text: hit.text || limit?.text || '' }
      if (event.type === 'result') result = event
      onEvent?.(event)
    }
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      appendFileSync(log, text)
      const lines = (carry + text).split('\n')
      carry = lines.pop()
      lines.forEach(take)
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      stderrTail = (stderrTail + text).slice(-2000)
      note(`[stderr] ${text.trimEnd()}`)
    })
    child.on('error', (error) => {
      spawnError = error
    })
    child.on('close', (code, signal) => {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
      if (carry) take(carry)
      if (awake && awake.exitCode === null) awake.kill()
      let outcome
      const out = { session, log, code, windows }
      if (limit) {
        // The window comes with the event; when it does not, a rejected window of the last rate_limit_event names it.
        const rejected = windows && WINDOWS.find((name) => windows[name]?.status === 'rejected')
        const window = limit.window ?? rejected ?? null
        Object.assign(out, { outcome: (outcome = 'limit'), window, resetsAt: limit.resetsAt ?? windows?.[window]?.resetsAt ?? null, text: limit.text })
        if (out.resetsAt !== null) out.resetsAtIso = new Date(out.resetsAt * 1000).toISOString()
      } else if (interrupted) {
        Object.assign(out, { outcome: (outcome = 'stopped'), text: 'the launcher was interrupted' })
      } else if (spawnError || signal || code !== 0 || result?.is_error) {
        const reason = spawnError ? spawnError.message : result?.is_error ? String(result.result ?? result.subtype ?? 'error result') : signal ? `killed by ${signal}` : `exit code ${code}`
        Object.assign(out, { outcome: (outcome = 'error'), text: `${reason}${stderrTail && !result?.is_error ? ` — ${stderrTail.trim().slice(-300)}` : ''}`.slice(0, 500) })
      } else {
        outcome = closedNow(task) ? 'completed' : 'stopped'
        out.outcome = outcome
        if (outcome === 'stopped') out.text = 'the session ended with the Force block still open'
      }
      const { windows: _seen, ...entry } = out
      recordRun(ticket, { type: 'outcome', ...entry }, dataDir)
      note(`outcome ${outcome}${out.window ? ` ${out.window} resets ${out.resetsAtIso ?? '?'}` : ''}`)
      done(out)
    })
  })
}

/** Readiness, worktree, one session. `{ ok: false, code, message }` before the start, else the outcome of `runSession`. */
export async function runForce(repo, ticket, options = {}) {
  const ctx = prepareRun(repo, ticket, options)
  if (!ctx.ok) return ctx
  if (ctx.created) say(`${ticket}: made worktree ${ctx.worktree}`)
  return { ok: true, ...(await runSession(ctx, options)) }
}

async function main(argv) {
  if (argv.length !== 2 || argv.some((arg) => arg.startsWith('-'))) {
    console.error('usage: force-run.mjs <repo> <TICKET>')
    process.exit(EXIT.notReady)
  }
  const out = await runForce(argv[0], argv[1])
  if (!out.ok) {
    say(out.message)
    process.exit(out.code)
  }
  const detail = out.outcome === 'limit' ? ` — ${out.window ?? 'unknown window'}, resets ${out.resetsAtIso ?? 'at an unknown time'}` : out.text ? ` — ${out.text}` : ''
  say(`${argv[1]}: ${out.outcome}${detail}`)
  process.exit(EXIT[out.outcome] ?? EXIT.error)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
