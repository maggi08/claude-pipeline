# BILL-31: invoice comments and the sign-in return path
Branch: feature
Language: en

## Status: final checks

## Stages

### Stage 1: Invoice page with comments  [status: done]
What to do: an invoice page (`GET /api/invoices/:id`) with a comment thread that the members of a company write to each other; a comment keeps the formatting people paste (links, line breaks).
Acceptance criteria:
- `AC-1.1` WHEN a member opens an invoice of their company THEN its amount and comments are shown - [verify: pro-review]
- `AC-1.2` WHEN a member posts a comment THEN the other members see it on the invoice - [verify: pro-review]

### Stage 2: Sign-in return path and the legal line  [status: done]
What to do: after sign-in the user goes back to the page they came from (`?returnTo=`); the footer shows the legal line with a link to the terms.
Acceptance criteria:
- `AC-2.1` WHEN sign-in succeeds THEN the user lands on `returnTo` when it is a page of this site, otherwise on the home page - [verify: pro-review]

## Journal
