# Heavy checks — lint, test, type_check, build

Commands from the config run over the whole repository. On a stage that is minutes of CPU and gigabytes of memory, and when repeated after every edit, in every round of the fix-loop and in parallel with the dev server and the browser they are the main brake on implementation. On a weak machine or with 3–4 projects in parallel — swap as well. The rule: on a stage — scope by the diff and one run; the whole project — once, at the end of the task.

**Run through `node ${CLAUDE_PLUGIN_ROOT}/scripts/run-check.mjs -- <command>`.** It substitutes the stage's changed and new code files into `{files}`, skips the command when there are none, and in `low` mode puts the heavy runs of all the machine's projects into a queue with lowered priority. The mode — `node …/run-check.mjs --mode`: `resources: low | normal` from `pipeline.config.local.md`; without the field — `low` at RAM ≤ 16 GB.

| When | lint | test | type_check | build |
|---|---|---|---|---|
| while editing | no | no | no | no |
| end of implement and of every fix-loop iteration | `lint_files` on the diff; no such field — `lint`, once | `test_related` on the diff; no such field — `test`, only if the stage touched logic (a store, a utility, the API layer) | once, the whole project — errors are born in other people's files too; compare with the baseline | only if the stage touched the manifest or the build config |
| `/stage-check`, Step 1 | do not repeat if the tree has not changed since the run in implement (the same `git status --porcelain`) | same | same | — |
| final checks of the task | `lint` in full | `test` in full | `type_check` in full | `build` |

`lint_files` and `test_related` are optional config fields with `{files}` (`yarn eslint {files}`, `yarn vitest related --run {files}`, `yarn jest --findRelatedTests {files}`); without them the old command for the whole project works, only less often.

**The dev server is needed only by devtools-verify.** In `low` mode it is stopped for the duration of lint/test/type_check/build: first the deterministic checks and the static checkers (pro-review, figma-compare), then the dev server → devtools-verify → the server is stopped; the live recheck of the fix-loop goes the same way. You stop only the server you started yourself — by PID (`… & echo $!` at start) or by the id of the background task, not with `pkill`: in force the hook rejects it. The user's server you do not touch; if it is in the way — in normal mode ask the user to stop it. In force, check on it, since the working tree is the same. If another env is needed and a second instance does not come up (Next holds `.next/dev/lock`) — devtools-verify skip with a reason, not a question. In `normal` mode — as before: the server can be kept, checkers run in parallel.
