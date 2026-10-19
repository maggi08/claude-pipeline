# Stage Pipeline · cheatsheet

A staged maker/checker workflow for Claude Code. Plugin `stage-pipeline@magzhan`, v0.16.1 — 18 skills, 12 agents.

---

## Installation (once per machine)

```bash
claude plugin marketplace add maggi08/claude-pipeline
claude plugin install stage-pipeline@magzhan
# restart Claude Code
claude plugin details stage-pipeline   # check: 18 skills, 12 agents, 2 MCP
```

The repository is public — no access rights and no cloning needed.

Update: `claude plugin update stage-pipeline` + restart.

**Permissions** — otherwise every checker at every stage asks for confirmation. `/pipeline-init` offers to
lay the profile itself; by hand: `node ${CLAUDE_PLUGIN_ROOT}/scripts/permissions.mjs` (report) →
`--apply` (write to `~/.claude/settings.json`, with a backup). `/pipeline-doctor` checks it through `--check`.
If you do not need a broad Bash allowlist, `--minimal` allows only skills and MCP.

## Once per repository

```
/pipeline-doctor    environment check: MCP, neighbouring repos, dev server, type-check baseline
/pipeline-init      generates .claude/pipeline.config.md — the project profile for all skills
```

---

## Work loop

**Per task**

```
/feature-checker <ticket>   → FEATURE-MAP.md   how the feature works now, what to reuse
/stage-plan                → STAGES.md        split into stages + WHEN/THEN acceptance criteria
```

**Per stage**

```
/stage-kickoff     stage plan, accumulated questions, business input, sign-off → screen spec
   … implementation …
/stage-check       checkers → fix-loop ≤2 → journal in STAGES.md → commit text
/clear             the state is already in files
```

**Autonomous**

```
/stage-force       all questions in one batch at the start, then no stops
                   always forbidden: git push, creating a PR, deploy
                   asks nothing mid-run: decides the reversible itself, parks an
                   irreversible fork, an exhausted fix-loop and a conflict of sources
                   as a blocker and finishes the rest — all in the summary at the end
```

**Hooks** look only at the task of the current branch: in normal mode the agent's `git add`/`commit` are rejected — you commit from its text; an auto-commit happens only in `/stage-force`, through `floor-guard`. A whole-branch review runs only on `review_model`, the maker in force starts only after the line `Confirmed:`, and a criterion in the journal is closed by the checker named in its tag.

**Before an MR**

```
/pro-review        the whole branch against main
/ds-parity         duplicates with the design system: what to replace with the kit, what to move INTO the kit
/dead-code         what the task orphaned
/task-converge     the code on HEAD against the intent of the task: what was promised
                   and not done, and what was done but not asked for. Findings → a "Catch-up"
                   block in STAGES.md, run until it converges
/task-wrapup       → PR.md: what and why, how to verify, blind spots, open questions
                   (manual only — never starts on its own, even in force)
```

---

## Skills

| Command | What it does |
|---|---|
| `/pipeline-init` | studies the repo → `pipeline.config.md`, which all the others read; manual only |
| `/pipeline-doctor` | environment diagnostics: MCP, neighbouring repos, dev server, baseline |
| `/feature-checker` | a map of the existing feature across all platforms → `FEATURE-MAP.md` |
| `/stage-plan` | cuts the task into stages (screen + states = stage) → `STAGES.md` |
| `/stage-kickoff` | opens a stage: plan + decisions + sign-off before code |
| `/stage-check` | closes a stage: checkers, fix-loop, journal, commit |
| `/stage-force` | an autonomous run of the whole task |
| `/pro-review` | senior review, the whole branch by default |
| `/figma-compare`, `/proto-compare` | checks code against a mockup or an HTML prototype |
| `/devtools-verify` | runtime check in the browser |
| `/root-cause` | debugging to the cause: a fix did not work, a symptom with no explanation |
| `/dead-code`, `/i18n-sweep`, `/deps-audit` | narrow passes: junk from the task, i18n, dependencies |
| `/ds-parity` | parity with the design system before a PR |
| `/task-converge` | the code on HEAD against the intent of the whole task: an uncovered criterion, a silently widened scope |
| `/task-wrapup` | an MR description from the task journal → `PR.md`; manual only |

## Agents

The orchestrator launches them itself; each works in its own clean context, and the checkers write a report to `checks/`.

| Agent | What it does | When |
|---|---|---|
| `stage-implement` | maker: implementation of a stage or of a fix-loop fix round in a clean context (sonnet), a summary comes back | in `/stage-force` |
| `figma-spec` | a compact screen spec from Figma | before code |
| `proto-spec` | the same from an HTML prototype + SPEC.md | before code |
| `docs-lookup` | a library API from the installed package (types, CHANGELOG) for the version from the lockfile — instead of the model's memory | unsure about an API |
| `figma-compare` | pixel-perfect comparison: colors, spacing, radii, shadows, typography | after code |
| `proto-compare` | the same against a prototype + behavior per SPEC.md | after code |
| `devtools-verify` | console and hydration, light/dark, widths, live state | after code |
| `pro-review` | correctness, conventions, duplicates, naming + an adversarial recheck | always |
| `dead-code` | what the diff orphaned: symbols, files, locale keys, assets | something was removed |
| `i18n-sweep` | hardcoded text, incomplete locales, concatenated keys, formatting without a locale | text appeared |
| `deps-audit` | new dependencies and assets: justification, an equivalent in the repo, weight | the manifest was touched |
| `task-converge` | the only one that does not look into the diff: `missing` / `partial` / `contradicts` / `unrequested` | before a PR |

No trigger → `[skip: no trigger]`, no subagent is spent.

**Acceptance criteria are numbered.** `AC-<stage>.<n>` + a tag of whoever is able to check
(`[verify: figma-compare]`, `[verify: devtools-verify]`, `[verify: pro-review]`,
`[verify: user-review]`, `[live: user-side]`). Checker reports refer to the ID and do not
retell the criterion; a stage is not closed with a criterion without an outcome; `TEST-PLAN.md`
is assembled by ID mechanically. A criterion with nothing to check it is a defect of the plan,
and it is caught at kickoff, not after the PR.

---

## Files

```
<repo>/.claude/
  pipeline.config.md        project profile: paths, commands, dev URL, breakpoints, baseline
  tasks/<TICKET>/            (in .gitignore — personal working memory)
    FEATURE-MAP.md          what already exists in the code
    STAGES.md               plan, decisions, stage journal
    specs/                  screen spec from the design
    checks/                 checker reports
    DESIGN-QUESTIONS.md     questions for the designer — close in a batch
    PR.md                   MR description
```

---

## Rules that save time

- 1 screen + all its states = 1 stage.
- Do not start implementation without a sign-off at kickoff — otherwise edits arrive in the middle.
- Do not close a stage with a critical finding or a `Request changes` verdict.
- Fix-loop: 2 orchestrator iterations + a third run by a fresh checker subagent. If it does not converge there either, it is a discrepancy in the requirements, and we take it to a person.
- An idea off the stage topic goes into the journal TODO, not into the current diff.
- Accumulate questions for the designer in `DESIGN-QUESTIONS.md` and close them in a batch.
- After a stage commit — `/clear`, not `/compact`: the state is already in files.
- Project review rules go into `CLAUDE.md` / `pipeline.config.md`, **not** into a plugin skill: the plugin is read in all repositories, and someone else's rubric produces false Majors.
- A commit message describes the substance of the change, not "stage N"; no service signatures about the tool's authorship.

## If the checkers do not work

- `/pipeline-doctor` — first of all.
- Figma MCP: "✓ Connected" does not yet mean the tools are available. You need **the right file open** in desktop Figma and **a session restart** (tool schemas are fixed at start).
- `devtools-verify`: a live dev server is needed; `yarn build` while `yarn dev` runs kills it; with Vite the esbuild worker dies — then any page returns 500 until a restart.
- Check dependencies **by the manifest or the symlink**: a neighbouring ui-lib checkout ≠ the installed package.
- The type-check baseline drifts — measure on `git stash` and do not trust what is recorded in the config.
