# claude-pipeline

Личный маркетплейс Claude Code: плагины, которые я подключаю к своим проектам.

## Плагины

| Плагин | Что делает |
|---|---|
| [`stage-pipeline`](plugins/stage-pipeline/README.md) | Поэтапный maker/checker-workflow для крупных UI-задач: разбивка на этапы, спека из дизайна, проверки субагентами (Figma/прототип, рантайм, код-ревью), журнал состояния в файлах |

## Подключение

### На этой машине — из локального клона

Маркетплейс читается прямо из папки: правишь скилл → `claude plugin update` → изменение доехало, пушить необязательно.

```bash
claude plugin marketplace add ~/programming/claude-pipeline
claude plugin install stage-pipeline@magzhan
```

Попадёт в `~/.claude/settings.json` и включится во всех репозиториях:

```json
{
  "extraKnownMarketplaces": {
    "magzhan": {
      "source": { "source": "directory", "path": "/Users/magzhan/programming/claude-pipeline" }
    }
  },
  "enabledPlugins": { "stage-pipeline@magzhan": true }
}
```

### На другой машине — из GitHub

```bash
claude plugin marketplace add maggi08/claude-pipeline
claude plugin install stage-pipeline@magzhan
```

Репозиторий приватный — на новой машине нужен доступ к GitHub (SSH-ключ или `gh auth login`).

### Только в одном репозитории

Те же команды с `--scope project` — попадут в `<repo>/.claude/settings.json`. Тогда убедись, что `.gitignore` не глотает `.claude/` целиком: `.claude/*` + `!.claude/settings.json`.

Обновление: `claude plugin update stage-pipeline`. После установки и обновления — перезапуск Claude Code.

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
