---
name: pipeline-init
description: Initialize the stage pipeline in a new repository — study the project (stack, commands, dev server, design tokens, UI lib, breakpoints, code layout) and generate `.claude/pipeline.config.md`, which all pipeline skills and agents read (feature-checker, stage-plan, stage-kickoff, stage-check, figma-spec, figma-compare, devtools-verify, pro-review), plus lay out the pipeline permissions (skills, MCP, safe commands, deny/ask) in the user-scope `~/.claude/settings.json` so checkers do not ask for confirmation at every step. Run ONCE per new project before the pipeline, or when the stack/commands/paths changed. Manual only, via /pipeline-init — it writes the config and user-scope settings, so the model never invokes it. Makes the pipeline project-agnostic. RU triggers — «настрой пайплайн в репо»
disable-model-invocation: true
---

# Pipeline Init — the pipeline config for a specific repository

The goal: the pipeline skills are generic and know nothing about a concrete project. Everything project-specific (paths, commands, sources of truth) they read from `<repo>/.claude/pipeline.config.md`. This command studies the repository and **generates that config**, so that the pipeline works in the new project's context.

Run it once per project (or when the stack, commands or paths change).

## Procedure

Study the repository directly (Read/Glob/Grep), without fanning out to subagents:

1. **Stack and package manager** — `package.json` (deps: nuxt/vue/react/next/svelte/…; `packageManager`), the lock file (`yarn.lock`→yarn, `pnpm-lock.yaml`→pnpm, `package-lock.json`→npm).
2. **Commands** — the `dev`/`build`/`lint`/`type-check` (or `typecheck`)/`test` scripts from `package.json`; `bundle_size` — a `size`/`size-limit`/`bundlesize`/`bundle-size` script in the same place, none — `—`. Plus the per-stage-files commands with `{files}` (`run-check.mjs` substitutes them, `${CLAUDE_PLUGIN_ROOT}/references/heavy-checks.md`): `lint_files` — the linter from devDependencies directly (`<pm> eslint {files}`, `<pm> biome check {files}`, `ruff check {files}`), `test_related` — `<pm> vitest related --run {files}` / `<pm> jest --findRelatedTests {files}`; run it on one file and record the form that works, if it does not start — `—`. If there is a type-check, offer to run it once and record the **baseline** error count (projects often carry legacy debt; checkers compare against the baseline, not against zero). Two mandatory sanity checks:
   - **Monorepo: does type_check really cover every workspace?** Scripts with a topological order (`yarn workspaces foreach -t`, turbo/nx) SILENTLY skip dependent packages when their dependency fails. The check: a direct `tsc -p <app>/tsconfig.json --noEmit` of the main app vs the output of the shared script; a suspiciously fast run (~seconds for a large app) is a sign of skipping. Record the DIRECT per-workspace command in the config, not only the shared script (lesson: one of the monorepo's apps was type-checked neither locally nor in CI — a broken commit lived unnoticed).
   - **Baseline sanity.** Do not accept a non-zero baseline silently — read the errors themselves. "Module X does not export Y" about local packages (a `file:` tarball, a workspace ui-lib) is more often a stale install than legacy debt: check freshness (the tgz date, the version vs the sources of the neighboring repo) and offer a reinstall BEFORE fixing the baseline (lesson: "baseline 16+3" was counted as the team's debt for a day, and turned out to be a stale tgz of the UI kit).
3. **Static analyzers** — whether the repo has a deterministic tool that finds what checkers would otherwise look for with grep: `knip`, `ts-prune`, `unimported`, `depcheck`, `madge`. Look in devDependencies, in scripts and in configs (`knip.json`, `.knip.*`, `.depcheckrc`, `.madgerc`). If you find one, run it once and record the EXACT working command in the config; if it does not run or is noisy across the whole repository, note that right in the config. **Do not suggest a new dependency for the sake of a checker** — that is the repo owner's decision; a one-off `npx` run may be suggested, but write into the config only what really works in this repo. Nothing there — put `—`: `dead-code` and `deps-audit` then work by grep, as before.
4. **Dev server** — from the `dev` script + framework defaults (Nuxt 3000, Vite 5173, Next 3000) + HTTPS signs (`ssl/`, `https:setup`, mkcert) → assemble the URL (protocol+host+port).
5. **Design sources of truth** (for figma-compare/spec): tokens/theme (`glob` over `**/theme/*`, `tokens*`, `design-tokens*`, `tailwind.config.*`), the UI library (deps like `@*/ui*`, the component prefix), breakpoints (from `tailwind.config`), icons (the folder + the auto-import convention), i18n (`locales/`, the i18n config, the translation helper).
6. **Code layout** (for the dedup audit/feature-checker): `components/`, `composables/`|`hooks/`, `page-components/`, `store/`|`stores/`, `server/api/`, tests. Note the "reuse baseline" (an existing implementation to match a redesign against), if the user named one.
7. **Platforms/related repos** (optional): one repo or multi-context (desktop/adaptive/webview, neighboring repositories).
8. **MCP dependencies — check.** The pipeline needs the Figma MCP for `figma-compare`/`figma-spec` and the Chrome DevTools MCP for `devtools-verify`. Both come in the plugin's `.mcp.json`, so connecting them by hand is usually not needed — `claude mcp list` is enough (expect "✓ Connected"), and approve the plugin's servers if Claude Code asks for confirmation.
   - `figma` does not connect — it is a local desktop-Figma server: the app must be running, Dev Mode MCP Server enabled (Figma → Preferences). Port check: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3845/mcp`.
   - `chrome-devtools` starts by itself via `npx` on the first call; it needs Node ≥ 18 and an installed Chrome.
   Do not stay silent about what needs the user's action. A project without Figma/UI redesign does not need `figma` and `chrome-devtools` — do not spend effort setting them up.

9. **Permissions — otherwise the pipeline asks for confirmation at every step.** The permissions profile lives in the plugin (`permissions/base.json`) and is poured into settings by a script; it generates the `Skill(stage-pipeline:*)` and `mcp__*` entries from the plugin itself, so a new skill does not have to be added by hand.

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/permissions.mjs           # report: what is missing (writes nothing)
   node ${CLAUDE_PLUGIN_ROOT}/scripts/permissions.mjs --apply   # append to ~/.claude/settings.json
   ```

   The order is strict: first the run without flags, **show the user the list of what will be added and apply only with their consent** — this edits their personal settings, not a file in the repo. The script only adds: it does not touch other people's entries, does not put an `allow` over `deny`/`ask` already in place (it reports a conflict), and puts a backup next to the file before writing.

   - **User scope (the default) is the right place.** The plugin is enabled in all repositories; permissions put into `<repo>/.claude/settings.local.json` would have to be set up again in every new project.
   - **Groups**: `pipeline` (skills + MCP), `fs-read`, `shell-tools`, `fs-write`, `vcs`, `js-toolchain`, `devserver` — by default; `docker`, `web` — via `--groups`. A user who does not want a broad Bash allowlist: `--minimal` gives only `pipeline`, the rest will keep asking. `shell-tools` (`sed`, `awk`, `find`, `xargs`) is split out of `fs-read` precisely because it is not reading: `sed -i` writes a file, `find -exec` and `xargs` run an arbitrary command — without it the set is honestly read-only.
   - **Project-specific goes into the project scope, not into the shared profile**: neighboring repos and the plugin repo (`--scope project --dirs ../ui-lib,../prototypes`, they land in `additionalDirectories`) and this repo's non-standard commands (`Bash(../../node_modules/.bin/tsc *)` in a monorepo) — add them by hand to `<repo>/.claude/settings.local.json`.
   - **`deny`/`ask` are part of the profile, not an add-on.** `git push`, `reset --hard`, `git clean`, `gh`, `pkill` and reading `.env` stay a question; force-push, package publishing, deploy, `ssh`/`scp`/`rsync` and reading `~/.ssh`, `~/.aws`, credentials are forbidden. `/stage-force` stands on these bans: without them an autonomous run gets the right to publish.
   - **Say out loud what this `deny` is NOT.** The profile allows `node`, `npx`, `python3` — that is, arbitrary code execution, and bypassing any ban on the list is trivial. Here `deny` protects against an accidental agent command, not a malicious one; a user who needs a real boundary needs a sandbox, not an allowlist. Promising more than the profile gives is worse than not setting it up at all.
   - **`Bash(...)` is a prefix match, the space before `*` is literal.** `Bash(rm -rf dist *)` does not cover `rm -rf dist` (no argument after it), but it does cover `rm -rf dist /someone/elses/path`; `Bash(curl -s http://localhost *)` does not cover `curl -s http://localhost:3000/`. When adding project entries by hand, check the form on a real command, not by eye.
   - Permissions are read at session start — after `--apply` tell the user to restart Claude Code, otherwise they will decide it did not work.

## Output: `.claude/pipeline.config.md`

Create `<repo>/.claude/pipeline.config.md` from the template below. Fill in what you found; mark uncertain values with `# TODO: confirm`. `slug` = the name of the repo's root folder.

**The "repo-local" layout (the default):** everything tied to tasks and project memory lives IN THE REPO, under `<repo>/.claude/` — this way the metadata sits next to the code, is shared by ticket and (if needed) travels in git/to the team. The skills and agents themselves are not copied into the repo — they come with the `stage-pipeline` plugin and work in all repos.
- `task_path` defaults to `<repo>/.claude/tasks/` — STAGES.md/specs/checks/DESIGN-QUESTIONS by ticket.
- `memory_path` defaults to `<repo>/.claude/memory/` — project memory (decisions/pitfalls/agreements of this repo). ⚠ This is NOT the harness auto-memory `~/.claude/projects/...` (that one is at a system path, is recalled automatically and stays for cross-repo user preferences) — the pipeline reads the repo-local memory explicitly at the start of a task.
- Checker screenshots are heavy — add `<repo>/.claude/tasks/**/checks/screens/` to `.gitignore` if tasks are committed.

```markdown
# Pipeline config — <project>
<!-- Read by the pipeline skills. Edit by hand when the project changes. -->

## Project
- slug: <repo-basename>
- stack: <e.g. Nuxt 4 / Vue 3 / Pinia / TS>
- package_manager: <yarn 1.x | npm | pnpm>
- main_branch: <dev | main | master>   # the branch the PR is opened INTO (if PRs go to dev — dev, not main); the merge-base for whole-branch pro-review, dead-code, wrapup
- language: <ru | en>   # optional: the default language of new tasks (the task files are written in it); leave out — the language of the message that starts the task decides. Unknown — delete the line, do not leave the placeholder. Rules: ${CLAUDE_PLUGIN_ROOT}/references/language.md

## Task state
- task_path: .claude/tasks/     # in the repo: STAGES.md / specs/ / checks/ / DESIGN-QUESTIONS.md by ticket
- memory_path: .claude/memory/  # in the repo: project memory (decisions/pitfalls of this repo)

## Commands
- dev: <yarn dev>
- build: <yarn build>
- lint: <yarn lint>
- type_check: <a direct per-workspace command, e.g. cd apps/x && ../../node_modules/.bin/tsc -p tsconfig.json --noEmit>  # baseline: <N | not measured>; the shared monorepo script may silently skip workspaces (see the procedure, item 2)
- test: <yarn test>
- lint_files: <yarn eslint {files} | —>        # lint by the stage's files (run-check.mjs substitutes the changed ones); — → `lint` on the whole stage
- test_related: <yarn vitest related --run {files} | yarn jest --findRelatedTests {files} | —>  # tests related to the stage's files
- bundle_size: <a command that prints the bundle size, e.g. `yarn build && du -sk dist` or `size-limit` | —>  # set → stage-plan adds metrics-baseline/metrics-guard; — → no such items
- e2e: <`yarn e2e:test` | —>   # a CI gate if there is no "CI gates" table below; likewise `smoke:`

## CI gates (optional — what CI runs on a PR and must not be broken)
<!-- The final checks run every command on HEAD (`ci-gates.mjs --run`), and force is not closed as "completed"
     until they are green. The list comes from the CI jobs on a pull request; deploy, publishing and steps with secrets are not gates. -->
| Check | Command | What it catches |
|---|---|---|
| <Smoke> | `<pnpm --filter smoke exec playwright test>` | <routes, a refusal by role> |

## Models
- review_model: opus   # whole-branch pro-review and the fresh checker run in the fix loop — the strongest model; in force it is also not the maker's (`stage-implement` = sonnet); sonnet | opus | haiku

## Static analysis (dead-code / deps-audit)
<!-- Gives CANDIDATES across the whole repo; the checker intersects the output with the diff and confirms on its own. -->
- unused_code: <yarn knip | npx ts-prune | —>          # orphaned exports, files, types
- unused_deps: <yarn depcheck | yarn knip --dependencies | —>  # dependencies without imports
- import_graph: <npx madge --circular <src> | —>       # cycles and the import graph

## Dev server
- url: <https://localhost:3000>        # protocol+host+port for devtools-verify

## Design sources of truth (figma-compare / figma-spec)
- tokens: <config/theme/tokens.ts | —>
- palette: <config/theme/colors.ts | —>
- ui_lib: <@scope/ui-lib, prefix UI*, components in node_modules/.../runtime/components/ | —>  # the kit's directory inside the repo — a path in backticks: kit-override-scan does not scan it; in the kit's own repo — the line `- kit_overrides: off`
- breakpoints: <xs ≤420, sm ≤767, md ≤1023, lg ≥1024 — from tailwind.config | —>
- icons: <assets/icons/ auto-import, prefix Icon* | —>
- i18n: <locales/ (ru, kk), useLang() | —>

## Code layout (dedup audit / feature-checker)
- components: <components/>
- composables: <composables/ | hooks/>
- page_components: <page-components/<page>/ | —>
- stores: <store/ | stores/ | —>
- server_api: <server/api/ | —>
- tests: <tests/ | —>
- reuse_baseline: <an existing implementation to compare against, e.g. components/<feature>/ | —>

## Platforms / related repos (optional, multi-context)
- desktop: <this repo | —>
- adaptive: <this repo | —>
- webview: <../<webview-repo> | —>

## Conventions
- The project conventions are in CLAUDE.md (pro-review rubric A reads it). No CLAUDE.md — suggest `/init`.
```

## After generation

1. Show the user the filled-in config and **ask about the fields you could not determine** (dev URL, the reuse baseline, the type-check baseline, the webview repo, the default task `language`: `ru` or `en`).
2. Report on MCP (step 8): what is connected and alive, what needs the user's action (start Figma desktop, approve the plugin's servers).
3. Show the permissions script's report (step 9) and, with consent, apply it. Not applied — say plainly that confirmations will be asked at every checker, and leave the ready command.
4. No CLAUDE.md — suggest Claude Code `/init`, so that pro-review has something to rely on.

From this moment the pipeline skills in this repository read `.claude/pipeline.config.md` and work in its context. The order of work from here is in `${CLAUDE_PLUGIN_ROOT}/README.md` (init → feature-checker → stage-plan → the stage loop).
