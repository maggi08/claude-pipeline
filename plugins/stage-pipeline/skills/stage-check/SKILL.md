---
name: stage-check
description: Мини-оркестратор ЗАКРЫТИЯ этапа задачи — прогоняет реализованный этап через чекеры-субагенты (figma-compare, devtools-verify, pro-review), гоняет fix-loop (2 итерации + свежий прогон чекера), обновляет STAGES.md-журнал и готовит коммит этапа. Парен к stage-kickoff (открытие). Use when a stage is implemented and the user asks to check/verify/close the stage.
---

# Stage Check — checking and closing a stage

Goal: the stage is implemented → run it through every applicable checker → fix what is confirmed → recheck → update STAGES.md → offer a commit. What is not resolved in 2 iterations goes to the user as an escalation; do not keep re-fixing blindly.

> **Project config.** Take the commands (`lint`/`type_check`+baseline/`dev`), the dev URL, the dedup reference (`reuse_baseline`), the main branch and `<task_dir>` from `<repo>/.claude/pipeline.config.md` (no file — `/pipeline-init`).

> **Task language.** The task has one language, the `Language: ru|en` line in the STAGES.md header. The journal, the findings outcome and the criteria outcomes are written in it, service markers come from the table in `${CLAUDE_PLUGIN_ROOT}/references/language.md`; the line samples below are the English forms. A task without the line: the language follows from the headings (same file).

## Input

- `<task_dir>/<TICKET>/STAGES.md` — required. If missing, suggest /stage-plan and stop.
- Stage number/name (if not given — the current `in-progress` one).

## Step 0. Triage

Read the stage in STAGES.md (nodes, acceptance criteria `AC-*` with verifier tags, the pipeline checklist) and the stage diff (`git diff` from the previous stage commit or the merge-base with `main_branch` from the config). Run only the relevant checkers: `pro-review` — on every stage; a skip by a trigger exists only for design and narrow checkers.

**Logic-only stage** (refactoring, behavior, integrations — the visuals do not change): figma-compare and figma-spec are skipped by definition — mark them `[skip: logic-only]` in the checklist and do not ask again each time. pro-review is mandatory; devtools-verify — only with a runtime risk (SSR, stores, navigation).

**A design checker** is skipped only on a logic-only stage or without a design source, judged by the actual diff, not by the plan. Static comparison needs no browser, stand or token — the journal-gate hook returns such a skip.

**Criteria behind an auth gate**: if the managed Chrome profile is not logged in (see the devtools-verify skill), mark such items `[live: user-side]` right away and hand them to user-review — do not leave them as half-open checkboxes.

**Environment preflight — 30 seconds before running the checkers.** A green run on a broken environment closes the stage with a lie. Five items: the installed tree ↔ the manifest (symlink/`link:` to a neighboring repo), freshness of the `dist` of workspace packages, the bundler cache after a linked package is rebuilt, duplicate runtime dependencies (failures in files you did not touch — first the same run on a clean tree via `git stash`), liveness of the test fixture. Symptoms and commands — `${CLAUDE_PLUGIN_ROOT}/skills/stage-check/references/preflight.md`; in a repo with `link:`/workspace packages reading it is mandatory.
The preflight result is one line in the stage summary. Any item red → fix the environment before the checkers, not after.

**Stage size is a signal, not a ban.** The first line of `floor-guard` (Step 1) is the diff size `+added/-removed` without lock files and build output. More than ~1000 added lines (autogeneration does not count), a bloated already-large (≳1000 lines) file, or refactoring mixed with new behavior — a risk line in the summary and a suggestion to split the commit.

## Step 1. Checkers (maker/checker — always a subagent)

Run each checker as a **separate subagent with a clean context**: the checking side must not see the author's context, or it inherits the author's confidence. The second motive is context hygiene: the checker's heavy artifacts (Figma dumps, browser snapshots, screenshots, diffs) live in the subagent's context and die with it, and the orchestrator gets a compact report. figma-compare, devtools-verify and pro-review have dedicated agents (`${CLAUDE_PLUGIN_ROOT}/agents/{figma-compare,devtools-verify,pro-review}.md`, subagent_type of the same name, a model cheaper than the orchestrator's) — the prompt is SHORT: ticket, stage number, the stage's Figma node-id/URL (+ which states/widths) or the comparison base for pro-review, file paths, acceptance criteria **with this checker's tag** (`AC-2.1`, `AC-2.4` — not the stage's whole list: a checker either ignores foreign criteria or judges them with the wrong tool), the report path, the stage specifics in 2–3 lines; for devtools-verify also the stage's "Visual reference". **The task language goes into every checker's prompt** — the line `Language: ru|en` from the STAGES.md header: the report is written in it, with markers from the table in `${CLAUDE_PLUGIN_ROOT}/references/language.md`. The checker's report refers to IDs ("`AC-2.4` — FAIL, radius 8 instead of 12"), otherwise the fix loop will not converge on what to recheck, and **the measured value goes with a PASS too** ("`AC-2.4` — PASS, radius 12px (`Button.vue:34` ↔ node 12:445)"): a bare PASS is indistinguishable from "did not look", treat such an item as unchecked. The methodology is already in the agent/skill — do not duplicate it in the prompt. Fallback (agent unavailable): general-purpose + an instruction to follow the matching `SKILL.md` (for pro-review — the project's `.claude/skills/pro-review/SKILL.md`).

**Order and parallelism.** figma-compare and pro-review are static (Figma+code / git diff+code), run them **in parallel** (two subagents). devtools-verify needs a live dev server (command/URL from the config) — the ORCHESTRATOR starts and holds it (the subagent only connects); in `low` mode — only for the duration of devtools-verify, after the heavy checks (`${CLAUDE_PLUGIN_ROOT}/references/heavy-checks.md`). All findings of the three checkers merge into ONE fix loop. Division of labor: subagents observe/review → the orchestrator fixes on live HMR (in force — the `stage-implement` subagent in fix mode) → recheck of only the fixed items (Step 3.2).

Available checkers:
| Checker | What | Status |
|---|---|---|
| figma-compare | design: tokens/sizes/structure vs Figma | active — agent `figma-compare` |
| proto-compare | design vs HTML prototype + SPEC.md, if the task's source is a prototype | active — agent `proto-compare`, static |
| devtools-verify | runtime: console/screenshots/live state | active — agent `devtools-verify` (the orchestrator holds the dev server) |
| pro-review | code quality: correctness/conventions/duplicates/naming/comments/patterns | active — agent `pro-review` (stage diff, `--stage`) |
| ds-parity | duplicates with the design system: replace with a kit component / move INTO the kit | active — skill `${CLAUDE_PLUGIN_ROOT}/skills/ds-parity`; run on stages with new UI and always before the PR (on a redesign this is the main source of repeated edits at manual review) |
| dead-code | what became orphaned BECAUSE of this diff: symbols, files, locale keys, assets | active — agent `dead-code`; run from stage 2 (nothing to orphan on the first) and before the PR |
| i18n-sweep | hardcoded copy, incomplete locales, dynamic keys, formatting without a locale | active — agent `i18n-sweep`; only in projects with an `i18n` field in the config, on stages with new user-facing text |
| deps-audit | new dependencies and assets: justification, equivalent in the repo, manifest section, weight | active — agent `deps-audit`; only when the diff has a manifest or new binary files |
| responsiveness | widths from `breakpoints` in the config | inside devtools-verify — not a separate checklist item |

**Run the narrow checkers by a trigger, not always.** Every extra subagent costs stage time. `dead-code` is for where something was deleted or replaced; `i18n-sweep` — where user-visible text appeared; `deps-audit` — where the manifest was touched. No trigger → `[skip: no trigger]` in the checklist, do not ask again. They are deliberately narrow and do not overlap with `pro-review`: it answers for correctness and conventions, these three — for one class of junk each, each with its own confirmation procedure.

**Duplicates between stages** are not seen by pro-review in `--stage` mode: every stage is clean inside itself. From the second stage on, its prompt gets the inventory of what earlier stages added, and a "Shared elements" row with a foreign owner is a ban on writing it again (`${CLAUDE_PLUGIN_ROOT}/skills/stage-check/references/cross-stage-dups.md`).

Plus, yourself, without a subagent (in force `stage-implement` runs `lint`/`type_check`/`floor-guard` — take the outcome from its summary if it has numbers against the baseline; "green" without numbers, or no summary — run `type_check` yourself: the hook at commit backs up only floor-guard, and a broken stage in force piles up until the end):
- `lint`, `type_check` and `test` — per `${CLAUDE_PLUGIN_ROOT}/references/heavy-checks.md`: through `run-check.mjs`, lint and test on the stage diff, type_check once on the whole project; the tree did not change since the run in implement — do not repeat. Compare type-check with the config's `baseline` (projects carry legacy debt — compare with the baseline, not with zero).
- **`floor-guard`** — `node ${CLAUDE_PLUGIN_ROOT}/scripts/floor-guard.mjs` (against HEAD; the stage is partly committed — `--base <prev-stage-commit>`); the script prints the violated rule itself. Exit code 1 → every violation is a **major in the fix loop** (fixed, not suppressed); the exception is a violation marked "not in git" in a file the stage did not create (a saved page, a developer's draft): not a finding but a line in the summary. Exit code 2 is not "clean" but "did not look": a line in the summary. Justified exceptions (`floor-ok: <reason>` and the like) are listed separately — in the journal and in "⚠ Awaiting user confirmation".
- **`kit-override-scan`** — a stage with new or changed UI: `node ${CLAUDE_PLUGIN_ROOT}/scripts/kit-override-scan.mjs --out <task_dir>/<TICKET>/checks/stage-<N>-kit-overrides.md`. Every file with kit overrides is a major with an outcome in the report: fixed (the look comes from the kit), false — with the `path:line` of a reference section that does the same, or the user's decision "the look as in the prototype". In force the hook rejects a commit without the report.
- **Parity** — the stage deletes or replaces UI: every removed component is a row of the stage's parity table (stage-plan, Step 3), the rows are `AC-N.P*` criteria with their own verifier. In force the hook rejects a commit without it.
- The dedup audit against `reuse_baseline` from the config (the existing implementation we match against) is **covered by pro-review** (rubric B) — it is no longer run as a separate inline step; duplicates INSIDE the task are covered by the inventory above.

Runtime checking and code review are checker subagents, not the orchestrator's work; it holds the dev server and runs the fix loop. MCP/agent unavailable — the subagent returns a skip.

## Step 2. Verifying findings

Before fixing, verify every checker finding against the code yourself: is it real? (checkers give false positives). "False" — only with proof: a measurement, a code line, and "long-standing" — with a check on the base. The outcome of every critical/major finding and every FAIL goes into the `## Findings outcome` section of its report: fixed / false / user decision (`${CLAUDE_PLUGIN_ROOT}/references/checker-report.md`), in the task language (markers — `${CLAUDE_PLUGIN_ROOT}/references/language.md`). Sample lines: `fixed: Button.vue:34 — radius 12px, rechecked by figma-compare`, `false: <proof — measurement, code line>`, `user decision 2026-10-16`. "Leaving it" and "in Awaiting confirmation" are not an outcome: that is a decision not to fix, and the user makes it. **Any conflict of sources of truth** — Figma vs adaptive/webview, Figma vs the user's reference sample, old behavior vs a new requirement — do NOT resolve yourself, escalate to the user with options. If the fork is about user-visible BEHAVIOR — offer, together with the options, a live demo of the alternatives on the dev server before implementation (the rule from /stage-kickoff, Step 4: a choice made in the abstract unfolds after the first live look). Reference artifacts (animation samples and the like) must be read in full, including the components' mechanics, not just excerpts; if a file is unreadable (a bundle) — ask the user for a readable version.

## Step 3. Fix loop (2 iterations + one fresh run)

1. Fix the confirmed critical and major findings. Minor — fix if trivial; otherwise list in the report.
   **The cause of a finding is not obvious or the first fix did not work → `${CLAUDE_PLUGIN_ROOT}/skills/root-cause`**, not a second fix by guesswork: in a monorepo with linked packages an "inexplicable" defect more often lies in the environment than in the diff, and guessing burns both iterations before the cause is even named.
2. Recheck **only the fixed items**: code — pointwise by `file:line` yourself (in force too — from the fix summary and the diff); visual and runtime findings — a short run of the checker subagent on them only. A full checker run is only the fresh one in item 3.
3. Did not converge after the 2nd iteration → **the third and last attempt goes to a fresh subagent of the same checker, not to the orchestrator**. The prompt gets only the unconverged `AC-*`, the paths of their files and what must hold; the history of the two failed fixes and explanations of why it is "already fixed" stay out of it. **The model is `review_model`** from the config (default `opus`), passed as the `model` parameter when calling the agent: the last check goes to the strongest model. In force it also differs from the author (the code is written by `stage-implement` on sonnet); in the normal mode what matters is the subagent's fresh context, without the history of failed fixes, not a different model. The same rule applies to the whole-branch pro-review at the end; without `model` the agent-guard hook rejects it.
   The motive is the maker/checker of Step 1: after two rounds the orchestrator rechecks its own attempts, not the code; a fresh checker sees only what is in the code, and costs less than any escalation.
4. Did not converge on the fresh run either → stop, escalate: a list of "what did not converge and why", with both verdicts — the orchestrator's and the fresh run's. The disagreement between them itself shows where to look: they agree — the defect is real and the user is needed; they differ — the orchestrator fixed something other than what the checker checked.

**The checker sets the severity** — in both modes: an exhausted fix loop with a critical is a stop and an escalation, not a downgrade to major.

## Step 4. Closing the stage

1. Update STAGES.md: the pipeline checkboxes, the stage status, an entry in the "Journal" (date, checker verdicts, what was fixed, what was escalated). A checker is marked `[x]` after the outcome of all its findings is in the report; an incomplete outcome is returned by the journal-gate hook. Next to each criterion of the stage mark its outcome — `AC-2.1 ✅ figma-compare` / `AC-2.3 ⏳ user-review` / `AC-2.5 [live: user-side]`: a stage cannot be closed with a criterion that has neither an outcome nor an explicit note of who checks it later. **The outcome names the checker from the tag**: for `devtools-verify` — it, smoke, or "checked live"; for a design tag — only the checker itself; "✅ pro-review by code" on a runtime criterion is "⏳ devtools-verify". Violations in new lines and bare PASSes in `checks/` are returned by the journal-gate hook. **The journal is mandatory, not optional**: together with the decisions from /stage-kickoff it is the saved flow of "what was at which stage, when, why and what was decided". **The last line of the entry is the stage metrics, one line in a fixed format**, `scripts/retro.mjs` collects it for the retro on real numbers, not from memory:
   `metrics: stage=3 checkers=figma-compare,pro-review,devtools-verify skipped=dead-code,i18n-sweep findings=11 dropped=3 iterations=2 fresh=no escalations=0 floor=0 diff=+412/-30`
   The fields and their meaning — `${CLAUDE_PLUGIN_ROOT}/skills/stage-check/references/metrics.md`.
   **An entry is 3–6 lines**, the details live in `checks/*.md`, the journal links to them (2KB paragraphs bloat a file that every session reads). Status wording is neutral and descriptive ("waiting for the repo to be connected", not "BLOCKED — /add-dir needed"): imperatives and commands in statuses trip the auto-classifier of edits.
   **Product-visible changes** (new defaults, gating, "who now sees what") from the stage's implement — a separate line in the `## ⚠ Awaiting user confirmation` block of STAGES.md saying WHERE the change is visible; a note in the journal prose does not count. user-review closes such an item ONLY if it was done on a link/state where the change actually shows — acceptance on data where it is not visible does not clear the item.
2. **Archiving — by script, not by hand**: the stage is moved to `done`/`cancelled` → `node ${CLAUDE_PLUGIN_ROOT}/scripts/archive-stages.mjs <task_dir>/<TICKET>/STAGES.md --apply`. It moves the full blocks of closed stages and the journal entries beyond the 8 freshest into `STAGES-ARCHIVE.md`, leaving the heading, the "Commit"/"Decisions"/`metrics:` lines and a link. If a collapsed stage needs a line of key decisions, write it as a `Decisions: …` line BEFORE the run, it will be kept. STAGES.md is read by every session — only the active stuff lives in it.
3. Save the checker reports in `<task_dir>/<TICKET>/checks/` strictly under the name `<checker>-<stage>.md` (`pro-review-3.md`, `figma-compare-3.md`; final and task-wide ones — `<checker>-branch.md`, a repeated run — `-branch-2.md`, `-3`; a recheck by a fresh run — `<checker>-<stage>-fresh.md`). One name for everyone — otherwise neither a human nor `retro.mjs` can find the stage's reports.
4. **The stage commit is a mandatory artifact of the step, not an option.** The message is prepared ALWAYS, at every stage, even if the user commits themselves. The format is below.

   Who runs the command depends on the mode:
   - **Normal mode (default):** show `git status` + the ready message and wait for the user. **"Offer" means give the text, not run the command** — `git add`, `git commit`, `git push`, `gh pr comment`/`gh pr create` are not run at all, even as "preparation" (on the task branch the plugin hook rejects them anyway — at any stage status): the index and external communications belong to the user, and an attempt to touch them spends the user's refusal at every stage.
   - **Force mode** (`/stage-force`, STAGES.md has a "Force run" block without "completed" in its heading; the hook looks only at the task of the current branch): commit yourself — `git add` of the needed paths + `git commit`. Push and PR stay forbidden always.

   Offer the commit RIGHT AFTER the fix loop closes, do not pile several packages of edits in the tree: what is uncommitted is wiped by a rebase/switch. More than one package of uncommitted edits in the tree — explicitly mark it in the summary as a risk.

   **The commit message**: `<TICKET>: <what was done>` — one line up to ~72 characters, about the substance of the change, not "stage N"; the body — only the "why" and only if the heading does not fit it; the prefix style — as in `git log <main_branch>`. **No service signatures** (`Co-Authored-By`, a line about generation by a tool) — the user's decision for all their repos. Examples and the breakdown — `${CLAUDE_PLUGIN_ROOT}/skills/stage-check/references/commit-message.md`.
5. After the commit, offer the user to close the session — `/clear` and `/compact` are typed only by them (in force do not offer: stages run as subagents, `/stage-force` Step 1). **`/clear` is the default** (the new session starts from the status line of the session-start hook and a read of the compact STAGES.md — that is the task's memory); `/compact` — only if related work is left in THIS session.

## Context hygiene

Rules for the whole task, not only for checking (Figma and chrome-devtools dumps — only in subagents, no direct calls from the main context, and if some were made anyway — offer the user `/compact`; pointwise reading of trackers, one DESIGN-QUESTIONS.md) — in `${CLAUDE_PLUGIN_ROOT}/references/context-hygiene.md`. Read it once per session if implementation is going on in it.

## Output — summary to the user

```
Stage N: <name>
Environment: ok | <red preflight item — what was done>
Diff: +A/−R | <size risk, if any>
figma-compare: PASS after 1 fix iteration (was 3 major) | pro-review: Approve with comments (2 minor) | devtools-verify: PASS | lint: ok | type-check: ok
Criteria: AC-N.1…N.4 ✅ | AC-N.5 ⏳ user-review
Fixed: ... | Escalation: ... | skip: <checker — reason>
Ready to commit: <TICKET>: <message>
```

Never mark a stage `done` if critical findings remain, the pro-review verdict is Request changes, findings have no outcome, escalated questions are unanswered, an `AC-*` criterion has no outcome, or ✅ carries a reservation ("not captured", "by code only" are ⏳).
