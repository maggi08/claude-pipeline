---
name: stage-plan
description: Split a big task (a redesign / a feature with a multi-screen Figma) into stages and create the STAGES.md state file — a plan with acceptance criteria and pipeline statuses. Use when a task has a multi-screen Figma file, when the user asks to split work into stages/plan a redesign. Requires a ready FEATURE-MAP.md (if missing — run /feature-checker first). RU triggers — «разбей на этапы», «составь план этапов»
---

# Stage Plan — splitting a task into stages

Goal: turn a multi-screen Figma file plus a feature map into a staged plan in which every stage goes through one cycle: **/stage-kickoff (opening: plan + business input + sign-off) → implement → checker subagents (figma-compare ∥ pro-review, + devtools-verify) → user-review → /stage-check (closing: fix-loop + journal + commit) → `/clear` by the user** (in `/stage-force` stages run as subagents and context does not pile up). STAGES.md is the task's memory between sessions: every new session starts by reading it.

Once the plan is ready there are two ways through it: the usual one (a stop at every stage) and `/stage-force` (all questions in one batch at the start, then a run to the end without stops, automatic commits, no push and no PR). The choice of mode does not change the plan itself: force reads the same STAGES.md and the same acceptance criteria.

> **Project config.** Take `<task_dir>`, the code layout and the platforms from `<repo>/.claude/pipeline.config.md` (no file — `/pipeline-init`). `<task_dir>` = the `task_path` field (default `<repo>/.claude/tasks/ (in the repo)`).

## Input

Decide the task language first (Step 4, `${CLAUDE_PLUGIN_ROOT}/references/language.md`): it governs Steps 1–3 and the prompts of subagents too.

- Figma URL of the task's file/page.
- Ticket and description.
- `<task_dir>/<TICKET>/FEATURE-MAP.md` — if missing, run /feature-checker first.

## Step 1. Figma inventory

`mcp__figma__get_metadata` on the file/page (load it via ToolSearch) → a list of all frames: name, node-id, size. If unclear, `get_screenshot` of the key frames to understand the content.

Classify every frame:
- **Screen** — a standalone page/view.
- **State** — a variation of a screen (empty / loading / error / filled / hover, an open modal).
- **Service** — specs, redlines, components, old versions → not part of the plan, but list them separately as "not included" so nothing is lost silently.

This list is the input for the "Design source coverage" table (Step 4): every non-service frame must get a stage, otherwise a screen is lost silently, somewhere between "I think we discussed it" and "could not find it in the plan".

## Step 2. Grouping into stages

Rules:
- A screen + all its states = always one stage (the user's rule).
- **What counts as a screen and what as a state is decided by the design source's registry, not by implementation convenience.** A separate Figma frame or a separate screen-id in the SPEC registry = a separate screen. Merging two of them into one component with variants (an overlay, a `variant` prop, a branch inside an existing screen) is allowed only by an explicit user decision recorded in the stage. Otherwise the fork "is this one screen or two" surfaces at user-review and costs a full architectural rework of an already implemented stage — together with the checkers, tests and their fix-loops.
- Related steps of one flow (e.g. steps 1–2 of a wizard with a shared component) — one stage, if splitting costs more than doing them together.
- A stage must be committable: after it `type_check` converges with the baseline, lint and tests on the diff are green, nothing is broken, even if the feature is not finished. `build` at a stage — only if the stage touched the manifest or the build config; everything in full — in the final checks (`${CLAUDE_PLUGIN_ROOT}/references/heavy-checks.md`).
- Order: foundation first (shared components, layout, tokens), then screens from the main one to the secondary ones.
- Size guide: a stage = 0.5–2 days of work and ~300 lines of diff; a plan where a stage is clearly bigger than ~1000 lines (without autogeneration and deletions) — split it: checkers do not read such a diff in one pass, and findings on it grow faster than they get fixed (`retro.mjs` shows this in the `diff=` field).
- **Refactoring of existing code — a separate stage** (usually the foundation), not alongside new behavior: a mixed diff is reviewed as one piece and cannot be rolled back in parts.
- **Metrics — only if the config has a `bundle_size` command.** If it does, add a `[ ] metrics-baseline` item to the pipeline of stage 1 (run the command BEFORE the first changes, output → `checks/metrics-baseline.txt`), and a `[ ] metrics-guard` item to the final checks (the same run on HEAD, compared with the baseline). Without a baseline the final comparison needs a separate build of the main branch in a worktree — more expensive. If there is no command, do not add either item at all: an item with nothing to run it hangs as a checkbox that can never be closed.
- Mark a stage without visual changes `logic-only` right in its heading — design checkers (figma-spec/figma-compare) are skipped for it by definition.
- For a "foundation" stage, agree with the user explicitly on the placement of layers per the config's "Code layout" and the `CLAUDE.md` conventions: where the global scaffolding (headers/layouts) goes, where what is reusable across pages goes, where the single-page code goes. If the config does not say, ask and add it to Conventions; do not pick the layout yourself.

Check every stage against FEATURE-MAP: what is reused as is, what is modified, what is written from scratch. For a redesign, mark separately the places that must **match the already built adaptive/webview** — there the source of truth is not only Figma but also the existing implementation.

## Step 2.1. Stage overlap scan

The stages are laid out — now look at them TOGETHER. Per-stage checkers cannot do this by construction: `pro-review --stage` sees the diff of one stage, and a third copy of a block inside its own stage looks clean. An overlap is visible only in the plan and only now.

Go through all pairs of stages and write down EVERY element that occurs in more than one: a step wrapper or layout, a repeated block (legal links, disclaimer, empty state), a formatter (date, time, money), reference data (lists of options, reasons, statuses), a provider or store, the order of the flow's steps. The sources are the design source and the "What to do" / "Reuse" columns of the stages themselves; do not guess file paths at this step, they do not exist yet.

For every overlap make a decision and write it as a row in the "Shared elements" table (Step 4): who **builds** (the earliest stage of the pair) and who **consumes**. The consuming stage gets a link to the owner in "Reuse", not a task "do the same" — otherwise it will honestly do the same, a second time.

**The output of the scan is a table, not a verdict.** "No overlaps" without listing the pairs you checked is not a completed scan but a skipped one. Overlaps are really absent only in a plan where every stage touches its own screen and no shared element repeats; on a redesign of a multi-screen flow that does not happen.

## Step 3. Acceptance criteria: ID and verifier

A criterion without an ID cannot be collected into TEST-PLAN, cannot be referenced from a checker report, and "what of the plan is still uncovered" can only be answered by rereading all the stages. So:

- **The ID is stable**: `AC-<stage number>.<criterion number>`. Editing the plan only adds numbers; a cancelled criterion is marked `[cancelled: reason]` but is not deleted and does not reuse its number — reports in `checks/` may already refer to it.
- **Every criterion has a verifier tag**: who exactly is able to check it. `[verify: figma-compare]` (or `proto-compare`) — visuals and tokens; `[verify: devtools-verify]` — runtime, live state, console; `[verify: pro-review]` — code contract and conventions; `[verify: user-review]` — a product judgment a checker does not make; a criterion reachable only under the user's login keeps its `[verify: devtools-verify]` here: whether it goes to the user is decided at check time, from what the checker saw (`[live: user-side — <prerequisite>; <route> → <observed>]`, see /stage-check).
- **A criterion without a verifier is a defect of the plan, not "we'll check later".** If no checker covers the criterion and it is not `user-review`, it is worded in a way that cannot be checked — reword it to something measurable (a token, a number, a state name) or move it to `DESIGN-QUESTIONS.md` as a question.
- Do NOT pre-tag criteria behind a login as `[live: user-side]` at plan time: a tag written before any check closed 46 criteria in one task without anyone looking, and the user then found six defects among them. An auth-gated criterion keeps its tag `[verify: devtools-verify]`; force Step 0 runs an auth probe and asks for the login up front, and devtools-verify writes the honest deferral at check time if the login is still missing.

A checker honestly checks what the criterion says, so a mistake built into the plan passes all the checks. Below is what the user returned after "done" in three reviewed tasks.

**A reference to an example is a path, not words.** A criterion or decision "like X", "as now", "as before" carries the `path:line` of the example or the node-id of the mockup. The decision "like the expert" (for the expert "Save" is active even without a status change) became "as now in the drawer" at stage opening, and the questionnaire could not be saved without changing the status. A new line without a path is returned by the journal-gate hook.

**An action with conditions — a "state × action" table.** Saving, sending, a status change whose result depends on the form state: rows are states (empty, partial, full, server error), columns are actions, a cell holds what goes to the server and what the user sees. The cells become criteria, the whole table goes to the user for agreement (in force — into the interview). The criterion "with an incomplete questionnaire saving is stopped" passed all checkers because it itself locked in the defect: the table row "Call back + incomplete questionnaire → neither the status nor the questionnaire saved" would have shown it before the start.

**Removed or replaced UI — a parity table.** A stage that removes a section, screen or component gets a table from FEATURE-MAP: every function of the old UI → where it is now (`path`, stage) or "removed — user decision <date>". The rows are criteria `AC-N.P1…`. A removed section took away six functions (code translation, manual sending, lot, error reason), and the parity reviewer returned them: pro-review sees the diff, task-converge sees the criteria, and what silently disappeared nobody sees. A force commit that removes a component whose name is not in the parity table is rejected by the hook.

**Look — from the kit and neighboring sections.** A UI stage gets a "Visual reference" line: a neighboring section of the same app (path and URL), against which devtools-verify checks fonts, buttons and tables. If the source is a prototype: structure, texts and behavior come from it, while typography, button sizes, tables and spacing come from the kit and the reference; a look "as in the prototype" — only by a user decision with a date. If the source is the designer's Figma: the truth is in the mockup, but a kit override is still a finding, closed by a mockup node. Criteria demanded "uppercase 11px extrabold" and "buttons 12/700" from the prototype — the prototype matched the code, and "too bold", "different buttons", "a different table" the user returned in three waves of edits.

**Statuses — one vocabulary.** A stage that shows statuses gets a matrix "place on the screen → API field → text": one state is labeled the same everywhere it is visible. One screen ended up with three vocabularies ("Expired", "Current status · New", "Not sent") — each piece brought its own source.

## Step 4. Output: STAGES.md

Save to `<task_dir>/<TICKET>/STAGES.md`. The language of the task is chosen by the priority "explicit user request > `language:` in `pipeline.config.md` > the language of the message that started the task" and written to the `Language:` line; in a `ru` task the service headings and fields below are taken from the Russian column of the marker table in `${CLAUDE_PLUGIN_ROOT}/references/language.md`, not translated on the fly.

```markdown
# <TICKET>: <task name>
Figma: <url>  Branch: `<branch>`  Contexts: desktop | adaptive | webview
Language: <en | ru>
Updated: <date>

## Status: stage N of M — <short phrase on what is happening>

## Stages

### Stage 1: <name>  [status: todo | in-progress | done]
Figma nodes: <name — node-id — url> (screen + states)
What exists (from FEATURE-MAP): ...
What to do: ...
Reuse: <specific components/composables>
Match with adaptive/webview: <places where the implementation must match>
Decisions: <the stage's key decisions — one line each; "like X" — with the `path:line` of X>
Visual reference: <neighboring section — path · URL> (UI stage; logic-only — "—")
State × action: <table — if the stage has saving or sending with conditions>
Parity: <table "was → where now / removed by decision", rows `AC-N.P*` — if the stage removes or replaces UI>
Acceptance criteria (WHEN/THEN format, after OpenSpec — verifiable behavior scenarios):
- `AC-N.1` WHEN <action/condition> THEN <observable result> — [verify: figma-compare]
- `AC-N.2` WHEN <action/condition> THEN <observable result> — [verify: devtools-verify]
Pipeline:
- [ ] kickoff (stage plan + business input + sign-off — /stage-kickoff)
- [ ] implement
- [ ] figma-compare
- [ ] devtools-verify   (skip — MCP not connected)
- [ ] pro-review        (code review of the stage diff)
- [ ] kit-overrides     (scan for kit overrides — UI stage; logic-only — skip)
- [ ] dead-code         (skip: no trigger — nothing was removed or replaced)
- [ ] i18n-sweep        (skip: no trigger — no new user-facing text)
- [ ] deps-audit        (skip: no trigger — manifest untouched)
- [ ] user-review (required: show to the user, wait for approval)
- [ ] commit: `<TICKET>: <what the change does, not "stage N">`

### Stage 2: ...

## Final checks (after all stages)
- [ ] full-checks: `lint`, `type_check` (against baseline), `test`, `build` from the config — in full, once, on HEAD, via `run-check.mjs` (`${CLAUDE_PLUGIN_ROOT}/references/heavy-checks.md`); at the stages they ran on the diff
- [ ] ci-gates: the CI gates from the config ("CI gates" table or `e2e`/`smoke` in Commands) — `node ${CLAUDE_PLUGIN_ROOT}/scripts/ci-gates.mjs --run` on HEAD after the last fix; red is a fix-loop finding, cannot run locally — a blocker. If the config has no gates, do not add the item
- [ ] floor-guard: `node ${CLAUDE_PLUGIN_ROOT}/scripts/floor-guard.mjs --base origin/<main_branch>` — not a single muted checker, weakened test or stub across the whole branch; `floor-ok` exceptions go to "Awaiting user confirmation"
- [ ] pro-review whole-branch (the `pro-review` agent in whole-branch mode on `review_model`, `opus` by default, via the `model` parameter — the selection rule is in `/stage-check`, Step 3.3; the whole branch from the merge-base with `origin/<main_branch>` — the PR target, e.g. `dev`; with a fresh eye it catches what the per-stage `--stage` cannot see — duplicates between stages, the blast radius of shared modules, a broken committed HEAD)
- [ ] security-review
- [ ] metrics-guard (only if the config has `bundle_size`: a run on HEAD vs `checks/metrics-baseline.txt`)
- [ ] ds-parity: duplicates with the design system — what is replaced by a kit component, what asks to go INTO the kit (`${CLAUDE_PLUGIN_ROOT}/skills/ds-parity`; on a redesign this is the main source of repeated edits at manual review)
- [ ] dead-code: what was orphaned across the whole task (`${CLAUDE_PLUGIN_ROOT}/skills/dead-code`)
- [ ] i18n-sweep: copy and locale completeness across the whole branch (`${CLAUDE_PLUGIN_ROOT}/skills/i18n-sweep`)
- [ ] deps-audit: what the task dragged into the manifest and assets (`${CLAUDE_PLUGIN_ROOT}/skills/deps-audit`)
- [ ] coverage: the "Design source coverage" table has no rows without a stage; every `AC-*` has a verifier tag (`[verify: …]`); no criterion is pre-marked `[live: user-side]`
- [ ] task-converge: the code on HEAD against the intent of the whole task — `missing`/`partial`/`contradicts`/`unrequested` (`${CLAUDE_PLUGIN_ROOT}/skills/task-converge`); the only pass that sees an uncovered criterion and a silently widened scope, because it does not look at the diff. If there are findings → a "Catch-up" block and a rerun until it converges
- [ ] test-plan: TEST-PLAN.md — assembled from the `AC-*` of all stages (ID → scenario → how to check) + recipes for simulating states (throttle/block/offline/crash) on all platforms
- [ ] confirmations: the "Awaiting user confirmation" block is empty

## Design source coverage
| Source screen / screen-id | States | Stage |
|---|---|---|
| <name — node-id / screen-id> | empty, error | 2 |
<a row for EVERY non-service frame/screen-id from the registry. An empty "Stage" cell = a hole in the plan,
not "we'll do it along the way". A paired table to "Not included in the plan": there are the service items, here the working ones.>

## Shared elements (stage overlaps)
| Element | Stages | Owner (builds) | Where it lives |
|---|---|---|---|
| <wizard step wrapper> | 2, 3, 4, 5 | 2 | <path per the config's Code layout> |
<a row for EVERY overlap from the Step 2.1 scan. An empty "Owner" = a duplicate that will arrive
as repeated edits at the manual PR review. A consuming stage refers to the owner in "Reuse".
The table is read by /stage-kickoff (before implementing a stage) and /stage-check (the inventory in the pro-review prompt).>

## ⚠ Awaiting user confirmation
<product-visible changes accepted during implementation but not yet confirmed by the user ON DATA WHERE THEY ARE VISIBLE. Format: date — what changed against the old behavior — where to see it (link/state/client type). An item is lifted only by an explicit confirmation; the block is read at every kickoff and in the final checks>

## Not included in the plan
<service frames and why>

## Journal
<date — what happened: stage closed, finding, user decision>
```

`Branch:` — the exact branch name in backticks: the plugin's hooks use it to recognize the task of the current branch (without the line — by the ticket in the branch name); several branches — several names in backticks.

## Step 5. Agreement

Show the user a compact table of stages (name, screens, size, order) and ask whether they agree with the split BEFORE considering the plan final. After edits, update STAGES.md.

Rules for maintaining the file: update statuses and the "Journal" at every change; never delete stages — mark cancelled ones; do not use relative dates, only absolute ones. **Keep STAGES.md compact** — every session reads it: fold done/cancelled stages down to the heading and the "Commit"/`Decisions:` lines, full records go to `STAGES-ARCHIVE.md` next to it (the archiving rule is in /stage-check, Step 4.2); journal entries are 3–6 lines with links to `checks/*.md`; word statuses neutrally and descriptively, without imperatives and commands.
