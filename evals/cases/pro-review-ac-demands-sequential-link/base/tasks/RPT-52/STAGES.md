# RPT-52: share a report by link
Branch: feature
Language: en

## Status: stage 1 of 1 - implementation

## Stages

### Stage 1: Share link  [status: in-progress]
What to do: the owner of a report can share it by a short link; support reads the link out over the phone, so it must stay short and easy to dictate.
Acceptance criteria:
- `AC-1.1` WHEN the owner shares a report THEN the link is `/r/<report number>`, the same number the report has in the list, so support can read it out - [verify: pro-review]
- `AC-1.2` WHEN anyone opens the link THEN the report opens without a sign-in - [verify: pro-review]
- `AC-1.3` WHEN the report opens from the link THEN the header shows the owner's email, so the reader knows whom to ask - [verify: pro-review]
Pipeline:
- [x] kickoff
- [ ] implement
- [ ] pro-review

## Journal
