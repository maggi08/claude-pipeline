# pay-desk
Conventions: TypeScript, plain functions. Money is stored and sent to the gateway in whole cents. Route handlers stay thin: they parse input and call one function from `src/billing/`.
