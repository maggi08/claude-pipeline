# /promote, the reverse direction: an entry of a false-positives file

Files: `skills/<checker>/references/false-positives.md` in the plugin (existing: stage-check `kit-overrides-false-positives.md`, devtools-verify, i18n-sweep).

An entry has four parts, as in the existing ones:

- **Skip when:** the condition, with what the report must show (a base sha, a `path:line`, a command and its result).
- **Do not skip when:** what makes the skip wrong; this always wins.
- **Example:** one skipped and one not skipped.
- **Source:** the dismissals it comes from (task, report, count), only ones that carry a proof.

Rules: an entry goes under the file's own heading level; it never overlaps the "Never skipped" list; a skipped symptom is still listed in the report with the pattern id; a dismissal without a proof is not a source. A reviewer who overturns a skip adds a "do not skip when" line with its source instead of deleting the entry.
