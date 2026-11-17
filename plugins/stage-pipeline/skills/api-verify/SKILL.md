---
name: api-verify
description: Methodology of the api-verify checker — API probes written from the stage criteria and the contract (codes, body, role matrix, read-back after a write, a sent event, a migration forward and back), run through the test command of the repo's `## Backend` section, report with a request/response/read-back line per criterion. Use when a backend stage is closed (/stage-check) or when the user asks to check an endpoint against its criteria. RU triggers — «проверь эндпоинт», «API-пробы по критериям»
---

# api-verify — probes from the criteria, run where the tests run

You are checking what the backend does, not how the maker's tests look. The maker's tests passing says the maker's reading of the criteria holds; your probes are a second, independent reading. You write them from the criteria and the contract, run them, and report one line per criterion.

## 1. Input and environment

1. **The criteria**: the stage's `[verify: api-verify]` criteria (id and text), from the prompt or from STAGES.md.
2. **The contract**: the file at `contractPath` (`<task_dir>/<TICKET>/CONTRACT.md`, or `<repo>/<contracts>/<TICKET>.md` when `## Backend` sets `contracts:`; the prompt gives it). Take from it the endpoints `E*`, events `EV*` and migrations `MG*` that the stage covers: method and path, roles, fields with types, nullable and enum values, the event's exchange, routing key and payload.
3. **The `## Backend` section** of the backend repo's `pipeline.config.md`: `test` (the command, with a `{files:rel+py}` placeholder for the probe paths), `test_env`, `compose`, `auth`, `note`. The `note:` line names the project fixtures worth knowing about (for example a session fixture that calls the network).
4. **The environment** (database and cache containers, a network) is started and held by the orchestrator, the way a dev server is held for devtools-verify. You only connect. A test command that does not start makes the report **FAIL with the reason** (the command, its output, the stack if it hung), not a skip and not `not checked`: a stage whose probes could not run stays open.

## 2. The probes are yours

1. Write the probes **before** you read the maker's tests, so the context stays clean. Reading them afterwards is allowed, to reuse the project's factories instead of duplicating them.
2. The probe folder is `<repo>/.api-verify/<TICKET>-<stage>/`, inside the repo tree so that the root `conftest.py` and the pytest settings are picked up. Make it a package when the project's tests are (`__init__.py`). **Clear it first**: list the folder; every file in it that this run does not write is overwritten with an empty file (when deletion is not permitted), and the report header lists it as a leftover. A run that found leftovers says so before its verdicts, because a stale `conftest.py` or fixture silently changes the run. Repo paths are absolute (no `~`, no runtime-computed `cd`). Git ignores the folder through the line `.api-verify/` in `<abs repo>/.git/info/exclude` (`git rev-parse --git-path info/exclude` gives the file in a worktree); when the line is missing, add it with a plain `echo ".api-verify/" >> <abs repo>/.git/info/exclude`. One command per Bash call when a session guard refuses compound commands. Check `git status` of the repo before the report: a probe file in it is a defect of your run.
3. Reading the project's existing tests and fixtures for the role and data setup (factories, permissions) is allowed; the assertions come from the criteria and the contract only. Use the project's factories and fixtures (find them first: the `note:` line, then `conftest.py` and the test-support package). The client is DRF `APIClient`. For auth prefer the project's own authenticated client fixture (for example a factory that issues a real JWT with role claims), named by `auth:`, over `force_authenticate`, which can skip the token-based policy conditions; use `force_authenticate(user=...)` when the project has none.
4. **A session fixture that goes to the network** (the `note:` line names it): first look for an env switch the project already has (in settings or `conftest.py`; the `note:` line names it, for example `SKIP_UNIT_TEST_WITH_API_CALLS_TO_STRIPE=1`) and use it. Without a switch, override the fixture in the `conftest.py` of your probe folder with a fixture of the **same name** that does nothing, and say so in the report ("overridden: `<name>`, reason: calls an external API without a timeout"). A project fixture that blocks on the network hangs every run.
5. Test data: each probe creates what it needs through factories, and rows that happen to be in the test database play no part.

## 3. What each probe checks

For each criterion decide which of these apply, and write a probe for each that does:

- **Code and body.** The status code, and every field the contract names: presence, type, nullable, enum values (the whole set, not one). A field the contract says is hidden for a role is **absent** (assert the key is not in the body), not just null.
- **Role matrix.** The same endpoint under **every role the contract row names**, plus an anonymous request (401 or 403, per the project's auth) and a user of another account (200 without the object for a list endpoint; 403 or 404 for a detail or a write; the contract may say why one is absent): the expected code (200 / 401 / 403 / 404) per role. A foreign object (another account, another creator) is not visible (404 or absent from a list) and not changeable: a write as the other role gets the expected refusal **and** the object, read back as its owner, is unchanged.
- **Read-back.** For a write criterion: after the write, in the same test and on the same data, a GET of the same resource (as the role that may read it; as role A for a write of another role) or a read of the model field, and compare with what was sent. A 200 alone proves nothing about what was saved. For a read criterion the request itself is the read; add a control in the same test: the other role, the same request without the filter, or, for the owner's own read, a model read-back after `refresh_from_db`. The report line says which control it used.
- **Event.** The broker publisher is replaced in the probe (`unittest.mock.patch` on the project's publisher function, the default; `mocker` only when the project has pytest-mock; find the function by searching the repo for the contract's exchange). Assert it was called once, with the exchange and routing key of the `EV*` row and the payload fields named there; also assert it is **not** called on the refusal path.
- **Migration `MG*`.** On the test database: `migrate <app> <previous migration>` (backwards), then `migrate <app>` (forwards), both without an error; if the contract names a data backfill, count the rows before and after. Run it through the same test setup (`call_command` inside a probe with `transaction=True`, or the project's own migration-test helper).
- **Filters and lists.** A criterion about a filter or ordering: create at least two objects that differ in the filtered value and assert the response contains exactly the matching ones.

A criterion no probe can reach (needs another service, a real broker, production data) is `not checked`, listed in "Could not verify" with the missing prerequisite. A neighbouring probe does not stand in for it.

## 4. The run

1. The command is `test` from `## Backend` with the probe path in the placeholder (`{files:rel+py}` gives the repo-relative paths in the form the container sees). `test_env` entries go as environment variables. The report and any blocker show an entry as `KEY=<set>` without its value (the report may be committed with the task).
2. **No terminal and a time limit.** Run the container without a TTY (`docker compose run -T ...`, stdin closed: `< /dev/null`). The container runner ignores the signal of an outer timer, so the limit goes **inside the container**. Substitution: in `test`, the tail `python -m pytest <args>` is replaced by `python -c "import faulthandler,sys,pytest; faulthandler.dump_traceback_later(<seconds>, exit=True); sys.exit(pytest.main([<args>]))"`; the prefix (`docker compose run -T --rm --no-deps -e ... <svc>`) and `test_env` stay, and `-e PYTHONDONTWRITEBYTECODE=1` is added to the prefix next to `test_env`, so that no `__pycache__` lands in the probe folder. `<args>` carry `-p no:faulthandler` (pytest's own faulthandler conflicts with `dump_traceback_later`), `-p no:cacheprovider` (the repo is mounted into the container), and `--reuse-db` when the test database exists. The wrapper kills the run and prints the stack where it stuck. Pick the seconds from the probe count (300 for a handful of probes; more for the first run on a fresh test database, whose migrations take minutes on an emulated database image).
3. The run goes to a file, not into `tail` or another filter: the exit code is read from `$?` first, then the file. The report needs the pytest summary line and the exit code.
4. A hang or a crash of the environment is **FAIL with the reason and the stack**: a critical finding and a FAIL on every criterion of the run. One retry is allowed when the stack shows a startup race, not a code error. A probe that fails by its own mistake (a wrong fixture, a wrong import) is fixed in the probe, counted as a probe iteration in the report header (`probe iterations: N`), and is not a product FAIL.
5. Record the exact command (the one that was run, after the substitution) and the wall time.

## 5. The report

`<task_dir>/<TICKET>/checks/api-verify-<stage>.md` (a recheck of a finding: `api-verify-<stage>-r<k>.md`), in the task language, by `${CLAUDE_PLUGIN_ROOT}/references/checker-report.md`:

```markdown
# api-verify <stage> — <TICKET>
Findings: critical N · major N · minor N
- ticket: <TICKET> · stage: <N> · repo: <name> · repo commit: <short sha> · contract: <path>
- command: `<the exact command, test_env values as KEY=<set>>` · exit code: <n> · time: <seconds> · result: <pytest summary line> · probe iterations: <n>
- overridden fixtures: <name — reason> | none

## Findings
- F1 [critical|major|minor] <what, where `file:line`, the criterion, the probe name>

## Stage criteria
- AC-x.y — PASS — <METHOD path> as <role> → <code> <key fields>; read-back: <GET path | Model.field> → <value>
- AC-x.z — FAIL — <METHOD path> as <role> → <code> expected <code>; <what was seen>
- AC-x.w — not checked — <prerequisite missing>

## Could not verify
- <item and why> | everything verified (of what was passed in)
```

Rules for the criteria lines:
- A PASS carries the **request** (method, path, the role), the **response** (the code and the fields that show the effect) and the **read-back** on the same line or the lines right under it — the same pair as a PASS on an `[effect]` criterion of devtools-verify. A write criterion with no read-back is not PASS.
- A criterion of the form "role B does not change the object of role A" shows three things: the request **as role B**, its code, and the **read-back of the object as role A** with the value unchanged.
- An event criterion names the exchange, routing key and the payload fields compared. A migration criterion names both commands and their exit status.
- Personal data and credentials in a body are named, not quoted (`email: <set>`).
- Every FAIL is also a finding with its severity (a refused role that gets through, a leaked field, a write that does not stick — critical or major; a wrong enum value or a missing field — major; a cosmetic body difference — minor).

**After the run:**
1. Copy the probe folder as it is to `<task_dir>/<TICKET>/checks/api-verify-<stage>-probes/` (for a recheck `...-<stage>-r<k>-probes/`).
2. Delete `<repo>/.api-verify/<TICKET>-<stage>/` from the repo and confirm with `ls <abs repo>/.api-verify` (not only `git status`, which does not show an excluded folder) that it is gone. When deletion is not permitted, any `__pycache__` or other file left in it is named too, and the report carries a minor finding with the absolute path and the cleanup command (`rm -rf <abs path>`), and the final message repeats them; the orchestrator records a blocker with that command.
3. Stop anything you started; the orchestrator's containers stay up.

## 6. Blind spots, to name in "Could not verify"

The probes run in-process on a test database with a mocked publisher, so they leave unproven the deployed service, the real broker, the real network between the services, the production data shapes or the frontend reading of the response. Those belong to `[verify: staging]` and `[verify: devtools-verify]` criteria.
