# claude-pipeline

A personal Claude Code marketplace: plugins I connect to my own projects.

## Plugins

| Plugin | What it does |
|---|---|
| [`stage-pipeline`](plugins/stage-pipeline/README.md) | A staged maker/checker workflow for large UI tasks: splitting into stages, a spec from the design, checks by subagents (Figma/prototype, runtime, code review), a state journal kept in files |
| [`human-text`](https://github.com/maggi08/human-text) | Rules for writing work text people actually read (status updates, handoffs, docs) and a closed-question check of a draft in a clean context. A copy also ships inside `stage-pipeline` |

## Installation

The repository is public, so it installs on any machine without access rights and without cloning:

```bash
claude plugin marketplace add maggi08/claude-pipeline
claude plugin install stage-pipeline@magzhan
```

The same through settings, if you do not want to install by hand:

```json
{
  "extraKnownMarketplaces": {
    "magzhan": { "source": { "source": "github", "repo": "maggi08/claude-pipeline" } }
  },
  "enabledPlugins": { "stage-pipeline@magzhan": true }
}
```

This is `~/.claude/settings.json` — the plugin is enabled in all repositories. If you need it in one repository only, use the same commands with `--scope project`; they end up in `<repo>/.claude/settings.json`. In that case make sure `.gitignore` does not swallow the whole `.claude/`: use `.claude/*` + `!.claude/settings.json`.

`human-text` installs on its own, without the pipeline: `claude plugin install human-text@magzhan` (run it as `/human-text:human-text <to whom> <about what>`). Inside `stage-pipeline` the same skill is `/stage-pipeline:human-text`, next to the manual `/stage-pipeline:feature-doc` (a doc on a finished feature) and `/task-wrapup`, which writes the PR description by the same rules.

Update: `claude plugin update stage-pipeline` (pulls the fresh `main`). After an install or an update, restart Claude Code. What changed between versions and what to do by hand on an upgrade is in [CHANGELOG.md](CHANGELOG.md).

**Branches.** `main` is production: everyone installs and updates the plugin from it, so only checked changes with a raised version go into it. Experiments live locally (a marketplace from a folder — below) or in a separate `dev` branch; there is no separate "stable" branch and none is needed.

Rollout to a team is a catalog in GitLab that points to this repository: [ROLLOUT.md](ROLLOUT.md).

Check that it arrived: `claude plugin details stage-pipeline` — it must show 21 skills, 15 agents, 2 MCP servers. Then `/pipeline-doctor` in the target repository checks the environment (MCP, dev server, baseline).

### Development mode — a marketplace from a local clone

On the machine where the plugin is edited, it is easier to read the marketplace straight from the folder: edit a skill → `claude plugin update stage-pipeline` → the change has arrived, pushing is not required.

```bash
git clone https://github.com/maggi08/claude-pipeline.git
cd claude-pipeline
claude plugin marketplace add "$PWD"
claude plugin install stage-pipeline@magzhan
```

`settings.json` gets `source: directory` with an absolute path — that is, a binding to this machine. It is fine for the development machine and not for the others: install from GitHub there. To switch an installed marketplace from one source to another: `claude plugin marketplace remove magzhan`, then `add` with the source you need.

## Development

```
.claude-plugin/marketplace.json   catalog: which plugins this repository serves
plugins/<name>/
  .claude-plugin/plugin.json      plugin manifest (name, version, description)
  skills/<name>/SKILL.md          skills (called as /<name>)
  skills/<name>/references/       rule precedents — for whoever changes a rule, not read during a run; the exception is `human-text/references/rules.md`, which task-wrapup, stage-force and feature-doc read while they work
  agents/<name>.md                checker subagents
  hooks/hooks.json                plugin hooks (seven: session-start, git-guard, force-guard, agent-guard, journal-gate, frames-guard, maker-guard)
  scripts/                        permissions / archive-stages / retro / verify-map and the hook scripts
  .mcp.json                       MCP servers that come with the plugin
  README.md                       plugin documentation
evals/cases/<name>/               synthetic projects with planted problems for scripts/eval.mjs (case.json, base/, stages/, working/, stubs/)
evals/ledger.tsv                  one row per eval run: version, SHA, models, hits, cost (local, gitignored)
```

Rules:

- **No project specifics in skills.** The plugin is enabled in all repositories; the rules of a given project live in its `CLAUDE.md` or `.claude/pipeline.config.md → Conventions`. Verified in practice: one project's rubric in a global skill produced false Majors in another.
- **Paths inside the plugin go through `${CLAUDE_PLUGIN_ROOT}`**, not through `~/.claude/`. Otherwise the skill→agent cross-references lead nowhere as soon as the plugin moves.
- **No secrets in `.mcp.json`** — only local or public endpoints; an external endpoint must be described in ROLLOUT.md (the validator checks this).
- **A precedent goes into `references/precedents.md`, the rule goes into `SKILL.md` as one line.** The budget is 30 KB per skill; the validator enforces it.
- **Product names** from your own projects: list them in a local `.product-denylist` (in `.gitignore`) — the validator keeps them out of the skills. Ticket ids are caught without it.

Workflow: a `dev` branch (or a feature branch) → a PR into `main`. `main` is production; direct pushes into it bypass the release check.

Before a PR:

```bash
node scripts/validate.mjs                         # structure, links, budgets, CHANGELOG
node scripts/release-check.mjs origin/main        # plugin changed → version raised and a CHANGELOG section exists
claude plugin validate . --strict
claude plugin validate ./plugins/stage-pipeline --strict
node scripts/eval.mjs --lint                      # free: builds every eval case and runs the leak lint (validate.mjs runs it too)
node scripts/eval.mjs                             # if agents changed: real runs, three per case, $0.1–0.5 per run
node scripts/eval.mjs --record-release              # free: the latest run of every agent case at this version → evals/releases.tsv (committed; release-check reads it)
```

**The eval gate.** When a PR changes `agents/<a>.md` or the checker skill `skills/<a>/`, `release-check.mjs` wants, for every case whose `case.json` names that agent, a row at the version in `evals/releases.tsv`, or a line `eval: skipped — <reason>` (or `eval: skipped <a>, <b> — <reason>` for named agents) — a row counts when its `agent_tree` (the blob of the agent file plus the tree of its skill dir) equals HEAD's, the run was not on a dirty tree and passed at least once; a rebase that keeps the agent's bytes keeps the row, a later edit of the agent makes it stale, and the commit ancestry is checked only when `--record-release` writes the row. The reason of a skip line must be a real one (the literal `<reason>` is rejected) in the CHANGELOG section of the version; an agent with no case needs the skip line. Run the cases (`node scripts/eval.mjs <cases>`), then `--record-release`. `node scripts/eval.mjs --effort <agent>=<level>` measures an `effort:` line, `evals/models.json` plus the drift warning watch the model an agent resolves to, and `node scripts/hillclimb.mjs --agent pro-review --max-cost-usd <x>` lets an opus editor tune an agent's references on its cases in a temp worktree (never in this checkout; `--dry-run` and `--self-test` are free). After `--resume` the failure counts of both splits come back from the invocation ids in `decision.tsv` (`train_invocations`, `holdout_invocations`), so an edit that adds a run failing a grader outside the metric is rejected with or without a resume; `--resume` of a log written before the `holdout_invocations` column is refused (start a new run; the old log stays as it is). The editor runs with `--restricted` (its file tools stay inside the temp worktree, the auto-memory exemption of the working-directory blocks is closed) and with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Checked live once (Claude Code 2.1.314, one haiku call built by the driver's own `editorArgs` and spawn env, cwd a temp worktree): asked to read and write a file in this repository's auto-memory folder, the editor was refused both times and the folder's file list and hashes did not change (VT-13, `AC-2.3`). Paid climbs (VT-13): `hc-vt13-1` is void (its N2 grader inflated the baseline and it stopped `stopped-no-headroom` without an editor call). `hc-vt13-2` (honest graders, 4 train cases incl. the pending `pro-review-ac-demands-role-overwrite` and `-sequential-link`, 3 holdout, 3 runs each, opus editor): baseline train 0.792, holdout 1.000, $3.04. Attempt 1 (a rule in the body of `agents/pro-review.md`: an AC that itself demands an unsafe design is reported critical/major with the AC named as the source) lifted train to 1.000, but a harness `W-` in `pro-review-parity-split-refund` run 3 left the holdout unmeasured and the run stopped `stopped-eval-failed`; attempt 2 (the same idea in `skills/pro-review/references/lenses.md`) did not move train (0.792, `rejected-train`); attempt 3 (a finding-line rule in the agent body) again lifted train to 1.000 and again stopped `stopped-eval-failed` because only 2 of 3 holdout runs of `parity-split-refund` were graded (the third skipped by the budget although the cap had about $0.74 left: the driver counted the cases running in parallel twice, fixed in this task). No edit was kept, the branch was deleted; spend $10.86 of the $11.6 cap. Not checked live: a climb that keeps an edit and a release record of a climbed agent; the train lift of both agent-body edits was never holdout-measured. The free tests of all of this run in `validate.mjs`.

**The delta review (0.24.0).** A force run's fix round after the final checks is re-reviewed by `pro-review --delta <full report>` (the change since the full whole-branch review, up to 400 changed lines) instead of a second whole-branch review; the hook counts it only on top of a full report that records its commit. What it replaces and what it does not check: CHANGELOG 0.24.0.

Comparing models on the same cases: `node scripts/eval.mjs --model i18n-sweep=haiku i18n-hardcode` — a copy of the plugin with the agent's `model:` rewritten; the summary shows the pass rate, the real model from `modelUsage` and the cost of the run.

The harness is blind and runs the production plugin: every case is dressed as a project of its own (repo name, ticket, git author and commits from `identity` in `case.json`), a leak lint aborts a case before any model call when its tree, prompt, paths or git history contain a word that gives the test away, MCP tools carry their production names, permissions come from `permissions/base.json`, and an agent case runs as a real subagent under a thin haiku parent session so the subagent hooks fire. Graders are deterministic: regexps, finding lines in the ledger form (severity and `file:line` on one line, a negated mention does not count), and traces over the subagent's tool calls. Every run appends a row to `evals/ledger.tsv`; `--budget-usd` keeps a lane inside its money; `--ref <tag>` and `--ablate <skill>` run a case against an older or reduced plugin, and a case added later carries `provenFailing`, its recorded failure there (`--record-failing`). The header of `scripts/eval.mjs` lists every grader.

GitHub Actions runs `validate.mjs` on push and PR, `release-check.mjs` on a PR into `main`, and on a push to `main` it creates the tag `stage-pipeline--v<version>` if it does not exist (`.github/workflows/validate.yml`). `claude plugin validate` and `eval.mjs` do not run in CI: the first needs the CLI, the second needs model calls.

Releasing a version: raise `version` in `plugin.json` + add a section to `CHANGELOG.md` → a PR into `main` → CI creates the tag. Commit messages: `feat:` / `fix:` / `docs:` in lowercase, describing the substance of the change.

Vendored human-text: `plugins/stage-pipeline/skills/human-text/`, `agents/human-text-check.md` and `human-text.lock.json` are a copy of the repo `maggi08/human-text`, which is the source of truth. Edit the rules there, then run `node scripts/sync-human-text.mjs [path-to-human-text | git-ref]` here; `validate.mjs` fails on a hand edit of the copy.

Retro over real tasks: `node plugins/stage-pipeline/scripts/retro.mjs ~/programming/<repo>` — the share of false findings, fix-loop rounds, skips per checker, bloated STAGES.md files. `retro.mjs <repo> --findings` lists the repeated findings with their outcomes; `/promote` turns each repeat into a rule it has proven on two pre-fix versions, and asks before writing anything (plugin README, "Repo rules and /promote").
