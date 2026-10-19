---
name: feature-doc
description: Create or update a feature doc in `docs/features/` after a finished task — why the feature exists, what it promises the user, how it works, where the code is, what it depends on. Writes for someone who has not seen the feature and checks the text with a subagent in a clean context. Reads the artifacts of both workflows (OpenSpec `openspec/changes/*` or stage-pipeline `<task_dir>/<TICKET>/`), and the branch diff where there are none. Manual only, via /stage-pipeline:feature-doc — the pipeline and the model never invoke it. Not a PR description (`/task-wrapup`) and not a formal OpenSpec spec.
disable-model-invocation: true
argument-hint: "[feature or doc path] [rewrite] — e.g.: saved-searches, or rewrite docs/features/saved-searches.md"
---

# Feature doc — a doc on the feature for the team

Request: `$ARGUMENTS`

When a task ends, the knowledge falls apart. The MR description dies with the MR, the stage journal lies outside the repository with its author, `openspec/changes/*` goes to the archive as a delta from which the current state cannot be assembled. A newcomer who arrives in six months finds neither the business requirements nor an explanation of how it works.

This skill leaves **one document per feature in the repository** after the task — `docs/features/<slug>.md`, which lives for years and is updated by every next task on the same feature.

It works the same from both workflows: a developer on OpenSpec and a developer on stage-pipeline run the same `/stage-pipeline:feature-doc`, and the skill finds what to collect the facts from.

**What this is not:**

| Not this | Who does it |
|---|---|
| A PR/MR description for the reviewer (lives a week) | `/task-wrapup` |
| A formal `SHALL` / `WHEN-THEN` spec | OpenSpec skills, `openspec/specs/` |
| The task journal, stages, checker findings | `STAGES.md`, `checks/*.md` |
| A retelling of the diff | `git log` |

## Who reads

The document is opened months later by people who have not seen the feature:

- **A developer** — came to fix a bug or to do the next task on the feature. Looks for what the feature promises, where the code is and what breaks if it is touched.
- **A product manager, QA, an analyst, a newcomer to the team** — read the top: the title, the first sentence, "Why", "What it does". They do not open the code and do not know the task's jargon.

So **the top of the document is clear without the code**. Before the "How it works" section, every sentence stays readable even if everything in `backticks` is skipped: a name from the code goes next to a word, not instead of one. From "How it works" down, the text is for a developer: paths, symbols, endpoints.

The text is written by a model, and the model has habits that get in the reader's way. The shared rules against them are in `${CLAUDE_PLUGIN_ROOT}/skills/human-text/references/rules.md`; the doc has a few rules of its own (Step 4). The draft is checked not by the author but by a subagent with a clean context (Step 5).

## Input: where to take the facts from

Determine the source yourself, in this order, and announce the choice ("Source: …", how to override it). If both are found, use both.

1. **OpenSpec** — `openspec/changes/<name>/` (an active change) or a fresh folder from `openspec/changes/archive/` if the change is already archived. Read `proposal.md` (`## Why` is a ready "why", `## What Changes`, `## Impact`), `design.md`, `tasks.md`, the delta specs `specs/**/spec.md`. The permanent specs `openspec/specs/<capability>/spec.md` are the requirements in pure form.
2. **stage-pipeline** — `<task_dir>/<TICKET>/`: `FEATURE-MAP.md` (the feature map from before the task — almost ready "How it works" and "Code" sections), `STAGES.md` (+ `STAGES-ARCHIVE.md`) — the user's decisions with reasons, boundaries, "Not included in the plan"; `checks/*.md` — what was checked and what stayed a blind spot; `PR.md` — the "why" in human language. `<task_dir>` comes from `<repo>/.claude/pipeline.config.md` (`Task state → task_path`), taking `pipeline.config.local.md` into account.
3. **None of these** — only git: `git log <main_branch>..HEAD`, `git diff --stat $(git merge-base <main_branch> HEAD)...HEAD`. The diff shows what was done but not **why** — get the missing part from the user in one batch of 2–3 questions, without stretching it into a dialogue.

The task may already be merged — then the comparison base is not `HEAD` but the ticket's commits: `git log --oneline --all --grep=<TICKET>`. A retrospective doc on an old feature is a normal mode of work, not an exception.

Below, the skill several times says to ask the user. If there is nobody to ask (an autonomous run, a launch from a subagent), do not stop: take the default decision and put both the decision and the question you would have asked into the report.

## Step 1. Find the feature and its document

The unit of the document is **the feature, not the task**. Five tasks on a payment calculator give one `docs/features/payment-calculator.md`, not five files.

First determine the documents folder, from here on `<docs_path>`:

1. `<repo>/.claude/pipeline.config.md` (taking `pipeline.config.local.md` into account), section `Feature docs → docs_path`;
2. otherwise the place where feature docs already lie in the repository (`docs/` with its own structure, `documentation/`, `wiki/`) — say that you put it there;
3. otherwise `docs/features/` — a default, not a dogma.

Find the existing document before creating a new one:

- read `<docs_path>` — names and headings;
- match by code: grep the paths of the task's key files across `<docs_path>*.md` — if a file is already mentioned in someone's document, that is the document of the same feature;
- match by domain and synonyms of the name (search / lookup / saved filters).

Several candidates — ask, do not guess. None, although the feature has clearly lived in the code for a long time — say that too: it means the document is created for the first time and covers the whole feature, not only the diff of this task.

The slug is kebab-case in Latin letters **by domain**: `saved-searches`, `seller-onboarding`, `toast-notifications`. Not by ticket (`ab-123`), not by screen (`results-page`), not by layer (`saved-search-store`).

Always announce the decision: "Document: `<docs_path><slug>.md` — creating / updating".

## Step 2. Check that the task is finished

Warn, but do not block — the document is written from the code as it is, not from ticked boxes:

- unclosed `- [ ]` in `tasks.md`, stages not in `[status: done]` in `STAGES.md`;
- a non-empty "⚠ Awaiting user confirmation" block;
- `git status --short` is non-empty — **name this without fail**: part of the feature lies in the working tree, and the document will describe what the branch does not have yet. The document must be committed together with those edits.

If something is found, list it and ask whether to continue. The user confirmed — continue.

## Step 3. Check the facts against the code and build the card

The journal and `proposal.md` say what was **meant** to be done. The document describes what **exists**. So every fact that goes into the document is confirmed by the code:

- paths and `file:line` — open them and make sure the symbol is in place;
- dependencies — from `package.json`, not from memory;
- endpoints, feature flags, i18n keys, routes — by grep;
- behavior promised in the delta spec — check that it is implemented in the code.

If the journal disagrees with the code, trust the code and name the disagreement to the user in the report: it is a finding, not an obstacle. Planned but not done — does not go into the document.

The result of the step is the **fact card**. It is internal: do not show it to the user unless asked. The document is written from the card, not from a general impression of the feature, and the subagent checks the draft against it in Step 5.

- **What it is and for whom** — one phrase without evaluations.
- **Why** — what problem of the user or the business the feature solves.
- **Rules** — "condition → what the user sees", each with a `file:line`.
- **Boundaries** — what is deliberately outside the feature; what is postponed — with the ticket, if there is one.
- **Decisions** — what was chosen, why and what it cost. Mark an external reason (a backend contract, a limit of the kit or a library, a deadline) separately.
- **Dangerous** — what is easy to break and for whom it breaks.
- **Mechanics and code** — the flow, files and their roles, dependencies, endpoints, flags, entry points. This is the material of the sections for a developer, each fact also has a source.
- **Terms** — every internal word that will get into the text: products, screens, abbreviations, team jargon. An explanation in one phrase and where it is taken from. A commonly used word (annuity, deductible) may be explained in your own words; facts about the feature itself — only from the sources.
- **Gaps** — what was not confirmed or not found.

Every fact has a source: the code, a task artifact, the user's words. If a gap breaks the document (nothing to fill "Why" with, nothing to explain a term with), ask the user. All questions in one list, together with the questions from "Input".

## Step 4. Write the document

Headings are given in English; write them in the language of the document: Why, Terms, What it does, How it works, Code, Dependencies, Entry points, Watch out.

```markdown
# <The feature in human language>

<One sentence: what this is and for whom. No names from the code.>

Current as of: <YYYY-MM-DD> · <short-sha>

## Why
<2–4 lines: what problem of the user or the business the feature solves. In the present tense: not "what we did" and not "was → became".>

## Terms
<The section exists only if there are more than three internal words; otherwise each is explained at its first mention.>
- **<Word>** — <what it is, in one phrase>.

## What it does
<Behavior rules as a list: condition → what the user sees. An item is one rule, 1–3 lines. Every item can be checked by hand in the interface.>

**Does not do:** <boundaries — what is deliberately outside the feature, so that the next person does not look for it in the code.>

## How it works
<The flow: screen → state → request → result. An ASCII diagram if the flow is not trivial. Mechanics — cache, races, order of requests — live here, not in "What it does".>

## Code
| Layer | File | Role |
|---|---|---|

<The role is one line, without caveats in parentheses.>

<Key decisions: what was chosen, why, what it cost. "That's how it was historically" is not a reason; no reason — do not write the item.>

## Dependencies
<External packages; internal modules (stores, composables, kit components); API endpoints; feature flags; locale namespaces.>

## Entry points
<A route or screen → file. How to open it locally: the dev server URL and the conditions — authorization, flag, platform, test data.>

## Watch out
<What is easy to break: what exactly will break, for whom, and what to do if you change this place. SSR, request races, legacy branches, shared code with a wide blast radius.>
```

### Content

- **Write for someone who has not seen the feature** (the "Who reads" section). No stage numbers, no checker names, no "as agreed in the fourth round" — that is the internal mechanics of the task.
- **Briefly: a guideline of 60–150 lines.** The size is most often inflated by retelling the code, mechanics in "What it does" and long "Role" cells: leave the path by which the code will be read. A feature across several screens may come out longer if the extra lines are behavior rules and warnings. The completeness of "What it does" and "Watch out" matters more than the limit. More than 200 lines is a sign the feature should be split into two documents.
- **A requirement is a rule, not an event.** "The down payment is at least 10% of the price" is a rule, it lives in the document. "We merged five calculators into one" is an event of the task, it lives in the git history. Words that make sense only relative to the task — "now", "new kind", "former", "no longer", "redrawn to the new design", "after the refactoring" — in six months nobody knows relative to what. Write it as it is. "Legacy" on its own also says nothing — name what exactly: markup outside the kit, an unreachable branch, a field of the old contract. A temporary state outside the feature (the endpoint is not on prod, a flag is not on everywhere) is written with a date: "As of 2026-10-06 prod answers 404".
- **Invent nothing.** Every fact is from the code or from the task artifacts. Nothing to confirm it with — do not write it.
- **References are `file:line`**, paths relative to the repository root.
- **The document language is the repository language** (existing docs and comments show which). File, symbol and command names — as in the code.

### Text

The shared rules 1–11 and "Don't overdo it" — in `${CLAUDE_PLUGIN_ROOT}/skills/human-text/references/rules.md`. Read it before writing and apply it to the document. The rules are "don't do this by default", not "always do this". The examples below are from a made-up feature, "saved searches" in an abstract marketplace.

The rules of the doc, on top of the shared ones:

**1. The point first.** The first sentence is what this is and for whom. No "This document describes…", "Within the task…", "In today's world…". "Why" is the problem the feature solves now. Backstory only if the decision is not clear without it.

- ✗ "The Save search button on the results page was a mute redirect into Alerthub: the buyer left for an outside product…"
- ✓ "Alerthub does not know which filters the buyer had set. So the marketplace creates the saved search itself, with the filters already applied."

**2. A term is explained and not renamed.** Products, screens, abbreviations, team jargon (SRP, "digest", "the gate") — one phrase at the first mention, and if there are more than three, in the "Terms" section. Having chosen a word, keep it to the end of the document. If in one place it is "saved search", in another "watchlist", in a third "subscription", the reader will decide these are three different things. And the other way round: one word is one thing.

- ✗ "A saved search / watchlist picks up new listings by itself", and in the code table — "Subscription".
- ✓ "**SRP** — the search results page, `/search`", and from then on always "SRP".

A flag, an endpoint or a field that has to be mentioned in the top sections gets a human name, and the code goes in parentheses next to it:

- ✗ "The whole block is hidden by the feature flag `disable_saved_search_alerts`."
- ✓ "The flag that turns off alerts (`disable_saved_search_alerts`) removes the Save search button from the SRP."

**3. A "What it does" item is one rule through the user's eyes.** Condition → what the user sees. Cache keys, `watch`, counters, the order of requests are mechanics, they belong in "How it works". More than two conditions — a table, not a sentence with "and only when".

- ✗ "The digest state goes into the preview key, so switching the toggle with an invalid email recalculates after the email is returned. One click — one `POST preview` with `digest: true`, the preview is recalculated (without `watch`)."
- ✓ "The digest toggle immediately updates the email preview. If the email address is invalid at that moment, the preview updates once the address is fixed."

**4. Short sentences.** One thought is one sentence. A parenthesis inside a parenthesis, a list through ";" in parentheses, a chain "only when… and only if…" — cut into sentences or move to a table.

**5. The dangerous — directly and with an action.** Name the severity in words: "breaks SSR", "touches the whole search flow", "the branch is unreachable". Not "there are nuances", not "worth considering". Every item in "Watch out" says what will break and what to do: "If you change the `savedSearches` store contract, run the whole search flow — 17 files read the store".

**6. The ending and the markup.** There is no "Summary" or "Conclusion" section: the document ends with "Watch out". Bold is only a label at the start of an item or paragraph ("**Does not do:**") and one warning. If a part needs a subsection, make it a `###` heading, not a bold subject. For a document in Russian, in addition to rule 11 of `rules.md`, also remove "данный" ("Данный документ описывает…"), "удобный", "гибкий".

## Step 5. Check the text in a clean context

You see your own draft as good: you know the code and remember what you meant. The check is done by the agent `stage-pipeline:human-text-check` — handled as in step 4 of `${CLAUDE_PLUGIN_ROOT}/skills/human-text/SKILL.md` (the findings are handled there too). The input follows `${CLAUDE_PLUGIN_ROOT}/agents/human-text-check.md`:

- the draft inside `<draft>...</draft>`, the fact card (Step 3) inside `<card>...</card>`;
- outside the tags: the reader and the goal (the "Who reads" section: a developer reads all of it, a product manager, QA, an analyst and a newcomer read the top; they will use the document to understand or change the feature), the language of the text;
- outside the tags, the extra questions of the doc, numbered `D1…` (`yes` = a violation);
- outside the tags, the reading condition: "as a newcomer: read only the document, do not open the repo; extra questions D1–D2 concern only the top of the document (before "How it works"), without the "Current as of" line; below it the reader is a developer — names from the code are normal there, team jargon is not".

The extra questions:

- **D1.** Is there a sentence in the top sections that loses its meaning if everything in backticks is skipped?
- **D2.** Is there a word in the top sections — jargon, an abbreviation, a product or screen name — that a newcomer will not understand and that is not explained at its first mention or in "Terms"? List all such words.
- **D3.** Is one thing named with different words, or does one word mean different things?
- **D4.** Is the first sentence not "what this is and for whom"? Does "Why" tell a story ("was → became", "now") instead of a problem?
- **D5.** Are there task-event words: "now", "new", "former", "no longer", "after the refactoring", "redrawn"?
- **D6.** Does a "What it does" item describe mechanics (cache, `watch`, counter, order of requests) instead of what the user sees, or is it longer than three lines?
- **D7.** Is there a sentence with nested caveats: a parenthesis in a parenthesis, a list through ";" in parentheses, a chain "only when… and only if…"?
- **D8.** Does some section retell code that is easier to open by the link? Is the document longer than 150 lines because of retelling code or repetition, rather than because of rules and warnings?
- **D9.** Is there a "Watch out" item that does not say what will break and what to do?

Fix only what was found, do not touch the rest: rewriting "everything" brings back the default habits. The exception is a violation of the same kind that you noticed yourself while fixing — fix it too. A finding may be rejected if it contradicts another rule (completeness against size) or the facts; a rejected one goes into the report with the reason. If the agent is unavailable — read `${CLAUDE_PLUGIN_ROOT}/agents/human-text-check.md` and go through the same list yourself, plus D1–D9, answering every question explicitly, and say in the report that the check was done by hand.

## Step 6. Update an existing document

The document already exists and the task changes it — merge, do not overwrite. (A request to rewrite the document more clearly is another mode, Step 7.)

- read the document in full;
- change **only** the sections the task touched; leave the rest as it is — in the same order and with the same wording;
- build new behavior into "What it does" as a separate item or an edit to an existing one, not as a tail to it. If an item has grown past three lines, split it, carry the mechanics into "How it works";
- behavior the feature has lost — delete it, do not mark it "used to be";
- update the "Current as of" line;
- the document describes a state that is no longer in the code (went stale since the last task) — fix it by the code and say so in the report.

The sections the task touched go through the Step 5 check. Do not silently fix violations in other sections: list them in the report and offer to fix them.

The document **keeps no change history**: it always describes the current state, and the past is looked up in `git log <docs_path><slug>.md`. Do not add sections "Changelog", "History", "Was/became".

The operation is idempotent: a repeated run on unchanged code must not change the content.

## Step 7. Rewrite more clearly

A separate mode: the user asks to rewrite an existing document more clearly or agrees to an offer from the report. There is no task behind it, so the steps go differently:

- **Source** — the document itself and the code. Read the artifacts of past tasks on the feature too, if any turn up (tickets from `git log <docs_path><slug>.md` and from the commits on the feature's files): without them "Why", the reasons and the price of decisions cannot be restored.
- **Step 1** — only if the path to the document is not given. **Step 2** — only `git status --short`.
- **Step 3 in full:** recheck every fact of the document against the code and build the card. A fact did not hold — fix it by the code or remove it.
- **Steps 4 and 5 — on the whole document.** The Step 6 rule "leave the rest in the same wording" does not apply here.
- **Step 8** — fix the index line if "About" does not pass the Step 4 rules. **Step 9** — the report; list there what was fixed or dropped because it did not hold in the code.

## Step 8. The index

`<docs_path>README.md` is a table by which a newcomer chooses what to read:

```markdown
# Feature docs

| Feature | About | Document |
|---|---|---|
| Saved searches | Saving a set of filters and an email digest of new listings — on the search results page and in the buyer's account | [saved-searches.md](saved-searches.md) |
```

The index headings are written in the language of the document, as in Step 4. The "About" column is written by the Step 4 rules: no names from the code and no jargon. Rows in alphabetical order. No file — create it, there is one — fix a single row.

## Step 9. The report

```markdown
## Doc ready: <feature>

**Document:** <docs_path><slug>.md (<created | sections updated: … | rewritten>)
**Source:** <openspec:<change> | pipeline:<TICKET> | git | document + code>
**Index:** <docs_path>README.md — <row added | updated | unchanged>
**Text check:** <found N, fixed M; rejected: … — why>

<Gaps: what was not confirmed or not found — what a human should check.>
<The document disagreed with the code — what was fixed by the code, what dropped out.>
<Disagreements of the journal with the code — if there were any.>
<Violations in untouched sections — if there were any, with an offer to fix.>
<Step 2 warnings and decisions made without the user — if there were any.>
```

End with one line: the document must be committed to the task branch, so that it arrives in the MR together with the code.

## Boundaries

- **Do not touch `openspec/specs/`.** The formal specs are kept by the OpenSpec skills; `docs/features/` is a parallel human layer. If the repository has specs, refer to them by a link, do not copy the requirements twice.
- **Do not write the PR description** (`/task-wrapup`) and **do not archive the change** (`/openspec-archive-change`).
- **Do not commit and do not push** — the result of this skill is files, not a commit.
- **One document per feature.** Do not start a second one under another slug if the first already exists — update it.
