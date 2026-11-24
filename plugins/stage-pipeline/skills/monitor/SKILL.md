---
name: monitor
description: Open the tracker page of the machine — the sessions that wait for you, the open chats of every task with their titles, each task's stage and heavy load, priorities by drag and pause. Starts the page when it is not running (it keeps running after this session) and opens it in the browser; `stop` stops it. Manual command. RU triggers — «открой трекер», «покажи монитор задач»
disable-model-invocation: true
argument-hint: "[stop] — no argument opens the page"
---

# Monitor — the tracker page

One command, then one line to the user. Nothing else: no snapshot, no table, no other tool.

- No argument: `node ${CLAUDE_PLUGIN_ROOT}/scripts/monitor.mjs open`
- `stop`: `node ${CLAUDE_PLUGIN_ROOT}/scripts/monitor.mjs stop`

`open` reuses the page that already runs on this machine, or starts it apart from the session and opens the browser. Give the user its `monitor: http://127.0.0.1:…` line as a link, and say in one sentence whether the page was started now or was already running. On an error, show the error line as it is; when it says the port is taken, offer `open --port <N>` with a free port.

The page itself is described in the plugin README, section 2d.
