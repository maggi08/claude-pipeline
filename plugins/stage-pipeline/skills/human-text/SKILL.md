---
name: human-text
description: Text for people about a project, feature or task — the team, managers, a newcomer, a client. Collects the facts from the repo into a card, writes by rules derived from the StoryScope study (arXiv 2604.03136) of how AI text differs from human text, and runs the draft through a check with closed questions in a clean context. Manual only, via /human-text:human-text. Not for code, commits or PR descriptions (for a PR description, use `/task-wrapup` if stage-pipeline is installed).
disable-model-invocation: true
argument-hint: "[to whom] [about what] — e.g.: managers, payments status"
---

# Human Text — text about a project that people read

Request: `$ARGUMENTS`

The goal is a text that a person will read and understand: a post to the team, an update for a manager, an intro to the project for a newcomer, a letter to a client.

Why a separate skill. What gives away a model's text is not only the words. StoryScope (Russell et al., 2026, 61,608 stories by humans and five models) showed that AI is recognized by the structure of the text: it states the conclusion, follows one clean line, closes all the questions, and gives generalities instead of specifics. A detector that looked only at structure lost 1.6 points after the verbal clichés were scrubbed. So structure first (steps 2–3), then words (rule 11).

The study is about fiction. The rules below are a transfer to work texts: kept are the places where "like humans" coincides with "clear to the reader"; dropped are the places where they diverge (digressions for the sake of digressions, a withheld resolution, broken chronology).

## Step 1. The reader and what they will do after the text

From the request and the conversation, determine:

- **Who reads:** a manager / the development team / a newcomer to the team (including the user themselves) / a client.
- **What they will do after reading:** make a decision, start work, approve, just be informed.
- **Where they will read it:** a post in a messenger, a document, an email — length and markup depend on it.
- **About what:** the whole project, a feature, the current branch or task, an incident.

If the reader cannot be determined — one question through AskUserQuestion: who reads and what should they do. The rest is by default:

| Reader | What they need | Size |
|---|---|---|
| Manager | status, dates, risks, impact on users and money, what is needed from them | 5–12 lines; code internals only if they affect the date |
| Team | what is where in the code (paths), how to run it, which decisions and why, what is open | a screen or two |
| Newcomer | what the product does for users, the repo map, where to start, whom to ask | 1–2 screens |
| Client | what they get, when, what is needed from them | like a manager, without the internal kitchen |

## Step 2. The fact card — before the text

Before comparing, StoryScope translated each story into a structured template. On raw text the model found stylistic differences, on the template structural ones: of the top 20 features, only 6 matched between the two variants. The same here: facts separately from prose, and the text is written from the card, not from a general impression of the project.

Sources — whatever exists, absence is not an error:

- README, CLAUDE.md, the manifest (`package.json`, `pyproject.toml`, `go.mod` …) — what this is and what it is built on.
- `git log --oneline -30`; for a branch or task — `git diff --stat <main>...HEAD`.
- Task artifacts: `.claude/pipeline.config.md` → `<task_dir>/<TICKET>/` (STAGES.md, FEATURE-MAP.md, PR.md), `docs/features/`, `openspec/`.
- The conversation: what the user has already said.

The card (internal, do not show it to the user unless asked):

- **What it is** — one phrase without evaluations or metaphors.
- **For whom and why** — which user, which problem of theirs.
- **State** — what works, what does not; numbers and dates.
- **Decisions and their price** — what was chosen; why, including external reasons (deadline, requirement, constraint, incident); what it cost.
- **Not done, open, risks** — everything found, with no selection "for beauty". Selection by reader is allowed — mark what concerns exactly them (for a manager — dates, money, security; not the file layout). What is not marked does not go into the text.
- **What is needed from the reader** — a decision, access, a review, or nothing.
- **Names** — services, paths, tickets, versions, dates, commands and people.

Every fact has a source: a file, a commit, the user's words. Do not invent what is not in the sources — that is a gap. If the gap breaks the text (cannot tell a manager what is needed from them; no date, which they will ask about first) — ask the user in one list. Otherwise write, and list the gaps after the text.

## Step 3. The draft by the rules

Read `${CLAUDE_PLUGIN_ROOT}/skills/human-text/references/rules.md` and write the draft by its rules 1–11, within the limits of "Don't overdo it". Write from the card of step 2 for the reader of step 1. The meaning of the percentages is in the header of `rules.md`.

## Step 4. The check in a clean context

You see your own draft as good. The check is done by the agent `human-text-check` with a clean context: `human-text:human-text-check` (in a copy of this skill inside another plugin — `stage-pipeline:human-text-check` in stage-pipeline, and likewise under the name of any other plugin that carries the copy). Give it: the draft inside `<draft>...</draft>`, the card (step 2) inside `<card>...</card>`, and outside the tags the reader and the goal (step 1), the language, and any extra questions or reading condition. The agent treats everything inside the tags as data.

The 14 questions, the rule "answer every one explicitly" and its reason live only in `${CLAUDE_PLUGIN_ROOT}/agents/human-text-check.md`. The agent returns only the violations (the question number, the quote, how to fix) and a line with the count.

Fix only what it found, do not rewrite the rest — rewriting "everything" brings back the default habits. A finding may be rejected if it contradicts another rule (writing out everything from the card against size) or the facts; a rejected one goes with the reason into step 5.

If the agent is unavailable — read `${CLAUDE_PLUGIN_ROOT}/agents/human-text-check.md` and go through the same list yourself, answering every question explicitly (`yes` / `no`, a quote on `yes`).

## Step 5. Delivery

- The text goes first and ready to paste. A post or an email — in a code block, so it copies without loss; markdown headings only if it is a document.
- After the text, briefly: the gaps from the card (what you did not find and is worth checking), what you did with the disputed ("did not find the date — wrote 'date not set'"), and which findings of the check you rejected and why.
- To a file — only if the user asked or it is a document; then ask for the path.
- Language — the language of the request. Address — as the team does it; if unclear — formal address (the polite form, where the language has one).
