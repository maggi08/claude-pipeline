# LOY-27: loyalty points at checkout
Branch: feature/loyalty-points
Language: en

## Status: stage 1 of 1 - closed

## Stages

### Stage 1: Earn and redeem points  [status: done]
What to do: points earned per order by tier, redeeming points at checkout, the points label.
Acceptance criteria:
- `AC-1.1` WHEN an order is paid THEN the customer earns points by the tier rate per whole 100 cents - [verify: pro-review]
- `AC-1.2` WHEN the customer redeems points THEN the balance drops by the redeemed amount and never goes below zero - [verify: pro-review]
- `AC-1.3` WHEN the customer presses "use all my points" THEN the whole balance is redeemed and the balance becomes 0 - [verify: pro-review]
Pipeline:
- [x] kickoff
- [x] implement
- [x] pro-review

## Journal
