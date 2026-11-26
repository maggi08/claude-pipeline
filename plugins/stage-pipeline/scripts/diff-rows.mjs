/**
 * The one parser of `git diff --unified=0` rows, shared by floor-guard (lines with numbers) and receipts (the change of the task's own diff, VT-20).
 * The flags are explicit: `diff.mnemonicPrefix`/`diff.noprefix`/`diff.renames` from the developer's config change the headers, and the path stops matching the file.
 */
export const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/']

/**
 * `+++ b/my file.ts\t` — git appends a tab to a path with a space; special characters are C-quoted even with quotePath=false.
 * `null` for `/dev/null`. `prefix` is the one to strip: `b/` for the new side, `a/` for the old one.
 */
export function diffPath(raw, prefix = 'b/') {
  let path = raw.replace(/\t$/, '')
  if (path === '/dev/null') return null
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1).replace(/\\([\\"tn])/g, (_, c) => ({ t: '\t', n: '\n' })[c] ?? c)
  }
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/**
 * Parses a unified diff: `entryFor(path)` gives the entry of a file (`{ added: [], removed: [] }`, any `push`-able pair) and the rows go to it as `{ line, text }`.
 * A file header runs from `diff --git` to the first `@@`: a content line `-- x` inside a hunk is not a header.
 * A deleted file (`+++ /dev/null`) has no entry unless `keepDeleted` — then its rows go to the entry of the old path.
 */
export function parseUnified(diff, entryFor, { keepDeleted = false } = {}) {
  let entry = null
  let header = false
  let oldPath = null
  let oldLine = 0
  let newLine = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      entry = null
      header = true
      oldPath = null
    } else if (header && raw.startsWith('--- ')) oldPath = diffPath(raw.slice(4), 'a/')
    else if (header && raw.startsWith('+++ ')) {
      const path = diffPath(raw.slice(4)) ?? (keepDeleted ? oldPath : null)
      entry = path === null ? null : entryFor(path)
    } else if (header && !raw.startsWith('@@')) continue
    else if (raw.startsWith('@@')) {
      header = false
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/)
      oldLine = Number(m?.[1] ?? 0)
      newLine = Number(m?.[2] ?? 0)
    } else if (entry && raw.startsWith('+')) entry.added.push({ line: newLine++, text: raw.slice(1) })
    else if (entry && raw.startsWith('-')) entry.removed.push({ line: oldLine++, text: raw.slice(1) })
  }
}
