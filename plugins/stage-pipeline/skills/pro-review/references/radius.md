# Blast radius with a proof level

For every CHANGED (not new) shared module, and every shape the diff starts relying on, say who else is affected and **how that was established**. Grep is the lowest level and not enough alone.

Proof levels, the weakest first. Write the level next to the claim; "safe" at a low level is a question, not a fact.
1. **guess**: by the name or the look of the code.
2. **grep**: importers/usages found by text. Misses dynamic use, re-exports, string keys.
3. **read**: each importer / consumer opened and read for the changed part.
4. **run**: a test, a type check or a live call that exercises it.

Where the radius goes beyond import graph (look at each the diff touches):
- **Props and emits** of a component: every parent that passes the prop or listens to the event, including ones outside the task's scope (the legacy tree, another app of the monorepo, a neighbouring package). A moved or rewritten style is a radius change: the types hold, the screen differs.
- **API shape**: for each field the diff starts to read, open the type's source AND a real response (a fixture, a recorded call, the backend's schema). Types written by hand are a claim, not a fact: a field typed non-null that arrives null is the class. A field the diff stops sending is read from the other side too.
- **Related repos** from the config (`Platforms / related repos`, a shared kit, a webview): the same change needed there, or the contract they share changed.
- **Build/env**: a changed build config, env file, CI file or manifest is run, not read: `build` from the config on HEAD (SKILL.md Step 1).

A shared component changed with visuals affecting screens outside the diff is Major, listing the screens; the typical fix is a copy in the legacy layer, not a shared component with a flag.
