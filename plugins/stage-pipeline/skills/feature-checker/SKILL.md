---
name: feature-checker
description: Build a map of an existing feature across all its contexts/platforms (from pipeline.config.md) — what is already implemented, how it works, what is shared. Use when starting a task on an existing feature, a redesign, or when the user asks "how does X work now" / "what is already done for X". First pipeline step before /stage-plan. RU triggers — «как сейчас работает X», «что уже сделано по X», «карта фичи»
---

# Feature Checker — a map of the existing feature

The goal: before any work on a feature starts, get a complete map of what already exists, so that the planner (/stage-plan) can tell "reuse" from "write from scratch".

## Input

- The feature name / ticket (WEB-XXXX, KC-XXX) and/or a description from the user.
- If it is unclear which feature is meant — ask a clarifying question BEFORE the research.

> **Project config.** Take the contexts/repositories, the code layout, the UI lib and `<task_dir>` from `<repo>/.claude/pipeline.config.md` (no file — `/pipeline-init`).

> **Task language.** FEATURE-MAP.md is a file of the task and is written in the task's language, `en` or `ru`. If `<task_dir>/<TICKET>/STAGES.md` exists, the language is its `Language:` line. Otherwise (the usual case — the map comes before the plan) the order is the same as for a new task: an explicit request of the user > `language:` in the config > the language of the message that started the task. The headings and the header fields of the template below are the English forms; for a ru task take them from the table in `${CLAUDE_PLUGIN_ROOT}/references/language.md` (the "FEATURE-MAP" rows). The prose is in the task language. A STAGES.md without a `Language:` line is resolved by the rule in `${CLAUDE_PLUGIN_ROOT}/references/language.md`.

## First — is someone already building this map

A feature map outlives the task that built it. Before reading the repository, look for a ready one: `<task_dir>/*/FEATURE-MAP.md` — another ticket may have studied the same feature. If several are found — take **one, with the freshest `Base:`** (by the commit date of the SHA, not by the date in the header: the header is edited by hand, the commit is not), do not look at the rest. If one is found — do not build it again, update it (`Base:` or its Russian form from the table in `${CLAUDE_PLUGIN_ROOT}/references/language.md` — both are read, whatever the language of that map):

1. Take `Base:` from its header and see what has changed since then in its files: `git diff <sha>..HEAD --stat -- <paths from the map>`.
2. Empty — the map is current. Update the date and the SHA, copy it into your ticket's directory (in your task's language, if the map is in the other one) and go on to the summary.
3. There are changes — re-read ONLY the affected sections, carry the rest over as is, and translate the carried-over sections into your task's language too if the map is in the other one, so the file does not end up mixed. At the end write the new SHA.
4. There is no header with `Base:` (a map of the old format), the SHA is not found in the history (the branch was rebased) or half of the paths no longer exist — build it anew.

This is the skill's main saving: a second task on the same feature must not re-read the whole repository. In the summary to the user say plainly **which ticket the map was taken from**, what was reused and what was re-read — otherwise, three tasks later on one feature, it will be impossible to tell which of the copies was maintained and which was abandoned.

## Platform contexts (from the config)

A feature can live in one or several contexts — their list and the repositories are in the "Platforms" section of the config. A single repo — one context, study only it. Multi-context (a typical layout): **Desktop + Adaptive** in one repo (often the same pages with responsive layout), **Webview** — a separate repo (talks to the native app through postMessage bridges + a platform cookie). UI components — from the config's `ui_lib` (the `UI*` prefix and the like).

## What to look for (in each repo where the feature exists)

Study directly (Glob/Grep/Read), without fanning out to subagents:

1. **Routes and pages**: the framework routing (`pages/`, `app/`, the routes file) and the per-page components by the config's `page_components`, used by layouts.
2. **Components**: local ones + which `UI*` components from the ui-lib are used.
3. **Data**: the config's `composables` and `stores`, the project's API layer (the one named in `CLAUDE.md`/Conventions — not bare fetch), the `server_api` endpoints.
4. **Feature flags**: the project's flag mechanism (from `CLAUDE.md`/Conventions) — which flags gate the feature.
5. **Webview bridges**: postMessage calls, the platform cookie, native-specific branches.
6. **i18n**: the feature's keys in all locales from the config's `i18n` field.
7. **Differences between platforms/contexts**: where the contexts diverge (v-if by breakpoint, separate components, device detection and the like), what is duplicated between the config's repositories.
8. **History**: `git log --oneline --all --grep=<TICKET>` and by the key files — which tickets touched the feature, whether there are reverts (a sign of a problem zone).

## Output: FEATURE-MAP.md

Save to `<task_dir>/<TICKET>/FEATURE-MAP.md` (create the directory; no ticket — the feature's name in kebab-case). The structure:

```markdown
# Feature map: <name> (<TICKET>)
Date: <date>  Repos: <from the config's Platforms section>
Base: <git rev-parse --short HEAD> (<branch>)   <!-- by this SHA the next task will understand what in the map has gone stale -->

## Orientation
<!-- ≤25 lines. A self-sufficient index: it is used to find the right file without reading the whole map.
     This block is enough for checkers. The duplication with the sections below is deliberate:
     here is the index, there are the details — when you edit a section, fix the line here too. -->

- **Essence:** <2–3 sentences: what the feature is and how it works now>
- **Entry points:** <route → `file:line`>, one line per platform
- **Data:** <store / composable / endpoint — a path for each>
- **Flags:** <flag → what it gates | —>
- **Careful:** <risk zones in one line: reverts, SSR traps, legacy | —>

## Entry points
| Platform | Route/screen | Files |

## Data architecture
stores, composables, API endpoints, flags

## Platform matrix
| Aspect | Desktop | Adaptive | Webview |
(what is shared, what is its own, what is duplicated)

## Webview bridges
(if any)

## Risk zones
reverts in the history, SSR traps, legacy ($http), TODO zones

## Reuse candidates
specific components/composables that the new work must take as is
```

"Orientation" is no longer than 25 lines — that is its point, not a wish. It does not fit — it means details have crept into the header: return them to the sections below and leave at the top the path by which they will be found.

Write only facts from the code with `file:line` references — not assumptions. If the feature does not exist on some platform — write that down, it is a result too.

Always fill in the header with `Base:` — without it the next task will not be able to update the map and will build it anew.

At the end give the user a short summary (5–10 sentences) and the path to FEATURE-MAP.md.
