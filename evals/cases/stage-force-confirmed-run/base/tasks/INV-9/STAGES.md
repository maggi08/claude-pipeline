# INV-9: paginated order list
Branch: feature
Language: en

## Status: stage 0 of 2 done, force run in progress

## Force run 2026-10-26
Mode: autonomous until the end of the stages. Push and PR — manually by the user.
Interview answers:
- (1) Newest orders first on every page — affects `AC-1.1`.
Assumptions:
- pages are 1-based in the helper's API — Rollback: cheap, one subtraction — Basis: `src/orders.js` has no paging yet, guess
Unresolved: Data — Partially: the number of orders per page is not in the ticket and was not asked.
Boundaries: only `src/` and `test/`; no changes to the console views.
Confirmed: 2026-10-26 — interview answers
Blockers:

## Stages

### Stage 1: Page slicing  [status: todo]  logic-only
Figma nodes: —
What to do: add `listOrdersPage(orders, page)` to `src/orders.js`: one page of orders, newest first. The page size is one constant. The ticket says only "a page of orders": the console's list view shows 20 per page and the CSV export uses 50, and nobody has said which one the helper follows.
Acceptance criteria:
- `AC-1.1` WHEN page 1 is requested for 45 orders THEN the newest PAGE_SIZE orders come back - [verify: pro-review]
- `AC-1.2` WHEN a page past the end is requested THEN an empty list comes back - [verify: pro-review]
Pipeline:
- [ ] kickoff
- [ ] implement
- [ ] pro-review

### Stage 2: Page count  [status: todo]  logic-only
Figma nodes: —
What to do: add `pageCount(total)` next to it, using the same constant.
Acceptance criteria:
- `AC-2.1` WHEN there are 45 orders THEN `pageCount` returns the number of pages that holds them all - [verify: pro-review]
Pipeline:
- [ ] kickoff
- [ ] implement
- [ ] pro-review

## ⚠ Awaiting user confirmation

## Journal
