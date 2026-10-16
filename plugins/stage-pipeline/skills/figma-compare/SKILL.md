---
name: figma-compare
description: Pixel-perfect comparison of implemented code (markup) with the Figma design — tokens, colors, spacing, radii, shadows, typography, layout structure (sources of truth from pipeline.config.md). Use when the user gives a Figma link (to a frame or node) and asks to check/compare the implementation, or as the check step of /stage-check. Static code ↔ design comparison (no browser). RU triggers — «сверь с макетом в фигме», «ссылка на ноду», «pixel perfect»
---

# Figma Compare — checking code against the design

Goal: find every divergence between the Figma node and the implementation. You are the **checker**, not the author: do not justify the code, look for divergences. Fix nothing — only the report (fixing is a separate step outside this skill).

> **Project config.** Take paths, sources of truth and `<task_dir>` from `<repo>/.claude/pipeline.config.md` (no file — ask to run `/pipeline-init`). Below, `<task_dir>` = the `task_path` field of the config (by default `<repo>/.claude/tasks/ (in the repo)`).

> **Task language.** The task has one language, the `Language: ru|en` line from the prompt (no line in the prompt — the STAGES.md header). Write the report in it; service markers come from the table in `${CLAUDE_PLUGIN_ROOT}/references/language.md`. The report samples below are the English forms.

## Input

- The Figma URL of a node/frame (one or several, each with its own state/screen).
- Code paths (page/components). If not given — take them from the "Orientation" block in the header of `<task_dir>/<TICKET>/FEATURE-MAP.md` (no need to read the whole map) or find them by the route.
- Which context is compared: desktop / adaptive / webview (it affects breakpoints and the repo).

## Figma tools (load via ToolSearch: "select:...")

| Tool | What for |
|---|---|
| `mcp__figma__get_design_context` | the main one: node structure, styles, values, bound variables |
| `mcp__figma__get_variable_defs` | all variables (tokens) of the node: colors, spacing, radius, typography |
| `mcp__figma__get_metadata` | the frame tree, sizes and positions of elements |
| `mcp__figma__get_screenshot` | the reference picture for an eye check of the structure |
| `mcp__figma__get_code_connect_map` | the existing Figma component ↔ code mapping |

## Sources of truth on the code side

Concrete paths come from `.claude/pipeline.config.md` (the "Design sources of truth" section). What to compare against:

- **DS semantic tokens**: the `tokens` file from the config — the mapping of classes (`bg-neutral-base`, `text-neutral-primary`, etc.) → palette + dark variants. If Figma has a variable, the code must have the matching token, not a raw hex.
- **Palette**: the `palette` file from the config (CSS variables `--color-*`) + the UI-lib preset, if given.
- **Breakpoints**: the `breakpoints` field of the config.
- **UI kit**: `ui_lib` from the config — if Figma uses a design-system component, the code must have the matching `UI*` component, not a home-made copy.
- Multi-context (desktop/adaptive/webview) — from the "Platforms" section of the config; webview has its own tokens/paths.

## Comparison order

1. Pull from Figma: variables (`get_variable_defs`), structure and styles (`get_design_context`, `get_metadata`), the screenshot.
2. Read the code: tailwind classes, scss, inline styles, props of `UI*` components. Resolve the classes into values through the configs above.
3. Compare by the checklist (below) — element by element, top to bottom along the node tree.

## Comparison checklist

- **Colors** — compare AT THE TOKEN LEVEL: if Figma has a variable (e.g. `text/neutral/secondary`), the code must have the matching semantic token, not a raw hex/palette — even when it matches visually this is a violation (it breaks in dark mode). A hardcoded hex = critical.
- **Typography**: size, weight, line-height, letter-spacing; the font Okta Neue.
- **Spacing**: margin / padding / gap (in Figma — auto-layout padding and item spacing).
- **Borders and radii**: border width/color, border-radius (per corner, if different).
- **Shadows**: box-shadow (all layers of the effect).
- **Sizes and positions**: widths/heights of fixed elements, alignment, element order; fill/hug in Figma ↔ flex-grow/fit-content in CSS.
- **Structure**: are all elements of the node in the code; are there extra ones; states (hover/active/disabled), if they are in the passed nodes.
- **DS components**: a library instance in Figma ↔ `UI*` in the code; compare the variant props (e.g. the variant of `UIButton`).
- **Copy/characters**: static UI copy (labels, buttons, headings, hints, empty-state, errors) — compare character by character; dynamic content — do NOT compare. Details in the "Text fidelity" section below.
- **Dark mode**: if a token has a dark variant, the class from tokens.ts already carries it; manual `dark:` over the raw palette is suspicious.

## Text fidelity — how to compare text (a frequent source of false findings)

Text from Figma breaks in two ways. Both were caught in practice — do not repeat them.

**Class A — placeholder vs real content.** Before flagging a text, classify the node:
- **Static UI copy** — fixed strings: buttons, headings, hints, empty-state, errors, labels. We compare it.
- **Dynamic content** — data-driven: prices, years, make/model names, counters, ranges. The value in Figma is a PLACEHOLDER, not copy.
- Signs of dynamic content/placeholder: round/repeating numbers (`2000`, `2000-2000`, `10 000 000`), sample names (`Kia Sport`), lorem, the node bound to a Figma variable/component-property, a data slot in `design_context`.
- The rule: **for dynamic content do not flag a content difference at all** (e.g. the Figma placeholder `2000` vs the real `2012 — 2015` is NOT a finding). Compare only the **format**, if the design specifies it (a mask, separators, the `₸` suffix). Static-vs-dynamic is unclear → write it into "Could not verify"/a question to the designer, do not assert.

**Class B — character accuracy.** The source of truth for characters = the text from `get_design_context` (the real `characters`), NOT a vision read of the screenshot (Cyrillic and small text are read with errors). The screenshot is only for understanding which state/variant is shown. design_context and the screenshot diverge → record the ambiguity, do not pick silently. Really check: the dash family (`-` hyphen / `–` en / `—` em), quotes (`«»` / `""`), `₸`, non-breaking space, `…` vs `...`.

**i18n.** Compare the Figma copy with the RESOLVED locale string (ru + kk from `locales/`), not with the key. An unfilled interpolation (e.g. `"Model {mark}"` rendered without the parameter) is a real bug, flag it. A key that resolves correctly but differs from the Figma placeholder is NOT a bug.

## Tolerances (severity)

| Severity | What |
|---|---|
| **critical** | wrong token/color, hex instead of a token, a missing/extra element, wrong UI component or variant, broken structure |
| **major** | a spacing/radius/shadow/typography divergence > 2px, wrong alignment |
| **minor** | ≤ 2px (px↔rem rounding), font rendering differences |

Do not flag: differences caused by **dynamic** content (real prices/years/names vs a Figma placeholder — see "Text fidelity"), text length, images, scrollbars, anti-aliasing. Compare static copy character by character against the resolved locale.

**The limits of a static checker** — always list them in "Could not verify", so that the orchestrator/user know the blind spots: animations and motion mechanics (checked only at runtime or against the mechanics spec), behavior at widths other than the mockup's (the responsiveness checker), hover/focus/active, dark mode when the mockup is light-only, the CSS classes actually generated (Tailwind arbitrary values may fail to build — visible only in the browser).

## Output: report

If `<task_dir>/<TICKET>/` exists — save to `checks/figma-compare-<stage>.md`, otherwise just print it.

```markdown
# Figma compare: <node> ↔ <files>
Findings: critical N · major N · minor N — PASS | N divergences

| # | AC | Element | Property | Figma | Code | Severity | Where |
|---|----|---------|----------|-------|-----|----------|-----|
| 1 | AC-2.4 | Button "Buy" | background color | token bg-accent-primary | bg-[#5B4DBE] (hex) | critical | src/components/BuyButton.tsx:12 |

## Stage criteria
(one line for every passed `AC-*`: `AC-2.1` — PASS, with the measured value | FAIL + exactly what does not match)

## Could not verify
(no access to the node, a dynamic state, etc. — list them honestly; nothing left — "everything verified")
```

Every row carries an exact `file:line` and the exact value from Figma (not "about"). If there are no divergences — an explicit PASS with the list of what was checked.
`AC` is the ID of the acceptance criterion from STAGES.md that this row closes (`AC-2.4`); no criterion for it — put `—`. Without the ID the second iteration of the fix loop does not understand what exactly is being rechecked, and the fixes drift from the plan.
