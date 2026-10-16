# Precedents of the /stage-check rules

Where each rule came from. The file is not needed to run a stage — the rules in `SKILL.md` are self-sufficient; it is needed when you want to weaken or rewrite a rule.

| Rule (Step) | Precedent |
|---|---|
| The inventory of past stages goes into the pro-review prompt (Step 1) | The manual PR review brought 10 remarks, 6 of them duplicates spread across stages: reference data, legal links, `formatTime`, a step wrapper in 4 copies, the step order in 3 places, a provider on top of an existing hook. Every stage was closed with a green pro-review. |
| Product-visible — a separate line in "Awaiting confirmation" (Step 4.1) | "CONFIRM at user-review" drowned in the journal prose and surfaced only at QA. |
| The journal is mandatory (Step 4.1) | The team ONBOARDING.md is assembled from the journal; without a journal there is nothing to explain the task's approach with. |
| Archiving by script (Step 4.2) | A measurement over 30 live tasks in four repos: 17 STAGES.md files larger than 40 KB, up to 153 KB (≈40k tokens on every read); with the manual rule five tasks had an archive. Journal entries of ~2 KB against the "3–6 lines" rule. |
| One report name `<checker>-<stage>.md` (Step 4.3) | Live tasks had four schemes: `pro-review-2.md`, `stage2-pro-review.md`, `stage-2-pro-review.md`, `stage-2/pro-review.md`. |
| The `metrics:` line in the journal (Step 4.1) | The 0.2.0–0.8.0 retros relied on numbers from memory; none of the 182 closed stage entries contained machine-readable metrics. |
| The commit in normal mode is text only (Step 4.4) | A measurement on one task: of 40 rejected calls more than half were `git add` and `gh pr comment`. Since 0.9.0 the rule is also held by the `git-guard` hook. |
| Commit right after the fix loop (Step 4.4) | A rebase destroyed applied but uncommitted cleanup edits; they were restored from memory. |
| `/clear` after a stage is the default (Step 4.5) | A measurement over four days: 177M cache-read tokens, 98M of them in one marathon day; the average request context was 234k. |
| The outcome of a criterion names the checker from the tag (Step 4.1, the journal-gate hook) | In one task 24 runtime criteria were closed with "✅ pro-review by code" while devtools-verify was off; two of them — a contract that did not save and pagination on an incomplete page — the user found themselves. The review report said "4.5 PASS" with no measurement. |
| A design checker skip — only logic-only or no source, judged by the actual diff (Step 0) | The static proto-compare was skipped on every UI stage of one task with the reasons "staging does not accept the token", "MCP-Chrome is busy"; in another task the skip "visuals do not change" was written into the plan, and the stage added visible form errors. |
