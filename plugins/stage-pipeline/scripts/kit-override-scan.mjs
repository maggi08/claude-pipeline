#!/usr/bin/env node
/**
 * Kit overrides and hand-set typography in the added lines of the diff: font weight, uppercase, tracking,
 * arbitrary `text-[…]`, `rounded-[…]`, spacing and widths, `!important`, kit component variables.
 *
 * Why: in one task the look was taken from the prototype, not from the kit and neighbouring dashboard sections — fifteen
 * constants with `uppercase 11px extrabold`, 36px buttons with `font-bold`, a table with its own look, `max-w-[70ch]`.
 * No checker named it: the prototype matched the code, and there was no comparison with neighbours. The user sent back
 * "too bold", "different buttons", "another table" in three waves of edits after "done".
 *
 * Each file with overrides is a major finding. The report is in the checker format, so "Findings outcome"
 * (references/checker-report.md) works further: fixed, false — with proof that the reference
 * section does the same (`path:line`), or a user decision "the look as in the prototype".
 *
 *   node kit-override-scan.mjs                         # uncommitted against HEAD (the stage before its commit)
 *   node kit-override-scan.mjs --base origin/dev       # everything from the merge-base
 *   node kit-override-scan.mjs --out <task>/checks/stage-3-kit-overrides.md
 *
 * Kit directories from the config's `ui_lib` / `ui_kit` are not scanned — an edit there is an edit of the kit. In the
 * kit's own repo the scan is switched off by the line `- kit_overrides: off` in pipeline.config.md.
 * Exit code: 1 — there are findings (without `--out`), 0 — none or the report is written, 2 — the script could not run.
 *
 * The report is a file of the task, so its text is written in the task language (taskLanguage; unknown → ru, as before).
 * The kind of a hit (`kind`) is a language-neutral English label; the report and messages translate it. Console output is English.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readConfig, readPipelineState, taskLanguage } from './hooks/pipeline-state.mjs'
import { KIT_OVERRIDES_OFF, LEDGER_HEADING } from './markers.mjs'

const CODE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?|css|scss|sass|less|styl)$/
const SKIP =
  /(^|\/)(?:\.claude|node_modules|dist|build|\.next|\.nuxt|\.output|coverage|vendor|__generated__|__mocks__|fixtures?|mocks?)\/|\.(?:test|spec|stories|story|cy|e2e)\.\w+$|(^|\/)(?:tailwind|postcss|vite|next|nuxt)\.config\.\w+$|(^|\/)(?:design-)?tokens?[^/]*\.\w+$|(^|\/)theme[^/]*\.\w+$/
// An arbitrary value through a token variable — `text-[var(--text-secondary)]` — is a token, not an override.
const TOKEN_VALUE = /\[var\(--[\w-]+\)\]$/

const RULES = [
  ['font weight', /(?<![\w-])font-(?:semibold|bold|extrabold|black)(?![\w-])|font-weight\s*:\s*(?:[6-9]00|bold(?:er)?)\b|fontWeight\s*:\s*['"]?(?:[6-9]00|bold)\b/g],
  ['text case', /(?<![\w-])uppercase(?![\w-])|text-transform\s*:\s*uppercase|textTransform\s*:\s*['"]uppercase/g],
  ['tracking', /(?<![\w-])tracking-(?:\[[^\]\s]+\]|tighter|tight|wider|widest|wide)(?![\w-])|letter-spacing\s*:|letterSpacing\s*:/g],
  ['font size', /(?<![\w-])(?:text|leading)-\[[^\]\s]+\]|font-size\s*:\s*\d+(?:\.\d+)?px|fontSize\s*:\s*['"]?\d+/g],
  ['radius', /(?<![\w-])rounded(?:-[trblse]{1,2})?-\[[^\]\s]+\]|border-radius\s*:\s*\d+(?:\.\d+)?px/g],
  ['spacing', /(?<![\w-])-?(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy])-\[[^\]\s]+\]/g],
  ['text width', /(?<![\w-])max-w-\[[^\]\s]+\]/g],
  ['shadow', /(?<![\w-])shadow-\[[^\]\s]+\]/g],
  ['!important', /!important\b/g],
  ['kit variable', /--(?:button|btn|table|input|badge|chip|tag|card|select|tooltip|modal|dialog|pill)-[\w-]+\s*:/g],
]
const COMMENT = /^\s*(?:\/\/|\/?\*|<!--)/

// How a kind of hit is called in a report of a ru task (the English label is the kind itself).
const RU_KIND = {
  'font weight': 'вес шрифта',
  'text case': 'регистр',
  tracking: 'трекинг',
  'font size': 'кегль',
  radius: 'радиус',
  spacing: 'отступ',
  'text width': 'ширина текста',
  shadow: 'тень',
  '!important': '!important',
  'kit variable': 'переменная кита',
}

/** Kit directories inside the repo — from the config's `ui_lib` / `ui_kit`: paths in backticks or with a slash that exist. */
export function kitDirs(config, root) {
  const dirs = []
  for (const [, value] of config.matchAll(/^\s*-\s*ui_(?:lib|kit)\s*:\s*(.+)$/gim)) {
    for (const candidate of [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]).concat(value.split(/[\s,;]+/))) {
      const path = candidate.replace(/[`'"→]/g, '').replace(/\/+$/, '')
      if (!path.includes('/') || path.startsWith('..') || path.startsWith('/') || path.startsWith('node_modules')) continue
      try {
        if (statSync(join(root, path)).isDirectory()) dirs.push(`${path}/`)
      } catch {
        // not a path in the repo — a package name or a comment
      }
    }
  }
  return [...new Set(dirs)]
}

export const scanDisabled = (config) => KIT_OVERRIDES_OFF.test(config)

/**
 * Overrides in the added lines: `[{ file, hits: [{ kind, token, line }] }]`.
 * `against` is what the working tree is compared with (HEAD or the merge-base), `paths` are the commit's pathspecs (null — everything).
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

/** A finding line: "font weight (`font-bold` ×3), text case (`uppercase`)"; `language: 'ru'` gives the Russian labels. */
export function summarize(hits, language = 'en') {
  const kinds = new Map()
  for (const { kind, token } of hits) {
    if (!kinds.has(kind)) kinds.set(kind, new Map())
    const tokens = kinds.get(kind)
    tokens.set(token, (tokens.get(token) ?? 0) + 1)
  }
  return [...kinds]
    .map(([kind, tokens]) => `${language === 'ru' ? (RU_KIND[kind] ?? kind) : kind} (${[...tokens].map(([token, count]) => `\`${token.replace(/\|/g, '\\|')}\`${count > 1 ? ` ×${count}` : ''}`).join(', ')})`)
    .join(', ')
}

// Report texts by task language. In a ru task they stay as they were, byte for byte.
const REPORT = {
  ru: {
    title: 'рабочее дерево против HEAD',
    summary: (n) => `Находки: critical 0 · major ${n} · minor 0`,
    intro: [
      'Переопределения кита и ручная типографика в добавленных строках. Вид — из кита и эталонной секции («Эталон вида» этапа в STAGES.md);',
      'переопределение остаётся только с доказательством, что эталон делает так же (`путь:строка`), или решением пользователя «вид как в прототипе».',
    ],
    columns: ['| # | Файл | Что переопределено | Строки | Severity |', '|---|---|---|---|---|'],
    none: 'Переопределений кита в добавленных строках нет.',
    unverified: '## Не удалось проверить',
    runtime:
      '- стили, собранные в рантайме (`cn(cond && …)`, значения из переменных), скрипт видит только литералами — вычисленный вид сверяет devtools-verify с эталонной секцией.',
  },
  en: {
    title: 'working tree against HEAD',
    summary: (n) => `Findings: critical 0 · major ${n} · minor 0`,
    intro: [
      'Kit overrides and hand-set typography in the added lines. The look comes from the kit and the reference section (the stage\'s "Visual reference" in STAGES.md);',
      'an override stays only with proof that the reference does the same (`path:line`), or a user decision "the look as in the prototype".',
    ],
    columns: ['| # | File | What is overridden | Lines | Severity |', '|---|---|---|---|---|'],
    none: 'No kit overrides in the added lines.',
    unverified: '## Could not verify',
    runtime:
      '- styles assembled at runtime (`cn(cond && …)`, values from variables) are seen by the script only as literals — devtools-verify checks the computed look against the reference section.',
  },
}

export function renderReport(found, { title, previous = '', language = 'ru' } = {}) {
  const text = REPORT[language] ?? REPORT.ru
  const lines = [`# kit-overrides: ${title ?? text.title}`, text.summary(found.length), '']
  if (found.length) {
    lines.push(
      ...text.intro,
      '',
      ...text.columns,
      ...found.map(({ file, hits }, index) => `| K-${index + 1} | \`${file}\` | ${summarize(hits, language)} | ${[...new Set(hits.map(({ line }) => line))].slice(0, 12).join(', ')} | major |`),
    )
  } else {
    lines.push(text.none)
  }
  lines.push('', text.unverified, text.runtime)
  // A repeated scan after fixes does not erase the outcome: the "fixed" lines belong to earlier findings.
  const ledgerAt = previous.search(LEDGER_HEADING)
  const ledger = ledgerAt === -1 ? null : previous.slice(ledgerAt)
  if (ledger) lines.push('', ledger.trimEnd())
  return `${lines.join('\n')}\n`
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
}

/** The language of the report to write: the task whose `checks/` it goes into (`<task>/checks/<file>`), else the current branch's task; unknown — ru. */
function taskLanguageFor(reportPath, root) {
  const stages = join(dirname(dirname(reportPath)), 'STAGES.md')
  try {
    if (existsSync(stages)) return taskLanguage(readFileSync(stages, 'utf8')) ?? 'ru'
  } catch {
    // unreadable — fall back to the current task
  }
  return readPipelineState(root)?.tasks.find((candidate) => candidate.current)?.language ?? 'ru'
}

function main(args) {
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
  let root
  try {
    root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim()
  } catch {
    console.error('kit-override-scan: not a git repository')
    process.exit(2)
  }
  const base = option('--base')
  let against = 'HEAD'
  if (base) {
    try {
      against = git(root, 'merge-base', base, 'HEAD').trim()
    } catch {
      console.error(`kit-override-scan: no merge-base with ${base}`)
      process.exit(2)
    }
  }
  const found = scanOverrides(root, { against })
  const out = option('--out')
  if (out) {
    const path = resolve(out)
    const language = taskLanguageFor(path, root)
    const title = base ? (language === 'en' ? `branch off ${base}` : `ветка от ${base}`) : undefined
    writeFileSync(path, renderReport(found, { title, previous: existsSync(path) ? readFileSync(path, 'utf8') : '', language }))
    console.log(`kit-override-scan: ${found.length} file(s) with overrides → ${path}`)
    process.exit(0)
  }
  for (const { file, hits } of found) console.log(`- ${file}: ${summarize(hits)}`)
  if (!found.length) console.log('No kit overrides in the added lines.')
  process.exit(found.length ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
