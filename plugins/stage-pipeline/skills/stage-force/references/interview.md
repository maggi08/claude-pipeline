# Interview probe pass

Read from `/stage-force`, Step 0. Facts first, questions second: of 24 force runs, 16 closed with blockers, and most of those blockers were a premise nobody looked at before the batch (a backend field that is not on dev, a kit component at another path, a Figma node that was moved, a login that was gone, a stand that is read-only).

## 1. The probe (once, before the batch)

Launch ONE read-only subagent (the general-purpose agent; no edits, no commits, no state changes on any stand). The prompt carries the list of premises from the plan, one per line. Take them from `plan-check` output, the criteria and the "Reuse" lines:

- a backend field or endpoint the criteria rely on — one GET on dev;
- a kit component or a path named in "Reuse" — does the file exist at that path;
- a Figma node of the plan — `get_metadata` answers, the node is there;
- the login — the result of the auth probe of Step 0 (the auth probe runs first; the probe pass runs after it and takes its result, it does not repeat it);
- write access on the stand, when a criterion needs a record — only read what can show it (a role, a flag), never write.

The probe returns, per premise, `Checked before start: <fact> — <evidence>` (evidence = a path:line, a status code, a node-id) or an entry for `Not proven:` with the reason it could not be observed. At most one probe per run; a premise that appears after the batch is an assumption or a blocker, not a second probe.

The orchestrator copies the lines into the Force block (`Checked before start:`, `Not proven:`).

## 2. Blocker forecast

Written into the Force block as `Blocker forecast:`. For each stage, one line: what from `Not proven:` or from the Environment and access category would make it end in a blocker, and the stage's fallback. A stage whose forecast is "blocker" and that nobody can unblock goes into the batch as a question, or is marked `[blocked: B<n>]` before the run starts.

## 3. Every question carries its fallback

Each question of the batch ends with: `if you don't answer: <X>, because <Y>`. X is the assumption that will be written into the block (with `Rollback:` and `Basis:`), Y is the reason it is the cheapest reversible option. The user who skips the question knows what they get.

## 4. What the orchestrator writes

- `Stage dependencies:` — which stage waits for which (a shared component, a backend field, a decision), or `none`. A hook (`plan-check`, at the `stage-implement` spawn) denies a new Force block without it.
- `Taxonomy:` — all 12 categories of Step 0, each with its status. Without all 12 the same hook denies.
- Nothing is asked after `Confirmed:`.
