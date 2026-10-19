# Stage commit message

Read from `/stage-check`, Step 4.4, and `/stage-force`, Step 1.6.

Subject: `<TICKET>: <what was done>` — one line, up to ~72 characters, in the present tense and about the substance of the change, not the stage number. "`<TICKET>`: input autofocus and deferred field validation" is fine; "`<TICKET>`: stage 29" is not: a month later such a message does not tell you what to look for in the history.

Add a body only when the subject objectively cannot hold the substance: 1–3 lines about **why**, not "what" — what is visible from the diff is not repeated in the body.

Check the style against the repository history (`git log <main_branch> --oneline -20`): where `feat:`/`fix:` type prefixes are used — follow them, where they are not — do not introduce them. The language of the message follows the history too (or the user's request), not the task language (`${CLAUDE_PLUGIN_ROOT}/references/language.md`).

**Do not add service signatures to the message** — no `Co-Authored-By`, no line about generation by a tool, no emoji authorship markers. This is the user's decision for all their repositories: the history should read as written by the person who answers for the change. If such a signature is added automatically (a template, a hook) — remove it from the stage message.
