# Contract: NTS-7 - notes API

- Ticket: NTS-7
- Backend repo: notes-api
- Schema: no schema
- Status: agreed 2026-11-03 Anders Wik

## Endpoints

### E1 - PATCH /api/notes/{id}/

- Why: a user edits the text of their own note
- Auth: session cookie; roles (role -> expected code):

| Role | Expected code | Note |
|---|---|---|
| owner of the note | 200 | the text changes |
| another signed-in user | 404 | the note is not visible to them; 403 is also accepted |
| anonymous | 403 | no session |

- Request:

| Field | Location | Type | Required | Nullable | Constraints |
|---|---|---|---|---|---|
| id | path | int | yes | no | an existing note |
| text | body | string | no | no | not empty |

- Pagination and filters: none
- Responses:

| Code | Field | Type | Nullable | Enum values (all of them) |
|---|---|---|---|---|
| 200 | `id` | int | no | |
| 200 | `text` | string | no | |
| 200 | `owner` | int | no | |

- Example:

```json
// request body
{ "text": "Buy milk" }
// response body, 200
{ "id": 1, "text": "Buy milk", "owner": 1 }
```

- Errors: 404 for a note the caller does not own

- Side effects: none
- Idempotency: the same body gives the same note

## Open questions

None.
