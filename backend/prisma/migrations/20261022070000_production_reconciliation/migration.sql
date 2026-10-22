-- Veyra production reconciliation migration.
-- Additive only. Preserves existing owner, account and balance rows.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'OWNER';
ALTER TYPE "TransactionStatus" ADD VALUE IF NOT EXISTS 'PENDING';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EntryType') THEN
    CREATE TYPE "EntryType" AS ENUM ('DEBIT','CREDIT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SavingsType') THEN
    CREATE TYPE "SavingsType" AS ENUM ('DAILY','TARGET','FIXED','SAFEBOX');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CardStatus') THEN
    CREATE TYPE "CardStatus" AS ENUM ('ACTIVE','FROZEN','BLOCKED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LoanStatus') THEN
    CREATE TYPE "LoanStatus" AS ENUM ('PENDING','APPROVED','ACTIVE','PAID','OVERDUE','REJECTED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NotificationType') THEN
    CREATE TYPE "NotificationType" AS ENUM ('TRANSFER_SENT','TRANSFER_RECEIVED','PAYMENT','SECURITY','SAVINGS','LOAN','CARD','SYSTEM');
  END IF;
END $$;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "firstName" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastName" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "username" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "accountNumber" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pinHash" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pinFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pinLockedUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "ninLast4" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "identityStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "faceVerificationStatus" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "upgradeLevel" TEXT NOT NULL DEFAULT 'BASIC';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "showUsername" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "allowPhoneReceiving" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailNotifications" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "loginAlerts" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "profileImageUrl" TEXT;

UPDATE "User" u SET
  "firstName" = COALESCE(NULLIF(u."firstName", ''), p."firstName", ''),
  "lastName" = COALESCE(NULLIF(u."lastName", ''), p."lastName", ''),
  "username" = COALESCE(NULLIF(u."username", ''), p."username"),
  "profileImageUrl" = COALESCE(u."profileImageUrl", p."profileImageUrl"),
  "identityStatus" = COALESCE(NULLIF(u."identityStatus", 'UNVERIFIED'), i."status", 'UNVERIFIED')
FROM "Profile" p LEFT JOIN "Identity" i ON i."userId" = u."id"
WHERE p."userId" = u."id";
UPDATE "User" u SET "accountNumber" = a."accountNumber"
FROM "Account" a WHERE a."userId" = u."id" AND (u."accountNumber" IS NULL OR u."accountNumber" = '');
UPDATE "User" SET "pinHash" = COALESCE("pinHash", ''), "firstName" = COALESCE("firstName", ''), "lastName" = COALESCE("lastName", '');

ALTER TABLE "User" ALTER COLUMN "firstName" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "lastName" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "username" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "accountNumber" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "pinHash" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX IF NOT EXISTS "User_accountNumber_key" ON "User"("accountNumber");

ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "legalFirstName" TEXT;
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "legalLastName" TEXT;
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "displayName" TEXT;
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "preferences" JSONB;
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "Profile" p SET
  "legalFirstName" = COALESCE(p."legalFirstName", p."firstName"),
  "legalLastName" = COALESCE(p."legalLastName", p."lastName"),
  "phone" = COALESCE(p."phone", u."phone"),
  "email" = COALESCE(p."email", u."email"),
  "avatarUrl" = COALESCE(p."avatarUrl", p."profileImageUrl")
FROM "User" u WHERE u."id" = p."userId";

ALTER TABLE "Identity" ADD COLUMN IF NOT EXISTS "ninLast4" TEXT;
ALTER TABLE "Identity" ADD COLUMN IF NOT EXISTS "ninProvider" TEXT;
ALTER TABLE "Identity" ADD COLUMN IF NOT EXISTS "ninProviderReference" TEXT;
ALTER TABLE "Identity" ADD COLUMN IF NOT EXISTS "ninVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Identity" ADD COLUMN IF NOT EXISTS "faceStatus" TEXT DEFAULT 'NOT_CONFIGURED';
ALTER TABLE "Identity" ADD COLUMN IF NOT EXISTS "faceProvider" TEXT;
ALTER TABLE "Identity" ADD COLUMN IF NOT EXISTS "faceProviderReference" TEXT;
ALTER TABLE "Identity" ADD COLUMN IF NOT EXISTS "faceVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Identity" ADD COLUMN IF NOT EXISTS "lockedLegalName" TEXT;
ALTER TABLE "Identity" ADD COLUMN IF NOT EXISTS "lastFailureCode" TEXT;
ALTER TABLE "Identity" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Identity" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Account" ALTER COLUMN "level" SET DEFAULT 'LEVEL_1';

ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "refreshHash" TEXT;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "previousRefreshHash" TEXT;
UPDATE "Session" SET "refreshHash" = COALESCE("refreshHash", "tokenHash", '');
ALTER TABLE "Session" ALTER COLUMN "refreshHash" SET DEFAULT '';
ALTER TABLE "Session" ALTER COLUMN "refreshHash" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

CREATE TABLE IF NOT EXISTS "Wallet" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL UNIQUE,
  "balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'NGN',
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "Wallet" ("id","userId","balance","currency","status")
SELECT 'wallet_' || md5(a."userId"), a."userId", a."balanceKobo"::numeric / 100, a."currency", COALESCE(a."status", 'ACTIVE')
FROM "Account" a ON CONFLICT ("userId") DO NOTHING;

CREATE TABLE IF NOT EXISTS "TransactionEntry" (
  "id" TEXT PRIMARY KEY,
  "transactionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "EntryType" NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TransactionEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "TransactionEntry_userId_createdAt_idx" ON "TransactionEntry"("userId","createdAt");

CREATE TABLE IF NOT EXISTS "IdempotencyKey" (
  "id" TEXT PRIMARY KEY,
  "key" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL DEFAULT '',
  "userId" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdempotencyKey_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "IdempotencyKey_userId_key_key" UNIQUE ("userId","key")
);

CREATE TABLE IF NOT EXISTS "SecurityEvent" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT,
  "event" TEXT NOT NULL,
  "ip" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "SecurityEvent_userId_createdAt_idx" ON "SecurityEvent"("userId","createdAt");

CREATE TABLE IF NOT EXISTS "Bank" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE,
  "code" TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS "BankAccount" (
  "id" TEXT PRIMARY KEY,
  "bankId" TEXT NOT NULL,
  "accountNumber" TEXT NOT NULL UNIQUE,
  "accountName" TEXT NOT NULL,
  "balance" DECIMAL(18,2) NOT NULL DEFAULT 1000000,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT "BankAccount_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "SavingsAccount" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "SavingsType" NOT NULL,
  "balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "targetAmount" DECIMAL(18,2),
  "maturityDate" TIMESTAMP(3),
  "interestRate" DECIMAL(8,4) NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SavingsAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "SavingsAccount_userId_idx" ON "SavingsAccount"("userId");

CREATE TABLE IF NOT EXISTS "Card" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "last4" TEXT NOT NULL,
  "maskedNumber" TEXT NOT NULL,
  "expiryMonth" INTEGER NOT NULL,
  "expiryYear" INTEGER NOT NULL,
  "cvvHash" TEXT NOT NULL,
  "pinHash" TEXT NOT NULL,
  "status" "CardStatus" NOT NULL DEFAULT 'ACTIVE',
  "spendingLimit" DECIMAL(18,2) NOT NULL DEFAULT 500000,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Card_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Loan" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "interest" DECIMAL(18,2) NOT NULL,
  "totalRepayable" DECIMAL(18,2) NOT NULL,
  "durationMonths" INTEGER NOT NULL,
  "status" "LoanStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Loan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "UpgradeRequest" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "requestedLevel" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "requirementNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  CONSTRAINT "UpgradeRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "UpgradeRequest_userId_createdAt_idx" ON "UpgradeRequest"("userId","createdAt");
CREATE INDEX IF NOT EXISTS "UpgradeRequest_status_createdAt_idx" ON "UpgradeRequest"("status","createdAt");

CREATE TABLE IF NOT EXISTS "WebAuthnChallenge" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "challenge" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebAuthnChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "WebAuthnChallenge_userId_purpose_expiresAt_idx" ON "WebAuthnChallenge"("userId","purpose","expiresAt");

CREATE INDEX IF NOT EXISTS "Account_status_updatedAt_idx" ON "Account"("status","updatedAt");
CREATE INDEX IF NOT EXISTS "Device_userId_revokedAt_idx" ON "Device"("userId","revokedAt");
CREATE INDEX IF NOT EXISTS "TransactionEvent_transactionId_createdAt_idx" ON "TransactionEvent"("transactionId","createdAt");
CREATE INDEX IF NOT EXISTS "Receipt_userId_createdAt_idx" ON "Receipt"("userId","createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId","createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_targetUserId_createdAt_idx" ON "AuditLog"("targetUserId","createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_action_createdAt_idx" ON "AuditLog"("action","createdAt");
