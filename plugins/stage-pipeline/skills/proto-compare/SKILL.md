---
name: proto-compare
description: Comparison of implemented code with a FILE-based design source — an HTML prototype from a prototype repo ("our Figma" in projects without Figma) — tokens, spacing, radii, typography, structure, copy, plus behavior per SPEC.md (transitions/CTAs/guards). Use as the design-check step of /stage-check in repos whose pipeline.config.md declares a prototype design source (Checker overrides), or when the user asks to check the implementation against a prototype. Static code ↔ prototype comparison (no browser). RU triggers — «сверь с HTML-прототипом», «совпадает ли экран с прототипом»
---

# Proto Compare — checking code against the prototype

Goal: find every divergence between the prototype (HTML/CSS + SPEC.md) and the implementation. You are the **checker**, not the author: do not justify the code, look for divergences. Fix nothing — only the report.

> **Project config.** Paths, sources of truth and `<task_dir>` come from `<repo>/.claude/pipeline.config.md` (the "Design sources of truth" section — the fields `design_source`, `design_snapshot`, `spec`, `tokens`, `ui_lib`, `breakpoints`, `i18n` — and "Checker overrides"; no file — ask to run `/pipeline-init`). The comparison methodology is the same as in `${CLAUDE_PLUGIN_ROOT}/skills/figma-compare/SKILL.md` (token-first, severity, text fidelity) — this skill describes how a file-based design source differs from Figma MCP.

> **Task language.** The task has one language, the `Language: ru|en` line from the prompt (no line in the prompt — the STAGES.md header). Write the report in it; service markers come from the table in `${CLAUDE_PLUGIN_ROOT}/references/language.md`. The report samples below are the English forms.

## Input

- Feature/stage → the prototype's flow files and screen-id (if not given — find them by the "prototype file → spec section" table in the SPEC.md header).
- Code paths (page/components). If not given — from the "Orientation" block in the header of `<task_dir>/<TICKET>/FEATURE-MAP.md` (no need to read the whole map) or by the route.
- Context/form factor (mobile / desktop / embedded widget / kiosk, etc.) — prototypes usually have separate files per form factor.

## Sources of truth

**The design side** (the prototype repo, the `design_source` path from the config):
- `SPEC.md` — behavior: states, transitions, CTA decision tables, timings, guard conditions. The screen-id table = the registry of hashes `flow-*.html#screen-id`.
- `flow-*.html` + the flow's CSS — visual: structure, values, classes. Read selectively (grep by `id="screen-id"`, the screen block), the files are large.
- Prototypes are usually built on the project's tokens — the CSS variables match the app; check against `tokens` from the config.

**The code side** (from the config): `tokens`, `ui_lib` (+ the default styles of ui-lib components — wrappers add their own paddings), `breakpoints`, the `i18n` locales.

## Comparison order

0. **The rendered variant — before reading any CSS.** Read the opening `<html>`/`<body>` tag of the flow file and write out all its classes; check whether the toggle script is connected (`grep -n "toggle" <flow>.html` — not connected means the baked-in class is the only one, the toggle is dead); find the `html.<class>`/`body.<class>` blocks in the CSS — they **win** over the base rules on all the properties they touch. Comparing the code with base rules overridden by such a block is a false comparison as a whole: both "matched" and "did not match" are equally unreliable. A self-describing comment in the CSS ("baked onto \<html\>", "the only version", "deprecated") is more authoritative than the README and SPEC — quote it with `file:line` in the report.
   If the implementation is built on the overridden base rules — this is **one** critical finding for the whole screen ("the wrong skin is implemented: X instead of Y, override `<css>:NNN`"), not twenty about each gradient, shadow and blur separately: it is fixed by one decision, and splitting it hides the cause behind the symptoms.
1. SPEC.md: the feature section → the list of screens/states and the expected behavior.
2. HTML/CSS: for each screen-id — structure and values (classes → CSS rules).
3. Code: classes/styles/props of ui-lib components. Resolve them into values.
4. Compare by the checklist, element by element, top to bottom.
5. **The element inventory — in both directions and across all states.** Build a table "element × state/form factor: present/absent in the prototype ↔ present/absent in the code" and check BOTH directions: not only "what is missing", but also "what is extra". An extra element almost never looks like a defect in a screen-by-screen comparison — it looks like a normal element, just in a state where the prototype does not draw it. Two common kinds: one block rendered in two places of the markup (the mobile and the desktop branch) and visible twice on a wide screen; chrome (a legal footer, a language pill, a badge) rendered in all states although the prototype gives it in some.

## Checklist

All of the figma-compare checklist: **colors at the token level** (the prototype's `var(--x)` ↔ the matching token/class in the code, a raw hex in the code = critical), **typography**, **spacing/gap**, **borders/radii**, **shadows**, **sizes/element order**, **structure/states**, **DS components** (a home-made copy where a ui-lib analog exists = critical), **dark mode** (the token carries the dark variant itself).

Specifics of a prototype source:
- **Look — from the kit and the reference, not from the prototype.** Typography (weight, size, case, tracking), button sizes, the look of tables and section spacing are compared with `ui_lib` and the stage's "Visual reference" (the neighboring section, STAGES.md); the prototype sets structure, texts and behavior. The code matched the prototype but not the kit and the reference — major "look from the prototype instead of the kit", if STAGES.md has no user decision "look as in the prototype". The prototype differs from the kit and the code took the kit — not a finding but a line "prototype ≠ kit: …" in the report. Precedent: the prototype's "uppercase 11px extrabold" matched the code, the comparison gave PASS, and "too bold" and "a different table" were returned by the user after "done".
- **Behavior by SPEC.md — the statically checkable part**: the presence of transitions (routes/handlers), CTA labels and their conditions (decision tables), guard conditions, error/empty/loading states. Timings and animations are NOT checked statically — into the blind spots (devtools-verify).
- **A hex in the prototype itself** (without a CSS variable): compare the value and check whether a fitting token exists in the DS — if so, the code must have the token (and mark the prototype's divergence from the DS as a question to the designer).
- **Proposal vs current**: if a feature has two prototype variants — which one we compare must be told by the prompt/STAGES.md. Unclear → escalate, do not choose silently.
- **The sync contract and the precedence order.** The sources diverge regularly, because they are updated at different paces. The order: **rendered HTML+CSS > SPEC.md > README**. HTML/CSS is what the designer actually delivered and what can be opened in a browser; SPEC describes the intent and lags; the README is rationale and over-promises most of all. Resolve a visual divergence in favor of the CSS and write it to the report as "SPEC §N is stale relative to `<css>:NNN`"; escalate a behavioral divergence (a transition, a CTA condition, a timing) — there HTML is not authoritative, because the prototype only imitates behavior. The wording "compare against both with a note" is forbidden: it leaves the choice to the implementer and surfaces later as an edit from the user.
- **The design source can change in the middle of a task.** The prototype repo lives its own life: a designers' commit renames/merges flow files and redoes screens. Before comparing, check `git -C <design_source> log --oneline -5 -- <flow file>` and compare with the prototype commit recorded in the STAGES.md header. They diverged → this is not a finding on the code but a replan: tell the orchestrator in a separate line "source updated: <was> → <now>" before issuing the divergences, otherwise the whole report will be about a design version that does not exist.
- **Source freshness**: the config declares both an external `design_source` and a `design_snapshot` committed to the repo, and they diverge on the needed flow → the truth is in the external one; mark the divergence in the report.

## Text fidelity

- **Static copy** (labels, buttons, headings, hints, empty-state, errors) — character by character: dashes/quotes/`…`/nbsp. The source is the HTML text (not screenshots, vision is not needed).
- **Mock data** (names, titles, dates, counters, prices) — do NOT compare the values, only the format, if it is specified.
- **i18n**: the language of the prototype copy = the reference locale. Compare with the RESOLVED string of this locale from `i18n` of the config, not with the key. A hardcoded string instead of the translation helper = critical (if the project is multilingual). For the other locales — check that the key exists.

## Severity

As in figma-compare: **critical** — wrong token/hex instead of a token, a missing/extra element/screen/transition, a home-made component instead of ui-lib, hardcoded copy without i18n; **major** — spacing/radius/shadow/typography > 2px, wrong alignment, a wrong CTA label/condition; **minor** — ≤ 2px, font rendering.

Do not flag: mock data, text length, placeholder images, scrollbars, anti-aliasing, **the prototype's service chrome** (floating nav, scenario chips, event console, design/embed toggles — these are the prototype's tools, not the design).

**Before issuing each finding, resolve the cascade to the end.** A value taken from the first matching rule is not the element's value. Check: is there a rule further down in the same file on the same selector (the last wins), is there a more specific selector, is there an `html.<skin>` override (step 0), is there a media query for the needed form factor, and is the CSS variable itself overridden closer to the element — a token can be reassigned in a component block, and then `var(--radius)` there means something different from `:root`. An unresolved cascade gives false criticals in both directions, and the price of a false critical is higher than the price of a missed minor: the orchestrator spends a cycle refuting it and starts distrusting the whole report.

**The blind spots of a static check** — list them in "Could not verify": timings/auto-advance/animations (SPEC specifies them — checked by devtools-verify, which can open the prototype in a browser next to the app for a side-by-side), hover/focus, responsive behavior between breakpoints, the CSS classes actually generated.

**Arbitrary values ≠ compiled CSS.** A class in the source is no guarantee that the utility made it into the bundle: Tailwind silently drops arbitrary values it considers ambiguous (plugins like tailwindcss-animate duplicate `duration`/`delay`/`ease` → `delay-[220ms]`/`duration-[280ms]`/`ease-[…]` are not generated; the same happens with `shadow-[var(…)]`). The lesson: the fades "passed" the static comparison by class names, but in reality ran at the default 150ms. So list every arbitrary-value transition/animation/shadow class from the diff BY NAME in "Could not verify" as a mandatory runtime item for devtools-verify (the computed value, not the presence of the class).

## Output: report

`<task_dir>/<TICKET>/checks/proto-compare-<stage>.md` (no task directory — just print it).

```markdown
# Proto compare: <flow file#screen-id> ↔ <code files>
Findings: critical N · major N · minor N — PASS | N divergences

| # | AC | Element | Property | Prototype | Code | Severity | Where |
|---|----|---------|----------|----------|-----|----------|-----|
| 1 | AC-2.4 | CTA "Continue" | background color | var(--primary) | bg-[#385bf8] (hex) | critical | src/pages/X/Btn.tsx:12 |

## Stage criteria
(one line for every passed `AC-*`: `AC-2.1` — PASS, with the measured value | FAIL + exactly what does not match)

## Behavior (SPEC §N)
(transitions/CTA conditions: what matched, what did not)

## Could not verify
(timings, hover, sync divergences, etc. — list them honestly; nothing left — "everything verified")
```

Every row carries an exact `file:line` and the exact value from the prototype. No divergences — an explicit PASS with the list of what was checked.
`AC` is the ID of the acceptance criterion from STAGES.md that this row closes (`AC-2.4`); no criterion for it — put `—`. Without the ID the second iteration of the fix loop does not understand what exactly is being rechecked, and the fixes drift from the plan.
