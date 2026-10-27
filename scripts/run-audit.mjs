#!/usr/bin/env node
/**
 * run-audit (VT-3 stage 7b): a per-force-run digest of what really happened, read from the transcripts. Dev repo only, deterministic, no dependencies, no model.
 * The manual audits (three so far) were done by hand, and what they counted was never counted twice the same way; this is the count, so that a lens (the dev skill
 * `/audit-runs`) starts from numbers and not from memory.
 *
 * INPUTS - explicit paths only. It never lists or globs `~/.claude/projects` as a whole (D7: that directory holds every project's conversations):
 *   --repo <path>          a repo of the task. Its task directory comes from that repo's `.claude/pipeline.config.md` (`task_path`, which may point outside the repo, e.g. `~/.claude/x-tasks/`;
 *                          a trailing `<TICKET>/` placeholder is dropped). May be repeated (a task that ran in two repos).
 *   --task-dir <dir>       a task directory given directly (the parent of `<task>/STAGES.md`), when no repo config is at hand (the self-test uses this).
 *   --task <name>          a task: the directory `<task_dir>/<name>` (STAGES.md, STAGES-ARCHIVE.md, checks/). May be repeated; each task is read with all the --repo / --transcripts given.
 *   --transcripts <path>   a directory of `<session>.jsonl` files (and `<session>/subagents/agent-*.jsonl` beside them) or one session file. May be repeated.
 *                          Without any --transcripts, the ONE project directory of each --repo is derived: `~/.claude/projects/<repo path with every non-alphanumeric character replaced by "-">`
 *                          (Claude Code's own encoding). That is a single directory of one repo, named from the path given; nothing else under `~/.claude/projects` is opened.
 *                          An explicit --transcripts always wins over the derived directory.
 *   --session <file>       a session given explicitly: audited as one extra run of its own (every event of it and of its subagents), with no Force block behind it.
 *   --after-days <n>       how far after a run closes "after done" looks (user messages, commits); default 7. It stops at the next run's start.
 *   --plugin <dir>         the plugin whose skills and agents "never invoked" is measured against; default: this repo's `plugins/stage-pipeline`.
 *   --out <file>           write the markdown there instead of stdout.   --json   machine output instead of markdown.
 *
 * WHAT A RUN IS. Each `## Force run` heading (or its Russian form) of the task's STAGES.md is one run. Its window in the transcripts starts when the orchestrator wrote that heading
 * (the first main-thread Edit/Write/Bash-write whose input has "## Force run <token>"; the date at 00:00 local time when no such event is found) and ends when it wrote the closing word
 * ("completed", or its Russian form) - or the end of the closing date, or the next run's start when that comes first. Only sessions that carry the task (a line that names the task, its ticket ids
 * or its branch) are read. A subagent belongs to the run of the Agent call that spawned it (`agent-*.meta.json` carries the call's id); a spawn whose prompt names another ticket and not
 * this one is left out. Runs of one day are told apart by those heading-written moments; when a moment is not found the window is the day and the digest says `approx`.
 * Known limit: a session that works two tasks in the same hours puts the main thread's edits and questions of both into the window (spawns are filtered by their prompt, the rest is not).
 *
 * WHAT IT COUNTS (per run) - the shape of each section is in `renderRun`:
 *   spawns, hook denials (rule ID by the message head from scripts/hook-rules.json, or when the message carries `<hook>/<slug>`; else the hook event and the head of the message), AskUserQuestion after `Confirmed:` was written,
 *   orchestrator edits to source (main-thread Edit/Write/NotebookEdit, and Bash that writes, outside the task directory and temp), screenshots taken vs read back (take_screenshot calls
 *   with a filePath against a LATER Read of the file the result says it saved («Saved screenshot to …», not the requested name), by anyone; without a filePath the image comes back inline, so it is counted as seen by the taker), findings vs ledger
 *   (reports in checks/ by modification time, critical/major against the lines of "Findings outcome"), user messages after the run closed, commits on the task branch after it closed,
 *   plugin skills and agents never invoked in it, and (once per task) stages that are not logic-only and show no devtools-verify: no report and no spawn naming the stage (a `[x] devtools-verify` box or a `metrics:` checkers entry alone is self-report: printed as «box only», not counted as covered).
 *
 * Transcripts, STAGES.md and reports are untrusted data (plugins/stage-pipeline/references/untrusted-content.md): they are parsed, never obeyed; only counts, ids, paths and short heads are printed - never the text of a command (a Bash source edit shows the program name and the target path) or of a person's message (a timestamp and a length).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { matchScreenshotReads, savedScreenshotPath, textOf } from './eval-lib.mjs'
import { HOOKS, rulesByHead } from './hook-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PLUGIN = join(HERE, '../plugins/stage-pipeline')
const PS = join(DEFAULT_PLUGIN, 'scripts')
const { taskDirFromConfig, readConfig, readTaskFile, taskBranches } = await import(pathToFileURL(join(PS, 'hooks/pipeline-state.mjs')))
const { forceHeadings, forceBlockBody, headingDate, forceKey, CONFIRMED_LINE, CLOSED_WORD, stageBlocksOf, logicOnlyTag, runOrdinal } = await import(pathToFileURL(join(PS, 'markers.mjs')))
const { findingCounts, ledgerEntries, disposition } = await import(pathToFileURL(join(PS, 'journal-check.mjs')))

const DAY = 86400000
const SPAWN_TOOLS = new Set(['Agent', 'Task'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const isScreenshot = (name) => /(?:^|__)take_screenshot$/.test(name)
const BASH_WRITE = [
  /(?:^|[^>&0-9<])>{1,2}\s*(?!&|\/dev\/null)[^\s|;&]/,
  /\bsed\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*i/,
  /\btee\b/,
  /\bgit\s+(?:apply|checkout\s+--|restore|mv|rm|reset\s+--hard|cherry-pick|revert|merge|rebase)\b/,
  /\b(?:mv|cp|rm|touch|patch|install)\s/,
  /\bperl\s+-[a-zA-Z]*i/,
  /(?:prettier\s+(?:.*\s)?--write|--fix\b)/,
]
const NOT_SOURCE = (path) => /^\/(?:private\/)?tmp\//.test(path) || /\/scratchpad\//.test(path) || /^\/dev\//.test(path)

// ── reading transcripts ──────────────────────────────────────────────────────────────────────────────────────────────

export const encodeProject = (repo) => resolve(repo).replace(/[^A-Za-z0-9]/g, '-')

/** The session files of a --transcripts path: a file as is, a directory's `*.jsonl` (not recursive, not `subagents/`). */
function sessionFilesOf(path) {
  if (!existsSync(path)) return []
  if (statSync(path).isFile()) return [path]
  return readdirSync(path)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => join(path, name))
}

// A user message that is a person's, not the harness's: not a tool result, not a system-reminder, a slash-command echo, a hook or task notification, a compact summary.
const HARNESS_USER = /^\s*(?:<system-reminder>|<command-|<local-command|<task-notification|<user-prompt-submit-hook|Caveat:|\[Request interrupted|This session is being continued|\[Subagent hand-back\]|<bash-|<ide_)/
const DENIAL_HEAD = /^\s*(?:PreToolUse|PostToolUse|SubagentStop|Stop)[\w:.-]*\s+hook\s+(?:error|blocking)/i

/**
 * One transcript file -> its events, kept lean (the real ones are up to 90 MB): the tool calls the digest looks at, the results of the few it needs, the denials, the people's messages.
 * `needles` are the strings that make a session "carry" the task; `carries` is set when a line has one of them.
 */
function readTranscript(file, needles) {
  const events = []
  let carries = false
  let sessionId = null
  const watched = new Set() // tool_use ids whose result matters (screenshots)
  const skills = new Set()
  const seenUse = new Set() // the same tool call is written more than once when a message is streamed in parts
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { file, events, carries: false, sessionId, unreadable: true }
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    if (!carries && needles.some((needle) => line.includes(needle))) carries = true
    if (!/"type":"(?:assistant|user|attachment)"/.test(line)) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    sessionId ??= o.sessionId ?? null
    const ts = Date.parse(o.timestamp ?? '')
    const base = { ts: Number.isFinite(ts) ? ts : null, cwd: typeof o.cwd === 'string' ? o.cwd : null }
    if (o.type === 'attachment') {
      const a = o.attachment
      const t = String(a?.blockingError?.blockingError ?? '')
      if (a?.type === 'hook_blocking_error' && /stage-pipeline/.test(t)) events.push({ ...base, kind: 'denial', event: String(a.hookEvent ?? ''), tool: String(a.hookName ?? '').split(':')[1] ?? '', text: t.slice(0, 600) })
      continue
    }
    const content = o.message?.content
    if (o.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== 'tool_use' || seenUse.has(b.id)) continue
        seenUse.add(b.id)
        if (isScreenshot(b.name)) watched.add(b.id)
        events.push({ ...base, kind: 'use', id: b.id, name: b.name, input: slim(b.name, b.input ?? {}) })
      }
      if (o.attributionSkill && !skills.has(o.attributionSkill)) {
        skills.add(o.attributionSkill)
        events.push({ ...base, kind: 'skill-attribution', skill: o.attributionSkill })
      }
    } else if (o.type === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== 'tool_result') continue
          const t = textOf(b.content)
          if (b.is_error && DENIAL_HEAD.test(t.slice(0, 200)) && /stage-pipeline/.test(t.slice(0, 400))) {
            events.push({ ...base, kind: 'denial', event: (t.match(/^\s*([\w:.-]+)\s+hook/i) ?? [])[1] ?? '', tool: '', text: t.slice(0, 600) })
          } else if (watched.has(b.tool_use_id)) events.push({ ...base, kind: 'result', id: b.tool_use_id, isError: Boolean(b.is_error), saved: b.is_error ? null : savedScreenshotPath(t, {}) })
        }
      }
      if (!o.isSidechain && !o.isMeta && !o.isCompactSummary) {
        const human = Array.isArray(content) ? (content.some((b) => b?.type === 'tool_result') ? '' : textOf(content)) : typeof content === 'string' ? content : ''
        const command = human.match(/<command-name>\/?([^<\s]+)<\/command-name>/)?.[1]
        if (command) events.push({ ...base, kind: 'command', name: command.replace(/^stage-pipeline:/, '') })
        if (human.trim() && !HARNESS_USER.test(human)) events.push({ ...base, kind: 'user', chars: human.trim().length })
      }
    }
  }
  return { file, events, carries, sessionId }
}

/** The part of a tool input the digest needs, so that a transcript of 90 MB does not stay in memory whole. */
function slim(name, input) {
  const out = {}
  if (SPAWN_TOOLS.has(name)) {
    out.subagent_type = input.subagent_type ?? null
    out.model = input.model ?? null
    out.promptChars = String(input.prompt ?? '').length
    out.description = String(input.description ?? '').slice(0, 120)
    out.prompt = String(input.prompt ?? '').slice(0, 4000)
  } else if (name === 'AskUserQuestion') {
    out.question = JSON.stringify(input.questions ?? input).slice(0, 160)
  } else if (EDIT_TOOLS.has(name)) {
    out.file_path = input.file_path ?? input.notebook_path ?? null
    out.marker = JSON.stringify([input.new_string, input.content, input.new_source]).slice(0, 20000)
  } else if (name === 'Read') {
    out.file_path = input.file_path ?? null
  } else if (name === 'Bash') {
    out.command = String(input.command ?? '').slice(0, 20000)
  } else if (name === 'Skill') {
    out.skill = input.skill ?? null
  } else if (isScreenshot(name)) {
    out.filePath = input.filePath ?? null
  }
  return out
}

/** The subagent files beside a session: `<session>/subagents/agent-*.jsonl` with their `.meta.json`. */
function subagentsOf(sessionFile) {
  const dir = join(sessionFile.replace(/\.jsonl$/, ''), 'subagents')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /^agent-.+\.jsonl$/.test(name))
    .sort()
    .map((name) => {
      let meta = {}
      try {
        meta = JSON.parse(readFileSync(join(dir, name.replace(/\.jsonl$/, '.meta.json')), 'utf8'))
      } catch {
        meta = {}
      }
      return { file: join(dir, name), agentId: name.replace(/^agent-|\.jsonl$/g, ''), meta }
    })
}

// ── the task ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const idsIn = (text) => [...new Set(text.match(/\b[A-Z]{2,6}-(?:\d{1,5}|no-ticket)\b/gi) ?? [])]

function loadTask(taskDir, name) {
  const dir = join(taskDir, name)
  const stages = readTaskFile(dir, 'STAGES.md') ?? ''
  const archive = readTaskFile(dir, 'STAGES-ARCHIVE.md') ?? ''
  const branches = taskBranches(stages)
  const ids = [...new Set([...idsIn(branches.join(' ')), ...idsIn(stages.split(/^## /m)[0]), ...(/^[A-Z]{2,6}-\d{1,5}$/i.test(name) ? [name] : [])])]
  return { name, dir, stages, archive, branches, ids, needles: [...new Set([`/${name}/`, name, ...ids])] }
}

/** The runs of a task from its Force headings, in file order. */
function runsOf(task) {
  return forceHeadings(task.stages).map((match) => {
    const heading = match[0]
    const key = heading.match(/^## (?:Force-прогон|Force run)\s+(\S+(?:\s+\(\d+\))?)/)
    const closedAt = heading.search(CLOSED_WORD)
    const body = forceBlockBody(task.stages, match)
    return {
      heading,
      token: key?.[1] ?? headingDate(heading) ?? heading,
      key: forceKey(heading).replace(/^## /, ''),
      date: headingDate(heading),
      ordinal: runOrdinal(heading),
      closed: closedAt !== -1,
      closeDate: closedAt !== -1 ? headingDate(heading.slice(closedAt)) : null,
      confirmedDate: CONFIRMED_LINE.test(body) ? headingDate(body.match(new RegExp(`${CONFIRMED_LINE.source}\\s*([^\\n]*)`, 'im'))?.[1] ?? '') : null,
    }
  })
}

const localStart = (iso) => (iso ? new Date(`${iso}T00:00:00`).getTime() : null)
const iso = (ms) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString())

// ── the pool: every event of the sessions that carry the task ────────────────────────────────────────────────────────

function buildPool(files, needles, given = []) {
  const sessions = []
  const seen = new Set()
  for (const file of [...files, ...given]) {
    if (seen.has(file)) continue
    seen.add(file)
    const main = readTranscript(file, needles)
    if (!main.carries && !given.includes(file)) continue
    const agents = subagentsOf(file).map((agent) => ({ ...agent, ...readTranscript(agent.file, []) }))
    sessions.push({ file, main, agents })
  }
  return sessions
}

/** Flatten to `{ ...event, session, agentId|null }`; subagent events know their agent. */
function flatten(sessions) {
  const all = []
  for (const s of sessions) {
    for (const e of s.main.events) all.push({ ...e, session: s.file, agentId: null })
    for (const a of s.agents) for (const e of a.events) all.push({ ...e, session: s.file, agentId: a.agentId })
  }
  return all
}

// ── runs: windows ────────────────────────────────────────────────────────────────────────────────────────────────────

const inputText = (e) => `${e.input?.marker ?? ''} ${e.input?.command ?? ''}`
const writesText = (e) => EDIT_TOOLS.has(e.name) || (e.name === 'Bash' && BASH_WRITE.some((re) => re.test(e.input.command ?? '')))
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The moments the orchestrator wrote a run's heading, its `Confirmed:` and its closing word; null when not found. The heading is looked for by its token (`<date>[ (n)]`), because
 * the orchestrator renames the rest of a heading as the run goes. Two runs of one day with no ordinal share a token and differ only after it: a write that carries a run's whole key
 * (`forceKey`: the heading without its closing tail) belongs to the longest such key, a write with the bare token to the shortest.
 */
function findMoments(run, runs, mainUses) {
  const tokenRe = (r) => new RegExp(`## (?:Force-прогон|Force run)\\s+${escapeRe(r.token)}(?![\\w-])(?!\\s*\\()`)
  const sameToken = runs.filter((r) => r.token === run.token)
  const owns = (text) => {
    if (!tokenRe(run).test(text)) return false
    if (sameToken.length < 2) return true
    const full = sameToken.filter((r) => text.includes(`## ${r.key}`)).sort((x, y) => y.key.length - x.key.length)
    if (full.length) return full[0] === run
    return [...sameToken].sort((x, y) => x.key.length - y.key.length)[0] === run
  }
  const written = mainUses.filter((e) => writesText(e) && owns(inputText(e)))
  const startEv = written[0] ?? null
  let closeEv = null
  let confirmEv = null
  if (startEv) {
    const mine = tokenRe(run)
    // The closing is the LAST writing of the heading with the closing word that is not later than the end of the closing date (the heading is rewritten as the run goes, and
    // opened with the closing word already in it when a block is rewritten whole): not the first one.
    const limit = run.closeDate ? localStart(run.closeDate) + DAY + DAY / 2 : Infinity
    for (const e of written) {
      const text = inputText(e)
      const at = text.search(mine)
      const rest = text.slice(at, at + 800).replace(/\\n/g, '\n').split('\n')[0]
      // A closing word within ten minutes of the opening is the heading being written (or renamed), not the run ending.
      if (e !== startEv && e.ts >= startEv.ts + 600000 && e.ts <= limit && CLOSED_WORD.test(rest)) closeEv = e
    }
    confirmEv = mainUses.find((e) => e.ts >= startEv.ts && writesText(e) && /(?:Confirmed|Подтверждено)\s*:/.test(inputText(e)) && (!closeEv || e.ts <= closeEv.ts)) ?? null
  }
  return { start: startEv?.ts ?? null, close: closeEv?.ts ?? null, confirmedAt: confirmEv?.ts ?? null }
}

function windows(runs, all) {
  const mainUses = all.filter((e) => e.kind === 'use' && !e.agentId && e.ts != null).sort((a, b) => a.ts - b.ts)
  const withMoments = runs.map((run) => ({ ...run, ...findMoments(run, runs, mainUses) }))
  // Chronological order of the runs is the order of the headings' dates, then their ordinals ("(2)", "b", "second run"), then the file order; the moments only place a run inside that.
  const ordered = withMoments.map((run, index) => ({ run, index })).sort((a, b) => (a.run.date ?? '').localeCompare(b.run.date ?? '') || a.run.ordinal - b.run.ordinal || a.index - b.index)
  const starts = []
  ordered.forEach(({ run }, i) => {
    const day = localStart(run.date)
    // A heading found more than a day after its own date was edited later (or its first writing is in a transcript that is gone): the date is the better start.
    const found = run.start != null && (day == null || run.start - day <= DAY) ? run.start : null
    const prev = i > 0 ? starts[i - 1] : -Infinity
    starts.push(Math.max(found ?? day ?? Infinity, prev))
  })
  const out = new Array(runs.length)
  ordered.forEach(({ run, index }, i) => {
    const nextStart = starts[i + 1] ?? Infinity
    const dayEnd = run.closeDate ? localStart(run.closeDate) + DAY : null
    const closeAt = run.close ?? dayEnd
    out[index] = { ...run, from: starts[i], to: Math.max(starts[i], Math.min(closeAt ?? Infinity, nextStart)), closeAt, nextStart, approx: run.start == null || starts[i] !== run.start || (run.closed && run.close == null) }
  })
  return out
}

// ── digest pieces ────────────────────────────────────────────────────────────────────────────────────────────────────

// The message heads of every rule (scripts/hook-rules.json, checked by validate.mjs): the transcript shows the message, and no hook writes its rule ID into it.
const HOOK_RULES = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, 'hook-rules.json'), 'utf8'))
  } catch {
    return { rules: {} }
  }
})()

function denialLabel(e) {
  const byHead = rulesByHead(e.text, HOOK_RULES)
  if (byHead.length) return { rule: byHead.join('|') }
  const id = e.text.match(new RegExp(`\\b(?:${HOOKS.join('|')})/[a-z0-9]+(?:-[a-z0-9]+)*`))?.[0]
  if (id) return { rule: id }
  const head = e.text.replace(/^.*?\bhook (?:error|blocking error):\s*/i, '').replace(/^stage-pipeline:\s*/, '').replace(/\s+/g, ' ').slice(0, 70)
  return { rule: `${e.event || 'hook'}${e.tool ? `:${e.tool}` : ''}`, head }
}

function auditRun(w, ctx) {
  const { all, agentRun, repoRoots, taskDirs } = ctx
  const events = all.filter((e) => (e.agentId ? agentRun.get(e.agentId) === w.key : e.ts != null && e.ts >= w.from && e.ts < w.to))
  const ownSpawns = events.filter((e) => e.kind === 'use' && SPAWN_TOOLS.has(e.name) && !ctx.foreign(e))

  const spawns = ownSpawns.map((e) => {
    const meta = ctx.metaOf.get(e.id)
    return { type: e.input.subagent_type ?? meta?.agentType ?? null, model: e.input.model ?? meta?.model ?? null, promptChars: e.input.promptChars, by: e.agentId ? 'subagent' : 'main', description: e.input.description }
  })

  const denials = new Map()
  for (const e of events.filter((x) => x.kind === 'denial')) {
    const label = denialLabel(e)
    const key = `${label.rule}\u0000${label.head ?? ''}`
    denials.set(key, { ...label, count: (denials.get(key)?.count ?? 0) + 1 })
  }

  const confirmedAt = w.confirmedAt ?? localStart(w.confirmedDate)
  const asks = events.filter((e) => e.kind === 'use' && e.name === 'AskUserQuestion' && !e.agentId)
  const midRun = confirmedAt == null ? [] : asks.filter((e) => e.ts > confirmedAt)

  const sourceEdits = []
  for (const e of events.filter((x) => x.kind === 'use' && !x.agentId)) {
    if (EDIT_TOOLS.has(e.name)) {
      const p = e.input.file_path
      if (!p || taskDirs.some((d) => p.startsWith(`${d}/`)) || NOT_SOURCE(p)) continue
      sourceEdits.push({ tool: e.name, path: p, where: repoRoots.some((r) => p.startsWith(`${r}/`)) ? 'repo' : 'other' })
    } else if (e.name === 'Bash') {
      const w = bashWrite(e.input.command ?? '', { repoRoots, taskDirs })
      if (w) sourceEdits.push({ tool: 'Bash', path: w.label, where: w.where })
    }
  }

  const ownSkills = new Set()
  for (const e of events) {
    if (e.kind === 'use' && e.name === 'Skill' && e.input.skill) ownSkills.add(String(e.input.skill).replace(/^stage-pipeline:/, ''))
    if (e.kind === 'command') ownSkills.add(e.name)
    if (e.kind === 'skill-attribution') ownSkills.add(String(e.skill).replace(/^stage-pipeline:/, ''))
  }
  const spawned = new Set(spawns.map((s) => String(s.type ?? '').replace(/^stage-pipeline:/, '')))
  const closeAt = w.closeAt
  const horizon = closeAt == null ? null : Math.min(w.nextStart, closeAt + ctx.afterDays * DAY)
  const after = horizon == null || !w.closed ? [] : all.filter((e) => e.kind === 'user' && !e.agentId && e.ts > closeAt && e.ts < horizon)
  const commits = w.closed && closeAt != null ? ctx.commitsAfter(closeAt, horizon) : { note: w.closed ? 'close time unknown' : 'run not closed', list: [] }

  return {
    key: w.key,
    heading: w.heading.replace(/^## /, ''),
    window: { from: iso(w.from), to: iso(w.to), approx: w.approx },
    closed: w.closed,
    transcriptEvents: events.length,
    spawns,
    denials: [...denials.values()].sort((a, b) => b.count - a.count),
    mid: { confirmedAt: iso(confirmedAt), confirmedExact: w.confirmedAt != null, asksTotal: asks.length, afterConfirmed: midRun.map((e) => ({ at: iso(e.ts), question: e.input.question })) },
    sourceEdits,
    screenshots: screenshotCounts(events, ctx.readsAll),
    userAfterDone: after.map((e) => ({ at: iso(e.ts), chars: e.chars })),
    commitsAfterClose: commits,
    neverSkills: ctx.skills.filter((s) => !ownSkills.has(s) && !spawned.has(s)),
    neverAgents: ctx.agents.filter((a) => !spawned.has(a)),
    spawnedStages: stagesNamed(ownSpawns.map((e) => `${e.input.description ?? ''} ${e.input.prompt ?? ''}`)),
    implementedStages: implementedStages(ownSpawns),
    verifiedStages: stagesNamed(ownSpawns.filter((e) => String(e.input.subagent_type ?? '').replace(/^stage-pipeline:/, '') === 'devtools-verify').map((e) => `${e.input.description ?? ''} ${e.input.prompt ?? ''}`)),
  }
}


/**
 * The name of the program a command runs (the first word of its first segment that is not `cd`, `export` or a `VAR=value`): the only part of a command the digest prints, next to the target path.
 * The rest of a command line is untrusted text that may hold a secret (`echo KEY=... >> .env`), so it is never copied into a digest (S-2).
 */
const commandName = (command) => {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const word = segment.trim().split(/\s+/).find((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
    if (word && !['cd', 'export', 'set', 'time', 'sudo'].includes(word)) return word.replace(/^.*\//, '').replace(/[^\w.+-]/g, '').slice(0, 24) || 'command'
  }
  return 'command'
}

/** Heredoc bodies and quoted text are data, not commands: dropped before the command is read for writes. */
const withoutBodies = (command) => command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\b/g, '<<$2').replace(/'[^'\n]*'|"[^"\n]*"/g, "''")

/**
 * Whether a Bash command writes, and where: `{ where: 'repo' | 'relative' | 'opaque' | 'other', label }` or null when it writes nothing, or only into temp, the task directory or `~/.claude`.
 * `repo` - a target under a given repo; `relative` - a target path relative to a cwd the digest does not know (counted with source, a guess); `opaque` - a write-like command with no readable
 * target (`python3 - <<EOF`, `git apply`, `sed -i` on a variable); `other` - an absolute path under none of the given repos.
 */
export function bashWrite(command, { repoRoots, taskDirs }) {
  const bare = withoutBodies(command)
  const targets = []
  for (const m of bare.matchAll(/(?:^|[^>&0-9<=-])>{1,2}\s*([^\s|;&<>()]+)/g)) targets.push(m[1])
  for (const m of bare.matchAll(/\bsed\s+(?:-(?!e\s)[a-zA-Z]+\s+|-e\s+\S+\s+)*-[a-zA-Z]*i\S*\s+(?:'[^']*'|\S+)\s+([^\s|;&]+)/g)) targets.push(m[1])
  for (const m of bare.matchAll(/\btee\s+(?:-a\s+)?([^\s|;&]+)/g)) targets.push(m[1])
  for (const m of bare.matchAll(/\b(?:cp|mv)\s+(?:-\w+\s+)*\S+\s+([^\s|;&]+)/g)) targets.push(m[1])
  const real = targets.filter((t) => !/^\/dev\//.test(t) && !t.startsWith('&') && t !== "''")
  const home = homedir()
  const abs = (t) => (t === '~' || t.startsWith('~/') ? join(home, t.slice(1)) : t)
  // `cd <dir> && ...` fixes the directory the relative targets of that command are about.
  const cd = bare.match(/^\s*cd\s+(\S+)/)?.[1]
  const base = cd && !cd.startsWith('$') ? abs(cd) : null
  const known = real.map((t) => (base && base.startsWith('/') && !abs(t).startsWith('/') && !t.startsWith('$') ? join(base, abs(t)) : abs(t)))
  const inRepo = known.filter((t) => repoRoots.some((r) => t.startsWith(`${r}/`)))
  if (inRepo.length) return { where: 'repo', label: `${commandName(bare)} -> ${inRepo[0]}` }
  const relative = known.filter((t) => !t.startsWith('/') && !t.startsWith('$'))
  if (relative.length) return { where: 'relative', label: `${commandName(bare)} -> ${relative[0]}` }
  const elsewhere = known.filter((t) => t.startsWith('/') && !NOT_SOURCE(t) && !taskDirs.some((d) => t.startsWith(`${d}/`)) && !t.startsWith(`${home}/.claude/`))
  if (elsewhere.length) return { where: 'other', label: `${commandName(bare)} -> ${elsewhere[0]}` }
  if (known.length) return null
  if (/\bgit\s+(?:apply|checkout\s+--|restore|mv|rm|reset\s+--hard|cherry-pick|revert|merge|rebase)\b|\bsed\s+(?:-\S+\s+)*-[a-zA-Z]*i|\bperl\s+-[a-zA-Z]*i|prettier\s+(?:.*\s)?--write|--fix\b|\b(?:python3?|node)\s+-?\s*<<|\b(?:rm|mv|cp|touch|patch|install)\s/.test(bare)) return { where: 'opaque', label: commandName(bare) }
  return null
}

/** The stages the run's stage-implement spawns were about: the description names them, else the first stage the prompt names. */
function implementedStages(spawns) {
  const found = new Set()
  for (const e of spawns.filter((x) => String(x.input.subagent_type ?? '').replace(/^stage-pipeline:/, '') === 'stage-implement')) {
    const named = stagesNamed([e.input.description ?? ''])
    for (const n of named.length ? named : stagesNamed([e.input.prompt ?? '']).slice(0, 1)) found.add(n)
  }
  return [...found].sort((a, b) => Number(a) - Number(b))
}

/**
 * Screenshots taken in the events, against the Reads of the same files (`readsAll` - every Read of the pool, with its time).
 * The file is the one the tool SAYS it saved («Saved screenshot to …», which rewrites x.jpg to x.jpeg when `format` is jpeg), the requested filePath only when the result has no such line.
 * A Read counts only before the same file is shot again (the earlier image was overwritten unseen).
 */
function screenshotCounts(events, readsAll) {
  const taken = events.filter((e) => e.kind === 'use' && isScreenshot(e.name))
  const failed = new Set(events.filter((e) => e.kind === 'result' && e.isError).map((e) => e.id))
  const savedOf = new Map(events.filter((e) => e.kind === 'result' && !e.isError && e.saved).map((e) => [e.id, e.saved]))
  const ok = taken.filter((e) => !failed.has(e.id))
  const pathOf = (e) => (e.input.filePath ? savedOf.get(e.id) ?? e.input.filePath : null) // no filePath asked: the image comes back inline, whatever the server also wrote to a temp file
  const inline = ok.filter((e) => !pathOf(e)).length
  const withFile = matchScreenshotReads(ok.filter((x) => pathOf(x)).map((e) => ({ path: pathOf(e), cwd: e.cwd, ts: e.ts })), readsAll)
  const bySource = {}
  for (const e of ok) {
    const k = `${e.session}${e.agentId ? `#agent-${e.agentId}` : ''}`
    bySource[k] = (bySource[k] ?? 0) + 1
  }
  return { taken: ok.length, failed: taken.length - ok.length, withFile: withFile.length, readBack: withFile.filter((t) => t.read).length, notRead: withFile.filter((t) => !t.read).length, inline, bySource }
}

// ── stages without devtools-verify ───────────────────────────────────────────────────────────────────────────────────

/** Stage numbers a file-name spec refers to: `19-21` is 19..21 (a short range), `18-A` is stage 18, `r2` and the like are ignored. */
function numbersOf(spec) {
  const m = spec.match(/^(\d+)(?:-(\d+))?/)
  if (!m) return []
  const a = Number(m[1])
  const b = m[2] != null ? Number(m[2]) : a
  return b > a && b - a <= 20 ? Array.from({ length: b - a + 1 }, (_, i) => String(a + i)) : [String(a)]
}

/** The stages a text names: "stage 5", "stages 33-42" (and the Russian forms), and report names `devtools-verify-19-21.md`. */
function stagesNamed(texts) {
  const found = new Set()
  for (const text of texts) {
    for (const m of text.matchAll(/(?:stage|этап[а-яё]*)[\s:#`]*(\d+(?:\s*[-–—,и&]\s*\d+)*)/gi)) {
      const nums = m[1].split(/\s*[-–—,и&]\s*/).map(Number)
      if (/[-–—]/.test(m[1]) && nums.length === 2 && nums[1] > nums[0] && nums[1] - nums[0] <= 20) for (let n = nums[0]; n <= nums[1]; n++) found.add(String(n))
      else for (const n of nums) found.add(String(n))
    }
    for (const m of text.matchAll(/devtools-verify-([0-9][\w.-]*?)\.md/g)) for (const n of numbersOf(m[1])) found.add(n)
  }
  return [...found].sort((a, b) => Number(a) - Number(b))
}

function devtoolsCoverage(task, spawnTexts) {
  const blocks = new Map()
  for (const text of [task.stages, task.archive]) {
    for (const b of stageBlocksOf(text)) {
      const prev = blocks.get(b.number)
      blocks.set(b.number, { number: b.number, heading: prev?.heading ?? b.block.split('\n')[0], text: `${prev?.text ?? ''}\n${b.block}` })
    }
  }
  const reports = new Map()
  const checks = join(task.dir, 'checks')
  for (const f of existsSync(checks) ? readdirSync(checks).filter((n) => n.endsWith('.md')) : []) {
    const m = f.match(/devtools-verify-([0-9][\w.-]*?)\.md$/) ?? f.match(/^stage-(\d+[\w.]*)-devtools-verify/)
    if (m) for (const n of numbersOf(m[1])) reports.set(n, [...(reports.get(n) ?? []), f])
  }
  const metrics = new Set()
  for (const line of `${task.stages}\n${task.archive}`.split('\n')) {
    const m = line.match(/metrics:\s*stage=(\S+).*?checkers=(\S*)/)
    if (m && /devtools-verify/.test(m[2])) for (const n of numbersOf(m[1])) metrics.add(n)
  }
  const spawned = new Set(stagesNamed(spawnTexts))
  const rows = []
  for (const b of [...blocks.values()].sort((a, c) => Number(a.number) - Number(c.number))) {
    const status = (b.heading.match(/\[status:\s*([^\]]+)\]/i)?.[1] ?? '').trim().split(/\s+/)[0]
    if (/^(?:cancel|отмен|todo)/i.test(status)) continue
    const box = b.text.split('\n').find((l) => /^\s*-\s*\[[ x]\]\s*devtools-verify/i.test(l))
    if (logicOnlyTag(b.heading) || (box && /skip[^)]*logic-only/i.test(box))) continue
    const boxDone = Boolean(box && /\[x\]/i.test(box) && !/skip/i.test(box))
    const evidence = { report: reports.get(b.number)?.length ?? 0, spawn: spawned.has(b.number) ? 1 : 0, box: boxDone ? 1 : 0, metrics: metrics.has(b.number) ? 1 : 0 }
    // A report file in checks/ or a spawn that names the stage is what happened; a ticked box or a `metrics:` checkers entry is what the orchestrator wrote about itself.
    const strong = evidence.report > 0
    const has = strong || evidence.spawn > 0
    rows.push({ stage: b.number, status, has, strong, boxOnly: !has && evidence.box + evidence.metrics > 0, skipped: Boolean(box && /skip/i.test(box)), evidence })
  }
  return { uiStages: rows.length, without: rows.filter((r) => !r.has).map((r) => ({ stage: r.stage, skipped: r.skipped })), withoutStrong: rows.filter((r) => !r.strong).map((r) => ({ stage: r.stage, skipped: r.skipped, spawnOnly: r.has })), boxOnly: rows.filter((r) => r.boxOnly).map((r) => ({ stage: r.stage, skipped: r.skipped })), with: rows.filter((r) => r.has).map((r) => r.stage), rows }
}

// ── findings vs ledger ───────────────────────────────────────────────────────────────────────────────────────────────

function ledgerOf(task) {
  const dir = join(task.dir, 'checks')
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir).filter((name) => name.endsWith('.md')).sort()) {
    const path = join(dir, f)
    let text
    let mtime
    try {
      const st = statSync(path)
      if (st.size > 2 * 1024 * 1024) continue
      mtime = st.mtimeMs
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const counts = findingCounts(text, f)
    const entries = ledgerEntries(text)
    const outcomes = { fixed: 0, false: 0, blocker: 0, user: 0, none: 0 }
    for (const entry of entries ?? []) {
      const d = disposition(entry)
      outcomes[d in outcomes ? d : 'none']++
    }
    const critical = counts.critical ?? 0
    const major = counts.major ?? 0
    if (critical + major === 0 && !entries?.length) continue
    out.push({ file: f, mtime, critical, major, hasLedger: entries != null, lines: entries?.length ?? 0, ...outcomes })
  }
  return out
}

// ── git ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

function commitsAfterFactory(repos, branches) {
  return (from, to) => {
    const list = []
    const notes = []
    let seen = false
    for (const repo of repos) {
      for (const branch of branches) {
        try {
          execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${branch}^{commit}`], { stdio: 'ignore' })
        } catch {
          continue
        }
        seen = true
        try {
          const args = ['-C', repo, 'log', branch, `--since=${new Date(from).toISOString()}`, '--max-count=60', '--format=%h|%cI|%s']
          if (Number.isFinite(to)) args.push(`--until=${new Date(to).toISOString()}`)
          for (const line of execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean)) {
            const [sha, at, ...subject] = line.split('|')
            list.push({ repo: basename(repo), branch, sha, at, subject: subject.join('|').slice(0, 90) })
          }
        } catch {
          notes.push(`git log failed in ${basename(repo)}`)
        }
      }
    }
    return { note: notes.length ? notes.join('; ') : seen ? '' : 'the task branch is in none of the given repos', list }
  }
}

// ── the whole audit ──────────────────────────────────────────────────────────────────────────────────────────────────

export function runAudit(options) {
  const repos = (options.repos ?? []).map((r) => resolve(r))
  const pluginDir = resolve(options.plugin ?? DEFAULT_PLUGIN)
  const skills = existsSync(join(pluginDir, 'skills')) ? readdirSync(join(pluginDir, 'skills')).filter((n) => existsSync(join(pluginDir, 'skills', n, 'SKILL.md'))).sort() : []
  const agents = existsSync(join(pluginDir, 'agents')) ? readdirSync(join(pluginDir, 'agents')).filter((n) => n.endsWith('.md')).map((n) => n.replace(/\.md$/, '')).sort() : []

  const taskDirs = [...new Set([...(options.taskDirs ?? []).map((d) => resolve(d)), ...repos.map((r) => taskDirFromConfig(readConfig(r), r))])]
  const transcriptPaths = (options.transcripts ?? []).length ? options.transcripts.map((p) => resolve(p)) : repos.map((r) => join(homedir(), '.claude/projects', encodeProject(r)))
  const files = [...new Set(transcriptPaths.flatMap(sessionFilesOf))]
  const report = { generatedFrom: { repos, taskDirs, transcriptPaths, sessionFiles: files.length }, tasks: [], skills, agents }

  for (const name of options.tasks ?? []) {
    const taskDir = taskDirs.find((d) => existsSync(join(d, name, 'STAGES.md'))) ?? taskDirs.find((d) => existsSync(join(d, name)))
    if (!taskDir) {
      report.tasks.push({ name, error: `no task directory ${name} under ${taskDirs.join(', ') || '(no task dir known: pass --repo with a pipeline.config.md or --task-dir)'}` })
      continue
    }
    const task = loadTask(taskDir, name)
    const sessions = buildPool(files, task.needles)
    const all = flatten(sessions)
    const uses = all.filter((e) => e.kind === 'use')
    const spawnsById = new Map(uses.filter((e) => SPAWN_TOOLS.has(e.name)).map((e) => [e.id, e]))
    const metaOf = new Map()
    const agentSpawn = new Map()
    for (const s of sessions) for (const a of s.agents) if (a.meta?.toolUseId) { metaOf.set(a.meta.toolUseId, a.meta); agentSpawn.set(a.agentId, spawnsById.get(a.meta.toolUseId) ?? null) }
    const foreign = (e) => {
      const text = `${e.input.description ?? ''} ${e.input.prompt ?? ''}`
      const others = idsIn(text).filter((id) => !task.ids.some((own) => own.toLowerCase() === id.toLowerCase()))
      return others.length > 0 && !task.needles.some((n) => text.includes(n))
    }
    const wins = windows(runsOf(task), all).map((w, i) => ({ ...w, key: `run${i}` }))
    const runOfEvent = (e) => wins.find((w) => e.ts != null && e.ts >= w.from && e.ts < w.to)?.key ?? null
    const agentRun = new Map()
    const resolveAgent = (agentId, depth = 0) => {
      const sp = agentSpawn.get(agentId)
      if (!sp || foreign(sp)) return null
      return sp.agentId && depth < 6 ? resolveAgent(sp.agentId, depth + 1) : runOfEvent(sp)
    }
    for (const s of sessions) for (const a of s.agents) agentRun.set(a.agentId, resolveAgent(a.agentId))

    const readsOf = (events) => events.filter((e) => e.kind === 'use' && e.name === 'Read' && e.input.file_path && e.ts != null).map((e) => ({ path: e.input.file_path, ts: e.ts }))
    const ctx = {
      all, agentRun, foreign, metaOf, skills, agents,
      repoRoots: repos, taskDirs: [...new Set([task.dir, ...taskDirs.map((d) => join(d, name))])],
      readsAll: readsOf(all), afterDays: options.afterDays ?? 7, commitsAfter: commitsAfterFactory(repos, task.branches),
    }
    const runResults = wins.map((w) => auditRun(w, ctx))

    for (const session of options.sessions ?? []) {
      const file = resolve(session)
      const s = buildPool([], task.needles, [file])
      const sAll = flatten(s)
      const span = sAll.filter((e) => e.ts != null).map((e) => e.ts)
      if (!span.length) continue
      const sMeta = new Map(s.flatMap((x) => x.agents.filter((a) => a.meta?.toolUseId).map((a) => [a.meta.toolUseId, a.meta])))
      const w = { key: 'session', heading: `session ${basename(file)}`, from: Math.min(...span), to: Math.max(...span) + 1, closed: false, approx: true, confirmedAt: null, confirmedDate: null, nextStart: Infinity, closeAt: null }
      runResults.push(auditRun(w, { ...ctx, all: sAll, agentRun: new Map(s.flatMap((x) => x.agents.map((a) => [a.agentId, 'session']))), metaOf: sMeta, readsAll: readsOf(sAll) }))
    }

    // Screenshots of the carrying sessions that no run owns (before the first run, between runs, after the last one, a spawn left out): said once, so that nothing is lost silently.
    const isForeignAgent = (e) => e.agentId && (!agentSpawn.get(e.agentId) || foreign(agentSpawn.get(e.agentId)))
    const unownedAll = all.filter((e) => e.kind === 'use' && isScreenshot(e.name) && !wins.some((w) => (e.agentId ? agentRun.get(e.agentId) === w.key : e.ts >= w.from && e.ts < w.to)))
    const unowned = unownedAll.filter((e) => !isForeignAgent(e))
    const leftOut = unownedAll.length - unowned.length
    const outside = auditRun({ key: 'outside', heading: 'outside', from: -Infinity, to: Infinity, closed: false, nextStart: Infinity, closeAt: null }, {
      ...ctx,
      all: unowned,
      agentRun: new Map(unowned.filter((e) => e.agentId).map((e) => [e.agentId, 'outside'])),
    }).screenshots
    const ledger = ledgerOf(task)
    const devtools = devtoolsCoverage(task, [...spawnsById.values()].filter((e) => !foreign(e) && String(e.input.subagent_type ?? '').replace(/^stage-pipeline:/, '') === 'devtools-verify').map((e) => `${e.input.description ?? ''} ${e.input.prompt ?? ''}`))
    const dvReports = existsSync(join(task.dir, 'checks')) ? readdirSync(join(task.dir, 'checks')).filter((n) => /devtools-verify-\d/.test(n) && n.endsWith('.md')).map((n) => ({ n, mtime: statSync(join(task.dir, 'checks', n)).mtimeMs })) : []
    const uiStages = new Set(devtools.rows.map((r) => r.stage))
    for (const run of runResults) {
      const w = wins.find((x) => x.key === run.key)
      run.findings = w ? ledger.filter((l) => l.mtime >= w.from && l.mtime < w.to) : []
      const reported = w ? stagesNamed(dvReports.filter((r) => r.mtime >= w.from && r.mtime < w.to).map((r) => r.n)) : []
      const verified = new Set([...run.verifiedStages, ...reported])
      run.implementedWithoutDevtools = run.implementedStages.filter((n) => uiStages.has(n) && !verified.has(n))
      run.implementedUi = run.implementedStages.filter((n) => uiStages.has(n))
      run.namedUi = run.spawnedStages.filter((n) => uiStages.has(n))
      run.namedWithoutDevtools = run.namedUi.filter((n) => !verified.has(n))
    }
    report.tasks.push({
      name, dir: task.dir, branches: task.branches, ids: task.ids,
      sessionsRead: sessions.map((s) => ({ file: s.file, events: s.main.events.length, agents: s.agents.length })),
      runs: runResults,
      screenshotsOutsideRuns: { ...outside, leftOutForeign: leftOut },
      devtools,
      ledgerAll: ledger,
    })
  }
  return report
}

// ── markdown ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const count = (items, key) => {
  const m = new Map()
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}
const sum = (items, key) => items.reduce((a, i) => a + (i[key] ?? 0), 0)

function renderRun(run, lines) {
  lines.push(`### Run: ${run.heading}`, '')
  if (!run.transcriptEvents) lines.push('- NO transcript events in this window (no transcript of this run in the given paths): the counts below are zero by absence, not by measurement')
  lines.push(`- window: ${run.window.from ?? '?'} .. ${run.window.to ?? 'open'}${run.window.approx ? ' (approx: a heading or closing moment was not found in the transcripts, the day is used)' : ''}; closed: ${run.closed ? 'yes' : 'no'}; transcript events in the run: ${run.transcriptEvents}`)
  lines.push(`- agent spawns: ${run.spawns.length}${run.spawns.length ? `; prompt chars total ${sum(run.spawns, 'promptChars')}, max ${Math.max(...run.spawns.map((s) => s.promptChars))}` : ''}`)
  for (const [k, n] of count(run.spawns, (s) => `${String(s.type ?? '?').replace(/^stage-pipeline:/, '')} (${s.model ?? 'default'})`)) lines.push(`  - ${k}: ${n}`)
  lines.push(`- hook denials: ${sum(run.denials, 'count')}`)
  for (const d of run.denials) lines.push(`  - ${d.rule}${d.head ? ` - "${d.head}"` : ''}: ${d.count}`)
  lines.push(`- AskUserQuestion: ${run.mid.asksTotal} in the run, ${run.mid.afterConfirmed.length} after \`Confirmed:\` (${run.mid.confirmedAt ? `${run.mid.confirmedAt}${run.mid.confirmedExact ? '' : ', date only'}` : 'Confirmed moment not found'})`)
  for (const a of run.mid.afterConfirmed) lines.push(`  - ${a.at}: ${a.question}`)
  const edits = run.sourceEdits.filter((e) => e.tool !== 'Bash')
  const writes = run.sourceEdits.filter((e) => e.tool === 'Bash')
  const by = (list, where) => list.filter((e) => e.where === where).length
  lines.push(`- orchestrator edits to source (main thread, outside the task dir, temp and ~/.claude): Edit/Write in a given repo ${by(edits, 'repo')}${by(edits, 'other') ? ` (+${by(edits, 'other')} Edit/Write outside every given repo)` : ''}; Bash write-like commands ${writes.length}: to a repo path ${by(writes, 'repo')}, to a relative path ${by(writes, 'relative')}, opaque (script, git apply, sed -i on a variable) ${by(writes, 'opaque')}, other absolute ${by(writes, 'other')} - the Bash split is a heuristic`)
  for (const [k, n] of count(edits.filter((e) => e.where === 'repo'), (e) => `${e.tool}: ${e.path}`).slice(0, 10)) lines.push(`  - ${k}${n > 1 ? ` x${n}` : ''}`)
  for (const [k, n] of count(writes.filter((e) => e.where === 'repo' || e.where === 'relative'), (e) => `Bash: ${e.path}`).slice(0, 6)) lines.push(`  - ${k}${n > 1 ? ` x${n}` : ''}`)
  const sh = run.screenshots
  lines.push(`- screenshots: taken ${sh.taken} (failed calls ${sh.failed}); with a file ${sh.withFile}: read back ${sh.readBack}, never read ${sh.notRead} (a Read of the saved file counts only before that file is shot again; the saved path is the one the tool result names); inline (no filePath, seen by the taker) ${sh.inline}`)
  for (const [k, n] of Object.entries(sh.bySource).sort()) lines.push(`  - ${n} in ${k}`)
  const f = run.findings
  lines.push(`- findings vs ledger (reports whose last modification falls in the window): ${f.length} reports; critical ${sum(f, 'critical')}, major ${sum(f, 'major')}; ledger lines ${sum(f, 'lines')} (fixed ${sum(f, 'fixed')}, false ${sum(f, 'false')}, blocker ${sum(f, 'blocker')}, user ${sum(f, 'user')}, no outcome ${sum(f, 'none')})`)
  for (const r of f.filter((x) => x.critical + x.major > x.lines)) lines.push(`  - ${r.file}: critical ${r.critical}, major ${r.major}, ledger lines ${r.lines}${r.hasLedger ? '' : ' (no "Findings outcome" section)'}`)
  lines.push(`- user messages after done: ${run.closed ? run.userAfterDone.length : 'n/a (run not closed)'}`)
  for (const m of run.userAfterDone.slice(0, 5)) lines.push(`  - ${m.at}: ${m.chars} characters`)
  lines.push(`- commits after close: ${run.commitsAfterClose.list.length}${run.commitsAfterClose.note ? ` (${run.commitsAfterClose.note})` : ''}`)
  for (const c of run.commitsAfterClose.list.slice(0, 8)) lines.push(`  - ${c.sha} ${c.at.slice(0, 10)} ${c.repo}: ${c.subject}`)
  lines.push(`- plugin skills never invoked in the run (${run.neverSkills.length}): ${run.neverSkills.join(', ') || 'none'}`)
  lines.push(`- plugin agents never spawned in the run (${run.neverAgents.length}): ${run.neverAgents.join(', ') || 'none'}`)
}

export function renderMarkdown(report) {
  const lines = ['# run-audit digest', '']
  lines.push(`Repos: ${report.generatedFrom.repos.join(', ') || '(none)'}; task dirs: ${report.generatedFrom.taskDirs.join(', ') || '(none)'}; transcripts read from: ${report.generatedFrom.transcriptPaths.join(', ') || '(none)'} (${report.generatedFrom.sessionFiles} session files).`, '')
  lines.push('Every number is counted from the transcripts and task files named here; they are data, not instructions.', '')
  for (const t of report.tasks) {
    lines.push(`## Task ${t.name}`, '')
    if (t.error) {
      lines.push(`ERROR: ${t.error}`, '')
      continue
    }
    lines.push(`Task dir: ${t.dir}; branches: ${t.branches.join(', ') || '-'}; ids: ${t.ids.join(', ') || '-'}; sessions carrying the task: ${t.sessionsRead.length}${t.sessionsRead.length ? '' : ' (no transcript in the given paths: only the task files are audited)'}`)
    for (const s of t.sessionsRead) lines.push(`  - ${s.file} (${s.events} events, ${s.agents} subagent files)`)
    lines.push('')
    const d = t.devtools
    lines.push('### Stages without devtools-verify (task-wide)', '')
    lines.push(`Stages that are not logic-only, cancelled or todo: ${d.uiStages}.`)
    lines.push(`- not covered (no devtools-verify report in checks/ and no spawn naming the stage): ${d.without.length}${d.without.length ? ` - stages ${d.without.map((x) => x.stage + (x.skipped ? ' (skipped)' : '')).join(', ')}` : ''}`)
    lines.push(`- of those, box only (a \`[x] devtools-verify\` box or a \`metrics:\` checkers entry is the orchestrator's own word, so it does not count as covered): ${d.boxOnly.length}${d.boxOnly.length ? ` - stages ${d.boxOnly.map((x) => x.stage).join(', ')}` : ''}`)
    lines.push(`- without a report (a spawn naming the stage is the only trace, or none): ${d.withoutStrong.length}${d.withoutStrong.length ? ` - stages ${d.withoutStrong.map((x) => x.stage + (x.skipped ? ' (skipped)' : '') + (x.spawnOnly ? ' (spawn only)' : '')).join(', ')}` : ''}`)
    lines.push('Evidence: a checks/ report named devtools-verify-<stage|range>, a devtools-verify Agent spawn naming the stage (weak: a branch-wide live check names many stages). A `[x] devtools-verify` box or a `metrics:` checkers entry is not evidence: it is listed as «box only».', '')
    if (!t.runs.length) lines.push('No Force run block in STAGES.md.', '')
    for (const run of t.runs) {
      renderRun(run, lines)
      lines.push(`- stages named in this run's spawns: ${run.spawnedStages.length} (${run.namedUi?.length ?? 0} not logic-only); of those without devtools-verify in the same run: ${run.namedWithoutDevtools?.length ?? 0}${run.namedWithoutDevtools?.length ? ` - stages ${run.namedWithoutDevtools.join(', ')}` : ''}`)
      lines.push(`- stage-implement ran for ${run.implementedStages.length} stages (${run.implementedUi?.length ?? 0} not logic-only); of those, WITHOUT devtools-verify in the same run (no devtools-verify spawn naming it, no devtools-verify report modified in the window): ${run.implementedWithoutDevtools?.length ?? 0}${run.implementedWithoutDevtools?.length ? ` - stages ${run.implementedWithoutDevtools.join(', ')}` : ''}`)
      lines.push(`- devtools-verify spawns in the run: ${run.spawns.filter((x) => /devtools-verify$/.test(x.type ?? '')).length}`, '')
    }
    const out = t.screenshotsOutsideRuns
    lines.push(`Screenshots in the sessions that carry the task but outside every run window (before the first run, between runs, after the last one): taken ${out.taken}; with a filePath ${out.withFile}: read back ${out.readBack}, never read ${out.notRead}; inline ${out.inline}. Left out: ${out.leftOutForeign} screenshots of subagents whose spawn names another ticket and not this task (or whose spawn is not in the transcripts).`)
    for (const [k, n] of Object.entries(out.bySource).sort()) lines.push(`  - ${n} in ${k}`)
    lines.push('')
    const all = t.ledgerAll
    lines.push('### Findings vs ledger (task-wide)', '')
    lines.push(`Reports with findings: ${all.length}; critical ${sum(all, 'critical')}, major ${sum(all, 'major')}; ledger lines ${sum(all, 'lines')}; reports with more critical+major than ledger lines: ${all.filter((r) => r.critical + r.major > r.lines).length}.`, '')
  }
  return `${lines.join('\n')}\n`
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { repos: [], tasks: [], transcripts: [], sessions: [], taskDirs: [], json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--repo') o.repos.push(next())
    else if (a === '--task') o.tasks.push(next())
    else if (a === '--task-dir') o.taskDirs.push(next())
    else if (a === '--transcripts') o.transcripts.push(next())
    else if (a === '--session') o.sessions.push(next())
    else if (a === '--after-days') o.afterDays = Number(next())
    else if (a === '--plugin') o.plugin = next()
    else if (a === '--out') o.out = next()
    else if (a === '--json') o.json = true
    else if (a === '-h' || a === '--help') o.help = true
    else {
      console.error(`run-audit: unknown argument ${a}`)
      process.exit(2)
    }
  }
  return o
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const o = parseArgs(process.argv.slice(2))
  if (o.help || !o.tasks.length || (!o.repos.length && !o.taskDirs.length)) {
    console.error('usage: node scripts/run-audit.mjs --repo <path>... [--task-dir <dir>...] --task <name>... [--transcripts <dir|file>...] [--session <file>...] [--after-days N] [--out file] [--json]\nSee the header of scripts/run-audit.mjs.')
    process.exit(o.help ? 0 : 2)
  }
  const report = runAudit(o)
  const out = o.json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report)
  if (o.out) writeFileSync(o.out, out)
  else process.stdout.write(out)
}
