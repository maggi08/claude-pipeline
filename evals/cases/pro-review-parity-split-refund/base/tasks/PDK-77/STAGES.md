# PDK-77: split the refund module
Branch: feature
Language: en

## Status: stage 1 of 1 - implementation

## Stages

### Stage 1: Refund module  [status: in-progress]
What to do: `billing/refund.ts` grew into one long function; split it into `refunds/amounts.ts` (money helpers) and `refunds/createRefund.ts` (the use case) and point the route at the new function.
Acceptance criteria:
- `AC-1.1` WHEN the support agent submits a refund for a payment THEN the payment is refunded for that amount through the gateway - [verify: pro-review]
- `AC-1.2` WHEN the amount has more than two decimals THEN it is rounded to whole cents before it is sent - [verify: pro-review]
Pipeline:
- [x] kickoff
- [ ] implement
- [ ] pro-review

## Journal
