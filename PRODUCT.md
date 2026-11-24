# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One developer (the plugin author) on their own machines. They run many Claude Code chats in parallel across several repositories (client apps, a backend, this plugin repo), each chat working a task through the stage pipeline. They know every pipeline term; nobody else reads the page.

## Product Purpose

claude-pipeline is a set of Claude Code plugins; stage-pipeline runs a task through stages with checker agents. Its one web surface is the monitor: a local page (`monitor.mjs serve`, `http://127.0.0.1:7317/?t=<token>`) that shows, at a glance, four things with equal weight:

1. which chat is waiting for them (a question or a permission) and a way to jump into it;
2. whether the machine is choking (memory pressure, swap, load) and what eats it: which task, chat or heavy command;
3. what each task is doing now: stage, next step, running checks, browsers, dev servers;
4. who goes first under shortage: the priority order (drag) and pause per task.

Success: one glance answers all four; nothing has to be read line by line.

## Operating Context

The page is an ordinary wide browser tab they switch to from VS Code, then switches back. It refreshes itself every 2 s from `/api/state`. "Open" links hand a chat to the VS Code window in focus. Typical load: 5 active tasks of 16 open, one repo with 7 chats, a 16 GB Mac with swap near full.

## Capabilities and Constraints

- One static HTML file (`plugins/stage-pipeline/monitor/index.html`) served by `monitor.mjs`; plain HTML, CSS and JS, no build step, no network fonts or CDN (it must work offline).
- Data per task: ticket, repo, stage n of m, current stage heading, next step, problem, chats (title, last active, CPU, memory, branch, pid, last prompt, waiting kind, subagents), heavy commands (kind check / browser / dev-server, state running / waiting / throttled / paused, CPU, memory, command line). A repo chat with no task gets a card keyed by the repo root.
- Machine data: memory pressure (normal / warn / critical), free and total memory, swap used and total, load and cores; a problem banner.
- Actions: reorder priority (drag, Alt+Up / Alt+Down), Pause / Resume per task, filter Active / All, Open a chat in VS Code.
- Light and dark themes follow the system.

## Product Principles

- The glance is the product: state is read from shape and colour, text is for detail.
- What needs them and what hurts the machine come before what is merely running.
- Dense is fine: they are the only reader and know the vocabulary; no explanatory paragraphs on screen.
- Every number names its owner: load without the task or chat behind it is noise.
