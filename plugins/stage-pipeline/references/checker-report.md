# Checker report and findings outcome

A checker report is written in the language of the task (the "Language:" line in the STAGES.md header). The service markers that scripts read — the summary line, the headings "Findings outcome" and "Could not verify" — are English for an English task; for a Russian task take their Russian forms from the marker table in references/language.md.

The first part is read by every checker: it is the report format. The second is read by the orchestrator: it is the findings outcome after the fix-loop. Both are checked by `scripts/journal-check.mjs` and enforced by hooks: journal-gate when a report or the journal is written, git-guard on a force commit. A violation goes back to whoever wrote the report or the journal, in the same turn.

Where this comes from. In three tasks in three repos reviewed on 2026-10-04, most of what the user found after "done" had already been found by the checkers. The orchestrator wrote the findings off as "leaving it", "accepted as a compromise", "into Awaiting user confirmation", "a question for Vlad". In one task 5 of 8 defects went that way; in another, 11 of 12 deferred findings later had to be fixed anyway.

## Checker report

1. **The summary is the second line, right after the title, in one form:** `Findings: critical N · major N · minor N`. A verdict may follow it. Without this line findings cannot be counted, and the hook returns the report.
2. **Severity is only `critical`, `major` or `minor`.** "Question", "ask the backend", "minor-major", "not frontend" are not severities. Weigh the consequences for the user and pick one of the three. Put a question for product or backend into the text of the finding. Example: in one task devtools-verify recorded a 20-point score mismatch as a "conclusion" with no severity, and a day later it became a user's fix.
3. **A FAIL on a criterion is a finding too**, even if the table has no row for it.
4. **The "Could not verify" section is mandatory.** If it is empty, say so: "everything verified" (of what was passed in). In a runtime checker, "no data", "no bookings on the account" and "no test leads" are not a reason: the state is put in place (`skills/devtools-verify`, "States without data").

## Findings outcome — written by the orchestrator

After the fix-loop, before the stage commit, a section is appended to the end of every report that has critical, major or FAIL:

```markdown
## Findings outcome
- M-1 — fixed: use-express-form.ts:104, rechecked by fix round 1
- #2 — false: 109×32 is the native size of full-logo.svg, the mockup shows 92 — the same image under a mask (node 463:199)
- AC-5.9 — B1
```

One line is needed for every critical and major finding and for every FAIL. The ID is as in the report: `M-1`, `#2`, `F10`, `AC-5.9`. A line is optional for a minor, but a minor without an outcome lands in the run summary as "not fixed".

Allowed outcomes:

- **`fixed: <file:line or how it was rechecked>`**.
- **`false: <proof>`** — a measurement, a line of code, a frame. "Pre-existing", "not a regression", "existed before the task" also make a finding false for this task, but only with proof on the base: the base sha, or a prod URL with a measurement. The word "pre-existing" without a check on the base is not enough: in one task such a hydration mismatch was written into the prompts of four checkers as "not a finding", and nobody ever checked it on the base.
- **`false: <proof>` is read for its kind of proof (VT-1 stage 5, reports written from release 0.18.0).** These do not dismiss a finding: "the fix is impossible" or "the kit / the backend owns it" with no `file:line` in the kit, the contract or the tool; "not reproduced" without two attempts and the route taken (`not reproduced (2 attempts, /root-cause)`, `(3 cold loads on /orders)`); "demoted to minor" as the reason; "this stage did not change it" without a base sha, a diff range or a `git` command; "a later stage owns it" proved by a plan line only; the same report, an acceptance criterion of the run or a force-run assumption as the only basis; "false for the data" from a sample; "not related to the task" with no diff command or range. The finding stands: a fix, a blocker `B<n>` or a user decision.
- **A critical dismissed as false goes to the fresh pass on `review_model`** (`/stage-check`, Step 3.3), and its line cites the fresh report: `C-1 — false: <proof> — fresh report checks/pro-review-3-fresh.md`. The hook checks that the file exists and is the fresh report of the same checker and stage (`<checker>-<stage>-fresh*.md`).
- **`B<n>`** — a blocker of the force run (`/stage-force`, Step 2). In normal mode — `user decision <date or "quote">`.

Not an outcome (the hook returns it): "leaving it", "accepted as a compromise", "into Awaiting user confirmation", "won't fix", "to the kit", "to FINDINGS", "as a separate task", "a question for design / product / backend", "out of scope" without proof. All of these are a decision not to fix, and the user makes it, not the one whose work was checked. A finding that the fix-loop did not fix is a blocker, not a line in "Awaiting user confirmation". "Awaiting" is for product decisions with no defect: a new default, a text, an order.

## Where this is checked

- **journal-gate, report write:** no summary line; a weak `false` (above); a critical dismissed without a cited fresh report; a forbidden outcome; "pre-existing" without proof; for devtools-verify — no `geometry` line, no `style-diff` on a stage with a "Visual reference", "no data" instead of putting the state in place.
- **journal-gate, journal:**
  - a mark `[x] <checker> (checks/<report>.md …)` while the outcome in that report is incomplete;
  - ✅ with a caveat "not captured", "not verified", "from code only", "partly";
  - a Force run block heading "completed" while blockers are open or reports have no outcome.
- **git-guard, force commit:** new reports of the task without a complete outcome; kit overrides in the diff without a `kit-overrides` report.

The report `checks/stage-<N>-kit-overrides.md` is written not by an agent but by the script `scripts/kit-override-scan.mjs --out …`: every file with kit overrides is a major. The outcome is the same: fixed (the look from the kit), false — with the `path:line` of a reference section that does the same, or a user decision "the look as in the prototype". A repeat scan after the fixes does not erase the outcome.

The weak-dismissal and fresh-report rules look only at reports written after the plugin first saw the task on release 0.18.0 or later (the snapshot lists the reports that were there). Only reports written after the plugin first saw the task on this version are checked. Old tasks need not be rewritten.
