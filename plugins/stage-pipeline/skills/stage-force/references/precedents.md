# Stage Force — precedents and measurements

Incidents and rationale that justify rules of `SKILL.md`, moved here to keep it within its size budget; the rules themselves stay in `SKILL.md`.

## Intro (the opening paragraph)

On a long task that is dozens of waiting windows, and they make up most of the idle time.

## Step 0. Interview — the only place questions are collected

The batch is the only collection point for the whole run, and a missed category costs not one stage but the whole run: there will be nowhere to ask before the end of the task.

In force mode the user answers once for the whole task: a question without a recommendation shifts onto them work you can do by reading the code and the source.

## Step 2. Mid-run — no questions

A question in the middle of the run stops all of it, together with everything that does not depend on the answer, and costs as long as the user is not looking at the terminal.

The cost is needed not for reporting but for the order of review: by the end of an autonomous run there are a dozen such lines, the user reads them at once and must see which to check first without opening each.

## Output — the run summary

A precedent: a summary reduced everything to "kk/en texts and minor deviations", and under it lay two defects the user found themselves; that is why the choice belongs to the script.

Otherwise they go into the PR without a single checker: that is how seven commits after the run were merged in four minutes in one task.

## Step 0. Auth probe

(proven at VT-1 kickoff) — said of checker subagents driving the orchestrator's MCP browser.
