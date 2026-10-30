# Precedents of the /pro-review rules

Where each rule came from. The file is not needed to run the skill — the rules in `SKILL.md` are self-sufficient; it is needed when you want to weaken or rewrite a rule.

## The remote branch, not the local one: a lagging local dev pulls other people's merged commits into the diff.

A rebase conflict resolution threw away variable declarations, and a broken component lived through the rewritten commits until the final review — the tests did not import it, and the working tree contained the fix.

## The remote branch, not the local one: a lagging local dev pulls other people's merged commits into the diff.

The branch pinned a beta version of the UI kit while `node_modules` was a symlink to a local checkout — through the whole pipeline (6 stages, three checkers on each, a cleanup-review before the PR) went 2 `type_check` errors on a clean clone and a selection indicator that vanished on one screen.

## B. Senior best practices (universal)

The shared info block of a step was rewritten from styled-components to Tailwind in the redesign tree; FIVE legacy screens imported it through the shared path, including one outside the scope of the task — on the classic design the headings became 21px instead of 24/28px and lost their centering and bottom margin. It went through the whole pipeline and was caught only by the final whole-branch review.

## Dedup repo-wide, open the reused helper (lenses, Step 2/3)

A locale-less `formatDate` called from a new place was seen three times in reviews and closed «false» because «the helper existed before the task»; the team lead raised it as major. Two more majors (history time in UTC, English months under a regional locale) came from helpers the diff called but did not change.

## Maintainability lane and the contract scenario (Step 4)

A finding about a nullable field was dropped because «no live ad reproduces it»; the null case gave a 500. Scenario from the type counts.

## Deleted-code parity and the yardstick (lenses)

A removal asked for by an AC, or disclosed in the awaiting list, was raised again by the team lead in 13 of 36 deleted-behaviour rows: the AC is the author's yardstick, not proof. A report accepted «"Send guest data" opens the send modal» as done; the reviewer's later round found the old flow gone.

## Copied code is new code (Step 4)

15 findings sat in code ported 1:1 from a reference branch and dismissed as «untouched».

## The report names the search (lenses, Evidence per aspect)

25 aspects were reported checked with no search named; 5 named searches missed the file type (`src/index.css`, a `.env`) or the value (a brand-light `rgba`) the diff added.
