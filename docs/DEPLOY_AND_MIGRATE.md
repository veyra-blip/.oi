# Veyra deployment and production database safety

## Current production reconciliation

The audited Render database already contains the normalized Veyra tables (`User`, `Profile`, `Identity`, `Account`, `Session`, `Transaction`, `Notification`, `Device`, `TransactionEvent`, `Receipt`, `Upgrade`, and `AuditLog`) but its columns do not exactly match the deployed compatibility service. The repository therefore includes:

`backend/prisma/migrations/20261022070000_production_reconciliation/migration.sql`

This migration is **additive only**. It does not reset, delete, truncate, recreate, or overwrite the existing owner or account balance. It adds the compatibility fields used by the current API, creates the missing legacy/support tables (`Wallet`, `TransactionEntry`, `IdempotencyKey`, `SecurityEvent`, `Bank`, `BankAccount`, `SavingsAccount`, `Card`, `Loan`, `UpgradeRequest`, `WebAuthnChallenge`), and backfills `Wallet` from the existing normalized `Account` balance.

### Important migration-history warning

The live `_prisma_migrations` table was audited as having no recorded migration rows. The older migration directories in this repository were written for earlier database shapes and must **not** simply be replayed against the current Render database. Before using `prisma migrate deploy`, reconcile the migration history with the actual production database or execute the reviewed reconciliation SQL through a protected database session and record the resulting migration state deliberately.

Never run any of the following against production:

- `prisma migrate dev`
- `prisma db push`
- `prisma migrate reset`
- `npm run seed`

Take a PostgreSQL backup first.

## Render build

Root Directory: `backend`

Build Command:

```sh
npm install --include=dev && npx prisma generate && npm run build
```

Start Command:

```sh
npm start
```

The application build does not automatically execute a database migration.

## Owner account

The existing owner account is preserved. Deployment code does not create, reset, or delete the owner. Do not run the seed script against production.

## Balance safety

The normalized `Account.balanceKobo` remains the integer balance source alongside the compatibility `Wallet.balance`. The reconciliation migration initializes Wallet from Account without changing Account. Money-moving paths update both representations in one transaction.
