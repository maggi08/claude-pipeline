---
name: deps-audit
description: Narrow pass over dependencies and assets added by the task — is the new library justified, does the repo already have an equivalent, did it land in the runtime bundle, are new images and fonts referenced. Use as a checker step of /stage-check on stages where the manifest changed, and always before a PR. RU triggers — «аудит зависимостей», «оправдана ли новая библиотека»
---

# Deps audit — what the task dragged into the project

The goal is narrow: every new dependency and every new asset must be justified, used and sit in the right section of the manifest. It is a cheap pass that catches an expensive class of fixes — extra bundle weight and a second library for what the project already has.

> **Project config.** Take the package manager and the layout of apps and packages from `<repo>/.claude/pipeline.config.md`.

## Scope

Changes of manifests and the lockfile in the diff (`package.json` of all workspaces, the lockfile) plus new binary files: images, fonts, video, icons.

None of that is in the diff — return "nothing to check" in one line and do not spend the pass.

The config declares `unused_deps` in the "Static analysis" section — run it first: it closes the item "a dependency was added and is not imported" more reliably than a grep by package name. Keep from the output only the packages from the diff — the rest is pre-existing debt, not our scope. It does not cancel the confirmation from the section below: indirect hookups (bundler plugins, linter configs, `postinstall`, type-only imports) such tools routinely count as unused.

## What to check

### New dependencies

1. **Is there an equivalent in the repo.** A second library for dates, strings, forms or requests next to an existing one is duplication with the price attached in kilobytes. Grep the imports over the whole repository before you agree to the newcomer.
2. **Is it imported at all.** A dependency that survived a rewrite and stayed unused is unnoticeable in review. Grep the package name over the code.
3. **The right section.** Everything needed only by the build, tests or lint must lie in the dev dependencies. Tooling in the runtime section goes into the image and the bundle.
4. **The version in the project's style.** If the monorepo has a version catalog or a single pin — the new dependency must come from there, not with its own range. Diverging versions of one package between apps give two copies at runtime.
5. **Transitive weight.** For a notable library say the size and whether there is a tree-shakeable entry. Do not guess — look at what really gets into the bundle.
6. **Liveness and version.** Check (see "Confirmation") that the added version is not deprecated, the package is not replaced by a successor, and the API used in the diff exists in this version. A new dependency on a major below the current one is a separate finding with the question "why not the fresh one".
7. **Framework duplicates.** A second copy of React/Vue/i18next because of a link to a neighbouring repo breaks hooks and contexts in a way that looks like an app bug. Check if the task touched linked packages.

### New assets

- Every new file has a reference (including `url(...)` in CSS, manifests, computed paths).
- The size is reasonable for the purpose; the format is consistent with the other assets of the repo.
- Raster instead of vector where SVGs lie nearby — a finding.

## Confirmation

- Confirm "an equivalent already exists" with a concrete path and the number of call-sites, not from memory.
- Before saying "not imported" — check the indirect hookups: bundler plugins, linter configs, `postinstall`, type-only imports.
- "Deprecated" and "replaced by a successor" — by the registry: `npm view <pkg>@<version> deprecated` (empty — not deprecated; the text usually names the successor) and `npm view <pkg> time --json` (the date of the last release); "this API is not in the version" — by the types of the installed package (`node_modules/<pkg>/…d.ts`). Not from the model's memory. The registry is unavailable and the package is not installed — mark the item "not checked" and do not make a finding out of it.
- Before suggesting to demote to dev — make sure the package is not pulled by the runtime on the server (an SSR path is easy to confuse with build time).

## Report

Into `<task_dir>/<TICKET>/checks/deps-audit-<stage>.md` (before the PR — `deps-audit-branch.md`) and compactly to the orchestrator. The report follows the common contract `${CLAUDE_PLUGIN_ROOT}/references/checker-report.md`, written in the task language:

```markdown
# Deps audit: <stage or branch>
Findings: critical N · major N · minor N

| # | Package / asset | What is wrong | What to replace with / where to move | Severity |
|---|-----------------|---------------|--------------------------------------|----------|

Outcome: N dependencies added, N of them justified, bundle weight delta <measured value | not measured>.

## Could not verify
(what was not checked, e.g. the registry is unavailable; nothing left — "everything verified")
```

All clean — say so.
