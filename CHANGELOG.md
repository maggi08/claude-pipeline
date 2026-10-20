# Changelog

The `stage-pipeline` plugin. The version is in `plugins/stage-pipeline/.claude-plugin/plugin.json`, dates follow the commits.
Each entry records what changes for the person who runs the pipeline, not a list of touched files.

Update: `claude plugin update stage-pipeline` + restart Claude Code.

## 0.18.0 — 2026-10-20

### Proof that checks ran, honest live checks, dismissals and decisions you can weigh (VT-1 stages 3–5, release R1)

Built on 0.17.0 and on the VT-1 stage 2 hook fixes in the next part of this entry. Every new rule follows the task's baseline snapshot (see "On upgrade"); no rule hangs on a guessed release date.

**Stage 3: stage receipts.**
- **A force commit needs the stage's checker reports.** git-guard denies a force commit when no `pro-review` report was written since the previous force commit, and when the diff changes UI with neither a `devtools-verify` report nor a legitimate skip line (`logic-only`, no visual change; a browser, MCP, login or stand reason is not one). UI files changed with no design report (figma-compare / proto-compare) on a stage that is not `logic-only` are denied too, unless a skip line says `logic-only`, no design source or no visual change. Everything else is not a block: it goes to the digest.
- **"Completed" needs fresh final reviews.** A force run is closed "completed" only when the whole-branch `pro-review` and `task-converge` reports are newer than the last commit that changed the tree.
- **The full digest has a new section, "Stages without runtime check".** The short view shows its count.
- Applies to a Force run opened after 0.18 first saw the task: the snapshot records that day and the Force headings already there and dated before it, so a Force run dated before the day of the upgrade keeps the old behaviour. A run dated the upgrade day, or one whose date does not parse, gets the new rules. Receipts live in `<plugin data>/receipts/`.

**Stage 4: login and honest live checks.**
- **Login is asked up front.** The force interview (Step 0) runs an auth probe when some criterion is behind a login and puts "log in in the managed Chrome window at `<route>`" into the opening batch. A session that expires mid-run is a deferral, not a pause.
- **`[live: user-side]` must say why.** The honest form is `[live: user-side — <prerequisite>; <route> → <observed>]`; a bare tag on a new line or in a new report is rejected. The plan no longer pre-tags criteria `[live: user-side]`.
- **`scripts/verify-doctor.mjs`** answers whether the dev server on the port is this worktree's app (baseline routes, an app marker, the listener's `cwd`) with one `doctor:` line: `ok`, `wrong app`, `down`, `no dev url` (a config without a dev url: a static target), `no config` (no pipeline config here or in the main tree — pass `--url`), `error` (the doctor itself failed; it never ends without a line). It finds the config as the hooks do, so a linked worktree whose `.claude/` is excluded reads the main tree's. devtools-verify runs it before its first navigation, and frames-guard blocks a navigation that came first or after any result but `ok` / `no dev url`. Optional config keys `verify_routes:` and `app_marker:` in "Dev server". New devtools-verify reports carry `doctor:` and `auth:` lines.
- **`/pipeline-doctor` offers an opt-in persistent Chrome profile** per repo through `claude mcp add --scope local stage-pipeline-chrome …` (the version the plugin pins, `--userDataDir` under `~/.cache/stage-pipeline/chrome/`). It lives in `~/.claude.json` and is never committed. The plugin's server keeps running next to it; devtools-verify and the force auth probe take the `mcp__stage-pipeline-chrome__*` tools first, so the login is made and read in the persistent profile. A project's own `chrome-devtools` server (a tracked `.mcp.json` with `chrome-devtools-mcp@latest` and the shared default profile) is never used. The permission profile allows `mcp__stage-pipeline-chrome`.
- **The Chrome DevTools MCP has run with `--isolated` since `ed3688d` (2026-10-06), a change this file never listed.** Every session gets a throwaway profile, so sessions in several repos no longer fight over one profile, and a login does not survive the session. The opt-in profile above is how to keep one.

**Stage 5: the dismissal trail and evidence for decisions taken alone.**
- **The full digest lists every dismissal.** A new section "Dismissed as false" quotes, verbatim and with its checker, every `false` outcome on a critical, major or FAIL finding. The short view gives the count and how many are critical. A `false` written for a criterion that did not fail ("not a FAIL") is listed apart.
- **A `false` needs a proof of its own kind.** In new reports the hook rejects: "the fix is impossible", "can't be fixed", "unfixable", "the kit / backend owns it" or "the kit has no such slot" without a `file:line` in the kit, the contract or the tool (a task-code `file:line` is enough for "impossible" / "forced" / "unavoidable" when the clause is not about the kit or the backend); "by design" without a source; "not reproduced" without two attempts and the route (`not reproduced (2 attempts, /root-cause)` passes); "demoted to minor" as the reason; "this stage did not change it" without a base sha, diff range or `git` command; "a later stage owns it" proved by a plan line; the same report, an acceptance criterion or a force assumption as the only basis; "false for the data" from a sample; "not related to the task" with no diff. The finding then stands: a fix, a blocker `B<n>` or a user decision.
- **A dismissed critical goes through the fresh pass.** Its ledger line cites the fresh report written on `review_model` (`/stage-check`, Step 3.3), and the hook checks that the file exists and belongs to the same checker and stage (`pro-review-3.md` is confirmed by `pro-review-3-fresh*.md`).
- **Awaiting lines and assumptions carry evidence.** A new line in "Awaiting user confirmation" or under `Assumptions:` of a Force block (the bullets, or the text on the `Assumptions:` line itself) needs `Rollback: <cost>` and `Basis: <path:line | node-id | URL | a ticket quote | D<n> / A<n> / AC-<n> | guess>` (the Russian task has its own two words, see `references/language.md`). journal-gate rejects a line without them, and the digest lists the rows by rollback cost, expensive first.

**Final-check fixes (VT-1 stage 5a).**
- **A gate red on HEAD is no longer accepted through the Force block's `skip:` line** (a change to the stage 2 skip rule in the next part of this entry). That line stands only for a gate that cannot run here; a gate that ran and failed is a fix-loop finding or a named blocker with "completed with blockers". The user's `skip:` mark in the config row still counts, and a green run still beats any skip.
- **The ticket-titled commit rule of stage 2 (the next part of this entry) follows the same per-task gate** as the receipts: a Force run dated before the day 0.18 first sees the task keeps the old behaviour (a run dated that day gets the new rules). A `Revert "…"` after a close is not named.
- **The first look cannot swallow the run it opens.** The snapshot takes its first look lazily, and that look could be the very edit that writes `## Force run <today>` (a session started on `main`, the branch created after the interview): the new run was then filed as one already there, and its stage commits went through with no reports. Only headings dated before the migration day now count as already there, and journal-gate takes the snapshot before an Edit or Write of a task file when none exists yet.
- **The hooks cost less on every Bash call.** journal-gate leaves at once outside a pipeline repo, and after a call it reads its stamp first and looks at the tasks only when a stamped file or directory changed; git-guard loads its rules only for a command that can add or commit. Measured on one machine (median of 20, the hooks of one event in parallel): outside a pipeline repo 51 ms per Bash call (0.16.2: 55 ms, 0.18.0 before this fix: 99 ms); in a pipeline worktree with a current task 76 ms (56 ms, 108 ms) — the stamp before the call still reads the task state. An Edit or Write of a task file: journal-gate loads its rule modules and runs git only when the task has no snapshot yet; PreToolUse median of 20 for one Edit of STAGES.md 68 ms before, 43 ms after (an Edit of any other file: 42 ms, 40 ms).
- **Long tokens no longer stall the hooks.** A 10 KB `false` line on a critical took 36 s in journal-gate and 38 s in git-guard, past their 5 s / 15 s timeouts, so the commit went through unchecked; the fresh-report name is now found among the words of the line, the dismissal, decision, live-tag, skip and config patterns run in linear time, and a findings line is read up to 4 000 characters. Task files are read only when they are regular files of at most 4 MB (a symlink only inside the task directory): a committed `STAGES-ARCHIVE.md -> /dev/random` made every hook read until it was killed.

**On upgrade.** Nothing to rewrite. The snapshot of each task migrates once: the "Awaiting" and assumption lines already there, and the reports already there, are old and raise nothing — so a devtools-verify report written before the upgrade stays editable without a `doctor:` line. The snapshot also records the day and the Force runs it saw dated before that day. The 0.18 rules judge only what is written, and the runs opened, after.

### The hooks stop firing on reads, gates can be skipped on the record, post-close commits are seen (VT-1 stage 2)

Four defects of the 2026-10-16 audit, fixed at the root. On 2026-10-19 the first of them reproduced live: a read-only `ls .claude/tasks/EN-1/checks` from another task's session returned EN-1's force-close demands.

- **journal-gate judges a Bash call by what it changed, not by what its text says.** It used to fire on any command that mentioned `STAGES` or `checks/`, reads included — about 37% of 156 firings in the audit. A PreToolUse run of the same hook now stamps the mtime and size of STAGES.md and `checks/*.md` of the current branch's tasks and of the tasks the command names by path, and the PostToolUse run acts only on the tasks where one of them changed during the call. `cat`, `ls`, `grep`, `sed -n` and `node run-digest.mjs` are silent; a command that rewrites the journal or a report gets the same demands as an edit. No stamp (a hook that did not run) — silent.
- **A CI gate can be skipped on the record.** `skip: <reason> <date>` in the gate's row of the "CI gates" table (or after an `- e2e:` / `- smoke:` line in Commands), or `skip: <gate> — <reason> <date>` in the run's Force block. A skip in the Force block speaks only for the gate named in its own clause (`smoke failed, e2e skip: …` skips e2e alone); a dash before a bare date (`skip: no staging — 2026-10-20`) is read as reason and date. The gate is listed once as skipped (`ci-gates.mjs`, the run digest) and the force close accepts it; before, a gate that cannot run on the machine produced the same blocker message again and again (PLI-3474: 56–65 repeats). The reason and the date are both required; an unmarked gate blocks as before, and a green run beats a skip.
- **A ticket-titled commit after a force close is no longer taken for the task's own squash.** session-start dropped every commit with the ticket in its title from the "bypassed the journal" list. Now only its SHA or patch-id in the journal clears it; a PR squash with `(#17)` is still skipped. The rule applies only to a force run opened after 0.18 first saw the task (the per-task gate of 0.18.0); a run dated before that day keeps the old behaviour (every ticket-titled commit is skipped).
- **One data directory for the hooks and for scripts run from Bash.** A script run from Bash finds the hooks' `stage-pipeline-<marketplace>` also when it is a cached older version of the install (a session that started before an update); the source tree of a directory marketplace is found since 0.16.2. A worktree or a `--plugin-dir` copy still gets `stage-pipeline-inline`, as that session's hooks do. Nothing is migrated: both directories are read, one is written.

Nothing to do on upgrade. Skips apply only to marks you write after it.

## 0.17.0 — 2026-10-19

### Text for people: human-text, `/feature-doc`, and a PR description written by the same rules

AI-written text for people (a PR description, a status note, a doc on a feature) reads like AI text: even, over-explained, every point given the same weight. The rules against this now live in one place, and the pipeline uses them.

- **`/stage-pipeline:human-text` — a manual skill for text about a project.** A post to the team, an update for a manager, an intro for a newcomer: it collects the facts from the repo into a card, writes the draft by the rules, and sends the draft to the `human-text-check` agent (14 closed questions, a clean context, only the violations come back). The model never calls it by itself.
- **The source of human-text is its own repo, `maggi08/human-text`; stage-pipeline carries a pinned copy.** The copy (`skills/human-text/`, `agents/human-text-check.md`) is brought in by `node scripts/sync-human-text.mjs`, which records the source commit and the sha256 of every file in `plugins/stage-pipeline/human-text.lock.json`. `validate.mjs` fails when a vendored file differs from the lock, so a hand edit of the copy is caught.
- **`human-text` is also installable on its own**, without the pipeline: `claude plugin install human-text@magzhan` (a new entry in the marketplace).
- **`/stage-pipeline:feature-doc` — a manual doc on a finished feature.** It writes `docs/features/<feature>.md` for someone who has not seen the feature: why it exists, what it promises the user, how it works, where the code is. It reads the artifacts of stage-pipeline or OpenSpec (and the branch diff when there are none), writes by the human-text rules and checks the text with the same agent. It is not part of the pipeline: no stage, hook or force run calls it.
- **`/task-wrapup` writes `PR.md` by the human-text rules** and runs the draft through `human-text-check` before it hands it over; a finding that is fixed is fixed in the text; a rejected finding is listed with the reason, and a draft that was checked by hand is marked as such.
- **The force run summary uses the same rules** for the three lines the model writes itself: the heading, `Not done:` and `Next:`. The short view and `RUN-DIGEST.md` from 0.16.2 are unchanged.
- **For whoever edits the plugin:** a change to the human-text skill, rules or agent goes into the human-text repo first, then `node scripts/sync-human-text.mjs` brings it here. Editing the vendored copy by hand fails `validate.mjs`.

Nothing to do on upgrade. If `feature-docs@mycar` is installed, it keeps working; `/stage-pipeline:feature-doc` does the same job and both are called only by hand, so pick one per repository.

## 0.16.2 — 2026-10-19

### The run summary is short; the full list goes to a file

On a long task the summary at the end of a force run ran to 150 lines, and what needed an answer was lost in the checkers' mechanics ("screenshots were not taken"). It now comes in two views, and the script, not the model, decides what goes where.

- **The short view goes into the chat.** Blockers, red CI gates and findings without an outcome come whole. Everything else is a number: the criteria not closed by a check (`⏳`, `[live:`, `[blocked`) by stage, the checkers' "could not verify", minor without an outcome; "accepted on my own" is a number and the first three. A category with nothing in it is folded into one "None: …" line (the blockers keep their own header with "none"), a category with something in it never disappears. One more line appears only when a report of the run has a critical/major finding or a FAIL without an allowed outcome in its "Findings outcome" (a finding closed by a "fixed: …" line no longer counts, whatever the verdict in the head says): "Not ready for PR — …" with the report names. The last line is the path to the full digest. The summary template in `/stage-force` ("Output") is rewritten for it: the short view is pasted whole, without retelling or picking — the reason is the same as before (a summary once reduced everything to "kk/en texts and minor deviations", and two defects lay under that line).
- **The full view is `<task_dir>/<TICKET>/RUN-DIGEST.md`.** Every line of every category, plus the checkers' verdicts by report; the date of the run is in the header. One file per task, overwritten when a run closes, outside `checks/` — so no hook or script takes it for a checker report. On "more" or "what about X" the model opens that section from the file instead of repeating the whole digest.
- **journal-gate puts the short view and the path into the context** when a force block closes, and writes the file.
- **Only the freshest run is summarised.** `lastForceBlock` takes the block with the latest date in its heading, not the last heading in the file: a journal that keeps new blocks on top used to report the blockers of its oldest run. Equal dates go by the ordinal in the heading ("(2)", `2026-10-12b`, "second run"), then by the direction the file keeps its blocks in. A run closed before the plugin first looked at the task is not checked after the fact: its CI gates are not re-run against today's HEAD and its summary is not shown late. Reports and journal lines count from the date of that run (and after the task snapshot), except "Awaiting confirmation": that list is open until the user confirms, so the date does not cut it. If an earlier run of the same day falls inside, the digest says so in a line.
- **Blockers written on the `Blockers:` line count.** `Blockers: B1 — … B7 — …` was invisible to the parser; each item is now its own blocker, and a lifted one is judged by its own text; a common mark lifts them all only as "both/all lifted" (the Russian plural forms too) or, without the quantifier, at the head of the field before the first `B<n>`.
- **`RUN-DIGEST.md` is never written through a symlink.** The file is written to a temp file and renamed; if `RUN-DIGEST.md` or the task directory is a symlink, or the task directory lies outside the `task_path` directory of the config (a `task_path` outside the repo, or `.claude/tasks` as a symlink to it, is fine), nothing is written and the short view says "Full digest not written: …". A "not all closed" inside a blocker no longer lifts the whole `Blockers:` line: the common mark counts only before the first `B<n>` or as the closing phrase ("both lifted 2026-10-14"), and a negation of the group ("not all", the Russian forms too) takes it back.
- **CI gates in the digest are the task's repo's**, not those of the repo the script was started from.
- **Scripts run from Bash use the hooks' data directory.** Without `CLAUDE_PLUGIN_DATA` they used `~/.claude/plugins/data/stage-pipeline`, a different directory from the hooks' `stage-pipeline-<marketplace>`, so snapshots and gate runs never met (`run-check` from Bash, then "ran on another tree" in the hook). The script now finds the hooks' directory and still reads the old one, so nothing recorded earlier is lost. The name is taken from where the script itself lies: the `installPath` in `~/.claude/plugins/installed_plugins.json` that contains it gives `stage-pipeline-<marketplace>`, a marketplace connected as a directory (its `source.path` / `installLocation` in `known_marketplaces.json` holds the script, while `installPath` points into the cache) gives its own `stage-pipeline-<marketplace>`; a script outside both (a `--plugin-dir` session) gives `stage-pipeline-inline`, as that session's hooks do. `run-digest.mjs` from Bash and from the hook give the same text. `scripts/eval.mjs` runs with a data directory of its own. A `CLAUDE_PLUGIN_DATA` with a trailing slash works too.

Nothing to do on upgrade. To go back to the long single list, `node scripts/run-digest.mjs <task_dir>/<TICKET> --full`.

## 0.16.1 — 2026-10-19

### The journal gates stay fast on Node 22

Two patterns of the journal gates took seconds on a long run of whitespace under Node 22: the caveat check of a `✅` criterion (about a minute on 50 000 newlines) and the closing word of a Force run heading (about 7 s on 50 000 tabs). Under Node 24 both were fast. Both now take about a millisecond, and what they match has not changed.

Nothing to do on upgrade.

## 0.16.0 — 2026-10-17

### The plugin is in English, tasks keep their own language

Skills, agents, references, hook messages, READMEs, the rollout guide, the cheatsheet and the deck are now in English.
The language of the work itself belongs to the task, not to the plugin.

- **The task language is a line in the STAGES.md header:** `Language: en` or `Language: ru`. Only these two are supported.
  - A new task gets it in this order: an explicit request ("make the task in English") > `language:` in `pipeline.config.md` > the language of the message that started the task. Once the line is written, later messages in another language do not change it.
  - Every file of the task directory is in that language: STAGES.md and its archive, `checks/` reports, FEATURE-MAP, TEST-PLAN, specs, the run summary. The orchestrator passes the language to subagents in the prompt.
  - "Translate the task to English" changes the line and translates STAGES.md as a whole; the old reports in `checks/` stay as they are. "Make this file in Russian" changes only that file.
  - Chat stays in the language of the user. Commits and PR descriptions follow the language of the repo's history, or the request. Hook messages are always English: the model reads them and retells them in your language.
  - The rule and the table of service markers are in `references/language.md`.
- **Old Russian tasks are read and run as they are.** The parsers read Russian and English markers (`scripts/markers.mjs`), and the journal gates understand English phrasing next to the Russian one. A task without the `Language:` line gets its language from the headings; nothing is added to it.
- **journal-gate returns a new `checks/` report that is explicitly written in a language other than the task language.** It measures the share of Cyrillic in the prose of the report; code, paths, quotes and ids do not count. A short report (under 40 words of prose) is not judged, and reports that already existed are not checked.
- **Russian phrases still call the skills.** Skill descriptions are English with a short tail of Russian trigger phrases, and the routing eval keeps the Russian phrases and has an English one for every skill.
- **The Russian "none" in `kit_overrides:` now really switches the scan off.** That form never matched; now `off`, `false`, `no`, the Russian "none" and `disabled` all work.
- **Checker report templates follow one contract** (`references/checker-report.md`): the figma-compare, proto-compare, dead-code, deps-audit, i18n-sweep and ds-parity templates got the `Findings: …` summary line and the "Could not verify" section. devtools-verify got a template of its own.
- **Stricter gates for older tasks.** These change the behavior of the journal and Force-run hooks for tasks that already exist:
  - Lifting a blocker with "user decision" or "user answer" (and the Russian forms of both) now needs a date or a quotation of the answer next to it.
  - A finding outcome in the future tense or with a negation ("will be fixed", "not fixed") is no longer counted as fixed.
  - A Force run heading whose date is neither ISO (`YYYY-MM-DD`) nor day.month.year now needs a `Confirmed:` line, like a heading with a readable date.
  - A PASS line needs its evidence within 300 characters of the criterion id.
  - The gates are faster on long files: the cubic-time regex that looked for `Confirmed:` is gone.
- CI: `validate.mjs` checks that every "/skill, Step N" reference leads to an existing step or section, and fails on Cyrillic outside the allowlist (`scripts/cyrillic-allowlist.json`) with the path and the line.

**What to do on upgrade:** nothing. If you want a default language for new tasks, add `language: ru` or `language: en` to `pipeline.config.md`.

## 0.15.2 — 2026-10-16

### devtools-verify finds the plugin's chrome-devtools

Claude Code exposes the tools of servers from the plugin's `.mcp.json` with a prefix: `mcp__plugin_stage-pipeline_chrome-devtools__*`. devtools-verify and pipeline-doctor looked for `mcp__chrome-devtools__*`, so they could not find the plugin's server, and the check fell into a skip "MCP not connected".

- **devtools-verify** (skill and agent) loads the tools by the name with the plugin prefix. A developer with their own `chrome-devtools` server keeps the old `mcp__chrome-devtools__*`. To reconnect — `/mcp reconnect plugin:stage-pipeline:chrome-devtools`.
- **`/pipeline-doctor`** checks `mcp__plugin_stage-pipeline_chrome-devtools__list_pages` (or `mcp__chrome-devtools__list_pages` for your own server).

Nothing to do by hand on upgrade.

## 0.15.1 — 2026-10-05

### Force starts right after the interview answers

After the answers to the batch, the run showed a summary and waited for a separate "yes" — a second stop where the user had already said everything. Now the answers to the batch are the start:

- **`/stage-force`, Step 0.** What used to go into the confirmation moves into the batch itself: files to be deleted — by name in the question about boundaries; an ambiguous free-form answer or a narrowing of scope against the ticket — straight away as a clarifying interview question. An unambiguous free-form answer is echoed back in the start message, without a question.
- **agent-guard** still does not let `stage-implement` start without a `Confirmed:` line in the "Force run" block, but the orchestrator writes it itself — `Confirmed: <date> — interview answers` — and the rejection no longer tells it to ask for a "yes".

## 0.15.0 — 2026-10-05

### An error is not built into the plan, the look comes from the kit and neighbors, CI gates join the final checks

The second half of the review of the same three tasks. A checker honestly checks what the criterion says, so an error built into the plan passes every check:

- **"Like X" without X.** The decision "like the expert" (for the expert, "Save" is active even without a status change) became "as it is now in the drawer" when the stage was opened — the form could not be saved without changing the status. Another criterion fixed the defect as the norm ("with an incomplete form, saving is stopped") and passed every checker.
- **The look from the prototype, not from the kit and neighboring sections.** The criteria required "uppercase 11px extrabold" and "buttons 12/700". The prototype matched the code, the comparison gave PASS, and "too bold", "different buttons", "another table" were returned by the user in three waves of fixes.
- **Removed UI without parity.** A removed section took six functions with it; the parity reviewer brought them back. On one screen — three dictionaries of statuses.
- **Project gates outside the pipeline.** The smoke test from the "CI gates" table of the config was not in the final checks and failed only on the PR. The task's fix went to dev under someone else's ticket, the evening commits bypassed the journal.

What changed:

- **Plan and criteria** (`/stage-plan`, Step 3; `/stage-kickoff` — the criteria gate is now eight questions).
  - "Like X", "as it is now", "as it was" carries the `path:line` of the sample. A new criterion or decision line without a path is returned by journal-gate.
  - An action with conditions (saving, sending, changing status) — a table "state × action → what goes to the server, what the user sees". In force it is shown in full in the interview.
  - A stage that removes or replaces UI gets a parity table "was → where it is now / removed by decision", the rows are criteria `AC-N.P*`. A force commit that removes a component whose name is not in the table is rejected by git-guard. task-converge checks the parity rows and catches different labels of one status on a screen.
- **The look — from the kit and neighboring sections.** A UI stage gets a "Visual reference" line — a neighboring section of the same app. For a prototype, by default the structure, texts and behavior are taken from it, while typography, buttons, tables and spacing come from the kit and the reference; "as in the prototype" — only by user decision. In Figma projects the truth is in the mockup, but a kit override is still a finding.
  - `scripts/kit-override-scan.mjs` writes a `kit-overrides` report at every UI stage: every file with `font-bold`, `uppercase`, `text-[…]`, `rounded-[…]`, `max-w-[…]`, `!important`, kit variables — major, with a "Findings outcome". A force commit with such overrides and no report is rejected by git-guard. On the commits of that task the scan names exactly what was redone later, including the forced `--button-font-weight: 700`.
  - devtools-verify compares the new section with the reference one by the script `skills/devtools-verify/references/style-probe.js`: font, size, weight, case, tracking, height of buttons and table headers. journal-gate requires `style-diff` lines for a stage with a "Visual reference".
  - proto-spec and proto-compare take the look from the kit and the reference; code that matches the prototype but not the kit is major.
- **CI gates.** The "## CI gates" table of the config or `e2e`/`smoke` lines in Commands make a final check `ci-gates` (`scripts/ci-gates.mjs --run`). `run-check.mjs` records the result by the commit tree. A Force block is not closed as "completed" until every gate is green on the current HEAD; a gate that does not run locally is a blocker and "completed with blockers". The gates go into the run summary. `/pipeline-doctor` compares the gates with the CI files and proposes a table; the plugin does not run commands from CI files itself.
- **Work outside the journal.** session-start recognizes a commit by its content (patch-id), not only by SHA and title, looks at all the task's branches (from the header and with the ticket in the name; those merged by squash are skipped) and at the integration branch in the first 14 days after closing — your commits in task files under another ticket. On live repos this is exactly one task's fix under someone else's ticket and an edit of a card after another task's closing; a commit rebuilt without a signature is no longer a false alarm.

### ⚠ What to do on upgrade

- Nothing in old tasks: the rules look at new journal lines, new reports and new run closings.
- In a project with gates in CI — `/pipeline-doctor`: if smoke or e2e run on a PR and are not in the config, it proposes a "## CI gates" table. Without it the gate rule stays silent.
- In the kit's own repo — the line `- kit_overrides: off` in `pipeline.config.md`; a kit directory inside an app goes as a path in `ui_lib`, the scan does not touch it.

## 0.14.0 — 2026-10-05

### A checker finding cannot be deferred, the unverified is visible in the summary, the runtime checker looks at its own frames

Three tasks in three repos were reviewed: what the user fixed after "done" and at which link it got through. The code the maker writes is the smaller part of the losses. The main points:

- **The finding was not fixed but deferred.** The checker found a defect, and the orchestrator wrote "leaving it", "accepted as a compromise", "to Awaiting user confirmation", "question for the designer". In one task 5 of the 8 defects found by the user passed this way, in another 11 of the 12 deferred findings later had to be fixed. 0.13 made it worse: the rule "decide the reversible yourself" began to apply to findings too.
- **The unverified was counted as verified.** "No data on the stand", "[live: user-side]" (46 times in one task), "✅ (dark theme not captured)", a "could not verify" that was never carried anywhere. The final message chose what to show, and defects lay under "minor deviations".
- **The runtime checker measured the wrong thing and did not look at the frames.** A clipped badge — the only real defect of one task — was on a frame nobody opened: 12 frames captured, 2 opened. A country name in three lines stuck out of the card in the checker's own screenshots. The user took the focus ring from a synthetic click for an extra blue border.

What changed:

- **Findings outcome** (`references/checker-report.md`).
  - A checker report starts with the line `Findings: critical N · major N · minor N`. A FAIL on a criterion is also a finding.
  - After the fix-loop the orchestrator appends `## Findings outcome` to the report: for every critical/major finding and FAIL — "fixed", "false" with evidence, or a blocker `B<n>` (in the normal mode — a user decision). "Leaving it", "to Awaiting user confirmation", "not fixing", "long-standing" without a check on the base do not count as an outcome.
  - journal-gate returns such outcomes at once. git-guard does not let a force commit of a stage with findings without an outcome through. A force block cannot be closed as "completed" with open blockers or findings without an outcome.
  - In `/stage-force` a checker finding is not a fork: it is fixed, and if that fails — it is a blocker. "Decide yourself" — only for product decisions without a defect.
- **The unverified.**
  - journal-gate returns ✅ with a caveat ("not captured", "code only", "partly") and "not verified, no data" without an attempt to put the state in place.
  - `scripts/run-digest.mjs` assembles the run summary from the journal and reports: blockers, findings without an outcome, everything unverified, minor without an outcome, "accepted on its own". A hook puts it into the context when a force block is closed, and it goes into the final message in full.
- **devtools-verify.**
  - Geometry of new nodes at every width by a script (`skills/devtools-verify/references/geometry-probe.js`): overflow, text in 3+ lines, zero gap to the container edge, clipping by the window, current focus. The report has a line `geometry <width>: …`.
  - Every new menu and modal is opened by the checker with a real click and captured open, with focus removed before the frame. In the fallback — `page.click`, not `el.click()`.
  - "No data" is not a reason: the state is put in place by a stub, a fixture or an intercept for reading only, with no writes to the stand.
  - The **frames-guard** hook (SubagentStop) does not let devtools-verify finish until it has opened every frame it captured. On live transcripts of one repo, 12 runs out of 14 ended with unviewed frames.
- **The other checkers** write the summary by the same contract. For ds-parity a self-made copy of a kit component and an override of its style are major.

### ⚠ What to do on upgrade

- Nothing in projects and old tasks. A task the plugin has already seen remembers the current journal lines and the moment at the new version's first look. An outcome is required only for reports written after that moment. 0.12 violations that appeared earlier and were not fixed still remind you of themselves.
- `node scripts/journal-check.mjs <task> --ledger` shows how many findings in an old task are left without an outcome.
- Reports get a little longer (summary, outcome, `geometry` lines), and devtools-verify a little slower: it opens every frame of its own.

## 0.13.0 — 2026-10-03

### Force does not stop in the middle

A review of two live force runs of one repo showed where the pauses come from.

- **The run of 2026-10-03.** After the start there was not a single question, but the run stood twice, for 22 and 37 minutes. Subagents shut down the servers they had started with `pkill -f …`, but `Bash(pkill *)` is in `ask` of the permissions profile, and ask beats allow even in auto mode. The whole run waited until the user came back and pressed "yes".
- **The run of 2026-09-29.** Two questions in the middle of the run:
  - whether to delete files, although deletion was a criterion of the agreed plan: the auto mode classifier rejected `git rm` from a subagent, and the orchestrator turned the rejection into a question;
  - whether to open the needed file in Figma desktop: the environment was checked not at the start but at a stage.

Now after the run is confirmed there are no questions at all.

- **`/stage-force`, Step 2.** Every fork has two outcomes:
  - the reversible one the agent decides itself and records in "⚠ Awaiting user confirmation" with the price of rollback;
  - what cannot be decided for the user becomes a **blocker**. This is an irreversible fork, a conflict of sources, missing access, an exhausted fix-loop with a critical, a red build, a missing stage, a permission rejection. A blocker is written as a line `B<n>` in `Blockers:` of the Force run block, the blocked criteria are marked `[blocked: B<n>]`, and everything that does not depend on the blocker is finished and committed.

  The run ends early only if nothing unblocked is left. In the summary the blockers come first, with a recommendation. A block with open blockers is closed as "completed with blockers". A new `/stage-force` starts the interview with answers to the blockers.
- **The interview** got a category "Environment and access": the file in Figma, the logged-in profile, writing to the stand, the backend contract, ports and other people's dev servers are checked at the start. The confirmation message names, by name, the files the plan deletes.
- **The force-guard hook.** Before a Bash command in a force run it rejects at once, with an explanation, what would stop at a confirmation:
  - `pkill`/`killall`;
  - subcommands under `ask` in `~/.claude/settings.json` and project settings.

  The agent shuts down its own process by PID and records the rest as a blocker. Outside force the hook is silent.
- **Processes.** `stage-implement` and `devtools-verify` shut down what they started themselves, and only by PID (`… & echo $!` → `kill <PID>`). They do not touch the user's server. A permission rejection in `stage-implement` is returned as a blocker with the exact command, and a fork — as options with a recommendation, without stopping the stage.

### ⚠ What to do on upgrade

- Nothing in projects and old tasks. A running force run picks up the hook after Claude Code is restarted.
- `Bash(pkill *)` can stay in `ask`: in force it will not get that far, and in the normal mode the question is a normal part of the work.

## 0.12.1 — 2026-10-03

### `/task-wrapup` and `/pipeline-init` — manual only

Both skills are marked `disable-model-invocation: true`. The model does not call them itself, and their descriptions no longer
sit in the context of every session. They start only by command.

- **`/task-wrapup`.** A PR description is needed not for every task, but force wrote it at the end of every run.
  Now after the final checks force ends with a summary with the line "The description — /task-wrapup, if
  needed". The `wrapup` item is removed from the "Final checks" template in `/stage-plan`. In old STAGES.md
  force skips this line.
- **`/pipeline-init`.** It writes `pipeline.config.md` and edits the user-scope `~/.claude/settings.json`.
  Such a thing must not start in the middle of a task because of the phrase "set up the pipeline".

### ⚠ What to do on upgrade

- Nothing in projects and old tasks.
- The phrase "write the PR description" no longer starts the skill. If you need a description — type `/task-wrapup`.

## 0.12.0 — 2026-10-02

A review of seven live force runs on 0.11 in four repos:
about 53 losses, and almost none at the step where code is written. The maker on sonnet most often names itself
what it did not do, and of its six false "done" five were caught by checkers. The losses happened around it: in the plan and interview,
at checkers that did not run or closed a criterion by reading the code, and at the orchestrator, which
forgot the rules written only as text. The final whole-branch review went to sonnet 5 times out of 14, the confirmation
of a run in one task was skipped three times, "✅ pro-review by code" stands on 24 runtime criteria of one task,
and two of them the user later found broken. The rules that already lived in hooks (floor-guard, git-guard)
worked. So 0.12 moves the next batch of rules from text into hooks.

### ⚠ What to do on upgrade

- Nothing in projects and old tasks. The new journal checks look only at lines that did not exist
  when the plugin first saw the task. Force blocks opened before 2026-10-03 do not require confirmation lines.
- A new force run: before the first stage the agent asks one confirmation and writes it into the block as a line
  `Confirmed: <date> — <answer>`. Without it `stage-implement` will not start.
- If you commit from under an agent in a repo with the pipeline — the `Co-Authored-By` and "Generated with …" signatures in the message
  are now rejected by a hook (the rule from `/stage-check`, Step 4.4, used to be held by text only).

### Journal: a criterion is closed by the checker in its tag

- **The journal-gate hook** (after an edit of STAGES.md or of a report in `checks/`) returns to the agent in the same turn:
  - a criterion with `[verify: devtools-verify|figma-compare|proto-compare]` is closed ✅, but the result names another
    verifier or none. Honest forms pass: `✅ devtools-verify (…)`, a smoke run, "verified live"
    for runtime, `⏳ devtools-verify`, `[live: user-side]`, "by user decision";
  - the result names a checker, but there is no report from it in `checks/`;
  - a design checker is skipped for a browser reason ("staging does not accept the token", "MCP-Chrome is busy") — the
    code ↔ mockup comparison is static;
  - PASS in a report without a measurement ("4.5 PASS"): a summary at the top of the report is not a violation if the criterion has details below.
- The task snapshot is in the plugin data directory (`CLAUDE_PLUGIN_DATA`), made by session-start. A violation
  that appeared after the snapshot reminds you of itself on every journal edit until it is fixed.
- `scripts/journal-check.mjs <task_dir>/<TICKET>` — the same rules over the whole task, including the archive. On the live
  58 tasks: 38 criteria and 5 reports, all real violations (24 of them from one task).
- `/stage-check`: proto-compare — a row in the table of checkers (before, the substitution was described only in the README, and in one
  task the design checker never ran); a design checker skip — only logic-only or no design source, by the fact of the diff,
  not in advance in the plan.

### Subagent launch: the review model and run confirmation

- **The agent-guard hook:**
  - a whole-branch `pro-review` without `model` equal to `review_model` from the config (`opus` by default) is rejected.
    The model was passed as a parameter and got lost: the first review of a run went to opus, the review of a neighboring branch or
    after a catch-up — to sonnet from the agent's frontmatter. On the history the hook would have stopped exactly these 5 calls;
  - `stage-implement` in a force run does not start until the block has a `Confirmed:` line.
- `/stage-force`, Step 0: in the confirmation message every free-form answer — as an echo "understood "…" as …", a narrowing of scope
  against the ticket — with a quote from the ticket. Without the echo free-form answers became the narrowest option: "return it to the
  webview" → "do not touch master", "the current branch" → a branch from release instead of dev.

### Commits: signature, second repo, work after force

- **git-guard** rejects a commit with a service signature on any branch of a repo with the pipeline — in the command text, heredoc
  or `-F` file. The skill's rule lost to the system instruction about attribution: three manual rebuilds of branches in two
  tasks, the last one left a hotfix branch on the dev base instead of master.
- **A task across two repos:** STAGES.md lies in the task directory of one repo, and the hooks of the second did not see it — the agent's commits
  in the webview went past the normal mode and floor-guard. Now session-start keeps a registry of task directories, and a task
  from a neighboring repo counts as its own when a ticket like `ABC-12` is in the branch name and STAGES.md names the repo
  by name. A single line `Branch: master` of someone else's task is not enough for that.
- **session-start** after a closed force names the branch commits that are in neither STAGES.md nor PR.md. The base is
  the nearest integration branch, PR merge and squash commits do not count. `/stage-force`, "Exit": an edit after
  "completed" is a catch-up stage, not "I'll quickly fix it".

## 0.11.0 — 2026-09-24

A revision of 0.9–0.10 on live tasks: hooks and state scripts were run over ten repos and 90 STAGES.md.
It turned out that they were written for a "correct" STAGES.md, but live files are built differently: in three repos the hooks
were silent, in one they blocked all commits because of an abandoned task, and parallel tasks got in each other's way.
Hence the release rule: the plugin reads configs and STAGES.md as they are, and looks only at the task
of the current branch. And Context7 is removed from the plugin: library APIs are checked against the installed package.

### ⚠ What to do on upgrade

- Change nothing in projects and old tasks: the forms that used to break hooks are now understood as they are.
- Force runs before 0.11 were closed not by the block heading but by the status line ("force run … completed") — such runs
  the hook counts as closed itself. A finished run that has neither, on a branch where you still work, close
  with a mark `— completed <date>` in the heading `## Force run <date>` — otherwise the agent commits on its own there.
- On a machine with RAM ≤ 16 GB the heavy checks of all projects run one after another (`run-check.mjs --mode` shows the mode);
  if you do not need that — `- resources: normal` in `pipeline.config.local.md`. `lint_files`/`test_related` in the project config are
  optional: without them the whole project runs at a stage, but once, not after every edit.
- `CONTEXT7_API_KEY` is no longer needed — the line can be removed from the shell profile. The permission
  `mcp__plugin_stage-pipeline_context7` will be shown by `node "$PERMS" --check` as outdated, the entry
  `plugin:stage-pipeline:context7` in `~/.claude/mcp-needs-auth-cache.json` is harmless.
- `/pipeline-doctor` now checks `main_branch` against where branches are actually merged. If features go into `dev`
  and the config says `main`, the whole-branch review and `floor-guard --base` will pick up other people's merged PRs — fix one
  line when the next task starts in this repo.

### Heavy checks — by the stage diff, one at a time per machine

`lint`, `type_check`, `test` and `build` from the config run over the whole repo, and they ran after edits, in implement,
again in `/stage-check`, in every round of the fix-loop — and in parallel with the dev server and the browser. On a weak
machine and with 3–4 parallel projects a stage hit the CPU and swap.

- **`scripts/run-check.mjs -- <command>`:**
  - `{files}` / `{files:ts+vue}` — the changed and new files of the stage; if there are none, the command does not run;
  - the `low` mode (RAM ≤ 16 GB or `resources: low` in the local config) — runs of all the machine's projects go
    one after another through a shared lock and with `nice`;
  - git commands do not run through the wrapper: a hook would not see them there.
- **The rule — in one place** (`references/heavy-checks.md`):
  - during edits — nothing;
  - at the end of implement and of every fix-loop iteration — `lint_files` and `test_related` by the diff, `type_check`
    once for the whole project (errors are born in other people's files too), `build` — only if the stage touched the manifest or
    the build config;
  - `/stage-check` does not repeat the run if the tree has not changed;
  - everything in full — a new item `full-checks` of the final checks.
- **The dev server in `low`** is started only for the time of devtools-verify: first the heavy checks and the static
  checkers, then the server. Only your own is shut down, a background one, not `pkill`.
- `/pipeline-init` finds `lint_files`/`test_related` (eslint/biome/ruff, vitest related/jest --findRelatedTests),
  `/pipeline-doctor` shows the machine mode. In root-cause the red test runs as a single file, not the whole `test`.
- A stage is "committable" when type_check and the diff checks converge; `build` is no longer required at every stage.

### Context7 removed — library APIs from the installed package

Context7 from 0.8.0 required a key or OAuth from every developer, silently switched itself off without it (Claude Code
caches the server as needs-auth) — and on the author's machine it never worked, and the pipeline did not notice.
Besides, it gave documentation of "about this version", while the exact version lies in the repo.

- `docs-lookup` answers from the installed package of the version in the lockfile: types (`.d.ts` — signatures, options,
  `@deprecated`; an export not in the types is not in the version), the package's `CHANGELOG.md`/`README.md` (breaking changes, migrations),
  the source (behavior). If that is not enough — the official documentation of this version through WebFetch. Package not installed
  and no network — "not verified" in three lines, with no claims from memory. Offline, without a key.
- `deps-audit`: deprecated and the successor — `npm view <pkg>@<version> deprecated` and `time`, the API — from the package types.
- `pro-review`, `/root-cause`, `stage-implement`, `/stage-kickoff` — the same rule "check against the installed version,
  not against memory", another source. Removed from `.mcp.json`, `/pipeline-doctor`, `/pipeline-init`, ROLLOUT and README;
  from the machine now only `npm view` and WebFetch of docs on allowed domains go out.
- eval: `docs-lookup-version-mismatch` goes against a `node_modules` stub (react-router-dom@6.22.3: types and CHANGELOG
  v6), `docs-lookup-no-context7` → `docs-lookup-not-installed`; the harness skips a case if it asks for an MCP server
  that is not in the plugin.

### Hooks look only at the current branch's task

- **Before:** any repo task with `[status: in-progress]` rejected `git add`/`git commit` across the whole repo and on any
  branch. The "Force run" block of any task allowed auto-commit to everyone. On live repos: a task abandoned a month and a half
  ago blocked commits, and a merged force task lifted the ban for neighboring ones.
- **Now:** a task is bound to a branch. First the ``Branch: `<branch>` `` in the STAGES.md header is looked at: `origin/…`,
  SHAs and tails like "branched from `dev`" / "→ PR into …" do not count, but an explicit `Branch: master` in a repo without a PR flow does.
  Without this line — the ticket in the branch name.
- **The stage status does not matter:** the task branch is guarded as a whole. Before, the hook fired only on `[status: in-progress]`,
  which no skill sets, and `/stage-check` closes a stage in STAGES.md before it prepares the commit — exactly the stage commit
  slipped past the hook: in the normal mode the agent committed itself, in force — without floor-guard.
- **floor-guard on a force commit — by what will go into the commit:** the index, paths from the `git add` of the same command
  (taking `cd` into account), all tracked files with `-a`/`-u`, the whole tree — only with `git add -A` without paths. Before, everything
  untracked was looked at: a saved PR page with minified JS in the repo root rejected any force commit,
  and the hook told you to fix it as a fix-loop finding.
- A STAGES.md that has not changed for 21 days is not seen by the hook. You came back to the task — the first kickoff or check updates the file.
- A worktree without `.claude/` takes the config from the main tree.
- `cd ../kit && git commit` and `git -C ../kit commit` are checked against the state of the repo the commit goes to.
- The "Force run" block is closed by the word "completed" in the heading, `/stage-force` does this on exit.
- The command is parsed by a lexer:
  - `grep "git add"`, a heredoc and a commit message with the words "git commit" are no longer rejected;
  - `git -c k=v commit` and `git --no-pager commit` no longer bypass the check.
- `task_path` is understood in backticks, with `~` and with the placeholder `<TICKET>/`. The statuses `in-progress — …` and
  `in progress` are recognized.
- session-start shows the current branch's task first and up to two recently touched. It reminds about collapsing
  only when archiving will really shrink the file: before, the hook and the archiver measured in different units, and the reminder
  never went out.
- A floor-guard that crashed or did not finish in time is no longer read as "violations": the commit passes,
  the user sees a warning.

### floor-guard — no dead ends in force

On branches of live repos — up to 25 false violations per repo. In force some of them would have blocked a commit,
and there was nowhere to justify an exception (for example, in JSON).

- A test is determined by the file name, not by a `test/` segment in the path: a domain module "tests" was read as deleted tests.
- A deleted test is not a violation if the code under test was deleted with it or the test was moved.
- A removed assert counts as moved only if the same line appeared in another test file of the diff: a test
  split across two files does not make noise, while a plainly removed assert is visible even in a large branch.
- `.catch(() => null | undefined)` is not a stub. An empty catch and a type cast in tests and mocks are not a violation.
- `# noqa` and `# type: ignore` count as suppression only if the repo has a Python linter or type checker.
  With a reason (`# noqa: BLE001 — reason`) — a justified exception.
- Coverage thresholds are looked for only as keys in test runner configs, the baseline — only in the pipeline config.
  Dependency versions in `package.json` are no longer "thresholds".
- Secret placeholders (`…EXAMPLE`, `XXXX`, `0000`) do not count as a secret; `model.fit()` is not a test focus.
- What used to be silently skipped:
  - a path with a space — the rules were not applied;
  - `diff.mnemonicPrefix`, `diff.noprefix`, `diff.renames` in the developer's git config broke paths;
  - a new `floor-ok-file:` in a production file silenced the whole file. Now the marker works in tests and fixtures
    or if it was in the file before the diff.
- A crash on a nested repo, a submodule, a symlink to a directory or on a diff over 64 MB — now exit code 2, not 1.
- `--pathspec-from-stdin` — only the passed paths (this is how the hook calls it). Without it, violations in untracked files
  are marked "not in git": a file the stage did not create is a line in the summary, not a fix-loop finding.
- `scripts/floor-guard-test.mjs` — 32 cases, 15 of them forms from live repos. The previous version fails 12.

### archive-stages and retro — by live files

- **Archiving checked on copies of 90 STAGES.md:** not a single line lost, a repeated run changes
  nothing. Compression: 273 → 97 KB, 188 → 92 KB, 174 → 86 KB.
- **The unclosed stays in STAGES.md.** 0.10 carried a closed stage's unclosed items to the archive together with it:
  on live tasks that is 322 lines of `- [ ]`, `⏳` and `[live: …]` that kickoff then does not see. Now they all stay.
- Dates `DD.MM.YYYY` are understood. Before, in a journal with such dates the freshest entries went to the archive and the old ones stayed.
- A journal heading with a tail (`## Journal (newest first)`) is found.
- `###` subheadings in the journal stay in place; a group from which all entries moved out moves out with its text.
- In a collapsed stage `Decisions:`, `Commit`, `- [x] commit:`, unclosed `- [ ]`, `[live: …]` and `⏳` stay.
- Stages inside the "Force run" and the "Journal" are not touched. "CANCELLED" is a closed status. The size is counted in bytes.
- **`metrics:` is written to the journal, and `retro.mjs` looked for it in the stage block** — of N stages one was counted.
  - The line now has `stage=N`; for old entries the stage is taken from the journal entry itself.
  - `diff=+A/-R`: size buckets — by added lines.
  - `diff=—` no longer crashes the script; `### Stage 2.1` is a separate stage.
  - Reports with old names (`deps-`, `i18n-`, `converge-`) are counted.
- `scripts/hooks-test.mjs` — 82 checks of hooks, commit scope, header parsing, archiving and retro, run in CI.
  Before, there was not a single test for these scripts, and almost all the defects found sat exactly in them.

### Texts — shorter and without contradictions

- **The "Excuses" tables are removed** from stage-check, stage-force and stage-implement: the rows repeated the rules of the same
  files. The only new rule — "severity is set by the checker; an exhausted fix-loop with a critical is an escalation" —
  was moved to stage-check, Step 3. Size: stage-check 30.1 → 29.5 KB, stage-force 20.9 → 19.6 KB,
  stage-implement 6.6 → 5.4 KB.
- **Force is faster:**
  - `lint`, `type_check` and `floor-guard` are run by `stage-implement`, the orchestrator takes the result from the summary — if it has
    numbers against baseline; "green" without numbers — it runs `type_check` itself (the hook only checks floor-guard);
  - the fixed is re-checked pointwise by `file:line`, a checker subagent — only for visuals and runtime;
  - a red test before the fix — only in the root-cause scenario.
- `review_model` is defined in one place (stage-check, Step 3.3) and always goes to opus by default: the last
  check — by the strongest model. In the normal mode what matters is the subagent's fresh context, not a change of model.
- The reports of all checkers — `<checker>-<stage>.md` / `-branch.md`. The dedup-pass is merged with the whole-branch pro-review.
  `/compact` is no longer described as an action of the model.
- `root-cause` is found by the phrase "the fix did not help — figure it out": the open finding of 0.10.0 is closed.
- `/pipeline-init` looks for `bundle_size`. ROLLOUT — a "Hooks" section.
  The cheatsheet and the deck: `stage-implement` in the table of agents, the repo is public.
- CI:
  - validate sees "21 skills" and "22 skills", does not take SHA-256 and ISO-8601 for tickets, checks the `headersHelper` path;
  - routing requires at least one phrase for every skill;
  - release-check requires the version to grow, not just change.


## 0.10.0 — 2026-09-24

A comparison with [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills): what was taken from there is
not skills but mechanisms the pipeline did not have — a quality floor that cannot be lowered silently, a check of skill
routing, a second opinion from a different model, and explicit excuses. Whatever a script can run, a script runs.

### ⚠ What to do on upgrade

- **Restart Claude Code** — the `git-guard` hook now runs `floor-guard` on the force commit.
- **`review_model` in `pipeline.config.md`** (section `## Models`) — the model for the whole-branch `pro-review` and for
  the fresh checker run. If the field is missing, `opus` is used. Add it by hand or regenerate with `/pipeline-init`.
- **The `metrics:` line** got the fields `floor=` and `diff=`; `retro.mjs` reads old entries as before.

### `floor-guard` — the quality floor cannot be lowered silently

`scripts/floor-guard.mjs` looks at the diff (working tree + untracked files against HEAD, or the whole branch with
`--base origin/<main_branch>`) and catches moves toward green that do not fix anything: a silenced checker (`@ts-ignore`,
`eslint-disable` without a reason), `as any`, `.skip`/`.only`, a removed assert and a deleted test, a stub and an empty
`catch`, a loosened tsconfig/eslint/coverage threshold, a raised `baseline` in the config, a secret in the code (the value
is not printed). Exit code 2 means "could not look", not "clean". A justified exception is `floor-ok: <reason>` or an
idiomatic `eslint-disable … -- reason` / `@ts-expect-error reason`: it is not a violation, but it is printed separately
and goes to "⚠ Awaiting user confirmation"; `@ts-ignore` and secrets are never an exception. A file with intentional
defects (test fixtures) gets `floor-ok-file: <reason>` in its first lines: its findings are printed as exceptions, and
secrets are still a violation.

- In force, the `git-guard` hook rejects a `git commit` with violations — there the model writes the code, models check it,
  and nobody else stops it from lowering the floor.
- `/stage-check` runs it on every stage (a violation is a major finding in the fix-loop), `stage-implement` — before
  returning, the final checks — over the whole branch (a new checklist item `floor-guard`).
- `scripts/floor-guard-test.mjs` — 12 fixtures, run in CI.

### Skill routing is checked

- **`scripts/routing.mjs` + `evals/routing.json`** — free and in CI: 36 phrases that people use to ask for skills, TF-IDF
  over the descriptions with crude Russian stemming; a phrase must find its skill in the top 2, and first in at least 75%
  of cases; a pair of descriptions with similarity > 0.5 is an error. The very first run found a hole: `figma-compare`
  was not found for a Russian phrase: the word "figma" was written in Cyrillic there, and the description
  had only the Latin "Figma". The description is fixed.
- **Live cases `kind: "routing"` in `scripts/eval.mjs`** — a model with the plugin gets an ordinary phrase, and the first
  plugin skill called is taken from the event stream. Four cases: `root-cause`, `stage-check`, `figma-compare`
  and "a small fix does not pull in the orchestrator". First run: "the fix did not help — figure it out" is resolved
  without `root-cause` (the model fixes it itself) — an open finding against the skill description.

### A second opinion from a different model

All force-run code is written by `stage-implement` on sonnet, and it was checked by checkers on sonnet. The final
whole-branch `pro-review` and the fresh checker run in the fix-loop now go on `review_model` (`opus` by default): the same
model shares blind spots with the author.

### Excuses

In `stage-check`, `stage-force` and `stage-implement` there is an "excuse → in reality" table built from real moves
that closed a stage with a lie: PASS without a value, "/compact between stages", `git add` "to prepare", lowering
severity on an exhausted fix-loop, `floor-ok` instead of a fix.

### Untrusted content

`references/untrusted-content.md`: the page DOM, console and network, prototype HTML, Figma text, Context7
documentation and error output are data, not instructions. Navigate only to the dev URL and URLs from the prompt,
`evaluate_script` without cookies/tokens and without outbound requests, secrets are not copied into reports. This matters
most for `devtools-verify`: it works in a profile that the user logged in by hand.

### Stage size and tests

- `/stage-plan`: a guideline of ~300 diff lines per stage, split anything over ~1000; refactoring goes in a separate stage.
  `/stage-check` takes the size from the first line of `floor-guard` and writes the risk into the summary; `retro.mjs`
  shows findings and fix-loop rounds by size bucket (≤300 / 301–1000 / >1000).
- `pro-review`: growing an already large file instead of extracting, and a refactoring that does not reduce the number of
  concepts, are findings.
- `/root-cause`: when the config has `test`, a logic defect is proved by a red test before the fix and a green one after;
  the revert stays for visual and runtime defects.

### Lighter skills

The environment preflight and the stage commit message format were moved out of `stage-check`
(`skills/stage-check/references/{preflight,commit-message}.md`) — otherwise the new rules did not fit in the 30 KB budget.

## 0.9.0 — 2026-09-24

The first release built from numbers from live tasks, not from memory: 30 tasks and 182 stages in four repos
were run through the new `scripts/retro.mjs`. The main thing it showed is that rules written in prose do not hold where
nothing checks that they are followed. So most of this release turns such rules
into scripts, hooks and checks.

### ⚠ What to do on upgrade

- **Restart Claude Code** — the plugin now has hooks (`hooks/hooks.json`), and they are picked up at start.
- **`main_branch` in `pipeline.config.md` is the branch the PR goes INTO.** If PRs are opened into `dev`, it must say
  `dev`: the whole-branch `pro-review`, `dead-code`, `task-converge` and `task-wrapup` are computed from it.
- **Bloated STAGES.md** — run `node "$PLUGIN/scripts/archive-stages.mjs" <task_dir>/<TICKET>/STAGES.md`
  (without `--apply` it only shows). The SessionStart hook will remind you itself if the file is larger than 40 KB.
- **The team should reread ROLLOUT.md**: Context7 is an external server, the section "What to know before the rollout" is extended.

### The final whole-branch `pro-review` is really whole-branch

The `pro-review` agent was hard-limited to the stage diff — the final run through the agent reviewed not the branch
but the last stage. Now the agent has two modes: stage (the default from `/stage-check`) and whole-branch (the final one
before the PR). The whole-branch base is `origin/<main_branch>` after `fetch`: a stale local `dev` pulled other people's
merged commits into the diff. In `/stage-force` the final checklist did not contain the whole-branch review at all —
it is added.

### `/stage-force` does not accumulate context between stages — the `stage-implement` subagent

`/stage-force` told the model to "run `/compact` and go on to the next stage", but `/compact` is a user command:
the model calls it neither as a tool nor from a hook, and the step was silently not executed — the context grew through
the whole run until Claude Code itself compressed it on overflow. Now the stage code is written by a new agent
**`stage-implement`** (maker, clean context), and the fix-loop rounds are run by the same agent in fix mode; the
orchestrator holds only STAGES.md and summaries. This is the same mechanism that already worked for checkers. In the
normal mode `/clear` is still suggested after a stage — the user types it, and the session-start hook orients the new
session.

### ⚠ Context7 requires a key — the promise "works anonymously" from 0.8.0 is no longer true

Hosted Context7 without authorization answers `401 Authentication required` already on `tools/list`, and Claude Code,
after such an answer, caches the server as needs-auth (`~/.claude/mcp-needs-auth-cache.json`) and silently does not
connect to it. The result — checkers worked without a warning in the "not checked against the docs" mode. A free key
`ctx7sk-…` is needed (`export CONTEXT7_API_KEY=...`), or OAuth through `/mcp`. `context7-headers.mjs` now
sends the standard `Authorization: Bearer <key>`; `/pipeline-doctor` checks the key with curl and finds a stuck entry in
the needs-auth cache; ROLLOUT puts the key into developer onboarding. Found by a `docs-lookup` eval run: without access
to Context7 the agent gave 58 lines of an answer from memory instead of "unavailable" — the agent contract is tightened
(no more than three lines, not a single claim about the API).

### Agent models — by measurement, not by role

The scheme "orchestrator — Opus, implementer — Sonnet, checkers — Haiku" was tested on eval cases, 3 runs per
variant (`eval.mjs --runs 3 --model <agent>=<model>`):

| Agent | Sonnet 4.6 | Haiku 4.5 | Sonnet 5 (1 run) |
|---|---|---|---|
| `deps-audit` | 3/3, $0.20 | 3/3, $0.08 | 1/1, $0.29 |
| `docs-lookup` (Context7 unavailable) | 1/3, $0.11 | 3/3, $0.03 | 1/1, $0.14 |
| `i18n-sweep` | 3/3, $0.19 | 2/3, $0.07 | 1/1, $0.29 |

- **`deps-audit` → `haiku`.** No worse than Sonnet, 2.5 times cheaper.
- **`docs-lookup` stays on `sonnet`.** On the "Context7 unavailable" branch Haiku first looked better, but with a key the
  main path showed the opposite: of 9 runs with Context7, Haiku had 4–5 substantive errors (a version from the manifest
  range instead of the lockfile, a contradiction with the code not named, once — a clarifying question instead of
  work, and a subagent has nobody to answer it), Sonnet had 2 (version/lockfile). The contract is tightened: no questions,
  an answer up to 40 lines, the version only from the lockfile. The spread between series of 3 runs is large — the same
  variant gave 1/3 and 3/3 — so the decision rests on the nature of the errors, not on the score.
- **`i18n-sweep` stays on `sonnet`**: in one run Haiku found the hardcoded text but did not quote the string.
- **`stage-implement` → `sonnet`** instead of `inherit`: with a session on Opus most of the tokens would go at the Opus price.
- The other checkers are `sonnet`: `pro-review`, `task-converge`, design and runtime comparison — judgment, where a false
  green is worse than a red. Their narrowness also saves little: by the retro, narrow checkers are skipped in 70–86% of
  stages, while `pro-review` runs on every one.
- The alias `sonnet` is currently Sonnet 4.6 (`claude-sonnet-4-6` in `modelUsage`); an explicit `claude-sonnet-5` works,
  but on these cases it is ~1.5 times more expensive with no visible difference — the move is decided by measuring on hard cases.
- `eval.mjs`: `--model`, `--runs`, the cost and the actual model of each run from the JSON output, skipping
  cases with Context7 without a key, `forbidSummary`, new cases `deps-audit-duplicate-lib`,
  `docs-lookup-version-mismatch`, `docs-lookup-no-context7`.

### Hooks

- **`git-guard` (PreToolUse).** In a repo with the pipeline, while a stage is in progress and STAGES.md has no
  "Force run" block, `git add`/`git commit` are rejected — the agent gives a ready message, and the user commits. Before,
  the rule lived in prose, and the permission profile hands out `git *` entirely. **In force mode the agent commits on its
  own without asking** — the sign is the same as in `/stage-check`: the "Force run" block. In a repo without
  `pipeline.config.md` the hook is silent.
- **`session-start` (SessionStart).** A status line of the repo's open tasks (up to three recent ones) and a reminder to
  compact a STAGES.md larger than 40 KB — instead of "find and read STAGES.md" at the start of every session.
- `glab` is added to `ask` next to `gh`.

### STAGES.md archiving — by script

In live tasks 17 STAGES.md out of 30 are larger than 40 KB, up to 153 KB (≈40k tokens on every read); the manual
archiving rule was followed in five. `scripts/archive-stages.mjs` deterministically collapses closed
stages (the heading, the "Commit"/"Decisions"/`metrics:` lines and a link remain) and journal entries beyond the 8 latest
into `STAGES-ARCHIVE.md`. On copies of real files: 78 → 39 KB, 89 → 49 KB. `/stage-check`, Step 4.2
calls the script instead of moving by hand.

### Retro from data — `scripts/retro.mjs` and the `metrics:` line

- A stage journal entry ends with the line
  `metrics: checkers=… skipped=… findings=N dropped=N iterations=N fresh=yes|no escalations=N`.
- `node scripts/retro.mjs <repo>` collects: the share of false findings, fix-loop rounds, how often the fresh run happens,
  runs/skips per checker, `AC-*` outcomes, bloated STAGES.md. For old stages without `metrics:` — from the checklists.
- **A single checker report name** `checks/<checker>-<stage>.md` (`-branch`, `-fresh`): live tasks had
  four schemes.

### Checker regression runs — `scripts/eval.mjs`

Fixtures with planted defects in `evals/cases/`: an orphan component and a locale key (`dead-code`), hardcoded
copy and an incomplete locale (`i18n-sweep`), a formatter duplicated between two stages (whole-branch `pro-review`),
a clean diff without a false Request changes and `PASS` with `file:line` (`pro-review`), and a maker case for
`stage-implement`: it reuses the owner from "Shared elements" instead of a second copy, keeps the
force boundaries, does not commit, does not touch STAGES.md, the summary is ≤ 25 lines. The harness checks not only the
report but the files after the run, that forbidden paths are unchanged and that there are no commits. The run is against
the plugin working copy, without user settings, ~$0.3–1 per case; run it before a release where checkers changed.
The very first run found a defect: the `pro-review` agent wrote a bare `AC-1.1 — PASS` — the 0.6.0 contract
was in the skill but not in the contract of the agent's final message. Fixed.

### Project specifics and unexecutable items

- Leftovers of one project are removed: `yarn build`, `useModalControl`, `page-components/`, `useApiFetch`/`$api`,
  `useFlag`, `locales/ru`+`kk`, the UI kit name, the theme token — replaced with config fields.
- `metrics-baseline`/`metrics-guard` are set up only if the config has the new command `bundle_size`;
  `a11y` and `responsiveness` are removed from the stage checklist — they had no executor, and the checkbox was never closed.

### Lighter skills

Precedents and measurements are moved to `skills/<x>/references/precedents.md`, context hygiene —
to `references/context-hygiene.md`. The rules stayed in `SKILL.md`; precedents are needed when you want to
weaken a rule, not while executing a stage.

### Repository checks

`scripts/validate.mjs`: the top CHANGELOG section = the plugin version; every external MCP server is mentioned
in ROLLOUT.md; `${CLAUDE_PLUGIN_ROOT}/…` links lead to existing files; hook scripts are in place; ticket
IDs and names from the local `.product-denylist` are forbidden in skills; every STAGES.md checklist item
has an executor; the size budget is 30 KB per skill, 8 KB per agent with a skill. CI: on a PR to `main` —
`scripts/release-check.mjs` (plugin changed → version bumped and a CHANGELOG section exists); on push to `main` —
the tag `stage-pipeline--v<version>`, if it does not exist yet.

## 0.8.0 — 2026-09-24

### Context7 ships with the plugin — library APIs are checked against documentation, not memory

A model knows library APIs as of its training, while the repo lives on a specific version from the lockfile —
the mismatch goes both ways: "there is no such option" about a fresh API and "you can do this" about a removed one.
Checkers gave this out as confident findings. Now the plugin's `.mcp.json` has a third server — `context7` (hosted
Upstash, no Node packages), and it appears for everyone who updated the plugin; the permissions for its tools
are generated by `permissions.mjs`, as for the other MCP servers.

- **New agent `docs-lookup`** — takes the version from the lockfile, fetches the docs for it, returns
  a compressed answer with an example. The documentation dump stays in its context. It is called from kickoff/force before
  implementation when there is no certainty about a third-party library API, and from `/root-cause` (a new
  "code → third-party library" boundary).
- **`pro-review`**: a finding about a signature, option, default or deprecation is confirmed by the docs for the version
  from the lockfile; if not confirmed, it is thrown out.
- **`deps-audit`**: a new item "liveness and version" — deprecated, replaced by a successor, whether
  the API in use exists in the added version.
- **`/pipeline-doctor`** checks that context7 is available and for a duplicate with a separately installed plugin.

The key is optional: without it — shared anonymous limits. Your own is `export CONTEXT7_API_KEY=...` in the shell
profile; it is not put into `.mcp.json`, the header is assembled by `scripts/context7-headers.mjs`. If Context7 is
unavailable, checkers mark such items "not checked against the docs" instead of answering from memory.

## 0.7.1 — 2026-09-01

### Skills are stripped of project specifics

Precedents in skills and agents referred to specific tasks, repositories, components and product
entities: ticket IDs, an app name in the monorepo, a theme name, a path to a CSS file, names of screen blocks.
For a person running the pipeline in another project this is noise — a rule reads as "about someone else's
product", and some of the details are outright confusing. The lessons themselves stay; only the identifiers are removed:
"Precedent IT-5237: `StepInfoBox` was rewritten…" → "Precedent: the shared step info block was rewritten…".
45 edits in 15 skill and agent files plus the presentation; the pipeline behavior does not change.

### Installation without access, `main` is prod

The README promised a private repository and an SSH key or `gh auth login` — the repository is public, and installation
goes by the short form `claude plugin marketplace add maggi08/claude-pipeline`: no credentials and no clone are needed
on a new machine. A branch rule is fixed: `main` is prod, the plugin is installed and updated from it for everyone,
so only verified work with a bumped version goes there; experiments live locally (a marketplace from a
folder) or in a separate `dev` branch.

### `ROLLOUT.md` — rollout to a team

A new file: how to give the plugin to a team through a catalog marketplace in its GitLab that points to this
repository (`git-subdir` → `plugins/stage-pipeline`, `ref: main`). Inside — a ready `marketplace.json`
for the catalog, connection through `.claude/settings.json` of the product repository, developer onboarding,
the release cycle and a checklist. The plugin code stays in one place: the GitLab catalog does not change after
creation, and the team gets updates from `main`.

## 0.7.0 — 2026-09-01

### New skill `/root-cause` — debugging to the cause

The pipeline could find defects (checkers) and demand they be fixed (fix-loop), but nowhere was it written
**how** to look for the cause when it is not obvious. In practice this meant guessing: a random edit,
the symptom went away, two iterations were spent before the cause was even named.

The skill leads from the symptom to the cause and does not let a defect be called fixed until the cause is named:

- **Environment first, then code.** In a monorepo with linked packages most "inexplicable"
  defects are not in the diff. Precedent: a symlink to a local checkout of the UI kit with a pinned version —
  two `type_check` errors and a missing indicator went through six stages and three checkers on each.
- **Evidence at the boundaries before hypotheses** — source → spec → code → build → runtime, and separately
  API → store → prop → template. In runtime, measure with numbers, not a screenshot.
- **Tracing back to the source** plus checking the radius of the future fix: an edit at the source is an edit
  to a shared module, and it has importers outside the task scope.
- **Proving the fix by revert** — red-green without a test runner: revert the fix, and the symptom must
  come back. If it did not — you fixed the wrong thing, it coincided for another reason.
- **Three failed fixes = a question for the architecture**, not a fourth hypothesis. It is escalated as an
  architecture question with a list of what each attempt uncovered.
- A table of typical frontend symptom-fixes: `!important`, `nextTick`, `?.` over a type error,
  a `key` bump, an extra `watch`, `z-index: 9999` — and what each of them actually masks.

The entry point is `/stage-check`, Step 3: the first edit did not work or the cause is not obvious → here,
not a second random edit. It is also called separately on a white page, `ReferenceError`, hydration mismatch
and "it works on my machine".

## 0.6.0 — 2026-09-01

Three structural holes, each of which let its own class of edits through to the manual PR review.

### Duplicates between stages are caught in the plan, not in the PR

`/stage-plan` got **Step 2.1 "Stage overlap scan"** and a paired "Shared elements" table
in STAGES.md: what occurs in more than one stage, which stage **builds** it, which ones consume it.
Before, nobody saw overlaps: `pro-review --stage` looks at the diff of one stage, and a third copy of a block
inside its own stage looks clean. The inventory of past stages in the `pro-review` prompt (0.4.0) catches a duplicate
after it is written; the table catches it before the first line of code. Precedent — 6 duplicates
out of 10 comments of a manual review, with a green `pro-review` on every stage.
`/stage-kickoff` now reads the table rows where the stage is listed as a consumer, `/stage-check` takes
it as the first source of the inventory.

### `PASS` must carry a measured value

The `AC-*` contract demanded proof only for `FAIL` — a bare `PASS` was indistinguishable from "did not look",
and there was nothing to tell them apart afterwards. Now `AC-2.4 — PASS, radius 12px (Button.vue:34 ↔ node 12:445)`,
and a criterion the checker did not reach is marked `not verified`. The report contract rule
introduces no extra recheck by the orchestrator and adds no step to the loop.
It affects `stage-check`, `pro-review`, the agents `figma-compare` / `devtools-verify` / `proto-compare`.

### The third fix-loop attempt — by a fresh checker, not by the orchestrator

There was a contradiction inside `/stage-check` itself: Step 1 demands checkers with a clean context ("the checker
must not inherit the author's confidence"), and Step 3 handed the recheck of its own fixes to the orchestrator.
After two rounds it rechecks no longer the code but its own attempts. Now: 2 iterations by the orchestrator,
then **a fresh subagent of the same checker** — only the unresolved `AC-*` go into the prompt, without the history
of the failed fixes. If it does not converge there either — escalation with both verdicts: their disagreement shows
whether what was fixed differs from what was checked. In `/stage-force` the rule is the same.

### Small things

- `/stage-force`, Step 0: dependent questions do not go into one batch — they are folded into the parent by a condition
  or go out as a conditional assumption. There is one collection point in force, and nowhere to ask again.
- `/stage-force`, Step 2: an autonomously made decision is recorded with the cost of rollback. By the end of a run there
  are a dozen such lines, and the user must see which to go through first.

## 0.5.0 — 2026-08-28

A revision of the three previous releases. The mechanics of 0.3.1 and 0.4.0 were right, but some of them worked
not as promised: permissions turned green on a broken environment, patterns fired where they
were not meant to, and the `AC-*` contract rested on one sentence in the orchestrator.

### ⚠ Upgrading from 0.4.0 — remove obsolete entries

The permission profile handed out entries that turned out more dangerous or more useless than assumed,
and they already sit in your `~/.claude/settings.json`. The script has no right to delete them — it is your file.
Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/permissions.mjs` (or `/pipeline-doctor`): it will list
them with reasons under `⚠ obsolete entry`. The main one is `Bash(rm -f *)`: prefix matching does not look
at the order of flags, so it allowed `rm -f -r <any path>` without confirmation, in all projects.

### Fixed

- **`permissions.mjs --check` no longer gives a false green.** An entry that cannot be added because of the user's
  own `deny`/`ask` was counted as "not missing": the script printed `⚠ conflict`
  and right after `✔ permissions are in place` with code 0. `/pipeline-doctor` reported OK on this about an environment
  where checkers are blocked — exactly the false "pipeline broke" that the item was created for.
- **Delete permissions narrowed to build artifacts.** `Bash(rm -f *)` is removed; artifacts are listed
  by exact names (`rm -rf .next`, `dist`, `node_modules`, `coverage`, `.turbo`, `.nuxt`, `build`, `out`).
- **`Bash(...)` patterns brought to prefix semantics.** The space before `*` is literal, so
  `Bash(rm -rf dist *)` did not cover `rm -rf dist`, but did cover `rm -rf dist /someone/else's/path`,
  and `Bash(curl -s http://localhost *)` did not cover `curl -s http://localhost:3000/` — the most frequent call
  in `devtools-verify`. The rule is written into the profile's `$comment` so that project entries do not repeat the mistake.
- **The `fs-read` group became truly read-only.** `sed`, `awk`, `find`, `xargs` are moved to a separate
  group `shell-tools` with an honest label: `sed -i` writes a file, `find -exec`/`xargs`/`awk system()`
  run an arbitrary command. The set without `shell-tools` can now be handed out as "read only".
- **`pkill` moved to `ask`.** By mask it kills not only your own dev server. `kill` by PID stayed in allow.
- **A broken `settings.json`** gives a clear error and code 2 instead of a Node stack trace.
- **`--check` and `--apply` together** are no longer silently executed as a single `--check`.

### Added

- **`retired` in the permission profile** — a list of entries from past versions with an explanation of what is wrong with each.
  The script finds them in someone else's `settings.json` and suggests removing them by hand; `/pipeline-doctor` shows them.
  Before, a profile upgrade was one-way: the new was topped up, the old stayed forever.
- **`AC-*` in checker report templates.** The `AC` column and the "Stage criteria" section in `figma-compare`,
  `proto-compare`, `devtools-verify` and `pro-review`. Before this, the requirement to reference an ID lived in one
  sentence in `/stage-check`, and the checkers themselves showed a template without IDs — the contract rested on the
  orchestrator's memory and broke exactly when it is needed: on the second fix-loop iteration.
- **`Read(**/.env)` and `Read(**/.env.*)` in `ask`** — project secrets are no longer read silently.
- **A check of the stated numbers in `scripts/validate.mjs`.** "Should show N skills, M agents" and the version
  in prose are checked against the plugin contents in the README, cheatsheet and deck. Numbers go stale in exactly the
  commit where a skill was added: it passes itself, while the showcase starts to lie — now it lies visibly.
- **A rule for choosing a feature map.** If there are several `FEATURE-MAP.md` for one feature, one is taken,
  the one with the freshest `Base:` (by the commit date of the SHA, not by the date in the header), and the source ticket
  is named in the summary. Without the rule copies multiplied with no sign of which one is maintained.

### Clarified

- **`deny` in the profile is honestly called protection against accidents, not a security boundary** — in the README,
  in `/pipeline-init` and in the profile itself. The profile allows `node`/`npx`/`python3`, that is, arbitrary
  execution; bypassing any ban from the list is trivial. Whoever needs a real boundary needs a sandbox.
- **The presentation caught up with the plugin**: 17 skills, 10 agents, v0.5.0, `task-converge` in both catalogs,
  the `AC-*` mechanics and the permissions step. In 0.3.1 the deck and the cheatsheet arrived already stale — in the same
  commit that made them stale.

## 0.4.0 — 2026-08-28

- **Permission profile and `scripts/permissions.mjs`.** A ready allow/ask/deny set in groups, topping up
  `~/.claude/settings.json` without deleting anyone else's entries, a backup before writing, `--check` for `/pipeline-doctor`.
  The `Skill(...)` and `mcp__*` entries are generated from the plugin itself, so a new skill gets into
  the permissions by itself. Motive: a confirmation on every checker step is the most frequent source of idle time.
- `/pipeline-init` offers to lay out the permissions, `/pipeline-doctor` checks them with the script, not by eye.
- `scripts/validate.mjs` checks the profile: dangling `defaultGroups`, groups without `title`/`why`,
  an entry in allow and in deny/ask at once.

## 0.3.1 — 2026-08-28

Three commits under one number — the version was not bumped twice.

- **Acceptance criteria got an ID and a verifier.** `AC-<stage>.<n>` + a tag `[verify: …]` / `[live: user-side]`.
  From this follow the "Design source coverage" table (a screen is not lost silently), ID references in checker
  reports and a mechanical build of `TEST-PLAN.md`. A criterion without a verifier is a plan defect.
- **`/task-converge` — a new skill and agent.** The only check that does not look at the diff: it compares the
  state of the code at HEAD with the intent of the whole task and classifies gaps as `missing` / `partial` /
  `contradicts` / `unrequested`. A criterion that no stage took on does not appear in the diff —
  its absence is invisible by definition. Findings go out as catch-up stages, append-only, into `STAGES.md`.
- **A criteria quality gate in `/stage-kickoff`** — five questions about the wording before sign-off, not after.
- **A question taxonomy in `/stage-force`** — a fixed list of categories with a status
  Clear / Partially / Not covered, because the interview batch in an autonomous run is the only one.
- **An "Orientation" header in `FEATURE-MAP.md`** (≤25 lines) — checkers take paths from it without reading the whole map.
- **`Base: <sha>` in the feature map** — a second task on the same feature updates the map by `git diff <sha>..HEAD`
  instead of rereading the repository.
- **Static analyzers in checkers.** `dead-code` and `deps-audit` start by running the tool declared
  in the config (knip / ts-prune / depcheck / madge), if there is one; its output is candidates, the confirmation
  procedure stays. Installing a dependency for a checker is forbidden — that is the repo owner's decision.
- The presentation: the deck and the cheatsheet.

## 0.3.0 — 2026-08-16

- `/stage-force` — an autonomous run through stages: questions in one batch at the start, then implementation,
  checkers, fixes and commits without stops. Push and PR creation are forbidden.
- `/task-wrapup` — a PR/MR description from the task journal.
- A cleanup stage and rules for archiving `STAGES.md` into `STAGES-ARCHIVE.md`.

## 0.2.0 — 2026-08-04

- Checker rules from the retro of two redesign tasks: confirming a finding matters more than the finding itself,
  adversarial recheck in `pro-review`, "consciously left" in `dead-code`.

## 0.1.0 — 2026-08-03

- The personal marketplace `claude-pipeline` and the plugin `stage-pipeline`: a stage-by-stage maker/checker loop,
  checker subagents, a state journal in files.
