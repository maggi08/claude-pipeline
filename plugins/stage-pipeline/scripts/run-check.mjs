#!/usr/bin/env node
/**
 * Тяжёлая проверка этапа (lint / test / type_check / build) — с охватом по дифу и без драки за ресурсы машины.
 *
 *   node run-check.mjs -- yarn eslint {files}             # только изменённые файлы кода; нет таких — пропуск
 *   node run-check.mjs -- yarn vitest related --run {files:ts+tsx+vue}
 *   node run-check.mjs -- yarn type-check                 # без {files} — команда как есть
 *   node run-check.mjs --base origin/dev -- yarn eslint {files}   # изменённое за ветку, а не только в рабочем дереве
 *   node run-check.mjs --mode                             # low | normal и почему
 *
 * Команды из конфига идут по всему репозиторию: на этапе это минуты CPU и гигабайты памяти, а на слабой машине
 * или при 3–4 параллельных проектах — ещё и конкуренция за них. Скрипт делает три вещи:
 * - `{files}` — изменённые и новые файлы кода против HEAD (или merge-base с `--base`) абсолютными путями;
 *   `{files:ts+vue}` — только эти расширения (через `+`: запятую в фигурных скобках раскрыл бы шелл).
 *   Файлов нет — команда не запускается, код 0.
 * - режим `low` (`resources: low` в pipeline.config.local.md, иначе автоматически при ОЗУ ≤ 16 GB) — прогоны
 *   всех проектов машины идут по очереди через общий лок и с пониженным приоритетом (`nice`): две проверки
 *   типов одновременно на 8 GB — своп, а не параллельность.
 * - время и код выхода в последней строке — для журнала этапа.
 * Код выхода — код команды; 2 — сам скрипт не смог (не git-репо, нет команды).
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { join } from 'node:path'
import { readConfig } from './hooks/pipeline-state.mjs'

const args = process.argv.slice(2)
const baseIndex = args.indexOf('--base')
const base = baseIndex === -1 ? null : args[baseIndex + 1]
const separator = args.indexOf('--')
// Один аргумент после `--` — готовая строка шелла (`'a && b'`); несколько — argv, которому шелл вызывающего уже снял
// кавычки: каждое слово экранируется заново, иначе `'%s|'` или `'a|b'` превратились бы в конвейер.
const rest = separator === -1 ? [] : args.slice(separator + 1)
const command = rest.length === 1 ? rest[0] : rest.map((word) => (/^[\w@%+=:,./{}-]+$/.test(word) ? word : shellQuote(word))).join(' ')

const git = (...cmd) => execFileSync('git', ['-c', 'core.quotePath=false', ...cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
let root
try {
  root = git('rev-parse', '--show-toplevel').trim()
} catch {
  fail('не git-репозиторий')
}

const mode = resourceMode()
if (args.includes('--mode')) {
  console.log(`${mode.name} — ${mode.why}`)
  process.exit(0)
}
if (!command) fail('нет команды: node run-check.mjs [--base <ref>] -- <команда с {files} или без>')
// Обёртка только для проверок: git внутри неё не видит хук git-guard, который смотрит на команду целиком.
if (/(^|[;&|(]\s*|\s)git\s/.test(` ${command}`)) fail('run-check — только для проверок (lint/test/type_check/build); git-команды запускай напрямую')

const CODE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|astro|py|go|rb|kt|swift|java|php|rs|cs)$/
const SKIP_PATH = /(^|\/)(node_modules|dist|build|\.next|\.nuxt|\.output|coverage|vendor|__generated__)\//
const placeholder = command.match(/\{files(?::([\w+.]+))?\}/)
let finalCommand = command
if (placeholder) {
  const extensions = placeholder[1]?.split('+').map((ext) => ext.replace(/^\./, ''))
  const matches = extensions ? (path) => extensions.some((ext) => path.endsWith(`.${ext}`)) : (path) => CODE.test(path)
  const files = changedFiles().filter((path) => matches(path) && !SKIP_PATH.test(path))
  if (!files.length) {
    console.log(`run-check: изменённых файлов для «${command}» нет — пропущено`)
    process.exit(0)
  }
  finalCommand = command.replace(placeholder[0], files.map((path) => shellQuote(join(root, path))).join(' '))
  console.log(`run-check: ${mode.name} · ${files.length} изм. файлов · ${command}`)
} else {
  console.log(`run-check: ${mode.name} · ${command}`)
}

const release = mode.name === 'low' ? await acquireLock() : () => {}
const started = Date.now()
const lowPriority = mode.name === 'low' && process.platform !== 'win32'
const child = spawn('/bin/sh', ['-c', lowPriority ? `nice -n 10 /bin/sh -c ${shellQuote(finalCommand)}` : finalCommand], { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal)
    release()
    process.exit(130)
  })
}
child.on('exit', (code, signal) => {
  release()
  const seconds = ((Date.now() - started) / 1000).toFixed(0)
  console.log(`run-check: код ${code ?? signal} за ${seconds} с`)
  process.exit(code ?? 1)
})

/** Изменённые и новые файлы (без удалённых) против HEAD или merge-base с `--base`, от корня репо. */
function changedFiles() {
  let against = 'HEAD'
  if (base) {
    try {
      against = git('merge-base', base, 'HEAD').trim()
    } catch {
      fail(`нет merge-base с ${base}`)
    }
  }
  const tracked = git('diff', '--name-only', '--diff-filter=ACMR', '--no-renames', '-z', against, '--').split('\0')
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0')
  return [...new Set([...tracked, ...untracked])].filter((path) => path && isFile(join(root, path)))
}

/**
 * `resources:` из pipeline.config.local.md / pipeline.config.md (раскладка машины — в local), иначе по памяти:
 * на 16 GB и меньше dev-сервер, браузер, IDE и Claude Code уже делят память, и вторая тяжёлая проверка — своп.
 */
function resourceMode() {
  const override = process.env.STAGE_PIPELINE_RESOURCES
  if (override === 'low' || override === 'normal') return { name: override, why: 'STAGE_PIPELINE_RESOURCES' }
  const configured = readConfig(root).match(/^\s*-\s*resources:\s*`?(low|normal)\b/m)?.[1]
  if (configured) return { name: configured, why: 'resources в pipeline.config' }
  const gb = Math.round(totalmem() / 1024 ** 3)
  return gb <= 16 ? { name: 'low', why: `${gb} GB ОЗУ (≤ 16) — тяжёлые проверки по очереди` } : { name: 'normal', why: `${gb} GB ОЗУ` }
}

/**
 * Лок на машину, а не на репо: очередь нужна именно между проектами. Каталог создаётся атомарно;
 * владелец умер или держит лок дольше 30 минут — лок забирается. Ждём не больше 20 минут, дальше — без очереди.
 */
async function acquireLock() {
  const dir = process.env.STAGE_PIPELINE_LOCK_DIR ?? join(homedir(), '.claude', 'stage-pipeline')
  const lock = join(dir, 'heavy.lock')
  mkdirSync(dir, { recursive: true })
  const deadline = Date.now() + 20 * 60 * 1000
  let announced = false
  while (Date.now() < deadline) {
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, repo: root, command, started: Date.now() }))
      return () => rmSync(lock, { recursive: true, force: true })
    } catch (error) {
      if (error.code !== 'EEXIST') return () => {}
    }
    const owner = readOwner(lock)
    if (!owner || !alive(owner.pid) || Date.now() - owner.started > 30 * 60 * 1000) {
      rmSync(lock, { recursive: true, force: true })
      continue
    }
    if (!announced) {
      console.log(`run-check: жду очереди — ${owner.repo}: ${owner.command}`)
      announced = true
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  console.log('run-check: очередь не освободилась за 20 минут — запускаю без неё')
  return () => {}
}

function readOwner(lock) {
  try {
    return JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))
  } catch {
    // Каталог только что создан, owner.json ещё пишется — считаем занятым, если каталог свежий.
    try {
      return Date.now() - lstatSync(lock).mtimeMs < 5000 ? { pid: process.pid, repo: '?', command: '?', started: Date.now() } : null
    } catch {
      return null
    }
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function isFile(path) {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

function shellQuote(text) {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

function fail(message) {
  console.error(`run-check: ${message}`)
  process.exit(2)
}
