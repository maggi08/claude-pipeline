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
    run: ['view', 'list', 'watch', 'download'],
    repo: ['view', 'clone'],
    issue: ['view', 'list'],
    release: ['view', 'list', 'download'],
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
// A help or version call of the CLI: `gh`, `gh --version`, `gh pr create --help` print text and publish nothing (0.29.3 review m-3).
const CLI_META = new Set(['--version', '-v', 'version', 'help', '--help', '-h'])
const PUSH_OPTIONS_WITH_VALUE = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo'])

/**
 * A `git push` (its arguments after `push`) that leaves nothing outside the machine (0.29.3 review m-3): a dry run, or a remote that is a local path
 * (`../remote.git`, `/tmp/x.git`, `file://…`) — a checker's probe in a scratch repo. A named remote (`origin`) is never taken for local: its URL is not in the command.
 */
function localPush(args) {
  if (args.includes('-n') || args.includes('--dry-run')) return true
  let remote = null
  for (let i = 0; i < args.length && remote === null; i++) {
    const arg = args[i]
    if (arg === '--') remote = args[i + 1] ?? ''
    else if (PUSH_OPTIONS_WITH_VALUE.has(arg)) i++
    else if (arg.startsWith('--repo=')) remote = arg.slice('--repo='.length)
    else if (!arg.startsWith('-')) remote = arg
  }
  return remote !== null && /^(?:\/|\.{1,2}(?:\/|$)|~\/|file:)/.test(remote)
}

/**
 * `gh api graphql` arguments that write (0.29.3 review m-3): the endpoint always takes a POST, so the body decides — a `mutation` in a field, or a query the hook cannot see
 * (`--input`, a `query=@file`). A plain query reads.
 */
export function graphqlWrites(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (/^--input(?:=|$)/.test(arg)) return true
    let value = null
    if (/^(?:-[fF]|--field|--raw-field)$/.test(arg)) value = args[++i] ?? ''
    else value = arg.match(/^(?:--field=|--raw-field=|-[fF])(.+)$/)?.[1] ?? null
    if (value !== null && (/\bmutation\b/i.test(value) || /^query=@/.test(value))) return true
  }
  return false
}

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
      if (words[i] === 'push' && !localPush(words.slice(i + 1))) return words.join(' ')
      continue
    }
    const reads = CLI_READS[name]
    if (!reads) continue
    const [group, sub] = words.slice(1)
    if (group === undefined || CLI_META.has(group) || words.includes('--help') || words.includes('-h')) continue
    if (group === 'api') {
      const args = words.slice(2)
      if (args.includes('graphql') ? graphqlWrites(args) : apiWrites(args)) return words.join(' ')
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

/** The settings files the session sees: the user's `settings.json` and the project's `settings.json` and `settings.local.json`. Force-guard and the doctor read the same set. */
export function settingsFiles(projectDir) {
  const files = [join(homedir(), '.claude/settings.json')]
  if (projectDir) files.push(join(projectDir, '.claude/settings.json'), join(projectDir, '.claude/settings.local.json'))
  return files
}

/** The `allow`, `ask` or `deny` rules (strings) of the files with the file each came from. A broken or missing file is not an error: it adds nothing. */
export function permissionRules(kind, files) {
  return files.flatMap((source) => {
    try {
      const list = JSON.parse(readFileSync(source, 'utf8'))?.permissions?.[kind]
      return Array.isArray(list) ? list.filter((rule) => typeof rule === 'string').map((rule) => ({ rule, source })) : []
    } catch {
      return []
    }
  })
}

/** Bash ask rules from the settings the session sees (`settingsFiles`). */
export const askRules = (projectDir) => permissionRules('ask', settingsFiles(projectDir)).filter(({ rule }) => rule.startsWith('Bash'))

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
