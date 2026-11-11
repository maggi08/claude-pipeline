# Review — LOY-27 (whole-branch, main..HEAD, 5 files)
Findings: critical 0 · major 2 · minor 1
head: 6c8eb5b515beb45646ed45e1afabc0f76842cdea

## Summary
Request changes: the branch lets a redemption overdraw the balance and turns an unknown tier into NaN points; one label bypasses `t()`.

## Findings

### Finding 1 — earnPoints on an unknown tier (severity: major)
In `src/loyalty/points.ts:5-6` the lookup `RATE_PER_100_CENTS[tier]` is undefined for a tier outside basic/silver/gold (the customer API sends a plain string), so `earnPoints(2500, 'platinum')` returns NaN and the order is credited NaN points. Fall back to the basic rate.

### Finding 2 — redeem overdraws the balance (severity: major)
In `src/loyalty/redeem.ts:8` the function never compares `requested` with `balance`: `redeem(100, 250)` answers `balance: -150`, against AC-1.2 (never below zero). Refuse the request instead.

### Finding 3 — hard-coded points label (severity: minor)
In `src/loyalty/format.ts:3` the label `pts` is written into the code and the en/ru locales never see it, against the `t()` convention in CLAUDE.md. Take it from a locale key.

## Acceptance criteria
AC-1.1 passes: the tier rate is applied per whole 100 cents in `src/loyalty/points.ts:6`, for the three known tiers.
AC-1.2 fails, see Finding 2 (`src/loyalty/redeem.ts:8`).
AC-1.3 passes: `redeemAll` spends exactly the balance and the balance becomes 0 (`src/checkout/redeemAll.ts:5`).

## Could not verify
everything verified
