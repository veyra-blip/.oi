import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import argon2 from "argon2";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "./db.js";
import { asyncRoute, requireAuth, requireAdmin } from "./middleware.js";
import { hashRequest, hashToken, signAccess, signRefresh, verifyRefresh } from "./auth.js";
import { internalTransfer } from "./transactionService.js";
import { idempotencyKey, reference } from "./utils.js";
import { Prisma } from "@prisma/client";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { friendlyPinError, verifyTransactionPin } from "./security.js";

const app = express();
app.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    name: "Veyra API",
    status: "online",
    message: "Veyra backend is running."
  });
});
app.set("trust proxy", 1);
const port = Number(process.env.PORT || 4000);

app.use(helmet());

const allowedOrigins = [
  "http://localhost:5173",
  "https://veyra-blip.github.io"
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Origin not allowed by CORS"));
  }
}));

app.use(express.json({ limit: "3mb", verify: (req: any, _res, buf) => { req.rawBody = Buffer.from(buf); } }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50 });
const moneyLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30 });

function requireSecret(name: string) {
  const value = process.env[name]?.trim();
  if (!value || value.length < 32) throw new Error(`${name}_NOT_CONFIGURED_OR_TOO_SHORT`);
  return value;
}

function amountToKobo(amount: Prisma.Decimal | string | number) { return BigInt(new Prisma.Decimal(amount).mul(100).toFixed(0)); }
function webAuthnConfig() { const origin = (process.env.WEBAUTHN_ORIGIN || process.env.FRONTEND_ORIGIN || "").trim(); if (!origin) throw new Error("WEBAUTHN_ORIGIN_NOT_CONFIGURED"); return { origin, rpID: (process.env.WEBAUTHN_RP_ID || new URL(origin).hostname).trim() }; }

function generateAccountNumber() {
  return `81${crypto.randomInt(10_000_000, 100_000_000)}`;
}

async function createUniqueAccountNumber(tx: Prisma.TransactionClient) {
  for (let i = 0; i < 10; i++) {
    const accountNumber = generateAccountNumber();
    const exists = await tx.user.findUnique({ where: { accountNumber }, select: { id: true } });
    const accountExists = await tx.account.findUnique({ where: { accountNumber }, select: { id: true } });
    if (!exists && !accountExists) return accountNumber;
  }
  throw new Error("ACCOUNT_NUMBER_GENERATION_FAILED");
}

requireSecret("JWT_SECRET");
requireSecret("REFRESH_SECRET");

app.get("/api/health", (_req, res) => res.json({ success: true, service: "internal-wallet" }));
app.get("/health/db", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    return res.status(200).json({
      success: true,
      service: "Veyra API",
      database: "connected"
    });
  } catch (error) {
    console.error("Database health check failed:", error);

    return res.status(503).json({
      success: false,
      service: "Veyra API",
      database: "disconnected"
    });
  }
});

app.post("/api/auth/register", authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    firstName: z.string().min(2).max(60),
    lastName: z.string().min(2).max(60),
    username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/),
    phone: z.string().regex(/^0\d{10}$/),
    email: z.string().email(),
    password: z.string().min(8).max(128),
    pin: z.string().regex(/^\d{4}$/),
    nin: z.string().regex(/^\d{11}$/).optional().or(z.literal(""))
  }).parse(req.body);

const normalizedEmail = body.email.trim().toLowerCase();
const normalizedPhone = body.phone.trim();
const normalizedUsername = body.username.trim().toLowerCase();
const firstName = body.firstName.trim();
const lastName = body.lastName.trim();

const exists = await prisma.user.findFirst({
  where: {
    OR: [
      { phone: normalizedPhone },
      { email: normalizedEmail },
      { username: normalizedUsername },
      { profile: { is: { username: normalizedUsername } } }
    ]
  },
  select: { id: true }
});

if (exists) {
  return res.status(409).json({
    success: false,
    code: "ACCOUNT_EXISTS",
    message: "Phone, email or username is already registered."
  });
}

  const passwordHash = await argon2.hash(body.password);
  const pinHash = await argon2.hash(body.pin);
  const user = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const accountNumber = await createUniqueAccountNumber(tx);
    const u = await tx.user.create({
      data: {
        firstName,
        lastName,
        username: normalizedUsername,
        phone: normalizedPhone,
        email: normalizedEmail,
        passwordHash,
        pinHash,
        accountNumber,
        ninLast4: body.nin ? body.nin.slice(-4) : null
      }
    });

    // Account.balanceKobo is the canonical balance. Wallet is a compatibility
    // mirror for older service routes and starts from the exact same amount.
    const startingBalanceKobo = 50000000000n;
    const startingBalance = new Prisma.Decimal(startingBalanceKobo.toString()).div(100);
    await tx.account.create({
      data: {
        userId: u.id,
        accountNumber,
        balanceKobo: startingBalanceKobo,
        currency: "NGN",
        status: "ACTIVE"
      }
    });
    await tx.wallet.create({
      data: { userId: u.id, balance: startingBalance, currency: "NGN", status: "ACTIVE" }
    });
    await tx.profile.create({ data: { userId: u.id, firstName: u.firstName, lastName: u.lastName, profileImageUrl: u.profileImageUrl, showUsername: true, allowPhoneReceiving: true, emailNotifications: true, loginAlerts: true, legalFirstName: u.firstName, legalLastName: u.lastName, username: u.username, phone: u.phone, email: u.email, avatarUrl: u.profileImageUrl } });
    await tx.identity.create({ data: { userId: u.id, status: "UNVERIFIED", ninLast4: u.ninLast4, faceStatus: "NOT_CONFIGURED" } });
    await tx.auditLog.create({ data: { userId: u.id, actorUserId: u.id, targetUserId: u.id, action: "ACCOUNT_REGISTERED", entityType: "Account", entityId: u.id, metadata: { startingBalanceKobo: "50000000000" } } });
    await tx.notification.create({
      data: {
        userId: u.id,
        channel: "IN_APP",
        type: "SYSTEM",
        title: "Welcome",
        body: "Your internal wallet has been created.",
        message: "Your internal wallet has been created.",
        status: "QUEUED"
      }
    });
    return u;
  });

  const refresh = signRefresh(user.id);
  const session = await prisma.session.create({
    data: { userId: user.id, refreshHash: hashToken(refresh), expiresAt: new Date(Date.now() + 730 * 86400000) }
  });
  const access = signAccess(user.id, session.id);
  res.status(201).json({ success: true, accessToken: access, refreshToken: refresh });
}));

app.post("/api/owner/bootstrap", authLimiter, asyncRoute(async (req: any, res: any) => {
  const setupKey = process.env.OWNER_SETUP_KEY?.trim();
  const supplied = String(req.headers["x-owner-setup-key"] || "");
  if (!setupKey || setupKey.length < 32 || !supplied) return res.status(503).json({ success:false, code:"OWNER_BOOTSTRAP_NOT_CONFIGURED", message:"Owner bootstrap is disabled until a strong OWNER_SETUP_KEY is configured." });
  const a = Buffer.from(setupKey), b = Buffer.from(supplied);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ success:false, code:"OWNER_SETUP_KEY_INVALID", message:"Owner setup authorization failed." });
  const existingOwner = await prisma.user.findFirst({ where:{ role:"OWNER" }, select:{ id:true } });
  if (existingOwner) return res.status(409).json({ success:false, code:"OWNER_ALREADY_CONFIGURED", message:"An owner is already configured. Bootstrap is one-time only." });
  const body = z.object({ email:z.string().email() }).parse(req.body);
  const user = await prisma.user.findUnique({ where:{ email:body.email.toLowerCase() }, select:{ id:true, email:true } });
  if (!user) return res.status(404).json({ success:false, code:"OWNER_USER_NOT_FOUND", message:"Register and verify the intended owner account before bootstrapping it." });
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.user.update({ where:{ id:user.id }, data:{ role:"OWNER" } });
    await tx.auditLog.create({ data:{ actorUserId:user.id, targetUserId:user.id, action:"OWNER_BOOTSTRAPPED", entityType:"User", entityId:user.id, metadata:{ oneTime:true } } });
  });
  res.json({ success:true, message:"Owner role configured. Remove OWNER_SETUP_KEY from the deployment environment now." });
}));

app.post("/api/auth/login", authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    identifier: z.string(),
    password: z.string()
  }).parse(req.body);

  
const identifier = body.identifier.trim();
const normalizedIdentifier = identifier.toLowerCase();

const user = await prisma.user.findFirst({
  where: {
    OR: [
      { phone: identifier },
      { email: normalizedIdentifier },
      { username: normalizedIdentifier },
      { profile: { is: { username: normalizedIdentifier } } }
    ]
  }
});

  if (!user || !(await argon2.verify(user.passwordHash, body.password))) {
    return res.status(401).json({ success: false, code: "INVALID_LOGIN", message: "Invalid login details." });
  }

  if (user.status !== "ACTIVE") {
    return res.status(403).json({ success: false, code: "ACCOUNT_LOCKED", message: "Account is not active." });
  }

  const refresh = signRefresh(user.id);
  const session = await prisma.session.create({
    data: { userId: user.id, refreshHash: hashToken(refresh), expiresAt: new Date(Date.now() + 730 * 86400000) }
  });
  const access = signAccess(user.id, session.id);
  const account = await prisma.account.findUnique({
  where: { userId: user.id },
  select: {
    accountNumber: true,
    balanceKobo: true,
    level: true,
    currency: true,
    status: true
  }
});

res.json({
  success: true,
  accessToken: access,
  refreshToken: refresh,
  user: {
    id: user.id,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    accountNumber: user.accountNumber,
    upgradeLevel: user.upgradeLevel,
    profileImageUrl: user.profileImageUrl
  },
  account: account
    ? {
        ...account,
        balanceKobo: account.balanceKobo.toString()
      }
    : null
});
  }));

app.post("/api/auth/refresh", authLimiter, asyncRoute(async (req: any, res: any) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(20) }).parse(req.body);
  try {
    const payload = verifyRefresh(refreshToken);
    const currentHash = hashToken(refreshToken);
    const session = await prisma.session.findFirst({
      where: { userId: payload.sub, refreshHash: currentHash, revokedAt: null, expiresAt: { gt: new Date() } }
    });

    if (!session) {
      const reused = await prisma.session.findFirst({ where: { userId: payload.sub, previousRefreshHash: currentHash } });
      if (reused) {
        await prisma.session.updateMany({ where: { userId: payload.sub, revokedAt: null }, data: { revokedAt: new Date() } });
        await prisma.securityEvent.create({ data: { userId: payload.sub, event: "REFRESH_TOKEN_REUSE_DETECTED" } });
      }
      return res.status(401).json({ success: false, code: "INVALID_REFRESH", message: "Refresh session invalid." });
    }

    const nextRefresh = signRefresh(payload.sub);
    await prisma.session.update({
      where: { id: session.id },
      data: { refreshHash: hashToken(nextRefresh), previousRefreshHash: currentHash, expiresAt: new Date(Date.now() + 730 * 86400000) }
    });
    res.json({ success: true, accessToken: signAccess(payload.sub, session.id), refreshToken: nextRefresh });
  } catch {
    res.status(401).json({ success: false, code: "INVALID_REFRESH", message: "Refresh session invalid." });
  }
}));

app.post("/api/auth/logout", requireAuth, asyncRoute(async (req: any, res: any) => {
  await prisma.session.deleteMany({ where: { userId: req.userId } });
  res.json({ success: true });
}));

app.get("/api/me", requireAuth, asyncRoute(async (req: any, res: any) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    include: { account: true }
  });
  if (!user) return res.status(404).json({ success: false, message: "User not found" });
  if (!user.account) return res.status(409).json({ success: false, code: "ACCOUNT_NOT_INITIALIZED", message: "The account record is not initialized. Contact support." });
  res.json({
    success: true,
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      phone: user.phone,
      email: user.email,
      accountNumber: user.accountNumber,
      balance: new Prisma.Decimal(user.account.balanceKobo.toString()).div(100).toFixed(2),
      ninLast4: user.ninLast4,
      identityStatus: user.identityStatus,
      faceVerificationStatus: user.faceVerificationStatus,
      upgradeLevel: user.upgradeLevel,
      showUsername: user.showUsername,
      allowPhoneReceiving: user.allowPhoneReceiving,
      emailNotifications: user.emailNotifications,
      loginAlerts: user.loginAlerts,
      profileImageUrl: user.profileImageUrl
    }
  });
}));

app.get("/api/users/lookup", requireAuth, asyncRoute(async (req: any, res: any) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 3) return res.status(400).json({ success: false, message: "Search is too short." });

  const user = await prisma.user.findFirst({
    where: {
      status: "ACTIVE",
      OR: [{ phone: q }, { accountNumber: q }, { username: q }]
    },
    select: { id: true, firstName: true, lastName: true, username: true, accountNumber: true }
  });

  if (!user || user.id === req.userId) return res.status(404).json({ success: false, message: "Recipient not found." });
  res.json({ success: true, recipient: user });
}));

app.get("/api/transfers/internal/recipient-history", requireAuth, asyncRoute(async (req: any, res: any) => {
  const recipientId = String(req.query.recipientId || "").trim();
  if (!recipientId) {
    return res.status(400).json({ success: false, code: "RECIPIENT_REQUIRED" });
  }
  if (recipientId === req.userId) {
    return res.status(400).json({ success: false, code: "SELF_TRANSFER" });
  }

  const prior = await prisma.transaction.findFirst({
    where: {
      senderId: req.userId,
      receiverId: recipientId,
      status: "SUCCESS",
      type: "INTERNAL_TRANSFER"
    },
    select: { id: true }
  });

  res.json({ success: true, hasPriorSuccessfulTransfer: Boolean(prior) });
}));

app.post("/api/transfers/internal", requireAuth, moneyLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    recipientId: z.string(),
    amount: z.coerce.number().positive().max(50000000),
    narration: z.string().max(140).optional(),
    pin: z.string().regex(/^\d{4}$/).optional(),
    authorizationId: z.string().optional(),
    senderId: z.string().trim().max(30).optional()
  }).parse(req.body);

  if (Boolean(body.pin) === Boolean(body.authorizationId)) {
    return res.status(400).json({ success:false, code:"ONE_AUTH_METHOD_REQUIRED", message:"Choose either your transaction PIN or fingerprint authorization." });
  }
  if (body.authorizationId) {
    try {
      await consumeTransferAuthorization(req.userId, body.authorizationId, {
        type: "INTERNAL_TRANSFER",
        recipientId: body.recipientId,
        amount: body.amount,
        narration: body.narration
      });
    } catch (e: any) {
      const code = e?.message || "TRANSFER_AUTHORIZATION_INVALID";
      return res.status(401).json({ success:false, code, message:"Fingerprint authorization expired or does not match this transfer. Please authorize again." });
    }
  } else {
    try {
      await verifyTransactionPin(req.userId, body.pin!);
    } catch (e: any) {
      const code = e?.message || "INVALID_PIN";
      return res.status(code === "PIN_LOCKED" ? 423 : code === "USER_NOT_FOUND" ? 404 : 401)
        .json({ success: false, code, message: friendlyPinError(code) });
    }
  }

  const limitCheck = await checkDailyTransferLimit(req.userId, body.amount);
  if (!limitCheck.ok) return res.status(403).json({ success: false, code: "DAILY_LIMIT_EXCEEDED", message: `This transfer exceeds your ${limitCheck.level} daily limit of ₦${limitCheck.limit.toLocaleString()}.` });

  try {
    const result = await internalTransfer(
      req.userId,
      body.recipientId,
      new Prisma.Decimal(body.amount.toFixed(2)),
      body.narration,
      idempotencyKey(req),
      body.senderId
    );
    res.json({ success: true, transaction: result.transaction });
  } catch (e: any) {
    const code = e.message || "TRANSFER_FAILED";
    const status = code === "INSUFFICIENT_BALANCE" ? 400 : code === "IDEMPOTENCY_KEY_REQUIRED" || code === "INVALID_AMOUNT" ? 400 : code === "IDEMPOTENCY_CONFLICT" ? 409 : 409;
    res.status(status).json({ success: false, code, message: friendlyError(code) });
  }
}));

app.get("/api/transactions", requireAuth, asyncRoute(async (req: any, res: any) => {
  const rows = await prisma.transaction.findMany({
    where: { OR: [{ senderId: req.userId }, { receiverId: req.userId }] },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { sender: { select: { firstName: true, lastName: true, accountNumber: true } }, receiver: { select: { firstName: true, lastName: true, accountNumber: true } } }
  });
  res.json({ success: true, transactions: rows });
}));

app.get("/api/transactions/:id/receipt", requireAuth, asyncRoute(async (req: any, res: any) => {
  const transaction = await prisma.transaction.findFirst({
    where: { id: String(req.params.id), OR: [{ senderId: req.userId }, { receiverId: req.userId }] },
    include: { sender: { select: { firstName: true, lastName: true, accountNumber: true } }, receiver: { select: { firstName: true, lastName: true, accountNumber: true } } }
  });
  if (!transaction) return res.status(404).json({ success: false, code: "RECEIPT_NOT_FOUND", message: "Transaction receipt not found." });
  res.json({ success: true, receipt: { reference: transaction.reference, status: transaction.status, type: transaction.type,
    amount: transaction.amount.toString(), fee: transaction.fee.toString(), total: transaction.total.toString(), currency: String((transaction.metadata as any)?.currency || "NGN"),
    recipientName: transaction.recipientName, recipientAccount: transaction.recipientAccount, recipientBank: transaction.recipientBank,
    narration: transaction.narration, createdAt: transaction.createdAt, completedAt: transaction.completedAt,
    simulated: Boolean((transaction.metadata as any)?.simulated), bankCreditRecorded: Boolean((transaction.metadata as any)?.bankCreditRecorded),
    sender: transaction.sender, receiver: transaction.receiver } });
}));

app.get("/api/account", requireAuth, asyncRoute(async (req: any, res: any) => {
  const account = await prisma.account.findUnique({ where: { userId: req.userId }, select: { accountNumber: true, currency: true, balanceKobo: true, status: true, createdAt: true } });
  if (!account) return res.status(404).json({ success: false, code: "ACCOUNT_NOT_FOUND" });
  res.json({ success: true, account: { ...account, balanceKobo: account.balanceKobo.toString(), balance: (Number(account.balanceKobo) / 100).toFixed(2) } });
}));

app.get("/api/receipts/:reference", requireAuth, asyncRoute(async (req: any, res: any) => {
  const requested = String(req.params.reference);
  const receipt = await prisma.receipt.findFirst({ where: { reference: requested, userId: req.userId } });
  if (receipt) return res.json({ success: true, receipt });
  const transactionRef = requested.replace(/-[SR]$/, "");
  const transaction = await prisma.transaction.findFirst({ where: { reference: transactionRef, OR: [{ senderId: req.userId }, { receiverId: req.userId }] }, include: { sender: { select: { firstName: true, lastName: true, accountNumber: true } }, receiver: { select: { firstName: true, lastName: true, accountNumber: true } } } });
  if (!transaction) return res.status(404).json({ success: false, code: "RECEIPT_NOT_FOUND", message: "No receipt was found for this reference." });
  res.json({ success: true, receipt: { reference: transaction.reference, status: transaction.status, kind: transaction.type === "BANK_TRANSFER" ? "BANK_TRANSFER" : "VEYRA_TRANSFER", snapshot: { reference: transaction.reference, status: transaction.status, amount: transaction.amount.toFixed(2), currency: String((transaction.metadata as any)?.currency || "NGN"), type: transaction.type, recipientName: transaction.recipientName, recipientAccount: transaction.recipientAccount, recipientBank: transaction.recipientBank, createdAt: transaction.createdAt.toISOString(), completedAt: transaction.completedAt?.toISOString() || null, simulated: Boolean((transaction.metadata as any)?.simulated), sender: transaction.sender, receiver: transaction.receiver } } });
}));

app.patch("/api/profile", requireAuth, authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ firstName: z.string().min(2).max(60).optional(), lastName: z.string().min(2).max(60).optional(),
    username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/).optional(), phone: z.string().regex(/^0\d{10}$/).optional(),
    email: z.string().email().optional(), showUsername: z.boolean().optional(), allowPhoneReceiving: z.boolean().optional(),
    emailNotifications: z.boolean().optional(), loginAlerts: z.boolean().optional(), profileImageUrl: z.string().max(2000000).nullable().optional() }).strict().parse(req.body);
  const identity = await prisma.identity.findUnique({ where: { userId: req.userId }, select: { status: true, lockedLegalName: true } });
  const currentUser = await prisma.user.findUnique({ where: { id: req.userId }, select: { firstName: true, lastName: true, identityStatus: true } });
  if ((identity?.status === "VERIFIED" || currentUser?.identityStatus === "VERIFIED") && ((body.firstName && body.firstName !== currentUser?.firstName) || (body.lastName && body.lastName !== currentUser?.lastName))) return res.status(403).json({ success:false, code:"VERIFIED_NAME_LOCKED", message:"Your legal name is locked after identity verification. Contact support for an authorized correction." });
  const user = await prisma.user.update({ where: { id: req.userId }, data: { ...body, email: body.email?.toLowerCase(), username: body.username?.toLowerCase() },
    select: { id: true, firstName: true, lastName: true, username: true, phone: true, email: true, accountNumber: true, showUsername: true, allowPhoneReceiving: true, emailNotifications: true, loginAlerts: true, profileImageUrl: true, upgradeLevel: true, identityStatus: true } });
  await prisma.profile.upsert({ where: { userId: req.userId }, create: { userId: req.userId, firstName: user.firstName, lastName: user.lastName, profileImageUrl: user.profileImageUrl, username: user.username, showUsername: user.showUsername, allowPhoneReceiving: user.allowPhoneReceiving, emailNotifications: user.emailNotifications, loginAlerts: user.loginAlerts, legalFirstName: user.firstName, legalLastName: user.lastName, phone: user.phone, email: user.email, avatarUrl: user.profileImageUrl }, update: { firstName: user.firstName, lastName: user.lastName, profileImageUrl: user.profileImageUrl, username: user.username, showUsername: user.showUsername, allowPhoneReceiving: user.allowPhoneReceiving, emailNotifications: user.emailNotifications, loginAlerts: user.loginAlerts, legalFirstName: user.firstName, legalLastName: user.lastName, phone: user.phone, email: user.email, avatarUrl: user.profileImageUrl } });
  await prisma.auditLog.create({ data: { actorUserId: req.userId, targetUserId: req.userId, action: "PROFILE_UPDATED", entityType: "Profile", entityId: req.userId } });
  res.json({ success: true, user });
}));

const UPGRADE_POLICIES: Record<string, any> = {
  BASIC: { maxBalance: 500000000, dailyTransferLimit: 50000000, requires: ["Email and phone confirmed"], benefits: ["Internal transfers", "Basic service access"] },
  VERIFIED: { maxBalance: 5000000000, dailyTransferLimit: 500000000, requires: ["NIN verification by a configured provider", "Additional review"], benefits: ["Higher limits", "Expanded payment access"] },
  PREMIUM: { maxBalance: 50000000000, dailyTransferLimit: 5000000000, requires: ["Verified identity", "Enhanced due diligence", "Approval"], benefits: ["Highest configured limits", "Priority support"] }
};
async function checkDailyTransferLimit(userId: string, amount: number) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { upgradeLevel: true } });
  const level = user?.upgradeLevel || "BASIC";
  const policy = UPGRADE_POLICIES[level] || UPGRADE_POLICIES.BASIC;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const spent = await prisma.transaction.aggregate({ where: { senderId: userId, createdAt: { gte: start }, status: { in: ["SUCCESS", "PROCESSING", "PENDING"] } }, _sum: { amount: true } });
  const used = Number(spent._sum.amount || 0);
  return { ok: used + amount <= policy.dailyTransferLimit, level, limit: policy.dailyTransferLimit };
}

app.get("/api/upgrades", requireAuth, asyncRoute(async (req: any, res: any) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { upgradeLevel: true } });
  const requests = await prisma.upgradeRequest.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" }, take: 10 });
  res.json({ success: true, currentLevel: user?.upgradeLevel || "BASIC", policies: UPGRADE_POLICIES, requests });
}));
app.post("/api/upgrades/request", requireAuth, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ level: z.enum(["VERIFIED", "PREMIUM"]) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { upgradeLevel: true, ninLast4: true, identityStatus: true } });
  if (!user) return res.status(404).json({ success: false, code: "USER_NOT_FOUND", message: "Account not found." });
  if (body.level === "VERIFIED" && !user.ninLast4) return res.status(400).json({ success: false, code: "NIN_REQUIRED", message: "Add your NIN before requesting this upgrade. Identity remains unverified until a trusted verification provider confirms it." });
  if (body.level === "PREMIUM" && user.identityStatus !== "VERIFIED") return res.status(400).json({ success: false, code: "IDENTITY_VERIFICATION_REQUIRED", message: "Premium requires verified identity and review." });
  const existing = await prisma.upgradeRequest.findFirst({ where: { userId: req.userId, requestedLevel: body.level, status: "PENDING" } });
  if (existing) return res.status(409).json({ success: false, code: "UPGRADE_ALREADY_PENDING", request: existing });
  const request = await prisma.upgradeRequest.create({ data: { userId: req.userId, requestedLevel: body.level, requirementNote: "Pending identity/provider and administrative checks." } });
  res.status(201).json({ success: true, request, message: "Upgrade request submitted for review. Limits do not change until approved." });
}));
app.post("/api/admin/upgrades/:id/approve", requireAuth, requireAdmin, asyncRoute(async (req: any, res: any) => {
  const request = await prisma.upgradeRequest.findFirst({ where: { id: String(req.params.id), status: "PENDING" } });
  if (!request) return res.status(404).json({ success: false, code: "UPGRADE_REQUEST_NOT_FOUND", message: "Pending upgrade request not found." });
  const user = await prisma.user.findUnique({ where: { id: request.userId }, select: { identityStatus: true } });
  if (user?.identityStatus !== "VERIFIED") return res.status(400).json({ success: false, code: "IDENTITY_VERIFICATION_REQUIRED", message: "Identity must be verified before this upgrade can be approved." });
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.user.update({ where: { id: request.userId }, data: { upgradeLevel: request.requestedLevel } });
    await tx.upgradeRequest.update({ where: { id: request.id }, data: { status: "APPROVED", reviewedAt: new Date(), reviewedBy: req.userId } });
    await tx.upgrade.create({ data: { userId: request.userId, level: request.requestedLevel, status: "ACTIVE", activatedAt: new Date(), reviewedBy: req.userId, entitlementSet: UPGRADE_POLICIES[request.requestedLevel] || UPGRADE_POLICIES.BASIC } });
    await tx.auditLog.create({ data: { actorUserId: req.userId, targetUserId: request.userId, action: "UPGRADE_APPROVED", entityType: "Upgrade", entityId: request.id, metadata: { level: request.requestedLevel } } });
    await tx.notification.create({ data: { userId: request.userId, type: "SYSTEM", title: "Upgrade approved", message: `Your ${request.requestedLevel} tier was approved.` } });
  });
  res.json({ success: true, message: "Upgrade approved." });
}));

app.get("/api/notifications", requireAuth, asyncRoute(async (req: any, res: any) => {
  const rows = await prisma.notification.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  res.json({ success: true, notifications: rows });
}));

app.post("/api/notifications/read-all", requireAuth, asyncRoute(async (req: any, res: any) => {
  await prisma.notification.updateMany({ where: { userId: req.userId }, data: { read: true } });
  res.json({ success: true });
}));

app.get("/api/banks", requireAuth, asyncRoute(async (_req: any, res: any) => {
  res.json({ success: true, banks: await prisma.bank.findMany({ orderBy: { name: "asc" } }) });
}));

// Paystack bank directory and live account-name resolution.
// The Paystack secret key MUST remain on the backend.
let paystackBanksCache: { expiresAt: number; banks: any[] } = { expiresAt: 0, banks: [] };

async function paystackRequest(path: string, init: RequestInit = {}) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error("PAYSTACK_NOT_CONFIGURED");
  const response = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
  let data: any = {};
  try { data = await response.json(); } catch {}
  if (!response.ok || data.status === false) {
    const err: any = new Error(data.message || "Paystack request failed.");
    err.httpStatus = response.status;
    throw err;
  }
  return data;
}

app.get("/api/paystack/banks", requireAuth, asyncRoute(async (_req: any, res: any) => {
  if (Date.now() < paystackBanksCache.expiresAt && paystackBanksCache.banks.length) {
    return res.json({ success: true, banks: paystackBanksCache.banks, source: "paystack-cache" });
  }
  const data = await paystackRequest("/bank?country=nigeria&perPage=100");
  const banks = (data.data || [])
    .filter((b: any) => b.active !== false && b.code && b.name)
    .map((b: any) => ({
      id: b.id,
      name: b.name,
      code: String(b.code),
      active: b.active !== false,
      country: b.country || "Nigeria",
      currency: b.currency || "NGN",
      type: b.type || "nuban"
    }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
  paystackBanksCache = { expiresAt: Date.now() + 6 * 60 * 60 * 1000, banks };
  res.json({ success: true, banks, source: "paystack" });
}));

app.get("/api/paystack/resolve", requireAuth, moneyLimiter, asyncRoute(async (req: any, res: any) => {
  const { accountNumber, bankCode } = z.object({
    accountNumber: z.string().regex(/^\d{10}$/),
    bankCode: z.string().min(2).max(20)
  }).parse({
    accountNumber: String(req.query.accountNumber || ""),
    bankCode: String(req.query.bankCode || "")
  });

  try {
    const data = await paystackRequest(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
    const account = data.data;
    if (!account?.account_name) {
      return res.status(404).json({ success: false, code: "ACCOUNT_NOT_RESOLVED", message: "Could not resolve the account name." });
    }
    res.json({
      success: true,
      account: {
        accountNumber: String(account.account_number || accountNumber),
        accountName: String(account.account_name),
        bankId: account.bank_id ?? null,
        bankCode
      },
      source: "paystack"
    });
  } catch (e: any) {
    const message = String(e?.message || "Could not resolve account.");
    if (message === "PAYSTACK_NOT_CONFIGURED") {
      return res.status(503).json({ success: false, code: message, message: "Paystack account verification is not configured on the Veyra backend." });
    }
    return res.status(404).json({ success: false, code: "ACCOUNT_NOT_RESOLVED", message: "Could not resolve account name. Check the bank and account number." });
  }
}));

app.get("/api/banks/resolve", requireAuth, moneyLimiter, asyncRoute(async (req: any, res: any) => {
  const parsed = z.object({
    accountNumber: z.string().regex(/^\d{10}$/),
    bankCode: z.string().trim().min(2).max(20)
  }).safeParse({
    accountNumber: String(req.query.accountNumber || ""),
    bankCode: String(req.query.bankCode || "")
  });

  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      code: "INVALID_BANK_LOOKUP_INPUT",
      message: "Enter a valid 10-digit account number and select a bank."
    });
  }

  const { accountNumber, bankCode } = parsed.data;

  try {
    const local = await prisma.bankAccount.findFirst({
      where: { accountNumber, active: true, bank: { code: bankCode } },
      include: { bank: true }
    });

    if (local) {
      return res.json({
        success: true,
        account: {
          accountNumber,
          accountName: local.accountName,
          bank: local.bank.name,
          bankCode
        },
        source: "veyra-bank-directory",
        verificationStatus: "VERIFIED"
      });
    }

    const data = await paystackRequest(
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`
    );

    const account = data?.data;
    const resolvedNumber = String(account?.account_number || accountNumber);
    const accountName = String(account?.account_name || "").trim();

    if (!accountName || resolvedNumber !== accountNumber) {
      console.warn("[bank-resolve] Provider returned no usable matching account", {
        bankCode,
        accountNumberLength: accountNumber.length,
        hasAccountName: Boolean(accountName),
        accountNumberMatched: resolvedNumber === accountNumber
      });

      return res.status(422).json({
        success: false,
        code: "ACCOUNT_NOT_RESOLVED",
        message: "The bank could not verify this account. Check the bank selection and account number."
      });
    }

    return res.json({
      success: true,
      account: {
        accountNumber: resolvedNumber,
        accountName,
        bank: String(account.bank_name || ""),
        bankCode
      },
      source: "paystack",
      verificationStatus: "VERIFIED",
      providerReference: account.bank_id ? String(account.bank_id) : null
    });
  } catch (e: any) {
    const message = String(e?.message || "Unknown provider error");
    const status = Number(e?.httpStatus || e?.status || 0);

    // Log only safe diagnostic information. Never log API keys or authorization headers.
    console.error("[bank-resolve] Lookup failed", {
      code: String(e?.code || ""),
      message: message.slice(0, 240),
      httpStatus: status || null,
      bankCode,
      accountNumberLength: accountNumber.length
    });

    if (message === "PAYSTACK_NOT_CONFIGURED") {
      return res.status(503).json({
        success: false,
        code: "ACCOUNT_RESOLUTION_PROVIDER_NOT_CONFIGURED",
        message: "The account verification provider is not available."
      });
    }

    if (status === 429) {
      return res.status(429).json({
        success: false,
        code: "ACCOUNT_RESOLUTION_RATE_LIMITED",
        message: "Account verification is temporarily busy. Please try again shortly."
      });
    }

    if (status === 401 || status === 403) {
      return res.status(502).json({
        success: false,
        code: "ACCOUNT_RESOLUTION_PROVIDER_AUTH_ERROR",
        message: "The account verification provider rejected the request. Check the backend provider configuration."
      });
    }

    if (status >= 500 || /timeout|ECONNRESET|ENOTFOUND|fetch failed|network/i.test(message)) {
      return res.status(502).json({
        success: false,
        code: "ACCOUNT_RESOLUTION_PROVIDER_UNAVAILABLE",
        message: "The account verification service is temporarily unavailable. Please retry."
      });
    }

    return res.status(422).json({
      success: false,
      code: "ACCOUNT_NOT_RESOLVED",
      message: "The bank could not verify this account. Check the bank selection and account number."
    });
  }
}));

app.get("/api/banks/lookup", requireAuth, asyncRoute(async (req: any, res: any) => {
  const accountNumber = String(req.query.accountNumber || "");
  const bankCode = String(req.query.bankCode || "");
  const account = await prisma.bankAccount.findFirst({
    where: { accountNumber, active: true, bank: { code: bankCode } },
    include: { bank: true }
  });
  if (!account) return res.status(404).json({ success: false, message: "Simulated account not found." });
  res.json({ success: true, account: { accountNumber: account.accountNumber, accountName: account.accountName, bank: account.bank.name, bankCode } });
}));

app.post("/api/transfers/external/simulate", requireAuth, asyncRoute(async (_req: any, res: any) => {
  res.status(410).json({ success: false, code: "SIMULATION_ROUTE_RETIRED", message: "Use the provider-backed bank-transfer route. No simulated external transfer is accepted." });
}));

app.post("/api/services/payment", requireAuth, moneyLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    type: z.enum(["AIRTIME", "DATA", "ELECTRICITY", "TV", "INTERNET", "WATER", "EDUCATION"]),
    target: z.string().min(3).max(100),
    amount: z.coerce.number().positive().max(10000000),
    pin: z.string().regex(/^\d{4}$/)
  }).parse(req.body);

  const user = await prisma.user.findUnique({ where: { id: req.userId }, include: { wallet: true } });
  if (!user?.wallet) return res.status(404).json({ success: false, message: "Wallet not found." });
  try {
    await verifyTransactionPin(req.userId, body.pin);
  } catch (e: any) {
    const code = e?.message || "INVALID_PIN";
    return res.status(code === "PIN_LOCKED" ? 423 : code === "USER_NOT_FOUND" ? 404 : 401)
      .json({ success: false, code, message: friendlyPinError(code) });
  }

  const amount = new Prisma.Decimal(body.amount.toFixed(2));

  const requestKey = idempotencyKey(req);
  if (!requestKey) return res.status(400).json({ success: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "A transaction request key is required." });
  const requestHash = hashRequest({ type: body.type, target: body.target, amount: amount.toFixed(2) });
  const transaction = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    
const existing = await tx.idempotencyKey.findUnique({
  where: {
    userId_key: {
      userId: req.userId,
      key: requestKey
    }
  },
  include: { transaction: true }
});
  
    if (existing) {
      if (existing.userId !== req.userId || existing.requestHash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
      return existing.transaction;
    }
    const created = await tx.transaction.create({
      data: {
        reference: reference("PAY"),
        senderId: user.id,
        type: body.type as any,
        status: "PROCESSING",
        amount,
        total: amount,
        recipientAccount: body.target,
        metadata: { simulated: true }
      }
    });

    const debit = await tx.wallet.updateMany({ where: { userId: user.id, status: "ACTIVE", balance: { gte: amount } }, data: { balance: { decrement: amount } } });
    if (debit.count !== 1) throw new Error("INSUFFICIENT_BALANCE");
    const accountDebit = await tx.account.updateMany({ where: { userId: user.id, status: "ACTIVE", balanceKobo: { gte: amountToKobo(amount) } }, data: { balanceKobo: { decrement: amountToKobo(amount) } } });
    if (accountDebit.count !== 1) throw new Error("ACCOUNT_BALANCE_MISMATCH");
    await tx.transaction.update({ where: { id: created.id }, data: { status: "SUCCESS", completedAt: new Date() } });
    await tx.transactionEntry.create({ data: { transactionId: created.id, userId: user.id, type: "DEBIT", amount } });
    await tx.notification.create({
      data: {
        userId: user.id,
        type: "PAYMENT",
        title: `${body.type} Successful`,
        message: `₦${amount.toFixed(2)} simulated ${body.type.toLowerCase()} payment to ${body.target}.`
      }
    });
    await tx.idempotencyKey.create({ data: { key: requestKey, userId: req.userId, requestHash, transactionId: created.id } });
    return tx.transaction.findUnique({ where: { id: created.id } });
  });

  res.json({ success: true, simulated: true, transaction });
}));

app.post("/api/security/password", requireAuth, authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ currentPassword: z.string(), newPassword: z.string().min(8).max(128) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { passwordHash: true } });
  if (!user || !(await argon2.verify(user.passwordHash, body.currentPassword))) return res.status(401).json({ success: false, code: "INVALID_PASSWORD", message: "Current password is incorrect." });
  await prisma.user.update({ where: { id: req.userId }, data: { passwordHash: await argon2.hash(body.newPassword) } });
  await prisma.session.deleteMany({ where: { userId: req.userId } });
  const refresh = signRefresh(req.userId);
  const session = await prisma.session.create({ data: { userId: req.userId, refreshHash: hashToken(refresh), expiresAt: new Date(Date.now() + 730 * 86400000) } });
  const access = signAccess(req.userId, session.id);
  res.json({ success: true, accessToken: access, refreshToken: refresh, message: "Password updated successfully." });
}));

app.post("/api/security/pin", requireAuth, moneyLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    currentPin: z.string().regex(/^\d{4}$/).optional(),
    currentPassword: z.string().min(1).max(128).optional(),
    newPin: z.string().regex(/^\d{4}$/)
  }).parse(req.body);

  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { pinHash: true, passwordHash: true }
  });

  if (!user) {
    return res.status(404).json({
      success: false, code: "USER_NOT_FOUND", message: "Account not found."
    });
  }

  if (user.pinHash) {
    if (!body.currentPin || !(await argon2.verify(user.pinHash, body.currentPin))) {
      return res.status(401).json({
        success: false, code: "INVALID_PIN",
        message: "Current transaction PIN is incorrect."
      });
    }
  } else {
    if (!body.currentPassword || !(await argon2.verify(user.passwordHash, body.currentPassword))) {
      return res.status(401).json({
        success: false, code: "INVALID_PASSWORD",
        message: "Verify your account password before setting a transaction PIN."
      });
    }
  }

  const pinHash = await argon2.hash(body.newPin);

  await prisma.user.update({
    where: { id: req.userId },
    data: { pinHash, pinFailures: 0, pinLockedUntil: null }
  });

  res.json({ success: true, message: "Transaction PIN updated successfully." });
}));

app.post("/api/security/pin/recover", requireAuth, authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    currentPassword: z.string().min(1).max(128),
    newPin: z.string().regex(/^\d{4}$/)
  }).parse(req.body);

  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, passwordHash: true }
  });

  if (!user) {
    return res.status(404).json({
      success: false, code: "USER_NOT_FOUND", message: "Account not found."
    });
  }

  const passwordValid = await argon2.verify(user.passwordHash, body.currentPassword);

  if (!passwordValid) {
    return res.status(401).json({
      success: false, code: "INVALID_PASSWORD",
      message: "Current account password is incorrect."
    });
  }

  const pinHash = await argon2.hash(body.newPin);

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.user.update({
      where: { id: req.userId },
      data: { pinHash, pinFailures: 0, pinLockedUntil: null }
    });

    await tx.auditLog.create({
      data: {
        actorUserId: req.userId,
        targetUserId: req.userId,
        action: "TRANSACTION_PIN_RECOVERED",
        entityType: "User",
        entityId: req.userId,
        outcome: "SUCCESS",
        ipAddress: req.ip,
        userAgent: String(req.get("user-agent") || ""),
        metadata: { method: "ACCOUNT_PASSWORD", pinLockCleared: true }
      }
    });
  });

  res.json({
    success: true,
    message: "Transaction PIN recovered successfully. You can now make PIN-protected transactions."
  });
}));

// WebAuthn is verified on the backend. On phones without a fingerprint sensor,
// Android may use the device screen lock (PIN/pattern) as the platform authenticator.
app.post("/api/security/webauthn/register/options", requireAuth, authLimiter, asyncRoute(async (req: any, res: any) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, username: true, firstName: true, lastName: true } });
  if (!user) return res.status(404).json({ success: false, code: "USER_NOT_FOUND" });
  const { origin, rpID } = webAuthnConfig();
  const existing = await prisma.device.findMany({ where: { userId: req.userId, revokedAt: null }, select: { credentialId: true, transports: true } });
  const options: any = await generateRegistrationOptions({ rpName: "Veyra", rpID, userID: new TextEncoder().encode(user.id), userName: user.username, userDisplayName: `${user.firstName} ${user.lastName}`.trim(), attestationType: "none", authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" }, excludeCredentials: existing.map((d: any) => ({ id: d.credentialId, transports: d.transports })) } as any);
  const challenge = await prisma.webAuthnChallenge.create({ data: { userId: req.userId, challenge: options.challenge, purpose: "REGISTRATION", expiresAt: new Date(Date.now() + 5 * 60_000) } });
  await prisma.auditLog.create({ data: { actorUserId: req.userId, targetUserId: req.userId, action: "WEBAUTHN_REGISTRATION_STARTED", entityType: "Device", metadata: { rpID, origin } } });
  res.json({ success: true, challengeId: challenge.id, publicKey: options, supportedFallback: "If fingerprint hardware is unavailable, your phone may ask for its screen-lock PIN or pattern." });
}));

app.post("/api/security/webauthn/register/verify", requireAuth, authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ challengeId: z.string().min(1), credential: z.record(z.string(), z.any()), label: z.string().max(80).optional() }).parse(req.body);
  const challenge = await prisma.webAuthnChallenge.findFirst({ where: { id: body.challengeId, userId: req.userId, purpose: "REGISTRATION", consumedAt: null, expiresAt: { gt: new Date() } } });
  if (!challenge) return res.status(400).json({ success: false, code: "WEBAUTHN_CHALLENGE_EXPIRED", message: "Restart device authentication setup and try again." });
  const { origin, rpID } = webAuthnConfig();
  let verification: any;
  try { verification = await verifyRegistrationResponse({ response: body.credential as any, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true } as any); }
  catch { return res.status(400).json({ success: false, code: "WEBAUTHN_VERIFICATION_FAILED", message: "Your device could not verify the authenticator. Try again or use your password and PIN." }); }
  if (!verification?.verified || !verification.registrationInfo) return res.status(400).json({ success: false, code: "WEBAUTHN_VERIFICATION_FAILED", message: "The device did not confirm secure authentication." });
  const info: any = verification.registrationInfo, cred: any = info.credential || info;
  const credentialId = String(cred.id || body.credential.id || "");
  const publicKey = cred.publicKey as Uint8Array;
  if (!credentialId || !publicKey) return res.status(400).json({ success: false, code: "WEBAUTHN_CREDENTIAL_MISSING" });
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.device.create({ data: { userId: req.userId, credentialId, publicKeyBase64: Buffer.from(publicKey).toString("base64url"), counter: BigInt(Number(cred.counter || 0)), transports: Array.isArray(body.credential.response?.transports) ? body.credential.response.transports.map(String) : [], deviceType: String(info.credentialDeviceType || "PLATFORM"), backedUp: Boolean(info.credentialBackedUp), label: body.label || "This device" } });
    await tx.webAuthnChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
    await tx.auditLog.create({ data: { actorUserId: req.userId, targetUserId: req.userId, action: "WEBAUTHN_DEVICE_REGISTERED", entityType: "Device", metadata: { credentialId, deviceType: String(info.credentialDeviceType || "PLATFORM"), backedUp: Boolean(info.credentialBackedUp) } } });
  });
  res.json({ success: true, verified: true, message: "Secure device authentication has been registered." });
}));



async function consumeTransferAuthorization(userId: string, authorizationId: string, context: any) {
  const challenge = await prisma.webAuthnChallenge.findFirst({
    where: {
      id: authorizationId,
      userId,
      purpose: "TRANSFER_AUTHORIZATION",
      verifiedAt: { not: null },
      consumedAt: null,
      expiresAt: { gt: new Date() }
    }
  });
  if (!challenge) throw new Error("TRANSFER_AUTHORIZATION_INVALID");
  const expectedHash = hashRequest(transferAuthorizationContext(userId, context));
  if (!challenge.contextHash || challenge.contextHash !== expectedHash) {
    throw new Error("TRANSFER_AUTHORIZATION_MISMATCH");
  }
  const consumed = await prisma.webAuthnChallenge.updateMany({
    where: {
      id: challenge.id,
      userId,
      purpose: "TRANSFER_AUTHORIZATION",
      verifiedAt: { not: null },
      consumedAt: null,
      expiresAt: { gt: new Date() },
      contextHash: expectedHash
    },
    data: { consumedAt: new Date() }
  });
  if (consumed.count !== 1) throw new Error("TRANSFER_AUTHORIZATION_INVALID");
}

// TRANSFER_WEBAUTHN_PATCH_V1
function transferAuthorizationContext(userId: string, body: any) {
  const type = String(body.type || "").toUpperCase();
  const amount = new Prisma.Decimal(body.amount).toFixed(2);
  if (type === "INTERNAL_TRANSFER") return {
    userId, type, recipientId: String(body.recipientId || ""),
    amount, narration: String(body.narration || "")
  };
  if (type === "BANK_TRANSFER") return {
    userId, type,
    countryCode: String(body.countryCode || "NG").toUpperCase(),
    currency: String(body.currency || "NGN").toUpperCase(),
    accountNumber: String(body.accountNumber || ""),
    bankCode: String(body.bankCode || ""),
    accountName: String(body.accountName || "").trim(),
    bankName: String(body.bankName || "").trim(),
    amount, narration: String(body.narration || "")
  };
  throw new Error("INVALID_TRANSFER_TYPE");
}

app.post("/api/security/webauthn/transfer/options", requireAuth, authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    type: z.enum(["INTERNAL_TRANSFER", "BANK_TRANSFER"]),
    recipientId: z.string().optional(),
    countryCode: z.string().length(2).optional(),
    currency: z.string().length(3).optional(),
    accountNumber: z.string().optional(),
    bankCode: z.string().optional(),
    accountName: z.string().optional(),
    bankName: z.string().optional(),
    amount: z.coerce.number().positive().max(50000000),
    narration: z.string().max(140).optional()
  }).parse(req.body);

  if (body.type === "INTERNAL_TRANSFER" && !body.recipientId)
    return res.status(400).json({ success: false, code: "RECIPIENT_REQUIRED" });
  if (body.type === "BANK_TRANSFER" && (!body.accountNumber || !body.bankCode || !body.accountName || !body.bankName))
    return res.status(400).json({ success: false, code: "BANK_RECIPIENT_REQUIRED" });

  const devices = await prisma.device.findMany({
    where: { userId: req.userId, revokedAt: null },
    select: { credentialId: true, transports: true }
  });
  if (!devices.length)
    return res.status(404).json({ success: false, code: "WEBAUTHN_NOT_ENROLLED", message: "Set up device authentication first." });

  const { rpID } = webAuthnConfig();
  const options: any = await generateAuthenticationOptions({
    rpID,
    allowCredentials: devices.map((d: any) => ({ id: d.credentialId, transports: d.transports })),
    userVerification: "required"
  } as any);

  const challenge = await prisma.webAuthnChallenge.create({
    data: {
      userId: req.userId,
      challenge: options.challenge,
      purpose: "TRANSFER_AUTHORIZATION",
      contextHash: hashRequest(transferAuthorizationContext(req.userId, body)),
      expiresAt: new Date(Date.now() + 5 * 60_000)
    }
  });
  res.json({ success: true, challengeId: challenge.id, publicKey: options });
}));

app.post("/api/security/webauthn/transfer/verify", requireAuth, authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    challengeId: z.string().min(1),
    credential: z.record(z.string(), z.any())
  }).parse(req.body);

  const challenge = await prisma.webAuthnChallenge.findFirst({
    where: {
      id: body.challengeId, userId: req.userId,
      purpose: "TRANSFER_AUTHORIZATION", consumedAt: null,
      verifiedAt: null, expiresAt: { gt: new Date() }
    }
  });
  if (!challenge) return res.status(400).json({ success: false, code: "TRANSFER_AUTHORIZATION_EXPIRED_OR_USED" });

  const credentialId = String(body.credential.id || "");
  const device = await prisma.device.findFirst({
    where: { userId: req.userId, credentialId, revokedAt: null }
  });
  if (!device) return res.status(401).json({ success: false, code: "WEBAUTHN_DEVICE_UNKNOWN" });

  const { origin, rpID } = webAuthnConfig();
  let verification: any;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.credential as any,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: device.credentialId,
        publicKey: Buffer.from(device.publicKeyBase64, "base64url"),
        counter: Number(device.counter),
        transports: device.transports as any
      },
      requireUserVerification: true
    } as any);
  } catch {
    return res.status(401).json({ success: false, code: "WEBAUTHN_AUTHENTICATION_FAILED" });
  }
  if (!verification?.verified)
    return res.status(401).json({ success: false, code: "WEBAUTHN_AUTHENTICATION_FAILED" });

  const updated = await prisma.webAuthnChallenge.updateMany({
    where: {
      id: challenge.id, userId: req.userId,
      purpose: "TRANSFER_AUTHORIZATION", consumedAt: null,
      verifiedAt: null, expiresAt: { gt: new Date() }
    },
    data: { verifiedAt: new Date() }
  });
  if (updated.count !== 1)
    return res.status(409).json({ success: false, code: "TRANSFER_AUTHORIZATION_ALREADY_USED" });

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.device.update({
      where: { id: device.id },
      data: {
        counter: BigInt(Number(verification.authenticationInfo?.newCounter || 0)),
        lastUsedAt: new Date()
      }
    });
    await tx.auditLog.create({
      data: {
        actorUserId: req.userId, targetUserId: req.userId,
        action: "TRANSFER_WEBAUTHN_VERIFIED",
        entityType: "WebAuthnChallenge", entityId: challenge.id
      }
    });
  });

  res.json({ success: true, verified: true, authorizationId: challenge.id });
}));

app.post("/api/security/webauthn/auth/options", requireAuth, authLimiter, asyncRoute(async (req: any, res: any) => {
  const devices = await prisma.device.findMany({ where: { userId: req.userId, revokedAt: null }, select: { credentialId: true, transports: true } });
  if (!devices.length) return res.status(404).json({ success: false, code: "WEBAUTHN_NOT_ENROLLED", message: "Set up device authentication first." });
  const { origin, rpID } = webAuthnConfig();
  const options: any = await generateAuthenticationOptions({ rpID, allowCredentials: devices.map((d: any) => ({ id: d.credentialId, transports: d.transports })), userVerification: "required" } as any);
  const challenge = await prisma.webAuthnChallenge.create({ data: { userId: req.userId, challenge: options.challenge, purpose: "AUTHENTICATION", expiresAt: new Date(Date.now() + 5 * 60_000) } });
  res.json({ success: true, challengeId: challenge.id, publicKey: options, origin });
}));

app.post("/api/security/webauthn/auth/verify", requireAuth, authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ challengeId: z.string().min(1), credential: z.record(z.string(), z.any()) }).parse(req.body);
  const challenge = await prisma.webAuthnChallenge.findFirst({ where: { id: body.challengeId, userId: req.userId, purpose: "AUTHENTICATION", consumedAt: null, expiresAt: { gt: new Date() } } });
  if (!challenge) return res.status(400).json({ success: false, code: "WEBAUTHN_CHALLENGE_EXPIRED" });
  const credentialId = String(body.credential.id || "");
  const device = await prisma.device.findFirst({ where: { userId: req.userId, credentialId, revokedAt: null } });
  if (!device) return res.status(401).json({ success: false, code: "WEBAUTHN_DEVICE_UNKNOWN" });
  const { origin, rpID } = webAuthnConfig();
  let verification: any;
  try { verification = await verifyAuthenticationResponse({ response: body.credential as any, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, credential: { id: device.credentialId, publicKey: Buffer.from(device.publicKeyBase64, "base64url"), counter: Number(device.counter), transports: device.transports as any }, requireUserVerification: true } as any); }
  catch { return res.status(401).json({ success: false, code: "WEBAUTHN_AUTHENTICATION_FAILED", message: "Device authentication failed. Use your password and transaction PIN instead." }); }
  if (!verification?.verified) return res.status(401).json({ success: false, code: "WEBAUTHN_AUTHENTICATION_FAILED" });
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.device.update({ where: { id: device.id }, data: { counter: BigInt(Number(verification.authenticationInfo?.newCounter || 0)), lastUsedAt: new Date() } });
    await tx.webAuthnChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
    await tx.auditLog.create({ data: { actorUserId: req.userId, targetUserId: req.userId, action: "WEBAUTHN_AUTHENTICATION_SUCCESS", entityType: "Device", entityId: device.id } });
  });
  res.json({ success: true, verified: true, message: "Your device authenticator was verified by Veyra." });
}));

app.get("/api/security/webauthn/devices", requireAuth, asyncRoute(async (req: any, res: any) => {
  const devices = await prisma.device.findMany({ where: { userId: req.userId, revokedAt: null }, select: { id: true, label: true, deviceType: true, backedUp: true, createdAt: true, lastUsedAt: true } });
  res.json({ success: true, devices });
}));

app.post("/api/security/identity/verify-nin", requireAuth, authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ nin: z.string().regex(/^\d{11}$/) }).parse(req.body);
  try {
    const result: any = await callProvider("IDENTITY", "/nin/verify", { nin: body.nin, userId: req.userId });
    if (result?.verified !== true) return res.status(400).json({ success: false, code: "NIN_NOT_VERIFIED", message: "The identity provider could not verify this NIN." });
    const registered = await prisma.user.findUnique({ where:{id:req.userId}, select:{firstName:true,lastName:true} });
    const providerName = String(result.verifiedName || result.fullName || result.name || "").trim().replace(/\s+/g," ");
    const registeredName = `${registered?.firstName || ""} ${registered?.lastName || ""}`.trim().replace(/\s+/g," ");
    if (!providerName || providerName.toLowerCase() !== registeredName.toLowerCase()) {
      await prisma.auditLog.create({ data:{actorUserId:req.userId,targetUserId:req.userId,action:"NIN_VERIFICATION_NAME_MISMATCH",entityType:"Identity",outcome:"FAILED",metadata:{provider:"IDENTITY",providerReturnedName:Boolean(providerName)}} });
      return res.status(409).json({ success:false, code:"NIN_NAME_MISMATCH", message:"The provider did not confirm a name matching your registered legal name. Identity remains unverified; contact support if your name needs correction." });
    }
    const updated = await prisma.user.update({ where: { id: req.userId }, data: { ninLast4: body.nin.slice(-4), identityStatus: "VERIFIED" }, select: { identityStatus: true, ninLast4: true } });
    await prisma.identity.upsert({ where:{userId:req.userId}, create:{userId:req.userId,status:"VERIFIED",ninLast4:updated.ninLast4,ninProvider:"IDENTITY",ninProviderReference:String(result.reference || result.verificationId || "provider-confirmed"),ninVerifiedAt:new Date(),lockedLegalName:registeredName}, update:{status:"VERIFIED",ninLast4:updated.ninLast4,ninProvider:"IDENTITY",ninProviderReference:String(result.reference || result.verificationId || "provider-confirmed"),ninVerifiedAt:new Date(),lockedLegalName:registeredName} });
    await prisma.securityEvent.create({ data: { userId: req.userId, event: "NIN_VERIFIED", metadata: { provider: "IDENTITY", last4: updated.ninLast4 } } });
    await prisma.auditLog.create({ data:{actorUserId:req.userId,targetUserId:req.userId,action:"NIN_VERIFICATION_CONFIRMED",entityType:"Identity",entityId:req.userId,metadata:{provider:"IDENTITY",last4:updated.ninLast4}} });
    res.json({ success: true, identityStatus: updated.identityStatus, ninLast4: updated.ninLast4, message: "Identity provider confirmed the NIN." });
  } catch (e: any) {
    res.status(e?.httpStatus || 503).json({ success: false, code: e?.message?.endsWith("NOT_CONFIGURED") ? e.message : "IDENTITY_PROVIDER_UNAVAILABLE", message: "NIN verification is unavailable until a trusted identity provider is configured. The full NIN was not stored." });
  }
}));
app.get("/api/security/face/verify", requireAuth, asyncRoute(async (req: any, res: any) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { faceVerificationStatus: true } });
  res.json({ success: true, configured: Boolean(process.env.FACE_API_URL && process.env.FACE_API_KEY), status: user?.faceVerificationStatus || "NOT_CONFIGURED" });
}));
app.post("/api/security/face/enroll", requireAuth, authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ template: z.string().min(100).max(2000000) }).parse(req.body);
  try {
    const result: any = await callProvider("FACE", "/face/enroll", { template: body.template, userId: req.userId });
    if (result?.enrolled !== true) return res.status(400).json({ success: false, code: "FACE_ENROLLMENT_FAILED", message: "The face provider did not confirm enrollment." });
    await prisma.user.update({ where: { id: req.userId }, data: { faceVerificationStatus: "ENROLLED" } });
    await prisma.identity.upsert({ where:{userId:req.userId}, create:{userId:req.userId,status:"ENROLLED",faceStatus:"ENROLLED",faceProvider:"FACE",faceProviderReference:String(result.reference || result.enrollmentId || "provider-confirmed")}, update:{status:"ENROLLED",faceStatus:"ENROLLED",faceProvider:"FACE",faceProviderReference:String(result.reference || result.enrollmentId || "provider-confirmed")} });
    await prisma.securityEvent.create({ data: { userId: req.userId, event: "FACE_ENROLLED", metadata: { provider: "FACE" } } });
    await prisma.auditLog.create({ data:{actorUserId:req.userId,targetUserId:req.userId,action:"FACE_ENROLLMENT_CONFIRMED",entityType:"Identity",entityId:req.userId,metadata:{provider:"FACE"}} });
    await prisma.auditLog.create({ data:{actorUserId:req.userId,targetUserId:req.userId,action:"FACE_ENROLLMENT_CONFIRMED",entityType:"Identity",entityId:req.userId,metadata:{provider:"FACE"}} });
    res.json({ success: true, status: "ENROLLED", message: "Face enrollment was confirmed by the configured provider." });
  } catch (e: any) {
    res.status(e?.httpStatus || 503).json({ success: false, code: e?.message?.endsWith("NOT_CONFIGURED") ? e.message : "FACE_PROVIDER_UNAVAILABLE", message: "Secure face enrollment requires a configured identity provider. The face template was not stored by Veyra." });
  }
}));
app.post("/api/security/face/verify", requireAuth, authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ template: z.string().min(100).max(2000000) }).parse(req.body);
  try {
    const result: any = await callProvider("FACE", "/face/verify", { template: body.template, userId: req.userId });
    if (result?.verified !== true) return res.status(401).json({ success: false, code: "FACE_NOT_MATCHED", message: "Face verification failed." });
    await prisma.user.update({ where: { id: req.userId }, data: { faceVerificationStatus: "VERIFIED" } });
    await prisma.identity.upsert({ where:{userId:req.userId}, create:{userId:req.userId,status:"VERIFIED",faceStatus:"VERIFIED",faceProvider:"FACE",faceProviderReference:String(result.reference || result.verificationId || "provider-confirmed"),faceVerifiedAt:new Date()}, update:{faceStatus:"VERIFIED",faceProvider:"FACE",faceProviderReference:String(result.reference || result.verificationId || "provider-confirmed"),faceVerifiedAt:new Date()} });
    await prisma.auditLog.create({ data:{actorUserId:req.userId,targetUserId:req.userId,action:"FACE_VERIFICATION_CONFIRMED",entityType:"Identity",entityId:req.userId,metadata:{provider:"FACE"}} });
    res.json({ success: true, verified: true, status: "VERIFIED" });
  } catch (e: any) {
    res.status(e?.httpStatus || 503).json({ success: false, code: e?.message?.endsWith("NOT_CONFIGURED") ? e.message : "FACE_PROVIDER_UNAVAILABLE", message: "Secure face verification is unavailable until a trusted provider is configured." });
  }
}));

app.get("/api/savings", requireAuth, asyncRoute(async (req: any, res: any) => {
  res.json({ success: true, savings: await prisma.savingsAccount.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } }) });
}));

app.post("/api/savings", requireAuth, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    name: z.string().min(2).max(60),
    type: z.enum(["DAILY", "TARGET", "FIXED", "SAFEBOX"]),
    targetAmount: z.coerce.number().positive().optional()
  }).parse(req.body);

  const savings = await prisma.savingsAccount.create({
    data: {
      userId: req.userId!,
      name: body.name,
      type: body.type,
      targetAmount: body.targetAmount
    }
  });
  res.status(201).json({ success: true, savings });
}));

app.post("/api/savings/:id/deposit", requireAuth, moneyLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ amount: z.coerce.number().positive().max(50000000), pin: z.string().regex(/^\d{4}$/) }).parse(req.body);
  try { await verifyTransactionPin(req.userId, body.pin); } catch (e: any) { const code=e?.message||"INVALID_PIN"; return res.status(code==="PIN_LOCKED"?423:401).json({success:false,code,message:friendlyPinError(code)}); }
  const amount = new Prisma.Decimal(body.amount.toFixed(2));
  const key = idempotencyKey(req);
  if (!key) return res.status(400).json({success:false,code:"IDEMPOTENCY_KEY_REQUIRED",message:"A transaction request key is required."});
  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.idempotencyKey.findFirst({where:{key},include:{transaction:true}});
      if (existing) {
        if (existing.userId !== req.userId) throw new Error("IDEMPOTENCY_CONFLICT");
        const existingSavingsId = String((existing.transaction.metadata as any)?.savingsAccountId || "");
        if (existing.requestHash !== hashRequest({savingsId:req.params.id,amount:amount.toFixed(2),direction:"deposit"}) || existingSavingsId !== req.params.id) throw new Error("IDEMPOTENCY_CONFLICT");
        return tx.savingsAccount.findUnique({where:{id:req.params.id}});
      }
      const savings = await tx.savingsAccount.findFirst({where:{id:req.params.id,userId:req.userId,active:true}});
      if (!savings) throw new Error("SAVINGS_NOT_FOUND");
      const debit = await tx.wallet.updateMany({where:{userId:req.userId,status:"ACTIVE",balance:{gte:amount}},data:{balance:{decrement:amount}}});
      if (debit.count!==1) throw new Error("INSUFFICIENT_BALANCE");
      const accountDebit = await tx.account.updateMany({where:{userId:req.userId,status:"ACTIVE",balanceKobo:{gte:amountToKobo(amount)}},data:{balanceKobo:{decrement:amountToKobo(amount)}}});
      if (accountDebit.count!==1) throw new Error("ACCOUNT_BALANCE_MISMATCH");
      const updated = await tx.savingsAccount.update({where:{id:savings.id},data:{balance:{increment:amount}}});
      const txr = await tx.transaction.create({data:{reference:reference("SAVE"),senderId:req.userId,type:"SAVINGS_DEPOSIT",status:"SUCCESS",amount,total:amount,completedAt:new Date(),metadata:{simulated:true,savingsAccountId:savings.id}}});
      await tx.transactionEntry.create({data:{transactionId:txr.id,userId:req.userId,type:"DEBIT",amount}});
      await tx.notification.create({data:{userId:req.userId,type:"SAVINGS",title:"Savings Deposit",message:`₦${amount.toFixed(2)} moved into ${savings.name}.`}});
      await tx.idempotencyKey.create({data:{key,userId:req.userId,requestHash:hashRequest({savingsId:req.params.id,amount:amount.toFixed(2),direction:"deposit"}),transactionId:txr.id}});
      return updated;
    },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
    res.status(200).json({success:true,savings:result});
  } catch(e:any) { const code=e?.message||"SAVINGS_DEPOSIT_FAILED"; const status=code==="INSUFFICIENT_BALANCE"?400:code==="SAVINGS_NOT_FOUND"?404:409; res.status(status).json({success:false,code,message:code==="INSUFFICIENT_BALANCE"?"Insufficient wallet balance.":"Savings deposit could not be completed."}); }
}));

app.post("/api/savings/:id/withdraw", requireAuth, moneyLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ amount: z.coerce.number().positive().max(50000000), pin: z.string().regex(/^\d{4}$/) }).parse(req.body);
  try { await verifyTransactionPin(req.userId, body.pin); } catch (e: any) { const code=e?.message||"INVALID_PIN"; return res.status(code==="PIN_LOCKED"?423:401).json({success:false,code,message:friendlyPinError(code)}); }
  const amount = new Prisma.Decimal(body.amount.toFixed(2));
  const key = idempotencyKey(req);
  if (!key) return res.status(400).json({success:false,code:"IDEMPOTENCY_KEY_REQUIRED",message:"A transaction request key is required."});
  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.idempotencyKey.findFirst({where:{key},include:{transaction:true}});
      if (existing) {
        if (existing.userId !== req.userId || existing.requestHash !== hashRequest({savingsId:req.params.id,amount:amount.toFixed(2),direction:"withdraw"})) throw new Error("IDEMPOTENCY_CONFLICT");
        return tx.savingsAccount.findUnique({where:{id:req.params.id}});
      }
      const savings = await tx.savingsAccount.findFirst({where:{id:req.params.id,userId:req.userId,active:true}});
      if (!savings) throw new Error("SAVINGS_NOT_FOUND");
      const debit = await tx.savingsAccount.updateMany({where:{id:savings.id,userId:req.userId,active:true,balance:{gte:amount}},data:{balance:{decrement:amount}}});
      if (debit.count!==1) throw new Error("INSUFFICIENT_SAVINGS_BALANCE");
      await tx.wallet.update({where:{userId:req.userId},data:{balance:{increment:amount}}});
      await tx.account.update({where:{userId:req.userId},data:{balanceKobo:{increment:amountToKobo(amount)}}});
      const txr = await tx.transaction.create({data:{reference:reference("SAVW"),senderId:req.userId,type:"SAVINGS_WITHDRAWAL",status:"SUCCESS",amount,total:amount,completedAt:new Date(),metadata:{simulated:true,savingsAccountId:savings.id}}});
      await tx.transactionEntry.create({data:{transactionId:txr.id,userId:req.userId,type:"CREDIT",amount}});
      await tx.notification.create({data:{userId:req.userId,type:"SAVINGS",title:"Savings Withdrawal",message:`₦${amount.toFixed(2)} withdrawn from ${savings.name}.`}});
      await tx.idempotencyKey.create({data:{key,userId:req.userId,requestHash:hashRequest({savingsId:req.params.id,amount:amount.toFixed(2),direction:"withdraw"}),transactionId:txr.id}});
      return tx.savingsAccount.findUnique({where:{id:savings.id}});
    },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
    res.status(200).json({success:true,savings:result});
  } catch(e:any) { const code=e?.message||"SAVINGS_WITHDRAWAL_FAILED"; const status=code==="INSUFFICIENT_SAVINGS_BALANCE"?400:code==="SAVINGS_NOT_FOUND"?404:409; res.status(status).json({success:false,code,message:code==="INSUFFICIENT_SAVINGS_BALANCE"?"Insufficient savings balance.":"Savings withdrawal could not be completed."}); }
}));

app.post("/api/cards", requireAuth, asyncRoute(async (req: any, res: any) => {
  const year = new Date().getFullYear();
  const cardNumber = `5399${crypto.randomInt(100000000000, 999999999999)}`;
  const last4 = cardNumber.slice(-4);
  const cvv = String(crypto.randomInt(100, 1000));
  const card = await prisma.card.create({
    data: {
      userId: req.userId,
      last4,
      maskedNumber: `5399 **** **** ${last4}`,
      expiryMonth: 12,
      expiryYear: year + 3,
      cvvHash: await argon2.hash(cvv),
      pinHash: await argon2.hash("0000")
    }
  });
  res.status(201).json({ success: true, card: { id: card.id, last4, maskedNumber: card.maskedNumber, expiryMonth: card.expiryMonth, expiryYear: card.expiryYear, status: card.status, spendingLimit: card.spendingLimit, cvv, simulated: true } });
}));

app.delete("/api/cards/:id", requireAuth, asyncRoute(async (req: any, res: any) => {
  const card = await prisma.card.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!card) return res.status(404).json({ success: false, code: "CARD_NOT_FOUND", message: "Card not found." });
  await prisma.card.delete({ where: { id: card.id } });
  res.json({ success: true, simulated: true });
}));

app.get("/api/cards", requireAuth, asyncRoute(async (req: any, res: any) => {
  const cards = await prisma.card.findMany({
    where: { userId: req.userId },
    select: { id: true, maskedNumber: true, last4: true, expiryMonth: true, expiryYear: true, status: true, spendingLimit: true, createdAt: true }
  });
  res.json({ success: true, cards });
}));

app.post("/api/cards/:id/freeze", requireAuth, asyncRoute(async (req: any, res: any) => {
  const card = await prisma.card.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!card) return res.status(404).json({ success: false, message: "Card not found." });
  const updated = await prisma.card.update({ where: { id: card.id }, data: { status: card.status === "FROZEN" ? "ACTIVE" : "FROZEN" } });
  res.json({ success: true, card: { id: updated.id, last4: updated.last4, maskedNumber: updated.maskedNumber, expiryMonth: updated.expiryMonth, expiryYear: updated.expiryYear, status: updated.status, spendingLimit: updated.spendingLimit, createdAt: updated.createdAt } });
}));

app.get("/api/loans", requireAuth, asyncRoute(async (req: any, res: any) => {
  res.json({ success: true, loans: await prisma.loan.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } }) });
}));

app.post("/api/loans", requireAuth, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    amount: z.coerce.number().positive().max(100000000),
    durationMonths: z.coerce.number().int().min(1).max(60),
    pin: z.string().regex(/^\d{4}$/)
  }).parse(req.body);
  try { await verifyTransactionPin(req.userId, body.pin); } catch (e: any) { const code=e?.message||"INVALID_PIN"; return res.status(code==="PIN_LOCKED"?423:401).json({success:false,code,message:friendlyPinError(code)}); }
  const amount = new Prisma.Decimal(body.amount.toFixed(2));
  const interest = amount.mul(new Prisma.Decimal("0.10"));
  const loan = await prisma.loan.create({
    data: {
      userId: req.userId!,
      amount,
      interest,
      totalRepayable: amount.add(interest),
      durationMonths: body.durationMonths,
      status: "PENDING"
    }
  });
  res.status(201).json({ success: true, loan });
}));

app.post("/api/loans/:id/repay", requireAuth, moneyLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ amount: z.coerce.number().positive(), pin: z.string().regex(/^\d{4}$/) }).parse(req.body);
  try { await verifyTransactionPin(req.userId, body.pin); } catch (e: any) { const code=e?.message||"INVALID_PIN"; return res.status(code==="PIN_LOCKED"?423:401).json({success:false,code,message:friendlyPinError(code)}); }
  const amount = new Prisma.Decimal(body.amount.toFixed(2));
  try {
    const loan = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const current = await tx.loan.findFirst({where:{id:req.params.id,userId:req.userId,status:{in:["APPROVED","ACTIVE"]}}});
      if (!current) throw new Error("LOAN_NOT_FOUND");
      const updated = await tx.loan.updateMany({where:{id:current.id,userId:req.userId,status:{in:["APPROVED","ACTIVE"]},totalRepayable:{gte:amount}},data:{totalRepayable:{decrement:amount},status:"ACTIVE"}});
      if (updated.count!==1) throw new Error("LOAN_REPAYMENT_EXCEEDS_BALANCE");
      const remaining = await tx.loan.findUnique({where:{id:current.id}});
      const finalLoan = remaining && remaining.totalRepayable.lte(0) ? await tx.loan.update({where:{id:current.id},data:{status:"PAID",totalRepayable:0}}) : remaining;
      const txr = await tx.transaction.create({data:{reference:reference("LOANR"),senderId:req.userId,type:"LOAN_REPAYMENT",status:"SUCCESS",amount,total:amount,completedAt:new Date(),metadata:{simulated:true,loanId:current.id}}});
      await tx.transactionEntry.create({data:{transactionId:txr.id,userId:req.userId,type:"DEBIT",amount}});
      await tx.notification.create({data:{userId:req.userId,type:"LOAN",title:"Loan Repayment",message:`₦${amount.toFixed(2)} loan repayment recorded.`}});
      return finalLoan;
    },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
    res.json({success:true,loan});
  } catch(e:any) { const code=e?.message||"LOAN_REPAYMENT_FAILED"; const status=code==="LOAN_NOT_FOUND"?404:code==="LOAN_REPAYMENT_EXCEEDS_BALANCE"?400:409; res.status(status).json({success:false,code,message:code==="LOAN_REPAYMENT_EXCEEDS_BALANCE"?"Repayment exceeds the outstanding loan balance.":"Loan repayment could not be completed."}); }
}));

app.post("/api/admin/loans/:id/approve", requireAuth, requireAdmin, asyncRoute(async (req: any, res: any) => {
  const loan = await prisma.loan.updateMany({where:{id:req.params.id,status:"PENDING"},data:{status:"APPROVED"}});
  if (loan.count!==1) return res.status(404).json({success:false,code:"LOAN_NOT_FOUND",message:"Pending loan not found."});
  res.json({success:true,message:"Loan approved."});
}));

app.post("/api/admin/loans/:id/disburse", requireAuth, requireAdmin, asyncRoute(async (req: any, res: any) => {
  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const loan = await tx.loan.findFirst({where:{id:req.params.id,status:"APPROVED"}});
      if (!loan) throw new Error("LOAN_NOT_APPROVED");
      await tx.wallet.update({where:{userId:loan.userId},data:{balance:{increment:loan.amount}}});
      await tx.account.update({where:{userId:loan.userId},data:{balanceKobo:{increment:amountToKobo(loan.amount)}}});
      const active = await tx.loan.update({where:{id:loan.id},data:{status:"ACTIVE"}});
      const txr = await tx.transaction.create({data:{reference:reference("LOAND"),receiverId:loan.userId,type:"LOAN_DISBURSEMENT",status:"SUCCESS",amount:loan.amount,total:loan.amount,completedAt:new Date(),metadata:{simulated:true,loanId:loan.id}}});
      await tx.transactionEntry.create({data:{transactionId:txr.id,userId:loan.userId,type:"CREDIT",amount:loan.amount}});
      await tx.notification.create({data:{userId:loan.userId,type:"LOAN",title:"Loan Disbursed",message:`₦${loan.amount.toFixed(2)} simulated loan disbursement credited to your Veyra wallet.`}});
      return active;
    },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
    res.json({success:true,simulated:true,loan:result});
  } catch(e:any) { res.status(409).json({success:false,code:e?.message||"LOAN_DISBURSEMENT_FAILED",message:"Loan disbursement could not be completed."}); }
}));

app.get("/api/admin/users", requireAuth, requireAdmin, asyncRoute(async (_req: any, res: any) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, firstName: true, lastName: true, username: true, phone: true, email: true, accountNumber: true, status: true, createdAt: true }
  });
  res.json({ success: true, users });
}));

// Provider gateway: credentials remain on the server. Without configured endpoints,
// live transactions fail closed and are never recorded as successful.
function providerConfig(name: string) {
  const baseUrl = process.env[`${name}_API_URL`]?.trim();
  const apiKey = process.env[`${name}_API_KEY`]?.trim();
  if (!baseUrl || !apiKey) return null;
  try { new URL(baseUrl); } catch { return null; }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}
async function callProvider(name: string, path: string, body: unknown, idempotency?: string) {
  const config = providerConfig(name);
  if (!config) {
    const err: any = new Error(`${name}_PROVIDER_NOT_CONFIGURED`);
    err.httpStatus = 503;
    throw err;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${config.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotency || crypto.randomUUID() },
      body: JSON.stringify(body), signal: controller.signal
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err: any = new Error("PROVIDER_REQUEST_FAILED");
      err.httpStatus = response.status >= 500 ? 502 : 400;
      throw err;
    }
    return data;
  } finally { clearTimeout(timeout); }
}

// International resolution adapter. The provider must explicitly support the chosen
// country/rail. The UI can call this now; missing provider configuration returns 503.
app.post("/api/providers/account-resolution", requireAuth, moneyLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    countryCode: z.string().length(2).transform(v => v.toUpperCase()),
    accountNumber: z.string().min(4).max(34),
    bankCode: z.string().max(40).optional(),
    sortCode: z.string().max(20).optional(),
    routingNumber: z.string().max(20).optional(),
    iban: z.string().max(34).optional(),
    currency: z.string().length(3).optional()
  }).parse(req.body);
  try {
    const result = await callProvider("ACCOUNT_RESOLUTION", "/resolve", body);
    if (!result || typeof result.accountName !== "string" || !result.accountName.trim()) {
      return res.status(502).json({ success: false, code: "INVALID_PROVIDER_RESPONSE", message: "The provider did not return a verified account name." });
    }
    res.json({ success: true, countryCode: body.countryCode, accountName: result.accountName,
      bankName: typeof result.bankName === "string" ? result.bankName : null,
      verificationStatus: result.verificationStatus === "VERIFIED" ? "VERIFIED" : "UNCONFIRMED",
      providerReference: result.providerReference || null });
  } catch (e: any) {
    const status = e?.httpStatus || (e?.name === "AbortError" ? 504 : 502);
    res.status(status).json({ success: false, code: e?.message?.endsWith("NOT_CONFIGURED") ? e.message : "ACCOUNT_RESOLUTION_UNAVAILABLE",
      message: "Account-name verification is currently unavailable for this route. No payment was made." });
  }
}));

// Real payout gateway. Only call after recipient confirmation, PIN verification and
// provider credentials are configured. Provider responses decide pending/success/failure.
app.post("/api/providers/bank-transfer", requireAuth, moneyLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    countryCode: z.string().length(2).transform(v => v.toUpperCase()),
    currency: z.string().length(3).transform(v => v.toUpperCase()),
    accountNumber: z.string().min(4).max(34), bankCode: z.string().max(40).optional(),
    accountName: z.string().min(2).max(120), bankName: z.string().min(2).max(120),
    amount: z.coerce.number().positive().max(50000000), narration: z.string().max(140).optional(),
    pin: z.string().regex(/^\d{4}$/).optional(),
    authorizationId: z.string().optional()
  }).parse(req.body);
  if (Boolean(body.pin) === Boolean(body.authorizationId)) {
    return res.status(400).json({ success:false, code:"ONE_AUTH_METHOD_REQUIRED", message:"Choose either your transaction PIN or fingerprint authorization." });
  }
  if (body.countryCode !== "NG" || body.currency !== "NGN") {
    if (!process.env.PAYOUT_API_URL || !process.env.PAYOUT_API_KEY) return res.status(503).json({ success:false, code:"INTERNATIONAL_PAYOUT_PROVIDER_NOT_CONFIGURED", message:"International payout requires the configured payout provider." });
  }
  if (body.countryCode === "NG" && body.currency === "NGN" && String(process.env.BANK_TRANSFER_MODE || "SIMULATED").toUpperCase() === "LIVE" && !process.env.PAYSTACK_SECRET_KEY?.trim()) return res.status(503).json({ success:false, code:"PAYSTACK_NOT_CONFIGURED", message:"Live payouts are disabled until Paystack is configured. No balance was changed." });
  if (body.authorizationId) {
    try {
      await consumeTransferAuthorization(req.userId, body.authorizationId, {
        type: "BANK_TRANSFER",
        countryCode: body.countryCode,
        currency: body.currency,
        accountNumber: body.accountNumber,
        bankCode: body.bankCode,
        accountName: body.accountName,
        bankName: body.bankName,
        amount: body.amount,
        narration: body.narration
      });
    } catch (e: any) {
      const code = e?.message || "TRANSFER_AUTHORIZATION_INVALID";
      return res.status(401).json({ success:false, code, message:"Fingerprint authorization expired or does not match this transfer. Please authorize again." });
    }
  } else {
    try { await verifyTransactionPin(req.userId, body.pin!); }
    catch (e: any) { const code = e?.message || "INVALID_PIN"; return res.status(code === "PIN_LOCKED" ? 423 : 401).json({ success: false, code, message: friendlyPinError(code) }); }
  }
  const idem = idempotencyKey(req);
  if (!idem || idem.length > 128) return res.status(400).json({ success:false, code:"IDEMPOTENCY_KEY_REQUIRED", message:"Provide a unique Idempotency-Key header." });
  const limitCheck = await checkDailyTransferLimit(req.userId, body.amount);
  if (!limitCheck.ok) return res.status(403).json({ success:false, code:"DAILY_LIMIT_EXCEEDED", message:`This transfer exceeds your ${limitCheck.level} daily limit of ₦${limitCheck.limit.toLocaleString()}.` });

  // Server-side recipient confirmation: never trust the account name supplied by the browser.
  let verifiedName = body.accountName;
  let resolvedBankName = body.bankName;
  let localBankAccount: any = null;
  if (body.countryCode === "NG" && body.currency === "NGN") {
    if (!body.bankCode || !/^\d{10}$/.test(body.accountNumber)) return res.status(400).json({ success:false, code:"INVALID_NIGERIAN_ACCOUNT", message:"A Nigerian transfer requires a 10-digit account number and bank code." });
    localBankAccount = await prisma.bankAccount.findFirst({ where:{ accountNumber:body.accountNumber, active:true, bank:{code:body.bankCode} }, include:{bank:true} });
    if (process.env.PAYSTACK_SECRET_KEY?.trim()) {
      try {
        const resolved = await paystackRequest(`/bank/resolve?account_number=${encodeURIComponent(body.accountNumber)}&bank_code=${encodeURIComponent(body.bankCode)}`);
        if (!resolved.data?.account_name) return res.status(404).json({ success:false, code:"ACCOUNT_NOT_RESOLVED", message:"The bank account name could not be verified." });
        verifiedName = String(resolved.data.account_name); resolvedBankName = String(resolved.data.bank_name || body.bankName);
      } catch { return res.status(404).json({ success:false, code:"ACCOUNT_NOT_RESOLVED", message:"The bank account name could not be verified. Check the bank and account number." }); }
    } else if (localBankAccount) { verifiedName = localBankAccount.accountName; resolvedBankName = localBankAccount.bank.name; }
    else return res.status(503).json({ success:false, code:"PAYSTACK_NOT_CONFIGURED", message:"Configure Paystack account resolution or use a known account in the local simulation directory." });
    if (verifiedName.trim().toLowerCase() !== body.accountName.trim().toLowerCase()) return res.status(409).json({ success:false, code:"RECIPIENT_NAME_CHANGED", message:"The verified account name changed. Search the account again before continuing." });
  } else if (process.env.ACCOUNT_RESOLUTION_API_URL && process.env.ACCOUNT_RESOLUTION_API_KEY) {
    try {
      const resolved:any = await callProvider("ACCOUNT_RESOLUTION", "/resolve", { countryCode:body.countryCode, currency:body.currency, accountNumber:body.accountNumber, bankCode:body.bankCode, accountName:body.accountName });
      if (resolved?.verified !== true || !resolved.accountName) return res.status(409).json({ success:false, code:"ACCOUNT_NOT_VERIFIED", message:"The international account name was not verified." });
      verifiedName = String(resolved.accountName); resolvedBankName = String(resolved.bankName || body.bankName);
      if (verifiedName.trim().toLowerCase() !== body.accountName.trim().toLowerCase()) return res.status(409).json({ success:false, code:"RECIPIENT_NAME_CHANGED", message:"The verified account name changed. Search the account again before continuing." });
    } catch (e:any) { return res.status(e?.httpStatus || 503).json({ success:false, code:"ACCOUNT_RESOLUTION_UNAVAILABLE", message:"The international account could not be verified." }); }
  } else return res.status(503).json({ success:false, code:"ACCOUNT_RESOLUTION_PROVIDER_NOT_CONFIGURED", message:"International account-name verification requires the configured provider." });

  const amount = new Prisma.Decimal(body.amount.toFixed(2));
  const requestHash = hashRequest({ ...body, pin: undefined, authorizationId: undefined, accountName: verifiedName, bankName: resolvedBankName });
  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.idempotencyKey.findUnique({ where:{ userId_key:{ userId:req.userId, key:idem } }, include:{transaction:true} });
      if (existing) { if (existing.requestHash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT"); return { transaction:existing.transaction, created:false }; }
      const sender = await tx.user.findUnique({
        where: { id: req.userId },
        include: { wallet: true, account: true }
      });
      if (!sender?.wallet || !sender.account ||
          sender.wallet.status !== "ACTIVE" || sender.account.status !== "ACTIVE") {
        throw new Error("WALLET_NOT_ACTIVE");
      }

      // Account balance is authoritative; synchronize the legacy wallet mirror.
      const amountKobo = amountToKobo(amount);
      const authoritativeWalletBalance = new Prisma.Decimal(
        sender.account.balanceKobo.toString()
      ).div(100);

      await tx.wallet.update({
        where: { userId: req.userId },
        data: { balance: authoritativeWalletBalance }
      });

      const accountDebit = await tx.account.updateMany({
        where: {
          userId: req.userId,
          status: "ACTIVE",
          balanceKobo: { gte: amountKobo }
        },
        data: { balanceKobo: { decrement: amountKobo } }
      });
      if (accountDebit.count !== 1) throw new Error("INSUFFICIENT_BALANCE");

      const debit = await tx.wallet.updateMany({
        where: {
          userId: req.userId,
          status: "ACTIVE",
          balance: { gte: amount }
        },
        data: { balance: { decrement: amount } }
      });
      if (debit.count !== 1) throw new Error("INSUFFICIENT_BALANCE");
      const providerMode = body.countryCode === "NG" && body.currency === "NGN" ? (String(process.env.BANK_TRANSFER_MODE || "SIMULATED").toUpperCase()) : "EXTERNAL_PROVIDER";
      let mirrorBankAccount: any = null;
      if (providerMode !== "LIVE" && body.countryCode === "NG" && body.currency === "NGN") {
        const bank = await tx.bank.upsert({ where:{code:body.bankCode!}, update:{name:resolvedBankName}, create:{code:body.bankCode!, name:resolvedBankName} });
        mirrorBankAccount = await tx.bankAccount.upsert({ where:{accountNumber:body.accountNumber}, update:{accountName:verifiedName, active:true}, create:{bankId:bank.id, accountNumber:body.accountNumber, accountName:verifiedName, balance:0} });
        await tx.bankAccount.update({ where:{id:mirrorBankAccount.id}, data:{balance:{increment:amount}} });
      }
      const created = await tx.transaction.create({ data:{ reference:reference("BANK"), senderId:req.userId, type:"BANK_TRANSFER", status:providerMode === "LIVE" ? "PROCESSING" : "SUCCESS", amount, fee:0, vat:0, total:amount, narration:body.narration, recipientName:verifiedName, recipientAccount:body.accountNumber, recipientBank:resolvedBankName, completedAt:providerMode === "LIVE" ? null : new Date(), metadata:{countryCode:body.countryCode,currency:body.currency,bankCode:body.bankCode||null,providerMode,bankCreditRecorded:Boolean(mirrorBankAccount),simulated:providerMode !== "LIVE"} } });
      await tx.transactionEntry.create({ data:{transactionId:created.id,userId:req.userId,type:"DEBIT",amount} });
      await tx.transactionEvent.create({ data:{transactionId:created.id,status:created.status,message:"Bank transfer submitted",actorUserId:req.userId,eventType:"BANK_TRANSFER_SUBMITTED",fromStatus:"CREATED",toStatus:created.status,provider:providerMode === "LIVE" ? "PAYSTACK" : "SIMULATED",eventKey:`bank:${created.reference}:created`,metadata:{simulated:providerMode !== "LIVE"}} });
      await tx.receipt.create({
  data: {
    userId: req.userId,
    transactionId: created.id,
    reference: `${created.reference}-R`,
    kind: "BANK_TRANSFER",
    snapshot: {
      kind: "BANK_TRANSFER",
      reference: created.reference,
      status: created.status,
      amount: amount.toFixed(2),
      currency: "NGN",
      recipientName: verifiedName,
      recipientAccount: body.accountNumber,
      recipientBank: resolvedBankName,
      simulated: providerMode !== "LIVE"
    }
  }
});
      await tx.notification.create({ data:{userId:req.userId,type:"TRANSFER_SENT",title:"Bank transfer recorded",message:`₦${amount.toFixed(2)} bank transfer to ${verifiedName} was recorded with reference ${created.reference}.`} });
      await tx.idempotencyKey.create({ data:{key:idem,userId:req.userId,requestHash,transactionId:created.id} });
      const after = await tx.wallet.findUnique({where:{userId:req.userId},select:{balance:true}});
      return {transaction:created, created:true, balanceAfter:after?.balance?.toString() || "0", bankCreditRecorded:Boolean(mirrorBankAccount)};
    }, {isolationLevel:Prisma.TransactionIsolationLevel.Serializable});

    // An idempotent retry must never submit a second external payout.
    if (!result.created) {
      const existingStatus = String(result.transaction.status);
      return res.status(existingStatus === "PROCESSING" ? 202 : 200).json({
        success: existingStatus === "SUCCESS" || existingStatus === "PROCESSING",
        status: existingStatus,
        transactionId: result.transaction.id,
        reference: result.transaction.reference,
        message: "Existing transaction returned; no new payout was submitted."
      });
    }

    if (String(process.env.BANK_TRANSFER_MODE || "SIMULATED").toUpperCase() === "LIVE" && body.countryCode === "NG" && body.currency === "NGN") {
      try {
        const recipient = await paystackRequest("/transferrecipient", { method: "POST", body: JSON.stringify({ type: "nuban", name: verifiedName, account_number: body.accountNumber, bank_code: body.bankCode, currency: "NGN" }) });
        const transfer = await paystackRequest("/transfer", { method: "POST", body: JSON.stringify({ source: "balance", amount: Math.round(body.amount * 100), recipient: transferRecipientCode(recipient), reason: body.narration || `Veyra bank transfer ${result.transaction.reference}` }) });
        await prisma.transaction.update({ where: { id: result.transaction.id }, data: { metadata: { countryCode: body.countryCode, currency: body.currency, bankCode: body.bankCode || null, providerMode: "LIVE", bankCreditRecorded: false, simulated: false, providerReference: transfer.data?.reference || transfer.data?.transfer_code || null } } });
        return res.status(202).json({ success:true, status:"PROCESSING", transactionId:result.transaction.id, reference:result.transaction.reference, accountName:verifiedName, bankName:resolvedBankName, accountNumber:body.accountNumber, amount:body.amount, currency:body.currency, bankCreditRecorded:false, simulated:false, balanceAfter:result.balanceAfter, message:"Transfer submitted to Paystack. Final status will be confirmed by the Paystack webhook." });
      } catch (providerError: any) {
        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.wallet.update({ where: { userId: req.userId }, data: { balance: { increment: amount } } });
          await tx.account.update({ where: { userId: req.userId }, data: { balanceKobo: { increment: amountToKobo(amount) } } });
          await tx.transaction.update({ where: { id: result.transaction.id }, data: { status: "FAILED", completedAt: new Date(), failureReason: "Paystack transfer submission failed" } });
          const receipts = await tx.receipt.findMany({ where: { transactionId: result.transaction.id } });
          for (const receipt of receipts) await tx.receipt.update({ where: { id: receipt.id }, data: { snapshot: { ...(receipt.snapshot as any), status: "FAILED", completedAt: new Date().toISOString(), simulated: false } } });
          await tx.transactionEvent.create({ data: { transactionId: result.transaction.id, status: "FAILED", message: "Paystack transfer submission failed; ledger debit reversed", actorUserId: req.userId, eventType: "PAYSTACK_SUBMISSION_FAILED", fromStatus: "PROCESSING", toStatus: "FAILED", provider: "PAYSTACK", eventKey: `bank:${result.transaction.reference}:submission-failed` } });
          await tx.transactionEntry.create({ data: { transactionId: result.transaction.id, userId: req.userId, type: "CREDIT", amount } });
        });
        return res.status(502).json({ success:false, status:"FAILED", transactionId:result.transaction.id, reference:result.transaction.reference, code:"PAYSTACK_TRANSFER_FAILED", message:"Paystack could not accept the transfer. The Veyra ledger debit was reversed." });
      }
    }
    return res.status(200).json({ success:true, status:"SUCCESS", transactionId:result.transaction.id, reference:result.transaction.reference, accountName:verifiedName, bankName:resolvedBankName, accountNumber:body.accountNumber, amount:body.amount, currency:body.currency, bankCreditRecorded:result.bankCreditRecorded, simulated:true, balanceAfter:result.balanceAfter, message:"Bank transfer recorded successfully in the Veyra transaction ledger." });
  } catch (e:any) {
    if (e?.message === "IDEMPOTENCY_CONFLICT") return res.status(409).json({success:false,code:e.message,message:"This request key was already used for different details."});
    if (e?.message === "INSUFFICIENT_BALANCE") return res.status(400).json({success:false,code:e.message,message:"Insufficient balance."});
    if (e?.message === "WALLET_NOT_ACTIVE") return res.status(400).json({success:false,code:e.message,message:"Wallet is not active."});
    throw e;
  }
}));

function transferRecipientCode(response: any) { const code = response?.data?.recipient_code; if (!code) throw new Error("PAYSTACK_RECIPIENT_NOT_CREATED"); return code; }

app.post("/api/webhooks/paystack", asyncRoute(async (req: any, res: any) => {
  const secret = process.env.PAYSTACK_SECRET_KEY?.trim();
  const signature = String(req.headers["x-paystack-signature"] || "");
  if (!secret || !signature || !req.rawBody) {
    return res.status(401).json({ success: false, message: "Webhook signature is required." });
  }

  const expected = crypto.createHmac("sha512", secret).update(req.rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, message: "Invalid webhook signature." });
  }

  const event = req.body || {};
  const eventName = String(event.event || "");
  if (!["transfer.success", "transfer.failed", "transfer.reversed"].includes(eventName)) {
    return res.status(200).json({ success: true, ignored: true });
  }

  const data = event.data || {};
  const providerReference = String(data.reference || data.transfer_code || "");
  if (!providerReference) return res.status(200).json({ success: true, ignored: true });

  const transaction = await prisma.transaction.findFirst({
    where: { metadata: { path: ["providerReference"], equals: providerReference } }
  });
  if (!transaction) return res.status(200).json({ success: true, ignored: true });

  const nextStatus = eventName === "transfer.success"
    ? "SUCCESS"
    : eventName === "transfer.reversed" ? "REVERSED" : "FAILED";
  const eventKey = `paystack:${providerReference}:${eventName}`;

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.transactionEvent.create({
        data: {
          transactionId: transaction.id,
          status: nextStatus,
          message: `Paystack webhook: ${eventName}`,
          actorUserId: transaction.senderId,
          eventType: eventName,
          eventKey,
          fromStatus: transaction.status,
          toStatus: nextStatus,
          provider: "PAYSTACK",
          providerRef: providerReference,
          payloadHash: crypto.createHash("sha256").update(req.rawBody).digest("hex"),
          metadata: { reason: data.reason || null }
        }
      });

      const latest = await tx.transaction.findUnique({ where: { id: transaction.id } });
      if (!latest) return;

      // SUCCESS can only follow PROCESSING. FAILED cannot overwrite SUCCESS.
      // A genuine REVERSED event can follow PROCESSING or SUCCESS.
      const allowedPreviousStatuses = nextStatus === "REVERSED"
        ? ["PROCESSING", "SUCCESS"]
        : ["PROCESSING"];

      const changed = await tx.transaction.updateMany({
        where: { id: latest.id, status: { in: allowedPreviousStatuses as any } },
        data: {
          status: nextStatus as any,
          completedAt: new Date(),
          failureReason: nextStatus === "SUCCESS"
            ? null
            : String(data.reason || `Paystack event: ${eventName}`)
        }
      });

      // A stale or out-of-order event must not change the ledger or refund.
      if (changed.count !== 1) return;

      const linkedReceipts = await tx.receipt.findMany({
        where: { transactionId: latest.id }
      });
      for (const receipt of linkedReceipts) {
        await tx.receipt.update({
          where: { id: receipt.id },
          data: {
            snapshot: {
              ...(receipt.snapshot as any),
              status: nextStatus,
              completedAt: new Date().toISOString(),
              providerReference
            }
          }
        });
      }

      // Only the single successful status transition above can trigger this refund.
      if ((nextStatus === "FAILED" || nextStatus === "REVERSED") && latest.senderId) {
        await tx.wallet.update({
          where: { userId: latest.senderId },
          data: { balance: { increment: latest.amount } }
        });
        await tx.account.update({
          where: { userId: latest.senderId },
          data: { balanceKobo: { increment: amountToKobo(latest.amount) } }
        });
        await tx.transactionEntry.create({
          data: {
            transactionId: latest.id,
            userId: latest.senderId,
            type: "CREDIT",
            amount: latest.amount
          }
        });
      }

      if (latest.senderId) {
        await tx.notification.create({
          data: {
            userId: latest.senderId,
            type: "TRANSFER_SENT",
            title: `Bank transfer ${nextStatus.toLowerCase()}`,
            message: `Bank transfer ${latest.reference}: ${nextStatus.toLowerCase()}.`
          }
        });
      }

      await tx.auditLog.create({
        data: {
          targetUserId: latest.senderId,
          action: "PAYSTACK_WEBHOOK_RECONCILED",
          entityType: "Transaction",
          entityId: latest.id,
          metadata: { providerReference, eventName, nextStatus }
        }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (e: any) {
    if (e?.code === "P2002") return res.status(200).json({ success: true, duplicate: true });
    throw e;
  }

  return res.status(200).json({ success: true });
}));

app.post("/api/support/reports", requireAuth, authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ category: z.enum(["BUG", "ACCOUNT", "TRANSFER", "SECURITY", "OTHER"]).default("OTHER"), message: z.string().trim().min(10).max(2000), reference: z.string().max(100).optional() }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { upgradeLevel: true } });
  if (user?.upgradeLevel !== "PREMIUM") return res.status(403).json({ success:false, code:"PREMIUM_REQUIRED", message:"Premium support reports are available only to approved Premium accounts." });
  const report = await prisma.auditLog.create({ data: { actorUserId: req.userId, targetUserId: req.userId, action: "PREMIUM_SUPPORT_REPORT_SUBMITTED", entityType: "SUPPORT_REPORT", outcome: "PENDING", metadata: { category: body.category, message: body.message, reference: body.reference || null } } });
  res.status(201).json({ success:true, reportId: report.id, status:"PENDING", message:"Your report has been recorded for review." });
}));

app.post("/api/providers/bill-payment", requireAuth, moneyLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ service: z.enum(["AIRTIME", "DATA", "ELECTRICITY", "TV", "INTERNET", "WATER", "EDUCATION"]),
    countryCode: z.string().length(2).default("NG"), target: z.string().min(3).max(100), amount: z.coerce.number().positive().max(10000000),
    providerCode: z.string().max(60).optional(), pin: z.string().regex(/^\d{4}$/) }).parse(req.body);
  try { await verifyTransactionPin(req.userId, body.pin); }
  catch (e: any) { const code = e?.message || "INVALID_PIN"; return res.status(code === "PIN_LOCKED" ? 423 : 401).json({ success: false, code, message: friendlyPinError(code) }); }
  const idem = idempotencyKey(req);
  if (!idem || idem.length > 128) return res.status(400).json({ success: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "Provide a unique Idempotency-Key header." });
  const limitCheck = await checkDailyTransferLimit(req.userId, body.amount);
  if (!limitCheck.ok) return res.status(403).json({ success: false, code: "DAILY_LIMIT_EXCEEDED", message: `This transfer exceeds your ${limitCheck.level} daily limit of ₦${limitCheck.limit.toLocaleString()}.` });
  const amount = new Prisma.Decimal(body.amount.toFixed(2));
  const requestHash = hashRequest({ ...body, pin: undefined });
  let transaction: any;
  try {
    transaction = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.idempotencyKey.findUnique({ where: { userId_key: { userId: req.userId, key: idem } }, include: { transaction: true } });
      if (existing) { if (existing.requestHash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT"); return existing.transaction; }
      const created = await tx.transaction.create({ data: { reference: reference(body.service), senderId: req.userId, type: body.service,
        status: "PROCESSING", amount, fee: new Prisma.Decimal(0), total: amount, recipientAccount: body.target,
        narration: body.providerCode || body.service, metadata: { countryCode: body.countryCode, provider: "BILL_PAYMENT", providerConfigured: Boolean(process.env.BILL_PAYMENT_API_URL && process.env.BILL_PAYMENT_API_KEY) } } });
      await tx.idempotencyKey.create({ data: { key: idem, userId: req.userId, requestHash, transactionId: created.id } });
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (e: any) {
    if (e?.message === "IDEMPOTENCY_CONFLICT") return res.status(409).json({ success: false, code: e.message, message: "This request key was already used for different details." });
    throw e;
  }
  if (transaction.status !== "PROCESSING") return res.status(200).json({ success: transaction.status === "SUCCESS", status: transaction.status, reference: transaction.reference, message: "Existing transaction request returned." });
  try {
    const result: any = await callProvider("BILL_PAYMENT", "/payments", { ...body, pin: undefined, userId: req.userId, clientReference: transaction.reference }, idem);
    const status = ["SUCCESS", "FAILED", "PENDING"].includes(result.status) ? result.status : "PENDING";
    const updated = await prisma.transaction.update({ where: { id: transaction.id }, data: { status,
      completedAt: status === "SUCCESS" || status === "FAILED" ? new Date() : null,
      metadata: { countryCode: body.countryCode, provider: "BILL_PAYMENT", providerReference: result.providerReference || null, providerMessage: result.message || null } } });
    await prisma.notification.create({ data: { userId: req.userId, type: "PAYMENT", title: `${body.service} ${status.toLowerCase()}`, message: `${body.service} reference ${updated.reference}: ${status}.` } });
    res.status(status === "PENDING" ? 202 : 200).json({ success: status === "SUCCESS", status, reference: updated.reference, providerReference: result.providerReference || null, amount: body.amount, message: result.message || `Provider status: ${status}` });
  } catch (e: any) {
    const configured = Boolean(process.env.BILL_PAYMENT_API_URL && process.env.BILL_PAYMENT_API_KEY);
    const status = configured ? "PROCESSING" : "FAILED";
    await prisma.transaction.update({ where: { id: transaction.id }, data: { status, completedAt: configured ? null : new Date(), metadata: { countryCode: body.countryCode, provider: "BILL_PAYMENT", errorCode: configured ? "BILL_STATUS_UNKNOWN" : "BILL_PROVIDER_NOT_CONFIGURED" } } });
    res.status(configured ? 202 : 503).json({ success: false, status, reference: transaction.reference,
      code: configured ? "BILL_STATUS_UNKNOWN" : "BILL_PROVIDER_NOT_CONFIGURED",
      message: configured ? "Provider status is uncertain. Keep this reference and check status before retrying." : "The bill provider is not configured. No payment was submitted." });
  }
}));

// Recovery is intentionally unavailable until an email/SMS challenge provider is configured.
// Never reset passwords from an email/phone value alone.
app.post("/api/auth/recovery/request", authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ email: z.string().email() }).parse(req.body);
  if (!process.env.RECOVERY_API_URL || !process.env.RECOVERY_API_KEY) {
    return res.status(503).json({ success: false, code: "RECOVERY_PROVIDER_NOT_CONFIGURED", message: "Secure account recovery is not configured yet." });
  }
  try { await callProvider("RECOVERY", "/challenge", { email: body.email.toLowerCase() }); }
  catch { /* Same generic response prevents account enumeration. */ }
  res.json({ success: true, message: "If the account is eligible, recovery instructions will be sent." });
}));

app.post("/api/auth/recovery/confirm", authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ email: z.string().email(), code: z.string().min(4).max(12), newPassword: z.string().min(12).max(128) }).parse(req.body);
  if (!process.env.RECOVERY_API_URL || !process.env.RECOVERY_API_KEY) return res.status(503).json({ success: false, code: "RECOVERY_PROVIDER_NOT_CONFIGURED", message: "Secure account recovery is not configured yet." });
  let verified: any;
  try { verified = await callProvider("RECOVERY", "/confirm", { email: body.email.toLowerCase(), code: body.code }); }
  catch { return res.status(400).json({ success: false, code: "RECOVERY_CHALLENGE_INVALID", message: "The recovery code is invalid or expired." }); }
  if (verified?.verified !== true) return res.status(400).json({ success: false, code: "RECOVERY_CHALLENGE_INVALID", message: "The recovery code is invalid or expired." });
  const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() }, select: { id: true } });
  if (!user) return res.status(400).json({ success: true, message: "If the account is eligible, the password has been updated." });
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash: await argon2.hash(body.newPassword) } });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.securityEvent.create({ data: { userId: user.id, event: "PASSWORD_RECOVERED" } });
  });
  res.json({ success: true, message: "Password updated. Sign in with your new password." });
}));

function friendlyError(code: string) {
  const map: Record<string, string> = {
    IDEMPOTENCY_KEY_REQUIRED: "A transaction request key is required.",
    IDEMPOTENCY_CONFLICT: "This request key was already used for different transaction details.",
    WALLET_NOT_ACTIVE: "One of the wallets is not active.",
    INVALID_AMOUNT: "Enter a valid amount.",
    SELF_TRANSFER: "You cannot transfer money to yourself.",
    ACCOUNT_NOT_FOUND: "Sender or recipient account was not found.",
    ACCOUNT_NOT_ACTIVE: "One of the accounts is not active.",
    ACCOUNT_BALANCE_MISMATCH: "Account balances need reconciliation. No money was moved.",
    INSUFFICIENT_BALANCE: "Insufficient account balance."
  };
  return map[code] || "The transaction could not be completed.";
}

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("API error details:", err);
  if (err?.name === "ZodError") return res.status(400).json({ success: false, code: "VALIDATION_ERROR", message: "Check the submitted information." });
  if (err?.code === "P2002") return res.status(409).json({ success: false, code: "DUPLICATE_RESOURCE", message: "A unique account detail is already in use." });
  res.status(500).json({ success: false, code: "SERVER_ERROR", message: "Something went wrong." });
});

app.listen(port, () => console.log(`Backend running on http://localhost:${port}`));
