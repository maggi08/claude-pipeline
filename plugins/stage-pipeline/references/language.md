# Task language and service markers

Every task has one language: English (`en`) or Russian (`ru`). Nothing else is supported. The language decides what the model writes into the task directory; the hooks read both languages and behave the same on either.

## The rule

- **The language is a line in the STAGES.md header:** `Language: en` or `Language: ru` (an existing task may carry the Russian form of the field name, see the table below). It sits next to the other header fields (`Branch:`, `Updated:`).
- **A new task gets its language, in this order:** an explicit request of the user ("make the task in English") > `language:` in `pipeline.config.md` > the language of the message that started the task. Once the line is written it holds the language: later messages in another language do not change it.
- **Everything in the task directory is in the task language:** STAGES.md and its archive, `checks/` reports, FEATURE-MAP, TEST-PLAN, specs, the run summary.
- **The orchestrator passes the language to subagents in the prompt** ("Language: en"). A subagent writes its report in that language and takes service markers from the table below.
- **Changing the language of a task:** "translate the task to <language>" — change the `Language:` line and translate STAGES.md as a whole; the old reports in `checks/` stay as they are (the hooks read both languages). "Make <file> in <language>" — only that file changes; the line stays.
- **A task without the line** (made before this rule): the language follows from the headings. `## Journal` / `### Stage N` mean en; their Russian forms (the table below) mean ru (the hook `scripts/hooks/pipeline-state.mjs`, `taskLanguage`). If both sets are present, the one that appears earlier in the file wins; if neither is present, the language is unknown and the task is run in Russian, as before. Do not add the line to such a task unless the user asks.
- **Service markers are not translated on the fly.** Headings, field names and phrases that scripts read come from the table below — the column of the task language. Everything around them (finding text, journal entries, decisions) is free prose in the task language.

## Other languages

- **Chat** — in the language of the user, whatever the task language is.
- **Hook messages** — always English (the model reads them and retells them to the user in the user's language).
- **Commits and PR descriptions** — in the language of the repo's history, or as the user asks (`skills/stage-check/references/commit-message.md`).
- **A report not in the task language** is returned by journal-gate: the hook measures the share of Cyrillic in the prose of a new report (code, quotes, paths and ids do not count). A ru task needs it high enough, an en task low enough; rewrite the report in the task language.

## Marker table

The markers that scripts and hooks read from STAGES.md, `checks/`, the Force run block and `pipeline.config.md`, plus the FEATURE-MAP template (read by the model: `/feature-checker` reuses a map written in either language). Write the column of the task language. Unchanged in both languages: `[verify: …]`, `[live: …]`, `⏳`, `✅`, `❌`, `AC-*`, `B<n>`, `M-<n>`, `D<n>`, `PASS`, `FAIL`, checker names, pipeline line keywords (`kickoff`, `implement`, `user-review`, `commit:`, `metrics:`, `skip`), `[status: todo | in-progress | done | cancelled]`.

| Where | English | Russian |
|---|---|---|
| Header | `Language: en` | `Язык: ru` |
| Header | `Branch:` / `Branches:` | `Ветка:` / `Ветки:` / `Ветка задачи:` |
| Header, branch value: none | `none` | `нет` |
| Header, words after a branch name | `from`, `off`, `cut from`, `branched`, `rebased onto`, `base`, `merged` | `от`, `из`, `срезана`, `отведена`, `пересажена`, `база`, `влита` |
| Header | `Contexts:`, `Updated:` | `Контексты:`, `Обновлено:` |
| Status heading | `## Status: stage N of M — …` | `## Статус: этап N из M — …` |
| Status line, force run closed / open | `force run … completed` / `not completed` | `force-прогон … завершён` / `не завершён` |
| Section | `## Journal` | `## Журнал` |
| Section | `## Stages` | `## Этапы` |
| Section | `## Final checks (after all stages)` | `## Финальные проверки (после всех этапов)` |
| Section | `## Design source coverage` | `## Покрытие дизайн-источника` |
| Section | `## Shared elements (stage overlaps)` | `## Общие элементы (пересечения этапов)` |
| Section | `## ⚠ Awaiting user confirmation` | `## ⚠ Ожидают подтверждения пользователя` |
| Section | `## Not included in the plan` | `## Не включено в план` |
| Section, catch-up block (task-converge Step 5) | `## Catch-up <date>` | `## Догон <дата>` |
| Stage heading | `### Stage N: <name>  [status: …]` | `### Этап N: <название>  [status: …]` |
| Stage field | `Figma nodes:` | `Figma-ноды:` |
| Stage field | `What exists:` | `Что есть:` |
| Stage field | `What to do:` | `Что сделать:` |
| Stage field | `Reuse:` | `Переиспользовать:` |
| Stage field | `Match with adaptive/webview:` | `Матчить с adaptive/webview:` |
| Stage field | `Decisions:` | `Решения:` |
| Stage field (value none: `—`, `none`, `n/a`, `not needed`) | `Visual reference:` | `Эталон вида:` (none: `—`, `нет`, `n/a`, `не нужен`) |
| Stage field | `State × action:` | `Состояние × действие:` |
| Stage field, parity table | `Parity:` | `Паритет:` |
| Stage field | `Acceptance criteria:` | `Критерии приёмки:` |
| Stage field | `Pipeline:` | `Пайплайн:` |
| Stage line, kept when a stage is archived | `Commit:` | `Коммит:` |
| Decision line (also `D<n>`) | `Decision:`, `Decided`, `We decided` | `Решение:`, `Решено`, `Решили` |
| Archived stage stub | `Full record: STAGES-ARCHIVE.md — …` | `Полная запись: STAGES-ARCHIVE.md — …` |
| Journal preamble | `Older entries (N): STAGES-ARCHIVE.md — "Journal".` | `Старые записи (N): STAGES-ARCHIVE.md — «Журнал».` |
| Force block heading | `## Force run <date>` | `## Force-прогон <дата>` |
| Force heading, closed (`completed`, also `complete`, only before a date or `with blockers`, or at the end of the heading after a dash: "— complete the migration" is a title, not a close) | `## Force run <date> — completed` | `## Force-прогон <дата> — завершён` |
| Force heading, closed with open blockers | `… — completed with blockers` | `… — завершён с блокерами` |
| Force block field | `Mode:` | `Режим:` |
| Force block field | `Interview answers:` | `Ответы интервью:` |
| Force block field | `Assumptions:` | `Допущения:` |
| Force block field | `Unresolved:` | `Незакрытое:` |
| Force block field | `Boundaries:` | `Границы:` |
| Force block field (the line the hooks require) | `Confirmed: <date> — <what>` | `Подтверждено: <дата> — <что>` |
| Force block field | `Blockers:` | `Блокеры:` |
| Blocker line `B<n> — …` closed by the words | `lifted by`, `resolved by`, `closed by`, `answered by`, `user answer`, `user decision` (the last two lift a blocker only with a date or a quotation right after the words, with at most `on`, `dated`, `(`, `in chat`, a colon or a dash between them: "user decision 2026-10-17: v2", "user decision (2026-10-17): v2", `user answer "token is set"`; a request — `needs`, `waiting for`, `awaiting`, `pending` before the words, or quoted options `"v1" or "v2"` after them — does not lift) | `снят`, `решён`, `закрыт`, `отвечен`, `ответ пользователя`, `решение пользователя` (последние два снимают блокер только с датой или цитатой сразу после слов, между ними допустимы «от», «(», «в чате», двоеточие или тире: «решение пользователя 17.10.2026», «решение пользователя от 17.10.2026», `ответ пользователя «токен задан»`; запрос — «нужно», «необходимо», «ждём», «ожидаем» перед словами или варианты в кавычках `«v1» или «v2»` после них — не снимает) |
| Blocker line, a final whole-task report missing or stale when the run closes "completed with blockers" (the hook reads only the marker, never prose about the checker; either state names the report) | `[final: pro-review — not run]`, `[final: task-converge — stale]` | `[final: pro-review — не запускался]`, `[final: task-converge — устарел]` (the brackets, `final:`, the report name and `—` are the same; only the state is in the task language) |
| Report, line 2 | `Findings: critical N · major N · minor N` | `Находки: critical N · major N · minor N` |
| devtools-verify report line (new reports) | `doctor: <verdict of verify-doctor>` | `окружение: <вердикт verify-doctor>` (the verdict text itself, `doctor: ok` / `wrong app` / `down` / `no dev url` / `no config` / `error`, is printed by the script and stays as it is) |
| devtools-verify report line (new reports) | `auth: ok \| not logged in — <route> → <observed> \| not needed` | `вход: ок \| нет входа — <маршрут> → <что видно> \| не нужен` |
| Deferral to the user, criterion line | `[live: user-side — <prerequisite>; <route> → <observed>]` | `[live: user-side — <что мешало>; <маршрут> → <что видно>]` (the tag, `—`, `;` and `→` are the same; only the words inside are in the task language; a bare `[live: user-side]` on a new line is rejected in both) |
| Decision line, new (Awaiting, assumption) | `Rollback: <what undoing it costs>` | `Откат: <во что обойдётся откат>` |
| Decision line, new (Awaiting, assumption) | `Basis: <path:line \| node-id \| URL \| a quote \| D<n> / A<n> / AC-<n> \| guess>` | `Основание: <path:line \| node-id \| URL \| цитата \| D<n> / A<n> / AC-<n> \| догадка>` |
| Report section | `## Findings outcome` | `## Итог находок` |
| Verdict line, criterion not reached | `not checked` | `не проверено` |
| Report section | `## Could not verify` | `## Не удалось проверить` |
| Findings outcome | `fixed: <file:line or the recheck>` | `исправлено: <file:line или чем перепроверено>` |
| Findings outcome | `false: <proof>` | `ложная: <доказательство>` |
| Findings outcome | `B<n>` | `B<n>` |
| Findings outcome, normal mode | `user decision <date or "quote">` | `решение пользователя <дата или «цитата»>` |
| Could-not-verify section, nothing left | `everything verified` | `всё проверено` |
| dead-code report summary | `N to remove` | `N удалить` |
| Config `pipeline.config.md` | `## CI gates` | `## Гейты CI` |
| Config gate command: none | `none` | `нет` |
| Config field, kit overrides off | `kit_overrides: off` (also `false`, `no`, `disabled`) | `kit_overrides: нет` |
| Config field | `language: en` | `language: ru` |
| FEATURE-MAP header | `# Feature map: …` / `Date:` / `Repos:` / `Base:` | `# Feature map: …` / `Дата:` / `Репо:` / `База:` |
| FEATURE-MAP section (read by figma-compare, proto-compare, stage-force, stage-implement) | `## Orientation` | `## Ориентация` |
| FEATURE-MAP Orientation fields | `Essence:`, `Entry points:`, `Data:`, `Flags:`, `Careful:` | `Суть:`, `Точки входа:`, `Данные:`, `Флаги:`, `Осторожно:` |
| FEATURE-MAP sections | `## Entry points`, `## Data architecture`, `## Platform matrix`, `## Webview bridges`, `## Risk zones`, `## Reuse candidates` | `## Точки входа`, `## Архитектура данных`, `## Матрица платформ`, `## Webview-бриджи`, `## Зоны риска`, `## Кандидаты на переиспользование` |
