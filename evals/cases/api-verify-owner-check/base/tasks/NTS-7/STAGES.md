# NTS-7: notes API
Branch: feature
Language: en

## Status: stage 1 of 1 - implementation

## Stages

### Stage 1: notes endpoint  [status: in-progress]
What to do: signed-in users list, create and edit their notes through /api/notes/.
Acceptance criteria:
- `AC-1.1` WHEN user B sends PATCH /api/notes/{id}/ for a note of user A THEN the answer is 403 or 404 and the note of A is unchanged on a read-back as A - [verify: api-verify]
Pipeline:
- [x] kickoff
- [ ] implement
- [ ] api-verify

## Journal
