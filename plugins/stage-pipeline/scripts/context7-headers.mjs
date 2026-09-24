// Ключ Context7 берётся из окружения разработчика, а не из .mcp.json: тот уезжает всей команде.
// С 2026-09 хостед Context7 без авторизации отвечает 401 даже на tools/list, а Claude Code
// после такого ответа кэширует сервер как needs-auth и больше к нему не подключается.
// Поэтому без ключа заголовок не отправляется вовсе: остаётся OAuth-вход через /mcp.
const apiKey = process.env.CONTEXT7_API_KEY

process.stdout.write(JSON.stringify(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}))
