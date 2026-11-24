---
version: 1
slug: "plugins-stage-pipeline-monitor-index-html"
primary_target: "plugins/stage-pipeline/monitor/index.html"
related_targets: []
---

# Monitor page

Scope: `plugins/stage-pipeline/monitor/index.html`, the one page of the tracker. Mode: Operate.
Reader: the plugin author alone, in a wide browser tab switched to from VS Code. Job: in one glance, who waits for them, whether the machine chokes and who eats it, what each task does, who goes first; then Open a chat, reorder, pause.
Constraints: one static file, no build, no network fonts, refreshes every 2 s; light and dark follow the system.

## Direction contract

THESIS: Priority is the order of strips in a bay, and the task that needs you sticks out of the line. Refuses the card-per-task admin dashboard with KPI tiles.

OWN-WORLD: Air traffic control flight progress strips. A graphite bay (pale grey-green in light) holds buff paper strips printed in near-black; each strip opens with a coloured holder cell naming its state (yellow needs you, green running, blue queued, buff live, grey idle, slate paused, red problem); fields sit in fixed boxes ruled by hairlines; tickets, figures and commands in mono, names in the system sans.

STORY: The reader sees the waiting chat first (yellow plate, cocked strip), reads the machine in the top bar (free memory, swap, load) and what eats it in Memory by owner (one bar of the whole memory, then a row per owner), scans the bay down its columns under one legend rail (stage, now, chats, memory, CPU), then opens the chat, drags a strip or pauses a task.

FIRST VIEWPORT: Top bar: name, the machine's three figures (free memory, swap, load, coloured by pressure), Active/All. Left: the bay, one 64 px strip per task in priority order, boxes under one legend rail: holder | place | ticket+repo | stage and next | now | chats | load (memory over CPU) | Pause, chevron; a strip whose chat asks something pushed 28 px left out of line. Right column 360 px: yellow plates for chats that ask (Open is the primary action), pale one-line plates for chats whose turn ended, memory-by-owner bars, heavy commands. Below 860 px the bay comes first.

FORM: ATC flight progress strip bay; position 1 of 7 on the ordered list (IMPECCABLE’S PICK). seed:f646e6e6f8645945. Signature interaction: a strip unfolds in place to its chats (title, age, load, last prompt, Open); hovering an owner bar lifts its strip; dragging or Alt+Up/Down reslots a strip.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

- None from the user. States precedence: problem > needs you > paused > your turn > queued > running > live > idle. "Your turn" (a chat whose turn ended, from the session-wait hook) was added after the contract, from live data: it waits for the reader, so it ranks above machine activity, and it is not cocked, so a question still stands out.
