import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pluginDataDir } from './pipeline-state.mjs'

/**
 * One place where a hook says "no": the verdict goes to stdout exactly as each hook always wrote it, and a row about the firing goes to
 * `<plugin data>/firings.jsonl` — `{rule, task, repo, ts, tool, read, event}`, rule IDs and paths only, never the command text, a file's content or the reason.
 * `retro.mjs` counts the rows per rule, repeats per task and firings on reads. A stable rule ID is `<hook>/<slug>`; the release rule (scripts/hook-rules.json,
 * checked by scripts/validate.mjs) wants an incident fixture and a legitimate fixture in hooks-test.mjs for every ID written in a hook.
 *
 * The log is a side effect and never a reason to change a verdict: every failure to write it (no directory, a full disk, a read-only home) is swallowed.
 * It is rotated at a size cap: past `FIRINGS_MAX_BYTES` (1 MB; `STAGE_PIPELINE_FIRINGS_MAX` overrides it, for the self-test) the file becomes `firings.jsonl.1`
 * (the older generation is dropped) and a new one starts — about 8,000 rows are kept at least.
 */
export const FIRINGS_FILE = 'firings.jsonl'
export const FIRINGS_MAX_BYTES = 1024 * 1024

// Tools that only read; a Bash call counts when every part of it is a known reader (see `readOnlyBash`).
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])
const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'ls', 'grep', 'rg', 'find', 'wc', 'sort', 'uniq', 'diff', 'stat', 'file', 'pwd', 'echo', 'printf', 'which', 'jq', 'tree', 'du', 'df', 'ps', 'lsof', 'date', 'basename', 'dirname', 'realpath', 'test', '['])
const READ_GIT = new Set(['status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'merge-base', 'shortlog', 'describe'])
// These git subcommands read only in a listing form: `git branch feature` creates a branch, `git config user.name x` writes, `git stash` stashes.
const GIT_LISTING = {
  branch: (args) => !args.length || args.every((a) => /^(?:--list|-l|-a|-r|-v{1,2}|--all|--remotes|--verbose|--show-current|--contains|--merged|--no-merged)$/.test(a)),
  remote: (args) => !args.length || args.every((a) => /^(?:-v|--verbose)$/.test(a)) || args[0] === 'show' || args[0] === 'get-url',
  config: (args) => /^--(?:get|get-all|get-regexp|list|show-origin|show-scope)$/.test(args[0] ?? '') || args[0] === '-l',
  worktree: (args) => args[0] === 'list',
  stash: (args) => args[0] === 'list' || args[0] === 'show',
}
// `find` with an action that writes or runs something, and `sort -o`, change files.
const FIND_ACTION = /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/

/**
 * A Bash command that changes nothing: every `&& || ; |` part starts with a reader, `git` only with a read subcommand, `sed` only with `-n`, and
 * nothing writes through `>` or a subshell. A guess in the safe direction — a doubt reads as "not a read". The text is looked at and thrown away.
 */
export function readOnlyBash(command) {
  const text = String(command ?? '')
  const bare = text.replace(/\d?>&\d|\d?>\s*\/dev\/null/g, '')
  if (!text.trim() || /`|\$\(|<|>/.test(bare)) return false
  return text.split(/&&|\|\||;|\||\n/).every((part) => {
    const words = part.trim().split(/\s+/).filter((word) => !/^[A-Za-z_]\w*=/.test(word))
    const name = (words[0] ?? '').split('/').at(-1)
    if (!name) return true
    if (name === 'git') {
      const at = words.findIndex((word, index) => index > 0 && !word.startsWith('-'))
      const sub = words[at] ?? ''
      return GIT_LISTING[sub] ? GIT_LISTING[sub](words.slice(at + 1)) : READ_GIT.has(sub)
    }
    if (name === 'find') return !words.some((word) => FIND_ACTION.test(word))
    if (name === 'sort') return !words.some((word) => /^(?:-[A-Za-z]*o|--output(?:=.*)?)$/.test(word))
    if (name === 'sed') return words.includes('-n') && !words.some((word) => /^-[A-Za-z]*i/.test(word))
    if (name === 'node') return false
    return READ_COMMANDS.has(name)
  })
}

/** Whether the call only reads: Read / Grep / Glob, or a read-only Bash command. Known from the input alone — no text is kept. */
export function isRead(input) {
  const tool = String(input?.tool_name ?? '')
  if (READ_TOOLS.has(tool)) return true
  return tool === 'Bash' && readOnlyBash(input?.tool_input?.command)
}

/** The row for one firing. `agent` hooks (frames-guard on SubagentStop) have no tool: `tool` is the event name there. */
export function firingRow(rule, { input = {}, task = null, repo = null, kinds = null, at = null } = {}) {
  const row = {
    rule,
    task: task ? String(task) : null,
    repo: repo ?? (typeof input.cwd === 'string' ? input.cwd : process.cwd()),
    ts: at ?? new Date().toISOString(),
    tool: String(input.tool_name ?? input.hook_event_name ?? ''),
    read: isRead(input),
    event: String(input.hook_event_name ?? ''),
  }
  if (Array.isArray(kinds) && kinds.length) row.kinds = [...new Set(kinds.map(String))].slice(0, 12)
  return row
}

/** Appends the row; returns whether it was written. Never throws. */
export function recordFiring(rule, context = {}) {
  try {
    const dir = pluginDataDir()
    const path = join(dir, FIRINGS_FILE)
    mkdirSync(dir, { recursive: true })
    const cap = Number(process.env.STAGE_PIPELINE_FIRINGS_MAX) || FIRINGS_MAX_BYTES
    try {
      if (statSync(path).size >= cap) renameSync(path, `${path}.1`)
    } catch {
      // no file yet — nothing to rotate
    }
    appendFileSync(path, `${JSON.stringify(firingRow(rule, context))}\n`)
    return true
  } catch {
    return false
  }
}

/** A PreToolUse denial: the rule is logged, the verdict is written as before, the hook ends. */
export function denyTool(rule, reason, context = {}) {
  recordFiring(rule, context)
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  )
  process.exit(0)
}

/** A PostToolUse / SubagentStop block (`decision: 'block'`). `rules` is one ID or several that the same message answers for; the message is written once. */
export function blockWith(rules, reason, context = {}) {
  // One moment for all the rows of the block: retro counts the rows that share it as one block.
  const at = new Date().toISOString()
  for (const rule of [].concat(rules)) recordFiring(rule, { ...context, at })
  process.stdout.write(JSON.stringify({ decision: 'block', reason }))
  process.exit(0)
}
