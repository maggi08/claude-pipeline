# Precedents of the /stage-plan rules

Where each rule came from. The file is not needed to run the skill — the rules in `SKILL.md` are self-contained; it is needed when you want to relax or rewrite a rule.

## Step 2. Grouping into stages

terminal states (`error`/`offline`) were separate screen-ids in the registry, but they were implemented as an overlay inside the start screen; at user-review came the directive "the start screen must stay itself, the error is a separate screen", and the whole stage 2 was redone — three passed checkers were voided.

## Step 2.1. Stage overlap scan

manual PR review brought 10 remarks, 6 of them duplicates spread across stages (reference data, legal links, `formatTime`, a step wrapper in 4 copies, the order of steps in 3 places, a provider on top of an existing hook). Every stage closed with a green pro-review — inside itself all six were clean, and the cheapest place to see them was here, before the first line of code.
