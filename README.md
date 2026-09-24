# claude-pipeline

Личный маркетплейс Claude Code: плагины, которые я подключаю к своим проектам.

## Плагины

| Плагин | Что делает |
|---|---|
| [`stage-pipeline`](plugins/stage-pipeline/README.md) | Поэтапный maker/checker-workflow для крупных UI-задач: разбивка на этапы, спека из дизайна, проверки субагентами (Figma/прототип, рантайм, код-ревью), журнал состояния в файлах |

## Установка

Репозиторий публичный, поэтому ставится на любой машине без доступов и без клонирования:

```bash
claude plugin marketplace add maggi08/claude-pipeline
claude plugin install stage-pipeline@magzhan
```

То же самое настройками, если раскладывать не руками:

```json
{
  "extraKnownMarketplaces": {
    "magzhan": { "source": { "source": "github", "repo": "maggi08/claude-pipeline" } }
  },
  "enabledPlugins": { "stage-pipeline@magzhan": true }
}
```

Это `~/.claude/settings.json` — плагин включён во всех репозиториях. Нужен только в одном — те же команды с `--scope project`, попадут в `<repo>/.claude/settings.json`; тогда убедись, что `.gitignore` не глотает `.claude/` целиком: `.claude/*` + `!.claude/settings.json`.

Обновление: `claude plugin update stage-pipeline` (подтянет свежий `main`). После установки и обновления — перезапуск Claude Code. Что изменилось между версиями и что нужно сделать руками на апгрейде — в [CHANGELOG.md](CHANGELOG.md).

**Ветки.** `main` — прод: с неё ставится и обновляется плагин у всех, поэтому в неё попадает только проверенное с поднятой версией. Эксперименты живут локально (маркетплейс из папки — ниже) или в отдельной `dev`-ветке; отдельной «стабильной» ветки нет и не нужно.

Раскатка на команду — каталог в GitLab, который ссылается на этот репозиторий: [ROLLOUT.md](ROLLOUT.md).

Проверка, что доехало: `claude plugin details stage-pipeline` — должен показать 18 скиллов, 12 агентов, 3 MCP-сервера. Дальше `/pipeline-doctor` в целевом репо проверит окружение (MCP, dev-сервер, baseline).

### Режим разработки — маркетплейс из локального клона

На машине, где плагин правится, удобнее читать маркетплейс прямо из папки: правишь скилл → `claude plugin update stage-pipeline` → изменение доехало, пушить необязательно.

```bash
git clone https://github.com/maggi08/claude-pipeline.git
cd claude-pipeline
claude plugin marketplace add "$PWD"
claude plugin install stage-pipeline@magzhan
```

В `settings.json` запишется `source: directory` с абсолютным путём — то есть привязка к этой машине. Это нормально для машины разработки и не годится для остальных: там ставь из GitHub. Переключить уже установленный маркетплейс с одного источника на другой: `claude plugin marketplace remove magzhan`, затем `add` с нужным источником.

## Разработка

```
.claude-plugin/marketplace.json   каталог: какие плагины отдаёт этот репо
plugins/<name>/
  .claude-plugin/plugin.json      манифест плагина (name, version, description)
  skills/<name>/SKILL.md          скиллы (вызываются как /<name>)
  skills/<name>/references/       прецеденты правил — для того, кто правило меняет, не для исполнения
  agents/<name>.md                субагенты-чекеры
  hooks/hooks.json                хуки плагина (git-guard, session-start)
  scripts/                        permissions / archive-stages / retro и скрипты хуков
  .mcp.json                       MCP-серверы, которые приезжают с плагином
  README.md                       документация плагина
evals/cases/<name>/               фикстуры с заложенными дефектами для scripts/eval.mjs
```

Правила:

- **Никакой проектной специфики в скиллах.** Плагин включён во всех репозиториях; правила конкретного проекта живут в его `CLAUDE.md` или `.claude/pipeline.config.md → Conventions`. Проверено на практике: рубрика одного проекта в глобальном скилле давала ложные Major в другом.
- **Пути внутри плагина — через `${CLAUDE_PLUGIN_ROOT}`**, не через `~/.claude/`. Иначе кросс-ссылки скилл→агент ведут в пустоту, как только плагин переезжает.
- **Никаких секретов в `.mcp.json`** — только локальные/публичные эндпоинты; внешний эндпоинт обязан быть описан в ROLLOUT.md (это проверяет валидатор).
- **Прецедент — в `references/precedents.md`, правило — одной строкой в `SKILL.md`.** Бюджет — 30 KB на скилл; валидатор его держит.
- **Имена продуктов** из своих проектов перечисли в локальном `.product-denylist` (в `.gitignore`) — валидатор не пустит их в скиллы. Айди тикетов ловятся и без него.

Порядок работы: ветка `dev` (или фича-ветка) → PR в `main`. `main` — прод, прямые пуши в него обходят проверку релиза.

Перед PR:

```bash
node scripts/validate.mjs                         # структура, ссылки, бюджеты, CHANGELOG
node scripts/release-check.mjs origin/main        # плагин изменён → версия поднята и есть раздел CHANGELOG
claude plugin validate . --strict
claude plugin validate ./plugins/stage-pipeline --strict
node scripts/eval.mjs                             # если менялись агенты: реальные прогоны, $0.1–0.3 за кейс
```

Сравнение моделей на тех же кейсах — `node scripts/eval.mjs --runs 3 --model i18n-sweep=haiku i18n-hardcode`: копия плагина с переписанным `model:` у агента, в сводке — доля прохождений, реальная модель из `modelUsage` и стоимость прогона. Кейсы с Context7 пропускаются без `CONTEXT7_API_KEY`.

GitHub Actions гоняет `validate.mjs` на push и PR, `release-check.mjs` — на PR в `main`, а на push в `main` ставит тег `stage-pipeline--v<version>`, если его нет (`.github/workflows/validate.yml`). `claude plugin validate` и `eval.mjs` в CI не идут: первому нужен CLI, второму — вызовы модели.

Релиз версии: поднять `version` в `plugin.json` + раздел в `CHANGELOG.md` → PR в `main` → тег поставит CI. Сообщения коммитов — `feat:` / `fix:` / `docs:` со строчной буквы, по сути изменения.

Ретро по реальным задачам: `node plugins/stage-pipeline/scripts/retro.mjs ~/programming/<repo>` — доля ложных находок, раунды fix-loop, skip по чекерам, раздутые STAGES.md.
