---
name: task-wrapup
description: Task finale — fold the journal of all stages into a ready PR/MR description → PR.md, collect the lists of verified and unverified items, open questions and risks for the reviewer. Manual only, via /task-wrapup — the pipeline and the model never invoke it. Only prepares text — does not create a PR or push. RU triggers — «оформи описание PR»
disable-model-invocation: true
---

# Task Wrapup — a PR/MR description from the task journal

The task has gone through N stages, each with its own decisions, checker findings and fixes. All of it lies in STAGES.md, STAGES-ARCHIVE.md and `checks/*.md`. The reviewer has not read it and will not: they need one text that makes clear what changed, why it is so and where to look.

This skill **only prepares the text**. Creating the PR, pushing and commenting are up to the user.

It is run **only manually** (`disable-model-invocation`): a description is not needed for every task, so neither `/stage-force` nor the final checks call it themselves.

> **Project config.** `main_branch`, `<task_dir>`, the platforms and the commands — from `<repo>/.claude/pipeline.config.md`.

> **Description language.** The PR/MR text is written in the language of the target repo's history (`git log <main_branch> --oneline -20`) or as the user asks — not in the task's language, which only decides the language of the task directory (`${CLAUDE_PLUGIN_ROOT}/references/language.md`, `skills/stage-check/references/commit-message.md`). The section names below are given in English; in a Russian-language description translate them.

## Step 1. Collect the facts into a card

The text is written from a fact card, not from a general impression of the task (step 2 of `${CLAUDE_PLUGIN_ROOT}/skills/human-text/SKILL.md`: facts separately from prose). Sources — what exists:

- `git log <main_branch>..HEAD --oneline` — what is really in the branch.
- `git diff --stat $(git merge-base <main_branch> HEAD)...HEAD` — the scale and the affected areas.
- STAGES.md: the stage statuses, the "Journal", the "⚠ Awaiting user confirmation" block, "Not included in the plan" (in a ru task they carry the Russian names from the table in `${CLAUDE_PLUGIN_ROOT}/references/language.md`).
- `checks/*.md`: the checkers' verdicts, what was fixed, blind spots.
- The repository's PR template, if there is one (`.github/pull_request_template.md`, `.gitlab/merge_request_templates/`) — fill it in, not your own structure.

The card (internal, shown only on request):

- **What and why** — the task and what the user will see.
- **Changes** — meaningful blocks, with paths; for a dependency bump — what it brought into the task (the reviewer needs this, not only the version); for a branch — its base.
- **Decisions and their price** — what was chosen, the reason (including an external one: a deadline, a library limit, an incident), what was given up.
- **Verified / not verified** — with the outcome of each: the exact screen or URL, where it was run (including a throwaway page that is not in the diff), and why anything could not be verified.
- **Not done, open, risks** — everything found, without selection "for beauty".
- **What is needed from the reviewer** — a decision, a look at a place, or nothing.
- **Names** — services, paths, tickets, versions, numbers, dates, commands.

Every fact carries its source (the journal, a checker report, a commit, the diff); a gap is handled as in step 2 of `${CLAUDE_PLUGIN_ROOT}/skills/human-text/SKILL.md`.

**The platform determines the word.** GitHub — PR, GitLab — MR; look at `git remote -v`, do not guess. The wording of commits and of the title — in the style of those already in the repo (`git log <main_branch> --oneline -20`).

## Step 2. Write the draft

The reader is a reviewer who has not seen the task; the channel is a PR/MR; what they do after reading is review the change. General writing rules (structure, words, "Don't overdo it") — `${CLAUDE_PLUGIN_ROOT}/skills/human-text/references/rules.md`; read it before writing and follow it, it is not repeated here.

The default structure (if the repo has no template of its own):

```markdown
## What and why
<2–4 lines: which task is solved and what the user will see. Not a retelling of the diff.>

## Changes
<By meaningful blocks, not by stages and not by files. Stages are internal mechanics,
the reviewer does not need them. 5–10 items, each one line.>

## How to test
<Concrete steps: URL/screen, state, what must happen. Assembled from the `AC-*` of all
stages (TEST-PLAN.md is already merged by ID) — but do not put IDs into the text, the reviewer does not know them:
what remains of a criterion is a scenario. Separately — how to reproduce non-trivial states and
what is left with the outcome `⏳`/`[live: user-side]` — this is what only they can check.>

## What the reviewer should look at
<Conscious decisions that had an alternative; places where shared code changed and
the radius is wider than the task; everything the checkers marked as a blind spot.>

## Out of scope
<What was deliberately not done and why; what was moved to separate tickets.>

## Open questions
<From DESIGN-QUESTIONS.md and the "Awaiting user confirmation" block — what is not yet confirmed
and by whom it must be.>
```

PR-specific rules:

- **Write for a person who has not seen the task.** Do not refer to stage numbers and the checkers' internal names.
- **Name the blind spots plainly.** What could not be verified and why is the most valuable part for the reviewer and the only one they cannot restore themselves; it goes into "How to test" or "What the reviewer should look at", not to the end (rule 6).
- Screenshots from `checks/screens/` — list the paths; there is no need to embed them in the text, the user will attach them themselves.

## Step 3. Pre-flight check

Before the text is checked and handed out, run and show each one in a single line (the points that edit the description are applied to the draft now, so that step 4 checks the final text):

- `lint`, `type_check` (against the baseline), `test`, the build — on the state of HEAD, not of the working tree: the `full-checks` item of the final checks (on the stages they went by the diff).
- Uncommitted in the tree: `git status --short`. Non-empty — say so explicitly, it is a risk of loss on a rebase.
- Is the "⚠ Awaiting user confirmation" block empty? Non-empty — move its items to the "Open questions" section of the description.
- Do the `AC-*` criteria of all stages have an outcome? The remaining `⏳`/`[live: user-side]` — into "How to test" as separate lines: this is exactly what the reviewer must check by hand, and silently it will not be checked.
- Has the final whole-branch pro-review passed? Not passed — suggest running it before opening the PR with the `pro-review` agent in whole-branch mode on `review_model` (`/stage-check`, Step 3.3), not with the skill in the main context: it catches a class of defects invisible to the per-stage checkers (the radius of a shared component, duplicates between stages, a broken HEAD under a clean tree).
- Has `/task-converge` passed and returned "converged"? It returned findings — the PR description is premature: catch-up first. This is the only check that answers "is the task really finished", not "is what was done done right".

## Step 4. Check the draft in a clean context

Check the text after the pre-flight insertions of step 3: the agent must see the final draft. Run the agent `stage-pipeline:human-text-check` (step 4 of `${CLAUDE_PLUGIN_ROOT}/skills/human-text/SKILL.md`; findings are handled as there). The input follows `${CLAUDE_PLUGIN_ROOT}/agents/human-text-check.md`: the draft inside `<draft>...</draft>`, the card of step 1 (with the items that step 3 moved into the text) inside `<card>...</card>`, and outside the tags the reader and the goal ("a reviewer who has not seen the task; a PR/MR; they review the change"), the language of the text.

Beyond human-text step 4: a finding may also be rejected if it contradicts the repository's PR template (for example, a required section with nothing to put in it); a rejected one goes into the output with the reason.

If the agent is unavailable, do it by hand as human-text step 4 says, and say in the output that the check was done by hand.

## Output

1. The ready description text — **in the chat as a block for copying** and as the file `<task_dir>/<TICKET>/PR.md`.
2. The proposed PR/MR title — in the repository's style.
3. One line: the check of step 4 — the agent's violations fixed, the rejected findings with reasons, and "checked by hand" if the agent was unavailable.
4. One line: the results of the pre-flight check.
5. One reminder line: pushing and creating the PR are done manually (`git push`, then the web interface or `gh`/`glab` by the user's command).

Do not run `git push`, `gh pr create`, `glab mr create` and do not comment on existing PRs — even as "preparation". The text is the result of this step.
