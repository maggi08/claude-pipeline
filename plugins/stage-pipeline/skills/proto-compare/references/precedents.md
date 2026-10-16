# Precedents of the proto-compare rules

Where each rule came from. The file is not needed to run the skill — the rules in `SKILL.md` are self-sufficient; it is needed when you want to weaken or rewrite a rule.

## Comparison order

A promo block was duplicated in the side panel and in the form card; Terms/Privacy stood on all 4 states of the sign-in screen against 2 in the prototype. Both findings came from the user after the checker's PASS — the comparison went one state at a time.

## Checklist

The README promised a surface variant that did not exist in the CSS (caught by proto-spec at stage 1 — an example); SPEC §20 "glass card" turned out older than the CSS, which had cut the glass; the CSS described itself more accurately than any document.

## Severity

proto-compare issued a FAIL with 3 criticals, two of which the orchestrator refuted — "pill 50px" (in fact `--button-radius:10px`, the variable is overridden further down) and "blue outline" (the rule is overridden further down in the same file). The same unresolved cascade, but in the opposite direction, in another task caused a whole theme to be missed.
