# Calls that wait for confirmation

Read from `/stage-force`, Step 2.

A permission request is the same stop, only an unnoticeable one: a call under `ask` (`pkill`, `git push`, `reset --hard`, `git clean`, the write forms of `gh`) waits until the user returns to the terminal. That is how in one run two `pkill` calls in subagents stood for 22 and 37 minutes. In force the plugin's `force-guard` hook rejects such calls at once and explains why. It also rejects a push and any `gh`/`glab` call that is not a read even where the settings allow them; reading a PR, its checks and runs (`gh pr view`, `gh pr checks`, `gh run view`, a GET `gh api`) passes. The rules, so that calls are not rejected:

- **A process is killed by whoever started it, and by PID.** This applies to the dev server, an API stub, a static server for `out/`. On start — `<command> > <log> 2>&1 & echo $!`, at the end — `kill <PID>`. Neither `pkill`/`killall`, nor a kill by a port that you did not take: a user's server may live on it.
- **A rejection is not a reason to look for a workaround** — the same action by another command. If a subagent's action from the plan is rejected, for example deleting files by a criterion, the orchestrator runs it once itself in the main session: the user's consent is visible there: the deletions are named one by one in the interview batch (Step 0). A rejection there too is a blocker with a command.
