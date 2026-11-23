<!-- product-handoff 1 -->
# Product handoff — the input `/stage-plan` reads from a product team

A product handoff is one file per task, `<task_dir>/<TICKET>/PRODUCT-HANDOFF.md`, written by whoever owns the product side (the `product-pipeline` plugin writes it by this spec; a person can write it by hand). `/stage-plan` reads it when it is there and works as before when it is not. The file is a plain document: nothing in it needs a second plugin.

The file starts with the marker line `<!-- product-handoff 1 -->` (this file's first line is the same marker, as the spec of version 1). `plan-check.mjs` reads the number: a file whose marker is missing or says another version is reported as "unknown handoff version" — a format it does not know is not guessed.

The skeleton is English whatever the language of the prose: the heading, the field names, the section headings, `WHEN` / `THEN`. Only the prose under them is in the task's language. The names below are short and stable — the writer's template copies them.

## No ids of the product side

A handoff is read by people and tools that do not have the product repo. It carries no epic ids (`F<n>`, `Q<n>`, `D<n>`, `T<n>`, `P<n>`), no section references (`§<n>`, "brief §9") and no path into the product repo's working files (the `From` line below is the one exception: it names the product repo and the epic folder as provenance, read by people, never by a tool). A decision is written out as words; another ticket is named by its Jira key or its summary. The only ids are the handoff's own `H<n>`.

## Header

```markdown
<!-- product-handoff 1 -->
# <KEY>: <summary>

Type: <[FE <app>] | [BE] | [FE <app>] + [BE]>
App/Repo: <the repo the task is done in>
From: <product repo> · <epic folder>
Design source: <Figma URL, prototype path, or "none">
Contract: <for [BE]: "stage 1 is the contract"; for [FE]: the contract path or key it follows, or "none">
```

| Field | Meaning | What `/stage-plan` does with it |
|---|---|---|
| `# <KEY>: <summary>` | the Jira key and the ticket summary | the key is the ticket (`<TICKET>`, the folder name); the summary is the task name in the STAGES.md heading |
| `Type` | where the work lands: `[FE <app>]`, `[BE]`, or both | `[BE]` makes stage 1 the contract (Step 2.2, backend task); a task with both gets backend stages before the frontend ones |
| `App/Repo` | the repo of the work | the repo whose `pipeline.config.md` applies; a mismatch with the current repo is a question to the user, not a silent switch |
| `From` | the product repo and the epic path the task came from | kept as a line in the STAGES.md journal of stage 1 (where to ask); never copied into criteria |
| `Design source` | a Figma URL, a prototype path, or `none` | the design source of Step 1 (a URL is passed as `--figma`); `none` and no `design_source` in the config means a logic-only plan |
| `Contract` | for `[BE]`: "stage 1 is the contract"; for `[FE]`: the contract it follows | the "Contract coverage" table and the MSW mocks of the frontend stages come from it |

## Sections

### `## Criteria`

One line per criterion, `H<n>` numbered from 1 in the file, never reused; a cancelled one is marked `[cancelled: reason]` and stays.

```markdown
## Criteria
- `H1` WHEN <condition> THEN <observable result>
- `H2` WHEN <condition> THEN <observable result>
```

Each line is a behavior a user or a client of the API can observe, in the WHEN/THEN form, with no implementation words. `/stage-plan` turns every `H<n>` into one or more `AC-*` of a stage (one `H` may become several: a screen, its empty state and its error; several `H` may share one `AC` when they are one behavior) and lists the mapping in the "Product handoff coverage" table of STAGES.md, a row per `H<n>`: `| H1 | 2 / AC-2.1, AC-2.2 |`. A criterion the plan does not cover says so: `not in plan — <reason>`. `plan-check.mjs` reports an `H<n>` with no row, or a row whose stage is not a stage of the plan.

### `## Decisions`

Decisions, written out in words, one line each:

```markdown
## Decisions
- <question> — <decision or recommendation> — <who decides> — <open | decided <date>>
```

No `D<n>`, no `Q<n>`. The state is `open` while nobody has decided and `decided <date>` after. A decision that waits for data (the product side's "pending data") is written `open`, with what it waits for in words: `open — waits for data: <what>`. Where each state goes in STAGES.md is in "Routing" below.

### `## Out of scope`

What the task leaves alone, one line each. `/stage-plan` copies the lines into "Not included in the plan", so nothing the product side excluded is planned by accident.

### `## Open questions`

What nobody has answered yet and the task may need: the question, who can answer, what it blocks.

## Routing: where the handoff's lines go in STAGES.md

This is the one place that says it; `/stage-plan` follows it.

| Handoff line | Goes to |
|---|---|
| `decided <date>` decision | the `Decisions:` line of the stage it shapes, one line, with `PRODUCT-HANDOFF.md` as the source |
| `open` decision the task depends on | "⚠ Awaiting user confirmation", a line each; and `DESIGN-QUESTIONS.md` too when the answer is a design one |
| criteria an open decision touches | tagged `[blocked: product decision — <short>]` (not `[Gap]`: plan-check reads a `[Gap]` without a closing mark as an open fork) |
| open question that blocks a stage | "⚠ Awaiting user confirmation" (and `DESIGN-QUESTIONS.md` for a design one) |
| open question that blocks nothing yet | the journal of the first stage that can meet it, not Awaiting (the block must be able to end empty) |
| Out of scope line | "Not included in the plan", line by line |
| `From` | one line in the journal of stage 1 |

## What `/stage-plan` does not do with the file

- It does not rewrite or "fix" the handoff: a wrong or unclear line is a question to the user, and the file changes on the product side.
- It does not treat the handoff as a design: screens, states and pixel values come from the design source; the handoff says what must be true, not how it looks.
- It does not reread a handoff by itself: `/stage-kickoff` (and the kickoff of a `/stage-force` stage) runs a full `plan-check <STAGES.md>` at every stage opening while the ticket folder holds `PRODUCT-HANDOFF.md`, so a handoff given again is seen (stage mode drops plan-level findings); a new `H<n>` is a missing row of "Product handoff coverage": a stage, or `not in plan — <reason>`.
- It does not require the file: without it `/stage-plan` takes its input from the ticket, the design and the contract, as before. With none of the four (ticket key, design source, contract, handoff) `plan-check.mjs --input` exits 1 and `/stage-plan` asks the user once: plan a task stated in chat, or go to the product side; only the product route stops.
