# Lenses and lanes of pro-review

Methodology the steps of `SKILL.md` point to. The correctness lens stays the main one: a finding in the correctness lane still needs an input → wrong result scenario (Step 4). This file adds the lanes where a different proof is right, and the lenses a diff is read through. It is not a copy of a cleanup review: a lane finding is kept only with the proof of its own kind.

## Maintainability lane (duplicate, dead code, readability, layering, test quality)

A finding in this lane has no crash scenario by nature, so Step 4's "no scenario → drop" does not apply. It stays when it carries a **cost proof**:
- duplicate: the other site as `path:line` (and what drifted between the copies, if anything);
- dead code: zero importers/references — the grep and its count;
- readability / layering: the concrete cost (the import that crosses the layer, the second place a reader must open to follow one rule);
- test quality: the behaviour the test does not pin (see "Tests" below).

A finding without a proof of its kind is dropped. A cost-proven finding the author decides to keep is closed by a ledger line with the reason, not accepted in the report body.

## Deleted and rewritten code: parity with the base

For every file the diff deletes or rewrites (not a few lines of it), open `git show <base>:<file>` (base: whole-branch `$BASE`; stage mode — the previous stage's commit, `HEAD` for an uncommitted stage) and list each behaviour the old code had (a render branch, a gate, a request, a side effect, a copy string, an error path). Each line of the list is one of:
- **restored**: `path:line` in the new code;
- **question**: not found in the new code. It goes to the report as a question for the user decision, and the list goes to the PR text.

An acceptance criterion that removes or changes existing behaviour is listed too, never accepted because the AC says so: the AC is the author's yardstick, not proof. A behaviour that moved (a deleted file whose logic now lives in a hook, a parent, another route) is found by searching the new tree for its trigger or its copy, then written as restored with the new `path:line`.

## States (every new async flow)

For each new request, mutation or transition list the states: idle, pending, error, empty, in-flight (a second trigger while the first runs). For each, what the user sees and what the code does. A missing one is a finding when the trigger is real. Also: **double action** (a double click, a retry, a re-mount) and **idempotency** (the second run leaves the same result: no duplicate rows, no second charge, no second toast).

## Tests: behaviour, not implementation

A new test is judged by what would make it fail: a behaviour change (good) or a rename of a class, a refactor of an internal (bad). Tests that assert class names, internal call order or a mock's own return are not proof of the behaviour they are named after. A test that passes with the fix reverted pins nothing.

## Symptom or root cause

A fix that guards the place the error shows up (a `?.`, a `try/catch`, a default) is read against the place the bad value is made. If the source stays and a second consumer of it exists, the fix is partial: name the second consumer.

## Evidence per aspect (the report names the search)

A rubric aspect the report calls checked ("i18n", "tokens", "reuse", "a11y", "no other call sites") names **what was searched and what was found**: the grep pattern, the files, the helper compared. The search is **derived from the diff**, not chosen by hand: the file types the diff changes (a `.css`/`.env`/`.json` change is searched in those files too), the values it adds (the literal, the colour, the key, the function name), the shape of the new symbol. A pattern that leaves out a changed file type or does not contain an added value is too narrow. When an aspect passes a named site, the report says what was checked there: the parameters, not only the export; the gating, not only the wording. "Checked, nothing found" with no search named counts as not checked.

## Yardstick is not proof

An AC, a spec line, a fix item or a test saying the code is right does not make it right: each can encode the defect. A PASS names what **would have failed it** (the input, the state, the line whose absence fails it); if nothing could have failed it, it is `not checked`. "The AC says so" is never the reason a behaviour change is acceptable (see parity above).
