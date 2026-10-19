# Precedents of the /pro-review rules

Where each rule came from. The file is not needed to run the skill — the rules in `SKILL.md` are self-sufficient; it is needed when you want to weaken or rewrite a rule.

## The remote branch, not the local one: a lagging local dev pulls other people's merged commits into the diff.

A rebase conflict resolution threw away variable declarations, and a broken component lived through the rewritten commits until the final review — the tests did not import it, and the working tree contained the fix.

## The remote branch, not the local one: a lagging local dev pulls other people's merged commits into the diff.

The branch pinned a beta version of the UI kit while `node_modules` was a symlink to a local checkout — through the whole pipeline (6 stages, three checkers on each, a cleanup-review before the PR) went 2 `type_check` errors on a clean clone and a selection indicator that vanished on one screen.

## B. Senior best practices (universal)

The shared info block of a step was rewritten from styled-components to Tailwind in the redesign tree; FIVE legacy screens imported it through the shared path, including one outside the scope of the task — on the classic design the headings became 21px instead of 24/28px and lost their centering and bottom margin. It went through the whole pipeline and was caught only by the final whole-branch review.
