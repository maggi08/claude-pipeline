import { resolve } from 'node:path'

/**
 * `git add`/`git commit` calls in a Bash command line — in command position, with global options
 * (`-C`, `-c k=v`, `--no-pager`, …) and taking a preceding `cd <dir> &&` into account: the hook checks the
 * repo the command actually commits to. Words inside quotes and heredoc bodies are not commands:
 * `grep "git add"` or a commit message with the words "git commit" does not trigger the hook.
 */
export function gitInvocations(line, cwd) {
  const found = []
  let dir = cwd
  for (const words of commandSegments(line)) {
    let i = 0
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++
    if (['command', 'time', 'nice', 'nohup'].includes(words[i])) i++
    const name = words[i]
    if (name === 'cd' && words[i + 1]) {
      dir = resolve(dir, words[i + 1].replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
      continue
    }
    if (name !== 'git' && !name?.endsWith('/git')) continue
    let target = dir
    i++
    while (i < words.length && words[i].startsWith('-')) {
      if (words[i] === '-C') target = resolve(target, words[++i] ?? '.')
      else if (['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'].includes(words[i])) i++
      i++
    }
    if (words[i] === 'add' || words[i] === 'commit') found.push({ subcommand: words[i], dir: target, args: words.slice(i + 1) })
  }
  return found
}

const WRAPPER_WORDS = ['command', 'time', 'nice', 'nohup', 'env']
const INDEX_ENV = /^GIT_INDEX_FILE=/

/**
 * What else a command does to the git index besides `git add` (K11a.2, S-1b): the maker receipt judges the blob a commit takes from the index or from the working tree
 * of the paths the command itself stages with `add`, so a path staged by another subcommand — `git update-index --add x && git commit` — slips past it. Returns short
 * descriptions (`update-index`, `GIT_INDEX_FILE=`), `[]` for a command that touches the index only through `add` and `commit`.
 * Covers `update-index`, `read-tree`, `mv`, `rm`, `reset`, `apply --cached/--index`, `checkout … -- <path>`, `restore --staged/--source`, and a `GIT_INDEX_FILE=` prefix or export.
 */
export function indexChangers(line) {
  const found = []
  for (const words of commandSegments(line)) {
    let i = 0
    for (;;) {
      while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
        if (INDEX_ENV.test(words[i])) found.push('GIT_INDEX_FILE=')
        i++
      }
      if (words[i] === 'export' || words[i] === 'env') {
        i++
        continue
      }
      if (WRAPPER_WORDS.includes(words[i])) i++
      else break
    }
    const name = words[i]
    if (name !== 'git' && !name?.endsWith('/git')) continue
    i++
    while (i < words.length && words[i].startsWith('-')) {
      if (['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'].includes(words[i])) i++
      i++
    }
    const sub = words[i]
    const args = words.slice(i + 1)
    const flag = (...names) => args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)))
    if (['update-index', 'read-tree', 'mv', 'rm', 'reset'].includes(sub)) found.push(sub)
    else if (sub === 'apply' && flag('--cached', '--index')) found.push('apply --cached')
    else if (sub === 'checkout' && args.includes('--')) found.push('checkout -- <path>')
    else if (sub === 'restore' && flag('--staged', '-S', '--source', '-s')) found.push('restore --staged')
  }
  return [...new Set(found)]
}

// Options whose value is a separate word: `-m "text"` is not a commit path.
const COMMIT_VALUE_SHORT = new Set(['m', 'F', 'c', 'C', 't'])
const COMMIT_VALUE_LONG = new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--author', '--date', '--cleanup', '--template', '--trailer', '--pathspec-from-file'])
const ADD_VALUE_LONG = new Set(['--chmod', '--pathspec-from-file'])

/**
 * What goes into the commit, from the arguments of one `git add`/`git commit` command — without running git:
 * `all` — the whole tree including untracked files (`git add -A` without paths, paths from a file), `tracked` —
 * all changes to tracked files (`git add -u`, `git commit -a`), `specs` — paths as git understands them,
 * with the call directory. An already built index is not included here — the hook adds it.
 * Doubt is resolved toward wider coverage: an extra file in the check is safer than a missed one.
 */
export function commitScope(invocations) {
  const scope = { all: false, tracked: false, specs: [] }
  for (const { subcommand, dir, args } of invocations) {
    const specs = []
    let all = false
    let tracked = false
    const valueShort = subcommand === 'commit' ? COMMIT_VALUE_SHORT : new Set()
    const valueLong = subcommand === 'commit' ? COMMIT_VALUE_LONG : ADD_VALUE_LONG
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '--') {
        specs.push(...args.slice(i + 1))
        break
      }
      // Redirections: `> out.txt` and `2>/dev/null` are not paths.
      if (/^\d*[<>]{1,2}$/.test(arg)) {
        i++
        continue
      }
      if (/^\d*[<>]/.test(arg)) continue
      if (arg.startsWith('--')) {
        const [name, value] = arg.split('=', 2)
        if (name === '--pathspec-from-file') all = true
        if (subcommand === 'add' && (name === '--all' || name === '--no-ignore-removal')) all = true
        if ((subcommand === 'add' && name === '--update') || (subcommand === 'commit' && name === '--all')) tracked = true
        if (valueLong.has(name) && value === undefined) i++
        continue
      }
      if (arg.startsWith('-') && arg.length > 1) {
        for (let k = 1; k < arg.length; k++) {
          const flag = arg[k]
          if (subcommand === 'add' && flag === 'A') all = true
          // `-p`/`-i` without paths — interactive choice among tracked files.
          if (subcommand === 'add' && 'upi'.includes(flag)) tracked = true
          if (subcommand === 'commit' && flag === 'a') tracked = true
          if (valueShort.has(flag)) {
            if (k === arg.length - 1) i++
            break
          }
        }
        continue
      }
      specs.push(arg)
    }
    // In `git add`, paths narrow both `-A` and `-u`; in `git commit`, `-a` and paths are a union (git does not mix them itself).
    if (subcommand === 'add' && specs.length) {
      all = false
      tracked = false
    }
    scope.all ||= all
    scope.tracked ||= tracked
    scope.specs.push(...specs.map((spec) => ({ dir, spec })))
  }
  return scope
}

// A simple shell lexer: quotes, escaping, the operators `&& || ; | & ( )`, newline, heredoc.
export function commandSegments(line) {
  const segments = [[]]
  let word = null
  let heredoc = null
  const flush = () => {
    if (word !== null) segments.at(-1).push(word)
    word = null
  }
  const split = () => {
    flush()
    if (segments.at(-1).length) segments.push([])
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\n' && heredoc) {
      // The heredoc body runs up to a line with only the delimiter; it does not become commands.
      let start = i + 1
      i = line.length
      while (start <= line.length) {
        const next = line.indexOf('\n', start)
        const end = next === -1 ? line.length : next
        if (line.slice(start, end).trim() === heredoc) {
          i = end
          break
        }
        if (next === -1) break
        start = next + 1
      }
      heredoc = null
      split()
    } else if (c === '\\' && i + 1 < line.length) {
      word = (word ?? '') + line[++i]
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1)
      word = (word ?? '') + line.slice(i + 1, end === -1 ? line.length : end)
      i = end === -1 ? line.length : end
    } else if (c === '"') {
      let j = i + 1
      let text = ''
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length) j++
        text += line[j++]
      }
      word = (word ?? '') + text
      i = j
    } else if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      flush()
      const m = line.slice(i + 2).match(/^-?\s*(['"]?)([\w.-]+)\1/)
      if (m) heredoc = m[2]
      i += 1 + (m ? m[0].length : 0)
    } else if (c === '\n') {
      split()
    } else if (/\s/.test(c)) {
      flush()
    } else if (';&|()'.includes(c)) {
      split()
    } else {
      word = (word ?? '') + c
    }
  }
  flush()
  return segments.filter((segment) => segment.length)
}
