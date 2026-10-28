---
name: stage-force
description: Autonomous run of a task through its stages — all questions are asked in ONE batch up front, then implementation (by the stage-implement subagent), checkers, fixes and commits run without stops to the end of all stages, while the main context keeps only summaries. Push and PR creation are forbidden. Use when the user asks to run the task autonomously, "force" / "without stopping" / "commit yourself", or explicitly starts /stage-force. Ends with a run summary; does not write the PR/MR description — that is the manual /task-wrapup. RU triggers — «без остановок», «сам коммить», «force-режим»
---

# Stage Force — the whole task, no stops in the middle

The regular pipeline stops twice on every stage: the sign-off at kickoff and the commit confirmation at check. On a long task that is dozens of waiting windows, and they make up most of the idle time.

Force moves all the questions to the start: they are collected ONCE, then the run goes to the end without a single stop. The agent decides what is reversible and puts it up for review. What cannot be decided for the user is deferred as a blocker, and everything that does not depend on the blocker is finished. The user gets both the decisions and the blockers in one summary at the end.

> **Project config.** `<task_dir>`, `main_branch`, the commands and the dev URL come from `<repo>/.claude/pipeline.config.md` (no file — `/pipeline-init`).

> **Task language.** The task has one language, the `Language:` line in the STAGES.md header. The Force block, the journal and the run summary are written in it; service headings and fields come from the table in `${CLAUDE_PLUGIN_ROOT}/references/language.md` (the templates below show the English forms). Pass the language ("Language: <task language>") in the prompt of `stage-implement` and of every checker subagent. The run summary is assembled by `run-digest.mjs` in the task language.

## Input

- `<task_dir>/<TICKET>/STAGES.md` — required. If missing, run `/stage-plan` first, then come here.
- Optional: the number of the stage to continue from (by default — the first one that is not `done`).

## Step 0. Interview — the only place questions are collected

Read STAGES.md in full, the "Orientation" header of FEATURE-MAP.md (its other sections only if a stage requires them), DESIGN-QUESTIONS.md and the "⚠ Awaiting user confirmation" block. Go through ALL the stages of the plan and write out everything you would ask at their kickoffs in the regular mode. After the batch is answered, asking is no longer possible (Step 2): a question that would surface on stage 4 is asked now, otherwise it becomes a blocker and stage 4 will not be done.

Blockers of the previous run (the `Blockers:` line of a closed "Force run" block) go into the batch first: a new run starts with the answers to them. An answered blocker gets `Lifted: <who> <date> — <answer>` on its own line (a who of at most 4 words, the answer after the date; Step 2 names the field): only that field lifts it in a block dated 2026-10-26 or later, words in its description never do; in a block dated before 2026-10-26, put the field on the blocker's own line.

**Taxonomy first, questions second.** The batch is the only collection point for the whole run, and a missed category costs not one stage but the whole run: there will be nowhere to ask before the end of the task. So do not rely on the needed thing coming to mind by itself — go through the fixed list and give every category a status: **Clear / Partially / Not covered**:

| Category | What to look at |
|---|---|
| Screens and states | whether everything from "Design source coverage" has a stage; empty / loading / error / offline |
| Copy and i18n | text from the source or a placeholder; whether all locales are needed in this task |
| Permissions and gating | who sees what, what is behind the login, defaults for new users |
| Breakpoints | widths from the config; what happens at intermediate ones |
| Motion | whether the source has transitions, what replaces them when there is no spec |
| A11y | focus, keyboard, contrast — in the scope of the task or not |
| Data | shape, limits, pagination, what happens when empty and when abnormally large |
| Platform parity | desktop / adaptive / webview — where it must match the existing one |
| Look | the reference is the kit and the neighboring section; a look "as in the prototype" — only by a decision |
| Terminology | what the entity is called in the UI, whether one thing has two names |
| Boundaries | what we explicitly do NOT do in this task |
| Environment and access | what the run will need from outside: the needed file open in Figma desktop, a logged-in browser profile, a record on the test stand, the backend contract, secrets, free ports and other people's dev servers. Check now, not at the stage: what is missing goes into the batch or falls back to assumptions (a checker skip with a reason; a login that stays missing becomes an honest `[live: user-side — <prerequisite>; <route> → <observed>]` at check time, never a pre-tag). The login is checked by the auth probe below |

**Auth probe (once, only if some `AC-*` of the plan is behind a login).** Checker subagents drive the orchestrator's MCP browser (proven at VT-1 kickoff), so one probe here answers for the whole run:
1. Pick the auth-gated route from the criteria (the first route that needs a session) and the dev URL from the config; run `node ${CLAUDE_PLUGIN_ROOT}/scripts/verify-doctor.mjs` first — a `doctor: wrong app` / `down` goes into the batch (or the assumptions) before anything else.
2. Open the route in the managed browser, picking the server the way devtools-verify picks it: the `stage-pipeline-chrome` server when it is there (tools `mcp__stage-pipeline-chrome__*` — the persistent-profile opt-in of `/pipeline-doctor`, the profile that keeps a login across restarts), otherwise the plugin's (`mcp__plugin_stage-pipeline_chrome-devtools__*`, `--isolated`); never a project's own `chrome-devtools` server (`mcp__chrome-devtools__*`). `new_page` → `list_pages` URL: a redirect to the login page means "not logged in". The login is then made in the window the checkers will drive. MCP unavailable — skip the probe with the reason in the assumptions; devtools-verify then probes by itself.
3. Not logged in → the opening batch carries one item with the route named: "log in in the managed Chrome window at `<route>`, then answer". Recommendation first: "I suggest logging in now, otherwise the criteria `AC-…` go to you as `[live: user-side — …]`". Logged in → no question, one line in the assumptions. An answer "not now" is an assumption: those criteria are deferred in the honest form at check time. Each of these lines is a full assumption — with `Rollback:` and `Basis:`, as the block below requires (journal-gate returns one without them):

   ```markdown
   Assumptions:
   - auth probe: `/orders` opened without a redirect in the stage-pipeline-chrome browser (the opt-in profile) — Rollback: none needed, the probe changes nothing — Basis: http://localhost:3000/orders
   - auth probe skipped: no Chrome DevTools MCP server of the plugin is available in this session, devtools-verify probes by itself — Rollback: none needed — Basis: guess
   - login "not now" (interview answer): the auth-gated criteria `AC-…` are deferred in the honest form at check time — Rollback: cheap, log in and rerun devtools-verify on them — Basis: interview answer
   ```
4. After `Confirmed:` nothing about the login is asked again: a session that expires mid-run is a deferral in the honest form, not a pause. (A persistent login across restarts is the opt-in of `/pipeline-doctor`.)

Rank by "impact × uncertainty" and take the top ones into the batch. `Clear` — do not ask; `Partially`/`Not covered` with low impact — into assumptions, not into a question.

Then ask the selected ones **in one batch** (`AskUserQuestion` — up to 4 questions per call; if one call is not enough, make a second right after it, but do not stretch the collection over the whole run). Only questions whose answer changes the implementation go into the batch:

- product forks and defaults visible to the user;
- priorities and scope boundaries ("do we do X in this task");
- edge cases the plan is silent about;
- things that cannot be derived from the design source and the code.

**Every question with a choice carries your recommendation** — as the first option and with a one-line reason ("I suggest A, because it is already done in adaptive"). In force mode the user answers once for the whole task: a question without a recommendation shifts onto them work you can do by reading the code and the source.

**The "state × action" tables of the plan go into the interview whole** (stage-plan, Step 3): a row where the action saves nothing or loses data is seen by the user before the start.

**Do not ask what is resolved by reading.** Skin and structural forks are closed by a fact from the source (`figma-spec`/`proto-spec`, step 0), not by a vote — read first, ask only if the source really gives two live options.

**Dependent questions do not go in one batch.** Before sending, sort the selected ones by dependencies: for a question whose reasonable options are determined by the answer to a neighboring question of the same batch, the answer will come back incompatible with that neighbor — and there is nowhere to ask again in force, the collection point is single. Such a question is either folded into the parent with a condition ("if A — then B1 or B2?"), or goes as a **conditional assumption** ("I accept B=X when A=Y, B=Z when A=W") into the Force run block. Only questions that can be answered independently of each other stay in the batch.

Everything left unanswered or not included in the batch is written as explicit **assumptions**: a line in STAGES.md worded "accepted X, because Y; reversible via Z". An assumption without a way back is not an assumption but a question: it goes into the batch.

Record the block in STAGES.md:

```markdown
## Force run <date>
Mode: autonomous until the end of the stages. Push and PR — manually by the user.
Interview answers: <decision — what it affects>
Assumptions: <what is accepted — why — Rollback: how to roll back and what it costs — Basis: path:line | quote | guess>
Unresolved: <taxonomy categories with status Partially/Not covered that did not make it into the batch — and where they went: assumption / DESIGN-QUESTIONS.md / "Awaiting user confirmation">
Boundaries: <what we explicitly do NOT do in this task>
Confirmed: <date> — interview answers
Blockers: <empty while there are none; format — Step 2>
```

**The answers to the batch are the start.** There is no separate "confirm, I am starting" after the interview: the user answered and left. What used to go into a confirmation goes into the batch. Files the plan deletes (`git rm` by the criteria) are named one by one in the text of the question about boundaries: the consent must be visible in the session before the deletion (Step 2, "Calls that wait for confirmation"). A free-form answer that reads two ways with different implementations or narrows the scope against the ticket gets a clarifying question right away, with these readings as options (a narrowing — with a quote from the ticket): "bring the button back in the webview" turned out to mean "do not touch master", "the current branch" — a branch off release instead of dev. An unambiguous one — an echo in the start message ("I understood "the current branch" as "a branch off `dev`""), without a question. Then add to the block `Confirmed: <date> — interview answers` (no questions were asked — `— no questions`); without this line the hook will not launch `stage-implement`. The "Force run" block is also a signal for the plugin hook: with it `git add`/`git commit` go without a question, without it they are rejected on the task branch, as in the regular mode. So the block is written BEFORE the first commit. The hook looks only at the task of the current branch (the `Branch:` line in the STAGES.md header or the ticket in the branch name) and only at an open block — without "completed" in the heading (closing — "Output").

## Step 1. Stage loop — no stops

**The main context is the orchestrator only.** The model cannot call `/compact` (it is a user command, it cannot be started by a tool or a hook), so the context between stages is kept not by compaction but by keeping the heavy things out of it: the `stage-implement` subagent reads the code and makes the edits, checker subagents run the checks, `figma-spec`/`proto-spec` produce the spec. Each dies with its own context and returns a summary. The orchestrator does not read or edit the stage code itself.

For each stage in order:

1. **Kickoff without sign-off.** Read the stage selectively, reconcile it with what has piled up, write the stage decisions as a `Decisions:` line into its block. Everything that is usually asked is already in the Force run block.
2. **Spec** — by the `figma-spec`/`proto-spec` subagent (for `logic-only` — skip), into `specs/<stage>.md`; the prompt carries the task's `Language:` line.
3. **Implement — by the `stage-implement` subagent**, implement mode: the ticket, the stage number, the spec path, the task language. Back comes a summary (changed files, decisions, product-visible, lint/type_check/floor-guard, blockers). A blocker or a fork outside the Force run block → Step 2: decide yourself or defer as a blocker, the stage is brought to the end in any case.
4. **Checkers — subagents, in parallel** (`/stage-check`, Step 1; the task language is in each prompt). Skips for logic-only work as usual. Do not rerun `lint`/`type_check`/`floor-guard` yourself if the `stage-implement` summary has numbers against the baseline; "green" without numbers — run `type_check` yourself (the commit hook only checks floor-guard). Verify the findings by the reports and selectively by `file:line` (`/stage-check` Step 2), without rereading the whole stage.
5. **Fix-loop — 2 iterations + a fresh run** (`/stage-check`, Step 3). Each fix iteration is a new `stage-implement` in fix mode with a list of confirmed findings (`AC-*`, `file:line`, what it should be). The recheck of the fixed is selective by `file:line`, by you; a new checker subagent — only for visual/runtime findings and for the fresh run of the third attempt (`/stage-check`, Step 3.2–3.3).
6. **Commit — yourself**, after the "## Findings outcome" in every report of the stage with critical/major/FAIL (`${CLAUDE_PLUGIN_ROOT}/references/checker-report.md`); without the outcome the hook will reject the commit. Format and prohibitions — `/stage-check`, Step 4.4. `git add` of the paths from the implement summary + `git commit` — not `-A` and not `.`: otherwise everything untracked next to the code would go into the commit. **No `git push`.** The commit passes through `floor-guard` (a hook) — over what will enter the commit: if rejected, the violations go as findings into a new `stage-implement` fix round, not into suppression or a `floor-ok` without a reason.
7. **Journal** in STAGES.md: 3–6 lines + a `metrics:` line (format — `/stage-check`, Step 4.1; `floor=` — the number of violations from the `stage-implement` summary, its first run); decisions from the implement summaries — into the stage's `Decisions:` line, product-visible — into "⚠ Awaiting user confirmation". Then `archive-stages.mjs --apply` (`/stage-check`, Step 4.2).
8. **The next stage** — in the same context: only summaries remain in it, not code.

Between stages keep in the context only STAGES.md (the current stage) and the subagent summaries. The context still grows (a long task, many escalations) — on overflow Claude Code will compact it itself, and the task memory lies in STAGES.md: after compaction the continuation starts with reading it.

## Step 2. Mid-run — no questions

After the `Confirmed:` line the user is not at the screen. A question in the middle of the run stops all of it, together with everything that does not depend on the answer, and costs as long as the user is not looking at the terminal. So from here on there is no `AskUserQuestion`, and no turn that ends with a question and waits for an answer. This rule is stronger than the "stop, escalation" of `/stage-check`, Step 3: in force an escalation is a blocker. Every fork has two outcomes.

**A checker finding is not a fork.** It is fixed in the fix-loop; if not fixed — a blocker. Findings do not go into "Awaiting user confirmation" or "leaving as is": Request changes "accepted as a compromise" — and the user fixed a duplicate of the request the next day. The outcome of every finding is in the report (`references/checker-report.md`).

**Decidable and reversible — decide yourself.** These are product decisions without a defect: a default, a text, an order. Take the reversible option and write it as a line into "⚠ Awaiting user confirmation": what was changed, where it is visible, **what the rollback will cost if the decision is wrong** (`Rollback: …`) and **what it stands on** (`Basis: <path:line | node-id | a ticket quote | a decision id | guess>` — an honest "guess" is allowed, an empty basis is not; the journal-gate hook rejects a new line without either; the digest lists the rows by rollback cost) ("rewrite the email template" against "rebuild three screens"). Then continue. This is cheaper than a stop and is not lost: the block is read at every kickoff and in the final checks. The cost is needed not for reporting but for the order of review: by the end of an autonomous run there are a dozen such lines, the user reads them at once and must see which to check first without opening each.

**Cannot be decided for the user — a blocker.** These are:

- a fork where both options are irreversible: a data migration, an API contract change, deleting user content, changing a default that is already visible in production;
- a conflict of sources of truth: the design against the existing behavior, a requirement against the implementation of the neighboring platform. It is never resolved autonomously;
- secrets, access or external systems are needed that the interview did not provide: a login, a token, someone else's service;
- the task asks to go beyond the boundaries recorded in the Force run block;
- the fix-loop is exhausted (2 iterations + a fresh checker run) and a critical remains; `type_check` or the build are red and do not converge in two attempts and `/root-cause`;
- a missing stage was discovered — the task does not close without it;
- an action was rejected by permissions: a hook, the auto mode classifier, an ask rule (below).

A blocker does not stop the run but cuts out of it exactly what depends on the blocker:

1. Add a line to `Blockers:` of the Force run block in the format `B<n> — what is blocked (AC, stage) — why — what is needed from the user — your recommendation — what else depends on it`. For a rejected action add the exact command the user will run. A blocker is lifted only by the field `Lifted: <who> <date> — <answer>` (a who of at most 4 words before the date, the answer after it, and no request or condition word such as needs, once, after, when, will outside quotes in the field's segment; the Russian form is in the marker table of `references/language.md`) in its own line or on an indented sub-item under it; from a block dated 2026-10-26 on no word of the description lifts it (in a block dated before that day, put the field on the blocker's own line). A blocker carried into a new run keeps its run: `B<n> (<run>) — …`, and the same number in two runs stays two blockers.
2. The blocked criteria are marked `[blocked: B<n>]` in STAGES.md and are not implemented. An irreversible "for now like this" is not done.
3. The rest of the stage is brought to the end: checkers, fix-loop, commit, journal (blockers go into `escalations=` of the `metrics:` line). A stage with an open critical is committed as is: the branch is local, and the next stage needs a clean diff. What exactly is broken is told by the blocker line. A red `type_check` or build breaks the checks of all the following stages, so only the stages whose checks it does not affect go on (another monorepo package), and `stage-implement` gets a new baseline with the blocker number. A stage in which nothing unblocked is left gets `[status: todo — blocked: B<n>]` and stays without code.
4. Move on to the next stage that does not depend on the blocker. Dependent stages get the same `todo — blocked: B<n>` and are not implemented. A missing stage is appended to STAGES.md with this status and a recommendation: without the user the scope does not grow.
5. The run ends early only when nothing is left that does not depend on the blockers. That is the final (Step 4 and "Output"), not a pause.

### Calls that wait for confirmation

A permission request is the same stop: a call under `ask` (`pkill`, `git push`, `gh`) waits until the user returns. In force the `force-guard` hook rejects such calls at once. A process is killed by whoever started it, by PID; a rejection is not a reason to look for a workaround. Details — `${CLAUDE_PLUGIN_ROOT}/skills/stage-force/references/permissions.md`.

## Step 3. Never — without a separate explicit command

- `git push`, `git push --force`, creating and commenting on a PR/MR (`gh pr create`, `gh pr comment`).
- Any deploy, package publication, change of CI secrets.
- `git reset --hard`, `git clean`, rebasing other people's branches, rewriting already pushed history.
- Edits outside the task repository and outside the agreed boundaries.

The branch and the index belong to the user: force gives the right to commit into one's own branch, not to publish.

## Step 4. Final

All stages `done` or `todo — blocked` → the final checks from STAGES.md (pro-review whole-branch — the `pro-review` agent in whole-branch mode against `origin/<main_branch>` on `review_model` (`/stage-check`, Step 3.3), it also catches duplicates between stages; `floor-guard --base origin/<main_branch>` — the quality floor over the whole branch, `ci-gates.mjs --run` — the CI gates from the config on HEAD after the last fix (the hook will not accept "completed" with a non-green gate — a gate red on HEAD is not covered by a `skip:` line of the Force block, that line is only for a gate that cannot run here — nor, in a run opened after 0.18 first saw the task, without a whole-branch `pro-review` and a `task-converge` report newer than the last commit that changed the tree), security-review, metrics-guard, ds-parity, dead-code, i18n-sweep, deps-audit, coverage, task-converge, test-plan, the confirmations block) → the run summary. The prompts of the final `task-converge` and whole-branch `pro-review` carry the task's `Language:` line, like every checker's.

Force does not write the PR/MR description: `/task-wrapup` is started only by the user, when they need a description. Skip the `wrapup` line in the "Final checks" of old STAGES.md — do not mark it or run it by the path to the skill.

`task-converge` is mandatory in a force run and is started **before** the summary (after the last fix commit: a report older than that commit does not count): an autonomous run is exactly the mode where an uncovered criterion or a silently widened scope will be caught by no one along the way. Its findings are catch-up stages, and they go through the same loop; the catch-up in force goes automatically, as a regular stage, and `unrequested` goes as a line into "⚠ Awaiting user confirmation". It will see the `[blocked: B<n>]` criteria as `missing`: do not start a catch-up for them, they are already in the blockers.

## Output — the run summary

After the final (including the catch-up) rename the block heading to `## Force run <date> — completed <date>`, and with open blockers — to `— completed with blockers <date>`. An open block is read by the hook as a permission, and the next catch-up or a new stage on this branch in the regular mode would go with an autocommit.

**The session's browser closes with the run.** The rename to "completed" is also the browser close: on the call that renames the heading (an Edit or MultiEdit of the heading line, a Write of STAGES.md, or a Bash call that names the task directory) journal-gate runs `browser-cleanup.mjs --session`, which closes by PID the browsers this session's DevTools MCP servers launched (the plugin's `--isolated` one, `stage-pipeline-chrome`) and nothing of another session, and the run digest records its line (`Session browser: closed by PID …`). A close the hook rejects stays this session's: the edit that fixes the journal closes the browser. Rename the heading only after the last devtools-verify, final checks and catch-up included: a later MCP call would open a fresh browser. The short view you paste then says the browser was closed. `Session browser: left open — …; close: …` means the user switched the close off (`STAGE_PIPELINE_BROWSER_CLEANUP=off`) or the heading was closed outside this session's call: paste the line as it is and leave the browser open. Only when the short view has no `Session browser:` line at all (an older plugin in the session) run `node ${CLAUDE_PLUGIN_ROOT}/scripts/browser-cleanup.mjs --session` yourself before the summary and put its line in as `Browser: …`. Within the run, force does not close an `--isolated` browser per stage: it holds the login made at the interview (`/stage-check`, Step 4.6).

A whole-branch `pro-review` or a `task-converge` report that is missing or older than the last tree change, and stays so, is a blocker that carries the fixed marker of that report: `B<n> — [final: pro-review — not run] <why>`, `B<n> — [final: task-converge — stale] <why>` (in a ru task the state takes its Russian form from the marker table in `references/language.md`). The hook reads only the marker: a blocker that names the checker in prose ("pro-review found a critical; the report lacks a recheck", "whole-branch pro-review was not run") does not cover the missing report, and the close is rejected with the marker to add.

The summary is plain markdown, never inside a code block: the short view carries `###` headings, and in a fence they show as one monospace block with a horizontal scroll. The lines, in this order:

<TICKET> — force run completed: stages N of M, commits K

Stages: 1 ✅ 2 ✅ 3 ⛔ B1 …

<the short view of run-digest.mjs, whole: blockers, red CI gates and findings without an outcome line by line; the rest as numbers; the session browser line; the path to RUN-DIGEST.md>

Not done: <what was put outside the boundaries>

Next: answers to the blockers → /stage-force will continue from the blocked one. The description — /task-wrapup, if needed. The push is yours.

**The lines you write yourself** (the heading, `Not done:`, `Next:` and anything that is not the run-digest output): the heading keeps the template form (`stages N of M, commits K`) with the numbers taken from the journal, the rules below act on the words around them, and `Not done:` does not repeat lines of the run-digest short view. They follow `${CLAUDE_PLUGIN_ROOT}/skills/human-text/references/rules.md`: the first line is the status, a blocker or red gate is named with its severity and not softened, numbers and names instead of "several" and "some issues", no closing paragraph that retells the summary. Only the rules apply here; the `human-text-check` agent is not run on every force run (it is too expensive for a summary). The run-digest short view is pasted as is, the rules do not touch it.

The middle of the summary is assembled by `node ${CLAUDE_PLUGIN_ROOT}/scripts/run-digest.mjs <task_dir>/<TICKET>`: it writes the full digest to `<task_dir>/<TICKET>/RUN-DIGEST.md` (every line of every category, the checkers' verdicts by report, the run date in the header) and prints the short view. When the block is closed, the hook puts the same short view and the path into the context. The script, not you, picks what the short view shows, and every category is in it with a number, so **paste it whole, without retelling or selecting** — do not shorten it further and do not add a "Checkers: …" line of your own: the verdicts are in the file. A precedent: a summary reduced everything to "kk/en texts and minor deviations", and under it lay two defects the user found themselves; that is why the choice belongs to the script. Blockers go first: only they need an answer. "Ready for PR" is written only if there are no blockers and the short view has no "Not ready for PR" line (it names the reports with a critical/major finding or a FAIL that has no allowed outcome in its "Findings outcome", and the task files that cannot be read; the verdicts of all the checkers are in the "Checkers" section of `RUN-DIGEST.md`). If the short view has no path (the file could not be written), run `node ${CLAUDE_PLUGIN_ROOT}/scripts/run-digest.mjs <task_dir>/<TICKET> --full --no-write` for the full view when the user asks "more".

When the user then writes "more" or "what about X" (the unverified, the accepted, a checker), open that section of `RUN-DIGEST.md` and show it; do not repeat the whole digest and do not summarise it from memory.

**After "completed", a code edit is a stage, not "a quick fix".** The user's remarks after the run, a manual check, edits from a review — a catch-up stage (`/stage-kickoff` → `/stage-check`) with a journal line. Otherwise they go into the PR without a single checker: that is how seven commits after the run were merged in four minutes in one task. The branch commits the journal does not know, the next session will see in the status line from the hook.
