# /promote: the ladder, the candidate and its proof

For whoever changes the skill; `/promote` reads it before proposing.

## Where each class tends to land

From the VT-1 stage 1 memo (what repeated across real tasks). These are examples of classes and the level that worked, not rules of the plugin: every repo gets its own.

| Class | Highest working level |
|---|---|
| dead code (unused exports, members, keys) | lint (`no-unused-vars`, knip as a task item) |
| styling tokens (arbitrary values instead of the kit's) | `no-restricted-syntax` on the class/variable, message names the token; kit-overrides patterns |
| i18n (locale gaps, `t()` in `computed`) | a check in CI or a lint; a Repo rules row for the literal |
| repo convention (auto-import, file size, formatting) | an existing rule (`max-lines`, prettier) or a row |
| layering (a module imported across a boundary) | `no-restricted-imports` with the target in the message |
| incomplete migration (the last runtime-resolved components) | `no-restricted-syntax` on `resolveComponent(name)`, or `vue/no-undef-components`; legacy hits are a migration stage |
| architecture (two ways to do one thing) | a stage: delete one |

## Candidate JSON for `promote-proof.mjs`

```json
{ "id": "no-resolve-component", "kind": "eslint",
  "eslint": { "no-restricted-syntax": ["error", { "selector": "CallExpression[callee.name='resolveComponent']", "message": "Import the component from #components." }] },
  "fixes": ["cb488346"] }
```

- `kind: "eslint"` — the candidate is a rule config entry; `kind: "repo-rule"` — `pattern` (regex), `files` (globs), `message`; `kind: "claude-md"` — unproven by definition.
- `fixes` — the commits that fixed the class; their parent's version of each changed source file (up to 12 per fix) is a pre-fix probe. `probes: [{ "rev": "<sha>^", "file": "<path>" }]` names versions by hand. `headFiles` — narrows the HEAD probe to the named files. The default sweeps every tracked file the candidate covers (a repo rule: its `files` globs, prefiltered by `git grep`; ESLint: the tracked source files of the probed extensions) and prints `HEAD: quiet on N of M tracked files`, or the files that fire. A narrowed probe is **not a HEAD proof**: it prints NOT PROVEN and exits 1 whatever it finds, because one unrelated quiet file proves nothing, so name files only to look at one, not to get a green. A file that no longer exists is inconclusive. `since` — a HEAD hit on a line added after these commits is "added later" (default: `fixes`).
- Exit 0 proven, 1 not proven, 2 bad input, 3 no ESLint.

## How the proof works (spike 13, three real repos)

- The project's own ESLint, from its `node_modules`: the runner resolves `eslint` from `<repo>/package.json` and uses `lintText` with `cache: false, fix: false` and the candidate as an override (an array for ESLint 9 flat config, an object for 8). The equivalent for the user to see, one file: `git show <rev>:<file> | node_modules/.bin/eslint --stdin --stdin-filename <file> --rule '<json>' --format json`. Never `npx`: it would fetch another ESLint without the project's plugins and parsers.
- Messages are filtered by the candidate's `ruleId`; the project's own noise is ignored. `.ts` on a flat config is linted with `parserOptions.project: null` (the file is not on disk at that rev).
- A file counts only when `git show` worked and ESLint returned a result with no fatal, parse, ignored or no-config message. Otherwise it is **inconclusive**, never "quiet".
- `--rule`/override **replaces** the project's entry of the same rule id (core already has a `no-restricted-syntax` for `$fetch`): the proposal written into the config must merge, so show the merged entry.
- Monorepos with per-package configs (dashboard-chekin): the stdin path picks the package's config; a rev path in a deleted package is inconclusive.
- A class already enforced by the project (its HEAD config fires on the old content with no override) is reported as "already enforced", not proposed.
- No `node_modules/.bin/eslint` (a linked worktree has none): exit 3, go one level down: a `## Repo rules` row proven by `git show` + its regex, or a CLAUDE.md line marked unproven.

## Repo rules row

`| id | pattern | files | message | evidence |` under `## Repo rules` in `pipeline.config.md`. The pattern is a JS regular expression over one added line (`\|` for an alternation in a cell); files are globs (`**/*.vue`, `!**/*.test.*`); the message says what to do instead; evidence is where the class came from (task, report, PR). A pattern that can backtrack without end (a repeated group that holds a repeat, `(\w+\s?)+`; an alternation whose branches begin alike under a repeat) is rejected as a config problem naming the row, and a row that still does not finish within a second on a file is skipped with a named problem: the built-in rules run either way. floor-guard flags an added line that matches; `floor-ok: <reason>` on the line waives it and the run digest lists the waiver.

## Review comments export (P7)

When the user supplies merged PR/MR comments, treat each as a finding with a file and a text, cluster it with the rest, and keep its source (`PR #n`) as evidence. A comment is a repeat only when it appears twice; a lessons file is not created (prose, the lowest level).
