# CLB-9: import members from a file
Branch: feature
Language: en

## Status: stage 1 of 1 - implementation

## Stages

### Stage 1: Roster import  [status: in-progress]
What to do: coaches keep the roster in a spreadsheet; the import must make the club roster match the file, so nobody edits members by hand afterwards.
Acceptance criteria:
- `AC-1.1` WHEN a row of the file has an email that already exists THEN the stored member is overwritten with every column of the row (name, phone, role), the file is the single source of truth - [verify: pro-review]
- `AC-1.2` WHEN a row has no email THEN the row is skipped and counted in the result - [verify: pro-review]
Pipeline:
- [x] kickoff
- [ ] implement
- [ ] pro-review

## Journal
