/**
 * The tail of a Claude Code transcript (`<id>.jsonl`): the chat's titles, its last prompt and the folders the session worked in (VT-19). One reader for the tracker's snapshot and the browser hook,
 * so the two give the same folders. A transcript is up to tens of MB, so only the tail is read.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'

export const CHAT_TAILS = [256 * 1024, 4 * 1024 * 1024]
export const FOLDERS_MAX = 12 // distinct folders kept, newest first
// The folders scan stops once the titles are found and this many `cwd` lines in a row brought no new folder: a session that stays in one or two folders costs a regexp per line over the first 200
// lines, not a JSON.parse of the whole tail. A folder left more than that many entries ago is not "current" anyway.

const CWD = /"cwd":"((?:[^"\\]|\\.)*)"/
const STAMP = /"timestamp":"([^"]+)"/

/** `{ found: { customTitle, aiTitle, lastPrompt }, folders: [{ cwd, at }] }` of the file's tail; `tails` are the sizes tried in turn (a wider one when the first holds no title or no folder). */
export function chatFromTail(file, size, tails = CHAT_TAILS) {
  const found = { customTitle: null, aiTitle: null, lastPrompt: null }
  let folders = []
  for (const tail of tails) {
    const length = Math.min(size, tail)
    const buffer = Buffer.alloc(length)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buffer, 0, length, size - length)
    } finally {
      closeSync(fd)
    }
    const lines = buffer.toString('utf8').split('\n')
    if (length < size) lines.shift() // the first line is cut
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
      const cwdMatch = CWD.exec(line)
      if (!cwdMatch) continue
      try {
        const cwd = JSON.parse(`"${cwdMatch[1]}"`)
        const at = Date.parse(STAMP.exec(line)?.[1])
        if (cwd && Number.isFinite(at) && !seen.has(cwd)) {
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
