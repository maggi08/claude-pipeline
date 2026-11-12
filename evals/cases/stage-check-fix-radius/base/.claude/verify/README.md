# Verify map — pay-portal
Base: main · Updated: 2026-11-02
## Instance and doctor
- Dev: http://127.0.0.1:{port}
- App marker: Portal
- Baseline routes: /
- Ready = the baseline routes answer 200 and the marker is on the page (`node ${CLAUDE_PLUGIN_ROOT}/scripts/verify-doctor.mjs`)
## Baseline preconditions
- Auth: none
- E2E command: not set
- Playwright / storageState: not set
- Data: demo data only
- Stand writes: none
- Surface: desktop width 1440
- Theme: light
## Driving conventions
- Handles as take_snapshot prints them (`button "Save"`), then data-testid, then aria-label; never CSS classes
- click and fill by uid; no el.click() inside evaluate; evaluate only arranges preconditions or reads state after the user path
- wait for an observable end state, no sleeps
## Proof and skip reporting
- action + resulting state; feature id + entry point on every artifact
- a skipped entry point is not verified through another one; unreachable = prerequisite + route tried + closest path covered
## Features (sweep order)
- [orders](features/orders.md) — /orders
- [invoices](features/invoices.md) — /invoices
