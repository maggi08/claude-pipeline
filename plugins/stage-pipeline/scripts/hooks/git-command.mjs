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
    if (words[i] === 'add' || words[i] === 'commit') found.push({ subcommand: words[i], dir: target })
  }
  return found
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
