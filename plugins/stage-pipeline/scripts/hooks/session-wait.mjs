#!/usr/bin/env node
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isClaude } from '../browser-cleanup.mjs'
import { alive, ancestors, commandOf, processTable } from '../processes.mjs'
import { isMain } from '../main-guard.mjs'
import { readHookInput } from './hook-input.mjs'
import { pluginDataDir } from './pipeline-state.mjs'

/**
 * Which session waits for the user and on what (VT-17 stage 4, D11): every event below sets or clears the state of its session in `<data dir>/sessions/<session_id>.json`
 * = { kind, text, options, since, cwd, transcript, claudePid }. `kind` is `turn-ended` (Stop), `question` (AskUserQuestion), `permission` (PermissionRequest, or the
 * Notification `permission_prompt` when nothing is set yet), `elicitation` (Elicitation, or the Notification `elicitation_dialog`), or null (cleared by UserPromptSubmit;
 * the file stays for its `claudePid`). SessionEnd removes the file. `since` is epoch ms. monitor.mjs reads these files; it drops a state when the transcript changed more
 * than 5 s after `since` or the Claude process is dead.
 *
 * An event with `agent_id` is a subagent's and changes nothing. The hook never blocks and never prints: any failure is an exit 0 with no output, and a hard timer ends it under 1 s.
 * `claudePid` is the nearest `claude` ancestor of this process, found by one `ps` call and kept in the file; it is looked up again when it is null, the process is gone or its
 * command line is no longer a `claude` (a session resumed by `claude -c` / `/resume` keeps its session id and gets a new process).
 *
 * Field names marked "unverified" below are not in the settings schema, only seen in the binary or guessed; the fallback named next to each one applies when it is absent.
 */
export const TEXT_MAX = 2000
const TAIL_BYTES = 256 * 1024
const PS_TIMEOUT_MS = 600
export const WAIT_STATE_MAX_AGE_MS = 7 * 24 * 3600 * 1000 // a state file older than this belongs to a session that never sent SessionEnd (killed)
const SWEEP_EVERY_MS = 3600 * 1000

const cap = (text) => {
  const value = String(text ?? '').trim()
  return value.length > TEXT_MAX ? value.slice(-TEXT_MAX) : value
}

/** The text of the last assistant message of a transcript: a bounded read of its tail, the lines from the end. Null when there is none. */
export function lastAssistantText(path) {
  let fd
  try {
    const size = statSync(path).size
    fd = openSync(path, 'r')
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n')
    if (size > length) lines.shift() // the first line is cut
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry
      try {
        entry = JSON.parse(lines[i])
      } catch {
        continue
      }
      if (entry?.type !== 'assistant' || entry.isSidechain) continue
      const content = entry.message?.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : ''
      if (text.trim()) return text
    }
  } catch {
    // no transcript, unreadable: no text
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return null
}

const asList = (value) => (Array.isArray(value) ? value : [])

/** The state an event sets: `{ kind, text, options }`, `'clear'`, `'remove'`, or null when the event changes nothing. */
export function stateFor(input, existing) {
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}
  switch (input.hook_event_name) {
    case 'Stop':
      // unverified field `last_assistant_message` (only in the binary): without it the text comes from the transcript tail
      return { kind: 'turn-ended', text: cap(input.last_assistant_message ?? lastAssistantText(input.transcript_path)), options: [] }
    case 'PreToolUse':
    case 'PostToolUse':
      if (input.tool_name !== 'AskUserQuestion') return null
      if (input.hook_event_name === 'PostToolUse') return 'clear'
      return {
        kind: 'question',
        text: cap(asList(toolInput.questions).map((item) => item?.question).filter(Boolean).join('\n')),
        options: asList(toolInput.questions).flatMap((item) => asList(item?.options).map((option) => String(option?.label ?? option))),
      }
    case 'PermissionRequest': {
      if (input.tool_name === 'AskUserQuestion' || existing?.kind === 'question') return null // the question already shows its options; its permission event must not replace them
      // unverified: which of command / file_path / path / url / pattern a tool's tool_input carries; the first one present is shown, none → the tool name alone
      const target = toolInput.command ?? toolInput.file_path ?? toolInput.path ?? toolInput.url ?? toolInput.pattern ?? ''
      return { kind: 'permission', text: cap([input.tool_name, typeof target === 'string' ? target : JSON.stringify(target)].filter(Boolean).join(' ')), options: [] }
    }
    case 'Notification': {
      // unverified field `notification_type`: without it (or with another value) a Notification sets nothing and the PermissionRequest / Elicitation events remain
      const kind = { permission_prompt: 'permission', elicitation_dialog: 'elicitation' }[input.notification_type]
      if (!kind || input.tool_name === 'AskUserQuestion') return null
      // a Notification refreshes only a state that came from a Notification (a second permission of the turn); a PermissionRequest / Elicitation text is richer and keeps its `since`; a different set kind is not replaced
      if (existing?.kind && (existing.kind !== kind || existing.source !== 'Notification')) return null
      return { kind, text: cap(input.message), options: [] }
    }
    case 'Elicitation':
      // unverified field: the server name is read from `mcp_server_name`, else `server_name`; without both only the message is shown
      return { kind: 'elicitation', text: cap([input.mcp_server_name ?? input.server_name, input.message].filter(Boolean).join(': ')), options: [] }
    case 'UserPromptSubmit':
      return 'clear'
    case 'SessionEnd':
      return 'remove'
    default:
      return null
  }
}

const readState = (file) => {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** The nearest `claude` ancestor of this process: one `ps` call. Null when `ps` is missing or no ancestor is one. */
export function claudePidOf(pid = process.pid) {
  const table = processTable({ timeout: PS_TIMEOUT_MS })
  return table ? ancestors(table, pid).find((entry) => isClaude(entry.args))?.pid ?? null : null
}

/** The stored `claudePid` still names a live `claude` process: not null, signal 0 succeeds, one `ps` says its command line is a `claude`. */
function pidStillClaude(pid, { aliveOf, commandOf: commandLine }) {
  if (!Number.isInteger(pid) || !aliveOf(pid)) return false
  const args = commandLine(pid, { timeout: PS_TIMEOUT_MS })
  return args !== null && isClaude(args)
}

/** Deletes the state files of other sessions older than 7 days, at most once an hour (the mtime of a marker file next to the directory). Never throws. */
function sweepStale(dir, keep, now) {
  try {
    const marker = join(dirname(dir), 'sessions.swept')
    try {
      if (now - statSync(marker).mtimeMs < SWEEP_EVERY_MS) return
    } catch {
      // no marker yet: sweep
    }
    writeFileSync(marker, String(now))
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') || name === keep) continue
      try {
        if (now - statSync(join(dir, name)).mtimeMs > WAIT_STATE_MAX_AGE_MS) rmSync(join(dir, name), { force: true })
      } catch {
        // gone meanwhile
      }
    }
  } catch {
    // a sweep that fails is skipped
  }
}

/**
 * An approved permission or a finished elicitation: PostToolUse of the tool that waited. Called from journal-gate (PostToolUse of Edit, Write, MultiEdit, Bash), so no hook of its own
 * runs per tool call. Other tools (MCP, WebFetch) are not seen here: their state is dropped by the monitor's transcript rule. One read, no process; sets `kind` to null only when it is
 * `permission` or `elicitation`. Never throws.
 */
export function clearApproved(sessionId, { dir = join(pluginDataDir(), 'sessions'), now = Date.now() } = {}) {
  try {
    const id = String(sessionId ?? '')
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return false
    const file = join(dir, `${id}.json`)
    const existing = readState(file)
    if (existing?.kind !== 'permission' && existing?.kind !== 'elicitation') return false
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...existing, kind: null, text: '', options: [], since: now }))
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

export function record(input, { dir = join(pluginDataDir(), 'sessions'), now = Date.now(), pidOf = claudePidOf, aliveOf = alive, commandOf: commandLine = commandOf } = {}) {
  const id = String(input.session_id ?? '')
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || input.agent_id) return
  const file = join(dir, `${id}.json`)
  const existing = readState(file)
  const change = stateFor(input, existing)
  if (change === null) return
  if (change === 'remove') return rmSync(file, { force: true })
  if (change === 'clear' && !existing) return
  const set = change === 'clear' ? { kind: null, text: '', options: [] } : change
  const kept = existing && pidStillClaude(existing.claudePid, { aliveOf, commandOf: commandLine })
  const next = {
    ...set,
    source: set.kind ? input.hook_event_name : null,
    since: now,
    cwd: input.cwd ?? existing?.cwd ?? null,
    transcript: input.transcript_path ?? existing?.transcript ?? null,
    claudePid: kept ? existing.claudePid : pidOf() ?? (Number.isInteger(existing?.claudePid) && aliveOf(existing.claudePid) ? existing.claudePid : null), // a failed lookup under load keeps a live old pid
  }
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next))
  renameSync(tmp, file)
  sweepStale(dir, `${id}.json`, now)
}

if (isMain(import.meta.url)) {
  setTimeout(() => process.exit(0), 900).unref()
  try {
    record(await readHookInput())
  } catch {
    // never blocks a turn
  }
  process.exit(0)
}
