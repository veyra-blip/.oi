# Deploy and database migration safety

## Before replacing production files
1. Download a PostgreSQL backup from the database provider.
2. In Render, record the current service environment variable names and current deploy commit. Do not paste secret values into chat or GitHub.
3. Run `sql/READ_ONLY_DATABASE_CHECKS.sql` against the existing database using a read-only SQL session.
4. Confirm the existing owner user, role, account/wallet, transaction count and schema. Do not run the seed script.
5. Deploy this package to a separate staging service against a restored database copy and run the tests.

## Render
Root Directory `backend`; Build Command `npm install && npx prisma generate && npm run build`; Start Command `npm start`.

Migration is intentionally not part of the build command. The included migration `20261016130000_security_repair` is from the previously audited schema and is not automatically asserted to match every live database. Before applying any migration, check `_prisma_migrations` and the actual table/column definitions. Never run `prisma migrate dev`, `prisma db push`, or `prisma migrate reset` on production.

## Read-only schema checks
Run the supplied SQL. Compare the results to `backend/prisma/schema.prisma`. If the production database schema differs, use `prisma db pull` against a protected staging copy and reconcile the schema before creating a new migration. Do not fabricate a migration based on a schema file alone; a migration must match the actual database state.

## Owner account
No owner account is created, reset, or overwritten during deployment. Do not run `npm run seed` against production. Verify the existing owner row and role using read-only queries, and use a reviewed one-time admin recovery process if that row is missing.

## Included additive migration
`backend/prisma/migrations/20261021120000_profile_identity_upgrades/migration.sql` adds the profile preferences, identity-status fields, OWNER enum value, and upgrade request table used by this bundle. It contains no DROP statements and does not reset or delete existing user, wallet, transaction, or owner rows. It must still be checked against the live schema and `_prisma_migrations` before applying. Do not manually execute it if Prisma already records it as applied.


## Transaction mode

`BANK_TRANSFER_MODE=SIMULATED` is the safe default. It records a successful simulated bank transaction, debits the Veyra wallet and credits the local BankAccount mirror. `PAYOUT_LIVE_MODE=false` remains the default. Do not enable live payout until the provider contract, webhook/reconciliation process and funding source have been tested.

## Added normalized architecture migration

The `20261021140000_normalized_accounts_devices_audit` migration is additive and backfills Account balances from existing Wallet balances. Back up production first and compare the exact live schema and `_prisma_migrations` history before applying. This migration has not been run against the production database. The current editing environment could not download npm dependencies, so run `npm install`, `npm run prisma:generate`, `npx prisma validate`, and `npm run build` in an environment with registry access before deploying.
