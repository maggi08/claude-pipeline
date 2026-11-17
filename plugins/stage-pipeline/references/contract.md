# Contract template (backend task)

One file per task, written in the task language (section names in `language.md`). Where it lives: `<task_dir>/<TICKET>/CONTRACT.md`, or `<repo>/<contracts>/<TICKET>.md` when the backend repo sets `contracts:` in its `## Backend` section (it is then committed with the backend PR); `contractPath` in `scripts/hooks/pipeline-state.mjs` gives the path.

Who reads it: stage-plan (the contract stage and the "Contract coverage" table), api-verify (probes per endpoint, role and event), contract-compare (code against contract), the frontend stages (MSW mocks are written from it).

Ids are stable, like `AC-*`: an edit adds numbers, a cancelled item is marked `[cancelled: reason]` and its number is not reused. A line in "Open questions" means the contract is not `agreed`. Fill what you know; a field you do not know is `TODO: confirm`, never a guess.

---

# Contract: <TICKET> — <name>

- Ticket: <TICKET>
- Backend repo: <name from `## Backend`>
- Schema: <link or path to the generated schema (`api_schema`), or "no schema">
- Status: draft | agreed <date> <who>

## Endpoints

One block per endpoint, `E<n>`.

### E1 — POST /api/v3/things/

- Why: <what the caller gets from it>
- Auth: <scheme>; roles (role → expected code):

| Role | Expected code | Note |
|---|---|---|
| owner | 201 | |
| other tenant | 404 | does not reveal that the object exists |
| anonymous | 401 | |

- Request:

| Field | Location | Type | Required | Nullable | Constraints |
|---|---|---|---|---|---|
| id | path | uuid | yes | no | the thing's id |
| name | body | string | yes | no | 1–80 chars |
| limit | query | int | no | no | 1–100, default 20 |

- Pagination and filters: <style (cursor / offset / none), page size and its cap, ordering, the filter params and which fields they act on; "none" for an endpoint that returns one object>
- Responses:

| Code | Field | Type | Nullable | Enum values (all of them) |
|---|---|---|---|---|
| 201 | `id` | uuid | no | |
| 201 | `name` | string | no | |
| 201 | `status` | string | no | `draft`, `active` |
| 201 | `archived_at` | datetime | yes | |

- Example (the frontend MSW mocks are built from these two blocks):

```json
// request body
{ "name": "Early check-in" }
```

```json
// response body, 201
{ "id": "6f1c0c1e-0000-4000-8000-000000000001", "name": "Early check-in", "status": "draft", "archived_at": null }
```

- Errors:

| Code | Machine error code | When |
|---|---|---|
| 400 | `name_too_long` | `name` over 80 chars |

- Side effects: <DB model and field written; event `EV<n>` sent>
- Idempotency: <what a repeat of the same request does>

## Events

### EV1 — thing.created

- Exchange / routing key / queue: <exchange> / <key> / <queue>
- Sender: <service>; reader: <service>
- Payload version: <field or header that carries it, and the current value>
- Payload:

| Field | Type | Nullable |
|---|---|---|
| id | uuid | no |

- Delivery: <at-least-once or at-most-once; ordering guaranteed per what key, or none; how a duplicate is handled by the reader (idempotency key, upsert)>
- Sent when: <the moment, e.g. after commit of E1>

## Migrations

### MG1 — things table

- Model and fields: <Model: field type, null, default>
- Reversible: <what the rollback does; "no" with the reason>
- Data: <backfill, or "none">

## Open questions

| # | Question | Owner |
|---|---|---|
| Q1 | <question> | <who answers> |
