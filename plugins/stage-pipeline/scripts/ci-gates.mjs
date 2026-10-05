#!/usr/bin/env node
/**
 * Гейты CI проекта — команды, которые CI гоняет на PR и которые «ронять нельзя»: смоук, e2e, вес бандла,
 * полнота локалей. Финальные проверки пайплайна знали только lint / type_check / test / build, и в одной
 * задаче смоук упал уже на PR: регрессию внёс раунд a11y-фиксов, который трогал визард вне экрана этапа,
 * а свежий devtools-verify смотрел только экран этапа.
 *
 * Откуда список: таблица «## Гейты CI» в pipeline.config.md (первая ячейка — название, команда — в бэктиках),
 * без таблицы — строки `- e2e:` и `- smoke:` в Commands. Команды из файлов CI сам скрипт не берёт:
 * там деплои и секреты, предложить таблицу — работа /pipeline-doctor.
 *
 * Результат прогона пишет run-check.mjs — по дереву коммита (`HEAD^{tree}`), только когда отслеживаемые
 * файлы не менялись ни до, ни во время прогона. Зелёный гейт — код 0 на дереве текущего HEAD: прогон до
 * последнего фикса закрытие не засчитывает.
 *
 *   node ci-gates.mjs          # гейты репо и их состояние на HEAD
 *   node ci-gates.mjs --run    # прогнать незелёные через run-check.mjs и показать итог
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { baselineInfo, fingerprint, lastForceBlock, openBlockers } from './journal-check.mjs'
import { pluginDataDir, readPipelineState } from './hooks/pipeline-state.mjs'

const RUN_CHECK = join(dirname(fileURLToPath(import.meta.url)), 'run-check.mjs')

export const normalize = (command) => command.replace(/\s+/g, ' ').trim()

/** Гейты из конфига: `[{ name, command }]`. Пусто — у проекта гейтов нет, правило молчит. */
export function gateCommands(config) {
  const table = gateTable(config)
  if (table.length) return table
  const gates = []
  for (const [, key, raw] of config.matchAll(/^\s*-\s*\**(e2e|smoke)\**(?:\s*\([^)\n]*\))?\s*:\s*(.+)$/gim)) {
    const command = raw.match(/`([^`]+)`/)?.[1] ?? raw.split(/\s+#|\s+\/\s+|\s+\(|\s+\|/)[0]
    if (!command || /^(?:нет|—|-|none|no)(?![а-яёa-z])/i.test(command.trim())) continue
    gates.push({ name: key.toLowerCase(), command: normalize(command) })
  }
  return dedupe(gates)
}

function gateTable(config) {
  const heading = config.match(/^(#{2,4})\s*(?:Гейты\s+CI|CI\s+gates)\b.*$/im)
  if (!heading) return []
  const rest = config.slice(heading.index + heading[0].length).split('\n')
  const end = rest.findIndex((line) => new RegExp(`^#{1,${heading[1].length}}\\s`).test(line))
  const gates = []
  for (const line of end === -1 ? rest : rest.slice(0, end)) {
    if (!/^\s*\|/.test(line) || /^\s*\|[\s:|-]+\|\s*$/.test(line)) continue
    const command = line.match(/`([^`]+)`/)?.[1]
    if (!command) continue
    const name = line.split('|')[1].replace(/[*`]/g, '').trim() || command
    gates.push({ name, command: normalize(command) })
  }
  return dedupe(gates)
}

const dedupe = (gates) => gates.filter((gate, index) => gates.findIndex((other) => other.command === gate.command) === index)

/** Дерево HEAD и чистота отслеживаемых файлов: неотслеживаемые (каталог задач, кадры) прогону не мешают. */
export function treeState(cwd) {
  try {
    const run = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return { tree: run('rev-parse', 'HEAD^{tree}'), clean: run('status', '--porcelain', '--untracked-files=no') === '' }
  } catch {
    return { tree: null, clean: false }
  }
}

function recordsPath(dataDir, worktree) {
  let real = worktree
  try {
    real = realpathSync(worktree)
  } catch {
    // каталог пропал — ключ по исходному пути
  }
  return join(dataDir, 'gates', `${createHash('sha1').update(real).digest('hex').slice(0, 16)}.json`)
}

export function gateRecords(dataDir, worktree) {
  try {
    return JSON.parse(readFileSync(recordsPath(dataDir, worktree), 'utf8'))
  } catch {
    return {}
  }
}

export function recordGate(dataDir, worktree, command, code, tree) {
  const path = recordsPath(dataDir, worktree)
  const records = gateRecords(dataDir, worktree)
  records[normalize(command)] = { code, tree, at: new Date().toISOString() }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(records, null, 2))
  } catch {
    // не записалось — гейт просто придётся прогнать ещё раз
  }
}

/**
 * Состояние каждого гейта на текущем HEAD: green | red | stale (прогон был на другом дереве) | missing.
 * Засчитывается и прогон с хвостом флагов: `… playwright test --grep-invert "снимок"` закрывает `… playwright test`.
 */
export function gateStatus(dataDir, worktree, config) {
  const gates = gateCommands(config)
  if (!gates.length) return []
  const { tree } = treeState(worktree)
  const records = Object.entries(gateRecords(dataDir, worktree))
  return gates.map((gate) => {
    const runs = records.filter(([command]) => command === gate.command || command.startsWith(`${gate.command} `)).map(([, record]) => record)
    const here = runs.filter((record) => tree && record.tree === tree).sort((a, b) => (a.at < b.at ? 1 : -1))
    const status = here.length ? (here[0].code === 0 ? 'green' : 'red') : runs.length ? 'stale' : 'missing'
    return { ...gate, status, code: here[0]?.code ?? null }
  })
}

const STATUS_TEXT = { green: 'зелёный', red: 'красный', stale: 'гонялся на другом дереве', missing: 'не запускался' }
export const describe = (gate) => `«${gate.name}» (\`${gate.command}\`) — ${STATUS_TEXT[gate.status]}${gate.status === 'red' ? `, код ${gate.code}` : ''}`

/**
 * Закрытие force-прогона при незелёном гейте. «Завершён» — только когда все гейты зелёные на текущем дереве;
 * «завершён с блокерами» — каждый незелёный назван в открытом блокере (локально не запускается: нужен
 * стейджинг, нет браузера). Только для закрытия, записанного после снимка задачи.
 */
export function gateCloseViolations(dataDir, worktree, config, taskDir) {
  const stagesPath = join(taskDir, 'STAGES.md')
  if (!existsSync(stagesPath)) return []
  const block = lastForceBlock(readFileSync(stagesPath, 'utf8'))
  if (!block || !/заверш/i.test(block.heading)) return []
  if (baselineInfo(dataDir, taskDir).lines.has(fingerprint(block.heading))) return []
  const failing = gateStatus(dataDir, worktree, config).filter((gate) => gate.status !== 'green')
  if (!failing.length) return []
  const withBlockers = /с\s+блокер/i.test(block.heading)
  const blockers = openBlockers(block.body).join('\n').toLowerCase()
  return failing
    .filter((gate) => !withBlockers || !(blockers.includes(gate.name.toLowerCase()) || blockers.includes(gate.command.toLowerCase())))
    .map((gate) => ({
      rule: 'ci-gate',
      id: gate.name,
      message:
        `гейт CI ${describe(gate)} на текущем HEAD. Прогони до закрытия: \`node ${RUN_CHECK} -- ${gate.command}\` (или \`node ${fileURLToPath(import.meta.url)} --run\`). ` +
        'Красный — находка fix-loop; локально не запускается — блокер B<n> с причиной и закрытие «завершён с блокерами».',
    }))
}

function main(args) {
  const state = readPipelineState(process.cwd())
  if (!state) {
    console.error('ci-gates: здесь нет pipeline.config.md')
    process.exit(2)
  }
  let gates = gateStatus(pluginDataDir(), state.worktree, state.config)
  if (!gates.length) {
    console.log('Гейтов CI в конфиге нет (таблица «## Гейты CI» или строки e2e / smoke в Commands).')
    process.exit(0)
  }
  if (args.includes('--run')) {
    for (const gate of gates.filter((candidate) => candidate.status !== 'green')) {
      console.log(`\n▶ ${gate.name}: ${gate.command}`)
      spawnSync(process.execPath, [RUN_CHECK, '--', gate.command], { cwd: state.worktree, stdio: 'inherit' })
    }
    gates = gateStatus(pluginDataDir(), state.worktree, state.config)
  }
  for (const gate of gates) console.log(`- ${gate.status === 'green' ? '✅' : '✗'} ${describe(gate)}`)
  process.exit(gates.every((gate) => gate.status === 'green') ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
