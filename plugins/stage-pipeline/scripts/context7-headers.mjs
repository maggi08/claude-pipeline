// Ключ Context7 берётся из окружения разработчика, а не из .mcp.json: тот уезжает всей команде.
// Без ключа сервер работает анонимно, на общих лимитах.
const apiKey = process.env.CONTEXT7_API_KEY

process.stdout.write(JSON.stringify(apiKey ? { Authorization: apiKey } : {}))
