# GST-14: guest list without the row component
Branch: feature
Language: en

## Status: stage 1 of 1 - implementation

## Stages

### Stage 1: Inline guest rows  [status: in-progress]
What to do: the guest list renders its rows itself; the separate row component goes away, the delete action lives in a small hook.
Acceptance criteria:
- `AC-1.1` WHEN the guest list opens THEN every guest is shown with the name and, for a VIP guest, the badge - [verify: pro-review]
- `AC-1.2` WHEN the user confirms deleting a guest THEN the guest disappears from the list - [verify: pro-review]
Pipeline:
- [x] kickoff
- [ ] implement
- [ ] pro-review

## Journal
