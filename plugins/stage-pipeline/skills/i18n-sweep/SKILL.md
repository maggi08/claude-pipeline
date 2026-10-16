---
name: i18n-sweep
description: Узкий проход по интернационализации дифа — хардкод пользовательского текста, неполные локали, динамически склеенные ключи, форматирование дат и чисел без локали. Use as a checker step of /stage-check или перед PR в проектах с i18n. Не ищет баги — для этого /pro-review.
---

# i18n sweep — copy and locales

The goal is narrow: no string the user sees must be hardcoded in the code, and no language of the project must silently stay without a translation.

> **Project config.** The translation mechanism, the dictionary paths and the list of languages are the `i18n` field in `<repo>/.claude/pipeline.config.md`. No field — detect it from the code (which helper is called in the neighbouring files) and say so in the report. Do not impose a foreign mechanism on the project.

## Scope

The diff of the stage (from `/stage-check`) or the whole branch (before the PR). Plus the dictionary files — look at them separately from the code.

## What to look for

1. **Hardcoded user-facing text** — literals in JSX/templates, `placeholder`, `title`, `aria-label`, `alt`, button texts, headings, error messages, toasts.
2. **Incomplete locales.** A key was added to one language of the project's list and forgotten in the others. The reverse case is a finding too: the key is everywhere but used nowhere — usually a leftover of a removed copy.
3. **Dynamically concatenated keys** (`t('errors.' + code)`). They are invisible to checks and pruners that work by literals, and one day they will be cut out as unused. Suggest an explicit map.
4. **Formatting without a locale.** `Intl.*`, `toLocaleDateString`, `toLocaleString` and wrappers over them without an explicit locale argument silently fall back to English, not to an error. Check currency and time zone too, where they are present.
5. **A translation assembled from pieces.** `t('you selected') + count + t('cars')` breaks with another word order and case endings — use interpolation, `t('selected', { count })`, and the library's plural forms.
6. **Hand-made pluralization**: a two-way ternary is wrong for ru, kk, pl, ar (three or more plural categories) even if it looks right in English — ru needs three forms, «товар, товара, товаров»; use the library's mechanism.

## What NOT to flag

- Internal identifiers, analytics keys, event names, test data.
- Log messages and error texts that only the developer sees.
- The locale tag INSIDE an `Intl` call — that is not copy but a parameter.
- Proper names and brands, if they are not translated in the project.
- Strings on service screens, if the project explicitly decided not to translate them (check the neighbouring files before you flag).

## Confirmation

- Before calling a string hardcoded — make sure it really reaches the screen. A literal in a prop that is then passed to `t()` is not a finding.
- Before calling a key missing — check the project's fallback mechanism: in some libraries a key is inherited from the default language, and that is a deliberate strategy.
- Before suggesting a new key — look for an existing one with the same text: duplicate keys litter the dictionary no less than hardcode.

## Report

Into `<task_dir>/<TICKET>/checks/i18n-sweep-<stage>.md` (before the PR — `i18n-sweep-branch.md`) and compactly to the orchestrator. The report follows the common contract `${CLAUDE_PLUGIN_ROOT}/references/checker-report.md`, written in the task language:

```markdown
# i18n sweep: <stage or branch>
Findings: critical N · major N · minor N

| # | Finding | file:line | Class | Suggested key / fix |
|---|---------|-----------|-------|---------------------|
```

The class is one of: `hardcode`, `incomplete locale`, `dynamic key`, `format without locale`, `concatenation`, `pluralization`.

Separately: a summary by language ("ru: +12 keys, kk: +12, en: −3 missing") and the "deliberately not translated" section, then the "Could not verify" section (nothing left — "everything verified"). Nothing found — say so straight and list what you looked at.
