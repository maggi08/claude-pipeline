# devtools-verify — stage 1
Findings: critical 0 · major 1 · minor 0
doctor: ok — http://127.0.0.1 answers 200, marker «Portal» found
auth: not needed — no auth-gated criteria
map: orders · entries 1/1 · drift 0

| # | AC | Element | Problem | Expected | Actual | Severity | Where |
|---|---|---|---|---|---|---|---|
| 1 | AC-1.2 | price of order A-1 on /orders | the price has no cents | `18.50 USD` | `19 USD` | major | lib/money.ts:2 |

geometry 1440: overflow 0 · zero-gap 0 · clipped 0

## Stage criteria
- `AC-1.2` — FAIL, `19 USD` instead of `18.50 USD` on /orders (screenshot checks/screens/orders.png)

## Could not verify
- none

## Findings outcome
- #1 AC-1.2 — open
