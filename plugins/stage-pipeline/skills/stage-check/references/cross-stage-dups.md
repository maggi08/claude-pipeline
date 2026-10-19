# Duplicates between stages — the inventory for pro-review

Read from `/stage-check`, Step 1, starting from the second stage.

**Duplicates between stages are a structural blind spot, and it has to be closed explicitly.** pro-review in `--stage` mode sees ONLY the diff of the current stage, so a third copy of the same block is indistinguishable for it from the first: every stage was written separately and looks clean inside itself. A duplicate is visible only in the sum — and a human sees it first, at the manual PR review, when fixing is the most expensive.
The first source of the inventory is the "Shared elements" table from STAGES.md (built by /stage-plan, Step 2.1): it already records which stage owns a shared element and which stages must consume it. A row of this table whose owner is not the current stage is a direct ban on writing this again.
Plus, starting from the SECOND stage, add to the pro-review prompt the inventory of what the previous stages actually added — a list of paths and exported names (the table catches what was planned, the inventory — what appeared along the way):
```
git diff --name-status <task-base>..<prev-stage-commit> | grep '^A'
grep -rhoE 'export (const|function|type) [A-Za-z]+' <new files of previous stages>
```
and one line in the prompt: "check what is added in this stage against this list — a duplicate or near-duplicate = major". The list is short (names, not contents), it does not bloat the context. The same goes for `ds-parity`: run it from stage 2, not only before the PR.
