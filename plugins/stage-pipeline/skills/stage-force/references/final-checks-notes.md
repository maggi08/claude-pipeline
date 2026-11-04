# Notes moved out of SKILL.md

Plain explanations the skill keeps one line of. The rules are in SKILL.md and in `/stage-check`; the two conditions below (the fix-round review, the `ru` state word) repeat them for reading here.

## Why the main context stays the orchestrator

The model cannot call `/compact`: it is a user command, and neither a tool nor a hook can start it. The context between stages is therefore kept not by compaction but by keeping the heavy things out of it: the `stage-implement` subagent reads the code and makes the edits, checker subagents run the checks, `figma-spec` / `proto-spec` produce the spec. Each dies with its own context and returns a summary.

## The fix-round review pass (Step 1, item 5)

The round's diff is reviewed by your own read of it, or by a stage-mode `pro-review` on it when the code is shared, spans several files or fixes a critical (`/stage-check`, Step 3.2).

## The team review skill in the final checks

- No `team_review:` line in the config: no extra report is asked for. A hand-saved `checks/<name>-branch.md` is still read as a checker report and needs its summary and its "Findings outcome".
- The skill's file is `.claude/skills/<skill>/SKILL.md` of the repo; the subagent follows it on the whole branch against `origin/<main_branch>`. Its findings get the same "Findings outcome" ledger as any checker's.
- A re-run of the report is named `checks/<skill>-branch-2.md` or `-branch-fresh.md`; either counts as the report.
- In a `ru` task the state word of the marker (`not run` / `stale`) comes from `${CLAUDE_PLUGIN_ROOT}/references/language.md`.

## The session browser close

`browser-cleanup.mjs --session` closes by PID the browsers this session's DevTools MCP servers launched: the plugin's `--isolated` one, `stage-pipeline-chrome`; it touches nothing of another session. It runs on the call that renames the heading: an Edit or MultiEdit of the heading line, a Write of STAGES.md, or a Bash call that names the task directory. The run digest records its line (`Session browser: closed by PID …`). A close the hook rejects stays this session's: the edit that fixes the journal closes the browser.

`Session browser: left open — …; close: …` means the user switched the close off (`STAGE_PIPELINE_BROWSER_CLEANUP=off`) or the heading was closed outside this session's call.

## The delta loop after the final checks (Step 4)

- Why a delta: the freshness rule makes every fix round end in another whole-branch review. The speed audit of 2026-10-28 (18 force runs) found that the active time after the first whole-branch review is 61% of a median run; the repeated whole-branch opus reviews took 814 minutes against 237 for the first review of each run, and one delta review took 1.3 minutes.
- The rounds: final checks, fix round 1, delta 1 (+ a fresh `task-converge`, + a delta of the team review skill when the config names one). A critical or major in delta 1: fix round 2, delta 2. A critical or major in delta 2 is a blocker; there is no third round. The second delta counts from the same full report, so it sees both rounds.
- The other final checkers (security-review, ds-parity, dead-code, i18n-sweep, deps-audit, devtools-verify) are not rerun: their fixed findings are rechecked by `file:line` in the fix round's diff. A runtime finding is rechecked by the short run of `/stage-check`, Step 3.2, with its `-r<k>` report.
- The bound is the hook's: a delta counts only when the full report's `head:` is an ancestor of HEAD and the change since it is at most 400 lines. A fix round over it gets a full whole-branch review, which becomes the new anchor; later deltas extend that report.
- A delta sees the round's diff and its radius, not the whole branch. What it does not check: whether a finding of the first review that the round did not touch still holds, and a defect that lies in the unchanged code around the round. Those stay with the full review.
- An autonomous run is exactly the mode where an uncovered criterion or a silently widened scope will be caught by no one along the way, hence the mandatory `task-converge`.
- A delta re-run caused only by staleness (a report older than HEAD's tree) is not a new round: the round counts stay as they were.
- Minors of a delta are not fixed in the run; they go to «Not included in the plan» as next-version items.
- A fix of the final checks that touches the pro-review agent or skill reruns the pro-review eval cases within the budget the Force block names (S2-D6 of VT-7).

## Mid-run (Step 2)

- Why no question: a question in the middle of the run stops all of it, together with everything that does not depend on the answer, and costs as long as the user is not looking at the terminal.
- The rollback cost of a decided-yourself line, by example: "rewrite the email template" against "rebuild three screens".

## The run summary (Step 4)

- Why the short view is pasted whole: a summary once reduced everything to "kk/en texts and minor deviations", and under it lay two defects the user found themselves. That is why the choice of what the short view shows belongs to the script.
- After the heading is renamed, the short view you paste says the browser was closed.
- A decided-yourself line in "Awaiting user confirmation" is cheaper than a stop, and it is not lost.
- Why a line carries its rollback cost: by the end of an autonomous run there are a dozen such lines, the user reads them at once and must see which to check first without opening each.
- Why a finding is never "accepted as a compromise": a Request changes accepted that way once led the user to fix a duplicate of the request the next day.
- Why the short view is chosen by the script: the script picks what it shows and every category is in it with a number; a hand-picked summary once lost two defects.
