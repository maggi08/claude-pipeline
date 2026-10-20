/**
 * Stage receipts (VT-1, stage 3) — proof that a force stage commit came with its checkers.
 *
 * `openLedgers` looks only at the reports that exist, so a stage with no reports passed the force commit: in announcement-details
 * 17 UI stages went in with zero devtools-verify, then a price ×100 bug reached the user. Two hard rules now stand at the force commit
 * (git-guard), one at the close (journal-gate), and every commit leaves a receipt that the run digest reads:
 *
 *  - the commit's window is the checker reports written after the previous force commit on this branch (its receipt) and after the
 *    Force block date; the window has no pro-review report → denied, naming the checker;
 *  - UI files changed (`.vue .tsx .jsx .svelte .css .scss .html`, not tests/stories/fixtures) and the window has neither a design report
 *    (figma-compare / proto-compare) nor a legitimate skip line in the stage's pipeline → denied; the same for devtools-verify.
 *    A `logic-only` stage needs no design report. A skip line is legitimate when its reason matches `LEGIT_REASON` (journal-check);
 *    a browser reason ("MCP busy", "no token") is not one;
 *  - a fix commit right after a stage commit (HEAD carries a receipt and the commit touches only files that commit touched) is a
 *    continuation: it needs no new reports, the stage's reports already stand behind those files. A commit that brings a new file, or
 *    follows a commit without a receipt, is a stage of its own (a catch-up stage included: it has its own window). Any pro-review report
 *    in the window counts, the whole-branch one too: the report name does not say which diff it covered, the window says when it was written;
 *  - closing a Force block as "completed" needs the whole-branch pro-review and task-converge reports newer than when HEAD's tree appeared
 *    (an amend or rebase that keeps the tree does not move it) and no uncommitted edits of tracked files; "completed with blockers" needs
 *    each missing one named in an open blocker that says it was not run / is missing / is stale.
 *
 * The rules apply only to the current branch's task and to a Force block opened after this version first saw the task: the day and the Force headings
 * recorded in the task snapshot at the 0.18 migration (`releaseGate`, `ruleAppliesToBlock`; D7: a run in progress keeps the rules it started with, whenever 0.18
 * is installed). A block without a readable date fails closed. The receipt `{sha, tree, reports, counts, skips, ...}` goes to `<plugin data>/receipts/<TICKET>.jsonl`.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { LEGIT_REASON, baselineInfo, findingCounts, fingerprint, lastForceBlock, newReports, openBlockers, readTaskFile, releaseGate, reportChecker, skipReasonAfter } from './journal-check.mjs'
import { OPEN_STATUS, patchIds, readDataFiles } from './hooks/pipeline-state.mjs'
import { CLOSED_WORD, CONFIRMED_LINE, WITH_BLOCKERS, headingDate, ruleAppliesToBlock, stageBlocksOf } from './markers.mjs'

const UI_FILE = /\.(?:vue|tsx|jsx|svelte|css|scss|html)$/i
const NOT_UI = /\.(?:test|spec|stories|story)\.\w+$|(?:^|\/)(?:__tests__|__mocks__|mocks?|fixtures?)\//
export const uiFiles = (files) => files.filter((file) => UI_FILE.test(file) && !NOT_UI.test(file))

const DESIGN = ['figma-compare', 'proto-compare']
const WHOLE_BRANCH = /branch|whole|final|целик|ветк/i

/**
 * The Force block of the task when the rules apply to it: `{ date, start, block }` (start — midnight of the run date, ms; with no readable date, of the day
 * the snapshot recorded), else null.
 */
function receiptRun(dataDir, taskDir) {
  const stages = readTaskFile(taskDir, 'STAGES.md')
  if (stages === null) return null
  const block = lastForceBlock(stages)
  if (!block) return null
  const confirmed = headingDate(block.body.split('\n').find((line) => CONFIRMED_LINE.test(line)) ?? '')
  const gate = releaseGate(dataDir, taskDir)
  if (!ruleAppliesToBlock(gate, block.heading, confirmed)) return null
  const date = headingDate(block.heading) ?? confirmed ?? gate.since ?? null
  const start = date ? new Date(`${date}T00:00:00`).getTime() : NaN
  return { date, start: Number.isFinite(start) ? start : 0, block }
}

const receiptsName = (ticket) => join('receipts', `${String(ticket).replace(/[^\w.-]/g, '_')}.jsonl`)

export function readReceipts(dataDir, ticket) {
  return readDataFiles(dataDir, receiptsName(ticket))
    .reverse()
    .flatMap((text) => text.split('\n'))
    .flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line)] : []
      } catch {
        return []
      }
    })
}

function appendReceipt(dataDir, ticket, receipt) {
  try {
    mkdirSync(join(dataDir, 'receipts'), { recursive: true })
    appendFileSync(join(dataDir, receiptsName(ticket)), `${JSON.stringify(receipt)}\n`)
  } catch {
    // no receipt — the digest just lacks this commit
  }
}

/** The stage(s) a commit now closes: in-progress ones, else done ones whose commit line is still open. `[{ heading, logicOnly, skips }]`. */
export function openStages(stagesText) {
  const parsed = stageBlocksOf(stagesText).map(({ block }) => {
    const heading = block.split('\n')[0]
    const skips = []
    for (const line of block.split('\n')) {
      const found = line.match(/^\s*[-*]\s*\[[ xX]\]\s*`?(figma-compare|proto-compare|devtools-verify)`?\b/i)
      if (!found) continue
      const reason = skipReasonAfter(line, found[0].length)
      if (reason !== null) skips.push({ checker: found[1].toLowerCase(), reason: reason.replace(/[`*()]/g, '').trim() })
    }
    const commitOpen = /^\s*[-*]\s*\[ \]\s*(?:commit|коммит)\b/im.test(block)
    return {
      heading: heading.replace(/^#+\s+/, '').trim(),
      active: /^in/i.test(OPEN_STATUS.exec(heading)?.[1] ?? ''),
      done: /\[status:\s*(?:done|ready)\b/i.test(heading),
      // the tag stands after the status bracket; a title that merely mentions "logic-only" does not waive the design report
      logicOnly: /\[status:[^\]]*\][^\n]*logic-only/i.test(heading),
      skips,
      commitOpen,
    }
  })
  const active = parsed.filter((stage) => stage.active)
  return active.length ? active : parsed.filter((stage) => stage.done && stage.commitOpen)
}

/** devtools-verify is a runtime check: only a stage with nothing visible may skip it. A missing mockup (a design-checker reason) is no reason. */
const RUNTIME_SKIP_REASON = /logic-only|no\s+visual|visuals?\s+(?:are\s+)?unchanged|без\s+визуал|визуал\w*\s+не\s+меня/i
const legitSkip = (skip) => (skip.checker === 'devtools-verify' ? RUNTIME_SKIP_REASON : LEGIT_REASON).test(skip.reason)

const skipDeclared = (stages, checkers) => stages.flatMap((stage) => stage.skips).filter((skip) => checkers.includes(skip.checker))

const git = (cwd, ...args) => {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).trim()
  } catch {
    return ''
  }
}

/** HEAD is the commit the receipt was written for, or its rewrite (amend, rebase, cherry-pick): the same sha, the same tree or the same patch-id. */
function isSameCommit(worktree, receipt, head) {
  if (receipt.sha === head) return true
  if (receipt.tree && receipt.tree === git(worktree, 'rev-parse', 'HEAD^{tree}')) return true
  return Boolean(receipt.patchId) && patchIds(worktree, [head]).get(head) === receipt.patchId
}

/**
 * The verdict for a force commit: the window, what it holds, and what is missing.
 * `changed` — the files of the commit (paths from the worktree root). `null` — the rules do not apply to this task.
 */
export function commitVerdict({ dataDir, taskDir, ticket, branch, worktree, changed }) {
  const run = receiptRun(dataDir, taskDir)
  if (!run) return null
  const last = readReceipts(dataDir, ticket).filter((receipt) => receipt.branch === branch).at(-1) ?? null
  const since = Math.max(run.start, last ? Date.parse(last.at) || 0 : 0)
  const reports = newReports(taskDir, since + 1)
  const has = (...checkers) => reports.some((name) => checkers.includes(reportChecker(name)))
  const stages = openStages(readTaskFile(taskDir, 'STAGES.md') ?? '')
  const ui = uiFiles(changed)
  const head = git(worktree, 'rev-parse', 'HEAD')
  const headFiles = last && isSameCommit(worktree, last, head) ? new Set(git(worktree, 'show', '--name-only', '--format=', '--no-renames', 'HEAD').split('\n').filter(Boolean)) : null
  const continuation = Boolean(headFiles) && changed.length > 0 && changed.every((file) => headFiles.has(file))

  const legit = (checkers) => skipDeclared(stages, checkers).filter(legitSkip)
  const missing = []
  if (!continuation) {
    if (!has('pro-review')) {
      missing.push(
        `no pro-review report in this commit's window (reports written after ${new Date(since).toISOString()}): run the \`pro-review\` agent in stage mode (/stage-check, Step 3) and save \`checks/pro-review-<N>.md\` with its findings outcome`,
      )
    }
    if (ui.length) {
      const shown = `${ui.slice(0, 4).join(', ')}${ui.length > 4 ? ` and ${ui.length - 4} more` : ''}`
      const logicOnly = stages.length > 0 && stages.every((stage) => stage.logicOnly)
      if (!has(...DESIGN) && !logicOnly && !legit(DESIGN).length) {
        missing.push(
          `UI files changed (${shown}) with no design report (figma-compare / proto-compare) in the window and no legitimate skip line: run the design checker of the repo, ` +
            'or mark the stage `logic-only`, or write `- [x] figma-compare (skip: logic-only | no design source)` in the stage pipeline. A browser, token or MCP reason is not a legitimate skip: this is a static comparison',
        )
      }
      if (!has('devtools-verify') && !legit(['devtools-verify']).length) {
        missing.push(
          `UI files changed (${shown}) with no devtools-verify report in the window and no legitimate skip line: run the \`devtools-verify\` agent (/stage-check, Step 3) and save \`checks/devtools-verify-<N>.md\`, ` +
            'or write `- [x] devtools-verify (skip: logic-only | no visual change)` in the stage pipeline with a real reason. "MCP busy", "no token", "[live: user-side]", "no design source" do not replace the run',
        )
      }
    }
  }
  const counts = { critical: 0, major: 0, minor: 0 }
  for (const name of reports) {
    const found = findingCounts(readTaskFile(taskDir, 'checks', name) ?? '', name)
    for (const key of Object.keys(counts)) counts[key] += found[key] ?? 0
  }
  return {
    since,
    reports,
    ui,
    continuation,
    // a continuation stands on the checks of the commit it continues: runtime and skips come from its receipt
    skips: continuation && last.skips ? last.skips : skipDeclared(stages, [...DESIGN, 'devtools-verify']).map((skip) => ({ ...skip, legit: legitSkip(skip) })),
    missing,
    stage: stages.map((stage) => stage.heading).join(' + ') || null,
    runtime: continuation && typeof last.runtime === 'boolean' ? last.runtime : !ui.length || has('devtools-verify'),
    counts,
  }
}

const pendingDir = (dataDir) => join(dataDir, 'receipts', 'pending')
const pendingPath = (dataDir, id) => join(pendingDir(dataDir), `${String(id).replace(/[^\w.-]/g, '_')}.json`)

/** The pre-hook writes the verdict; the post-hook turns it into a receipt if HEAD moved. */
export function savePending(dataDir, id, data) {
  try {
    mkdirSync(pendingDir(dataDir), { recursive: true })
    writeFileSync(pendingPath(dataDir, id), JSON.stringify(data))
    for (const name of readdirSync(pendingDir(dataDir))) {
      const old = join(pendingDir(dataDir), name)
      if (Date.now() - statSync(old).mtimeMs > 86_400_000) rmSync(old, { force: true })
    }
  } catch {
    // not saved — the commit just leaves no receipt
  }
}

/** PostToolUse of a force commit: HEAD moved since the pre-hook → append the receipt. Returns it, or null. */
export function finishPending(dataDir, id, worktree) {
  const path = pendingPath(dataDir, id)
  let pending
  try {
    pending = JSON.parse(readFileSync(path, 'utf8'))
    rmSync(path, { force: true })
  } catch {
    return null
  }
  const sha = git(worktree, 'rev-parse', 'HEAD')
  if (!sha || sha === pending.head) return null
  const receipt = {
    sha,
    tree: git(worktree, 'rev-parse', 'HEAD^{tree}'),
    patchId: patchIds(worktree, [sha]).get(sha) ?? null,
    at: new Date().toISOString(),
    branch: pending.branch,
    stage: pending.stage,
    reports: pending.reports,
    counts: pending.counts,
    skips: pending.skips,
    ui: pending.ui.length > 0,
    runtime: pending.runtime,
    continuation: pending.continuation,
    files: git(worktree, 'show', '--name-only', '--format=', '--no-renames', 'HEAD').split('\n').filter(Boolean).slice(0, 300),
  }
  appendReceipt(dataDir, pending.ticket, receipt)
  return receipt
}

/**
 * When HEAD's tree appeared: the oldest commit of the run of commits that carry this very tree (an amend or a rebase that keeps the tree
 * does not start a new run), or the oldest receipt of the branch for it when the commit that got it has been rewritten away.
 * Any tree change counts, a docs-only commit too: in this plugin docs are the product.
 */
function treeSince(dataDir, worktree, ticket, branch) {
  const tree = git(worktree, 'rev-parse', 'HEAD^{tree}')
  if (!tree) return 0
  const times = []
  for (const line of git(worktree, 'log', '-n', '300', '--format=%ct %T').split('\n').filter(Boolean)) {
    const [time, commitTree] = line.split(' ')
    if (commitTree !== tree) break
    times.push(Number(time) * 1000)
  }
  // A manual commit that was amended or rebased has no receipt: the HEAD reflog remembers when this tree first became HEAD's (fail-safe: no reflog, no change).
  const reflog = git(worktree, 'log', '-g', '-n', '300', '--date=unix', '--format=%gd %T', 'HEAD').split('\n').filter(Boolean)
  for (const line of reflog) {
    const [selector, reflogTree] = line.split(' ')
    if (reflogTree !== tree) break
    const stamp = Number(/@\{(\d+)\}/.exec(selector)?.[1])
    if (stamp) times.push(stamp * 1000)
  }
  const receipts = readReceipts(dataDir, ticket).filter((receipt) => receipt.branch === branch)
  for (let index = receipts.length - 1; index >= 0 && receipts[index].tree === tree; index--) times.push(Date.parse(receipts[index].at) || Infinity)
  return times.length ? Math.min(...times) : 0
}

/** Tracked files with uncommitted edits outside the task directory (the journal and the reports change all the time and are not the code). */
function dirtyTracked(worktree, taskDir) {
  let taskRel = null
  try {
    taskRel = relative(realpathSync(git(worktree, 'rev-parse', '--show-toplevel')), realpathSync(taskDir)).split(sep).join('/')
  } catch {
    // task directory outside the repo: nothing to exclude
  }
  return git(worktree, 'status', '--porcelain', '--untracked-files=no')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).split(' -> ').at(-1).replace(/^"|"$/g, ''))
    .filter((file) => !taskRel || !(file === taskRel || file.startsWith(`${taskRel}/`)))
}

// An open blocker counts for a missing review only when the phrase is bound to the report: the checker name followed within ~40 characters
// by "not run" / "report missing" / "stale report" (English and Russian). A bare "missing" or "not fixed" elsewhere in the line does not count.
const NOT_RUN_EN = "(?:(?:was|has|had)\\s+not\\s+(?:been\\s+)?run|not\\s+(?:been\\s+)?run|did\\s*n[o']t\\s+run|was(?:n't)\\s+run|never\\s+ran|report\\s+(?:is\\s+)?(?:missing|stale|outdated|absent)|(?:missing|stale|outdated)\\s+report|no\\s+report|"
const NOT_RUN_RU = 'не\\s+(?:запускал|запущ|прогонял|прогнан|проводил)[а-яё]*|не\\s+выполн[а-яё]*|отчёт[а-яё]*\\s+(?:отсутств|устарел|нет)[а-яё]*|нет\\s+отчёта|отсутству[а-яё]*\\s+отчёт|устарев[а-яё]*\\s+отчёт|отчёт\\s+не\\s+свеж[а-яё]*'
const NOT_RUN_PHRASE = `${NOT_RUN_EN}${NOT_RUN_RU})`
const notRunFor = (line, checker) => new RegExp(`${checker}[^\\n]{0,40}?${NOT_RUN_PHRASE}`, 'i').test(line)

/**
 * Closing a Force block as "completed": the whole-branch pro-review and task-converge reports must be newer than when HEAD's tree appeared
 * and the tracked files must have no uncommitted edits; "completed with blockers" — each missing one named in an open blocker together with
 * "not run" / "missing" / "stale". Only for a closing written after the snapshot, a block of the new rules' dates, the current task.
 */
export function finalReviewViolations(dataDir, worktree, taskDir) {
  const run = receiptRun(dataDir, taskDir)
  if (!run || !CLOSED_WORD.test(run.block.heading)) return []
  if (baselineInfo(dataDir, taskDir).lines.has(fingerprint(run.block.heading))) return []
  const branch = git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')
  const since = treeSince(dataDir, worktree, basename(taskDir), branch)
  if (!since) return []
  const dirty = dirtyTracked(worktree, taskDir)
  const fresh = (match) => !dirty.length && newReports(taskDir, since).some(match)
  const wanted = [
    { checker: 'pro-review', ok: fresh((name) => reportChecker(name) === 'pro-review' && WHOLE_BRANCH.test(name)), how: 'the `pro-review` agent in whole-branch mode, `checks/pro-review-branch.md`' },
    { checker: 'task-converge', ok: fresh((name) => reportChecker(name) === 'task-converge'), how: 'the `task-converge` agent, `checks/task-converge.md`' },
  ].filter((item) => !item.ok)
  const blockers = openBlockers(run.block.body).map((line) => line.toLowerCase())
  const withBlockers = WITH_BLOCKERS.test(run.block.heading)
  const reason = dirty.length
    ? `tracked files have uncommitted edits (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''})`
    : `newer than the code last changed (the tree of HEAD appeared ${new Date(since).toISOString()}; a rewrite that keeps the tree does not count)`
  return wanted
    .filter((item) => !withBlockers || !blockers.some((line) => notRunFor(line, item.checker)))
    .map((item) => ({
      rule: 'final-review',
      id: item.checker,
      message:
        `${item.checker}: no whole-task report ${reason} — "completed" needs it fresh. Run ${item.how} after the last fix; ` +
        `or close as "completed with blockers" and write an open blocker B<n> that names ${item.checker} and says it was not run / is missing / is stale.`,
    }))
}

/** For the run digest: the force commits of the run that changed UI and have no devtools-verify report. */
export const stagesWithoutRuntime = (dataDir, taskDir, sinceMs) => readReceipts(dataDir, basename(taskDir)).filter((receipt) => receipt.ui && !receipt.runtime && Date.parse(receipt.at) >= sinceMs)
export const hasReceipts = (dataDir, taskDir, sinceMs) => readReceipts(dataDir, basename(taskDir)).some((receipt) => Date.parse(receipt.at) >= sinceMs)
