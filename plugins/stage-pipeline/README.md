# stage-pipeline

A staged workflow for large tasks with a multi-screen design (redesigns, big features): maker/checker with a clean context for the checkers, state kept in files, context hygiene.

Skills and agents come with the plugin and work in any repository; project specifics live in `<repo>/.claude/pipeline.config.md`, which `/pipeline-init` generates.

## Language

- The plugin is written in English: skills, agents, references, scripts and hook messages.
- The language of a task is the line `Language:` in the STAGES.md header. A new task gets it by the user's request, else by `language:` in `pipeline.config.md`, else by the language of the message that started the task.
- Only `ru` and `en` are supported. Russian tasks keep going in Russian as before; hooks and scripts read both languages.
- In chat the model talks to you in your language, whatever the task language is. Commits and PR descriptions follow the language of the repo history (or your request), not the task language.
- Details and the table of service markers: [references/language.md](references/language.md).

## Installation

```bash
claude plugin marketplace add maggi08/claude-pipeline
claude plugin install stage-pipeline@magzhan
```

Without `--scope` it goes into `~/.claude/settings.json` and is enabled in all repositories. If you need it in one repository only, use the same commands with `--scope project`. After the installation, restart Claude Code.

The repository is public — no access rights and no cloning needed. The "marketplace from a local clone" variant (for the machine where the plugin is edited) is in the [marketplace README](../../README.md).

The plugin brings its own MCP servers `figma` (Dev Mode from desktop Figma) and `chrome-devtools` — there is no need to connect them by hand, but Figma desktop must be running with **Enable Dev Mode MCP Server** turned on. Third-party library APIs are checked not by an external service but against the installed package (the types and CHANGELOG in `node_modules` for the version from the lockfile) — no keys and no authorization needed. Environment check: `/pipeline-doctor`.

### Permissions

So that the checkers do not ask for confirmation at every step, the plugin has a ready permission profile (`permissions/base.json`) and a script that merges it into settings:

```bash
PERMS=$(ls -d ~/.claude/plugins/cache/*/stage-pipeline/*/scripts/permissions.mjs | sort -V | tail -1)
node "$PERMS"           # what would be added (writes nothing)
node "$PERMS" --apply   # append to ~/.claude/settings.json
```

(from a Claude Code session the path is shorter — `${CLAUDE_PLUGIN_ROOT}/scripts/permissions.mjs`; the plugin cache is versioned, so in a shell we take the latest version)

The `Skill(stage-pipeline:*)` and `mcp__*` entries are generated from the plugin itself, so a new skill shows up in the permissions on its own. The script only adds what is missing: it does not touch other people's entries, does not put an `allow` over `deny`/`ask` entries already in place (it reports a conflict and counts such an entry as missing — `--check` returns 1 on it), and makes a backup before writing. The profile also carries the prohibitions that `/stage-force` stands on: `push`/`reset --hard`/`clean`/`gh`/`glab`/`pkill` and reading `.env` go to `ask`; force-push, publishing and deploy go to `deny`. If you do not need a broad Bash allowlist, `--minimal` allows only skills and MCP. Paths of neighbouring repositories go separately, into the project scope: `--scope project --apply --dirs ../ui-lib,../prototypes`.

The `deny` list in the profile protects against an accidental agent command; it is not a security boundary: the profile allows `node`/`npx`/`python3`, that is, arbitrary execution, and getting around any prohibition from it is trivial. Whoever needs a real boundary needs a sandbox, not an allowlist.

`/pipeline-init` does the same when it initializes a project (showing the list and asking for confirmation), and `/pipeline-doctor` checks it through `--check`.

Check the environment: `/pipeline-doctor`.

### Hooks

They work only in a repository with `.claude/pipeline.config.md` and stay silent elsewhere, and they look only at the task of the current branch — by the line ``Branch: `<branch>` `` in the STAGES.md header, and without it by the ticket in the branch name. The hook does not see the tasks of other branches: parallel tasks, worktrees and sessions do not get in each other's way, and old abandoned tasks block nothing (a `STAGES.md` that has not changed for 21 days is invisible to the hook).

A task spanning two repositories (core + webview) lives in the task directory of one of them. In the second repository the hooks find it through the registry of task directories (session-start fills it), if the ticket (`ABC-12`) is in the branch name and STAGES.md names this repository.

- **session-start** — at the start of a session puts into the context a status line for the task of the current branch and reminds you to shrink a STAGES.md larger than 40 KB. After a closed force run it names the commits that the journal does not know by SHA, by title or by content (a commit rebuilt without a signature counts as the same one; a commit that names the ticket in its title is no exception after the close — only its SHA or patch-id in the journal clears it, a PR squash "(#17)" is skipped, and so is a `Revert "…"`; this applies only to force runs opened after the plugin (0.18 or later) first saw the task — the day and the runs already there, dated before that day, are recorded in the task snapshot, so a run already going or closed then keeps the old behaviour): on all branches of the task (from the header and with the ticket in the name; squash-merged ones are skipped) and, in the integration branch, during the first 14 days after closing — your commits in the task files under another ticket. This is work done past the checkers; it is run through a catch-up stage. For a recently closed task of another branch such a line arrives once. A task whose STAGES.md cannot be read is listed with the reason instead of its status.
- **git-guard** — on a task branch in normal mode the agent's `git add`/`git commit` are rejected at any stage status: the agent hands over a ready commit message and you commit yourself. In force mode (an unclosed "Force run" block in STAGES.md — without "completed" in the heading) the agent runs `git add` + `git commit` itself, without asking — but the commit goes through `floor-guard` and is rejected if the diff has a silenced checker, a weakened test or a leftover stub. What is checked is what will go into the commit: the index, the paths from the `git add` of the same command, all tracked files with `-a`, the whole tree only with `git add -A` without paths. A force commit is also rejected when a checker finding has no outcome — "## Findings outcome" in the report (`references/checker-report.md`); when the commit deletes a UI component whose name is not in the Parity table of STAGES.md; when the diff has kit overrides (`font-bold`, `uppercase`, `text-[…]`, `rounded-[…]`, `!important`…) and there is no `kit-overrides` report with these files. A force commit in a run opened after the plugin (0.18 or later) first saw the task (the day and the runs already there, dated before that day, are recorded in the task snapshot; a heading dated that day or whose date does not parse counts as new) is also rejected when its window (the reports written after the previous force commit on the branch) has no `pro-review` report, or when UI files changed (`.vue .tsx .jsx .svelte .css .scss .html`) and there is no design report (not needed on a `logic-only` stage; a skip line with `logic-only`, no design source or no visual change stands in for it) or no `devtools-verify` report and no skip line with a runtime reason (`logic-only`, no visual change — a browser, MCP, login or stand reason is not one); a fix commit that touches only the files of the previous force commit passes. Each force commit leaves a receipt in the plugin data (`receipts/<TICKET>.jsonl`: sha, tree, reports, counts, skips); the full run digest lists the UI stages committed without a runtime check, the short one shows the count. A commit with a service signature (`Co-Authored-By`, "Generated with …") is rejected on any branch of a repository with the pipeline. On the branch of a task whose STAGES.md cannot be read (see "Task files" below) `git add` and `git commit` are rejected in either mode, with the file and the reason named.
- **agent-guard** — before a subagent starts. A whole-branch `pro-review` without `model` equal to `review_model` from the config (`opus` by default) is rejected. `stage-implement` does not start in a force run until its block has the line `Confirmed: <date> — interview answers` (stage-force, Step 0; no separate "yes" is asked after the interview); blocks opened before 0.12 are not touched.
- **force-guard** — before a Bash command in a force run. A call that would stop on a confirmation is rejected at once, with an explanation, instead of waiting until you come back to the terminal. These are `pkill`/`killall` (the agent stops its process by PID) and subcommands under `ask` in the user and project settings (`git push`, `reset --hard`, `gh`…), which the agent records as run blockers. Outside force the hook is silent: you are nearby there, and a question is a normal part of the work.
- **journal-gate** — after an edit of STAGES.md or of a report in `checks/`. For a Bash call it acts only when STAGES.md or a report changed during the call (a `cat`, `ls`, `grep`, `sed -n` or `run-digest` of the journal stays silent); a PreToolUse run of the same script stamps the files of the current branch's tasks and of the tasks the command names by path before the call. Before an Edit or Write of a task file a PreToolUse run takes the task snapshot when there is none yet, so the first look reads the journal before the edit. Outside a pipeline repo both runs leave at once (a file-system check, no git). Returns violations to the agent in the same turn:
  - in the journal: a criterion tagged `devtools-verify`/`figma-compare`/`proto-compare` is closed ✅ while the outcome names another checker or nobody; a design checker is skipped for a browser reason; ✅ with a caveat ("not captured", "code only"); "not verified, no data" instead of staging the state; "like X" in a criterion or a decision without `path:line` of X; a checker marked `[x]` while the outcome of its findings is incomplete;
  - in a new journal line or a report written after 0.18 (with or without an `AC-*` id): every unquoted bare `[live: user-side]` — the honest form is `[live: user-side — <prerequisite>; <route> → <observed>]`; a mention in backticks is a quote, older lines and reports are not touched;
  - in a report written after 0.18.0, a `false` outcome without a proof of its own kind ("the fix is impossible", "not reproduced" without two attempts and the route, "the stage did not change it" without a base sha, a plan line for "a later stage owns it", the report itself as the basis, a sample for "false for the data", "not related" without a diff), and a critical dismissed as `false` without a cited fresh report on `review_model` in `checks/`;
  - in the journal, a new line of "Awaiting user confirmation" or under `Assumptions:` of a Force block without `Rollback: <cost>` and `Basis: <path:line | node-id | quote | guess>`; the digest lists them by rollback cost;
  - in a report: PASS without a measurement; no line `Findings: critical N · major N · minor N`; an outcome "leaving it", "awaiting", "long-standing" without a check on the base; for devtools-verify — no `geometry` lines, for a stage with a "Visual reference" — no `style-diff` lines, and in a report written after 0.18 no `doctor:` line (what verify-doctor printed) or no `auth:` line (whether the browser was logged in; the Russian keys are in `references/language.md`);
  - closing a "Force run" block as "completed" while blockers are open, findings have no outcome, the CI gate on the current HEAD is not green (a `skip:` line of the Force block covers a gate that cannot run here, never one that ran red on HEAD), or (runs opened after 0.18 first saw the task) the whole-branch `pro-review` or `task-converge` report is missing or older than the last commit that changed the tree; "completed with blockers" — if every non-green gate is named a blocker, and every missing or stale final report is named by an open blocker with its marker, `[final: pro-review — not run]` / `[final: task-converge — stale]` (the state words in Russian in a ru task; prose about the checker is not read, and in a Force block dated 2026-10-26 or later that was written after 0.18.2 first saw the task (every block already there then, open or closed, keeps the lift words; a second data dir that first reads the task later holds the blocks 0.18.2 wrote) a blocker is lifted only by the field `Lifted: <who> <date> — <answer>` (a who of at most 4 words, the answer after the date; its Russian form is in the marker table), never by a word in the reason; an older block keeps the lift words, and the field on the blocker's own line lifts there too). On closing, the short run summary (`run-digest.mjs`, with the CI gates) is put into the context with the path to the full one, `RUN-DIGEST.md` — the short one goes into the final message whole. Since 0.18.1 the call that closes the block (an Edit or MultiEdit of its heading, a Write of STAGES.md, a Bash call that names the task; a close the hook rejected counts for the same session's fixing edit) also closes the session's MCP browser (`browser-cleanup.mjs --session`, by PID, only this session's pipeline browsers; nothing is held up when `ps` is missing) and both views of the digest carry its line, `Session browser: closed by PID …`. A heading closed by hand, in another session or during an unrelated call leaves the browser open, and so does `STAGE_PIPELINE_BROWSER_CLEANUP=off` in the environment: the line then says `left open — …; close: <command>`.

  It looks only at lines and reports that did not exist when the plugin first saw the task: old stages need not be rewritten.

  Task files: the hooks and scripts read STAGES.md, the archive and the reports only as regular files of at most 4 MB whose real path lies inside the task directory (a task root behind a symlink, `.claude/tasks → ~/.claude/team-tasks`, is fine), and the configs as regular files of at most 256 KB. A STAGES.md or a report that is there but cannot be read (over the limit, a link out of the task directory, not a regular file) counts as open, not as empty: the force commit and the "completed" close are refused with the file and the limit named, and the run digest says "Not ready for PR" for it.
- **frames-guard** — when devtools-verify finishes. It does not let the agent go until it has opened every frame it captured: a defect that the user found after "done" has sat on a frame nobody opened. It also blocks a finish when the first navigation came before a `verify-doctor.mjs` call, or after a doctor result other than `ok` / `no dev url` (`wrong app`, `down`, `no config`, `error`, or no `doctor:` line at all): a run against another worktree's server on the same port is green about the wrong code. Since 0.18.1 it also blocks a finish that leaves running what the agent opened: a page of its `new_page` still in the freshest `## Pages` list (the last page may stay, on `about:blank`: MCP 1.6.0 refuses to close it), or a browser it launched that still runs: a `journey: browser pid N` line or the one PID a `<browser or node script> … & echo $!` call printed, a wrapper such as `timeout`, `env` or `bash -c "…"` included (the browser told by `browser-cleanup.mjs`'s list of executable names, Linux ones included), both from its own Bash results, a browser executable started after the agent's first transcript record (a transcript with no timestamps names none). The page list is read only from the page tools' own `## Pages` section, never from a console message. Only a page that the agent's own successful `new_page` returned as the fresh selected one is named; a tab left by a `new_page` that answered with an error (or with an open dialog) is not, and devtools-verify lists and closes it. Once a page tool of that server answers with the transport's disconnect error (the answer starts with `MCP server "…" is not connected` or `MCP error -32000: Connection closed`; the same words in a page's dialog or in a URL do not count), the page rule is off: nothing can close the page, and the agent names it under "Could not verify". `browser-cleanup.mjs --orphans` closes a temp-profile (`--isolated`) browser that outlived its server; a `stage-pipeline-chrome` browser whose server is gone is only listed: `browser-cleanup.mjs` with no flag names it with `kill <pid>`. The orchestrator's pages and the session's MCP browser are not the agent's. A force run already open when 0.18 first saw the task is not checked for this.

### Scripts

- `scripts/archive-stages.mjs <STAGES.md> [--apply]` — fold closed stages and the old journal into `STAGES-ARCHIVE.md` (called from `/stage-check`, Step 4.2).
- `scripts/run-check.mjs -- <command with {files}>` — a stage's lint/test/type_check/build: only the changed files; on a machine with RAM ≤ 16 GB — one after another across projects and at a lowered priority (`references/heavy-checks.md`; `--mode` — the machine mode). A whole command on a clean tree records its result under the commit's tree — the hook sees the CI gates through it.
- `scripts/ci-gates.mjs [--run]` — the CI gates from the config (the "## CI gates" table or `e2e`/`smoke` in Commands) and their state on HEAD; `--run` runs the non-green ones through `run-check.mjs`. A gate that cannot run here is skipped on the record: `skip: <reason> <date>` in its table row (or after an `e2e`/`smoke` Commands line), or `skip: <gate> — <reason> <date>` in the run's Force block. It is listed once as skipped and accepted at close; without a reason and a date the mark does not count, and an unmarked gate still blocks. A green run on HEAD beats any skip, and a run red on HEAD beats the Force block's skip (that line stands only for a gate that cannot run here; the user's mark in the config row still counts). Called from the final checks.
- `scripts/kit-override-scan.mjs [--base <ref>] [--out <report>]` — kit overrides and manual typography in the added lines; with `--out` it writes a `kit-overrides` report in the checker format (every file is major, then "Findings outcome"). The kit directory from `ui_lib` is not scanned; in the kit's own repository — `kit_overrides: off` in the config.
- `scripts/floor-guard.mjs [--base <ref>] [--pathspec-from-stdin]` — the quality floor over the diff: silenced checkers, `as any`, weakened tests and configs, stubs, secrets; the first line is the diff size (called from `/stage-check`, `stage-implement` and the hook on a force commit — the hook passes the commit paths through stdin). Violations in untracked files are marked "not in git".
- `scripts/verify-doctor.mjs [--url … --route … --marker …]` (config keys `verify_routes:` / `app_marker:` in "Dev server") — read-only: is the dev server on the port this worktree's app (answers on the baseline routes, the app marker, the listening process's `cwd` inside the worktree), always one `doctor:` line (`ok`, `wrong app`, `down`, `no dev url`, `no config`, `error`); the config is found as the hooks find it, the main tree's for a linked worktree with `.claude/` excluded; devtools-verify runs it before its first navigation.
- `scripts/browser-cleanup.mjs [--session [--persistent] | --orphans]` — the Chrome windows the DevTools MCP servers launched, by Claude Code session (the nearest `claude` process above the caller). No flag — read-only: this session's browsers with their PID and the close command, other sessions' with age and session folder, orphans, and a `stage-pipeline-chrome` browser whose MCP server is gone (it keeps that profile busy; listed with `kill <pid>`, never closed by the script). `--session` closes this session's pipeline browsers by PID (the plugin's `--isolated` one and `stage-pipeline-chrome`; `--persistent` — only the latter); the next MCP call opens a fresh one; a project server's browser on its own profile (the default or a `--user-data-dir`) is listed, never closed; one started with `--isolated` cannot be told from the plugin's, so it is closed too and relaunches on its next call. `--orphans` closes temp-profile browsers whose MCP server is gone: a browser executable of this user on a `puppeteer_dev_chrome_profile-*` profile in the OS temp dir, never a shell or a script that names such a profile. SIGKILL goes only to a PID whose start time and command line are still the ones read before SIGTERM. Another session's browser is never closed. The force close runs `--session` (journal-gate); in normal mode `/stage-check` runs `--session --persistent` after each stage with the opt-in profile, and names the `--isolated` browser's PID and this command.
- `scripts/journal-check.mjs <task_dir>/<TICKET> [--ledger]` — the same rules as journal-gate, over the whole task, including the archive and `checks/`; `--ledger` adds a summary and the findings outcome in all reports (old tasks have none by construction).
- `scripts/run-digest.mjs <task_dir>/<TICKET> [--full | --no-write]` — the summary of the freshest run from the journal and the reports. The full view also lists every critical, major and FAIL dismissal (`false`) verbatim with its checker and sorts "Awaiting" by rollback cost; the short view gives the dismissal count. It writes the full digest to `<task_dir>/<TICKET>/RUN-DIGEST.md` (every line of every category, overwritten at each closing) and prints the short one: blockers, red CI gates and findings without an outcome in full; a "Not ready for PR" line when a report has a critical, major or FAIL finding without an allowed outcome (each outcome line is judged by the severity of its own finding, so a fixed minor does not stand in for a parked critical) or a task file cannot be read; the unverified (by stage), the checkers' "could not verify" and minor as numbers; "accepted on its own" as a number and the first three. `/stage-force` inserts the short one into the final message.
- `scripts/retro.mjs <repo>` — a retro over the task files: false findings, fix-loop rounds, skips per checker, `AC-*` outcomes, bloated STAGES.md files. Takes metrics from the `metrics:` line of the stage journal.

## 0. Once per repository — `/pipeline-init`

Studies the project and creates `<repo>/.claude/pipeline.config.md` (paths, commands, dev URL, design sources, code layout, platforms, `task_path`/`memory_path`). If there is no `CLAUDE.md`, it offers `/init`. It also offers to lay the pipeline permissions into the user scope (see "Permissions" above) — once per machine, not in every repository.

## 1. Once per task

1. **`/feature-checker <ticket/feature>`** → `FEATURE-MAP.md` — a map of what already exists (reuse vs write from scratch). Needed for planning.
2. **`/stage-plan`** → `STAGES.md` — splitting into stages (1 screen + its states = 1 stage), WHEN/THEN acceptance criteria, the order. Requires FEATURE-MAP.

Criteria are numbered (`AC-<stage>.<n>`) and carry a verifier tag — who is able to check them: `figma-compare`, `devtools-verify`, `pro-review`, `user-review`. A criterion that only the user can reach is never pre-tagged at plan time: the checker defers it with `[live: user-side — <prerequisite>; <route> → <observed>]` after it tried (force asks for the login up front). This gives three things that would not exist otherwise: a design source coverage table (no screen is lost silently), ID references in checker reports (the fix-loop knows what it rechecks) and a mechanical assembly of TEST-PLAN.md instead of rereading all stages. A criterion without a verifier is a defect of the plan: there is nothing to check it with.

## 2. The loop of EACH stage

```
/stage-kickoff   → show the stage plan + merge with what has piled up (TODO/DESIGN-QUESTIONS/
                   decisions) + collect business input + sign-off  → runs figma-spec (the spec)
   implement     → write code (reusing what feature-checker found)
   checkers      → in parallel: figma-compare ∥ pro-review (static, subagents)
                   + devtools-verify (runtime, subagent; the dev server is held by the orchestrator)
                   + narrow ones by a trigger: dead-code / i18n-sweep / deps-audit
   fix-loop ≤2   → fix what is confirmed, recheck point by point
   user-review   → show the user, wait for approval (mandatory)
/stage-check     → journal in STAGES.md + commit message
   /clear        → typed by the user (the model cannot call /clear or /compact);
                   the new session starts from the status line of the hook and STAGES.md
```

Rule: do not start implement without a sign-off (kickoff); do not mark a stage done with critical findings, a pro-review verdict of Request changes or open escalations.

The commit message is prepared at EVERY stage — by the substance of the change, not "stage N", and without service signatures about the tool's authorship.

## 2b. Autonomous run — `/stage-force`

The same plan and the same checkers, but the stops are moved to the beginning: all questions for all stages are asked in one batch, then the run goes to the end — implementation, checkers, fixes, commits — without waiting.

The context does not pile up between stages without any `/compact` (the model cannot call it anyway): the stage code is written by the `stage-implement` subagent, the fix-loop fixes by the same one in fix mode, and the checker subagents verify. The main context keeps STAGES.md and short summaries, so a long run goes in one session.

Always forbidden: `git push`, creating and commenting on a PR/MR, deploy, publishing. Always mandatory: a stop on irreversible forks, an exhausted fix-loop, a red build and a conflict of sources of truth. Reversible forks are decided on its own: the revertible option is taken, and a line goes into "⚠ Awaiting user confirmation".

## 3. Task finale

- A full `pro-review` over the whole branch (an agent in whole-branch mode on `review_model`, the base is `origin/<main_branch>`, that is, the PR target: if PRs go into `dev`, the config has `main_branch: dev`).
- `floor-guard --base origin/<main_branch>` — the quality floor over the whole branch: silenced checkers, weakened tests, stubs.
- security-review, metrics-guard (if the config has `bundle_size`), ds-parity, dead-code, i18n-sweep, deps-audit (per STAGES "Final checks").
- **`/task-converge`** — the code on HEAD against the intent of the task. All other checkers look into the diff and answer "is what was done done right"; converge answers "was everything promised done, and was nothing extra done". A criterion that no stage took on does not appear in the diff — its absence is invisible by definition. Findings → a "Catch-up" block in STAGES.md (append-only, rewriting nothing) → a repeated run until it converges.
- **`/task-wrapup`** → `PR.md` — a PR/MR description from the task journal, written by the human-text rules and checked by `human-text-check`: what and why, how to verify, what the reviewer should look at, blind spots, open questions. Manual only, when the description is needed: neither force nor the final checks call it. Pushing and creating a PR are also manual.
- A legacy removal / cleanup is a separate final stage.

## Skills and agents

| Tool | Role |
|---|---|
| `/pipeline-init` (skill, manual only) | project config |
| `/pipeline-doctor` (skill) | environment diagnostics (MCP, neighbouring repos, dev server, baseline) |
| `/feature-checker` (skill) | a map of the existing feature → FEATURE-MAP.md |
| `/stage-plan` (skill) | splitting into stages → STAGES.md |
| `/stage-kickoff` (skill) | open a stage: plan + business input + sign-off |
| `stage-implement` (agent) | maker: the code of one stage or a fix round in a clean context, a summary comes back; the basis of `/stage-force` |
| `figma-spec` (agent) | a compact spec from Figma (in a clean context) |
| `figma-compare` (agent) | checking code against Figma |
| `proto-spec` (agent) | like figma-spec, but from a repository of HTML prototypes ("our Figma" in projects without Figma) |
| `docs-lookup` (agent) | a reference on a library API for the version from the lockfile — the types, CHANGELOG and source of the installed package, and when that is not enough, the official docs of that version; used when unsure about an API during implementation, in the fix-loop and in `/root-cause` |
| `proto-compare` (agent) | like figma-compare, but against an HTML prototype + SPEC.md |
| `devtools-verify` (agent) | runtime check through Chrome DevTools |
| `pro-review` (agent) | senior code review in two modes: the stage diff (stage) or the whole branch before a PR (whole-branch) |
| `/ds-parity` (skill) | duplicates with the design system: what to replace with a kit component, what to move INTO the kit |
| `dead-code` (agent) | what this diff orphaned — symbols, files, locale keys, assets |
| `i18n-sweep` (agent) | hardcoded copy, incomplete locales, dynamic keys, formatting without a locale |
| `deps-audit` (agent) | new dependencies and assets: justification, an equivalent in the repository, weight |
| `/stage-check` (skill) | close a stage: fix-loop + journal + commit |
| `/root-cause` (skill) | debugging to the cause: a fix did not work, a symptom with no explanation, a white page |
| `task-converge` (agent + skill) | the code on HEAD against the intent of the whole task: an uncovered criterion, a partial implementation, a contradiction, a silently widened scope |
| `/stage-force` (skill) | an autonomous run of the whole task: questions in a batch at the start, then no stops |
| `/task-wrapup` (skill, manual only) | a PR/MR description from the task journal → `PR.md`, written by the human-text rules and checked by `human-text-check` |
| `/human-text` (skill, manual only) | text about a project for people (team, manager, newcomer, client): a fact card, a draft by the rules, a closed-question check |
| `human-text-check` (agent) | checks a draft against 14 closed questions in a clean context, returns only the violations; used by `/human-text`, `/task-wrapup` and `/feature-doc` |
| `/feature-doc` (skill, manual only) | a doc on a finished feature in `docs/features/` for someone who has not seen it; outside the pipeline |

**Models.** The orchestrator (the `/stage-*` skills) runs on the model of your session — the plugin does not set it; the recommended one is Opus (`/model`). The agents use the `model:` field in the frontmatter, and it was chosen by a `scripts/eval.mjs` measurement, not by role:

| Model | Agents | Why |
|---|---|---|
| `sonnet` | `stage-implement`, `pro-review`, `task-converge`, `figma-*`, `proto-*`, `devtools-verify`, `dead-code`, `i18n-sweep`, `docs-lookup`, `human-text-check` | judgment and accuracy: a false green from a checker is worse than a red one, and noise is refuted by the expensive orchestrator |
| `haiku` | `deps-audit` | mechanical work; on the eval case not worse than Sonnet at a 2.5 times lower price (measurement — CHANGELOG 0.9.0) |

The exception is the whole-branch pro-review and the fresh checker run in the fix-loop: they go on `review_model` from the config (`opus` by default) through the `model` parameter: the last check by the strongest model, and in force also not the one that wrote the code (`/stage-check`, Step 3.3). For whole-branch the agent-guard hook enforces this: in live runs 5 of 14 such reviews went to sonnet because the parameter was forgotten.

The `sonnet` alias resolves differently depending on the Claude Code version: in 2.1.193 to Sonnet 4.6, in 2.1.276 already to Sonnet 5. The real model is shown by `modelUsage` in the summary of an eval run. If you need a specific model, put an explicit id into the frontmatter (`claude-sonnet-5`). Before changing an agent's model: `node scripts/eval.mjs --runs 3 --model <agent>=<model> <the agent's cases>`.

**Three narrow checkers instead of one big one.** `pro-review` answers for correctness, security and conventions. `dead-code`, `i18n-sweep` and `deps-audit` each answer for their own class of junk, with their own confirmation procedure, and run **by a trigger**: something was deleted → dead-code; user text appeared → i18n-sweep; the manifest was touched → deps-audit. No sign — `[skip: no trigger]`, no extra subagent is spent.

**Replacing checkers per repository.** The design source is not Figma but a file one (a repository of HTML prototypes from AI designers): `pipeline.config.md` declares `figma-spec → proto-spec`, `figma-compare → proto-compare` in the "Checker overrides" section — the kickoff/check orchestrators read the config and take the named agents. The rest of the loop is unchanged; such a repository does not need the Figma MCP.

## human-text and feature-doc — outside the loop

Two manual skills for text that people read. Neither is called by the pipeline's stages or hooks.

- **`/stage-pipeline:human-text <to whom> <about what>`** — text about a project for the team, a manager, a newcomer or a client. It also installs on its own, without the pipeline: `claude plugin marketplace add maggi08/claude-pipeline`, then `claude plugin install human-text@magzhan` (the command is then `/human-text:human-text`).
- **`/stage-pipeline:feature-doc [feature]`** — a doc on a finished feature in `docs/features/`. If a separate `feature-docs` plugin is installed, this does the same job; both are manual, pick one per repository.

**For whoever edits the plugin.** `skills/human-text/` and `agents/human-text-check.md` are a vendored copy; the source of truth is the repo `maggi08/human-text`. `plugins/stage-pipeline/human-text.lock.json` pins the source commit and the sha256 of each copied file. Change the rules in the human-text repo, then run `node scripts/sync-human-text.mjs` (from the marketplace repo; `../human-text` by default, or a path or a git ref as an argument) and commit the copy together with the lock. `node scripts/validate.mjs` fails on a hand edit of the copy.

## Files (in the repository — `<repo>/.claude/`)

- `pipeline.config.md` — the project profile (read by all skills).
- `tasks/<TICKET>/` — `STAGES.md` (the journal: what/when/why/outcome), `specs/`, `checks/`, `DESIGN-QUESTIONS.md`.
- `memory/` — project memory (decisions/pitfalls of this repository).

Keep project review checklists in `CLAUDE.md` or in `pipeline.config.md → Conventions`, NOT in the plugin skills: the plugin is read in all repositories, and someone else's rubric produces false Majors.

## Context hygiene (the main lever of spending)

The full version with measurements — [references/context-hygiene.md](references/context-hygiene.md).

- Checks go through subagents (heavy Figma dumps/snapshots/diffs do not settle in the main context).
- After closing a stage — `/clear` (typed by the user); chrome-devtools and Figma through subagents, not from the main context; in force the stages go through subagents and there is nothing to clear.
- `evaluate_script` (numbers) instead of screenshots for measurements; `take_snapshot` only for the uid.
- Text fidelity: placeholder vs dynamic, exact characters (—/₸/«»/nbsp), i18n against the resolved locale.
- Read big trackers (STAGES.md) selectively (offset/grep).
