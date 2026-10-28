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
 *    each missing one named in an open blocker by the fixed marker `[final: <report> — not run | stale]` (markers.mjs), not by prose.
 *
 * The rules apply only to the current branch's task and to a Force block opened after this version first saw the task: the day and the Force headings
 * recorded in the task snapshot at the 0.18 migration (`releaseGate`, `ruleAppliesToBlock`; D7: a run in progress keeps the rules it started with, whenever 0.18
 * is installed). A block without a readable date fails closed. The receipt `{sha, tree, reports, counts, skips, ...}` goes to `<plugin data>/receipts/<TICKET>.jsonl`.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { LEGIT_REASON, baselineInfo, blockerGate, blockerLines, findingCounts, fingerprint, lastForceBlock, newReports, openBlockers, readTaskFile, releaseGate, reportChecker, skipReasonAfter } from './journal-check.mjs'
import { OPEN_STATUS, patchIds, readDataFiles, taskLanguage } from './hooks/pipeline-state.mjs'
import { CLOSED_WORD, CONFIRMED_LINE, WITH_BLOCKERS, finalMarker, finalMarkerReports, headingDate, logicOnlyTag, ruleAppliesToBlock, blockerFieldApplies, stageBlocksOf } from './markers.mjs'

const UI_FILE = /\.(?:vue|tsx|jsx|svelte|css|scss|html)$/i
const NOT_UI = /\.(?:test|spec|stories|story)\.\w+$|(?:^|\/)(?:__tests__|__mocks__|mocks?|fixtures?)\//
export const uiFiles = (files) => files.filter((file) => UI_FILE.test(file) && !NOT_UI.test(file))

const DESIGN = ['figma-compare', 'proto-compare']
const WHOLE_BRANCH = /branch|whole|final|целик|ветк/i

/**
 * The Force block of the task when the rules apply to it: `{ date, start, block, stages }` (start — midnight of the run date, ms; with no readable date, of the day
 * the snapshot recorded; stages — the STAGES.md text), else null.
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
  return { date, start: Number.isFinite(start) ? start : 0, block, stages }
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
      // a tag in one of the live forms; a title that merely mentions "logic-only" does not waive the design report
      logicOnly: logicOnlyTag(heading),
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

/** git output as is: `status --porcelain` starts with a significant space. */
const gitRaw = (cwd, ...args) => {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return ''
  }
}
const git = (cwd, ...args) => gitRaw(cwd, ...args).trim()

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
  // A report that cannot be read (over the cap, a link out of the task) does not stand for its checker: journal-gate and the ledger rules name it.
  const window = newReports(taskDir, since + 1).map((name) => ({ name, text: readTaskFile(taskDir, 'checks', name) })).filter(({ text }) => text !== null)
  const reports = window.map(({ name }) => name)
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
  for (const { name, text } of window) {
    const found = findingCounts(text, name)
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
 * When HEAD's tree appeared on the branch. The branch's own reflog comes first: the run of its newest entries that carry this very tree.
 * An amend that keeps the tree is an entry with the same tree; a rebase sequence (`--force-rebase`, `-i` reword or fixup) is a single
 * `rebase (finish)` entry there, its `start` and `pick` steps go to HEAD's reflog only, so the walk compares the entry before it; a checkout away and back
 * leaves no entry. A fast-forward or a reset is an entry of its own, stamped when the branch moved: the committer date of an older commit (`%ct`) does not
 * make fresh reports look older than the tree. Only when the reflog gives nothing for this tree (no reflog) do the committer dates of the same-tree run
 * of commits and the branch's receipts for this tree stand in; with a reflog the receipts are not read: a receipt of an older commit (a `reset --hard`
 * onto it) would win the minimum over the reflog's later stamp. Any tree change counts, a docs-only commit too: in this plugin docs are the product.
 */
function treeSince(dataDir, worktree, ticket, branch) {
  const tree = git(worktree, 'rev-parse', 'HEAD^{tree}')
  if (!tree) return 0
  const times = []
  for (const line of git(worktree, 'log', '-g', '-n', '300', '--date=unix', '--format=%gd %T', `refs/heads/${branch}`).split('\n').filter(Boolean)) {
    const [selector, entryTree] = line.split(' ')
    if (entryTree !== tree) break
    const stamp = Number(/@\{(\d+)\}$/.exec(selector)?.[1])
    if (stamp) times.push(stamp * 1000)
  }
  if (!times.length) {
    for (const line of git(worktree, 'log', '-n', '300', '--format=%ct %T').split('\n').filter(Boolean)) {
      const [time, commitTree] = line.split(' ')
      if (commitTree !== tree) break
      times.push(Number(time) * 1000)
    }
    const receipts = readReceipts(dataDir, ticket).filter((receipt) => receipt.branch === branch)
    for (let index = receipts.length - 1; index >= 0 && receipts[index].tree === tree; index--) times.push(Date.parse(receipts[index].at) || Infinity)
  }
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
  // `-z`: `XY path`, NUL-terminated, unquoted; a rename or a copy is followed by its source path as a field of its own.
  const fields = gitRaw(worktree, 'status', '--porcelain', '-z', '--untracked-files=no').split('\0')
  const files = []
  for (let index = 0; index < fields.length; index++) {
    if (fields[index].length < 4) continue
    files.push(fields[index].slice(3))
    if (/[RC]/.test(fields[index].slice(0, 2))) index++
  }
  return files.filter((file) => !taskRel || !(file === taskRel || file.startsWith(`${taskRel}/`)))
}

/**
 * Closing a Force block as "completed": the whole-branch pro-review and task-converge reports must be newer than when HEAD's tree appeared
 * and the tracked files must have no uncommitted edits; "completed with blockers" — each missing one named in an open blocker by its marker
 * (`[final: pro-review — not run]`, markers.mjs). A blocker that names the checker in prose does not count: it gets the marker to add.
 * Only for a closing written after the snapshot, a block of the new rules' dates, the current task.
 */
export function finalReviewViolations(dataDir, worktree, taskDir) {
  const run = receiptRun(dataDir, taskDir)
  if (!run || !CLOSED_WORD.test(run.block.heading)) return []
  if (baselineInfo(dataDir, taskDir).lines.has(fingerprint(run.block.heading))) return []
  const branch = git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')
  const since = treeSince(dataDir, worktree, basename(taskDir), branch)
  if (!since) return []
  const dirty = dirtyTracked(worktree, taskDir)
  const wanted = [
    { checker: 'pro-review', match: (name) => reportChecker(name) === 'pro-review' && WHOLE_BRANCH.test(name), how: 'the `pro-review` agent in whole-branch mode, `checks/pro-review-branch.md`' },
    { checker: 'task-converge', match: (name) => reportChecker(name) === 'task-converge', how: 'the `task-converge` agent, `checks/task-converge.md`' },
  ].filter((item) => dirty.length || !newReports(taskDir, since).some((name) => item.match(name) && readTaskFile(taskDir, 'checks', name) !== null))
  const bGate = blockerGate(dataDir, taskDir)
  const blockers = openBlockers(run.block, bGate)
  const withBlockers = WITH_BLOCKERS.test(run.block.heading)
  const language = taskLanguage(run.stages)
  const fixedBlock = withBlockers && blockerFieldApplies(bGate, run.block.heading, run.block.body)
  const reason = dirty.length
    ? `tracked files have uncommitted edits (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''})`
    : `newer than the code last changed (the tree of HEAD appeared ${new Date(since).toISOString()}; a rewrite that keeps the tree does not count)`
  return wanted
    .filter((item) => !withBlockers || !blockers.some((line) => finalMarkerReports(line).has(item.checker)))
    .map((item) => {
      const marker = finalMarker(item.checker, newReports(taskDir, 0).some(item.match) ? 'stale' : 'missing', language)
      const prose = withBlockers ? blockers.find((line) => line.toLowerCase().includes(item.checker)) : undefined
      // The marker is there, but a lift word in the reason ("skipped per user decision 2026-10-20", "closed by the token limit") makes the line read as lifted.
      const lifted = withBlockers ? blockerLines(run.block, bGate).find((line) => !blockers.includes(line) && finalMarkerReports(line).has(item.checker)) : undefined
      return {
        rule: 'final-review',
        id: item.checker,
        message:
          `${item.checker}: no whole-task report ${reason} — "completed" needs it fresh. Run ${item.how} after the last fix; ` +
          `or close as "completed with blockers" with an open blocker that carries the marker \`${marker}\`, for example \`B<n> — ${marker} <why>\`.` +
          (lifted
            ? ` The blocker "${lifted.slice(0, 100)}" has a marker but reads as lifted (` +
              (fixedBlock
                ? 'it carries the lift field `Lifted:`, or its Russian form, with a date): if it is still open, remove that field.'
                : 'a word such as "closed", "lifted", "resolved", "user decision <date>" in its reason): if it is still open, drop the lift word from the reason.')
            : '') +
          (prose ? ` The blocker "${prose.slice(0, 100)}" names ${item.checker} in prose, and prose is not read: if it is about this report, add \`${marker}\` to it.` : ''),
      }
    })
}

/** For the run digest: the force commits of the run that changed UI and have no devtools-verify report. */
export const stagesWithoutRuntime = (dataDir, taskDir, sinceMs) => readReceipts(dataDir, basename(taskDir)).filter((receipt) => receipt.ui && !receipt.runtime && Date.parse(receipt.at) >= sinceMs)
export const hasReceipts = (dataDir, taskDir, sinceMs) => readReceipts(dataDir, basename(taskDir)).some((receipt) => Date.parse(receipt.at) >= sinceMs)
