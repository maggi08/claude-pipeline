---
name: stage-kickoff
description: Мини-оркестратор ОТКРЫТИЯ этапа задачи — перед реализацией показывает пользователю план этапа, сводит его с накопленными правками/TODO/вопросами, собирает бизнес/UX-ввод, фиксирует решения в STAGES.md и берёт sign-off, затем запускает спеку. Парен к stage-check (закрытие). Use when starting/opening a new stage, before implementation begins.
---

# Stage Kickoff — opening a stage

Goal: do not start coding blind. Edits that arrive in the MIDDLE of a stage cost rework — it is cheaper to collect everything at the entrance. Kickoff shows the stage plan, checks it against what has piled up, takes the product input and the sign-off — and only then hands over to implementation.

This is the pair of /stage-check: **kickoff opens the stage, check closes it**.

> **Project config.** Take `<task_dir>` and the code layout from `<repo>/.claude/pipeline.config.md` (no file — `/pipeline-init`). `<task_dir>` = the `task_path` field (default `<repo>/.claude/tasks/ (in the repo)`).

> **Task language.** Read and write the service headings and fields of STAGES.md (`## Journal`, `Decisions:`, the "Awaiting user confirmation" block and the rest) in the form of the task language — the `Language:` line of the header; the English and Russian forms are in the table of `${CLAUDE_PLUGIN_ROOT}/references/language.md`. Write the free text (journal entries, decisions) in the task language as well.

## Input

- `<task_dir>/<TICKET>/STAGES.md` — required (the task plan). If missing, suggest /stage-plan and stop.
- The stage number/name (if not given — the next `todo` in order).

## Procedure

### Step 1. Read the stage
From STAGES.md: scope, Figma nodes, acceptance criteria (`AC-*`, WHEN/THEN), what to reuse, where to match with adaptive/webview, plus the rows of the "Shared elements" table where this stage is listed as the CONSUMER — their owner is already written, and there is nothing to write again. Read selectively (offset/grep), not the whole file — STAGES.md can be big.

**The criteria quality gate — before sign-off, not after.** What is checked here is not the implementation (it does not exist yet) but the wording itself: an unmeasurable criterion passes into implement unhindered and surfaces as an edit after the PR. Run the stage's criteria through eight questions:

1. **Measurable?** There is a token, a number, a state name or an observable event. "As in the design", "neat", "noticeable" are not criteria but intentions.
2. **Verifier named?** The `[verify: …]` tag is present and reachable at this stage (`figma-compare` for a logic-only stage is a contradiction, `devtools-verify` without MCP is `skip`, not "we'll check").
3. **States closed?** For every screen of the stage, empty / loading / error / offline are either described by a criterion or explicitly moved out by an "out of stage" line.
4. **Copy from the source?** User-facing text is either taken from the source or marked with a placeholder — and then it is a question in `DESIGN-QUESTIONS.md`, not "we'll fix it later".
5. **No dangling `[Gap]` / `[Ambiguity]`?** An unclosed fork in the stage's criteria does not live to implement: it is either closed by a fact from the source (Step 4), or goes into the question batch, or the stage is explicitly narrowed.
6. **Example named by a path?** "Like X", "as now", "as before" in a criterion or decision carry the `path:line` of X — read it now and carry into the criterion what is actually there (conditions for a button being active, what goes to the server). A line without a path is returned by the journal-gate hook.
7. **Actions with conditions — a table?** Saving, sending, a status change with conditions — a "state × action" table (stage-plan, Step 3). Show the user separately a cell where the action saves nothing or loses what was entered: a criterion that locks that in will pass all the checkers.
8. **UI stage: reference, parity, vocabulary?** A "Visual reference" is named (a neighboring section, path and URL); the stage removes or replaces UI — there is a parity table; it shows statuses — a matrix "place → API field → text". A look "as in the prototype" instead of the kit is a user decision, not a default.

Failed items are not a blocker for the stage but material for Steps 3 and 4: you show them to the user in the form "this is unverifiable, I propose this". A criterion reworded at kickoff is edited in STAGES.md right there (the ID is kept).

### Step 2. Merge with what has piled up
Collect everything that may affect this stage, BEFORE the start:
- `<task_dir>/<TICKET>/DESIGN-QUESTIONS.md` — open questions relevant to the stage (🔴/🟡).
- **The "⚠ Awaiting user confirmation" block in STAGES.md** — if non-empty, show it to the user at EVERY kickoff until the items are explicitly confirmed (otherwise a product change lives to QA and gets reversed).
- The "TODO from the user" and "User decisions" blocks in STAGES.md.
- Escalations and "questions to the designer" from the journals of past stages.
- Mid-flight decisions from the recent dialogue that are not yet recorded.
Note what of this changes the scope/approach of the current stage.

### Step 3. Show the stage plan to the user
Compactly (not a dump): what we build, which components/composables we **reuse** (specific paths), what we write from scratch, which decisions are needed, which questions are open and how you propose to close them. If a Figma spec is needed — say that you will run `figma-spec` after sign-off (the spec itself does not go into the kickoff context, it goes to a subagent).

### Step 4. Collect business/UX input
Ask directly: "what should be taken into account or added from the product/user side before the start?". Let the user add requirements, edge cases, priorities. An open question collects what the user thinks about on their own; to not lose what they do not think about, walk the user through the taxonomy of categories from `/stage-force`, Step 0 — but only the categories relevant to this stage, and ask only about the statuses `Partially`/`Not covered` with a real impact on the implementation. Open design questions that they cannot decide now go to DESIGN-QUESTIONS.md; do not block the start with them if the stage can be implemented without them.

**A behavioral fork → a demo before implementation.** If the decision concerns BEHAVIOR visible to the user (defaults, gating, when what is shown) — do not ask to choose in the abstract: offer a live demo of both alternatives on the dev server (a toggle/temporary patch/query parameter) BEFORE the full implementation. A choice "in words" is reversed after the first live look; a 5-minute demo is cheaper than a cycle of implementation + tests + rollback. Visual tokens/sizes do not need a demo — the checkers catch them.

**A fork between visual variants (skins) is closed by a FACT, not by a vote — and before implementation.** If the design source contains more than one visual variant of one screen (a skin, glass/flat, Modern/Classic, proposal/current), this is NOT a question of taste for "Awaiting user confirmation" — it is the question "which of them did the source actually deliver", and it is resolved by reading the source: the class on the root element of the flow file, whether the toggle is wired, whether there is an overriding block in the CSS, what the self-describing comment says (the method is `${CLAUDE_PLUGIN_ROOT}/agents/proto-spec.md`, step 0, or figma-spec for Figma projects). You may ask the user only when the source really gives two live variants.
The rule: **the chosen variant goes as a line in the stage's decisions with a `file:line` reference it follows from.** A variant chosen without such a reference is not considered closed and must not go into implement: an item "settle the glass skin" in the confirmations block lives to QA and comes back as a full circle of edits.

### Force mode — where the procedure changes

STAGES.md has an unclosed "Force run" block (no "completed" in the heading — the task is running through `/stage-force`) → steps 3 and 4 are not performed as stops: the stage plan is not shown to the user and sign-off is not requested — the questions were already collected by the interview at the run start. Steps 1, 2 and 5 stay: the stage is still read, merged with what has piled up, and its decisions are still written to STAGES.md.

The criteria quality gate (Step 1) stays in force, but its failures wait for no one: reword an unmeasurable criterion to a measurable one yourself and record the edit in STAGES.md; if it becomes measurable only after a product decision — a line in "⚠ Awaiting user confirmation" saying where it is visible, and go on with the plan.

If merging with what has piled up (step 2) reveals a fork that was not in the interview, in force this is not a stop either. Decide a reversible one yourself with a line in "⚠ Awaiting user confirmation". Park an irreversible one or a conflict of sources as a blocker and bring the stage to the end without it (`/stage-force`, Step 2).

### Step 5. Record and sign-off
- Write what was agreed to STAGES.md: the stage's decisions — as a `Decisions:` line in the stage block (archiving keeps it), business input and the course of the discussion — into the "Journal" (date, what was decided and **what for**). This is part of preserving the flow, not optional. Compactly: 3–6 lines, details → `checks/`/`specs/`.
- A stage without visual changes — mark `logic-only` in the stage heading (design checkers skip, see /stage-check Step 0). Acceptance criteria reachable only under a login — mark `[live: user-side]` right away if the authorized Chrome profile is unavailable (see the devtools-verify skill).
- Take the user's explicit **sign-off** for the start. Do not begin implementation without it (unless they explicitly allowed going on without confirmation in advance).
- After sign-off: run `figma-spec` (a subagent, spec → `specs/<stage>.md`) and pass it to implement.
- The stage relies on a third-party library API you are not sure about (a new dependency, a fresh major, a rare option, a migration) — before the code, run the `docs-lookup` subagent (types and CHANGELOG of the installed package for the version from the lockfile). The answer goes into the stage's spec, not a dump of documentation into the main context.

## Output — summary to the user

```
Stage N: <name> — kickoff
We build: <1–2 lines>  | We reuse: <composables/components>
Stage decisions: <what was agreed>  | Open questions: <in DESIGN-QUESTIONS>
Waiting for: sign-off for the start (or edits to the plan).
```

Never move to implementation while there is an unanswered question that blocks the scope of the stage.
