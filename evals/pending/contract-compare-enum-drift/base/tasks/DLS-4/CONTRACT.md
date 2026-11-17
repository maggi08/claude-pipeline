# Contract: DLS-4 - deals list

- Ticket: DLS-4
- Backend repo: deals-board
- Schema: no schema
- Status: agreed 2026-11-02 Ingrid Solheim

## Endpoints

### E1 - GET /api/v3/deals/

- Why: the board shows the deals of the account
- Auth: session cookie; roles (role -> expected code):

| Role | Expected code | Note |
|---|---|---|
| manager | 200 | |

- Request:

| Field | Location | Type | Required | Nullable | Constraints |
|---|---|---|---|---|---|
| status | query | string | no | no | one of the status values |

- Pagination and filters: none; filter `status`
- Responses:

| Code | Field | Type | Nullable | Enum values (all of them) |
|---|---|---|---|---|
| 200 | `id` | int | no | |
| 200 | `title` | string | no | |
| 200 | `status` | string | no | `requested`, `approved`, `rejected`, `expired` |
| 200 | `price` | decimal | yes | |
| 200 | `currency` | string | no | |

- Example (the frontend mocks are built from these two blocks):

```json
// response body, 200
[{ "id": 1, "title": "Late checkout", "status": "requested", "price": null, "currency": "EUR" }]
```

- Errors: none beyond the common session check

- Side effects: none
- Idempotency: read only

## Open questions

None.
