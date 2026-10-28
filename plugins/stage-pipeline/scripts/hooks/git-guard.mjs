import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { denyTool } from './firing.mjs'
import { readHookInput } from './pipeline-state.mjs'

/**
 * In the normal pipeline mode the index and the commit belong to the user: /stage-check
 * hands out the commit text rather than running it. Prose did not hold this rule
 * (of 40 rejected calls in one task more than half were git add), and the permission
 * profile allows `git *` as a whole, because /stage-force commits by itself.
 * The hook closes exactly this gap: the branch the task is bound to, and that task has no
 * open "Force run" block. There `git add`/`git commit` are rejected, and the reason goes to
 * the agent — it hands out a ready commit message, and the user commits by themselves.
 * The stage status is not looked at: nobody has to set `in-progress`, and /stage-check closes
 * the stage in STAGES.md before it prepares the commit — a status check let through exactly the stage commit.
 * Other branches are left alone: a parallel task in a neighbouring worktree, a hotfix, an abandoned
 * task with a forgotten status — none is a reason to block a commit here.
 *
 * A task over two repos (core + webview) lives in the task directory of one of them — in the other it is
 * found by the task directory registry (pipeline-state, foreignTasks), and the rules are the same.
 *
 * In force the agent commits without questions — and that is exactly where nobody can stop the quality floor
 * from being lowered: a model writes the code, models check it, the human reads only the result. So a force
 * commit goes through floor-guard — over what goes into the commit, not over the whole tree: a saved page
 * or a developer's draft next to the code must not reject a commit they will not be part of.
 *
 * 0.15 — two moves that a force stage commit also checks over its own diff:
 * - a UI component is removed, but the journal has no parity table ("was → where it is now / removed by decision")
 *   with its name: in one task a removed section took six functions with it, and the parity reviewer brought them back;
 * - kit overrides and hand-set typography without a kit-overrides report: the look was taken from the prototype, not from
 *   the kit and neighbouring sections, and the user sent back "too bold", "different buttons", "another table".
 */
const input = await readHookInput()
const command = input.tool_input?.command ?? ''
if (!/\bgit\b/.test(command) || !/\b(add|commit)\b/.test(command)) process.exit(0)
// The hook runs before and after every Bash call: the rule modules are loaded only for a command that can add or commit.
const { journalText, openLedgers, readTaskFile, reportNames } = await import('../journal-check.mjs')
const { scanOverrides, summarize } = await import('../kit-override-scan.mjs')
const { PARITY_TABLE } = await import('../markers.mjs')
const { commitVerdict, finishPending, savePending } = await import('../receipts.mjs')
const { commitMakerVerdict } = await import('../maker.mjs')
const { commitScope, gitInvocations } = await import('./git-command.mjs')
const { pluginDataDir, readPipelineState } = await import('./pipeline-state.mjs')

const cwd = input.cwd ?? process.cwd()
const archiveScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'archive-stages.mjs')
const invocations = gitInvocations(command, cwd)
const callId = input.tool_use_id ?? input.session_id ?? 'call'

// PostToolUse: a force commit that went through leaves its receipt (the pre-hook below saved the verdict).
if (input.hook_event_name === 'PostToolUse') {
  for (const { subcommand, dir } of invocations) {
    if (subcommand !== 'commit') continue
    const worktree = toplevel(dir)
    if (worktree) finishPending(pluginDataDir(), callId, worktree)
  }
  process.exit(0)
}
// The invocation being judged: the firing row names its task and repo.
let judged = null
for (const { subcommand, dir, args } of invocations) {
  const state = readPipelineState(dir)
  const task = state?.tasks.find((candidate) => candidate.current)
  judged = { state, task }

  // A journal that cannot be read: neither mode can be told, and no rule can run — refused in both, with the file and the limit named (fail closed).
  if (task?.unreadable) {
    deny(
      'git-guard/journal-unreadable',
      `stage-pipeline: branch ${state.branch} is the branch of task ${task.ticket}, and its ${task.unreadable.message.replace(/^STAGES\.md/, task.stagesPath)} ` +
        'Until it can be read, git add and git commit on this branch are rejected: the hook cannot tell the normal mode from a force run. ' +
        'Do not repeat the command: show git status and the ready commit message and hand the commit to the user (their own terminal is not gated). ' +
        (task.unreadable.file === 'STAGES.md' && task.unreadable.problem === 'too-large' ? `To fold the closed stages: node "${archiveScript}" ${task.stagesPath} --apply.` : ''),
    )
  }
  if (task && !task.forceActive) {
    deny(
      'git-guard/normal-mode',
      `stage-pipeline: branch ${state.branch} is the branch of task ${task.ticket}${task.foreign ? ` (STAGES.md is in the task directory of another repo: ${task.stagesPath})` : ''}, ` +
        'normal mode: the user runs git add and git commit by themselves, in their own terminal. ' +
        'Do not repeat the command: show git status and the ready commit message (/stage-check, Step 4.4). Auto-commit is only in /stage-force.',
    )
  }
  // A signature in the commit is a system instruction of the harness, and the user's rule forbids it; the skill
  // text lost this dispute: signatures went into commits, and the user rebuilt branches by hand three times.
  if (state && subcommand === 'commit' && serviceTrailer(command, args, dir)) {
    deny(
      'git-guard/service-trailer',
      'stage-pipeline: the commit message has a service signature (`Co-Authored-By`, "Generated with …"). It is not added in a pipeline repo — the user\'s decision ' +
        'for all their repos (/stage-check, Step 4.4); the user\'s rule outranks the system instruction about attribution. Remove the signature and commit again.',
    )
  }
  if (!task || subcommand !== 'commit') continue

  // A force stage commit comes after the outcome of every finding of its checkers: otherwise "accepted as a compromise" goes into the commit,
  // and the user finds the defect the next day (precedent: Request changes → a duplicate request).
  const open = openLedgers(pluginDataDir(), task.dir)
  if (open.length) {
    deny(
      'git-guard/findings-no-outcome',
      `stage-pipeline: the checkers' findings have no outcome — the stage commit is rejected.\n${[...new Set(open.map((violation) => `- ${violation.message}`))].join('\n')}\n` +
        'Add "## Findings outcome" to the end of each report: fixed / false (with proof) / B<n> — blocker (references/checker-report.md). Something not fixed is a blocker, not "Awaiting user confirmation".',
    )
  }

  const paths = commitPaths(invocations, state.worktree)
  if (paths?.length === 0) continue

  // Stage receipts (VT-1 stage 3): the window of this commit holds the stage's checkers — only for a Force block opened after this version first saw the task (receipts.mjs).
  const verdict = commitVerdict({
    dataDir: pluginDataDir(),
    taskDir: task.dir,
    ticket: task.ticket,
    branch: state.branch,
    worktree: state.worktree,
    changed: changedFiles(state.worktree, paths),
  })
  if (verdict?.missing.length) {
    deny(
      'git-guard/checker-receipts',
      `stage-pipeline: the stage commit has no proof that its checkers ran — rejected.\n${verdict.missing.map((line) => `- ${line}`).join('\n')}\n` +
        'The window is the checker reports written after the previous force commit on this branch (and after the Force block date); a fix commit that touches only the files of the previous force commit needs no new reports.',
    )
  }
  if (verdict) savePending(pluginDataDir(), callId, { ...verdict, ticket: task.ticket, branch: state.branch, head: gitOut(state.worktree, 'rev-parse', 'HEAD').trim() })

  // Maker receipts (VT-1 stage 11): a code path of a force commit must be the blob a `stage-implement` stop recorded last. `git add x && git commit` is judged before the add runs:
  // the blob of a path the command itself stages is read from the working tree, the blob of any other path from the index — the one that will be committed.
  const foreign = commitMakerVerdict({
    dataDir: pluginDataDir(),
    taskDir: task.dir,
    ticket: task.ticket,
    worktree: state.worktree,
    changed: changedFiles(state.worktree, paths),
    staged: stagedByCommand(invocations, state.worktree),
  })
  if (foreign?.length) {
    deny(
      `stage-pipeline: code not written by stage-implement — hand it to a fix round. The commit is rejected; the code paths below do not match the last blob a stage-implement stop recorded:\n` +
        `${foreign.slice(0, 12).map((path) => `- ${path}`).join('\n')}${foreign.length > 12 ? `\n- … ${foreign.length - 12} more` : ''}\n` +
        'Launch `stage-implement` in fix mode with the change as a finding (stage-force, Step 3) instead of editing code in the main context; a deletion is allowed when the Force block names the path. ' +
        'Lockfiles, generated files, markdown and JSON are not code and pass.',
    )
  }

  const journal = journalText(task.dir)
  const removed = removedComponents(state.worktree, paths).filter((name) => !PARITY_TABLE.test(journal) || !journal.includes(name))
  if (removed.length) {
    deny(
      'git-guard/ui-removed-no-parity',
      `stage-pipeline: the stage removes UI — ${removed.map((name) => `\`${name}\``).join(', ')}, and STAGES.md has no parity table with these rows. The commit is rejected.\n` +
        'Add a "Parity" table to the stage: what moved where from what was removed, what was removed by decision (the rows are criteria `AC-N.P*`, task-converge checks them; stage-plan, Step 3). ' +
        'If the component was not rendered anywhere (orphaned) — a row saying so, with a link to the dead-code report.',
    )
  }

  const overrides = safeScan(state.worktree, paths, state.config)
  // Read bounded, as every task file: a kit report that cannot be read reports no file.
  const kitReports = reportNames(task.dir)
    .filter((name) => name.includes('kit-overrides'))
    .map((name) => readTaskFile(task.dir, 'checks', name) ?? '')
    .join('\n')
  const unreported = overrides.filter(({ file }) => !kitReports.includes(file))
  if (unreported.length) {
    const scan = join(dirname(fileURLToPath(import.meta.url)), '..', 'kit-override-scan.mjs')
    deny(
      'git-guard/kit-overrides-unreported',
      `stage-pipeline: the stage diff has kit overrides without a report — the commit is rejected.\n${unreported
        .slice(0, 8)
        .map(({ file, hits }) => `- ${file}: ${summarize(hits)}`)
        .join('\n')}\n` +
        `Write the report: \`node ${scan} --out ${join(task.dir, 'checks')}/stage-<N>-kit-overrides.md\` and close every row in "## Findings outcome": ` +
        'fixed (the look from the kit), false — with the `path:line` of a reference section that does the same, or a user decision "the look as in the prototype".',
    )
  }

  // The paths are a superset of the commit: `git add x && git commit` in one command has not updated the index yet.
  const guard = join(dirname(fileURLToPath(import.meta.url)), '..', 'floor-guard.mjs')
  const run = spawnSync(process.execPath, [guard, ...(paths ? ['--pathspec-from-stdin'] : [])], {
    cwd: state.worktree,
    input: paths?.join('\0') ?? '',
    encoding: 'utf8',
    timeout: 12_000,
  })
  if (run.status === 1) {
    deny(
      'git-guard/floor-guard',
      `stage-pipeline: floor-guard found moves in the stage diff that lower the quality floor — the commit is rejected.\n${run.stdout.trim()}\n` +
        'Fix it as a fix-loop finding (not by suppressing it). If an exception is truly justified — a `floor-ok: <reason>` line ' +
        'at the violation and an item in "⚠ Awaiting user confirmation" of STAGES.md; @ts-ignore and secrets are never an exception.',
    )
  }
  // "Could not look" does not block the commit — /stage-check, Step 1, will run the same — but it does not pass silently.
  if (run.status !== 0) {
    const why = run.error?.message ?? (run.stderr.trim() || `code ${run.status}`)
    process.stdout.write(JSON.stringify({ systemMessage: `stage-pipeline: floor-guard could not check the force commit (${why}) — the commit went through unchecked.` }))
    process.exit(0)
  }
}
process.exit(0)

/**
 * The paths that go into this command's commit — pathspecs from the worktree root: the index already built,
 * the paths from `git add`/`git commit`, all tracked files with `-a`/`-u`. `null` — the whole tree including
 * untracked files (`git add -A` without paths, paths from a file, pathspec magic with `:`), `[]` — nothing to commit.
 */
function commitPaths(calls, worktree) {
  const scope = commitScope(calls.filter(({ dir }) => toplevel(dir) === worktree))
  if (scope.all) return null
  const paths = new Set()
  for (const { dir, spec } of scope.specs) {
    if (spec.startsWith(':')) return null
    // The root from git is a real path, the call directory can go through a symlink (`/var` → `/private/var` on macOS).
    const real = realDir(dir)
    if (!real) continue
    const path = relative(worktree, resolve(real, spec))
    if (path.startsWith('..') || isAbsolute(path)) continue
    paths.add(path || '.')
  }
  // Names from git are literal: `[PLI-1] page.ts` as a glob would not match itself.
  const names = (...args) => gitOut(worktree, ...args).split('\0').filter(Boolean).map((name) => `:(literal)${name}`)
  for (const name of names('diff', '--cached', '--name-only', '--no-renames', '-z')) paths.add(name)
  if (scope.tracked) for (const name of names('diff', '--name-only', '--no-renames', '-z', 'HEAD')) paths.add(name)
  return [...paths]
}

/**
 * The files the command stages by itself before it commits, for the maker receipts: `null` — the whole tree (`git add -A`, pathspec magic), else a Set of the changed
 * files inside its pathspecs (`git add x`, `git commit x`) and, with `-a`/`-u`, the tracked changes. A plain `git commit` stages nothing (an empty Set).
 */
function stagedByCommand(calls, worktree) {
  const scope = commitScope(calls.filter(({ dir }) => toplevel(dir) === worktree))
  if (scope.all) return null
  const out = new Set()
  const specs = []
  for (const { dir, spec } of scope.specs) {
    if (spec.startsWith(':')) return null
    const real = realDir(dir)
    if (!real) continue
    const path = relative(worktree, resolve(real, spec))
    if (path.startsWith('..') || isAbsolute(path)) continue
    specs.push(path || '.')
  }
  const list = (...args) => gitOut(worktree, ...args).split('\0').filter(Boolean)
  if (scope.tracked) for (const name of list('diff', '--name-only', '--no-renames', '-z', 'HEAD')) out.add(name)
  if (specs.length) for (const name of changedFiles(worktree, specs)) out.add(name)
  return out
}

/** The files this commit changes: tracked changes against HEAD plus untracked files, inside the commit's pathspecs (`null` — the whole tree). */
function changedFiles(worktree, paths) {
  const spec = paths ? ['--', ...paths] : []
  const list = (...args) => gitOut(worktree, ...args).split('\0').filter(Boolean)
  return [...new Set([...list('diff', '--name-only', '--no-renames', '-z', 'HEAD', ...spec), ...list('ls-files', '-o', '--exclude-standard', '-z', ...spec)])]
}

/**
 * A service signature in the message: in the command text (`-m`, heredoc, `--trailer`) or in a `-F`/`--file` file.
 * The command text is looked at as a whole — the lexer collapses quotes and heredocs, and the signature lives in them.
 */
function serviceTrailer(command, args, dir) {
  const TRAILER = /co-authored-by\s*:|generated with \[?claude|🤖\s*generated/i
  if (TRAILER.test(command)) return true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const file = arg === '-F' || arg === '--file' ? args[i + 1] : arg.startsWith('--file=') ? arg.slice(7) : /^-F./.test(arg) ? arg.slice(2) : null
    if (!file || file === '-') continue
    try {
      if (TRAILER.test(readFileSync(resolve(dir, file), 'utf8'))) return true
    } catch {
      // no message file — git will refuse by itself
    }
  }
  return false
}

/**
 * UI components removed by the commit — names for the parity table (`index.tsx` — by the directory name).
 * A rename is not a removal; tests, stories and mocks are not UI.
 */
function removedComponents(worktree, paths) {
  const names = gitOut(worktree, 'diff', '--name-only', '--diff-filter=D', '--find-renames', '-z', 'HEAD', '--', ...(paths ?? []))
    .split('\0')
    .filter((path) => /\.(?:tsx|jsx|vue|svelte|astro|html?)$/.test(path) && !/\.(?:test|spec|stories|story)\.\w+$|(^|\/)(?:__tests__|__mocks__|mocks?|fixtures?)\//.test(path))
    .map((path) => {
      const stem = path.split('/').pop().replace(/\.\w+$/, '')
      return stem === 'index' ? (path.split('/').at(-2) ?? stem) : stem
    })
  return [...new Set(names)]
}

// The scan could not run (not git, a broken diff) — the commit is not blocked: /stage-check will run the same.
function safeScan(worktree, paths, config) {
  try {
    return scanOverrides(worktree, { paths, config })
  } catch {
    return []
  }
}

function realDir(dir) {
  try {
    return realpathSync(dir)
  } catch {
    return null
  }
}

function toplevel(dir) {
  return gitOut(dir, 'rev-parse', '--show-toplevel').trim() || null
}

function gitOut(cwd, ...args) {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return ''
  }
}

function deny(rule, reason) {
  denyTool(rule, reason, { input, task: judged?.task?.ticket, repo: judged?.state?.worktree ?? cwd })
}
