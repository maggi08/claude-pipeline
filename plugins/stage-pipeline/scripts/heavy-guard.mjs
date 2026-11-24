/**
 * The `heavy-guard/bypass` rule (VT-17 stage 2): in the `low` resource mode a heavy command of the repo's config (`test`, `build`, `type_check`, `lint`
 * of "## Commands") runs through `run-check.mjs`, which asks the memory admission; run bare, it goes round the balancer and nobody counts its memory.
 * The rule is judged by words: a Bash segment matches when it starts with the words of one `&&`/`;`/`||` part of a config command, so `yarn test --watch`
 * matches `yarn test`, while `yarn test:e2e` and `grep test` do not. Pure functions here; git-guard asks, and loads this file only for a Bash call in a repo with a config.
 */
const KINDS = ['test', 'build', 'type_check', 'lint']
/** A config part of one such word (`build: make`, `test: yarn`) is the tool itself, not a check: `make clean` and `yarn add x` are not it. */
const TOOLS = new Set(['npm', 'yarn', 'pnpm', 'bun', 'npx', 'make'])
const THROUGH = /(^|\/)(run-check|ci-gates)\.mjs$/

/** The `## Commands` lines `test` / `build` / `type_check` / `lint` of the config as word lists, one per `&&`/`;`/`||` part: `[{ kind, words }]` (`dev` and `—` are no part). */
export function heavyParts(config) {
  const start = config.search(/^##\s+Commands\b.*$/m)
  if (start === -1) return []
  const rest = config.slice(start).split('\n').slice(1)
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line))
  const parts = []
  for (const line of end === -1 ? rest : rest.slice(0, end)) {
    const m = line.match(/^\s*-\s*\**([a-z_]+)\**\s*:\s*(.+)$/i)
    if (!m || !KINDS.includes(m[1].toLowerCase())) continue
    // The value is the backtick span when it STARTS with one; otherwise the plain text up to ` #` (a backtick inside a trailing comment is not the command).
    const value = m[2].trim()
    const raw = value.startsWith('`') ? (value.match(/^`([^`]*)`/)?.[1] ?? '') : value.split(/\s+#/)[0]
    for (const part of raw.split(/&&|\|\||;/)) {
      const words = part.trim().split(/\s+/).filter(Boolean)
      const cut = words.findIndex((word) => word.includes('{files'))
      const kept = cut === -1 ? words : words.slice(0, cut)
      // `cd <dir>` is no check (the command after it is the next part); a first word that is not a program path (`—`, `-`, prose) is no command
      if (!kept.length || kept[0] === 'cd' || !/^[\w./~@-]*[\w/]$/.test(kept[0]) || kept[0] === '-') continue
      if (kept.length === 1 && TOOLS.has(kept[0])) continue
      parts.push({ kind: m[1].toLowerCase(), words: kept })
    }
  }
  return parts
}

/** The command with the body of every heredoc (`<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF`), up to its terminator line, blanked out: it is text, not commands. Same length. */
function maskHeredocs(command) {
  let out = command
  let from = 0
  for (;;) {
    const open = /<<(?!<)(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2/g
    open.lastIndex = from
    const m = open.exec(out)
    const lineEnd = m ? out.indexOf('\n', m.index + m[0].length) : -1
    if (lineEnd === -1) return out
    const bodyStart = lineEnd + 1
    const terminator = new RegExp(`^${m[1] ? '\\t*' : ''}${m[3]}[ \\t]*$`, 'm').exec(out.slice(bodyStart))
    const end = terminator ? bodyStart + terminator.index + terminator[0].length : out.length
    // from the line break after the opener: the body stays inside the opener's segment
    out = out.slice(0, lineEnd) + out.slice(lineEnd, end).replace(/[^]/g, 'Q') + out.slice(end)
    from = end
  }
}

/** The Bash command cut into its own segments at `&&`, `||`, `;`, `|` and newlines; quoted text cannot cut it. `[{ text, words }]`, text as written. */
export function segments(command) {
  const blank = maskHeredocs(command).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (quoted) => 'Q'.repeat(quoted.length))
  const out = []
  let from = 0
  for (const cut of [...blank.matchAll(/&&|\|\||;|\||\n/g), { index: command.length, 0: '' }]) {
    const text = command.slice(from, cut.index).trim()
    from = cut.index + cut[0].length
    if (text) out.push({ text, words: text.split(/\s+/).map((word) => word.replace(/^['"]|['"]$/g, '')) })
  }
  return out
}

const ENV_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The first segment of the command that runs a heavy part of the config bare: `{ kind, text, cd }` (`cd` — the last `cd <dir>` segment before it, or null), or `null` (also for a run through run-check / ci-gates). */
export function bypassOf(config, command) {
  const parts = heavyParts(config)
  if (!parts.length) return null
  let cd = null
  for (const { text, words } of segments(command)) {
    if (words[0] === 'cd') cd = text
    if (words.some((word) => THROUGH.test(word))) continue
    const own = words.slice(words.findIndex((word) => !ENV_WORD.test(word)))
    for (const { kind, words: part } of parts) if (part.length <= own.length && part.every((word, index) => own[index] === word)) return { kind, text, cd }
  }
  return null
}
