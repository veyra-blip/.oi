CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

ALTER TABLE "User"
  ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER';

ALTER TABLE "Session"
  ADD COLUMN "previousRefreshHash" TEXT,
  ADD COLUMN "revokedAt" TIMESTAMP(3);

CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

ALTER TABLE "IdempotencyKey"
  ADD COLUMN "requestHash" TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS "IdempotencyKey_key_key";
CREATE UNIQUE INDEX "IdempotencyKey_userId_key_key" ON "IdempotencyKey"("userId", "key");
