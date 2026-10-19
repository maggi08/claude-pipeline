import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { commandSegments } from './git-command.mjs'

/**
 * Which parts of a Bash command will stop the run on a question to the user — without launching Claude Code.
 * It repeats Claude Code's rules as far as force-guard needs: the command is cut into subcommands
 * at `&& || ; | &` and newline, `FOO=1`, `nohup`, `time`, `nice`, `timeout N` are stripped from each,
 * and the subcommand is matched against `Bash(...)` from `ask`. Words in quotes and heredoc bodies are
 * not commands: `echo "pkill later"` and `grep -rn "git push" .` stop nobody.
 */

// `pkill`/`killall` kill processes by name — including the user's dev server and a neighbouring session.
const NAME_KILLERS = new Set(['pkill', 'killall'])
const WRAPPERS = new Set(['command', 'nohup', 'time', 'nice', 'exec'])

/** Subcommands of a line: words without wrappers, in the form the rules match against. */
export function subcommands(line) {
  return commandSegments(line)
    .map((words) => {
      let i = 0
      for (;;) {
        while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++
        if (WRAPPERS.has(words[i])) i++
        else if (words[i] === 'timeout' && words[i + 1]) i += 2
        else break
      }
      return words.slice(i)
    })
    .filter((words) => words.length)
}

/** A subcommand that kills processes by name: `pkill -f x`, `/usr/bin/killall node`, `… | xargs pkill`. */
export function nameKill(line) {
  for (const words of subcommands(line)) {
    let i = 0
    if (words[0] === 'xargs') for (i = 1; i < words.length && words[i].startsWith('-'); i++);
    if (NAME_KILLERS.has(basename(words[i] ?? ''))) return words.join(' ')
  }
  return null
}

/**
 * `Bash(...)` → regexp. `*` is any characters, the tail ` *` is the command itself or the same with arguments,
 * the old form `:*` means the same. A bare `Bash` and `Bash(*)` in ask are not taken: the hook does not turn
 * "ask about everything" into "deny everything" — force does not work with such a profile even without the hook.
 */
export function bashRulePattern(rule) {
  const body = String(rule).match(/^Bash\((.*)\)$/s)?.[1]?.trim()
  if (!body || body === '*') return null
  let text = body.endsWith(':*') ? `${body.slice(0, -2)} *` : body
  const anyTail = text.endsWith(' *')
  if (anyTail) text = text.slice(0, -2)
  const source = text.split('*').map(escapeRegExp).join('.*')
  return new RegExp(`^${source}${anyTail ? '(?:\\s.*)?' : ''}$`, 's')
}

/** The first subcommand of a line that one of the ask rules will stop: `{ command, rule, source }` or null. */
export function askMatch(line, rules) {
  const patterns = rules.map((rule) => ({ ...rule, pattern: bashRulePattern(rule.rule) })).filter((rule) => rule.pattern)
  if (!patterns.length) return null
  for (const words of subcommands(line)) {
    const command = words.join(' ')
    const hit = patterns.find(({ pattern }) => pattern.test(command))
    if (hit) return { command, rule: hit.rule, source: hit.source }
  }
  return null
}

/**
 * Bash ask rules from the settings the session sees: the user file and both project files.
 * A broken or missing file is not a hook error: there are just no rules from it.
 */
export function askRules(projectDir) {
  const files = [join(homedir(), '.claude/settings.json')]
  if (projectDir) files.push(join(projectDir, '.claude/settings.json'), join(projectDir, '.claude/settings.local.json'))
  return files.flatMap((source) => {
    try {
      const ask = JSON.parse(readFileSync(source, 'utf8'))?.permissions?.ask
      return Array.isArray(ask) ? ask.filter((rule) => typeof rule === 'string' && rule.startsWith('Bash')).map((rule) => ({ rule, source })) : []
    } catch {
      return []
    }
  })
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
