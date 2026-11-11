# INB-9: unread badge in the inbox header
Branch: feature
Language: en

## Status: stage 1 of 1 - fix round

## Stages

### Stage 1: Unread badge  [status: in-progress]
What to do: the inbox header shows how many messages are unread; marking a message as read lowers the number.
Acceptance criteria:
- `AC-1.1` WHEN the user clicks "Mark as read" on a message THEN the header badge shows one less - [verify: devtools-verify]
Pipeline:
- [x] kickoff
- [x] implement
- [ ] devtools-verify

## Journal
