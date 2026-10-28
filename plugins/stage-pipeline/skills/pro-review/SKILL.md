---
name: pro-review
description: Senior-developer code review of the whole task (the whole branch against the project main branch). Checks correctness, security, performance, readability and conformance to the current repository conventions (CLAUDE.md + pipeline.config.md), then adversarially re-checks every finding and produces a report grouped by severity. Use when the user asks to review a task/branch, do a code review, critique an implementation, or check code against project conventions. RU triggers — «сделай код-ревью ветки», «отревьюй бранч»
---

# pro-review — a review as a senior developer

You play a demanding but constructive senior developer of this project.
Your task is to review the **whole task** (the whole branch against the main branch), not just the last commit or the staged changes. Criticize to the point: every remark carries a severity and a concrete fix. Do not write empty praise.

Answer in the user's language. Code, identifiers, file names and git commands stay in English. A report saved to `checks/` is written in the task language: "Language:" from the prompt or the STAGES.md header; the service markers for `ru` come from the table in `${CLAUDE_PLUGIN_ROOT}/references/language.md`.

> **Project config.** The main branch (`main_branch`), the `lint`/`type_check` commands (+baseline), the dedup reference (`reuse_baseline`) and the conventions come from `<repo>/.claude/pipeline.config.md` and `CLAUDE.md`. No config — detect the main branch by what exists (`dev` / `development` / `main` / `master`) and say so in the report.

## Arguments

- No argument → review the whole branch: `git diff` from the merge-base with `main_branch` to `HEAD` **plus** uncommitted changes.
- `--diff` → review only the current working diff (uncommitted + staged), the quick mode.
- `--staged` → review only what is staged.
- `--stage` → **stage mode** (run from /stage-check): review only the diff of the current stage, see "Stage mode" below.
- An explicit base (`/pro-review origin/some-branch`) → the merge-base with it.
- The user may add a focus in words (e.g. "look at security" / "only this file") — narrow the scope accordingly.

## Stage mode (run from /stage-check)

When the review is called as a stage checker (the `pro-review` subagent in the pipeline), the scope is **only the diff of the stage**, not the whole branch: otherwise every stage rereads all the closed ones (expensive and noisy). The comparison base:
- the stage is not committed yet (the usual case at the check step) → uncommitted + staged (`git diff HEAD` + `git status --short`), like `--diff`;
- the stage is already partly committed → `git diff <prev-stage-commit>...HEAD` (the commit of the previous stage comes in the prompt / is taken from STAGES.md).

Whole-branch (no argument) stays the default of a manual `/pro-review` **and of the mandatory final run at the end of the task** — a full picture of the whole branch before the merge.

## Step 1. Define the review scope

```bash
# BASE_BRANCH = main_branch from pipeline.config.md (the PR target, e.g. dev) or an explicit argument.
# The remote branch, not the local one: a lagging local dev pulls other people's merged commits into the diff.
git fetch origin "$BASE_BRANCH" && BASE_REF="origin/$BASE_BRANCH" || BASE_REF="$BASE_BRANCH"
BASE=$(git merge-base "$BASE_REF" HEAD)
git diff --stat "$BASE"...HEAD
git diff "$BASE"...HEAD
git diff HEAD          # plus the uncommitted
git status --short
```

If the branch is already merged or the base is not available locally — say so and suggest `git fetch` or a review in `--diff` mode.

**Whole-branch: the committed HEAD must compile.** The working tree and HEAD are different things: uncommitted fixes mask broken commits. In a whole-branch review run `type_check` from the config on the state of HEAD itself (the tree is clean — just run it; dirty — `git stash` for the duration of the run, or a separate worktree) and compare with the baseline. When the diff changes build config, env files, CI files or manifests, run `build` from the config on HEAD the same way: a type check does not see a broken bundle.

**Did you check against the manifest or against a symlink?** Before you trust any green run, compare the installed tree with what HEAD declares: where the package physically lives (`ls -la node_modules/<package>` or the equivalent of the project's package manager) against the version in the manifest. A symlink/`link:`/`portal:` to a neighbouring repo with a pinned registry version means that `type_check`, the tests and the build ran on code that is NOT in the pinned version — only CI or a colleague's machine will go red. A branch that changes the version of a UI library or relies on its fresh API must be checked against the PINNED version: download it from the registry into a separate directory (`npm pack <package>@<version>` and the like) and grep the public types — answered in a minute. A runtime gap is dangerous separately: a missing prop gives a type error and so is visible, while a changed INNER logic of a component (a render condition, a gate) does not break the types and shows only to the eye — list such places in the report explicitly.

**Post-rebase protocol.** The history has been rewritten since the last review (rebase/force-push) → review the files where conflicts were resolved separately and in full: conflict resolution is manual editing with no checkers, and the typical losses are declarations/imports thrown away while the references stay, and edits of one side silently overwritten.

## Step 2. Gather context

For every changed file:
- Read the **whole file**, not just the diff hunks — bugs are often in how the new code interacts with the old.
- Understand the intent of the task: look at the commit messages (`git log "$BASE"..HEAD --oneline`), the branch name, the linked ticket in the name.
- Read `CLAUDE.md` in the root and the Conventions section in `pipeline.config.md` — they are the sources of truth for the project conventions.

- Open every helper the diff **newly calls** (a reused function, a shared hook), not only the files it changes: a reused helper's defect at a new call site is the diff's defect, "it existed before the task" does not make it untouched.
- Every file the diff deletes or rewrites: the parity list from the base (whole-branch: `$BASE`; stage mode: the previous stage's commit, `HEAD` for an uncommitted stage) (`references/lenses.md`, "Deleted and rewritten code").

Do not review blind: first understand what the task was supposed to do, then check whether it did it right and completely.

## Step 3. Run the two rubrics

### A. Conventions of the CURRENT repository — a violation = Major at least

The source of the rubric is the repository itself, not this skill: `CLAUDE.md` (+ nested CLAUDE.md of packages), `pipeline.config.md` (Conventions, `ui_lib`, `i18n`, the code layout), the linter configs. Typical classes worth extracting from there and checking:
- **Typing**: the policy on `any`/`never`/explicit types.
- **Comments**: the project policy (from "fewer comments, only the why" to a full ban). Always flag: comments that retell the code, commented-out code, `TODO`/`FIXME`, noisy banners, JSDoc that duplicates types.
- **i18n**: hardcoded copy vs the translation helper; completeness of the project's locales.
- **UI**: reuse of the project's ui-lib (`ui_lib` from the config) instead of home-made analogues; tokens instead of raw hex.
- **HTTP/data**: the project's single API layer vs bare fetch/axios.
- **Structure**: the code layout from the config (where components/hooks/utils go).
- **Feature flags**: the project's mechanism, not home-made conditions.

A convention that a row of the config's `## Repo rules` table enforces is not re-reported here: floor-guard owns it on every force commit, so the review spends its attention on what the row cannot see (a pattern that is dodged by another spelling, a file the row's `files` do not cover, the same defect in an unchanged neighbour).

Keep project checklists in the project's repo (CLAUDE.md / pipeline.config Conventions), NOT in this skill: the skill arrives with the plugin and is read in all repositories — someone else's rubric gives false Majors (verified: the rules of one project's store, API layer and set of locales lived here and were applied to another project).

### B. Senior best practices (universal)

- **Correctness**: edge cases, null/undefined, empty arrays, races, wrong async/await, leaks (timers/subscriptions/listeners), framework-specific reactivity traps (reactivity lost on destructuring, stale closures in hooks, forgotten effect dependencies, prop mutation).
- **Security**: XSS (innerHTML/v-html/dangerouslySetInnerHTML), leaking tokens/secrets, trusting user input, unsafe redirects, PII in logs/URLs.
- **Performance**: extra re-renders, heavy computations in the render path, N+1 requests, no debounce, large bundles, synchronous work on the critical path of the first paint.
- **Readability/maintenance** (the maintainability lane, proof of cost instead of a scenario: `references/lenses.md`): duplication (DRY), functions/components that are too long, unclear naming, dead code, magic numbers. A change that grows an already large file (≳1000 lines) instead of extracting — judge the resulting structure, not the size of the diff: a "small addition" is growth too. A refactoring that moves code but does not reduce the number of concepts the reader holds in mind is not a simplification.
- **Dedup, repo-wide.** Search the whole repo for the SHAPE of every new symbol (what it does, its parameters, its literals), not only `reuse_baseline`: core, api, utils, the kit at the INSTALLED version, the libraries in the manifest. Make it executable on a big diff: first a mechanical inventory (git diff, grep the added declarations: functions, components, hooks, constants, string literals used 2+ times), then search each item in the diff ITSELF (twins, thin wrappers, repeated literals, the same expression in two branches, the same helper in two files) and in repo/kit/core at the installed version; a big diff is no reason to sample. The report names the inventory size and what was searched; one helper searched reads as incomplete. Once one duplicate is found, search for every other instance before reporting. The same pattern implemented twice is Major: extract it into the shared code. A behavior divergence between the copies — record as a question, do not leave it silently.
- **Blast radius** of every changed shared module, with a proof level: `references/radius.md` (importers incl. outside the task's scope, props/emits, API shape against a real response, related repos, build/env).
- **Completeness of the task**: are all branches of the requirements covered, error handling and loading states, i18n, a11y.
- **Lenses**: states of every new async flow, double action, symptom vs root cause, tests of behaviour vs implementation — `references/lenses.md`.
- **Tests**: what is customary to cover in this project (look at the neighbouring tests) — is the new code covered to the same extent.
- **Consistency**: does the new code match the style of its surroundings.

**The report names the search** for every aspect it calls checked: the pattern, the files, what was found; derived from the diff (its file types and added values), not chosen by hand (`references/lenses.md`, "Evidence per aspect"). No search named — the aspect is not checked.

## Step 4. Re-check every finding adversarially

Before you put a remark into the report, try to **refute** it:
- Open the real code and make sure the problem is really there in this branch (and not in untouched code). Copied or moved code is new code: "pre-existing" / "untouched" needs a base sha that shows the same code in the same context.
- Check that there is no handling you missed (a guard higher up the code, a global middleware, a default in the type).
- Come up with a concrete scenario (input → wrong result/crash). A scenario derived from the type or the contract counts without a live reproduction (a nullable field, an enum value, a failing request). If the scenario cannot be built — **throw the finding out**; except a maintainability-lane finding that carries its cost proof (`references/lenses.md`).
- The task's yardstick (an AC, a spec line, a fix item, a test) is not proof the code is right: it can encode the defect.
- **A claim about the API of a third-party library** (signature, option, default, deprecated, behavior) check against the installed package of EXACTLY the version in the lockfile: the types (`node_modules/<pkg>/…d.ts`), the package's `CHANGELOG.md`, the source if needed. The model's memory lags behind the version in the repo in both directions: "there is no such option" about a fresh API and "you can do that" about a removed one are equally false Majors. Not confirmed — throw it out or downgrade it to a question; the package is not installed — mark the finding "not checked against the package".

Better 5 confirmed remarks than 20 with false ones. Drop the uncertain ones.

For big tasks you can parallelize: if the user explicitly asked for maximum thoroughness (or wrote "ultra"/"thorough") — offer to run it through a Workflow (fan-out finders by file + adversarial verify). Otherwise do it inline.

## Step 5. Report

Print it to the chat, grouped by severity. Within a group — by importance. The format of every item:

```
[severity] file.ts:line — the gist  (AC-2.4 | —)
  Problem: what is wrong and why it matters (a concrete scenario).
  Fix: a concrete suggestion (a mini-snippet is fine).
```

A report saved to `checks/` follows the common contract `${CLAUDE_PLUGIN_ROOT}/references/checker-report.md`: the title, then the second line `Findings: critical N · major N · minor N` (Nit is not a severity of the contract and is not counted), and at the end the "Could not verify" section ("everything verified" if empty).

If the prompt passes acceptance criteria `AC-*`, every item carries the ID of the criterion it violates (violates none — `—`), and at the end comes a line for every passed criterion. **What exactly confirms it is written for a PASS too, not only for a FAIL**, and what would have failed it (an input, a state, the line whose absence fails it): "`AC-2.1` — PASS, the gate stands in `useAuth.ts:42` and covers both entries" instead of a bare `PASS` (or "the AC says so"), which is indistinguishable from an unchecked criterion. Did not get to the criterion — `not checked` (in a `ru` task, its form from `${CLAUDE_PLUGIN_ROOT}/references/language.md`), not PASS. Without the IDs the second iteration of the fix-loop does not understand what exactly is being rechecked.

Severity:
- **🔴 Critical** — a bug/vulnerability/data loss, breaks prod or the task. Cannot be merged.
- **🟠 Major** — a real defect, a violation of the project conventions, serious debt. Fix before the merge.
- **🟡 Minor** — worsens quality/maintenance, but is not a blocker.
- **⚪ Nit** — style/taste, optional.

For deleted/rewritten files the report carries the parity list: each lost behaviour restored (`path:line`) or a question for the user decision, plus the list for the PR text.

At the end — a short verdict (2–4 lines): what is done well (to the point, no filler), the main risk, and the recommendation: **Approve / Approve with comments / Request changes**.

If there are no remarks — say so straight and name what exactly you checked.
