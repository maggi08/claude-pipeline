# Fields of the `metrics:` line

Read from `/stage-check`, Step 4.1. The line is collected by `scripts/retro.mjs` for the retro on real numbers.

`stage` — the stage number; `findings` — how many findings the checkers returned in total; `dropped` — how many were dropped as false at Step 2; `iterations` — fix-loop rounds (0 if there was nothing to fix); `fresh` — whether a fresh checker run was needed (Step 3.3); `floor` — `floor-guard` violations on the first run (in force — from the `stage-implement` summary, its first run); `diff` — `+added/-removed` from the first line of `floor-guard` (the size buckets in the retro go by the added ones). Values are numbers and checker names, with no explanations.
