import { resolve } from 'node:path'

/**
 * Вызовы `git add`/`git commit` в строке Bash-команды — в позиции команды, с глобальными опциями
 * (`-C`, `-c k=v`, `--no-pager`, …) и с учётом `cd <dir> &&` перед ними: хук проверяет тот репо,
 * в который команда реально коммитит. Слова внутри кавычек и тела heredoc — не команды:
 * `grep "git add"` или сообщение коммита со словами «git commit» хук не трогают.
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

// Опции со значением отдельным словом: `-m "текст"` — не путь коммита.
const COMMIT_VALUE_SHORT = new Set(['m', 'F', 'c', 'C', 't'])
const COMMIT_VALUE_LONG = new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--author', '--date', '--cleanup', '--template', '--trailer', '--pathspec-from-file'])
const ADD_VALUE_LONG = new Set(['--chmod', '--pathspec-from-file'])

/**
 * Что войдёт в коммит по аргументам `git add`/`git commit` одной команды — без запуска git:
 * `all` — всё дерево вместе с неотслеживаемыми (`git add -A` без путей, пути из файла), `tracked` —
 * все изменения отслеживаемых (`git add -u`, `git commit -a`), `specs` — пути в том виде, в каком
 * их понимает git, с каталогом вызова. Уже собранный индекс сюда не входит — его добавляет хук.
 * Сомнение решается в сторону большего охвата: лишний файл в проверке безопаснее пропущенного.
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
      // Перенаправления: `> out.txt` и `2>/dev/null` — не пути.
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
          // `-p`/`-i` без путей — интерактивный выбор среди отслеживаемых.
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
    // У `git add` пути сужают и `-A`, и `-u`; у `git commit` `-a` и пути — объединение (git сам их не смешивает).
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

// Простой шелл-лексер: кавычки, экранирование, операторы `&& || ; | & ( )`, перевод строки, heredoc.
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
      // Тело heredoc — до строки с одним ограничителем; в команды оно не попадает.
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
