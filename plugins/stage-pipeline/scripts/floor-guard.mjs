#!/usr/bin/env node
/**
 * Нижняя планка качества по дифу — ловит ходы, которыми агент добирается до зелёного, не починив:
 * заглушённый чекер, ослабленный тест, незаконченная работа, ослабленный конфиг, секрет в коде.
 *
 *   node floor-guard.mjs                        # диф этапа: рабочее дерево + неотслеживаемые против HEAD
 *   node floor-guard.mjs --base origin/dev      # вся ветка: от merge-base с базой до рабочего дерева
 *   node floor-guard.mjs --json                 # то же машинно
 *
 * Код выхода: 0 — чисто, 1 — есть нарушения, 2 — проверить не удалось (не git-репо, нет базы).
 * 2 никогда не читается как 0: «не смог посмотреть» ≠ «посмотрел, чисто».
 *
 * Обоснованное исключение — маркер `floor-ok: <причина>` на той же или предыдущей строке, а также
 * идиоматичное обоснование самого подавления (`eslint-disable-line x -- причина`, `@ts-expect-error причина`).
 * Такие строки не нарушения, но печатаются отдельным списком: их видит ревью и пользователь.
 * Файл, где дефекты заложены намеренно (фикстуры тестов, сам guard), — `floor-ok-file: <причина>` в первых
 * 10 строках: все его находки уходят в исключения с этой причиной, а не пропадают.
 * Значение найденного секрета не печатается никогда — только правило и место.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'

const args = process.argv.slice(2)
const json = args.includes('--json')
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : null

const git = (...cmd) => execFileSync('git', ['-c', 'core.quotePath=false', ...cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
const tryGit = (...cmd) => {
  try {
    return git(...cmd)
  } catch {
    return null
  }
}

const root = tryGit('rev-parse', '--show-toplevel')?.trim()
if (!root) bail('не git-репозиторий')
process.chdir(root)

let base = 'HEAD'
if (baseArg) {
  base = tryGit('merge-base', baseArg, 'HEAD')?.trim()
  if (!base) bail(`нет merge-base с ${baseArg} — нужен git fetch или другая база`)
} else if (!tryGit('rev-parse', '--verify', '-q', 'HEAD')) {
  bail('в репо нет ни одного коммита')
}

// Код и конфиги. Markdown не смотрим: документация законно цитирует `@ts-ignore` и `.skip`.
const CODE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|astro|py|go|rb|kt|swift|java|php|rs|cs)$/
const CONFIG = /(^|\/)(\.?eslintrc(\.\w+)?|eslint\.config\.\w+|biome\.jsonc?|tsconfig[\w.-]*\.json|(vitest|jest|vite|playwright)\.config\.\w+|package\.json|pipeline\.config\.md)$/
const SKIP_PATH = /(^|\/)(node_modules|dist|build|\.next|\.nuxt|\.output|coverage|vendor)\/|(\.lock|-lock\.json|\.lock\.yaml|\.min\.js|\.map|\.snap)$/
const TEST_FILE = /(\.(test|spec)\.[\w]+$|(^|\/)(__tests__|tests?)\/|_test\.\w+$|(^|\/)test_[\w]+\.py$)/

const RULES = {
  'silenced-checker': 'заглушён чекер',
  'type-escape': 'типы обойдены приведением',
  'test-made-easier': 'тест ослаблен',
  'unfinished-work': 'незаконченная работа',
  'loosened-config': 'ослаблен конфиг проверок',
  'secret': 'похоже на секрет',
}

// Директива работает, только когда стоит первым словом комментария (у noqa и type: ignore комментарий `#` — в конце
// строки кода, поэтому он ищется где угодно). Упоминание директивы в прозе, в строке или в регэкспе — не директива.
const COMMENT = String.raw`(?:\/\/|\/\*+|<!--|\{\/\*|^\s*\*)\s*`
const SUPPRESSION = new RegExp(`${COMMENT}(?:@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable|biome-ignore|oxlint-disable|stylelint-disable|(?:istanbul|c8|v8) ignore|nosemgrep|NOLINT)|#\\s*(?:noqa|type:\\s*ignore)\\b`)
const HARD_SUPPRESSION = new RegExp(`${COMMENT}@ts-(?:ignore|nocheck)`)
const TYPE_ESCAPE = /\bas\s+any\b|\bas\s+unknown\s+as\b/
const SKIPPED_TEST = /\b(it|test|describe|context|suite)\.(skip|only|todo)\s*\(|\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(|@pytest\.mark\.skip|\bt\.Skip\(/
const STUB = [
  /throw\s+new\s+\w*Error\([^)]*not\s+implemented/i,
  /\bcatch\s*(\(\s*\w*\s*\))?\s*\{\s*\}|\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|undefined|null)\s*\)/,
  new RegExp(`(?:${COMMENT}|#\\s*)(?:TODO|FIXME|XXX)\\b`),
]
const ASSERTION = /\b(expect|assert\w*|should)\b\s*[.(]/
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{24,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bctx7sk-[A-Za-z0-9-]{16,}\b/,
]
// Ослабление конфига — только по добавленным строкам и только в конфиге своего инструмента:
// `retry: 0` в vitest.config — не выключенное правило, а `"off"` в package.json не встречается.
const ESLINT_CONFIG = /(^|\/)(\.?eslintrc(\.\w+)?|eslint\.config\.\w+|biome\.jsonc?)$/
const LOOSENED = [
  { file: /(^|\/)tsconfig[\w.-]*\.json$/, pattern: /["']?(strict|noImplicitAny|strictNullChecks|noUncheckedIndexedAccess|noImplicitReturns|noUnusedLocals|noUnusedParameters)["']?\s*:\s*false/ },
  { file: ESLINT_CONFIG, pattern: /:\s*\[?\s*["']off["']|:\s*\[?\s*0\s*[\],}]|["']?level["']?\s*:\s*["']off["']/ },
  { file: /(^|\/)package\.json$/, pattern: /--passWithNoTests|--no-verify/ },
]
const THRESHOLD = /\b(lines|branches|functions|statements|threshold|baseline)\b[^\n]*?(\d+(\.\d+)?)/

// floor-ok — для любого правила; идиомы обоснованного подавления — только для самого подавления.
const FLOOR_OK = /floor-ok:\s*\S.{8,}/
const JUSTIFIED_SUPPRESSION = [
  /eslint-disable(-next-line|-line)?\s+[\w@/-]+(\s*,\s*[\w@/-]+)*\s+--\s*\S.{4,}/,
  /@ts-expect-error:?\s+\S.{4,}/,
  /biome-ignore\s+\S+:\s*\S.{4,}/,
]

// ── диф ──────────────────────────────────────────────────────────────────────
const files = new Map()
const fileEntry = (path) => {
  if (!files.has(path)) files.set(path, { added: [], removed: [] })
  return files.get(path)
}

parseUnified(git('diff', '--unified=0', '--no-color', '--no-ext-diff', base, '--'))

const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)
for (const path of untracked) {
  if (SKIP_PATH.test(path) || !existsSync(path) || statSync(path).size > 2 * 1024 * 1024) continue
  const text = readFileSync(path, 'utf8')
  if (text.includes('\0')) continue
  const entry = fileEntry(path)
  text.split('\n').forEach((line, i) => entry.added.push({ line: i + 1, text: line }))
}

const deleted = git('diff', '--name-only', '--diff-filter=D', '-z', base, '--').split('\0').filter(Boolean)

function parseUnified(diff) {
  let entry = null
  let header = false
  let oldLine = 0
  let newLine = 0
  for (const raw of diff.split('\n')) {
    // Заголовок файла — от `diff --git` до первого `@@`: строка контента `-- x` внутри ханка — не заголовок.
    if (raw.startsWith('diff --git ')) {
      entry = null
      header = true
    } else if (header && raw.startsWith('+++ ')) {
      const path = raw.slice(4).replace(/^b\//, '')
      entry = path === '/dev/null' ? null : fileEntry(path)
    } else if (header && !raw.startsWith('@@')) continue
    else if (raw.startsWith('@@')) {
      header = false
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/)
      oldLine = Number(m?.[1] ?? 0)
      newLine = Number(m?.[2] ?? 0)
    } else if (entry && raw.startsWith('+')) entry.added.push({ line: newLine++, text: raw.slice(1) })
    else if (entry && raw.startsWith('-')) entry.removed.push({ line: oldLine++, text: raw.slice(1) })
  }
}

// ── правила ──────────────────────────────────────────────────────────────────
const violations = []
const accepted = []
let addedTotal = 0
let removedTotal = 0

const justification = (lines, index, rule) => {
  const here = lines[index]?.text ?? ''
  const above = lines[index - 1]?.line === lines[index].line - 1 ? lines[index - 1].text : ''
  const patterns = rule === 'silenced-checker' ? [FLOOR_OK, ...JUSTIFIED_SUPPRESSION] : [FLOOR_OK]
  for (const text of [here, above]) {
    for (const pattern of patterns) {
      const m = text.match(pattern)
      if (m) return m[0].trim().slice(0, 120)
    }
  }
  return null
}

const FILE_OK = /floor-ok-file:\s*(\S.{8,})/
const fileJustification = (path) => {
  if (!existsSync(path)) return null
  const head = readFileSync(path, 'utf8').split('\n', 10).join('\n')
  return head.match(FILE_OK)?.[1].replace(/\s*\*\/\s*$/, '').trim().slice(0, 120) ?? null
}

const record = (rule, path, line, text, lines, index, { redact = false, justifiable = true } = {}) => {
  const shown = redact ? '(значение скрыто)' : text.trim().slice(0, 120)
  // Секрет не обосновывается ничем — ни строкой, ни файлом.
  const why = rule === 'secret' ? null : currentFileOk ?? (justifiable && lines ? justification(lines, index, rule) : null)
  ;(why ? accepted : violations).push({ rule, file: path, line, text: shown, ...(why ? { justification: why } : {}) })
}

let currentFileOk = null
const push = (rule, file, line, text) =>
  (currentFileOk ? accepted : violations).push({ rule, file, line, text, ...(currentFileOk ? { justification: currentFileOk } : {}) })
for (const [path, { added, removed }] of files) {
  if (SKIP_PATH.test(path)) continue
  currentFileOk = fileJustification(path)
  addedTotal += added.length
  removedTotal += removed.length
  const isCode = CODE.test(path)
  const isConfig = CONFIG.test(path)
  const isTest = TEST_FILE.test(path)

  added.forEach(({ line, text }, i) => {
    if (SECRET.some((pattern) => pattern.test(text))) record('secret', path, line, text, added, i, { redact: true, justifiable: false })
    if (!isCode && !isConfig) return
    if (HARD_SUPPRESSION.test(text)) record('silenced-checker', path, line, text, added, i, { justifiable: false })
    else if (SUPPRESSION.test(text)) record('silenced-checker', path, line, text, added, i)
    if (isCode && TYPE_ESCAPE.test(text)) record('type-escape', path, line, text, added, i)
    if (isCode && SKIPPED_TEST.test(text)) record('test-made-easier', path, line, text, added, i)
    if (isCode && STUB.some((pattern) => pattern.test(text))) record('unfinished-work', path, line, text, added, i)
    if (LOOSENED.some((rule) => rule.file.test(path) && rule.pattern.test(text))) record('loosened-config', path, line, text, added, i)
  })

  // Ассерт убран из теста, который остался: считаем по файлу, чтобы переписанный ассерт не шумел.
  if (isTest && isCode) {
    const lost = removed.filter(({ text }) => ASSERTION.test(text)).length - added.filter(({ text }) => ASSERTION.test(text)).length
    if (lost > 0) {
      const first = removed.find(({ text }) => ASSERTION.test(text))
      push('test-made-easier', path, first.line, `ассертов стало меньше на ${lost}`)
    }
  }

  // Порог опущен (покрытие) или baseline поднят (type_check): число в той же строке-ключе поменялось в сторону слабее.
  if (isConfig) {
    for (const before of removed) {
      const key = before.text.match(THRESHOLD)
      if (!key) continue
      const after = added.find(({ text }) => text.match(THRESHOLD)?.[1] === key[1])
      if (!after) continue
      const was = Number(key[2])
      const now = Number(after.text.match(THRESHOLD)[2])
      const weaker = key[1] === 'baseline' ? now > was : now < was
      if (weaker) push('loosened-config', path, after.line, `${key[1]}: ${was} → ${now}`)
    }
  }
}

for (const path of deleted) {
  if (TEST_FILE.test(path) && CODE.test(path) && !SKIP_PATH.test(path)) {
    violations.push({ rule: 'test-made-easier', file: path, line: 0, text: 'тестовый файл удалён' })
  }
}

// ── вывод ────────────────────────────────────────────────────────────────────
const baseLabel = baseArg ? `${baseArg} (merge-base ${base.slice(0, 8)})` : 'HEAD'
const size = { files: [...files.keys()].filter((path) => !SKIP_PATH.test(path)).length, added: addedTotal, removed: removedTotal }

if (json) {
  process.stdout.write(JSON.stringify({ base: baseLabel, size, violations, accepted }, null, 2) + '\n')
} else {
  console.log(`floor-guard: база ${baseLabel} · диф +${size.added} −${size.removed} строк в ${size.files} файлах (без lock/сборки)`)
  if (!violations.length) console.log('✔ нарушений нет')
  else {
    console.log(`✘ нарушений: ${violations.length}`)
    for (const v of violations) console.log(`  - [${v.rule}] ${v.file}${v.line ? `:${v.line}` : ''} — ${RULES[v.rule]}: ${v.text}`)
  }
  if (accepted.length) {
    console.log(`обоснованные исключения: ${accepted.length} (в журнал этапа и «⚠ Ожидают подтверждения»)`)
    for (const a of accepted) console.log(`  - [${a.rule}] ${a.file}:${a.line} — ${a.justification}`)
  }
}
process.exit(violations.length ? 1 : 0)

function bail(message) {
  if (json) process.stdout.write(JSON.stringify({ error: message }) + '\n')
  else console.error(`floor-guard: проверить не удалось — ${message}`)
  process.exit(2)
}
