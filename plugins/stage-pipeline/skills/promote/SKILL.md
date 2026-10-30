---
name: promote
description: Turn what the pipeline keeps finding into something that stops it — repeated findings of a repo's tasks become the highest working level (an architecture stage, types, a lint rule, a `## Repo rules` row, a CLAUDE.md line), each proven on two real pre-fix versions before it is offered, and repeated dismissals become skip patterns of a checker. Manual only, via /promote; nothing in the project changes without an explicit yes per rule. Use when the user asks which repeated findings could become rules, after a few tasks of a repo have closed, or to clean the false positives of a checker. RU triggers — «что у нас повторяется в ревью», «превратить повторы в правила»
disable-model-invocation: true
---

# Promote — repeated findings become rules, repeated false positives become skip patterns

A finding that the checkers raise in two tasks of the same repo should not be raised a third time: it should become something that stops it by itself. Prose rules decay (the 0.11 audit); a lint rule, a type or a guard on the commit does not. This skill finds the repeats, picks for each the **highest level that works**, **proves** it on real history, and offers it. It writes nothing on its own.

Manual only. It never calls `gh` or `glab` (in force they are denied; the user exports review comments by hand), never fetches, never installs, never uses `npx`.

## 0. Inputs

Collect, then say in one line what was read and what was missing.

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/retro.mjs <repo | task_dir> --findings --json [--repo <name>] [--root <repo>]`: the critical and major findings of the repo's tasks with their outcomes, grouped into a first cut of classes, signals (the same path or identifier in two tasks), commits after each task closed (no checker ran on them), and the stage 1 corpus rows with `--corpus <tsv>` when the user gives the file. The first cut is noisy (keywords): it only makes sure nothing is missed. **Where the tasks live**: the repo's own `task_path` is read, and so are the tasks of the task directory registry whose `STAGES.md` header names the repo or whose ticket-named branch exists in it (a task over several repos keeps its journal in one of them; the output lists those it found). A task directory that is not registered (a shared one outside any repo): pass it as another target, and keep only the tasks whose `STAGES.md` names the repo (`grep -l <repo> <dir>/*/STAGES.md`), one by one: the shell must not word-split a path that has a space. Say in the inputs line how many task directories were read and where, so that a repo with one of seventeen tasks read is visible as that.
2. Merged PR/MR review comments, **only if the user supplies an export** (a file or pasted text). They are a repeat source like any other: a human reviewer's comment that came twice is a class the checkers did not have. Ask once; no export, no PR input.
3. Repeated dismissals per checker: `retro.mjs <repo> --findings --dismissals` lists the findings closed as `false` per checker with the reason of each outcome line (`dismissals` in `--json`). This is the input of the reverse direction, section 6.

Read `${CLAUDE_PLUGIN_ROOT}/skills/promote/references/ladder.md` before proposing anything.

## 1. Cluster

Take the `retro --findings` classes and signals, then cluster by meaning on top of them: two findings are one class when the same fix would have prevented both (`resolveComponent('Name')` in two screens, a toast imported from the wrong package, an arbitrary radius instead of a token). A class needs **two or more hits**; one-off findings are not promoted. Drop a class the repo already enforces (its lint rule, its `## Repo rules` row, a CLAUDE.md line with a mechanical check) and a class **the build or the type check already stops** (a deleted module, an import that cannot resolve, a missing export: the code does not compile with it, so a rule on it proves nothing and guards nothing), and say so. Show the user the clusters with their hit count, tasks and one `path:line` each, before any proposal.

## 2. Pick the highest working level

For each class, in this order, the first level that works:

1. **An architecture or delete stage**, proposed: the repeat comes from a structure (two ways to do one thing, an unfinished migration). Offer a stage, not a rule.
2. **Types**: the wrong form does not type-check.
3. **A lint rule**: an existing ESLint rule, else `no-restricted-syntax` / `no-restricted-imports` with a message that names the fix.
4. **A `## Repo rules` row** (id · pattern · files · message · evidence), enforced on added lines by floor-guard.
5. **A CLAUDE.md line**, last: prose, marked unproven.

A level "works" when it can be proven (section 3) or, for 1 and 2, when it is a task the user can judge. If a higher level does not prove, say why and go one down; do not skip levels to the easy one.

## 3. Find the fix commits, then prove it, with revs and counts (AC-13.2)

The proof needs the `fixes`: the commits that removed the wrong form. The findings give a `file:line`, not a sha; find them in this order: the `commits` the `retro --findings` examples list (the commits of the task branch that touched that file); then the commits of the task whose subject or ticket id names the class (`git log --oneline --grep=<ticket>` or the class words); then the pickaxe on the form itself (`git log -S'<text>' --oneline -- <file>`, or `-G'<regex>'`). Keep a commit only when its diff really removes the form (`git show <sha> -- <file>`). A class with no such commit has no pre-fix version in the repo: it goes to level 5, unproven.

A candidate of level 3 or 4 is offered only after `node ${CLAUDE_PLUGIN_ROOT}/scripts/promote-proof.mjs --root <repo> --candidate <json>` ran and its output is **shown to the user as is**: it fires on at least two real pre-fix versions (the files a fix commit changed, at its parent) and stays quiet on HEAD, or fires on HEAD only on lines added after the fix. **HEAD is swept by default over every tracked file the rule covers** (`HEAD: quiet on N of M tracked files`, or the files that fire): the files the fix cleaned are quiet by construction and prove nothing. `headFiles` narrows the sweep to named files, and the result then says so; a narrowed probe is not a HEAD proof, do not use it to get a green. The runner uses the project's own ESLint (never `npx`), counts only files that ESLint really linted, and prints what the project already has under the same rule id, because an override replaces it: **the proposal is a merge with the existing entry, shown as a diff, not a substitute**. Candidate fields and the fallbacks (`exit 3` no ESLint: a Repo rules row proven by `git show` + its regex, or a CLAUDE.md line marked unproven) are in `references/ladder.md`.

Not proven means not offered as a rule: say "not proven: <reason>" and move one level down. Legacy code that still matches (HEAD fires on old lines) is reported as a migration to the user, not as a failed rule: the count of files and the list come from the proof output. The proof also prints `no entry for <rule id> (checked on <file>)` or the project's existing entry; a failed lookup says so, and then the merge is checked by hand before anything is written.

## 4. Offer, one at a time (AC-13.5)

For each proposal show: the class and its evidence (task, report, `path:line`), the level and why not a higher one, the proof output, the exact text that would be written and where, and **the prose of the repo the rule contradicts**: grep the project's `CLAUDE.md`, `pipeline.config.md` and docs for the opposite advice (a config that recommends the form the rule forbids); list each hit as a line to change with the rule, since a rule and a sentence that disagree make the agent follow the sentence. Then **wait for yes or no on that proposal**. No "accept all", no default yes; silence is a no. Several proposals are shown one after another, each with its own answer.

What a yes does, by level (nothing else is written):

- **Architecture/delete stage, types, lint config, CLAUDE.md line**: a task item. Add the proposal as a line under "Not included in the plan" (or as a catch-up stage text for `/stage-plan`) of the current task's `STAGES.md`, with the proof output path; when there is no task, print the item for the user to carry. The project's lint config, `CLAUDE.md` and types are **never edited by this skill**: they change in a stage that goes through the pipeline's checkers.
- **A `## Repo rules` row**: written only after that yes, to **the config the hooks read** (`configRoot`: the main tree's `.claude/pipeline.config.md` for a linked worktree whose `.claude/` is excluded, the worktree's own otherwise), never to a new `pipeline.config.md` created in the worktree: it would shadow the main tree's config for every hook in that worktree and `task_path` would fall back to the default. Name that path in the proposal. The way `/pipeline-doctor` writes config: show the exact row and the file, write it, and say that this is a shared, committed file, so it goes in a separate commit that the user makes. If the config has no `## Repo rules` heading, add the heading with the header row first. Check the result with `parseRepoRules` (the script prints problems for a bad row) and tell the user the line: `floor-ok: <reason>` in an added line waives it, and the digest lists the waivers.
- A no: write nothing. Keep the proposal in the answer so the user can come back to it.

In force mode this skill does not run (it is manual): a user who starts it in a force session still gets the same questions.

## 5. The ladder's honest limits

Say what was not covered: classes with one hit, the findings without an outcome line, the tasks whose reports were not readable, the commits after done that carry no finding at all (counted, not classified). A class that came only from human review comments and has no pre-fix version in the repo is offered at level 5 and marked unproven.

## 6. The reverse direction: repeated false positives

For each checker whose findings were closed as `false` two or more times for the same reason (read the outcome lines; a dismissal with a proof counts, one without does not), propose an entry for `skills/<checker>/references/false-positives.md` **of the plugin repository** (the file lives in the plugin, not in the project; a checker with no such file, as figma-compare, gets a new one in the same format): **skip when / do not skip when / example / source**, same four parts as the existing entries. Read the file first: if the pattern is there, propose a "do not skip when" line instead, when the repeat shows the skip was wrong. The "Never skipped" list at the top of each file is not negotiable: an entry never overlaps it (the format: `references/reverse.md`). An entry is shown with the dismissals it comes from and waits for a yes like any other. **This direction never writes into `${CLAUDE_PLUGIN_ROOT}`**: for a teammate that is the versioned cache of the installed plugin, and the next update replaces it, so an entry the user said yes to would vanish. After the yes, emit a patch (a unified diff against the plugin repository's file) or a task item for the plugin repo and tell the user where to apply it; write the file itself only when the working directory is a git working tree of the plugin. A pattern for `kit-override-scan` also needs a code change in the scan and its self-test: propose that as a task item, do not write the script.

## Output

Short: the inputs line; clusters; then each proposal with its proof output and the question; at the end a table `class · level · proof · answer · written where`. Language of the reply is the user's.
