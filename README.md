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

Check that it arrived: `claude plugin details stage-pipeline` — it must show 20 skills, 13 agents, 2 MCP servers. Then `/pipeline-doctor` in the target repository checks the environment (MCP, dev server, baseline).

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
  hooks/hooks.json                plugin hooks (six: session-start, git-guard, force-guard, agent-guard, journal-gate, frames-guard)
  scripts/                        permissions / archive-stages / retro and the hook scripts
  .mcp.json                       MCP servers that come with the plugin
  README.md                       plugin documentation
evals/cases/<name>/               fixtures with planted defects for scripts/eval.mjs
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
node scripts/eval.mjs                             # if agents changed: real runs, $0.1–0.3 per case
```

Comparing models on the same cases: `node scripts/eval.mjs --runs 3 --model i18n-sweep=haiku i18n-hardcode` — a copy of the plugin with the agent's `model:` rewritten; the summary shows the pass rate, the real model from `modelUsage` and the cost of the run.

GitHub Actions runs `validate.mjs` on push and PR, `release-check.mjs` on a PR into `main`, and on a push to `main` it creates the tag `stage-pipeline--v<version>` if it does not exist (`.github/workflows/validate.yml`). `claude plugin validate` and `eval.mjs` do not run in CI: the first needs the CLI, the second needs model calls.

Releasing a version: raise `version` in `plugin.json` + add a section to `CHANGELOG.md` → a PR into `main` → CI creates the tag. Commit messages: `feat:` / `fix:` / `docs:` in lowercase, describing the substance of the change.

Vendored human-text: `plugins/stage-pipeline/skills/human-text/`, `agents/human-text-check.md` and `human-text.lock.json` are a copy of the repo `maggi08/human-text`, which is the source of truth. Edit the rules there, then run `node scripts/sync-human-text.mjs [path-to-human-text | git-ref]` here; `validate.mjs` fails on a hand edit of the copy.

Retro over real tasks: `node plugins/stage-pipeline/scripts/retro.mjs ~/programming/<repo>` — the share of false findings, fix-loop rounds, skips per checker, bloated STAGES.md files.
