# Replacement build verification report

## Checks completed in this environment
- TypeScript parser check: `backend/src/server.ts` and `backend/src/transactionService.ts` passed with no syntax diagnostics.
- JavaScript parser check: all four inline scripts in both `index.html` and `frontend/index.html` passed with no syntax diagnostics.
- Archive integrity is checked after packaging.
- Reviewed the schema/migration text for the requested normalized models and additive backfill.

## Checks blocked
A full `npm install`, Prisma Client generation, `prisma validate`, database migration test, and TypeScript build could not be run because this environment could not reach `registry.npmjs.org` (`EAI_AGAIN`). The package now declares `@simplewebauthn/server`; its installed API types and Prisma-generated client still need a real dependency install before this can honestly be called a fully verified production build. No live database migration was run.

## Before deployment
1. Set `WEBAUTHN_ORIGIN` to the exact deployed frontend origin and `WEBAUTHN_RP_ID` to that origin's hostname.
2. Set strong `JWT_SECRET`, `REFRESH_SECRET`, and one-time `OWNER_SETUP_KEY` values. Bootstrap the intended owner once, then remove `OWNER_SETUP_KEY`.
3. Back up the production database and compare live `schema.prisma`, `information_schema`, and `_prisma_migrations` before `npm run prisma:deploy`. Never run reset/db-push/seed on production.
4. Keep `BANK_TRANSFER_MODE=SIMULATED` until Paystack funding, payout permissions, webhook URL/signature handling, reconciliation and reversal tests are complete.
