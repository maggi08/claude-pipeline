# TODO

The backlog of plugin work that is agreed but not started. A task moves out of here when it gets its own `.claude/tasks/<ID>/STAGES.md`; its PR removes the line.

## Speed (measured 2026-11-09 over 47 force runs; plan of 2026-11-09)
Item 1, `scripts/hooks-test.mjs` in parallel, is done by VT-8. Item 2, cheaper checkers, is done by 0.25.0: the security review and `ds-parity` are agents on sonnet. Measure the time of both on the next real force run (the 9-minute median was on opus general-purpose agents).

3. ~~Narrower runtime rechecks~~ — measured on 2026-11-10 and dropped. In 60 days, 218 rechecks already used one or two widths and frames, and on 0.25.0 the agent rechecked only the named finding when the prompt was exact (one eval run). Recheck time goes to the agent's own Playwright scripts (374 min) and to build waits (193 min), almost all in mycar-new-cor and mycar-core. If those repos matter, find out why they fall back to scripts: a busy browser profile, a login, or a production build for hydration.
4. Close a stage in one script call — measured on 2026-11-10 and parked: about 11 min of bookkeeping per headless run (journal scripts, STAGES edits, git status and commit). Hook bounces were 321 in 10 days, but the median episode is one round. The one long chain that was a false alarm ("ran on another tree") is fixed in 0.25.1.
5. Parallel tracks inside one task, when a real task needs them: stages in another repo (ui-lib next to core) or in another package of a monorepo, with a maker lock per repo instead of per task.

## CPU load across parallel sessions (asked 2026-11-09)
Several stage-pipeline sessions run at once in different repos, and the machine can stop responding. Wanted:
- a priority per task, with more CPU for a higher priority;
- a session that waits (for an answer, a review, a limit) gives its share to the others, and a stopped task frees it;
- heavy checks (tests, builds, dev servers) queue instead of all starting at once.

VT-8 only lowers the priority of its own test workers and sizes them by the load average at start. The rest is a separate task. What VT-8 measured: on a quiet machine (load average 2–5) hooks-test takes 78–81 s; next to other sessions (load 5–12) its workers give way and it takes 123–216 s.

## Unattended force runs (asked 2026-11-09)
- Usage limits during a force run: track how much limit is left while the run goes. If the limit runs out before the run is done, schedule a job for the reset time that resumes only that force run, nothing else.
- A night queue: plan several tasks (say three) with `/stage-plan` as usual, then queue them so they run one after another in force mode, for example overnight on a second, weaker machine. A queued task that hits the limit waits for the reset like above, and the next task starts after it.

## Evals
- The two cases of 0.25.0, `security-review-branch` and `ds-parity-hand-rolled-dialog`, wait in `evals/pending/` for a failing run on the ablated agent. `--record-failing` refuses `--pending` and writes into `evals/cases/`, so: move a case to `evals/cases/`, run `node scripts/eval.mjs --ablate agent:<name> --record-failing <case>`, and commit the case with its `provenFailing`. The security review's scale was tightened after a sonnet run rated a cross-account IDOR major; watch its severity on real branches.
- The eval follow-up PR of VT-1: M-1 and S-1 of the hill-climb driver, harder `pro-review` cases, an eval case for the delta mode, the eval cases of 0.20.0–0.22.0, the first paid climb. Paid; needs a budget.
