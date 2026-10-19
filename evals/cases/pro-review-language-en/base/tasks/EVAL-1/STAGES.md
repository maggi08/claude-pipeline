# EVAL-1: profile name
Branch: feature
Language: en

## Status: stage 1 of 1 — implementation

## Stages

### Stage 1: Profile name  [status: in-progress]
What to do: the `ProfileName` component shows the user name, and for an empty name — the "Anonymous" label.
Acceptance criteria:
- `AC-1.1` WHEN name is empty, null or whitespace THEN `t('profile.anonymous')` is shown instead of the name — [verify: pro-review]
Pipeline:
- [x] kickoff
- [ ] implement
- [ ] pro-review

## Journal
