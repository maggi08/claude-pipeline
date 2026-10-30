# REG-18: guest registration
Branch: feature
Language: en

## Status: stage 1 of 1 - implementation

## Stages

### Stage 1: Guest registration data  [status: in-progress]
What to do: load a guest's registration and build the refusal message of the submit form.
Acceptance criteria:
- `AC-1.1` WHEN the guest has no registration (404) THEN the loader answers null - [verify: pro-review]
- `AC-1.2` WHEN the service refuses the submit THEN the message is the error code followed by the reason when there is one - [verify: pro-review]
Pipeline:
- [x] kickoff
- [ ] implement
- [ ] pro-review

## Journal
