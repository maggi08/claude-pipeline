---
name: contract-compare
description: Methodology of the contract-compare checker — a static comparison of CONTRACT.md with the frontend types and API calls, the MSW mock handlers and the backend serializers (fields, nullable, enum values, codes), report with three anchors per finding. Use when the diff of a stage touches the frontend API layer, the mocks or the backend serializers/views and the task has a contract (/stage-check), or when the user asks whether the frontend matches the contract. RU triggers — «сверь с контрактом», «типы фронта против бэкенда»
---

# contract-compare — the frontend, the mocks and the serializers against one contract

The contract (`references/contract.md`) is the one agreed text; the frontend types, the mocks and the serializers are three readings of it, written by hand. You read them side by side and report where they part. The job is reading: the app, the tests and the mock server stay off.

## 1. Input

1. **The contract**: the file at `contractPath` (the prompt gives it). Take the endpoints `E*` the stage diff touches: method and path, the request table (`Location`, `Nullable`), the response table (code, field, type, nullable, all enum values), the `Example` block.
2. **The frontend repo and its API layer**: the `api_layer:` key of `## Code layout` in the frontend config (globs). No key — look for `fetch(`, axios or the API client named in CLAUDE.md. Mocks: MSW handlers (`http.get(...)`, `rest.get(...)`), usually under `mocks/` or `handlers`.
3. **The backend repo** (`## Backend` of its config): the serializers and views of the same endpoints (DRF `Serializer`/`ModelSerializer`; FastAPI pydantic models). A repo that is not on this machine is "Could not verify", not a finding.
4. **The diff of the stage** names which endpoints to compare; compare whole endpoints, not only the changed lines.

## 2. What is compared, per endpoint

- **(a) Frontend types** for the request and the response (TS `interface` / `type` / zod): field names, types, nullable and optional, enum values (all of them, against the contract's list).
- **(b) The call**: method, path, query parameters, body fields against the request table.
- **(c) The mocks**: fields and values of the mock body against the `Example` block and the response table: a field the contract does not have, a missing one, a value outside the enum, `null` where the contract says not nullable.
- **(d) The backend serializer**: fields, `read_only`, `allow_null`, the optional-or-not flag, `choices`; a pydantic model's fields and `Optional`. Against the contract's rows, and against the frontend.
- Codes: a code the frontend handles that the contract does not list, or a contract error code the frontend has no branch for.
- Types that serialize differently than they look: a DRF `DecimalField` is a string on the wire unless `COERCE_DECIMAL_TO_STRING=False`, datetimes are ISO strings, UUIDs strings. A contract type that parts from the wire type is a finding about the contract ("Open questions"), unless the serializer settings say otherwise.

## 3. Findings

A finding names a field and carries three anchors: the contract line (`CONTRACT.md:<line>` or `E<n>`, row), the frontend `path:line`, the backend `path:line` (when that side is in the diff or in the repo). A field absent on one side: cite the declaration that would hold it (the type or serializer class lines) and say "no field" (in the report language). Severity:
- **major** — a field or an enum value that one side does not know; nullable or optional parted; a rename with no trace in the contract.
- **minor** — an extra field in a mock only; a contract error code the frontend has no branch for when it handles errors generically (**major** when the code carries a user-visible state the contract names).
- The contract disagrees with both sides in the same way — a finding about the contract, in "Open questions" of the report, not about the code.
- Fields that match are not findings.

## 4. The report

`checks/contract-compare-<stage>.md` by `references/checker-report.md`. The prompt wins over STAGES.md for the stage and the language; a mismatch goes into the report header, not into "Could not verify". The file: the second line is the findings counter of the report format; "Findings" with an id each; "Stage criteria" (a line per criterion tagged `[verify: contract-compare]`, if there are any); "Could not verify" (a side in another repo that is not on this machine, a schema you could not read), "everything verified" when empty.
