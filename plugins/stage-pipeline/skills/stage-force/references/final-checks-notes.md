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

`browser-cleanup.mjs --session` closes by PID the browsers this session's DevTools MCP servers launched: the plugin's `--isolated` one, `stage-pipeline-chrome`. The run digest records its line (`Session browser: closed by PID …`). A close the hook rejects stays this session's: the edit that fixes the journal closes the browser.

## Mid-run (Step 2)

- Why no question: a question in the middle of the run stops all of it, together with everything that does not depend on the answer, and costs as long as the user is not looking at the terminal.
- The rollback cost of a decided-yourself line, by example: "rewrite the email template" against "rebuild three screens".

## The run summary (Step 4)

- Why the short view is pasted whole: a summary once reduced everything to "kk/en texts and minor deviations", and under it lay two defects the user found themselves. That is why the choice of what the short view shows belongs to the script.
- After the heading is renamed, the short view you paste says the browser was closed.
- A decided-yourself line in "Awaiting user confirmation" is cheaper than a stop, and it is not lost.
