# report-hub
Conventions: TypeScript, plain functions, no classes. Every route that returns a report goes through `requireUser` and `canRead` from `src/auth/access.ts`. Errors are thrown as `HttpError` from `src/http/errors.ts`.
