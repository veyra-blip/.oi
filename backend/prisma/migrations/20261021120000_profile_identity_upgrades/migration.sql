ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'OWNER';
-- Additive-only Veyra profile, identity status and upgrade request migration.
-- Review against live information_schema and _prisma_migrations before applying.
ALTER TABLE IF EXISTS "User" ADD COLUMN IF NOT EXISTS "ninLast4" TEXT;
ALTER TABLE IF EXISTS "User" ADD COLUMN IF NOT EXISTS "identityStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE IF EXISTS "User" ADD COLUMN IF NOT EXISTS "faceVerificationStatus" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED';
ALTER TABLE IF EXISTS "User" ADD COLUMN IF NOT EXISTS "upgradeLevel" TEXT NOT NULL DEFAULT 'BASIC';
ALTER TABLE IF EXISTS "User" ADD COLUMN IF NOT EXISTS "showUsername" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE IF EXISTS "User" ADD COLUMN IF NOT EXISTS "allowPhoneReceiving" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE IF EXISTS "User" ADD COLUMN IF NOT EXISTS "emailNotifications" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE IF EXISTS "User" ADD COLUMN IF NOT EXISTS "loginAlerts" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE IF EXISTS "User" ADD COLUMN IF NOT EXISTS "profileImageUrl" TEXT;
CREATE TABLE IF NOT EXISTS "UpgradeRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "requestedLevel" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "requirementNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  CONSTRAINT "UpgradeRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "UpgradeRequest_userId_createdAt_idx" ON "UpgradeRequest"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "UpgradeRequest_status_createdAt_idx" ON "UpgradeRequest"("status", "createdAt");
DO $$ BEGIN
  IF to_regclass('public."User"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UpgradeRequest_userId_fkey') THEN
    ALTER TABLE "UpgradeRequest" ADD CONSTRAINT "UpgradeRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
