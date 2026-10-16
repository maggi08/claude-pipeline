---
name: dead-code
description: Узкий проход по мёртвому коду, который образовался ИЗ-ЗА этой задачи — осиротевшие компоненты, хуки, утилиты, ассеты, ключи локалей, экспорты. Use as a checker step of /stage-check (со второго этапа) или перед PR. Не ищет баги — для этого /pro-review; не ищет дубли с китом — для этого /ds-parity.
---

# Dead code — what became orphaned because of this task

The goal is narrow: find code that **stopped being used as a result of these changes**. Pre-existing junk is not our target: deleting it bloats the diff and hides the point of the task.

> **Project config.** Take `main_branch`, the code layout, `ui_lib` and `i18n` from `<repo>/.claude/pipeline.config.md`; the conventions from `CLAUDE.md`.

## Scope

| Run | Scope |
|---|---|
| from `/stage-check` | the diff of the stage (uncommitted+staged or `git diff <prev-stage-commit>...HEAD`) |
| before the PR | the whole branch: `git diff $(git merge-base <main_branch> HEAD)...HEAD` |

Look first at the **removed and replaced** places of the diff: they are what leaves orphans. A file that the task only added cannot become an orphan.

## First — the deterministic run

The config declares `unused_code` in the "Static analysis" section — start with it, not with grep: a parser sees re-exports, types and barrels more precisely than a text search and costs less.

The output of such a tool is over the **whole repository**, while our scope is only the orphans of this diff. Reconcile the two:

- Intersect the tool's list with the files and symbols touched by the diff. Everything else is pre-existing debt, outside the scope; mention it in one line at the end of the report and do not drag it into the findings.
- The run is fast (under a minute) — more precise to do it this way: run on the comparison base and on HEAD, take the difference of the lists. Appeared after the diff = became orphaned because of it.

The output of the tool is **candidates, not findings**: it does not cancel the confirmation procedure below. Dynamic keys, `url(...)` in CSS, route tables and concatenated translation keys are invisible to a parser, and it regularly declares live code dead. The tool is not declared or does not run — work by grep with the checklist below, that is still a working path.

## What to look for

1. **Symbols that lost their last call-site.** A component/hook/utility/type whose only use the task removed or rewrote.
2. **Whole orphaned files** — a module nobody imports from any more.
3. **Unreachable code inside changed functions.** A high-yield case: a `return`/`throw` added in the middle leaves the tail dead. Trace the branching, do not read it by eye.
4. **Locale keys** left over from a removed copy (the `i18n` paths from the config).
5. **Assets** — images, icons, fonts that no longer have references.
6. **Exports from barrel files** that lead nowhere.

## Confirmation — the main part of the work

"Delete it, it is not used" on live code is the worst finding a checker can make. Before you put an item into the report, go through all the checks:

- Grep the name over the whole repository, **including barrel files that re-export it under another name**.
- Look for references assembled at runtime: access by a string key, dynamic import paths, concatenated translation keys, route and config tables where the symbol lies as data.
- In a monorepo search in **all** apps and packages, not only in the one the task goes in.
- Reachable ≠ mentioned: code can be imported and still be dead if an earlier branch always wins. And the other way round.
- An asset can be hooked up from CSS (`url(...)`), from a manifest or by a computed path — grep not only the code.
- A symbol can be the public API of a package. If a file is exported outward from `package.json`/barrel of the root — it is not dead code but a contract.

Not confirmed in a reasonable time — the item goes not into "to remove" but into "in question", saying what exactly stayed unchecked.

## Report

Save to `<task_dir>/<TICKET>/checks/dead-code-<stage>.md` and return compactly. The report follows the common contract `${CLAUDE_PLUGIN_ROOT}/references/checker-report.md`, written in the task language: the title, the second line with the summary (one line: the severity counters and the counter "N to remove / N in question" — journal-check reads "N to remove" as major), the table, then the sections:

```markdown
# Dead code: <stage or branch>
Findings: critical 0 · major N · minor N — N to remove / N in question

| # | What | Where | Why it became orphaned | How checked | Confidence |
|---|------|-------|------------------------|-------------|------------|
```

`How checked` — concretely: "knip + grep over the monorepo, 0 references; not in the barrel; no dynamic keys found" (the tool is named if there was one). Without this column the finding cannot be believed.

As separate sections:
- **In question** — what could not be confirmed and what was missing.
- **Deliberately kept** — what looks dead but is alive (public API, a legacy branch, used dynamically). Without this section the rest of the report is not believed.
- **Could not verify** — what the pass could not reach; nothing left — "everything verified".

If nothing became orphaned — say so, listing what you looked at. An empty report is better than an invented one.
