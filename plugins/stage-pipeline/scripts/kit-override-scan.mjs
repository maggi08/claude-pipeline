#!/usr/bin/env node
/**
 * Переопределения кита и ручная типографика в добавленных строках дифа: вес шрифта, uppercase, трекинг,
 * произвольные `text-[…]`, `rounded-[…]`, отступы и ширины, `!important`, переменные компонентов кита.
 *
 * Зачем: в одной задаче вид взяли из прототипа, а не из кита и соседних секций дашборда — пятнадцать
 * констант с `uppercase 11px extrabold`, кнопки 36px с `font-bold`, таблица своего вида, `max-w-[70ch]`.
 * Ни один чекер это не назвал: прототип совпадал с кодом, а сверки с соседями не было. Пользователь вернул
 * «жирно», «разные кнопки», «другая таблица» тремя волнами правок после «готово».
 *
 * Каждый файл с переопределениями — находка major. Отчёт в формате чекера, поэтому дальше работает
 * «Итог находок» (references/checker-report.md): исправлено, ложная — с доказательством, что эталонная
 * секция делает так же (`путь:строка`), или решение пользователя «вид как в прототипе».
 *
 *   node kit-override-scan.mjs                         # незакоммиченное против HEAD (этап перед коммитом)
 *   node kit-override-scan.mjs --base origin/dev       # всё от merge-base
 *   node kit-override-scan.mjs --out <task>/checks/stage-3-kit-overrides.md
 *
 * Каталоги кита из `ui_lib` / `ui_kit` конфига не сканируются — правка там и есть правка кита. В самом
 * репо кита скан выключается строкой `- kit_overrides: off` в pipeline.config.md.
 * Код выхода: 1 — есть находки (без `--out`), 0 — нет или отчёт записан, 2 — скрипт не смог.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readConfig } from './hooks/pipeline-state.mjs'

const CODE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?|css|scss|sass|less|styl)$/
const SKIP =
  /(^|\/)(?:\.claude|node_modules|dist|build|\.next|\.nuxt|\.output|coverage|vendor|__generated__|__mocks__|fixtures?|mocks?)\/|\.(?:test|spec|stories|story|cy|e2e)\.\w+$|(^|\/)(?:tailwind|postcss|vite|next|nuxt)\.config\.\w+$|(^|\/)(?:design-)?tokens?[^/]*\.\w+$|(^|\/)theme[^/]*\.\w+$/
// Произвольное значение через переменную токена — `text-[var(--text-secondary)]` — это токен, а не переопределение.
const TOKEN_VALUE = /\[var\(--[\w-]+\)\]$/

const RULES = [
  ['вес шрифта', /(?<![\w-])font-(?:semibold|bold|extrabold|black)(?![\w-])|font-weight\s*:\s*(?:[6-9]00|bold(?:er)?)\b|fontWeight\s*:\s*['"]?(?:[6-9]00|bold)\b/g],
  ['регистр', /(?<![\w-])uppercase(?![\w-])|text-transform\s*:\s*uppercase|textTransform\s*:\s*['"]uppercase/g],
  ['трекинг', /(?<![\w-])tracking-(?:\[[^\]\s]+\]|tighter|tight|wider|widest|wide)(?![\w-])|letter-spacing\s*:|letterSpacing\s*:/g],
  ['кегль', /(?<![\w-])(?:text|leading)-\[[^\]\s]+\]|font-size\s*:\s*\d+(?:\.\d+)?px|fontSize\s*:\s*['"]?\d+/g],
  ['радиус', /(?<![\w-])rounded(?:-[trblse]{1,2})?-\[[^\]\s]+\]|border-radius\s*:\s*\d+(?:\.\d+)?px/g],
  ['отступ', /(?<![\w-])-?(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy])-\[[^\]\s]+\]/g],
  ['ширина текста', /(?<![\w-])max-w-\[[^\]\s]+\]/g],
  ['тень', /(?<![\w-])shadow-\[[^\]\s]+\]/g],
  ['!important', /!important\b/g],
  ['переменная кита', /--(?:button|btn|table|input|badge|chip|tag|card|select|tooltip|modal|dialog|pill)-[\w-]+\s*:/g],
]
const COMMENT = /^\s*(?:\/\/|\/?\*|<!--)/

/** Каталоги кита внутри репо — из `ui_lib` / `ui_kit` конфига: пути в бэктиках или со слешем, которые существуют. */
export function kitDirs(config, root) {
  const dirs = []
  for (const [, value] of config.matchAll(/^\s*-\s*ui_(?:lib|kit)\s*:\s*(.+)$/gim)) {
    for (const candidate of [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]).concat(value.split(/[\s,;]+/))) {
      const path = candidate.replace(/[`'"→]/g, '').replace(/\/+$/, '')
      if (!path.includes('/') || path.startsWith('..') || path.startsWith('/') || path.startsWith('node_modules')) continue
      try {
        if (statSync(join(root, path)).isDirectory()) dirs.push(`${path}/`)
      } catch {
        // не путь в репо — имя пакета или комментарий
      }
    }
  }
  return [...new Set(dirs)]
}

export const scanDisabled = (config) => /^\s*-\s*kit_overrides\s*:\s*`?(?:off|false|no|нет)\b/im.test(config)

/**
 * Переопределения в добавленных строках: `[{ file, hits: [{ kind, token, line }] }]`.
 * `against` — с чем сравнивать рабочее дерево (HEAD или merge-base), `paths` — pathspec'и коммита (null — всё).
 */
export function scanOverrides(root, { against = 'HEAD', paths = null, config = readConfig(root) } = {}) {
  if (scanDisabled(config)) return []
  const kit = kitDirs(config, root)
  const scanned = (file) => CODE.test(file) && !SKIP.test(file) && !kit.some((dir) => file.startsWith(dir))
  const spec = paths ?? []
  const added = new Map()
  const push = (file, line, text) => {
    if (!scanned(file) || COMMENT.test(text)) return
    if (!added.has(file)) added.set(file, [])
    added.get(file).push({ line, text })
  }
  let file = null
  let next = 0
  for (const row of git(root, 'diff', against, '-U0', '--no-color', '--no-ext-diff', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/', '--', ...spec).split('\n')) {
    if (row.startsWith('+++ ')) file = row === '+++ /dev/null' ? null : row.slice(6)
    else if (row.startsWith('@@')) next = Number(row.match(/\+(\d+)/)?.[1] ?? 0)
    else if (row.startsWith('+') && file) push(file, next++, row.slice(1))
  }
  for (const untracked of git(root, 'ls-files', '--others', '--exclude-standard', '-z', '--', ...spec).split('\0').filter(Boolean)) {
    if (!scanned(untracked)) continue
    let text
    try {
      text = readFileSync(join(root, untracked), 'utf8')
    } catch {
      continue
    }
    text.split('\n').forEach((row, index) => push(untracked, index + 1, row))
  }
  const found = []
  for (const [path, lines] of added) {
    const hits = []
    for (const { line, text } of lines) {
      for (const [kind, pattern] of RULES) {
        for (const match of text.matchAll(pattern)) {
          if (!TOKEN_VALUE.test(match[0])) hits.push({ kind, token: match[0].trim(), line })
        }
      }
    }
    if (hits.length) found.push({ file: path, hits })
  }
  return found
}

/** Строка находки: «вес шрифта (`font-bold` ×3), регистр (`uppercase`)». */
export function summarize(hits) {
  const kinds = new Map()
  for (const { kind, token } of hits) {
    if (!kinds.has(kind)) kinds.set(kind, new Map())
    const tokens = kinds.get(kind)
    tokens.set(token, (tokens.get(token) ?? 0) + 1)
  }
  return [...kinds]
    .map(([kind, tokens]) => `${kind} (${[...tokens].map(([token, count]) => `\`${token.replace(/\|/g, '\\|')}\`${count > 1 ? ` ×${count}` : ''}`).join(', ')})`)
    .join(', ')
}

export function renderReport(found, { title = 'рабочее дерево против HEAD', previous = '' } = {}) {
  const lines = [`# kit-overrides: ${title}`, `Находки: critical 0 · major ${found.length} · minor 0`, '']
  if (found.length) {
    lines.push(
      'Переопределения кита и ручная типографика в добавленных строках. Вид — из кита и эталонной секции («Эталон вида» этапа в STAGES.md);',
      'переопределение остаётся только с доказательством, что эталон делает так же (`путь:строка`), или решением пользователя «вид как в прототипе».',
      '',
      '| # | Файл | Что переопределено | Строки | Severity |',
      '|---|---|---|---|---|',
      ...found.map(({ file, hits }, index) => `| K-${index + 1} | \`${file}\` | ${summarize(hits)} | ${[...new Set(hits.map(({ line }) => line))].slice(0, 12).join(', ')} | major |`),
    )
  } else {
    lines.push('Переопределений кита в добавленных строках нет.')
  }
  lines.push('', '## Не удалось проверить', '- стили, собранные в рантайме (`cn(cond && …)`, значения из переменных), скрипт видит только литералами — вычисленный вид сверяет devtools-verify с эталонной секцией.')
  // Повторный скан после фиксов не стирает итог: строки «исправлено» относятся к прошлым находкам.
  const ledger = previous.match(/^#{2,3}\s*Итог находок[\s\S]*$/m)?.[0]
  if (ledger) lines.push('', ledger.trimEnd())
  return `${lines.join('\n')}\n`
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
}

function main(args) {
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
  let root
  try {
    root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim()
  } catch {
    console.error('kit-override-scan: не git-репозиторий')
    process.exit(2)
  }
  const base = option('--base')
  let against = 'HEAD'
  if (base) {
    try {
      against = git(root, 'merge-base', base, 'HEAD').trim()
    } catch {
      console.error(`kit-override-scan: нет merge-base с ${base}`)
      process.exit(2)
    }
  }
  const found = scanOverrides(root, { against })
  const out = option('--out')
  if (out) {
    const path = resolve(out)
    writeFileSync(path, renderReport(found, { title: base ? `ветка от ${base}` : 'рабочее дерево против HEAD', previous: existsSync(path) ? readFileSync(path, 'utf8') : '' }))
    console.log(`kit-override-scan: ${found.length} файл(ов) с переопределениями → ${path}`)
    process.exit(0)
  }
  for (const { file, hits } of found) console.log(`- ${file}: ${summarize(hits)}`)
  if (!found.length) console.log('Переопределений кита в добавленных строках нет.')
  process.exit(found.length ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
