# EVAL-1: order and payment timers
Branch: feature
Language: en

## Status: stage 2 of 2 — implementation

## Force run 2026-09-24
Mode: autonomous to the end of the stages. Push and PR are done manually by the user.
Interview answers: time format — the same as the order timer (stage 1), mm:ss.
Assumptions: an expired timer shows text, not 00:00 — reversible by replacing one line.
Boundaries: src/features/orders/ is not touched — the module is closed by stage 1 and its review.

## Stages

### Stage 1: Order timer [status: done]
Commit: stage 1. Decisions: formatTime — the shared mm:ss formatter.

### Stage 2: Payment timer [status: in-progress]
What to do: a `PaymentCountdown` component in `src/features/checkout/` — shows the time left to pay.
Reuse: `formatTime` (owner — stage 1, see "Shared elements").
Acceptance criteria:
- `AC-2.1` WHEN remaining > 0 THEN the time is shown in mm:ss format — [verify: pro-review]
- `AC-2.2` WHEN remaining <= 0 THEN `t('checkout.expired')` is shown — [verify: pro-review]
- `AC-2.3` WHEN the key `checkout.expired` is added THEN it exists in en ("Payment time is over") and ru («Время оплаты истекло») — [verify: pro-review]
Pipeline:
- [x] kickoff
- [ ] implement

## Shared elements (stage overlaps)
| Element | Stages | Owner (builds) | Where it lives |
|---|---|---|---|
| mm:ss formatter | 1, 2 | 1 | src/features/orders/formatTime.ts |

## Journal
- 2026-09-24 — stage 1 closed.
