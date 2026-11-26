/**
 * The tail of a Claude Code transcript (`<id>.jsonl`): the chat's titles, its last prompt and the checkout roots the session worked in (VT-19). One reader for the tracker's snapshot and the browser hook,
 * so the two give the same folders. A transcript is up to tens of MB, so only the tail is read.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { commandSegments, shellPath } from './hooks/git-command.mjs'
import { commonGitDir, nearestCheckout } from './hooks/pipeline-state.mjs'

const CHAT_TAILS = [256 * 1024, 4 * 1024 * 1024]
const FOLDERS_MAX = 12 // distinct folders kept, newest first

/** The lines of the last `bytes` of a file of `size` bytes, in file order; a cut first line is dropped. Throws when the file cannot be read (callers keep their own never-throws contract). */
export function tailLines(file, size, bytes) {
  const length = Math.min(size, bytes)
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, length, size - length)
  } finally {
    closeSync(fd)
  }
  const lines = buffer.toString('utf8').split('\n')
  if (length < size) lines.shift() // the first line is cut
  return lines
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'Read', 'NotebookEdit'])
const AFTER_CD = new Set(['&&', ';']) // only these run what follows in the folder `cd` moved to: not `||`, `|`, `&`; a newline does too but is not taken on purpose (as before this stage): a multi-line command is mostly a script whose `cd` is not the session's place

/** An absolute folder from a path of a tool call, by the shared `shellPath`; null when it cannot be told (`-`, `~name`, no `cwd` for a relative path, and in a Bash command a variable or a substitution — a `file_path` may hold `$`, as `$postId.tsx`). Unlike git-guard, which guesses a literal path to guard a commit, a wrong folder here would move a session: an unknown one is dropped. */
function resolveFolder(path, cwd, shell = false) {
  if (typeof path !== 'string' || !path || path === '-') return null
  if (!isAbsolute(path) && !path.startsWith('~') && !(typeof cwd === 'string' && isAbsolute(cwd))) return null
  const { path: folder, known } = shellPath(path, typeof cwd === 'string' && isAbsolute(cwd) ? cwd : '/', shell)
  return known ? folder : null
}

/** The folders a Bash command names at its start: a leading `cd <path>` before `&&` or `;`, and `git -C <path>` as the first word of the command or of what follows that `cd`. Nothing else of the text (VT-19 A9). Lexed by the shared `commandSegments`. */
function bashFolders(command, cwd) {
  const out = []
  const operators = []
  const segments = commandSegments(command, operators)
  let first = 0
  let base = cwd
  const [head] = segments
  if (head?.[0] === 'cd' && head.length === 2 && AFTER_CD.has(operators[0])) {
    const folder = resolveFolder(head[1], cwd, true)
    if (!folder) return out // an unresolved `cd`: what follows runs in a folder that is not known, its `git -C` is relative to it
    out.push(folder)
    base = folder
    first = 1
  }
  const git = segments[first]
  if (git?.[0] === 'git' && git[1] === '-C') {
    const folder = resolveFolder(git[2], base, true)
    if (folder) out.push(folder)
  }
  return out
}

/** The checkout a folder belongs to and its repo, by the file system alone, no git process: `root` is the nearest ancestor (itself included) with a `.git`, `repo` its common git dir (all worktrees of a repo share it, whatever the main tree's layout); `root` is the folder and `repo` null off any checkout. `cache` is per read. */
function checkoutOf(folder, cache) {
  const known = cache.get(folder)
  if (known !== undefined) return known
  const checkout = nearestCheckout(folder)
  const found = checkout ? { root: checkout.root, repo: commonGitDir(checkout.root) ?? checkout.root } : { root: folder, repo: null }
  cache.set(folder, found)
  return found
}

/** The folders the line's own tool calls name (`message.content[]` items `tool_use`), in call order; only a Bash command's start and a file tool's path, never the text of a command or a file. */
function toolFolders(entry) {
  const content = entry?.message?.content
  if (!Array.isArray(content)) return []
  const out = []
  for (const item of content) {
    if (item?.type !== 'tool_use' || !item.input || typeof item.input !== 'object') continue
    if (item.name === 'Bash') {
      if (typeof item.input.command === 'string') out.push(...bashFolders(item.input.command, entry.cwd))
    } else if (FILE_TOOLS.has(item.name)) {
      const file = resolveFolder(item.input.file_path ?? item.input.notebook_path, entry.cwd, false)
      if (file) out.push(dirname(file))
    }
  }
  return out
}

/** `{ found: { customTitle, aiTitle, lastPrompt }, folders: [{ cwd, at }] }` of the file's tail; `tails` are the sizes tried in turn (a wider one when the first holds no title or no folder). */
export function chatFromTail(file, size, tails = CHAT_TAILS) {
  const found = { customTitle: null, aiTitle: null, lastPrompt: null }
  let folders = []
  const mtime = statSync(file).mtimeMs
  for (const tail of tails) {
    const length = Math.min(size, tail)
    const lines = tailLines(file, size, tail)
    folders = []
    const seen = new Set()
    const roots = new Map()
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const titlesDone = found.customTitle && found.aiTitle && found.lastPrompt
      if (titlesDone && folders.length >= FOLDERS_MAX) break // no other stop: a folder of the whole read tail counts (AC-1.4), the full pass is ~1 ms
      const line = lines[index]
      const key = line.includes('"custom-title"') ? 'customTitle' : line.includes('"ai-title"') ? 'aiTitle' : line.includes('"last-prompt"') ? 'lastPrompt' : null
      if (key && !found[key]) {
        try {
          const value = JSON.parse(line)?.[key]
          if (typeof value === 'string' && value.trim()) found[key] = value
        } catch {
          // a cut or foreign line
        }
      }
      if (folders.length >= FOLDERS_MAX) continue // the cap is of the newest folders: an older line adds none
      if (!line.includes('"cwd":"') && !line.includes('"tool_use"')) continue
      try {
        // the top-level fields only: a nested `git_state.cwd` or a tool call's input may stand before them in the line; one parse gives the line's `cwd` and its tool calls' folders
        const entry = JSON.parse(line)
        const stamped = Date.parse(entry?.timestamp)
        if (!Number.isFinite(stamped)) continue
        const at = Math.min(stamped, mtime) // a time later than the file's last write is not a time of the transcript (D7)
        const named = typeof entry?.cwd === 'string' && entry.cwd ? [entry.cwd] : []
        // a call into another repo does not move the session (A11): a tool folder counts when it is in the repo (the common git dir) of the line's `cwd`, or when that `cwd` is in no checkout
        const home = named.length ? checkoutOf(named[0], roots).repo : null
        const called = toolFolders(entry).reverse().filter((folder) => home === null || checkoutOf(folder, roots).repo === home)
        for (const folder of [...called, ...named]) {
          const cwd = checkoutOf(folder, roots).root // the task key of a folder is its checkout root's: a handful of entries, not a folder per file
          if (seen.has(cwd) || folders.length >= FOLDERS_MAX) continue
          seen.add(cwd)
          folders.push({ cwd, at })
        }
      } catch {
        // a cut or foreign line
      }
    }
    if ((found.customTitle || found.aiTitle) && folders.length > 0) break
    if (length === size) break
  }
  return { found, folders }
}

/** The folders of a transcript file, newest first, from a bounded read of its tail (`tails`, the first size by default). Empty when the file cannot be read. */
export function foldersOfFile(file, tails = [CHAT_TAILS[0]]) {
  try {
    return chatFromTail(file, statSync(file).size, tails).folders
  } catch {
    return []
  }
}
