# claude-pipeline

Личный маркетплейс Claude Code: плагины, которые я подключаю к своим проектам.

## Плагины

| Плагин | Что делает |
|---|---|
| [`stage-pipeline`](plugins/stage-pipeline/README.md) | Поэтапный maker/checker-workflow для крупных UI-задач: разбивка на этапы, спека из дизайна, проверки субагентами (Figma/прототип, рантайм, код-ревью), журнал состояния в файлах |

## Установка

Из GitHub — так ставится на любой машине, клонировать репо руками не нужно:

```bash
claude plugin marketplace add git@github.com:maggi08/claude-pipeline.git
claude plugin install stage-pipeline@magzhan
```

Репозиторий приватный, поэтому машине нужен доступ к нему. SSH-вариант выше требует ключа, добавленного в GitHub (`ssh -T git@github.com` должен отвечать приветствием). Через HTTPS — сначала `gh auth login && gh auth setup-git`, тогда работает и короткая форма:

```bash
claude plugin marketplace add maggi08/claude-pipeline
```

Дальше:

```json
{
  "extraKnownMarketplaces": {
    "magzhan": { "source": { "source": "url", "url": "git@github.com:maggi08/claude-pipeline.git" } }
  },
  "enabledPlugins": { "stage-pipeline@magzhan": true }
}
```

Это `~/.claude/settings.json` — плагин включён во всех репозиториях. Нужен только в одном — те же команды с `--scope project`, попадут в `<repo>/.claude/settings.json`; тогда убедись, что `.gitignore` не глотает `.claude/` целиком: `.claude/*` + `!.claude/settings.json`.

Обновление: `claude plugin update stage-pipeline` (подтянет свежий `main`). После установки и обновления — перезапуск Claude Code.

Проверка, что доехало: `claude plugin details stage-pipeline` — должен показать 11 скиллов, 6 агентов, 2 MCP-сервера. Дальше `/pipeline-doctor` в целевом репо проверит окружение (MCP, dev-сервер, baseline).

### Режим разработки — маркетплейс из локального клона

На машине, где плагин правится, удобнее читать маркетплейс прямо из папки: правишь скилл → `claude plugin update stage-pipeline` → изменение доехало, пушить необязательно.

```bash
git clone git@github.com:maggi08/claude-pipeline.git
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
  agents/<name>.md                субагенты-чекеры
  .mcp.json                       MCP-серверы, которые приезжают с плагином
  README.md                       документация плагина
```

Правила:

- **Никакой проектной специфики в скиллах.** Плагин включён во всех репозиториях; правила конкретного проекта живут в его `CLAUDE.md` или `.claude/pipeline.config.md → Conventions`. Проверено на практике: рубрика одного проекта в глобальном скилле давала ложные Major в другом.
- **Пути внутри плагина — через `${CLAUDE_PLUGIN_ROOT}`**, не через `~/.claude/`. Иначе кросс-ссылки скилл→агент ведут в пустоту, как только плагин переезжает.
- **Никаких секретов в `.mcp.json`** — только локальные/публичные эндпоинты.

Перед коммитом:

```bash
node scripts/validate.mjs
claude plugin validate . --strict
claude plugin validate ./plugins/stage-pipeline --strict
```

Те же проверки гоняет GitHub Actions на push и PR (`.github/workflows/validate.yml`).

Релиз версии: поднять `version` в `plugin.json`, затем `claude plugin tag plugins/stage-pipeline` (проверит, что манифест и запись в маркетплейсе сходятся).
