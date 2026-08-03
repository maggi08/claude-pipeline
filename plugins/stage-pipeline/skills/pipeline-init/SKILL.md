---
name: pipeline-init
description: Инициализировать stage-пайплайн в новом репозитории — изучить проект (стек, команды, dev-сервер, дизайн-токены, UI-lib, брейкпоинты, раскладку кода) и сгенерировать `.claude/pipeline.config.md`, из которого дальше читают все пайплайн-скиллы и агенты (feature-checker, stage-plan, stage-kickoff, stage-check, figma-spec, figma-compare, devtools-verify, pro-review). Use ONCE per new project before running the pipeline, or when project setup changed. Делает пайплайн проект-агностичным.
---

# Pipeline Init — конфиг пайплайна под конкретный репозиторий

Цель: пайплайн-скиллы generic и не знают ничего про конкретный проект. Всё специфичное (пути, команды, источники правды) они читают из `<repo>/.claude/pipeline.config.md`. Эта команда изучает репозиторий и **генерирует этот конфиг**, чтобы в новом проекте пайплайн заработал в его контексте.

Запускать один раз на проект (или когда поменялся стек/команды/пути).

## Процедура

Исследуй репозиторий напрямую (Read/Glob/Grep), без фан-аута субагентов:

1. **Стек и пакет-менеджер** — `package.json` (deps: nuxt/vue/react/next/svelte/…; `packageManager`), lock-файл (`yarn.lock`→yarn, `pnpm-lock.yaml`→pnpm, `package-lock.json`→npm).
2. **Команды** — скрипты `dev`/`build`/`lint`/`type-check`(или `typecheck`)/`test` из `package.json`. Если type-check есть — предложи прогнать один раз и записать **baseline** число ошибок (в проектах бывает легаси-долг; чекеры сравнивают с baseline, а не с нулём). Два обязательных санити-чека:
   - **Монорепо: type_check реально покрывает каждый workspace?** Скрипты с топологическим порядком (`yarn workspaces foreach -t`, turbo/nx) МОЛЧА пропускают зависимые пакеты, когда падает их зависимость. Проверка: прямой `tsc -p <app>/tsconfig.json --noEmit` главного приложения vs вывод общего скрипта; подозрительно быстрый прогон (~секунды на большом приложении) = признак пропуска. В конфиг фиксируй ПРЯМУЮ per-workspace команду, не только общий скрипт (урок IT-5236: guestapp не тайпчекался ни локально, ни в CI — сломанный коммит прожил незамеченным).
   - **Baseline sanity.** Ненулевой baseline не принимай молча — прочитай сами ошибки. «Модуль X не экспортирует Y» про локальные пакеты (`file:`-tarball, workspace ui-lib) — чаще устаревшая установка, чем легаси-долг: проверь свежесть (дата tgz, версия vs исходники соседнего репо) и предложи переустановку ДО фиксации baseline (урок IT-5236: «baseline 16+3» сутки считался командным долгом, оказался устаревшим ui-kit tgz).
3. **Dev-сервер** — из `dev`-скрипта + дефолты фреймворка (Nuxt 3000, Vite 5173, Next 3000) + признаки HTTPS (`ssl/`, `https:setup`, mkcert) → собери URL (протокол+хост+порт).
4. **Дизайн-источники правды** (для figma-compare/spec): токены/тема (`glob` по `**/theme/*`, `tokens*`, `design-tokens*`, `tailwind.config.*`), UI-библиотека (deps вида `@*/ui*`, префикс компонентов), брейкпоинты (из `tailwind.config`), иконки (папка + конвенция авто-импорта), i18n (`locales/`, i18n-конфиг, хелпер перевода).
5. **Раскладка кода** (для дедуп-аудита/feature-checker): `components/`, `composables/`|`hooks/`, `page-components/`, `store/`|`stores/`, `server/api/`, тесты. Отметь «эталон для сверки» (существующая реализация, с которой матчить редизайн), если пользователь назвал.
6. **Платформы/связанные репо** (опц.): один репо или мульти-контекст (desktop/adaptive/webview, соседние репозитории).
7. **MCP-зависимости — проверить.** Пайплайну для `figma-compare`/`figma-spec` нужен Figma MCP, для `devtools-verify` — Chrome DevTools MCP. Оба приезжают в `.mcp.json` плагина, поэтому подключать руками обычно не нужно — достаточно `claude mcp list` (ждём «✓ Connected») и разрешить серверы плагина, если Claude Code спрашивает подтверждение.
   - `figma` не подключается — это локальный сервер десктоп-Figma: приложение должно быть запущено, Dev Mode MCP Server включён (Figma → Preferences). Проверка порта: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3845/mcp`.
   - `chrome-devtools` поднимается сам через `npx` при первом вызове; нужен Node ≥ 18 и установленный Chrome.
   Не молчи о том, что требует действия пользователя. Проекту без Figma/UI-редизайна эти MCP не нужны — не гоняй его настраивать их впустую.

## Выход: `.claude/pipeline.config.md`

Создай `<repo>/.claude/pipeline.config.md` по шаблону ниже. Заполни обнаруженным; неуверенные значения помечай `# TODO: подтвердить`. `slug` = имя корневой папки репо.

**Раскладка «репо-локально» (по умолчанию):** всё, что связано с задачами и проектной памятью, живёт В РЕПО, под `<repo>/.claude/` — так метаданные хранятся рядом с кодом, делятся по тикетам и (если нужно) едут в git/команду. Сами скиллы и агенты в репо не копируются — они приезжают плагином `stage-pipeline` и работают во всех репо.
- `task_path` по умолчанию `<repo>/.claude/tasks/` — STAGES.md/specs/checks/DESIGN-QUESTIONS по тикетам.
- `memory_path` по умолчанию `<repo>/.claude/memory/` — проектная память (решения/грабли/договорённости этого репо). ⚠ Это НЕ харнесс-автопамять `~/.claude/projects/...` (та по системному пути, авто-вспоминается и остаётся для кросс-репных user-префов) — репо-локальную память пайплайн читает явно в начале задачи.
- Скриншоты чекеров тяжёлые — добавь `<repo>/.claude/tasks/**/checks/screens/` в `.gitignore`, если задачи коммитятся.

```markdown
# Pipeline config — <project>
<!-- Читается пайплайн-скиллами. Правь руками при изменении проекта. -->

## Project
- slug: <repo-basename>
- stack: <напр. Nuxt 4 / Vue 3 / Pinia / TS>
- package_manager: <yarn 1.x | npm | pnpm>
- main_branch: <dev | main | master>   # PR-таргет; merge-base для дифа

## Task state
- task_path: .claude/tasks/     # в репо: STAGES.md / specs/ / checks/ / DESIGN-QUESTIONS.md по тикетам
- memory_path: .claude/memory/  # в репо: проектная память (решения/грабли этого репо)

## Commands
- dev: <yarn dev>
- build: <yarn build>
- lint: <yarn lint>
- type_check: <прямая per-workspace команда, напр. cd apps/x && ../../node_modules/.bin/tsc -p tsconfig.json --noEmit>  # baseline: <N | не замерен>; общий монорепо-скрипт может молча пропускать workspace'ы (см. процедуру, п.2)
- test: <yarn test>

## Dev server
- url: <https://localhost:3000>        # протокол+хост+порт для devtools-verify

## Design sources of truth (figma-compare / figma-spec)
- tokens: <config/theme/tokens.ts | —>
- palette: <config/theme/colors.ts | —>
- ui_lib: <@scope/ui-lib, префикс UI*, компоненты в node_modules/.../runtime/components/ | —>
- breakpoints: <xs ≤420, sm ≤767, md ≤1023, lg ≥1024 — из tailwind.config | —>
- icons: <assets/icons/ авто-импорт, префикс Icon* | —>
- i18n: <locales/ (ru, kk), useLang() | —>

## Code layout (dedup audit / feature-checker)
- components: <components/>
- composables: <composables/ | hooks/>
- page_components: <page-components/<page>/ | —>
- stores: <store/ | stores/ | —>
- server_api: <server/api/ | —>
- tests: <tests/ | —>
- reuse_baseline: <существующая реализация для сверки, напр. components/<feature>/ | —>

## Platforms / related repos (опц., мульти-контекст)
- desktop: <this repo | —>
- adaptive: <this repo | —>
- webview: <../<webview-repo> | —>

## Conventions
- Конвенции проекта — в CLAUDE.md (pro-review рубрика A читает его). Нет CLAUDE.md — предложи `/init`.
```

## После генерации

1. Покажи пользователю заполненный конфиг и **спроси про поля, которые не удалось определить** (dev-URL, эталон переиспользования, baseline type-check, webview-репо).
2. Отчитайся по MCP (шаг 7): что подключено и живо, что требует действия пользователя (запустить Figma desktop, одобрить серверы плагина).
3. Нет CLAUDE.md — предложи Claude Code `/init`, чтобы pro-review было на что опереться.

С этого момента пайплайн-скиллы в этом репозитории читают `.claude/pipeline.config.md` и работают в его контексте. Порядок работы дальше — в `${CLAUDE_PLUGIN_ROOT}/README.md` (init → feature-checker → stage-plan → цикл этапов).
