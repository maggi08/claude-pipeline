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
 *   node kit-override-scan.mjs --reference src/pages/Neighbour.tsx    # the stage's reference file (repeatable): a value it has too is skipped and listed with its file:line
 *
 * False-positive patterns (stage 13, `skills/stage-check/references/kit-overrides-false-positives.md`): a hit that is not a new override is skipped, listed in the report
 * with the id of the pattern that skipped it (never dropped silently): `moved-line` — the same line is removed in the diff from a file the scan reads, as many times as it is added,
 * and the removal is a move: from the same file, from a file the diff deletes or renames, or as a contiguous block of 3+ lines that reappears as a block; `token-shorthand` — an arbitrary value that is only a CSS variable (`rounded-[--radius-md]`) that
 * the diff itself does not declare; `reference-line` — the same value stands in a reference file the caller names with `--reference <file>`, which the diff does not touch: the report says "the reference does the same", and now it says where. A line with
 * `!important` or a kit variable is never skipped.
 *
 * Kit directories from the config's `ui_lib` / `ui_kit` are not scanned — an edit there is an edit of the kit. In the
 * kit's own repo the scan is switched off by the line `- kit_overrides: off` in pipeline.config.md.
 * Exit code: 1 — there are findings (without `--out`), 0 — none or the report is written, 2 — the script could not run.
 *
 * The report is a file of the task, so its text is written in the task language (taskLanguage; unknown → ru, as before).
 * The kind of a hit (`kind`) is a language-neutral English label; the report and messages translate it. Console output is English.
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
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

/** The ids of the false-positive patterns the scan applies; `references/kit-overrides-false-positives.md` documents each one under a heading of the same name. */
export const SKIP_PATTERNS = ['moved-line', 'token-shorthand', 'reference-line']
// Kinds no pattern skips: a kit component variable redefined or `!important` is an override wherever the line came from.
const NEVER_SKIPPED = new Set(['!important', 'kit variable'])
// `rounded-[--radius-md]`: Tailwind's shorthand for a variable (`[--x]` since v3.3; v4 writes `(--x)`), a token as `[var(--x)]` is.
const TOKEN_SHORTHAND = /\[(--[\w-]+)\]$/
const normalized = (text) => text.trim().replace(/\s+/g, ' ').replace(/[,;]$/, '')

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

/** A file the scan reads: code by extension, not a story/test/mock/config, not in a kit directory. */
const isScanned = (file, kit) => CODE.test(file) && !SKIP.test(file) && !kit.some((dir) => file.startsWith(dir))
// An untracked file larger than this is not code written by hand (a dump, a bundle): it is not read.
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024

/**
 * The text of a regular file inside the cap, or null. `lstat`, not `stat`: a symlink (to `/dev/zero`, a FIFO) is not code the stage wrote and `stat` reports its
 * target's size 0, so the cap would pass and the read would never end. The read itself is bounded by the cap, whatever the file turns into.
 */
function readRegular(path) {
  const info = lstatSync(path)
  if (!info.isFile() || info.size > MAX_UNTRACKED_BYTES) return null
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(info.size, MAX_UNTRACKED_BYTES))
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.toString('utf8', 0, length)
  } finally {
    closeSync(fd)
  }
}

export const scanDisabled = (config) => KIT_OVERRIDES_OFF.test(config)

/**
 * Overrides in the added lines: `[{ file, hits: [{ kind, token, line }] }]`.
 * `against` is what the working tree is compared with (HEAD or the merge-base), `paths` are the commit's pathspecs (null — everything).
 */
export function scanOverrides(root, options = {}) {
  return scanOverridesDetailed(root, options).found
}

/** `scanOverrides` and what the false-positive patterns skipped: `{ found, skipped }`, `skipped` is `[{ file, hits: [{ kind, token, line, skip }] }]` with the pattern id in `skip`. */
export function scanOverridesDetailed(root, { against = 'HEAD', paths = null, config = readConfig(root), reference = [] } = {}) {
  if (scanDisabled(config)) return { found: [], skipped: [] }
  const kit = kitDirs(config, root)
  const spec = paths ?? []
  const untracked = []
  for (const name of git(root, 'ls-files', '--others', '--exclude-standard', '-z', '--', ...spec).split('\0').filter(Boolean)) {
    if (!isScanned(name, kit)) continue
    try {
      const text = readRegular(join(root, name))
      if (text !== null) untracked.push({ file: name, text })
    } catch {
      // a file that cannot be read has no lines to scan
    }
  }
  const diff = git(root, 'diff', against, '-U0', '--no-color', '--no-ext-diff', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/', '--', ...spec)
  const references = []
  for (const name of reference) {
    try {
      const text = readRegular(join(root, name))
      if (text !== null) references.push({ file: name, text })
    } catch {
      // a reference that is not a readable file in the repo names nothing
    }
  }
  return scanDiffText(diff, { kit, untracked, reference: references })
}

/**
 * The scan over a unified diff (`-U0`, `a/` and `b/` prefixes) and the text of untracked files `[{ file, text }]`, with the kit directories left out: `{ found, skipped }`.
 * The scan of a working tree is this function over `git diff`; a test or a replay over a commit gives it the diff of that commit (without `--find-renames`, as an
 * uncommitted move looks: the old file deleted, the new one untracked). `reference` is `[{ file, text }]`: a reference file the diff touches is no proof and is ignored.
 */
export function scanDiffText(diff, { kit = [], untracked = [], reference = [] } = {}) {
  const scanned = (file) => isScanned(file, kit)
  const added = new Map()
  const push = (file, line, text) => {
    if (!scanned(file) || COMMENT.test(text)) return
    if (!added.has(file)) added.set(file, [])
    added.get(file).push({ line, text })
  }
  let file = null
  let next = 0
  let header = false
  // The lines the diff removes from files the scan reads (a moved or extracted line leaves its old place). A removed line covers an added one only as a move:
  // in the same file (a renamed file is the same file under its new name), from a file the diff deletes, or as part of a contiguous block of MOVE_BLOCK lines that reappears as a block. Counted: a line
  // added three times and removed once is two new copies. A removed line of a story, a test or a kit file, or a line removed because it was fixed, covers nothing.
  const MOVE_BLOCK = 3
  const sameFile = new Map() // `${file}\0${line}` → count
  const goneFile = new Map() // line → count, from deleted files only (a renamed file is the same file: its removed lines are keyed by its new name in sameFile)
  const grams = new Map() // MOVE_BLOCK removed lines in a row, joined → count
  let source = null
  let gone = false // `deleted file mode`: the lines left the repo's files, they may reappear anywhere
  let block = []
  const closeBlock = () => {
    for (let at = 0; at + MOVE_BLOCK <= block.length; at++) {
      const key = block.slice(at, at + MOVE_BLOCK).join('\n')
      grams.set(key, (grams.get(key) ?? 0) + 1)
    }
    block = []
  }
  for (const row of diff.split('\n')) {
    if (row.startsWith('diff --git ')) {
      closeBlock()
      header = true
      const names = row.match(/^diff --git a\/(.*) b\/(.*)$/)
      source = names ? names[2] : null
      gone = false
    } else if (header && row.startsWith('deleted file mode')) gone = true
    else if (row.startsWith('+++ ')) file = row === '+++ /dev/null' ? null : row.slice(6)
    else if (row.startsWith('@@')) {
      closeBlock()
      header = false
      next = Number(row.match(/\+(\d+)/)?.[1] ?? 0)
    } else if (row.startsWith('+') && file) {
      closeBlock()
      push(file, next++, row.slice(1))
    } else if (row.startsWith('-') && !header && source && scanned(source)) {
      const text = normalized(row.slice(1))
      block.push(text)
      const map = gone ? goneFile : sameFile
      const key = gone ? text : `${source}\0${text}`
      map.set(key, (map.get(key) ?? 0) + 1)
    } else closeBlock()
  }
  closeBlock()
  const touched = new Set([...diff.matchAll(/^diff --git a\/.* b\/(.*)$/gm)].map((found) => found[1]).concat(untracked.map(({ file: name }) => name)))
  const references = reference.filter(({ file: name }) => !touched.has(name))
  for (const { file: name, text } of untracked) {
    if (!scanned(name)) continue
    text.split('\n').forEach((row, index) => push(name, index + 1, row))
  }
  // A variable the diff itself declares is a token made by hand, not the kit's.
  const declared = new Set()
  for (const lines of added.values()) for (const { text } of lines) for (const [, name] of text.matchAll(/(--[\w-]+)\s*:/g)) declared.add(name)
  const found = []
  const skipped = []
  for (const [path, lines] of added) {
    const hits = []
    const skips = []
    // lines that are part of a block of MOVE_BLOCK added in a row that the diff removes as a block
    const blockMoved = new Set()
    for (let at = 0; at + MOVE_BLOCK <= lines.length; at++) {
      const window = lines.slice(at, at + MOVE_BLOCK)
      if (window.some((row, index) => row.line !== window[0].line + index)) continue
      const key = window.map((row) => normalized(row.text)).join('\n')
      if ((grams.get(key) ?? 0) > 0) {
        grams.set(key, grams.get(key) - 1)
        for (const row of window) blockMoved.add(row.line)
      }
    }
    for (const { line, text } of lines) {
      const own = []
      for (const [kind, pattern] of RULES) {
        for (const match of text.matchAll(pattern)) {
          if (!TOKEN_VALUE.test(match[0])) own.push({ kind, token: match[0].trim(), line })
        }
      }
      for (const hit of own) {
        const variable = hit.token.match(TOKEN_SHORTHAND)?.[1]
        if (variable && !declared.has(variable)) hit.skip = 'token-shorthand'
      }
      const open = own.filter((hit) => !hit.skip && !NEVER_SKIPPED.has(hit.kind))
      const key = normalized(text)
      const own1 = `${path}\0${key}`
      let moved = false
      if (open.length) {
        if ((sameFile.get(own1) ?? 0) > 0) {
          sameFile.set(own1, sameFile.get(own1) - 1)
          moved = true
        } else if ((goneFile.get(key) ?? 0) > 0) {
          goneFile.set(key, goneFile.get(key) - 1)
          moved = true
        } else if (blockMoved.has(line)) moved = true
      }
      if (moved) for (const hit of open) hit.skip = 'moved-line'
      for (const hit of own) {
        if (hit.skip || NEVER_SKIPPED.has(hit.kind)) continue
        const place = referenceOf(references, hit.token)
        if (place) Object.assign(hit, { skip: 'reference-line', ref: place })
      }
      for (const hit of own) (hit.skip ? skips : hits).push(hit)
    }
    if (hits.length) found.push({ file: path, hits })
    if (skips.length) skipped.push({ file: path, hits: skips })
  }
  return { found, skipped }
}

/** Where a reference file has the value as a whole token (not inside a longer class), `file:line`; null — nowhere. */
function referenceOf(references, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`)
  for (const { file, text } of references) {
    const at = text.split('\n').findIndex((row) => found.test(row))
    if (at !== -1) return `${file}:${at + 1}`
  }
  return null
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
    skippedHeading: (n) => `## Пропущено по шаблонам ложных срабатываний (${n})`,
    skippedIntro: 'Это не новые переопределения; шаблоны — `references/kit-overrides-false-positives.md` в stage-check. Строки здесь, а не в таблице, чтобы пропуск был виден.',
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
    skippedHeading: (n) => `## Skipped by false-positive patterns (${n})`,
    skippedIntro: 'These are not new overrides; the patterns are in `references/kit-overrides-false-positives.md` of stage-check. They are listed here, not in the table, so that a skip stays visible.',
    unverified: '## Could not verify',
    runtime:
      '- styles assembled at runtime (`cn(cond && …)`, values from variables) are seen by the script only as literals — devtools-verify checks the computed look against the reference section.',
  },
}

export function renderReport(found, { title, previous = '', language = 'ru', skipped = [] } = {}) {
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
  const skippedHits = skipped.flatMap(({ file, hits }) => hits.map((hit) => `- \`${file}:${hit.line}\` ${hit.kind} (\`${hit.token.replace(/\|/g, '\\|')}\`) — ${hit.skip}${hit.ref ? ` (${hit.ref})` : ''}`))
  if (skippedHits.length) lines.push('', text.skippedHeading(skippedHits.length), text.skippedIntro, ...skippedHits)
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
  const out = option('--out')
  const explicit = args.flatMap((arg, index) => (arg === '--reference' && args[index + 1] ? [args[index + 1]] : []))
  const reference = [...new Set(explicit)].filter((name) => !name.startsWith('/') && !name.split('/').includes('..'))
  const { found, skipped } = scanOverridesDetailed(root, { against, reference })
  if (out) {
    const path = resolve(out)
    const language = taskLanguageFor(path, root)
    const title = base ? (language === 'en' ? `branch off ${base}` : `ветка от ${base}`) : undefined
    writeFileSync(path, renderReport(found, { title, previous: existsSync(path) ? readFileSync(path, 'utf8') : '', language, skipped }))
    console.log(`kit-override-scan: ${found.length} file(s) with overrides → ${path}`)
    process.exit(0)
  }
  for (const { file, hits } of found) console.log(`- ${file}: ${summarize(hits)}`)
  for (const { file, hits } of skipped) console.log(`- skipped ${file}: ${hits.map((hit) => `${hit.kind} \`${hit.token}\` (${hit.skip}${hit.ref ? ` ${hit.ref}` : ''})`).join(', ')}`)
  if (!found.length) console.log('No kit overrides in the added lines.')
  process.exit(found.length ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
