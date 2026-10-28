# Kit overrides: what the scan does not report

`scripts/kit-override-scan.mjs` flags every hand-set weight, case, tracking, size, radius, spacing, width and shadow on an added line. 76% of what it flagged on the real task directories of this machine was closed as "false" (VT-1 stage 1: 79 of 104 report rows; 26 of them are in the ledger of dismissals with a proof). The same few reasons repeat, so the scan now applies them itself: a skipped hit is **listed in the report under "Skipped by false-positive patterns" with the id of the pattern, never dropped silently**, and a "do not skip when" condition always wins over a skip.

Each class below has four parts: skip when, do not skip when, an example, the source of the rule. The ids with a backtick heading are applied by the script (`SKIP_PATTERNS` in the scan; a self-test checks that the headings and the list agree). A reviewer who overturns a skip adds a "do not skip when" line here, with its source.

## Never skipped

- `!important` and a kit component variable (`--button-…:`): an override wherever the line came from.
- A line that is new or changed in the diff, on the grounds that "the reference does it too" with nothing the scan can compare: a precedent copies a miss as readily as a rule, and the VT-1 corpus has a reviewer overturning a proof-backed "the reference does the same" because the kit had a token for the value. The ledger still takes `false` with a `path:line` of the reference section; the script does not decide it.
- A decision of the user ("the look as in the prototype"): it stays a decision in the ledger with its date or quote.

### `moved-line`

- **Skip when:** the identical line (trimmed, white space collapsed, a trailing `,` or `;` dropped) is also *removed* in the same diff, **from a file the scan reads** (not a story, test, mock or kit file), and the removal is a move: (a) from the **same file** (a re-indent, a reorder inside the file); (b) from a file the diff **deletes** (the file is gone: its lines may reappear elsewhere); a file the diff **renames** is the same file under a new name, so its removed lines count as the same-file case (a) in the new file only; or (c) as a **contiguous block of 3 or more removed lines that reappears as a block** (a section extracted into a new component). One removed copy covers one added copy.
- **Do not skip when:** the line is added more times than it is removed (every copy past the removed count is a new override and stays a finding); the line is not equal after the change (a reordered class list, a changed value, a new attribute); the hit is `!important` or a kit variable; the removed copy is in another file that stays (a line that was *fixed* in `Old.vue` and written again in a new `NewCard.vue` is a new override: one removed line elsewhere is a coincidence, short attribute lines repeat everywhere), or in a file the scan does not read (a `Badge.stories.tsx` line does not cover `Badge.tsx`).
- **Example:** `<h3 className="font-semibold uppercase">` leaves `Old.tsx`, which the diff deletes, and appears, indented deeper, in `Moved.tsx`: skipped. The same line copied into a third file: reported once. `class="font-semibold"` replaced by a kit component in `Old.vue`, and the same line written in a new `NewCard.vue`: reported.
- **Source:** 13 of the 26 dismissals of kit-overrides rows close with base proof (`git show <base>:<file>` or "the file moved, the lines did not change"), in 4 repos; replay in the section below.

### `token-shorthand`

- **Skip when:** the arbitrary value is only a CSS variable in Tailwind's `[--x]` shorthand (`rounded-[--radius-md]`; v3.3 form, v4 writes `(--x)`), and no added line of the diff declares that variable.
- **Do not skip when:** the diff declares the variable (`--radius-md: 9px` in an added line): the token is hand-made, not the kit's.
- **Example:** `rounded-[--radius-md]` in a component: skipped; the same class with `:root { --radius-md: 9px }` added next to it: reported.
- **Source:** 2 dismissals with a kit file as proof (the same technique in the kit's own component), and the "fixed" outcome of a hand-set `rounded-[16px]` that became this token and was then flagged again by the scan on the token itself.

### `reference-line`

- **Skip when:** the value is a whole class token (not a part of a longer one) of a reference file named for the scan: `--reference <file>` (repeatable), for example the source file of the stage's "Visual reference". Nothing is read from STAGES.md on its own. The report prints the place, `file:line`, which is the proof the ledger asks for. The reference file must not be in the diff.
- **Do not skip when:** the reference file is changed by the diff (it proves nothing); the hit is `!important` or a kit variable; the kit has a token or a component for the value (the finding is "use it", and the reference only repeats the miss; the scan cannot see this, the person who picks the reference file must); the reference is a neighbour picked to match, not the section the stage names.
- **Example:** the stage's reference section has `rounded-[20px] bg-… pb-2` on its card; a new card uses `rounded-[20px]`: skipped with `Reference.vue:43`.
- **Source:** 11 of the 26 dismissals read "the reference section does the same, `path:line`". Without a file named for the scan nothing is skipped.

## Measured on the real reports (VT-6 stage 13, 2026-10-28; the eval half waits for VT-3)

The numbers below were measured again after the move rule was narrowed in the fix round (same-file, deleted or renamed file, or a block of 3): the replay is unchanged, row for row, because the replay diffs are `--no-renames` commits, where a move is a deleted file plus a new one.

Replay: the scan's skip logic over the commits that introduced each flagged value (`git diff <commit>^ <commit> --no-renames`, as an uncommitted move looks), for the 64 distinct rows (task, file, values) of the 104 report rows found in 15 task directories of 4 repos.

- Before: 79 of 104 rows are false (76%); 43 of 64 distinct rows (67%).
- 46 of the 64 rows could be replayed (the rest were fixed before any commit, so no diff holds them). Of the 41 false rows among them, the scan alone skips 6; with the reference file that the ledger cited named for the scan, 24 are skipped and 17 stay. **No row that a ledger closes as fixed or as a true override is skipped**: of 8 skips without a reference file, 6 are `false`, 1 is a user decision on a file that only moved (the ledger says "the class did not change"), 1 is the token that *replaced* a fixed hand-set value (the original `rounded-[16px]` is not skipped).
- Without a named reference file the script removes about one false row in seven; the larger part needs the file, so the reduction comes only when `/stage-check` passes the stage's reference file with `--reference` (reading the "Visual reference" line itself gave no file on the real tasks: its prose seldom names one).
