# i18n-sweep: what is not a finding

33% of i18n-sweep findings on the real task directories of this machine were closed as "false" (VT-1 stage 1: 20 dismissals with a proof). Two reasons repeat with a proof; a third (text copied word for word from the prototype) is not a skip, because a string the diff adds to a screen is never skipped (first item above), and "the prototype has it" does not make it translated. A string that matches a class below **goes into the report as skipped, with the class id and the proof, never silently dropped**. A "do not skip when" condition wins.

## Never skipped

- A string the diff **adds** to a screen, or a call of a formatting helper the diff adds, even if the helper (or a sibling string) already existed without a locale. The corpus has a reviewer overturning "the helper existed before the task" three times, because the diff added a new call.
- A locale file that is missing a key the diff adds for a language the project ships, and plural or interpolation forms the language needs.
- Date, number and currency formatting on a new call with no locale.

### `unchanged-on-base`

- **Skip when:** the flagged line is on the base unchanged and the diff does not add or move a use of it: `git show <base>:<file>` shows the same string, call or helper, and the diff touches neither the line nor a new call site.
- **Do not skip when:** the diff adds a call of the helper (a new site inherits the defect); the line is moved to a place where a different rule applies; the base was not shown (no sha, no content).
- **Example:** `aria-label="Listing images"` is on the base at the same file, and the diff does not edit that line: skipped. A new component that calls a locale-less `formatDate`: reported.
- **Source:** at least 4 dismissals in 2 tasks close with `git show <base>:<file>` or a base sha and line.

### `mock-not-rendered`

- **Skip when:** the text sits in a mock whose gate is a constant `false` (a pending-backend flag) and the source is never called while it is `false`: the report names the flag's `file:line` and the call site that checks it. The text arrives localized from the backend when the flag turns on.
- **Do not skip when:** the flag can be `true` in any environment, default or test; the mock renders in stories, tests or a preview; the gate is a runtime value rather than a constant.
- **Example:** `BACKEND_PENDING_FEATURES.priceAiExplanation = false` and the composable does not call the source: the mock's English text is skipped.
- **Source:** 2 proof-backed dismissals in 1 task.
