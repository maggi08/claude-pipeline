/**
 * The tail of a Claude Code transcript (`<id>.jsonl`): the chat's titles, its last prompt and the folders the session worked in (VT-19). One reader for the tracker's snapshot and the browser hook,
 * so the two give the same folders. A transcript is up to tens of MB, so only the tail is read.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'

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
      if (folders.length >= FOLDERS_MAX) continue
      if (!line.includes('"cwd":"')) continue
      try {
        // the top-level fields only: a nested `git_state.cwd` or a tool call's input may stand before them in the line
        const entry = JSON.parse(line)
        const cwd = entry?.cwd
        const stamped = Date.parse(entry?.timestamp)
        if (typeof cwd === 'string' && cwd && Number.isFinite(stamped) && !seen.has(cwd)) {
          seen.add(cwd)
          folders.push({ cwd, at: Math.min(stamped, mtime) }) // a time later than the file's last write is not a time of the transcript (D7)
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
