import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { commandSegments } from './git-command.mjs'

/**
 * Какие части Bash-команды остановят прогон на вопросе пользователю — без запуска Claude Code.
 * Повторяет его правила настолько, насколько это нужно force-guard: команда режется на подкоманды
 * по `&& || ; | &` и переводу строки, у каждой снимаются `FOO=1`, `nohup`, `time`, `nice`, `timeout N`,
 * и подкоманда сверяется с `Bash(...)` из `ask`. Слова в кавычках и тела heredoc — не команды:
 * `echo "pkill later"` и `grep -rn "git push" .` никого не останавливают.
 */

// `pkill`/`killall` снимают процессы по имени — в том числе dev-сервер пользователя и соседнюю сессию.
const NAME_KILLERS = new Set(['pkill', 'killall'])
const WRAPPERS = new Set(['command', 'nohup', 'time', 'nice', 'exec'])

/** Подкоманды строки: слова без обёрток, в том виде, в каком их сверяют правила. */
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

/** Подкоманда, которая снимает процессы по имени: `pkill -f x`, `/usr/bin/killall node`, `… | xargs pkill`. */
export function nameKill(line) {
  for (const words of subcommands(line)) {
    let i = 0
    if (words[0] === 'xargs') for (i = 1; i < words.length && words[i].startsWith('-'); i++);
    if (NAME_KILLERS.has(basename(words[i] ?? ''))) return words.join(' ')
  }
  return null
}

/**
 * `Bash(...)` → регулярка. `*` — любые символы, хвост ` *` — сама команда или она же с аргументами,
 * старая форма `:*` — то же. Голое `Bash` и `Bash(*)` в ask не берутся: «спрашивать всё» хук не превратит
 * в «отклонять всё» — force с таким профилем не работает и без хука.
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

/** Первая подкоманда строки, которую остановит одно из ask-правил: `{ command, rule, source }` или null. */
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
 * Ask-правила Bash из settings, которые видит сессия: пользовательский и оба проектных файла.
 * Битый или отсутствующий файл — не ошибка хука: правил из него просто нет.
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
