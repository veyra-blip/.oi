# Production SQL

`PRODUCTION_RECONCILIATION_20261022.sql` is the reviewed additive reconciliation for the currently audited Render database.

Before applying it:

1. Take a PostgreSQL backup.
2. Confirm the live schema and `_prisma_migrations` state again.
3. Apply the SQL once through a protected PostgreSQL session.
4. Re-run the read-only database checks.
5. Do not run the older Prisma migration folders against this live database without reconciling migration history first.

The SQL does not reset or delete the existing owner or balance rows.
