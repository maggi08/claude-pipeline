#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import { join, sep } from 'node:path'

/**
 * verify-doctor — is the dev server on the configured port really THIS worktree's app. Read-only: it sends GET requests and
 * reads process info, it starts and stops nothing.
 *
 * Precedent: core, new-cor and mycar-webview all serve on :3000, and a config of another repo carries a wrong-app warning of its own.
 * A runtime check against another worktree's server is green about the wrong code.
 *
 *   node verify-doctor.mjs [--url <dev-url>] [--route /a --route /b] [--marker <text>] [--cwd <dir>]
 *
 * The URL, `verify_routes:` (`/a, /b`) and `app_marker:` come from the "Dev server" section of `.claude/pipeline.config.md` (the local config overrides);
 * flags override both. Other values (prose after `verify_routes:`, a multi-line marker) are ignored with a note in the line. It prints exactly one `doctor:` line and exits 0 for `ok` and `no dev url`, 1 for `wrong app` and `down`:
 *   doctor: ok — <url> answers on / (marker found), pid 123 cwd /repo/apps/web inside /repo, HEAD abc1234
 *   doctor: wrong app — <url> is held by pid 123 with cwd /other/repo, outside /repo, HEAD abc1234
 *   doctor: wrong app — marker "…" is not on <url>/, …
 *   doctor: ok — front proxy, cwd not checked (the listener's cwd is `/`: a Docker / nginx front)
 *   doctor: down — <url>/ did not answer: ECONNREFUSED
 *   doctor: no dev url — <reason>, HEAD abc1234   (also: the url in the config does not parse)
 * `lsof` missing (or not allowed to look at the process) is a warning inside an `ok` line, not a failure.
 */
const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const flags = (name) => args.flatMap((value, at) => (value === name ? [args[at + 1]] : []))

const cwd = flag('--cwd') ?? process.cwd()
const real = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
const git = (...gitArgs) => {
  try {
    return execFileSync('git', gitArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}
const worktree = real(git('rev-parse', '--show-toplevel') || cwd)
const head = git('rev-parse', '--short', 'HEAD')
const tail = head ? `, HEAD ${head}` : ''
const say = (line, code = 0) => {
  process.stdout.write(`${line}\n`)
  process.exit(code)
}

const config = readConfig(worktree)
const rawUrl = flag('--url') ?? config.url ?? ''
if (!rawUrl || rawUrl === '—' || !/^https?:\/\//.test(rawUrl)) {
  say(`doctor: no dev url — the config has no dev server url (a static file or a non-web target), nothing to probe${tail}`)
}
// the first URL token: `http://localhost:3000 (https via mkcert)` is the url with a remark
const parsed = URL.canParse(rawUrl.split(/\s+/)[0]) ? new URL(rawUrl.split(/\s+/)[0]) : null
if (!parsed) say(`doctor: no dev url — url not parseable${tail}`)
const url = (parsed.origin + parsed.pathname).replace(/\/+$/, '')
const routes = flags('--route').length ? flags('--route') : config.routes.length ? config.routes : ['/']
const marker = flag('--marker') ?? config.marker
const notes = config.notes.length ? ` (ignored in the config: ${config.notes.join('; ')})` : ''

const results = []
const deadline = Date.now() + 15_000 // a total budget for all the routes, not an idle timeout per route
for (const route of routes) {
  const answer = await get(url + (route.startsWith('/') ? route : `/${route}`), deadline)
  results.push({ route, ...answer })
  if (answer.error) say(`doctor: down — ${url}${route} did not answer: ${answer.error}${tail}`, 1)
}

const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
const holders = listeners(port)
// a front proxy (Docker, nginx) runs with cwd `/`: the listener says nothing about the app behind it
const front = holders.some(({ cwd: path }) => path === '/')
const foreign = front ? undefined : holders.find(({ cwd: path }) => path && !inside(worktree, path))
if (foreign) {
  say(`doctor: wrong app — ${url} is held by pid ${foreign.pid} with cwd ${foreign.cwd}, outside ${worktree}${tail}. Do not drive this instance: start this worktree's dev server on a free port or ask the owner.${notes}`, 1)
}
// a 404 on a route is wrong-app only if no baseline route answered 2xx/3xx (a basePath app answers 404 on `/`)
const answered = results.some(({ status }) => status >= 200 && status < 400)
const missing = results.find(({ status }) => status === 404)
if (missing && !answered) say(`doctor: wrong app — ${url}${missing.route} answers 404 and no baseline route answered, the app of this worktree is not there${tail}${notes}`, 1)
if (marker) {
  const without = results.find(({ body, status }) => status >= 200 && status < 300 && !body.includes(marker))
  if (without) say(`doctor: wrong app — marker "${marker}" is not on ${url}${without.route}${tail}${notes}`, 1)
}
const seen = results.map(({ route, status }) => `${route} ${status}`).join(', ')
const [holder] = holders
const process_ = front
  ? 'front proxy, cwd not checked'
  : holder?.pid
    ? holder.cwd
      ? `pid ${holder.pid} cwd ${holder.cwd} inside ${worktree}`
      : `pid ${holder.pid}, its cwd is not readable (warning: not checked)`
    : 'warning: lsof is unavailable or sees no listener, the process cwd is not checked'
say(`doctor: ok — ${url} answers on ${seen}${marker ? `, marker found` : ', no marker in the config (warning: app identity rests on the process cwd)'}, ${process_}${tail}${notes}`)

function inside(root, path) {
  const resolved = real(path)
  return resolved === root || resolved.startsWith(root + sep)
}

/** Every pid listening on the port with its cwd, through lsof; empty where lsof is not there. */
function listeners(portNumber) {
  const run = (...lsofArgs) => execFileSync('lsof', lsofArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
  try {
    const pids = [...new Set(run('-nP', `-iTCP:${portNumber}`, '-sTCP:LISTEN', '-Fp').split('\n').filter((line) => line.startsWith('p')).map((line) => line.slice(1)))]
    return pids.map((pid) => {
      try {
        return { pid, cwd: run('-a', '-p', pid, '-d', 'cwd', '-Fn').split('\n').find((line) => line.startsWith('n'))?.slice(1) }
      } catch {
        return { pid } // another user's process
      }
    })
  } catch {
    return []
  }
}

/** GET with up to three redirects on the same host, self-signed certificates allowed (dev servers). */
function get(target, deadline, hops = 0) {
  return new Promise((done) => {
    const left = deadline - Date.now()
    if (left <= 0) return done({ error: 'timeout (the 15 s budget is spent)' })
    const client = target.startsWith('https') ? https : http
    const request = client.get(target, { rejectUnauthorized: false, timeout: Math.min(8000, left), headers: { 'user-agent': 'stage-pipeline-verify-doctor' } }, (response) => {
      const next = response.headers.location
      if (response.statusCode >= 300 && response.statusCode < 400 && next && hops < 3) {
        response.resume()
        const to = new URL(next, target)
        if (to.host === new URL(target).host) return get(to.href, deadline, hops + 1).then(done)
        return done({ status: response.statusCode, body: '' })
      }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        if (body.length < 400_000) body += chunk
      })
      response.on('end', () => done({ status: response.statusCode, body }))
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    setTimeout(() => request.destroy(new Error('timeout')), left).unref()
    request.on('error', (error) => done({ error: error.code ?? error.message }))
  })
}

/**
 * `url`, `verify_routes:` (comma separated, each `^/\S*$`) and `app_marker:` (one line, no prose markers) of the "Dev server" section; the local config overrides the base one.
 * The key names are specific on purpose: `routes:` / `marker:` already mean something else in live configs (a path to a routes file). Values that do not fit are ignored and noted.
 */
function readConfig(root) {
  const found = { url: undefined, routes: [], marker: undefined, notes: [] }
  for (const name of ['pipeline.config.md', 'pipeline.config.local.md']) {
    const path = join(root, '.claude', name)
    if (!existsSync(path)) continue
    const section = readFileSync(path, 'utf8').match(/^##\s+Dev server[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/im)?.[1] ?? ''
    for (const line of section.split('\n')) {
      const field = line.match(/^\s*-\s*(url|verify_routes|app_marker)\s*:\s*(.+?)\s*(?:#.*)?$/i)
      if (!field) continue
      const key = field[1].toLowerCase()
      const value = field[2].replace(/^`|`$/g, '').trim()
      if (!value || value === '—') continue
      if (key === 'url') found.url = value
      else if (key === 'app_marker') {
        found.marker = value
      } else {
        const items = value.split(',').map((item) => item.trim().replace(/^`|`$/g, '')).filter(Boolean)
        const good = items.filter((item) => /^\/\S*$/.test(item))
        if (good.length !== items.length) found.notes.push(`verify_routes: ${items.length - good.length} value(s) are not a /path`)
        if (good.length) found.routes = good
      }
    }
  }
  return found
}
