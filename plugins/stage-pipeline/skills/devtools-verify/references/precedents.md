# Precedents moved out of SKILL.md

Where the rules of SKILL.md came from. No rule lives here.

## Classes of bugs found by the first run (real cases)

- a hydration mismatch from two root `ClientOnly`;
- a draft ignored because of SSR instantiation of the store (Pinia hydrate);
- a progress bar with `px-[480px]` collapsed at 1024;
- a dark theme without a dark mockup.

## Animations (item 9)

The fades of the start screen ran at the default 150ms from the first stage and passed all static comparisons: a Tailwind arbitrary value (`delay-[220ms]`) had silently been dropped.

## Open browsers (the SubagentStop hook, frames-guard)

Three MCP browsers were found open 18–23 h after their sessions went idle, with the app still running in their tabs.
