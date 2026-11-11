# SHP-6: express surcharge in the quote
Branch: feature
Language: en

## Status: stage 0 of 2 done

## Stages

### Stage 1: Express surcharge  [status: todo]  logic-only
Figma nodes: —
What to do: add `expressQuoteCents(weightKg)` to `src/quote.js`: the base rate plus a 25% express surcharge, rounded up to a whole cent, for the `EU` zone.
Reuse: `src/lib/money.js` exports `formatCents(cents)` and `ceilCents(value)` (round up to a whole cent); `src/rates/zones.json` holds the zone table, and the stage reads the `EU` zone multiplier from it; `src/lib/weights.js` exports `roundWeightKg(weightKg)`.
Acceptance criteria:
- `AC-1.1` WHEN `expressQuoteCents(2)` is called THEN it returns the base rate for 2 kg plus 25%, rounded up - [verify: pro-review]
- `AC-1.2` WHEN the quote label is built THEN it shows the price through `formatCents` - [verify: pro-review]
Pipeline:
- [ ] kickoff
- [ ] implement
- [ ] pro-review

### Stage 2: Surcharge in the label  [status: todo]  logic-only
Figma nodes: —
What to do: `quoteLabel(weightKg, express)` returns "Express: <price>" or "Standard: <price>".
Acceptance criteria:
- `AC-2.1` WHEN `quoteLabel(2, true)` is called THEN the text starts with "Express:" - [verify: pro-review]
Pipeline:
- [ ] kickoff
- [ ] implement
- [ ] pro-review

## ⚠ Awaiting user confirmation

## Journal
