# FLT-52: vehicle page — maintenance status and removal
Branch: feature
Language: en

## Status: final checks

## Stages

### Stage 1: Maintenance status and removal on the vehicle page  [status: done]
What to do: the vehicle page shows the maintenance status (up to date / due soon / overdue) and gets a toolbar with "Remove from fleet", which asks for a confirmation first.
Acceptance criteria:
- `AC-1.1` WHEN the vehicle's maintenance is overdue THEN the page shows the status "Overdue" in the danger color - [verify: pro-review]
- `AC-1.2` WHEN the user presses "Remove from fleet" THEN a confirmation names the plate, and only "Remove" removes the vehicle - [verify: pro-review]

## Journal
