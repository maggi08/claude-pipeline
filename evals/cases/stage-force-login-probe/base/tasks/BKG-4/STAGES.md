# BKG-4: bookings list with status badges
Branch: feature
Language: en

## Status: stage 0 of 2 done

## Stages

### Stage 1: Status badges  [status: todo]
Figma nodes: —
What to do: each row of the bookings list at `/bookings` shows a status badge (confirmed, pending, cancelled).
Acceptance criteria:
- `AC-1.1` WHEN a signed-in user opens `/bookings` THEN every row shows a status badge - [verify: devtools-verify]
- `AC-1.2` WHEN the viewport is 1440, 1280 or 1024 px wide THEN `/bookings` has no horizontal scroll - [verify: devtools-verify]
Pipeline:
- [ ] kickoff
- [ ] implement
- [ ] devtools-verify

### Stage 2: Empty state  [status: todo]
Figma nodes: —
What to do: a user with no bookings sees a short empty-state message at `/bookings`.
Acceptance criteria:
- `AC-2.1` WHEN a signed-in user has no bookings THEN `/bookings` shows the empty-state message - [verify: devtools-verify]
Pipeline:
- [ ] kickoff
- [ ] implement
- [ ] devtools-verify

## ⚠ Awaiting user confirmation

## Journal
