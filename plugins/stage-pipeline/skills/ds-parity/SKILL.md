---
name: ds-parity
description: Проход по дизайн-системе перед PR — какие локальные компоненты заменяются существующими в UI-ките и какие логически просятся В кит. Use before opening a PR (вместе с /cleanup-review и /code-review), или когда пользователь просит проверить дубли с дизайн-системой. Ловит класс правок, который иначе всплывает на ручном ревью повторными запросами.
---

# DS Parity — duplicates between the app and the design system

The goal: remove two classes of duplication from the PR — (a) hand-rolled UI where the kit already has a component; (b) local components that are shared by meaning and should live in the kit, so that other apps do not rewrite them.

Motivation (a real measurement on a redesign task): on a redesign about ~90% of a developer's time goes not on writing but on review and repeated fix requests — a flow is written in an hour, then 4 hours of checks and refactoring, and the lion's share of the fixes is exactly about duplicates with the UI kit. This pass is cheaper than catching them by eye round after round.

> **Project config.** Take the kit repo, the component prefix and the code layout from `<repo>/.claude/pipeline.config.md` (`ui_lib`, `components`, `page_components`; no file — `/pipeline-init`).

## Required precondition: kit freshness

The conclusion "the kit has no such thing" without fresh refs is unreliable. Before the search:
- `git -C <ui-repo> fetch --all --prune`;
- search not only the exact name but synonyms (`Language*`, `Locale*`, `*Switcher`, `Country*`, brand prefixes);
- compare the version of the installed package with the version on the kit's development branch: **a component can be on the branch and not in npm** (precedent: on the kit's development branch beta.60, in the registry — beta.53).
Verified twice: both times "there is no component" turned out to be the result of week-old refs.

## Procedure

Run with **parallel subagents** (Explore), not inline: three independent passes are cheaper in context and do not contaminate each other with conclusions.

1. **Parity over the PR diff** — only the changed files. What is hand-rolled in this PR and what replaces it.
2. **Parity over the tree** — a breadth sweep of the whole app by functional categories (modals/sheets, dropdowns, selects, tabs, loaders/skeletons, progress, badges/statuses, cards, tooltips, tables, inputs/OTP/dates, empty state, toasts, copy to clipboard, flags/languages).
3. **Promotion candidates** — local components with no domain imports (no reading of reservation/guest contexts, no react-query, no feature i18n keys) that make sense for other apps.

Into every agent's prompt: the path to the kit repo + how to read its sources (`git show <ref>:<path>`), the path to the installed types (`node_modules/<ui-lib>/dist/index.d.ts`), the search scope, and the requirement to **read the real prop signatures, not guess by name**.

## Output rules (otherwise the report is useless)

- **Match by function, not by name.** "Our `Sheet` ↔ the kit's `ResponsiveSheet`" is a finding; "our `Card` ↔ the kit's `Card`" without checking the props is guessing.
- **Name what the hand-rolled version loses**, concretely: focus management, keyboard, portal (a popover without a portal is cut by any `overflow:hidden` ancestor), ARIA links, tokens/theming, a dark variant. That turns a finding from taste into a defect.
- **A local wrapper over a kit component is NOT a duplicate.** Do not flag it. A duplicate is your own implementation of the same mechanics.
- **The migration cost** for every finding: drop-in / props needed / a change in the kit needed.
- **Promotion only with a concrete signature** of the future DS component and a list of what has to be de-parameterized (contexts, i18n keys, stores).
- **A negative result is a result too**: list the categories where there are no duplicates and the components that deliberately stay local (feature ones). Without this the rest of the report is not believed.
- Rank by "gain × low risk", not alphabetically. More call-sites — a stronger argument.

## Output

A compact table into the chat (and into `<task_dir>/<TICKET>/checks/ds-parity-branch.md` before the PR or `ds-parity-<stage>.md` on a stage, if there is a task dir; a repeat run — with the suffix `-2`, `-3`). Above the table — the line `Findings: critical N · major N · minor N` per the common contract (`${CLAUDE_PLUGIN_ROOT}/references/checker-report.md`):
- major — a home-made copy of a kit component when a drop-in is ready, and an override of a kit component's style (weight, caps, size, radius) without a decision in STAGES.md;
- minor — "belongs in the kit".

In one task three such findings went into "to the kit" and "a design decision", and all three came back as the user's fixes.

```markdown
| # | Ours | DS analogue | What we lose | Migration | Confidence |
|---|------|-----------|------------|----------|-------------|
```
Plus the section "Candidates for the kit" (ours → the proposed DS signature → what to de-parameterize → call-sites), the section "Deliberately local" and the section "Could not verify" (nothing left — "everything verified"; the report is written in the task language, the markers for `ru` come from `${CLAUDE_PLUGIN_ROOT}/references/language.md`).

Then — as usual: the confirmed findings are fixed by the orchestrator, the disputed ones and those that need changes in the kit go to the tracker of questions to the DS (for example, `DESIGN-QUESTIONS.md`).
