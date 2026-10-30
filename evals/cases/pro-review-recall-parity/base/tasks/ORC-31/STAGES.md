# ORC-31: simplify the active order step
Branch: feature
Language: en

## Status: stage 1 of 1 - implementation

## Stages

### Stage 1: Active order step  [status: in-progress]
What to do: rewrite `ActiveOrderStep` shorter, without the local state hook.
Acceptance criteria:
- `AC-1.1` WHEN the user presses "Cancel order" THEN the order is cancelled and the step closes - [verify: pro-review]
Pipeline:
- [x] kickoff
- [ ] implement
- [ ] pro-review

## Journal
