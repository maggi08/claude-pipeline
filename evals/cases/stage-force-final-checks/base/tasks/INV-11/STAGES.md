# INV-11: paginated order list
Branch: feature
Language: en

## Status: stage 2 of 2 done, final checks next

## Force run 2026-10-26
Mode: autonomous until the end of the stages. Push and PR — manually by the user.
Interview answers:
- (1) Newest orders first on every page — affects `AC-1.1`.
Assumptions:
- 20 orders per page, as in the console's list view — Rollback: cheap, one constant — Basis: the console list view, guess
Unresolved: —
Boundaries: only `src/` and `test/`; no changes to the console views.
Confirmed: 2026-10-26 — interview answers
Blockers:

## Stages

### Stage 1: Page slicing  [status: done]  logic-only
Figma nodes: —
What to do: `listOrdersPage(orders, page)` in `src/orders.js`: one page of orders, newest first.
Acceptance criteria:
- `AC-1.1` ✅ pro-review: WHEN page 1 is requested for 45 orders THEN the newest PAGE_SIZE orders come back - [verify: pro-review]
- `AC-1.2` ✅ pro-review: WHEN a page past the end is requested THEN an empty list comes back - [verify: pro-review]
Pipeline:
- [x] kickoff
- [x] implement
- [x] pro-review
Commit: feat(INV-11): stage 1
Decisions: PAGE_SIZE is 20.
metrics: stage=1 checkers=pro-review skipped=figma-compare,devtools-verify findings=0 dropped=0 iterations=0 fresh=no escalations=0 floor=0 diff=+14/-0

### Stage 2: Page count  [status: done]  logic-only
Figma nodes: —
What to do: `pageCount(total)` next to it, on the same constant.
Acceptance criteria:
- `AC-2.1` ✅ pro-review: WHEN there are 45 orders THEN `pageCount` returns the number of pages that holds them all - [verify: pro-review]
Pipeline:
- [x] kickoff
- [x] implement
- [x] pro-review
Commit: feat(INV-11): stage 2
metrics: stage=2 checkers=pro-review skipped=figma-compare,devtools-verify findings=0 dropped=0 iterations=0 fresh=no escalations=0 floor=0 diff=+10/-0

## Final checks (after all stages)
- [ ] full-checks: `test` from the config, in full, once, on HEAD
- [ ] floor-guard: `node ${CLAUDE_PLUGIN_ROOT}/scripts/floor-guard.mjs --base main`
- [ ] pro-review whole-branch (the `pro-review` agent in whole-branch mode, from the merge-base with `main`)
- [ ] dead-code
- [ ] task-converge
- [ ] confirmations: the "Awaiting user confirmation" block is empty

## ⚠ Awaiting user confirmation
- 20 orders per page — visible in `listOrdersPage` — Rollback: cheap, one constant — Basis: guess

## Journal
- 2026-10-26 stage 1 closed, pro-review Approve.
- 2026-10-26 stage 2 closed, pro-review Approve.
