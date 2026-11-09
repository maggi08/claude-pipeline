# TODO

The backlog of plugin work that is agreed but not started. A task moves out of here when it gets its own `.claude/tasks/<ID>/STAGES.md`; its PR removes the line.

## Speed (measured 2026-11-09 over 47 force runs; plan of 2026-11-09)
Item 1, `scripts/hooks-test.mjs` in parallel, is done by VT-8.

2. Cheaper checkers: `ds-parity` and the security review run as general-purpose agents and inherit opus (median 9 min a run). Pin them to sonnet and compare on paid evals before and after (budget to agree, about $5–10).
3. Narrower runtime rechecks: after a fix, `devtools-verify` rechecks only the fixed findings (87 rechecks took 628 min in the 2026-10-28 audit).
4. Close a stage in one script call: journal metrics, archive, gates and commit, instead of dozens of orchestrator calls (the orchestrator alone is 11–22% of a headless run).
5. Parallel tracks inside one task, when a real task needs them: stages in another repo (ui-lib next to core) or in another package of a monorepo, with a maker lock per repo instead of per task.

## CPU load across parallel sessions (asked 2026-11-09)
Several stage-pipeline sessions run at once in different repos, and the machine can stop responding. Wanted:
- a priority per task, with more CPU for a higher priority;
- a session that waits (for an answer, a review, a limit) gives its share to the others, and a stopped task frees it;
- heavy checks (tests, builds, dev servers) queue instead of all starting at once.

VT-8 only lowers the priority of its own test workers and sizes them by the load average at start. The rest is a separate task. What VT-8 measured: on a quiet machine (load average 2–5) hooks-test takes 78–81 s; next to other sessions (load 5–12) its workers give way and it takes 123–216 s.

## Evals
- The eval follow-up PR of VT-1: M-1 and S-1 of the hill-climb driver, harder `pro-review` cases, an eval case for the delta mode, the eval cases of 0.20.0–0.22.0, the first paid climb. Paid; needs a budget.

## Next-version minors
- `journal-gate.mjs` output over 64 KiB is cut on macOS (a pipe), so a huge reason becomes invalid JSON.
- The task-dir check is duplicated in `maker.mjs` and `resume-point.mjs`.
- No fixture for a failed `git diff --numstat` in `changedLinesSince`.
- Two nits in `receipts.mjs` from the VT-7 delta review: one `deltaWhy` append written twice, the rewrite remedy without `${redo}`.
- stage-force `SKILL.md` is at 30,647 of 30,720 bytes: the next addition needs prose moved to `references/` first.
- The `5f: openBlockers` timing check (< 250 ms) failed once in CI at 257 ms.
- hooks-test, from the VT-8 reviews:
  - `--self-test` has no fake unit that exits with a code other than 0 or 1, so nothing pins that such an exit counts as a crash;
  - `--units ,` runs nothing and exits 0;
  - in `vt3s7a`, `statSync` is not imported, so `size()` returns 0 and the size-cap half of the rotation check passes on any file (the same on `abb6d18`);
  - a crash of `vt1s5b` before its cleanup leaves its fake `claude` and MCP processes holding the worker's stderr, and the run waits about 2 minutes for them;
  - the second-scale hang guards run in the pool; the 4-vCPU CI runner gets 2 workers, so watch the first CI runs after VT-8;
  - the S-4 walk over a 600 MB archive is held to < 1 s and takes 0.6–0.8 s at the normal priority under load 8: a slow machine is close to the line.
