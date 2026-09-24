#!/usr/bin/env node
/**
 * Нижняя планка качества по дифу — ловит ходы, которыми агент добирается до зелёного, не починив:
 * заглушённый чекер, ослабленный тест, незаконченная работа, ослабленный конфиг, секрет в коде.
 *
 *   node floor-guard.mjs                        # диф этапа: рабочее дерево + неотслеживаемые против HEAD
 *   node floor-guard.mjs --base origin/dev      # вся ветка: от merge-base с базой до рабочего дерева
 *   node floor-guard.mjs --json                 # то же машинно
 *   node floor-guard.mjs --pathspec-from-stdin  # только эти пути (pathspec'и git от корня, через NUL; пусто — нечего проверять)
 *
 * Без `--pathspec-from-stdin` смотрятся и все неотслеживаемые файлы: нарушения в них помечены `untracked`,
 * потому что в дереве разработчика рядом с кодом лежит и то, что никогда не будет закоммичено.
 * Код выхода: 0 — чисто, 1 — есть нарушения, 2 — проверить не удалось (не git-репо, нет базы).
 * 2 никогда не читается как 0: «не смог посмотреть» ≠ «посмотрел, чисто».
 *
 * Обоснованное исключение — маркер `floor-ok: <причина>` на той же или предыдущей строке, а также
 * идиоматичное обоснование самого подавления (`eslint-disable-line x -- причина`, `@ts-expect-error причина`).
 * Такие строки не нарушения, но печатаются отдельным списком: их видит ревью и пользователь.
 * Файл, где дефекты заложены намеренно (фикстуры тестов, сам guard), — `floor-ok-file: <причина>` в первых
 * 10 строках: все его находки уходят в исключения с этой причиной, а не пропадают. Маркер действует в тестах
 * и фикстурах или если стоял в файле до дифа: новый маркер в продовом файле глушил бы всё, что рядом добавлено.
 * Значение найденного секрета не печатается никогда — только правило и место; плейсхолдеры (`…EXAMPLE`,
 * `xxxx`, `0000`) секретом не считаются.
 * Правила подстраиваются под репо: `# noqa` и `# type: ignore` — подавление, только если в репо есть
 * Python-линтер / тайпчекер, которому они адресованы.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'

const args = process.argv.slice(2)
const json = args.includes('--json')
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : null
// Упавший скрипт — не «нашёл нарушения»: код 1 хук читает как отказ в коммите, поэтому любая ошибка — код 2.
process.on('uncaughtException', (error) => bail(`внутренняя ошибка: ${error.code ?? error.message}`))
if (args.includes('--base') && (!baseArg || baseArg.startsWith('--'))) bail('--base ждёт ветку или коммит')
// Охват от хука — то, что войдёт в коммит; `null` — всё дерево вместе с неотслеживаемыми.
const pathspecs = args.includes('--pathspec-from-stdin') ? readFileSync(0, 'utf8').split('\0').filter(Boolean) : null

const git = (...cmd) => execFileSync('git', ['-c', 'core.quotePath=false', ...cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 })
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
const SKIP_PATH = /(^|\/)(node_modules|dist|build|\.next|\.nuxt|\.output|coverage|vendor|__generated__)\/|(\.lock|-lock\.json|\.lock\.yaml|\.min\.js|\.map|\.snap)$|\.(generated|gen)\.\w+$/
// Тест — по имени файла. Сегмент `test/` в пути тестом не считается: в живых репо это бывает доменный
// модуль («тесты/экзамены»), и его удаление читалось бы как «удалён тест».
const TEST_FILE = /\.(test|spec|cy|e2e)\.\w+$|(^|\/)__tests__\/|_test\.\w+$|(^|\/)test_\w+\.py$|^tests?\/|(^|\/)\w+Tests?\.(swift|kt|java)$/
// Моки и фикстуры: приведения типов и проглоченный промис там — идиома, а не обход.
const TESTISH = new RegExp(`${TEST_FILE.source}|(^|\\/)(__mocks__|__fixtures__|fixtures?|testdata|mocks?)\\/`)

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
const SUPPRESSION = new RegExp(`${COMMENT}(?:@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable|biome-ignore|oxlint-disable|stylelint-disable|(?:istanbul|c8|v8) ignore|nosemgrep|NOLINT)`)
const PY_SUPPRESSION = /#\s*noqa\b/
const PY_TYPE_SUPPRESSION = /#\s*type:\s*ignore\b/
const HARD_SUPPRESSION = new RegExp(`${COMMENT}@ts-(?:ignore|nocheck)`)
const TYPE_ESCAPE = /\bas\s+any\b|\bas\s+unknown\s+as\b/
const SKIPPED_TEST = /\b(it|test|describe|context|suite)\.(skip|only|todo)\s*\(|@pytest\.mark\.skip|\bt\.Skip\(/
// `xit(`/`fit(` — только в тестах и не как метод: `model.fit(X, y)` и `fitAddon.fit()` — не фокус теста.
const SKIPPED_TEST_BARE = /(?<![.\w$])(xit|xdescribe|xtest|fit|fdescribe)\s*\(/
// Пустой catch — проглоченная ошибка. `.catch(() => null)` — идиома «данные необязательны», не заглушка.
const EMPTY_CATCH = /\bcatch\s*(\(\s*\w*\s*\))?\s*\{\s*\}|\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*\{\s*\}\s*\)/
const STUB = [/throw\s+new\s+\w*Error\([^)]*not\s+implemented/i, new RegExp(`(?:${COMMENT}|#\\s*)(?:TODO|FIXME|XXX)\\b`)]
const ASSERTION = /\b(expect|assert\w*|should)\b\s*[.(]/
// Плейсхолдеры из документации и `.env.example`: AWS-овский `AKIAIOSFODNN7EXAMPLE`, `sk-proj-XXXX…`, `ctx7sk-0000…`.
const PLACEHOLDER = /EXAMPLE|X{6,}|x{6,}|0{8,}|\*{4,}|your[_-]?(api[_-]?)?key|placeholder|dummy|fake|redacted/i
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
// Порог покрытия — только ключом в конфиге тест-раннера (или его секции в package.json), baseline — только
// в конфиге пайплайна. Иначе версии зависимостей (`"baseline-browser-mapping": "^2.8.1"`) читаются как пороги,
// а в JSON `floor-ok` поставить некуда.
const THRESHOLD_FILE = /(^|\/)((vitest|jest|vite)\.config\.\w+|package\.json|\.nycrc(\.json)?|\.c8rc(\.json)?)$/
const THRESHOLD = /["']?\b(lines|branches|functions|statements)\b["']?\s*:\s*(\d+(?:\.\d+)?)/
const BASELINE_FILE = /(^|\/)pipeline\.config(\.local)?\.md$/
const BASELINE = /\b(baseline)\b[^\n]*?(\d+(?:\.\d+)?)/

// floor-ok — для любого правила; идиомы обоснованного подавления — только для самого подавления.
const FLOOR_OK = /floor-ok:\s*\S.{8,}/
const JUSTIFIED_SUPPRESSION = [
  /eslint-disable(-next-line|-line)?\s+[\w@/-]+(\s*,\s*[\w@/-]+)*\s+--\s*\S.{4,}/,
  /@ts-expect-error:?\s+\S.{4,}/,
  /biome-ignore\s+\S+:\s*\S.{4,}/,
  // `# noqa: BLE001 — причина`, `# noqa: E501  # причина`, `# type: ignore[attr-defined]  # причина`
  /#\s*noqa:\s*[A-Z]+\d+(\s*,\s*[A-Z]+\d+)*\s*(?:[—–-]{1,2}|#|:)\s*\S.{4,}/,
  /#\s*type:\s*ignore(\[[\w,\s-]+\])?\s*#\s*\S.{4,}/,
]

// ── диф ──────────────────────────────────────────────────────────────────────
const files = new Map()
const fileEntry = (path) => {
  if (!files.has(path)) files.set(path, { added: [], removed: [] })
  return files.get(path)
}

// Префиксы и переименования — явно: `diff.mnemonicPrefix`/`diff.noprefix`/`diff.renames` из конфига разработчика
// меняют заголовки, и путь перестаёт совпадать с файлом.
const DIFF = ['--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/']
// Пустой охват — ни одного файла, а не «без ограничения»: `git diff --` без путей смотрит всё.
const scoped = (...cmd) => (pathspecs?.length === 0 ? '' : git(...cmd, '--', ...(pathspecs ?? [])))
parseUnified(scoped('diff', '--unified=0', ...DIFF, base))

// Обычный файл, а не каталог (вложенный репо, указатель субмодуля), не симлинк и не бинарь.
const regularFile = (path) => {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && stat.size <= 2 * 1024 * 1024
  } catch {
    return false
  }
}

const untracked = new Set(scoped('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))
for (const path of untracked) {
  if (SKIP_PATH.test(path) || !regularFile(path)) continue
  const text = readFileSync(path, 'utf8')
  if (text.includes('\0')) continue
  const entry = fileEntry(path)
  text.split('\n').forEach((line, i) => entry.added.push({ line: i + 1, text: line }))
}

const deleted = scoped('diff', '--name-only', '--diff-filter=D', '-z', ...DIFF, base).split('\0').filter(Boolean)
const repoHas = (...paths) => paths.some((path) => existsSync(path))
const repoFileHas = (path, pattern) => regularFile(path) && pattern.test(readFileSync(path, 'utf8'))
const pythonLinted =
  repoHas('ruff.toml', '.ruff.toml', '.flake8', '.pylintrc', 'tox.ini') ||
  repoFileHas('pyproject.toml', /\[tool\.(ruff|flake8|pylint)/) ||
  repoFileHas('setup.cfg', /\[flake8\]/)
const pythonTyped =
  repoHas('mypy.ini', '.mypy.ini', 'pyrightconfig.json') || repoFileHas('pyproject.toml', /\[tool\.(mypy|pyright)/) || repoFileHas('setup.cfg', /\[mypy\]/)

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
      const path = diffPath(raw.slice(4))
      entry = path === null ? null : fileEntry(path)
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

// `+++ b/my file.ts\t` — git дописывает таб к пути с пробелом; спецсимволы — C-кавычками даже при quotePath=false.
function diffPath(raw) {
  let path = raw.replace(/\t$/, '')
  if (path === '/dev/null') return null
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1).replace(/\\([\\"tn])/g, (_, c) => ({ t: '\t', n: '\n' })[c] ?? c)
  }
  return path.replace(/^b\//, '')
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
const fileMarker = (text) => text?.split('\n', 10).join('\n').match(FILE_OK)?.[1].replace(/\s*\*\/\s*$/, '').trim().slice(0, 120) ?? null
const fileJustification = (path) => {
  if (!regularFile(path)) return null
  const why = fileMarker(readFileSync(path, 'utf8'))
  if (!why) return null
  // Новый маркер в продовом файле — не исключение, а способ заглушить весь файл одной строкой.
  return TESTISH.test(path) || fileMarker(tryGit('show', `${base}:${path}`)) ? why : null
}

const record = (rule, path, line, text, lines, index, { redact = false, justifiable = true } = {}) => {
  const shown = redact ? '(значение скрыто)' : text.trim().slice(0, 120)
  // Секрет не обосновывается ничем — ни строкой, ни файлом.
  const why = rule === 'secret' ? null : currentFileOk ?? (justifiable && lines ? justification(lines, index, rule) : null)
  ;(why ? accepted : violations).push({ rule, file: path, line, text: shown, ...(why ? { justification: why } : {}), ...notInGit(path) })
}

// Неотслеживаемый файл мог не создаваться этапом — решает тот, кто знает список файлов этапа.
const notInGit = (path) => (untracked.has(path) ? { untracked: true } : {})
let currentFileOk = null
const push = (rule, file, line, text) =>
  (currentFileOk ? accepted : violations).push({ rule, file, line, text, ...(currentFileOk ? { justification: currentFileOk } : {}), ...notInGit(file) })
for (const [path, { added, removed }] of files) {
  if (SKIP_PATH.test(path)) continue
  currentFileOk = fileJustification(path)
  addedTotal += added.length
  removedTotal += removed.length
  const isCode = CODE.test(path)
  const isConfig = CONFIG.test(path)
  const isTest = TEST_FILE.test(path)
  const isTestish = TESTISH.test(path)
  const isPython = path.endsWith('.py')

  added.forEach(({ line, text }, i) => {
    if (SECRET.some((pattern) => pattern.exec(text) && !PLACEHOLDER.test(text.match(pattern)[0]))) {
      record('secret', path, line, text, added, i, { redact: true, justifiable: false })
    }
    if (!isCode && !isConfig) return
    if (HARD_SUPPRESSION.test(text)) record('silenced-checker', path, line, text, added, i, { justifiable: false })
    else if (SUPPRESSION.test(text)) record('silenced-checker', path, line, text, added, i)
    else if (isPython && ((pythonLinted && PY_SUPPRESSION.test(text)) || (pythonTyped && PY_TYPE_SUPPRESSION.test(text)))) {
      record('silenced-checker', path, line, text, added, i)
    }
    if (isCode && !isTestish && TYPE_ESCAPE.test(text)) record('type-escape', path, line, text, added, i)
    if (isCode && (SKIPPED_TEST.test(text) || (isTest && SKIPPED_TEST_BARE.test(text)))) record('test-made-easier', path, line, text, added, i)
    if (isCode && (STUB.some((pattern) => pattern.test(text)) || (!isTestish && EMPTY_CATCH.test(text)))) {
      record('unfinished-work', path, line, text, added, i)
    }
    if (LOOSENED.some((rule) => rule.file.test(path) && rule.pattern.test(text))) record('loosened-config', path, line, text, added, i)
  })

  // Порог опущен (покрытие) или baseline поднят (type_check): число в той же строке-ключе поменялось в сторону слабее.
  const thresholds = THRESHOLD_FILE.test(path) ? THRESHOLD : BASELINE_FILE.test(path) ? BASELINE : null
  if (thresholds) {
    for (const before of removed) {
      const key = before.text.match(thresholds)
      if (!key) continue
      const after = added.find(({ text }) => text.match(thresholds)?.[1] === key[1])
      if (!after) continue
      const was = Number(key[2])
      const now = Number(after.text.match(thresholds)[2])
      const weaker = key[1] === 'baseline' ? now > was : now < was
      if (weaker) push('loosened-config', path, after.line, `${key[1]}: ${was} → ${now}`)
    }
  }
}

// Удалённый тест — нарушение, если его не объясняет сам диф: удалён и код, который он проверял
// (выпил компонента вместе с тестом), или тест с тем же именем появился в другом месте (перенос без `git add`).
const stem = (path) => basename(path).replace(/\.(test|spec|cy|e2e)(?=\.)/, '').replace(/^test_|_test(?=\.)/, '').replace(/\.\w+$/, '')
const deletedSources = new Set(deleted.filter((path) => !TEST_FILE.test(path)).map(stem))
const addedTests = new Set([...files.keys()].filter((path) => TEST_FILE.test(path) && !deleted.includes(path)).map((path) => basename(path)))
const deletedTests = deleted.filter((path) => TEST_FILE.test(path) && CODE.test(path) && !SKIP_PATH.test(path))
for (const path of deletedTests) {
  if (deletedSources.has(stem(path)) || addedTests.has(basename(path))) continue
  violations.push({ rule: 'test-made-easier', file: path, line: 0, text: 'тестовый файл удалён' })
}

// Ассерт убран — по сумме всех оставшихся тестов дифа: тест, разнесённый по двум файлам, ассертов не теряет,
// а удалённые файлы считает правило выше.
const assertionFiles = [...files].filter(([path]) => TEST_FILE.test(path) && CODE.test(path) && !SKIP_PATH.test(path) && !deleted.includes(path))
const count = (lines) => lines.filter(({ text }) => ASSERTION.test(text)).length
const lostAssertions = assertionFiles.reduce((sum, [, { added, removed }]) => sum + count(removed) - count(added), 0)
if (lostAssertions > 0) {
  const [path, { removed }] = assertionFiles.reduce((worst, candidate) =>
    count(candidate[1].removed) - count(candidate[1].added) > count(worst[1].removed) - count(worst[1].added) ? candidate : worst,
  )
  currentFileOk = fileJustification(path)
  push('test-made-easier', path, removed.find(({ text }) => ASSERTION.test(text))?.line ?? 0, `ассертов стало меньше на ${lostAssertions}`)
}

// ── вывод ────────────────────────────────────────────────────────────────────
const baseLabel = `${baseArg ? `${baseArg} (merge-base ${base.slice(0, 8)})` : 'HEAD'}${pathspecs ? ` · только пути коммита (${pathspecs.length})` : ''}`
const size = { files: [...files.keys()].filter((path) => !SKIP_PATH.test(path)).length, added: addedTotal, removed: removedTotal }

if (json) {
  process.stdout.write(JSON.stringify({ base: baseLabel, size, violations, accepted }, null, 2) + '\n')
} else {
  console.log(`floor-guard: база ${baseLabel} · диф +${size.added} −${size.removed} строк в ${size.files} файлах (без lock/сборки)`)
  if (!violations.length) console.log('✔ нарушений нет')
  else {
    console.log(`✘ нарушений: ${violations.length}`)
    for (const v of violations) console.log(`  - [${v.rule}] ${v.file}${v.line ? `:${v.line}` : ''}${v.untracked ? ' (не в git)' : ''} — ${RULES[v.rule]}: ${v.text}`)
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
