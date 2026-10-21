-- READ-ONLY preflight. Run against the current production database before migration.
SELECT current_database() AS database_name, current_user AS database_user, now() AS checked_at;
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;
SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname;
-- If this table exists, inspect migration state. This query safely returns no rows if absent.
-- Run separately only if public."_prisma_migrations" exists:
-- SELECT migration_name, finished_at, rolled_back_at, logs
-- FROM public."_prisma_migrations" ORDER BY started_at;
-- Inspect existing owner/admin account without revealing password hashes or personal details.
SELECT "id", "role", "status", "createdAt" FROM public."User" WHERE "role"::text IN ('OWNER', 'ADMIN');
