#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { configRoot, mainRoot, parseDevServer, readBounded, readConfig } from './hooks/pipeline-state.mjs'
import { ENTRY_FILES_COLUMN, ENTRY_POINTS_HEADING, ENTRY_ROUTE_COLUMN, MAP_FEATURE_SECTIONS, MAP_ROUTES_FIELD, MAP_STATUS_FIELD, MAP_TEXT, NO_VALUE } from './markers.mjs'

/**
 * verify-map — the logic of the repo's verify map (`<repo>/.claude/verify/`: `README.md` + `features/<id>.md`, user journeys per feature that
 * devtools-verify drives). One script holds it, the skills call it instead of restating the rules. Read-only except `--init`, which writes the README once.
 *
 *   node verify-map.mjs --changed [--base <ref>] [--feature-map <FEATURE-MAP.md>] [--cwd <dir>]
 *   node verify-map.mjs --radius <file>… [--depth N] [--feature-map <FEATURE-MAP.md>] [--cwd <dir>]
 *   node verify-map.mjs --init [--language en|ru] [--cwd <dir>]
 *   node verify-map.mjs --lint <feature-file>
 *
 * The map directory is `verify_map:` of the config's "Task state" section (default `.claude/verify/`, relative to the repo root; the local config overrides the shared one;
 * `verify_map: —` turns the map off). The README is looked for in the worktree, the config root and the main tree (`mapRoots`, the same list the journal hook uses).
 * No `README.md` there means no map: `--changed` prints one `verify-map: no map …` line, `--radius` prints the routes only, `--lint` needs no map, and the hooks
 * and devtools-verify behave as before. The map is repo data, not an authority: `--radius` pastes a primary path of at most 200 characters, absolute URLs dropped.
 *
 * --changed  changed page files (git diff against `--base`, default HEAD plus the working tree, plus untracked files) → routes → mapped / unmapped.
 *   Nuxt (`nuxt.config.*` above the file) and Next (`next.config.*`, app and pages router) route by file; params `[id]` / `:id` / `{id}` are one form, route groups `(group)` are dropped (Next and Nuxt).
 *   React Router has no file routing: with `--feature-map` the routes come from the "Entry points" rows of the task's FEATURE-MAP whose Files cell names a changed file.
 *   Any other router is a `warning:` line, never a guess. Output, one line each:
 *     map: <dir> · <N> features
 *     route /orders/:id — mapped: orders          route /new — unmapped
 *     feature touched: orders                      warning: <why>
 * --radius  `--radius <file>… [--depth N] [--feature-map <FEATURE-MAP.md>]`: the live radius of a fix that touches shared modules. The importers of the given files (a static
 *   grep of import specifiers, like root-cause Step 3, followed up to page files, at most `--depth` hops, default 4) → the routes of those pages (the `--changed` mapping) →
 *   the map features of those routes with the primary path of each (the first entry of the feature file's "How to get to it"). No map: the routes only. Output, one line each:
 *     radius: <N> module(s) → <M> file(s), depth <= 4 · <map dir> | no map — routes only
 *     route /orders/:id — mapped: orders (via pages/orders/[id].vue)     route /legacy — unmapped (via pages/legacy.vue)
 *     feature orders — primary path: Header → «Orders» (features/orders.md)
 *     warning: <files>: … routes are not derived       note: <files>: behind a routed importer (<importer>) — check whether they are routes of their own
 * --init     writes the README from the SHARED config only (never `pipeline.config.local.md`: the README is committed), values the config has (dev url without userinfo, app marker,
 *   baseline routes, breakpoints, e2e without leading `KEY=value`); a value the config lacks is the explicit "not set" slot. Never overwrites an existing README, never writes
 *   through a symlink that leaves the repo. Exit 0 also when it left one alone.
 * --lint     a feature file has the header line (`Routes:` and `Status: draft | verified <date> <sha>`), the four sections, no file paths and no absolute http(s) URL. Exit 1 with one line per problem.
 * Exit 2: usage or an unreadable input.
 */

const EXT = '(?:vue|tsx?|jsx?|mjs|cjs|mts|cts|svelte|astro|scss|css|json|ya?ml|py|rb|php|go|rs|java|kt|swift|md|mdx)'
const FRAMEWORK_NAME = /\b(?:Node|Vue|Next|Nuxt|Three|Chart|React|Express|Alpine|Backbone|Ember|Pixi)\.(?:js|JS)\b/g
// A file path in a feature file: a name with a source extension (optionally `:line`), or a path that starts with a code directory or `./`, `../`, `~/`, `@/`.
const FILE_PATH = new RegExp(
  String.raw`(?<![\w/.:@-])(?:(?:\.{1,2}/|~/|@/)[\w.\-\[\]()@/]+|(?:src|app|pages|components|composables|stores?|server|packages|apps|libs?|node_modules|layouts|plugins|middleware|utils|hooks|tests?|e2e)/[\w.\-\[\]()@/]*)|(?<![\w/.:@-])[\w\-\[\]()@]+(?:/[\w\-\[\]()@.]+)*\.${EXT}(?![\w])(?::\d+)?`,
)

const readText = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** A map file (a feature file, the README, a README link target) through the one bounded reader: a regular file of at most 512 KB whose real path lies inside the map directory. `null` otherwise. */
const readMapFile = (path, within) => {
  const read = readBounded(path, { max: SIZE_CAP, within })
  return read.text ?? null
}

const isFile = (path) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const git = (cwd, ...args) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

/** The cleaned value of `- <key>: <value>` (the first occurrence: the local config is read before the shared one), `undefined` — the key is absent. */
function rawValue(text, key) {
  const raw = text.match(new RegExp(`^[ \\t]*-[ \\t]*${key}[ \\t]*:[ \\t]*(.*)$`, 'm'))?.[1]
  return raw === undefined ? undefined : raw.replace(/[ \t]#.*$/, '').trim().replace(/^`+|`+$/g, '').trim()
}

/** The value of `- <key>: <value>` in a config text. `null` — absent or a placeholder. */
export function configValue(text, key, keepAngle = false) {
  const value = rawValue(text, key)
  if (value === undefined) return null
  return !value || NO_VALUE.test(value) || (!keepAngle && /^<.*>$/.test(value)) ? null : value
}

/** The map directory from a config text: relative to the repo root, inside it; `null` — `verify_map: —` turns the map off. Throws on an absolute path or a `..` escape. */
export function mapDir(config) {
  const own = rawValue(config, 'verify_map')
  if (own !== undefined && NO_VALUE.test(own)) return null
  const value = configValue(config, 'verify_map') ?? '.claude/verify/'
  if (isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error(`verify_map: "${value}" must be a path inside the repo`)
  return value.replace(/^\.\//, '').replace(/\/+$/, '')
}

/** The checkouts a map README is looked for in, deduplicated: the worktree, the config root, the main tree (whose `.claude/` may be excluded). One list for the hook and the CLI. */
export function mapRoots(cwd) {
  const top = git(cwd, 'rev-parse', '--show-toplevel')?.trim() ?? resolve(cwd)
  return [...new Set([top, configRoot(cwd, top), mainRoot(cwd)].filter(Boolean))]
}

/** The README of the map, or null: `roots` are the checkouts to look in (see `mapRoots`). */
export function mapReadme(roots, config) {
  let dir
  try {
    dir = mapDir(config)
  } catch {
    return null
  }
  if (dir === null) return null
  for (const root of roots.filter(Boolean)) {
    const path = join(root, dir, 'README.md')
    if (isFile(path)) return path
  }
  return null
}

// --- routes ---

/** One form for a route: no query, no trailing slash, every parameter (`[id]`, `:id`, `{id}`) is `:p`. */
export function normalizeRoute(route) {
  const bare = route.trim().replace(/[?#].*$/, '').replace(/^`+|`+$/g, '')
  const parts = bare.split('/').map((segment) => (/^(?:\[\[?\.{0,3}[^\]]+\]?\]|:[\w-]+\*?|\{[^}]+\})$/.test(segment) ? ':p' : segment))
  const joined = parts.join('/').replace(/\/+$/, '')
  return (joined.startsWith('/') ? joined : `/${joined}`).replace(/\/+/g, '/') || '/'
}

const display = (segments) => `/${segments.join('/')}`
const param = (segment) => {
  const named = segment.match(/^\[{1,2}(?:\.{3})?([^\]]+)\]{1,2}$/)
  return named ? `:${named[1]}` : null
}

function nearestConfig(dir, top, names) {
  for (let at = dir; ; at = dirname(at)) {
    for (const name of names) if (isFile(join(at, name))) return { dir: at, name }
    if (at === top || at === dirname(at)) return null
  }
}

const CONFIGS = { nuxt: ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.cjs', 'nuxt.config.mts'], next: ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs', 'next.config.mts'] }

/**
 * The route of one changed file, or a reason it has none. `{ route }` — a page; `{ framework }` — a page file of a router we know that is not a route (a layout, an API file);
 * `{ warning }` — the router is not one we derive routes for; `null` — not a page file.
 */
export function routeOfFile(file, top) {
  const abs = join(top, file)
  const dir = dirname(abs)
  // the nearest framework config wins: a monorepo holds a Nuxt app next to a Next one
  const found = ['nuxt', 'next'].map((framework) => ({ framework, hit: nearestConfig(dir, top, CONFIGS[framework]) })).filter(({ hit }) => hit)
  if (!found.length) return null
  found.sort((a, b) => b.hit.dir.length - a.hit.dir.length)
  const { framework, hit } = found[0]
  const rel = relative(hit.dir, abs).split(sep).join('/')
  if (framework === 'nuxt') {
    const match = rel.match(/^(?:layers\/[^/]+\/)?(?:(?:app|src)\/)?pages\/(.+)\.(?:vue|tsx?|jsx?|md)$/)
    if (!match) return { framework }
    const segments = match[1].replace(/\.(?:client|server)$/, '').split('/').filter((segment) => !/^\(.+\)$/.test(segment)).map((segment) => param(segment) ?? segment)
    if (segments.at(-1) === 'index') segments.pop()
    return { route: display(segments), framework }
  }
  const app = rel.match(/^(?:src\/)?app\/(?:(.+)\/)?page\.(?:tsx?|jsx?|mdx?)$/)
  if (app) {
    const raw = (app[1] ?? '').split('/').filter(Boolean)
    if (raw.some((segment) => /^\(\.{1,3}\)/.test(segment))) return { warning: `${file}: an intercepting route — its URL depends on the folder level, derive it by hand`, framework }
    const segments = raw.filter((segment) => !/^\(.+\)$/.test(segment) && !segment.startsWith('@')).map((segment) => param(segment) ?? segment)
    return { route: display(segments), framework }
  }
  const pages = rel.match(/^(?:src\/)?pages\/(.+)\.(?:tsx?|jsx?|mdx?)$/)
  if (pages && !app) {
    const segments = pages[1].split('/')
    if (segments[0] === 'api' || /^_(?:app|document|error|middleware)$/.test(segments[0])) return { framework }
    const mapped = segments.map((segment) => param(segment) ?? segment)
    if (mapped.at(-1) === 'index') mapped.pop()
    return { route: display(mapped), framework }
  }
  return { framework }
}

// --- the map on disk ---

const FEATURE_LINK = /^[ \t]*[-*][ \t]*\[([^\]]+)\]\(([^)]+)\)(?:[ \t]*[—–-][ \t]*(.*))?$/
const routesIn = (text) =>
  text
    .split(/[,\s]+/)
    .map((token) => token.replace(/^[`(]+|[`).;]+$/g, ''))
    .filter((token) => token.startsWith('/'))

/** The header-line routes of a feature file: the text after `Routes:` up to the next ` · Field:`. */
export function featureRoutes(text) {
  const line = text.split('\n').slice(0, 12).find((candidate) => MAP_ROUTES_FIELD.test(candidate))
  if (!line) return []
  const after = line.slice(line.search(MAP_ROUTES_FIELD)).replace(MAP_ROUTES_FIELD, '')
  return routesIn(after.split(/[ \t]·[ \t]/)[0])
}

/** The features of a map: `{ id, file, routes }`, from the README list and the `features/` directory. */
export function readMap(readme) {
  const base = dirname(readme)
  const text = readMapFile(readme, base) ?? ''
  const features = new Map()
  const add = (id, file, routes) => {
    const known = features.get(id) ?? { id, file, routes: [] }
    known.routes.push(...routes)
    features.set(id, known)
  }
  for (const line of text.split('\n')) {
    const link = line.match(FEATURE_LINK)
    if (link) add(link[1], link[2], routesIn(link[3] ?? ''))
  }
  const dir = join(base, 'features')
  if (existsSync(dir))
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.md'))) {
      const id = basename(name, '.md')
      const body = readMapFile(join(dir, name), base)
      if (body !== null) add(id, `features/${name}`, featureRoutes(body))
    }
  for (const feature of features.values()) feature.routes = [...new Set(feature.routes)].map((route) => ({ route, key: normalizeRoute(route) }))
  return [...features.values()]
}

const featureFor = (features, route) => {
  const key = normalizeRoute(route)
  return features.find((feature) => feature.routes.some((entry) => entry.key === key || (entry.key.endsWith('/*') && (key === entry.key.slice(0, -2) || key.startsWith(entry.key.slice(0, -1))))))
}

/** The rows of the "Entry points" table of a FEATURE-MAP (either language): `{ id, route, files }`; the ID column is optional. */
export function featureMapRows(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => ENTRY_POINTS_HEADING.test(line))
  if (start < 0) return []
  const rows = []
  let columns = null
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break
    if (!line.trim().startsWith('|')) continue
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue
    if (!columns) {
      const at = (pattern) => cells.findIndex((cell) => pattern.test(cell))
      columns = { id: at(/^ID$/i), route: at(ENTRY_ROUTE_COLUMN), files: at(ENTRY_FILES_COLUMN) }
      continue
    }
    rows.push({ id: columns.id >= 0 ? cells[columns.id] : '', route: columns.route >= 0 ? cells[columns.route] : '', files: columns.files >= 0 ? cells[columns.files] : '' })
  }
  return rows.filter((row) => row.route || row.files)
}

// --- modes ---

/**
 * Whether a FEATURE-MAP "Files" cell names `file`: a whole path, never a substring of a longer name. A cell path may carry a markdown link target (`#L73` anchor dropped),
 * a `:line` suffix and a `./` prefix; it matches when it equals the repo path, when the repo path ends with it after a `/` and it has two or more segments
 * (an app-relative `pages/Guest.tsx` for `apps/dashboard/src/pages/Guest.tsx`), or when it ends with the repo path after a `/`.
 */
function rowNamesFile(cell, file) {
  return cell
    .split(/[\s,;|<>()[\]`]+/)
    .map((part) => part.replace(/#L?\d+(?:-L?\d+)?$/, '').replace(/:\d+(?:[-:]\d+)*$/, '').replace(/^(?:\.{1,2}\/)+/, ''))
    .some((path) => path === file || path.endsWith(`/${file}`) || (path.includes('/') && file.endsWith(`/${path}`)))
}

/** The route of a FEATURE-MAP row: the first `/…` token of the route cell, backticks and trailing punctuation dropped (`/bookings/:id (guest)` → `/bookings/:id`); `null` when the cell has none. */
const rowRoute = (cell) => {
  const token = cell.replace(/`/g, '').split(/\s+/).find((part) => part.startsWith('/'))
  return token ? token.replace(/[,;)]+$/, '') : null
}

function changedFiles(top, base) {
  // `--base` is resolved to a commit first: an option-like value never reaches `git diff` (`--output=<file>` would truncate a file).
  const resolved = base === null ? 'HEAD' : git(top, 'rev-parse', '--verify', '--end-of-options', `${base}^{commit}`)?.trim()
  if (!resolved) throw new Error(`--base ${base.slice(0, 80)} is not a commit`)
  const tracked = git(top, 'diff', '--name-only', '--diff-filter=ACMRT', resolved, '--')
  if (tracked === null) throw new Error(`git diff against ${base ?? 'HEAD'} failed`)
  const untracked = git(top, 'ls-files', '--others', '--exclude-standard') ?? ''
  return [...new Set(`${tracked}\n${untracked}`.split('\n').map((line) => line.trim()).filter(Boolean))]
}

/**
 * The routes of a list of files, one reader for `--changed` and `--radius`: file routing (Nuxt, Next) first; React Router and anything else without it only through the
 * FEATURE-MAP "Entry points" rows whose Files cell names a file of `rowFiles` (default: the files with no route of their own). Every file that stays without a route
 * and classifies as `'warning'` is named in one `warnings` line, never a guess; a file the caller classifies `{ note }` goes to one `notes` line. `known`: route key → FEATURE-MAP row id.
 */
function collectRoutes({ top, files, rows, rowFiles = null, classify = () => 'warning', nameFramework = false }) {
  const routes = new Map()
  const warnings = []
  const notes = []
  const unknown = []
  const layouts = new Set()
  for (const file of files) {
    const result = routeOfFile(file, top)
    if (!result) {
      if (/\.(?:vue|svelte|tsx|jsx)$/.test(file)) unknown.push(file)
      continue
    }
    // a file of a known framework that is not a page (a layout, `app.vue`, `_app.tsx`): named only where the caller asks (the radius), as such
    if (nameFramework && result.route === undefined && !result.warning && /\.(?:vue|svelte|tsx|jsx|ts|js|mjs)$/.test(file)) {
      unknown.push(file)
      layouts.add(file)
    }
    if (result.warning) warnings.push(result.warning)
    else if (result.route !== undefined) routes.set(normalizeRoute(result.route), { route: result.route, file })
  }
  const known = new Map()
  for (const row of rows) {
    const key = rowRoute(row.route)
    if (!key) continue
    if (row.id) known.set(normalizeRoute(key), row.id)
    const named = (rowFiles ?? unknown).find((file) => rowNamesFile(row.files, file))
    if (named) routes.set(normalizeRoute(key), { route: key, file: named })
  }
  const routed = new Set([...routes.values()].map((entry) => entry.file))
  // `classify(file, routed)`: `'warning'` (named, no route derived), `{ note: <routed importer> }` (hidden behind a routed importer: named on its own line, not decided to be a route) or `null` (not named)
  const sorted = unknown.filter((file) => !routed.has(file)).map((file) => [file, classify(file, routed)])
  const unrouted = sorted.filter(([, kind]) => kind === 'warning').map(([file]) => file)
  const hidden = sorted.filter(([, kind]) => kind?.note)
  if (hidden.length) {
    const shown = hidden.slice(0, 8).map(([file]) => file)
    const importers = [...new Set(hidden.map(([, kind]) => kind.note))]
    notes.push(
      `${shown.join(', ')}${hidden.length > 8 ? ` and ${hidden.length - 8} more` : ''}: behind a routed importer (${importers.slice(0, 3).join(', ')}${importers.length > 3 ? ` and ${importers.length - 3} more` : ''}) — check whether ${hidden.length > 1 ? 'they are routes' : 'it is a route'} of ${hidden.length > 1 ? 'their' : 'its'} own`,
    )
  }
  if (unrouted.length) {
    const shown = unrouted.slice(0, 8).map((file) => (layouts.has(file) ? `${file} (a layout or root file, not a page)` : file))
    const cause = unrouted.some((file) => !layouts.has(file)) ? 'no nuxt.config / next.config above and no FEATURE-MAP "Entry points" row names' : 'no FEATURE-MAP "Entry points" row names'
    warnings.push(
      `${shown.join(', ')}${unrouted.length > 8 ? ` and ${unrouted.length - 8} more` : ''}: ${cause} ${unrouted.length > 1 ? 'them' : 'it'} — routes are not derived${rows.length ? '' : ' (React Router and other routers: pass --feature-map)'}`,
    )
  }
  return { routes, warnings, notes, known }
}

export function changedReport({ top, config, base = null, featureMap = null, mapRoots = [top] }) {
  const lines = []
  let dir
  try {
    dir = mapDir(config)
  } catch (error) {
    return { lines: [`verify-map: ${error.message}`], code: 2 }
  }
  if (dir === null) return { lines: ['verify-map: no map — verify_map is off in the config, nothing to match'], code: 0 }
  const readme = mapReadme(mapRoots, config)
  if (!readme) return { lines: [`verify-map: no map — ${dir}/README.md is absent, nothing to match`], code: 0 }
  const features = readMap(readme)
  let files
  try {
    files = changedFiles(top, base)
  } catch (error) {
    return { lines: [`verify-map: ${error.message}`], code: 2 }
  }
  const rows = featureMap ? featureMapRows(readText(featureMap) ?? '') : []
  const { routes, warnings, known } = collectRoutes({ top, files: files.filter((file) => !file.startsWith(`${dir}/`)), rows })
  lines.push(`map: ${dir} · ${features.length} feature${features.length === 1 ? '' : 's'} · README ${resolve(readme)}`)
  const touched = new Set()
  for (const [key, { route }] of routes) {
    const feature = featureFor(features, route) ?? (known.has(key) ? features.find((entry) => entry.id === known.get(key)) : undefined)
    if (feature) touched.add(feature.id)
    lines.push(feature ? `route ${route} — mapped: ${feature.id}` : `route ${route} — unmapped`)
  }
  for (const file of files) {
    const match = file.startsWith(`${dir}/features/`) ? basename(file, '.md') : null
    if (match) touched.add(match)
  }
  for (const id of touched) lines.push(`feature touched: ${id}`)
  for (const warning of warnings) lines.push(`warning: ${warning}`)
  if (!routes.size && !warnings.length) lines.push('no changed page files')
  return { lines, code: 0 }
}

// --- live radius ---

const SOURCE_EXT = /\.(?:vue|tsx?|jsx?|mjs|cjs|mts|cts|svelte|astro)$/
const RESOLVE_EXT = ['', '.vue', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.svelte', '.astro', '/index.vue', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs']
const ALIAS_PREFIX = /^(?:@@?|~~?)\/|^#(?=[\w/])/
const IMPORT_SPEC = /(?:\bimport|\bexport)\b[^'"`;]{0,2000}?\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*['"]([^'"\n]+)['"]|\bimport\(\s*['"]([^'"\n]+)['"]\s*\)|\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g
const FILE_CAP = 20000
const SIZE_CAP = 512 * 1024
// the import regex reads at most this much of a file: a lazy scan over a long file with no `;` and no quote is quadratic
const SCAN_CAP = 200 * 1024
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const noExt = (file) => file.replace(SOURCE_EXT, '')

function sourceFiles(top) {
  const listed = git(top, 'ls-files', '--cached', '--others', '--exclude-standard')
  if (listed === null) throw new Error('git ls-files failed — not a git checkout')
  return listed.split('\n').filter((file) => SOURCE_EXT.test(file) && !file.endsWith('.d.ts') && !/(?:^|\/)(?:node_modules|dist|\.nuxt|\.next|\.output|build|coverage)\//.test(file)).slice(0, FILE_CAP)
}

/** The reverse import graph of the repo's source files: `file → Set<importer>`. Relative specifiers are resolved exactly, `@/` `~/` `#` aliases by the end of the path; a `<Name>` tag of a `.vue` file names a Nuxt auto-imported component. */
export function importGraph(top, files = sourceFiles(top)) {
  const set = new Set(files)
  const byBase = new Map()
  for (const file of files) {
    const stem = noExt(file)
    for (const key of new Set([basename(stem), basename(stem) === 'index' ? basename(dirname(stem)) : null].filter(Boolean))) byBase.set(key, [...(byBase.get(key) ?? []), file])
  }
  const importers = new Map()
  const link = (target, importer) => {
    if (target === importer) return
    const known = importers.get(target) ?? new Set()
    known.add(importer)
    importers.set(target, known)
  }
  const components = files.filter((file) => file.endsWith('.vue') && /^[A-Z]/.test(basename(file))).map((file) => ({ file, name: basename(file, '.vue') }))
  for (const file of files) {
    let text
    try {
      // a FIFO, a device or a symlink to one is not read: stat says size 0 for them and the read blocks or never ends
      const stat = statSync(join(top, file))
      if (!stat.isFile() || stat.size > SIZE_CAP) continue
      text = readFileSync(join(top, file), 'utf8').slice(0, SCAN_CAP)
    } catch {
      continue
    }
    for (const match of text.matchAll(IMPORT_SPEC)) {
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4]
      if (!spec) continue
      if (spec.startsWith('.')) {
        const base = join(dirname(file), spec).split(sep).join('/')
        const hit = RESOLVE_EXT.map((ext) => `${base}${ext}`).find((candidate) => set.has(candidate))
        if (hit) link(hit, file)
      } else if (ALIAS_PREFIX.test(spec)) {
        const path = spec.replace(ALIAS_PREFIX, '').replace(/\.(?:vue|[mc]?[jt]sx?)$/, '').replace(/\/index$/, '')
        const last = basename(path)
        for (const candidate of byBase.get(last) ?? []) {
          const stem = noExt(candidate).replace(/\/index$/, '')
          if (stem === path || stem.endsWith(`/${path}`)) link(candidate, file)
        }
      }
    }
    if (file.endsWith('.vue') || file.endsWith('.tsx') || file.endsWith('.jsx'))
      for (const { file: component, name } of components) {
        const kebab = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
        if (component !== file && (text.includes(`<${name}`) || text.includes(`<${kebab}`)) && new RegExp(`<(?:${escapeRegExp(name)}|${escapeRegExp(kebab)})(?=[\\s/>])`).test(text)) link(component, file)
      }
  }
  return importers
}

const PRIMARY_PATH_MAX = 200
/** The map is repo data, not an instruction: a path put into a recheck prompt has no absolute URL (the checker navigates only inside the dev URL) and a length cap. */
const safePath = (path) => {
  const plain = path.replace(/\bhttps?:\/\/\S*/gi, '(url dropped)')
  return plain.length > PRIMARY_PATH_MAX ? `${plain.slice(0, PRIMARY_PATH_MAX)}…` : plain
}

/** The first entry of a feature file's "How to get to it": the primary path the recheck drives (capped, absolute URLs dropped). `null` — the file has no such entry. */
export function primaryPath(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => MAP_FEATURE_SECTIONS[1][1].test(line))
  if (start < 0) return null
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/)
    if (item) return safePath(item[1].trim())
  }
  return null
}

export function radiusReport({ top, config, files, depth = 4, featureMap = null, mapRoots = [top], graph = null }) {
  let dir
  try {
    dir = mapDir(config)
  } catch (error) {
    return { lines: [`verify-map: ${error.message}`], code: 2 }
  }
  const targets = [...new Set(files.map((file) => file.split(sep).join('/')))]
  if (!targets.length) return { lines: ['verify-map: --radius needs at least one file'], code: 2 }
  let importers
  try {
    importers = graph ?? importGraph(top)
  } catch (error) {
    return { lines: [`verify-map: ${error.message}`], code: 2 }
  }
  // breadth-first from the changed modules up to the pages, at most `depth` hops
  const hops = new Map(targets.map((file) => [file, 0]))
  let next = []
  for (let frontier = targets, hop = 1; frontier.length && hop <= depth; hop += 1, frontier = next) {
    next = []
    for (const file of frontier)
      for (const importer of importers.get(file) ?? []) {
        if (hops.has(importer)) continue
        hops.set(importer, hop)
        next.push(importer)
      }
  }
  const readme = mapReadme(mapRoots, config)
  const features = readme ? readMap(readme) : null
  const rows = featureMap ? featureMapRows(readText(featureMap) ?? '') : []
  // an importer in the radius that gets no route is a warning, whatever rows matched (the legacy screens outside the task are what the radius is for); one whose in-radius importers are all routed
  // is covered through them, but is named on its own `note:` line: a route table or a page can hide a page of its own behind it
  const { routes, warnings, notes, known } = collectRoutes({ top, files: [...hops.keys()], rows, rowFiles: [...hops.keys()], nameFramework: true, classify: (file, routed) => {
    if (hops.get(file) === 0) return null
    const above = [...(importers.get(file) ?? [])].filter((importer) => hops.has(importer))
    return !above.length || !above.every((importer) => routed.has(importer)) ? 'warning' : { note: above[0] }
  } })
  const lines = [`radius: ${targets.length} module${targets.length === 1 ? '' : 's'} → ${hops.size - targets.length} importer file${hops.size - targets.length === 1 ? '' : 's'}, depth <= ${depth} · ${features ? `${dir} · README ${resolve(readme)}` : 'no map — routes only'}`]
  const touched = new Map()
  for (const [key, { route, file }] of routes) {
    const feature = features ? (featureFor(features, route) ?? (known.has(key) ? features.find((entry) => entry.id === known.get(key)) : undefined)) : undefined
    if (feature) touched.set(feature.id, feature)
    lines.push(`route ${route} — ${features ? (feature ? `mapped: ${feature.id}` : 'unmapped') : 'no map'} (via ${file})`)
  }
  for (const feature of touched.values()) {
    const path = primaryPath(readMapFile(join(dirname(readme), feature.file), dirname(readme)) ?? '')
    lines.push(`feature ${feature.id} — primary path: ${path ?? 'none written — see the feature file'} (${feature.file})`)
  }
  for (const warning of warnings) lines.push(`warning: ${warning}`)
  for (const note of notes) lines.push(`note: ${note}`)
  if (!routes.size && !warnings.length && !notes.length) lines.push('no page imports these modules within the depth')
  return { lines, code: 0 }
}

/** The README is committed: a URL carries no `user:password@`, a command no leading `NAME=value` environment assignment (a token often lives there). */
const plainUrl = (text) => (text === null ? null : text.replace(/\b(https?:\/\/)[^/\s@]*@/gi, '$1'))
const plainCommand = (text) => (text === null ? null : plainUrl(text.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')))

export function readmeText({ config, language = 'en', base, branch, date, widths = null }) {
  const t = MAP_TEXT[language] ?? MAP_TEXT.en
  const slot = t.notSet
  const dev = devServerConfigOf(config)
  const value = (key) => configValue(config, key)
  const surface = [`${t.widths}: ${widths ?? slot}`, `${t.webview}: ${value('target_width') ?? slot}`].join('; ')
  return [
    `# ${t.title} — ${value('slug') ?? slot}`,
    `${t.base}: ${base ?? slot}${branch ? ` (${branch})` : ''} · ${t.updated}: ${date}`,
    `## ${t.instance}`,
    `- ${t.dev}: ${plainUrl(dev.url) ?? slot}`,
    `- ${t.marker}: ${dev.marker ?? slot}`,
    `- ${t.routes}: ${dev.routes ?? slot}`,
    `- ${t.ready}`,
    `## ${t.preconditions}`,
    `- ${t.auth}: ${slot}`,
    `- ${t.e2e}: ${plainCommand(value('e2e')) ?? slot}`,
    `- ${t.playwright}: ${slot}`,
    `- ${t.data}: ${slot}`,
    `- ${t.writes}: ${slot}`,
    `- ${t.surface}: ${surface}`,
    `- ${t.theme}: ${slot}`,
    `## ${t.conventions}`,
    `- ${t.conv1}`,
    `- ${t.conv2}`,
    `- ${t.conv3}`,
    `## ${t.proof}`,
    `- ${t.proof1}`,
    `- ${t.proof2}`,
    `- ${t.proof3}`,
    `## ${t.features}`,
    `- ${t.none}`,
    '',
  ].join('\n')
}

// the "Dev server" section, read by the one parser the doctor and the hook use
function devServerConfigOf(config) {
  const dev = parseDevServer([config])
  return { url: dev.url ?? null, marker: dev.marker ?? null, routes: dev.routes.length ? dev.routes.join(', ') : null }
}

const insideOf = (base, target) => target === base || target.startsWith(`${base}${sep}`)

/** Why `path` may not be written, or null: the nearest existing part of it (a symlink included) must resolve inside the repo; a broken symlink is named. */
function symlinkProblem(top, path) {
  let root
  try {
    root = realpathSync(top)
  } catch {
    return null
  }
  for (let at = path; ; at = dirname(at)) {
    let exists = true
    try {
      lstatSync(at)
    } catch {
      exists = false
    }
    if (exists) {
      try {
        return insideOf(root, realpathSync(at)) ? null : `${relative(top, at) || '.'} is a symlink that leaves the repo`
      } catch {
        return `${relative(top, at) || '.'} is a broken symlink`
      }
    }
    if (dirname(at) === at) return null
  }
}

export function initReadme({ top, config, mapConfig = config, language = 'en' }) {
  let dir
  try {
    dir = mapDir(mapConfig)
  } catch (error) {
    return { lines: [`verify-map: ${error.message}`], code: 2 }
  }
  if (dir === null) return { lines: ['verify-map: verify_map is off in the config — nothing written'], code: 0 }
  const path = join(top, dir, 'README.md')
  const problem = symlinkProblem(top, path)
  if (problem) return { lines: [`verify-map: ${problem} — nothing written`], code: 2 }
  if (existsSync(path)) return { lines: [`verify-map: ${dir}/README.md exists — left as it is`], code: 0 }
  const sha = git(top, 'rev-parse', '--short', 'HEAD')?.trim() ?? null
  const branch = git(top, 'symbolic-ref', '--short', '-q', 'HEAD')?.trim() ?? null
  const widths = configValue(config, 'breakpoints')
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, readmeText({ config, language, base: sha, branch, date: new Date().toISOString().slice(0, 10), widths }), { flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') return { lines: [`verify-map: ${dir}/README.md exists — left as it is`], code: 0 }
    return { lines: [`verify-map: cannot write ${dir}/README.md — ${error.code ?? error.message}`], code: 2 }
  }
  return { lines: [`verify-map: wrote ${dir}/README.md from the config (values the config lacks are marked "${(MAP_TEXT[language] ?? MAP_TEXT.en).notSet}")`], code: 0 }
}

const LINT_LINE_MAX = 2000

/** The problems of a feature file, `[{ line, message }]`: header line, the four sections, file paths. */
export function lintFeature(text) {
  const problems = []
  const lines = text.split(/\r?\n/)
  if (!/^#[ \t]+\S/.test(lines[0] ?? '')) problems.push({ line: 1, message: 'the first line must be the feature name as a "# " heading' })
  const header = lines.slice(1, 12).find((line) => MAP_ROUTES_FIELD.test(line))
  if (!header) problems.push({ line: 2, message: 'no header line with "Routes: <route> · Auth: … · Platforms: … · Status: draft | verified <date> <sha>"' })
  else {
    if (!routesIn(header.slice(header.search(MAP_ROUTES_FIELD)).replace(MAP_ROUTES_FIELD, '').split(/[ \t]·[ \t]/)[0]).length) problems.push({ line: lines.indexOf(header) + 1, message: 'the header line names no route (a route starts with "/")' })
    if (!MAP_STATUS_FIELD.test(header)) problems.push({ line: lines.indexOf(header) + 1, message: 'the header line has no "Status: draft | verified <date> <sha>"' })
  }
  for (const [name, pattern] of MAP_FEATURE_SECTIONS) if (!pattern.test(text)) problems.push({ line: 0, message: `no "## ${name}" section` })
  lines.forEach((whole, at) => {
    const line = whole.slice(0, LINT_LINE_MAX)
    const url = line.match(/\bhttps?:\/\/\S*/i)
    if (url) problems.push({ line: at + 1, message: `absolute URL "${url[0].slice(0, 60)}" — the map holds routes of the dev URL; another origin is never a path to drive` })
    const found = line.replace(FRAMEWORK_NAME, ' ').match(FILE_PATH)
    if (found) problems.push({ line: at + 1, message: `file path "${found[0]}" — the map is user-facing and holds routes and what the user sees, not code paths` })
  })
  return problems
}

function main(args) {
  const flag = (name) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : undefined
  }
  const out = (result) => {
    for (const line of result.lines) console.log(line)
    process.exit(result.code)
  }
  if (args.includes('--lint')) {
    const file = flag('--lint')
    const text = file ? readText(resolve(file)) : null
    if (text === null) out({ lines: [`verify-map: cannot read ${file ?? '(no file given)'}`], code: 2 })
    const problems = lintFeature(text)
    out(problems.length ? { lines: problems.map(({ line, message }) => `lint: ${file}${line ? `:${line}` : ''} — ${message}`), code: 1 } : { lines: [`lint: ok — ${file}`], code: 0 })
  }
  const cwd = resolve(flag('--cwd') ?? process.cwd())
  const top = git(cwd, 'rev-parse', '--show-toplevel')?.trim() ?? cwd
  const root = configRoot(cwd, top) ?? top
  const roots = mapRoots(cwd)
  const config = readConfig(root)
  if (args.includes('--changed')) {
    const featureMap = flag('--feature-map')
    out(changedReport({ top, config, base: flag('--base') ?? null, featureMap: featureMap ? resolve(featureMap) : null, mapRoots: roots }))
  }
  if (args.includes('--radius')) {
    const at = args.indexOf('--radius')
    const named = []
    for (const arg of args.slice(at + 1)) {
      if (arg.startsWith('--')) break
      named.push(relative(top, resolve(realpathSync(cwd), arg)))
    }
    const featureMap = flag('--feature-map')
    const depth = Number.parseInt(flag('--depth') ?? '4', 10)
    out(radiusReport({ top, config, files: named, depth: Number.isInteger(depth) && depth > 0 ? Math.min(depth, 12) : 4, featureMap: featureMap ? resolve(featureMap) : null, mapRoots: roots }))
  }
  if (args.includes('--init')) {
    // the README is committed: it is built from the shared config only, never from the gitignored local one
    const shared = readText(join(root, '.claude/pipeline.config.md')) ?? ''
    const language = flag('--language') ?? configValue(shared, 'language') ?? 'en'
    // the map directory is read the way the consumers read it (local over shared); the README values stay with the shared config
    out(initReadme({ top, config: shared, mapConfig: config, language: language === 'ru' ? 'ru' : 'en' }))
  }
  console.error('Usage: node verify-map.mjs --changed [--base <ref>] [--feature-map <file>] | --radius <file>… [--depth N] [--feature-map <file>] | --init [--language en|ru] | --lint <feature-file>')
  process.exit(2)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
