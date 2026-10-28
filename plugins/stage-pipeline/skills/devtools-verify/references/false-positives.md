# devtools-verify: what is not a finding of the stage

36% of devtools-verify findings on the real task directories of this machine were closed as "false" (VT-1 stage 1: 48 of the 163 dismissals with a proof; the rest are other checkers). Three reasons repeat with a proof. A symptom that matches a class below **goes into the report under "Could not verify" or a "Skipped" line with the class id and the proof, never silently dropped**; the checker keeps the evidence it ran. A "do not skip when" condition wins.

## Never skipped

- A console error, a hydration mismatch or a failed request that appears on the branch and **not** on the base, or more often than on the base. Reproduction on the base is the proof; "it looks old" is not.
- A criterion that fails (`FAIL`) on the stage's own acceptance criteria. "Not a FAIL" is a different outcome: write it as a PASS line, not as a skip.
- A symptom at a width or state the stage's criteria name.
- Anything on a path the diff touches: a file, a route, a request or a component the stage changed.

### `base-reproduces`

- **Skip when:** the same symptom (the same console message, request, markup or geometry) reproduces on a build of the stage's base — a base sha or the base URL, named in the report — in the same number of loads as on the branch (at least 3 each for a timing-dependent symptom such as a hydration mismatch), and the diff does not touch the code that produces it.
- **Do not skip when:** the base was measured once, or on another route, width or data set; the count on the branch is higher than on the base; the message text differs; the diff changed the file, route or request. A "before the stage" claim with no base measurement is not proof (`pre-existing-no-base-proof`, `references/checker-report.md`).
- **Example:** `Hydration completed but contains mismatches` on a detail page, 3 of 3 loads on the branch and 3 of 3 on the base build, in a component the diff does not touch: skipped, with the base sha and the three loads.
- **Source:** at least 10 dismissals in 4 tasks close with a base build or `git show <base>:<file>` showing the same markup, request or title.

### `environment-not-code`

- **Skip when:** a check of the dependency itself (a `curl` of the dev API with its status and the date, a dev server restarted after a dictionary change) shows the symptom comes from the environment: a backend 404 or 500 on a request the diff does not add, a stale dev server, an asset missing on the stand. The report names the command and what it returned.
- **Do not skip when:** the request is new in the diff; the app turns the backend's failure into a crash or a blank screen that the code could have handled (that is a finding about the handling); the check was not rerun (the claim "stand data" with no request is `data-seen-only`).
- **Example:** a 500 from a preview endpoint on one record, `curl` returns 500 today, and the diff does not call it: skipped. The same 500 turning the whole page white: a finding.
- **Source:** 4 proof-backed dismissals (a dev server holding an old dictionary, a backend 500, a backend 404 swallowed by the app, an asset missing on the stand).

### `not-reachable`

- **Skip when:** the state the finding needs cannot occur in the branch: a code path behind a media query, a flag fixed to `false`, a link that exists only in a block hidden at that width, shown by a `file:line` of the condition. The report names the condition.
- **Do not skip when:** the condition depends on data or a flag that production can turn on; another entry point reaches it (a deep link, a back navigation); the stage's own criterion asks for that state (then it is `not checked`, not skipped).
- **Example:** a modal bug at 375px, while the calculator that opens it renders only above 1023px (`file:line` of the condition): skipped.
- **Source:** 3 proof-backed dismissals in 2 tasks (a viewport gate, a hidden-at-width link, a hidden calculator).
