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

// The GitHub / GitLab CLI calls a force run may make: reads only. `null` — every subcommand of the group reads; `api` is judged by its flags.
const CLI_READS = {
  gh: {
    pr: ['view', 'list', 'checks', 'diff', 'status'],
    run: ['view', 'list', 'watch'],
    repo: ['view'],
    issue: ['view', 'list'],
    release: ['view', 'list'],
    workflow: ['view', 'list'],
    auth: ['status'],
    search: null,
  },
  glab: {
    mr: ['view', 'list', 'diff'],
    ci: ['view', 'list', 'status', 'trace'],
    issue: ['view', 'list'],
    repo: ['view'],
    auth: ['status'],
  },
}
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

/** `gh api` / `glab api` arguments that write: a method other than GET, or a body (`-f`, `-F`, `--field`, `--raw-field`, `--input` switch the default to POST). */
export function apiWrites(args) {
  let explicitGet = false
  let body = false
  for (let i = 0; i < args.length; i++) {
    const method = args[i].match(/^(?:-X|--method)=?(.*)$/)
    if (method) {
      const value = method[1] || args[i + 1] || ''
      if (value.toUpperCase() !== 'GET') return true
      explicitGet = true
    } else if (/^(?:-[fF]|--field|--raw-field|--input)(?:=|$)/.test(args[i]) || /^-[fF]./.test(args[i])) body = true
  }
  return body && !explicitGet
}

/**
 * The first subcommand a force run never makes, whatever the permissions allow: a `git push`, and a `gh` / `glab` call that
 * is not a read (a PR or MR created, edited, merged or commented on, a rerun, an API write). Null when there is none.
 * The profile's optional `pr` group lets the user's own sessions push a branch and open a PR without a question,
 * so the ban in force cannot rest on the ask list any more.
 */
export function forceNever(line) {
  for (const words of subcommands(line)) {
    const name = basename(words[0])
    if (name === 'git') {
      let i = 1
      while (i < words.length && words[i].startsWith('-')) i += GIT_OPTIONS_WITH_VALUE.has(words[i]) ? 2 : 1
      if (words[i] === 'push') return words.join(' ')
      continue
    }
    const reads = CLI_READS[name]
    if (!reads) continue
    const [group, sub] = words.slice(1)
    if (group === 'api') {
      if (apiWrites(words.slice(2))) return words.join(' ')
      continue
    }
    if (!(group in reads) || (reads[group] !== null && !reads[group].includes(sub))) return words.join(' ')
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
