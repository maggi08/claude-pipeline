# Rollout to a team

For the case "the plugin works for me, the team asks to install it too". For the workflow itself, see the [plugin README](plugins/stage-pipeline/README.md).

## How it works

A marketplace is a **catalog of pointers**, not a code store: a git repository with a `.claude-plugin/marketplace.json` file that lists which plugins exist and where to get each one. The plugin itself can live in another repository and on another host. That is why the catalog lives in the team's GitLab, while the plugin code is here, on public GitHub.

```
GitLab  <group>/claude-code-marketplace        ← the team catalog, ~20 lines, does not change after creation
        .claude-plugin/marketplace.json  ──┐
                                           │ link: git-subdir → plugins/stage-pipeline, ref main
GitHub  maggi08/claude-pipeline  ←──────────┘
        main  ← production: the team gets the plugin and its updates from here
        dev   ← if needed, experiments live here and do not reach main
```

Updates go on two independent levels:

| What is updated | Command | Where it pulls from | When it is needed |
|---|---|---|---|
| The catalog | `claude plugin marketplace update mycar-frontend` | GitLab | only when a plugin was added to the catalog or a pin was changed |
| The plugin itself | `claude plugin update stage-pipeline` | **GitHub, branch `main`** | every time a new version is released |

That is: I push to `main` → a developer runs `plugin update` + restarts Claude Code → it has arrived. **The GitLab repository is not touched.**

The plugin repository is public, so the team needs no credentials, no SSH keys and no `gh auth` — neither for the installation nor for auto-updates.

## Step 1. The catalog in GitLab

A new repository in the team group, for example `<group>/claude-code-marketplace`, visibility internal. The only required file is `.claude-plugin/marketplace.json`:

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "mycar-frontend",
  "description": "Claude Code plugins for the frontend team",
  "owner": { "name": "Frontend" },
  "plugins": [
    {
      "name": "stage-pipeline",
      "description": "A staged maker/checker workflow for large UI tasks: splitting into stages, a spec from the design, checks by subagents (Figma/prototype, runtime, code review, dead code, i18n, dependencies), an autonomous force run, a state journal kept in files and a PR description",
      "category": "workflow",
      "source": {
        "source": "git-subdir",
        "url": "https://github.com/maggi08/claude-pipeline.git",
        "path": "plugins/stage-pipeline",
        "ref": "main"
      }
    }
  ]
}
```

`git-subdir` is needed because the plugin lies in a subfolder of the repository, not in the root: Claude Code makes a sparse clone of that folder only. The catalog `name` defines the plugin id — `stage-pipeline@mycar-frontend`, and it is the one written in the settings of the team repositories.

Check on your own machine before the announcement:

```bash
claude plugin marketplace add https://gitlab.<host>/<group>/claude-code-marketplace.git
claude plugin install stage-pipeline@mycar-frontend
claude plugin details stage-pipeline    # 20 skills, 13 agents, 2 MCP servers
```

Later the catalog can be extended — a second team plugin is added with the same kind of entry.

## Step 2. Connecting developers

**Through the product repository — the main option.** A commit to `<repo>/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "mycar-frontend": {
      "source": {
        "source": "url",
        "url": "https://gitlab.<host>/<group>/claude-code-marketplace.git"
      }
    }
  },
  "enabledPlugins": { "stage-pipeline@mycar-frontend": true }
}
```

A developer clones the repository and answers "I trust this folder" — the catalog is registered and the plugin is marked enabled; if it is not yet installed on the machine, the installation is one command, `claude plugin install stage-pipeline@mycar-frontend`, or `/plugin` in a session. Make sure `.gitignore` does not swallow the file: you need `.claude/*` + `!.claude/settings.json`.

**By hand** — if you roll out to two or three people as a trial: the same two commands as in the check of Step 1. Without `--scope` it goes into `~/.claude/settings.json`, that is, the plugin gets enabled in all repositories of that machine.

**Through the admin console** (Team/Enterprise) — if you need to give the catalog to everyone without editing repositories: managed settings accept the same `extraKnownMarketplaces`; the sources `github`, `url`, `git-subdir` are allowed.

## Step 3. What every developer needs once

| What | Why | Check |
|---|---|---|
| A fresh Claude Code | `git-subdir` and pins need a relatively new CLI | `claude --version` |
| Node 22+ | the `chrome-devtools` MCP is installed through `npx` | `node -v` |
| Figma desktop, **Enable Dev Mode MCP Server** | `figma-spec` / `figma-compare`; in projects on HTML prototypes `proto-spec` / `proto-compare` are used instead | `/pipeline-doctor` |
| The permission profile | otherwise the checkers ask for confirmation at every step | `node "$PERMS" --check` |
| Restart Claude Code after install/update | otherwise the plugin is not picked up | `/plugin` |

Separately, **once per repository**, not per person: `/pipeline-init` generates `.claude/pipeline.config.md` — the stack, commands, dev URL, tokens, breakpoints, code layout. One person makes it and commits it; the others get it together with the code. Personal deviations (paths to neighbouring repositories, ports) go into `pipeline.config.local.md`, which `/pipeline-doctor` creates.

## Step 4. How updates are released

My cycle:

```bash
# a skill edit is checked locally: a marketplace from a folder, no push needed
claude plugin update stage-pipeline && restart

# release
# 1. raise version in plugins/stage-pipeline/.claude-plugin/plugin.json + an entry in CHANGELOG.md
node scripts/validate.mjs
claude plugin validate . --strict
claude plugin tag plugins/stage-pipeline     # tag stage-pipeline--v<version>
git push origin main --tags
```

The team: `claude plugin update stage-pipeline` + restart. What changed and what to do by hand on an upgrade is in [CHANGELOG.md](CHANGELOG.md).

`main` is a moving branch: the team gets everything that lands in it. If a review gate is needed, a tag goes into the catalog entry instead of `"ref": "main"` (`"ref": "stage-pipeline--v0.7.0"`), and then every update becomes an MR in GitLab with a one-line edit. It is simpler to start with `main`; you can switch at any moment.

## human-text and feature-doc

- **Who installs human-text without the pipeline.** Anyone who writes status updates, handoffs or docs for people and does not run the staged workflow. That is the personal channel, with no tag pin: `claude plugin marketplace add maggi08/claude-pipeline`, then `claude plugin install human-text@magzhan`; for the team, add `human-text` to the catalog (next bullet) and install `human-text@mycar-frontend`; the skill is `/human-text:human-text <to whom> <about what>`. It needs no config, MCP or permission profile. Whoever has `stage-pipeline` already has the same skill as `/stage-pipeline:human-text` and needs nothing extra; installing both is harmless, the two commands are separate.
- **The catalog entry for the team.** Next to `stage-pipeline` in the `plugins` array of the GitLab catalog (the catalog itself is not edited here), the pin is a tag of the human-text repo:

  ```json
  {
    "name": "human-text",
    "description": "Rules for writing work text people actually read (status updates, handoffs, docs) and a closed-question check of a draft in a clean context",
    "category": "writing",
    "source": {
      "source": "github",
      "repo": "maggi08/human-text",
      "ref": "v0.1.0"
    }
  }
  ```
  The tag does not exist yet: tag the human-text repo (`v0.1.0` matches its `plugin.json`) before the entry is added.
- **`feature-docs@mycar` (the mycar-frontend catalog).** If a developer has it installed, leave it: `/stage-pipeline:feature-doc` does the same job (a doc on a finished feature in `docs/features/`) and does not replace it. Both are called only by hand, and neither runs on its own, so they do not collide; pick one per repository so the docs do not get two writers.
- **The source of human-text** is the repo `maggi08/human-text`; `stage-pipeline` carries a pinned copy (`human-text.lock.json`). A change in the rules reaches the team in two steps: the human-text repo, then a `stage-pipeline` release with a fresh sync.

## Hooks

The plugin installs seven hooks. They work only in a repository with `.claude/pipeline.config.md` and stay silent elsewhere.

- **session-start** — at the start of a session puts into the context a status line for the task of the current branch and reminds you to shrink a bloated `STAGES.md`. Since 0.21.0, after `/compact` or a resume in an open force run it prints a resume point (stage, uncommitted code vs the maker, reports and their outcome state, blockers, one next action). After a closed force run it names the branch commits that are not in the task journal — work that did not pass the checkers.
- **git-guard** — in normal mode on a task branch the agent's `git add`/`git commit` are rejected at any stage status: the agent hands over a ready commit text, and the developer commits in their own terminal — even if the agent is asked to. In force mode (`/stage-force`) the agent commits itself, but the commit goes through `floor-guard` and is rejected if the diff has a silenced checker, a weakened test or a leftover stub. Only what will go into the commit is checked — saved pages and drafts next to the code do not block the commit. A service signature in the message (`Co-Authored-By`) is rejected.
- **force-guard** — before a Bash command in a force run: a call that would stop on a confirmation (`pkill`/`killall`, subcommands under `ask` in the settings) is rejected at once with an explanation and recorded as a run blocker. Outside force the hook is silent.
- **agent-guard** — the final review of the whole branch goes only on `review_model` (opus by default), and the implementation agent in force starts only after the run interview — no separate "yes" is asked after the answers. Since 0.21.0 it also denies the start of `stage-implement` while the plan has a new `plan-check` problem, and records the tree at the spawn for maker-guard.
- **journal-gate** — after an edit of the task journal returns to the agent a criterion closed without the checker named in it, and a bare PASS without a measurement in a checker report. Old tasks are not checked — only what is written now. Since 0.18.1, when the session's own edit closes a force run as "completed", the hook also closes that session's MCP browser by PID (`browser-cleanup.mjs --session`; another session's browser never); `STAGE_PIPELINE_BROWSER_CLEANUP=off` in the environment turns this off.
- **frames-guard** — when devtools-verify finishes: the agent is not let go until it has opened every frame it captured and closed the pages and browsers it opened.
- **The firing log (0.19.0).** Every block or deny of these hooks also writes a row (rule ID, task, repo, time, tool, read or not) to `firings.jsonl` in the plugin data dir, capped at 1 MB with one older generation; `retro.mjs <repo>` prints it as «Hook firings» for that repo (`--all`: the whole machine). Nothing to roll out: no config, and IDs and paths only.
- **maker-guard** — when `stage-implement` finishes (since 0.21.0): the stop is blocked, up to 3 times, until the hand-back has its sections, fits 4000 characters and names the files that actually changed since the spawn; what the maker handed back is stored for the run digest. With the spawn snapshot of agent-guard it lets git-guard deny a force commit of code the maker did not write (`STAGE_PIPELINE_MAKER_RECEIPTS=off` turns that off). Runs that began before 0.21.0 keep their rules.

The hook recognizes the task by the branch: the line ``Branch: `<branch>` `` in the `STAGES.md` header, and without it the ticket (the name of the task directory) in the branch name. A task spanning two repositories, whose `STAGES.md` lies in the task directory of the neighbouring one, is seen by the hook when the ticket is in the branch name and `STAGES.md` names the repository. It does not see the tasks of other branches, so parallel tasks, worktrees, sessions and neighbouring repositories do not get in each other's way, and old tasks block nothing — there is no need to rewrite them for a new version. A task whose `STAGES.md` has not changed for 21 days the hook considers abandoned and does not see; if you come back to it, the first kickoff or check updates the file and the guard turns on again.

The agent's commits on a task branch are rejected at any stage status — this is the rule of normal mode: you commit yourself. A really abandoned task the hook stops seeing after 21 days without edits to its `STAGES.md`. The agent commits itself where it should not when a force run is not closed: the word "completed" in the block heading (`## Force run 2026-09-24 — completed 2026-09-25`) or in the status line ("force run completed").

## What to know before the rollout

- **Weak machines.** With RAM ≤ 16 GB the heavy checks (`lint`/`test`/`type_check`/`build`) of all the machine's projects go one after another and at a lowered priority: 3–4 parallel projects do not go into swap, but a check may wait for a neighbouring one ("waiting in the queue"). For a strong machine — `- resources: normal` in `pipeline.config.local.md`.
- **A public personal GitHub becomes a dependency of the team's dev machines.** If the account or the repository disappears, installation and updates break for the team. It is cured by changing `url` in one line of the catalog (for example, to a GitLab mirror), but it is better to decide in advance whether this is acceptable.
- **Availability of github.com from the corporate network** is the only thing worth checking by hand before the announcement.
- **The permission profile is broad.** `permissions/base.json` allows `node`/`npx`/`python3`, that is, arbitrary execution; its `deny` list protects against an accidental agent command and is not a security boundary. For whom it does not fit — `node "$PERMS" --minimal --apply`: only skills and MCP.
- **There are no secrets in the plugin.** `.mcp.json` has only two local servers: `127.0.0.1:3845` for Figma and `npx chrome-devtools-mcp`.
- **Little leaves the machine.** Library APIs are checked against the installed package in `node_modules` — locally. Only `npm view <pkg>` to the registry goes to the network (`deps-audit`: whether the added version is deprecated) and, if the installed package was not enough, a WebFetch of the official documentation on the domains from the permission profile — the request carries the package name and version, the repository code is not sent.
- **The plugin does not push and does not create an MR.** `git push`, `gh pr create`, `glab mr create` and commenting on existing MRs are strictly forbidden in the skills, including the autonomous `/stage-force`; `/task-wrapup` only prepares the description text in `PR.md`.
- **State is files in the repository** (`STAGES.md`, `FEATURE-MAP.md`, `PR.md` in the `task_dir` from the config). The team has to decide whether to commit them or ignore them; committing is more convenient — it is the task journal for the reviewer.
- **The language of the skills is English**: the plugin is written in English. The language of a task is the `Language:` line in its `STAGES.md` (a new task — by the user's request, else by `language:` in the config, else by the language of the starting message); only `ru` and `en` are supported; Russian tasks keep going in Russian, the model talks to the user in the user's language, and commits and PR descriptions follow the language of the repo history (or the user's request), not the task language. See `references/language.md` in the plugin.

## Checklist

- [ ] A catalog repository is created in GitLab, with `.claude-plugin/marketplace.json` from Step 1 in it
- [ ] The installation from scratch is checked on one machine (`marketplace add` → `install` → `details`)
- [ ] The pilot product repository has `.claude/settings.json` with the catalog and `enabledPlugins`
- [ ] The pilot repository has `.claude/pipeline.config.md` from `/pipeline-init`
- [ ] One developer went through the onboarding of Step 3 from scratch, `/pipeline-doctor` is green
- [ ] The README of the plugin, this file and CHANGELOG are sent to the team
- [ ] Whoever writes for people without the pipeline knows about `human-text@magzhan`; whoever has `feature-docs@mycar` knows `/stage-pipeline:feature-doc` is the same job, by hand
