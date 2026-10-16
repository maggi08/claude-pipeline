---
name: task-converge
description: Сверка ТЕКУЩЕГО состояния кода с намерением всей задачи — критериями приёмки всех этапов, решениями журнала и границами скоупа. Не diff-инструмент — отвечает на «что из обещанного не сделано и что сделано, но никто не просил», безотносительно того, каким дифом это въехало. Use before opening a PR, after all stages are done, or when the user asks what is left / whether the task is actually complete. Дописывает недостающее догоняющими этапами, ничего не переписывая.
---

# Task Converge — code against the intent of the task

All the pipeline checkers look at the **diff**: `pro-review --stage` — at the stage diff, whole-branch — at the branch diff, `figma-compare` — at the changed files against the design. That answers the question "is what was done done right". The question "is everything that was promised done, and is nothing extra done" a diff cannot ask: a criterion nobody implemented does not appear in the diff at all, and its absence is invisible by definition.

Converge asks this question. It reads the intent of the task (the `AC-*` criteria of all stages, the journal decisions, the boundaries) and compares it with the **current state of the code on HEAD** — without `git diff`, without history, without a comparison base. By which stage a criterion was closed and whether it was closed at all does not matter to converge: what matters is whether it holds in the code now.

> **Project config.** Take `main_branch`, `<task_dir>`, the code layout, the platforms and the commands from `<repo>/.claude/pipeline.config.md` (no file — `/pipeline-init`).

> **Task language.** The task has one language, the `Language:` line in the STAGES.md header. The report, the catch-up block and the summary are written in it; service headings and fields (`Findings:`, "Could not verify", the catch-up heading) come from the table in `${CLAUDE_PLUGIN_ROOT}/references/language.md`. The samples below are the English forms.

## What it is not

- **It does not look for bugs** — that is `/pro-review`.
- **It does not look for orphans** — that is `dead-code` (what is orphaned because of the diff). Converge catches something else: live, used code that no criterion asked for.
- **It does not look for duplicates with the kit** — that is `/ds-parity`.
- **It does not compare with the design** — that is `figma-compare` / `proto-compare`. Converge trusts the criteria, not the source: if a criterion is worded wrongly, that is a defect of the plan, not a converge finding.
- **It does not fix.** It writes a report and appends catch-up stages; the implementation is done by the regular cycle `/stage-kickoff → implement → /stage-check`.

## Input

- `<task_dir>/<TICKET>/STAGES.md` — required. If missing — suggest `/stage-plan` and stop.
- `STAGES-ARCHIVE.md` — the full records of closed stages (the criteria are there too if the stage is folded).
- `checks/*.md` — the checker verdicts: what closed each `AC-*` and what remained `⏳`.
- The blocks "⚠ Awaiting user confirmation", "Not included in the plan", "Design source coverage", "Boundaries" (in a force run).

## Step 1. Intent inventory

Collect into an internal model — do not dump the raw material into the report:

- **Criteria** — all `AC-*` of all stages, including folded and archived ones, with their verifier tags and recorded results.
- **Decisions** — journal lines that fixed a product or architectural choice ("we reuse X", "the theme from a class on `<html>`", "the modal through the shared hook"): this is intent too, and the code must match it.
- **Plan tables** — the "Parity" rows (a function of the removed UI → where it is now) and the "state × action" cells are inventory items on a par with the criteria. A function of the old UI that is nowhere in the code is `missing`, even if the row was forgotten to be made a criterion: what quietly disappeared when a section was removed is seen neither by pro-review nor by the per-stage checkers.
- **A decision "like X" with a path** — compare the logic with the example X (the conditions of activity, what goes to the server), not only the presence of a similar element.
- **Boundaries** — what the task explicitly does NOT do. They are needed to classify `unrequested`: code outside the boundary is a finding, even if it is good.
- **Code scope.** The paths from the stages, `specs/`, the checker reports plus a search by the concepts of the criteria. **Do not go beyond the scope** — converge is not an audit of the repository; whatever does not follow from the task artifacts is outside it.

Cancelled criteria (`[cancelled: …]`) do not go into the inventory, but their implementation does not fall into `unrequested` either: mark it with the line "implemented by a cancelled criterion" and leave the decision to the user.

## Step 2. Classification of gaps

For each inventory item look at the code and raise a finding **only where there is a divergence**. The type is mandatory:

| Type | What it means | Typical source |
|---|---|---|
| `missing` | the required thing is not in the code at all | a criterion no stage took on; a state forgotten in a transfer |
| `partial` | it exists, but the criterion is not met in full | the happy path is done, no error/offline; done on one platform of three |
| `contradicts` | the code does something that contradicts a criterion or a journal decision | a later decision overwrote an earlier one; an edit of stage 5 broke a criterion of stage 2 |
| `unrequested` | the code is live and used, but there is no requirement for it | a leftover of an experiment, a silently widened scope, a neighboring feature closed "on the way" |

**Status vocabulary.** One state labeled with different words on one screen ("Expired" in the bar, "Not sent" in the panel) is `contradicts` between the elements of the screen, even if each label separately matches its own criterion: each piece brought its own source, and the user sees the whole screen.

`unrequested` is the only type no one else in the pipeline catches, and the only one for which converge **proposes nothing to delete**: it puts it to the user's decision ("this is needed and a criterion is worth adding" or "this is extra and goes away"). A silently widened scope is the most expensive exactly at the PR review, where a human sees it first.

**Little code or none** (converge was started early) — this is not an error: the whole declared scope goes as `missing`, the report stays valid.

**A divergence because of source drift.** If a criterion does not match because the design source changed, not the code — it is `contradicts` with the mark "source drift: the criterion describes the state of the source on the date X". Do not rewrite either the criterion or the code yourself: the conflict of sources of truth is resolved by the user (the rule from `/stage-check`, Step 2).

## Step 3. Confirmation

As with the other checkers, confirmation is the main part of the work: "not implemented" on implemented code zeroes the trust in the report.

- Before writing `missing`, look for the concept of the criterion **in several ways**: by the entity name, by a copy string from the UI, by a token/class name, by a route. In a monorepo — across all applications and packages, not only the main one.
- Confirm `partial` by pointing out which exact part of the criterion is not met — "no offline branch", not "partly done".
- `contradicts` requires two references: where in the code and which item of the intent is violated (`AC-2.3` / a journal line from a date).
- Confirm `unrequested` by the fact that the symbol is **used** (otherwise it is `dead-code`, someone else's area) and that no `AC-*` requires it.
- Criteria with the result `⏳ user-review` or `[live: user-side]` are **not closed** by converge — they go in a separate list "a human checks", not into findings.

Each finding carries a "how checked" column. If not confirmed — into "in question", not into findings.

## Step 4. Report

Save to `<task_dir>/<TICKET>/checks/task-converge-branch.md` (a repeated run after a catch-up — `task-converge-branch-2.md`, `-3`):

```
| # | Type | Severity | Intent | What is in the code | How checked |
|---|-----|----------|-----------|------------|---------------|
| C1 | missing | critical | AC-3.2 | no offline branch in any of the three contexts | grep by the concept + routes, 0 matches |
```

Severity — in the vocabulary of the pipeline: `critical` — a criterion of a P1 screen is not met or a decision from the `MUST` conventions is violated; `major` — `missing`/`partial` on a main criterion; `minor` — a small `partial`, polish, a low-risk `unrequested`.

Metrics as a line: criteria checked / decisions checked / findings by type / "a human checks".

As separate lines — **in question** and **a human checks** (`⏳`, `[live: user-side]`).

## Step 5. Catch-up — append-only

If there are findings — append to the **end** of STAGES.md a block of catch-up work. The rules are strict, because STAGES.md is the memory of the task between sessions:

- The heading `## Catch-up <date>` and under it stages of the regular format (criteria, pipeline, commit) — that is, the catch-up goes through the same cycle `kickoff → implement → checkers`, not "quick edits".
- **Do not touch anything existing**: do not rewrite, renumber or delete either stages, or criteria, or the journal. New criteria get the next free numbers of their stage; IDs are never reused.
- The order inside the catch-up: `critical` and `contradicts` first.
- Each line refers to its intent: `AC-3.2` / "the decision of 2026-08-12" / "task boundary".
- `unrequested` is **not turned into a task to delete** in the catch-up — it goes as a line into "⚠ Awaiting user confirmation" with the question "is this needed in the task".
- If there was already a previous catch-up — add a new block below, do not touch the old one.

No findings → **do not change STAGES.md at all**, not even with an empty heading. Say "converged" and attach the metrics of what was checked.

## When to run

- **Mandatory** — in the "Final checks" before the PR: converge closes the question "is the task really finished", which the per-stage checkers cannot answer.
- Useful — after a big series of stages on a long task, without waiting for the final: the earlier a `missing` is found, the cheaper the catch-up.
- After a catch-up — a repeated run. The cycle `catch-up → converge` goes until "converged", like a fix loop, but it has no limit of 2 iterations: it does not fix blindly, it compares with the intent.

## Output — summary

```
<TICKET> — converge: <converged | catch-up of N stages>
Checked: criteria M, decisions K, platforms P
Findings: missing X / partial Y / contradicts Z / unrequested W  (critical A, major B, minor C)
A human checks: AC-*, …
Appended to STAGES.md: ## Catch-up <date> — stages …   | For confirmation: …
```

Never report "converged" if `critical`/`major` findings or unconfirmed items remain: "converged" is a pass into the PR, and the price of a mistake here equals the price of a manual review.
