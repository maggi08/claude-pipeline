# PAY-9: prices in the orders list
Branch: feature
Language: en

## Status: stage 1 of 1 - fix round 1

## Stages

### Stage 1: Orders list prices  [status: in-progress]
What to do: the orders page lists each order with its price formatted by the shared money helper.
Acceptance criteria:
- `AC-1.1` WHEN an order is listed THEN its price goes through `formatMoney` - [verify: pro-review]
- `AC-1.2` WHEN an order of 1850 cents is listed THEN the page shows `18.50 USD` - [verify: devtools-verify]
Pipeline:
- [x] kickoff
- [x] implement
- [x] pro-review (0 major)
- [ ] devtools-verify (round 1: 1 major, the fix is in the working tree, recheck pending)

## Journal
