---
name: pipeline-doctor
description: Check the developer environment for the stage pipeline — MCP (figma, chrome-devtools), paths to neighbouring repos, dev server, type-check baseline. Run after the first clone of a repo, when switching machines or moving to a new laptop or new machine, or when checkers (figma-spec/figma-compare/devtools-verify) do not work. Diagnoses, suggests fixes, and creates pipeline.config.local.md for a non-standard layout. RU triggers — «не работает figma MCP», «проверь окружение», «склонировал репо на новый ноут»
---

# Pipeline Doctor — checking the developer's environment

The goal: in one run, make sure that everything the pipeline needs works on this
machine, and suggest a fix for what does not. The pipeline itself comes with the
`stage-pipeline` plugin — the doctor checks only the environment around it.

## Checklist (in order)

1. **MCP servers.** The canonical names are set by the plugin's `.mcp.json`:
   `figma` and `chrome-devtools`; Claude Code adds the prefix
   `plugin_stage-pipeline_` to the tools of plugin servers. Through ToolSearch check that
   `mcp__figma__get_metadata` and `mcp__plugin_stage-pipeline_chrome-devtools__list_pages`
   are available (or `mcp__chrome-devtools__list_pages`, if the developer has their own server).
   - No Figma tools → (a) project servers are not approved — suggest `/mcp` →
     approve; (b) Figma desktop is not running or the MCP server is off
     (Figma → Preferences → **Enable Dev Mode MCP Server**). Port check:
     `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3845/mcp` —
     any HTTP code = the server is alive, connection refused = it is off.
   - No chrome-devtools → Node ≥ 18 is needed (`npx -v`); the server starts by itself
     via npx on the first call, Chrome must be installed.
   - If the developer has a user-scope server on the same endpoint but under a
     DIFFERENT name — that is a duplicate: the skills and permissions are tied to the canonical
     names, so the duplicate should be removed (`claude mcp remove <name> -s user`).

2. **Neighboring repos.** Check the paths from `pipeline.config.md → Platforms /
   related repos` — each must exist on disk.
   They do not match the real layout → ask for the actual paths and create
   `.claude/pipeline.config.local.md` with the section `## Platforms / related repos`
   (the local fields override the base config; the file is gitignored).

3. **Machine resources.** `node ${CLAUDE_PLUGIN_ROOT}/scripts/run-check.mjs --mode` — `low` (RAM ≤ 16 GB or
   `resources: low` in `pipeline.config.local.md`): the heavy checks of all the machine's projects go in a queue,
   the dev server lives only for the duration of devtools-verify (`${CLAUDE_PLUGIN_ROOT}/references/heavy-checks.md`).
   Tell the user the mode; a strong machine and the queue gets in the way — `- resources: normal` into the local config.
   No `lint_files`/`test_related` in the config — suggest them (`/pipeline-init`, item 2): without them the whole
   project is run on a stage.

4. **Dev server.** `Dev server → url` from the config (+ the local override). If the
   developer has a different port/protocol — also in `pipeline.config.local.md`.

5. **Baseline (optional, ~a minute).** `type_check` from the config → compare the
   error count with the baseline. It has drifted — suggest updating the baseline in the
   base config (a shared file — in a separate commit, not silently). Two catches:
   - **Monorepo masking**: a shared script with a topological order
     (`workspaces foreach -t`, turbo/nx) silently skips dependent
     workspaces when their dependency fails; a suspiciously fast run =
     skipping — check with a direct `tsc -p <app>` of the main app.
   - **Freshness of local packages**: baseline errors "module does not export X"
     about a `file:`-tarball/workspace ui-lib = first reinstall the package,
     then measure the baseline (a stale tgz masquerades as legacy debt).
   - **Installed tree ≠ manifest** — the most expensive of the catches, because
     it makes the checks green by a lie. `ls -la node_modules/<ui-lib>`
     and compare with the version in `package.json`: a symlink (`link:`/`portal:`) to a
     neighboring repo with a pinned registry version means that everything is
     checked locally against code that is not in the pinned version — only
     CI will turn red. The reverse also happens: the manifest asks for `link:`, but a
     registry tarball is installed, and the neighboring repo's edits are simply not visible.
     A mismatch → say which mode the developer needs and bring the tree
     in line with the manifest (`install`), not fit the manifest to the tree.
     Separately: `link:` is resolved FROM THE WORKSPACE, not from the monorepo root —
     from `apps/<app>` to the neighboring repo it is `../../../<repo>`; a wrong
     depth gives a broken symlink and a failure at the config-loading stage
     (PostCSS/bundler: "Cannot find package"), not a clear error.
   - **Duplicate runtime dependencies from a linked neighbor**: a second copy of
     React/i18next from its `node_modules` fails tests in files unrelated
     to the work. Measure the set of failures on a clean tree and record it as
     known environment noise, otherwise every session fixes it again.

6. **Static analyzers (if declared).** The `Static analysis` section of the config:
   run each non-empty command (`unused_code`, `unused_deps`,
   `import_graph`) once and make sure it works and
   returns a list, not an error. It broke — put `—` back in the config: a checker
   is better off working by grep than trusting a broken tool. It fails because of a
   missing package — say what to get it with, but do not install it yourself.
   No section at all — SKIP, not FAIL: the config was generated before it appeared.

7. **Permissions.** They are checked by the plugin's script, not by eye:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/permissions.mjs --check          # user scope
   node ${CLAUDE_PLUGIN_ROOT}/scripts/permissions.mjs --check --scope project
   ```

   Exit code 1 = something is missing OR a needed entry is overridden by the user's own
   `deny`/`ask` (the `+ …` and `⚠ conflict` lines respectively).
   What is missing is fixed by the same script with `--apply` — show the list to
   the user and apply with their consent (it edits their user scope);
   what is overridden the script does not touch on principle, it is the user's
   conscious choice — just name what exactly will be asked about because of it.

   The script also catches three skews that are not visible by hand: a bare `Bash`
   in allow (all of Bash is allowed — point entries are meaningless), entries
   like `Skill(pro-review)` without the plugin prefix, and **obsolete entries**
   (`⚠ obsolete entry`) — those that the profile handed out in past versions and
   that turned out to be more dangerous or more useless than assumed. The script
   may not remove them: `settings.json` belongs to the user. Show the list with the
   reasons and suggest removing them — on an upgrade from 0.4.0 there will be
   `Bash(rm -f *)`, which allows `rm -f -r <any path>`.

   The last one is the most frequent false "the pipeline broke": a skill that came
   with the plugin is called as `stage-pipeline:<name>`, and the entries accumulated
   while the skills lived in the personal user scope no longer allow ANYTHING.
   The symptom: "it did not ask before, now it asks on the same action" —
   almost always a renaming of the rule's subject, not a tightening of the policy.

   Separately check the project scope (`<repo>/.claude/settings.local.json`):
   `additionalDirectories` must hold the paths of the neighboring repos and the path to the
   plugin repo — otherwise reading the neighboring kit and editing the skills themselves ask for
   permission on every file. To add: `--scope project --apply --dirs
   ../ui-lib,../prototypes`.

8. **`main_branch`** — the PR target: the base of whole-branch
   pro-review, `floor-guard --base`, dead-code and wrapup is counted from it. Check it against where
   branches really get merged: `git log --merges --first-parent -20 --oneline
   origin/<main_branch>` against the same for the neighboring candidates with origin
   (`dev`/`development`/`main`/`master`). Feature merges go to another branch,
   and into `main_branch` — only release ones from it → suggest fixing the field
   (a shared config — in a separate commit). One candidate — SKIP.

9. **CI gates.** Find in the CI files (`.github/workflows/*.yml`, `.gitlab-ci.yml`,
   `bitbucket-pipelines.yml`) the jobs on a pull request / merge request and their
   check commands. Compare with what the plugin sees:
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/ci-gates.mjs` (the "## CI gates" table of the
   config or `e2e`/`smoke` in Commands). CI runs smoke, e2e, bundle size
   or locale completeness on a PR, and the plugin does not see them — FAIL with a ready table
   for the config. In the table — only check commands: deploy, publishing and steps
   with secrets are never gates. The precedent: smoke ran in CI but was not part of the final
   checks — and failed only on the PR. No CI files — SKIP.

10. **Summary.** A compact table: item | status (OK/FAIL/SKIP) | what to do.
   All OK → the environment is ready, then follow `${CLAUDE_PLUGIN_ROOT}/README.md`.
