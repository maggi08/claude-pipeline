---
name: pipeline-init
description: Инициализировать stage-пайплайн в новом репозитории — изучить проект (стек, команды, dev-сервер, дизайн-токены, UI-lib, брейкпоинты, раскладку кода) и сгенерировать `.claude/pipeline.config.md`, из которого дальше читают все пайплайн-скиллы и агенты (feature-checker, stage-plan, stage-kickoff, stage-check, figma-spec, figma-compare, devtools-verify, pro-review), плюс разложить разрешения пайплайна (скиллы, MCP, безопасные команды, deny/ask) в user-скоуп `~/.claude/settings.json`, чтобы чекеры не спрашивали подтверждение на каждом шаге. Use ONCE per new project before running the pipeline, or when project setup changed. Делает пайплайн проект-агностичным.
---

# Pipeline Init — конфиг пайплайна под конкретный репозиторий

Цель: пайплайн-скиллы generic и не знают ничего про конкретный проект. Всё специфичное (пути, команды, источники правды) они читают из `<repo>/.claude/pipeline.config.md`. Эта команда изучает репозиторий и **генерирует этот конфиг**, чтобы в новом проекте пайплайн заработал в его контексте.

Запускать один раз на проект (или когда поменялся стек/команды/пути).

## Процедура

Исследуй репозиторий напрямую (Read/Glob/Grep), без фан-аута субагентов:

1. **Стек и пакет-менеджер** — `package.json` (deps: nuxt/vue/react/next/svelte/…; `packageManager`), lock-файл (`yarn.lock`→yarn, `pnpm-lock.yaml`→pnpm, `package-lock.json`→npm).
2. **Команды** — скрипты `dev`/`build`/`lint`/`type-check`(или `typecheck`)/`test` из `package.json`; `bundle_size` — скрипт `size`/`size-limit`/`bundlesize`/`bundle-size` там же, нет такого — `—`. Плюс команды по файлам этапа с `{files}` (их подставляет `run-check.mjs`, `${CLAUDE_PLUGIN_ROOT}/references/heavy-checks.md`): `lint_files` — линтер из devDependencies напрямую (`<pm> eslint {files}`, `<pm> biome check {files}`, `ruff check {files}`), `test_related` — `<pm> vitest related --run {files}` / `<pm> jest --findRelatedTests {files}`; прогони на одном файле и запиши рабочую форму, не завелось — `—`. Если type-check есть — предложи прогнать один раз и записать **baseline** число ошибок (в проектах бывает легаси-долг; чекеры сравнивают с baseline, а не с нулём). Два обязательных санити-чека:
   - **Монорепо: type_check реально покрывает каждый workspace?** Скрипты с топологическим порядком (`yarn workspaces foreach -t`, turbo/nx) МОЛЧА пропускают зависимые пакеты, когда падает их зависимость. Проверка: прямой `tsc -p <app>/tsconfig.json --noEmit` главного приложения vs вывод общего скрипта; подозрительно быстрый прогон (~секунды на большом приложении) = признак пропуска. В конфиг фиксируй ПРЯМУЮ per-workspace команду, не только общий скрипт (урок: одно из приложений монорепо не тайпчекалось ни локально, ни в CI — сломанный коммит прожил незамеченным).
   - **Baseline sanity.** Ненулевой baseline не принимай молча — прочитай сами ошибки. «Модуль X не экспортирует Y» про локальные пакеты (`file:`-tarball, workspace ui-lib) — чаще устаревшая установка, чем легаси-долг: проверь свежесть (дата tgz, версия vs исходники соседнего репо) и предложи переустановку ДО фиксации baseline (урок: «baseline 16+3» сутки считался командным долгом, оказался устаревшим tgz UI-кита).
3. **Статические анализаторы** — есть ли в репо детерминированный инструмент, который находит то, что чекеры иначе ищут грепом: `knip`, `ts-prune`, `unimported`, `depcheck`, `madge`. Ищи в devDependencies, в скриптах и в конфигах (`knip.json`, `.knip.*`, `.depcheckrc`, `.madgerc`). Нашёл — прогони один раз и запиши в конфиг ТОЧНУЮ рабочую команду; не запускается или шумит на весь репозиторий — пометь это прямо в конфиге. **Новую зависимость ради чекера не предлагай** — это решение владельца репо; разовый `npx`-прогон предложить можно, но в конфиг пиши только то, что в этом репо реально работает. Ничего нет — ставь `—`: `dead-code` и `deps-audit` тогда работают грепом, как и раньше.
4. **Dev-сервер** — из `dev`-скрипта + дефолты фреймворка (Nuxt 3000, Vite 5173, Next 3000) + признаки HTTPS (`ssl/`, `https:setup`, mkcert) → собери URL (протокол+хост+порт).
5. **Дизайн-источники правды** (для figma-compare/spec): токены/тема (`glob` по `**/theme/*`, `tokens*`, `design-tokens*`, `tailwind.config.*`), UI-библиотека (deps вида `@*/ui*`, префикс компонентов), брейкпоинты (из `tailwind.config`), иконки (папка + конвенция авто-импорта), i18n (`locales/`, i18n-конфиг, хелпер перевода).
6. **Раскладка кода** (для дедуп-аудита/feature-checker): `components/`, `composables/`|`hooks/`, `page-components/`, `store/`|`stores/`, `server/api/`, тесты. Отметь «эталон для сверки» (существующая реализация, с которой матчить редизайн), если пользователь назвал.
7. **Платформы/связанные репо** (опц.): один репо или мульти-контекст (desktop/adaptive/webview, соседние репозитории).
8. **MCP-зависимости — проверить.** Пайплайну для `figma-compare`/`figma-spec` нужен Figma MCP, для `devtools-verify` — Chrome DevTools MCP. Оба приезжают в `.mcp.json` плагина, поэтому подключать руками обычно не нужно — достаточно `claude mcp list` (ждём «✓ Connected») и разрешить серверы плагина, если Claude Code спрашивает подтверждение.
   - `figma` не подключается — это локальный сервер десктоп-Figma: приложение должно быть запущено, Dev Mode MCP Server включён (Figma → Preferences). Проверка порта: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3845/mcp`.
   - `chrome-devtools` поднимается сам через `npx` при первом вызове; нужен Node ≥ 18 и установленный Chrome.
   Не молчи о том, что требует действия пользователя. Проекту без Figma/UI-редизайна `figma` и `chrome-devtools` не нужны — не гоняй его настраивать их впустую.

9. **Разрешения — иначе пайплайн спрашивает подтверждение на каждом шаге.** Профиль разрешений лежит в плагине (`permissions/base.json`) и доливается в settings скриптом; записи `Skill(stage-pipeline:*)` и `mcp__*` он генерирует из самого плагина, так что новый скилл вписывать руками не надо.

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/permissions.mjs           # отчёт: чего не хватает (ничего не пишет)
   node ${CLAUDE_PLUGIN_ROOT}/scripts/permissions.mjs --apply   # дописать в ~/.claude/settings.json
   ```

   Порядок жёсткий: сначала прогон без флагов, **покажи пользователю список того, что добавится, и применяй только с его согласия** — это правка его личных настроек, а не файла в репо. Скрипт только доливает: чужих записей не трогает, `allow` не ставит поверх уже стоящих `deny`/`ask` (сообщает конфликтом), перед записью кладёт бэкап рядом.

   - **User-скоуп (по умолчанию) — правильное место.** Плагин включён во всех репозиториях; разрешения, положенные в `<repo>/.claude/settings.local.json`, придётся заводить заново в каждом новом проекте.
   - **Группы**: `pipeline` (скиллы + MCP), `fs-read`, `shell-tools`, `fs-write`, `vcs`, `js-toolchain`, `devserver` — по умолчанию; `docker`, `web` — по `--groups`. Пользователь не хочет широкий Bash-аллоулист — `--minimal` даёт только `pipeline`, остальное продолжит спрашиваться. `shell-tools` (`sed`, `awk`, `find`, `xargs`) вынесена из `fs-read` отдельно именно потому, что это не чтение: `sed -i` пишет файл, `find -exec` и `xargs` запускают произвольную команду — без неё набор честно read-only.
   - **Проектное — в project-скоуп, а не в общий профиль**: соседние репо и репо плагина (`--scope project --dirs ../ui-lib,../prototypes`, попадают в `additionalDirectories`) и нестандартные команды этого репо (`Bash(../../node_modules/.bin/tsc *)` в монорепо) — их допиши руками в `<repo>/.claude/settings.local.json`.
   - **`deny`/`ask` — часть профиля, не довесок.** `git push`, `reset --hard`, `git clean`, `gh`, `pkill` и чтение `.env` остаются вопросом; force-push, публикация пакета, деплой, `ssh`/`scp`/`rsync` и чтение `~/.ssh`, `~/.aws`, credentials — запрещены. На этих запретах стоит `/stage-force`: без них автономный прогон получает право публиковать.
   - **Скажи вслух, чем этот `deny` НЕ является.** Профиль разрешает `node`, `npx`, `python3` — то есть произвольное исполнение кода, и обойти любой запрет из списка тривиально. `deny` здесь защищает от случайной команды агента, а не от злонамеренной; пользователю, которому нужна настоящая граница, нужен sandbox, а не аллоулист. Обещать больше, чем профиль даёт, — хуже, чем не ставить его вовсе.
   - **`Bash(...)` — префиксное совпадение, пробел перед `*` литеральный.** `Bash(rm -rf dist *)` не покрывает `rm -rf dist` (нет аргумента после), зато покрывает `rm -rf dist /чужой/путь`; `Bash(curl -s http://localhost *)` не покрывает `curl -s http://localhost:3000/`. Дописывая проектные записи руками, проверь форму на реальной команде, а не на глаз.
   - Разрешения читаются при старте сессии — после `--apply` скажи пользователю перезапустить Claude Code, иначе он решит, что не сработало.

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
- main_branch: <dev | main | master>   # ветка, В КОТОРУЮ открывается PR (если PR идут в dev — dev, не main); merge-base для whole-branch pro-review, dead-code, wrapup

## Task state
- task_path: .claude/tasks/     # в репо: STAGES.md / specs/ / checks/ / DESIGN-QUESTIONS.md по тикетам
- memory_path: .claude/memory/  # в репо: проектная память (решения/грабли этого репо)

## Commands
- dev: <yarn dev>
- build: <yarn build>
- lint: <yarn lint>
- type_check: <прямая per-workspace команда, напр. cd apps/x && ../../node_modules/.bin/tsc -p tsconfig.json --noEmit>  # baseline: <N | не замерен>; общий монорепо-скрипт может молча пропускать workspace'ы (см. процедуру, п.2)
- test: <yarn test>
- lint_files: <yarn eslint {files} | —>        # lint по файлам этапа (run-check.mjs подставит изменённые); — → на этапе целиком `lint`
- test_related: <yarn vitest related --run {files} | yarn jest --findRelatedTests {files} | —>  # тесты, связанные с файлами этапа
- bundle_size: <команда, печатающая размер бандла, напр. `yarn build && du -sk dist` или `size-limit` | —>  # есть → stage-plan заводит metrics-baseline/metrics-guard; — → пунктов нет

## Models
- review_model: opus   # whole-branch pro-review и свежий прогон чекера в fix-loop — самая сильная модель; в force она ещё и не та, что у maker (`stage-implement` = sonnet); sonnet | opus | haiku

## Static analysis (dead-code / deps-audit)
<!-- Даёт КАНДИДАТОВ по всему репо; чекер пересекает вывод с дифом и подтверждает сам. -->
- unused_code: <yarn knip | npx ts-prune | —>          # осиротевшие экспорты, файлы, типы
- unused_deps: <yarn depcheck | yarn knip --dependencies | —>  # зависимости без импортов
- import_graph: <npx madge --circular <src> | —>       # циклы и граф импортов

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
2. Отчитайся по MCP (шаг 8): что подключено и живо, что требует действия пользователя (запустить Figma desktop, одобрить серверы плагина).
3. Покажи отчёт скрипта разрешений (шаг 9) и, получив согласие, примени его. Не применил — скажи прямо, что подтверждения будут спрашиваться на каждом чекере, и оставь готовую команду.
4. Нет CLAUDE.md — предложи Claude Code `/init`, чтобы pro-review было на что опереться.

С этого момента пайплайн-скиллы в этом репозитории читают `.claude/pipeline.config.md` и работают в его контексте. Порядок работы дальше — в `${CLAUDE_PLUGIN_ROOT}/README.md` (init → feature-checker → stage-plan → цикл этапов).
