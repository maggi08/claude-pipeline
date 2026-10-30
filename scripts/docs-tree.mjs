/**
 * Docs-vs-tree (VT-3 stage 7, AC-7.5): what the documentation says against what the tree has. Dev repo only; validate.mjs calls it.
 *
 * For each markdown file it reports, with `file:line`:
 *   - an unknown slash command: `/name` as a standalone word that is not a skill of the plugin, a known built-in Claude Code command or a dev-repo command listed in DEV_COMMANDS;
 *   - a broken relative link: `[text](path)` whose target file or directory does not exist;
 *   - a broken anchor: `[text](#slug)` or `[text](file.md#slug)` whose slug is none of the target's heading slugs (GitHub rules, see `slug`).
 *
 * What counts as a command (kept narrow so that routes and paths are not noise): a token `/name` (lower case, digits and hyphens, at least 3 characters) that stands alone - after
 * the start of a line, a space, `(`, `[`, a quote, a backtick, a dash or a slash-separated alternative (`/a, /b`, `/a / /b`) - and is not followed by `/`, `.` plus a letter, `:` plus a
 * letter, `=` or a word character; inside fenced blocks only the links are skipped too; links, URLs and inline-code spans that are not themselves a bare `/name` are not read for commands.
 * In CHANGELOG.md the history names commands that no longer exist, so only its links and anchors are checked.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// Built-in commands of Claude Code (and bundled skills that the docs may name). Not exhaustive on purpose: a command that is missing here is added when a doc really needs it.
export const BUILTIN_COMMANDS = new Set([
  'add-dir', 'agents', 'bug', 'clear', 'code-review', 'compact', 'config', 'context', 'copy', 'cost', 'doctor', 'effort', 'exit', 'export', 'fast', 'feedback', 'help', 'hooks', 'ide',
  'init', 'install-github-app', 'login', 'logout', 'loop', 'mcp', 'memory', 'model', 'output-style', 'permissions', 'plugin', 'plugins', 'pr-comments', 'quit', 'release-notes', 'rename',
  'resume', 'review', 'rewind', 'sandbox', 'schedule', 'security-review', 'simplify', 'skills', 'status', 'statusline', 'tasks', 'terminal-setup', 'theme', 'todos', 'upgrade', 'usage', 'vim',
])

/** Commands of this dev repo (not plugin skills): `.claude/skills/*` and the like. Listed explicitly - a doc naming one is not an unknown command. */
export const DEV_COMMANDS = new Set(['audit-runs'])

const FENCE = /^\s*(`{3,}|~{3,})/

/** GitHub heading slug: markup dropped, lower case, everything but letters, digits, spaces, hyphens and underscores removed, spaces to hyphens. */
export function slug(heading) {
  return heading
    .replace(/<[^>]+>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*~]/g, '')
    .replace(/(^|[^\w])_+|_+($|[^\w])/g, '$1$2')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-')
}

/** The anchors of a markdown text: `Set` of slugs, with `-1`, `-2` for repeats as GitHub numbers them. */
export function anchorsOf(markdown) {
  const out = new Set()
  const seen = new Map()
  let fence = null
  for (const line of markdown.split('\n')) {
    const f = line.match(FENCE)
    if (f) {
      fence = fence ? (f[1][0] === fence ? null : fence) : f[1][0]
      continue
    }
    if (fence) continue
    const h = line.match(/^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/)
    if (!h) continue
    const base = slug(h[1])
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    out.add(n ? `${base}-${n}` : base)
  }
  return out
}

/** `[{ line, kind: 'link'|'command', text, target? }]` of one markdown file, code fences and inline code spans left out of the commands. */
export function scanDoc(markdown) {
  const found = []
  let fence = null
  markdown.split('\n').forEach((raw, index) => {
    const f = raw.match(FENCE)
    if (f) {
      fence = fence ? (f[1][0] === fence ? null : fence) : f[1][0]
      return
    }
    if (fence) return
    const line = index + 1
    // links first, on the line with code spans blanked (a link in backticks is an example, not a link)
    const noCode = raw.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length))
    for (const m of noCode.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) found.push({ line, kind: 'link', text: m[0], target: m[1] })
    // commands: outside links and URLs; inside a code span only when the span is exactly `/name` or starts with `/name ` (a command with arguments)
    const prose = raw
      .replace(/\]\([^)]*\)/g, ']()')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/`([^`]*)`/g, (_, code) => (/^\/[a-z][a-z0-9-]*(?:\s|$)/.test(code) ? ` ${code.match(/^\/[a-z][a-z0-9-]*/)[0]} ` : ' '.repeat(code.length + 2)))
    for (const m of prose.matchAll(/(?:^|[\s(["'—–,;|])(\/[a-z][a-z0-9-]{2,})(?![\w/=]|\.[a-zA-Z]|:[a-zA-Z])/g)) found.push({ line, kind: 'command', text: m[1] })
  })
  return found
}

/**
 * The failures of a set of docs. `files`: absolute paths; `root`: the repo root for the names in messages; `skills`: names of the plugin's skills;
 * `read`/`exists` are injectable for the self-test. `commandsIn(file)` says whether the commands of this file are checked.
 */
export function checkDocs({ root, files, skills, commandsIn = () => true, read = (path) => readFileSync(path, 'utf8'), exists = existsSync }) {
  const failures = []
  const known = new Set([...skills, ...BUILTIN_COMMANDS, ...DEV_COMMANDS])
  const anchors = new Map()
  const anchorsFor = (path) => {
    if (!anchors.has(path)) anchors.set(path, anchorsOf(read(path)))
    return anchors.get(path)
  }
  for (const file of files) {
    const rel = relative(root, file)
    for (const item of scanDoc(read(file))) {
      const where = `${rel}:${item.line}`
      if (item.kind === 'command') {
        const name = item.text.slice(1)
        if (commandsIn(file) && !known.has(name)) failures.push({ where, message: `unknown slash command \`${item.text}\` - not a skill of the plugin, a built-in command or a listed dev command (scripts/docs-tree.mjs)` })
        continue
      }
      const target = item.target
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue
      const [pathPart, fragment] = target.split('#')
      const clean = decodeURIComponent(pathPart.split('?')[0])
      const dest = clean ? resolve(dirname(file), clean) : file
      if (clean && !exists(dest)) {
        failures.push({ where, message: `broken link ${item.text}: ${clean} does not exist` })
        continue
      }
      if (fragment === undefined || fragment === '') continue
      const isMarkdown = /\.md$/i.test(dest)
      if (!isMarkdown || (exists(dest) && statSync(dest).isDirectory())) continue
      let slugs
      try {
        slugs = anchorsFor(dest)
      } catch {
        continue
      }
      if (!slugs.has(decodeURIComponent(fragment).toLowerCase())) failures.push({ where, message: `broken anchor ${item.text}: no heading with the slug "${fragment}" in ${relative(root, dest)}` })
    }
  }
  return failures
}

/** Every `.md` under a directory, symbolic links not followed. */
export function markdownUnder(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) return []
    if (entry.isDirectory()) return markdownUnder(path)
    return entry.name.endsWith('.md') ? [path] : []
  })
}
