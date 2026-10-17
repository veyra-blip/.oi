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
import { friendlyPinError, verifyTransactionPin } from "./security.js";

const app = express();
app.set("trust proxy", 1);
const port = Number(process.env.PORT || 4000);

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "100kb" }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50 });
const moneyLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30 });

function requireSecret(name: string) {
  const value = process.env[name]?.trim();
  if (!value || value.length < 32) throw new Error(`${name}_NOT_CONFIGURED_OR_TOO_SHORT`);
  return value;
}

function generateAccountNumber() {
  return `81${crypto.randomInt(10_000_000, 100_000_000)}`;
}

async function createUniqueAccountNumber(tx: Prisma.TransactionClient) {
  for (let i = 0; i < 10; i++) {
    const accountNumber = generateAccountNumber();
    const exists = await tx.user.findUnique({ where: { accountNumber }, select: { id: true } });
    if (!exists) return accountNumber;
  }
  throw new Error("ACCOUNT_NUMBER_GENERATION_FAILED");
}

requireSecret("JWT_SECRET");
requireSecret("REFRESH_SECRET");

app.get("/api/health", (_req, res) => res.json({ success: true, service: "internal-wallet" }));

app.post("/api/auth/register", authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    firstName: z.string().min(2).max(60),
    lastName: z.string().min(2).max(60),
    username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/),
    phone: z.string().regex(/^0\d{10}$/),
    email: z.string().email(),
    password: z.string().min(8).max(128),
    pin: z.string().regex(/^\d{4}$/)
  }).parse(req.body);

  const exists = await prisma.user.findFirst({
    where: { OR: [{ phone: body.phone }, { email: body.email }, { username: body.username }] }
  });
  if (exists) return res.status(409).json({ success: false, code: "ACCOUNT_EXISTS", message: "Phone, email or username is already registered." });

  const passwordHash = await argon2.hash(body.password);
  const pinHash = await argon2.hash(body.pin);
  const user = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const accountNumber = await createUniqueAccountNumber(tx);
    const u = await tx.user.create({
      data: {
        firstName: body.firstName,
        lastName: body.lastName,
        username: body.username,
        phone: body.phone,
        email: body.email,
        passwordHash,
        pinHash,
        accountNumber
      }
    });
    await tx.wallet.create({ data: { userId: u.id, balance: 500000000 } });
    await tx.notification.create({
      data: {
        userId: u.id,
        type: "SYSTEM",
        title: "Welcome",
        message: "Your internal wallet has been created."
      }
    });
    return u;
  });

  const access = signAccess(user.id);
  const refresh = signRefresh(user.id);
  await prisma.session.create({
    data: { userId: user.id, refreshHash: hashToken(refresh), expiresAt: new Date(Date.now() + 365 * 86400000) }
  });

  res.status(201).json({ success: true, accessToken: access, refreshToken: refresh });
}));

app.post("/api/auth/login", authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    identifier: z.string(),
    password: z.string()
  }).parse(req.body);

  const user = await prisma.user.findFirst({
    where: { OR: [{ phone: body.identifier }, { email: body.identifier }, { username: body.identifier.toLowerCase() }] }
  });

  if (!user || !(await argon2.verify(user.passwordHash, body.password))) {
    return res.status(401).json({ success: false, code: "INVALID_LOGIN", message: "Invalid login details." });
  }

  if (user.status !== "ACTIVE") {
    return res.status(403).json({ success: false, code: "ACCOUNT_LOCKED", message: "Account is not active." });
  }

  const access = signAccess(user.id);
  const refresh = signRefresh(user.id);
  await prisma.session.create({
    data: { userId: user.id, refreshHash: hashToken(refresh), expiresAt: new Date(Date.now() + 365 * 86400000) }
  });

  res.json({ success: true, accessToken: access, refreshToken: refresh });
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
      data: { refreshHash: hashToken(nextRefresh), previousRefreshHash: currentHash }
    });
    res.json({ success: true, accessToken: signAccess(payload.sub), refreshToken: nextRefresh });
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
    include: { wallet: true }
  });
  if (!user) return res.status(404).json({ success: false, message: "User not found" });
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
      balance: user.wallet?.balance.toString() ?? "0"
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

app.post("/api/transfers/internal", requireAuth, moneyLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    recipientId: z.string(),
    amount: z.coerce.number().positive().max(50000000),
    narration: z.string().max(140).optional(),
    pin: z.string().regex(/^\d{4}$/),
    senderId: z.string().trim().max(30).optional()
  }).parse(req.body);

  try {
    await verifyTransactionPin(req.userId, body.pin);
  } catch (e: any) {
    const code = e?.message || "INVALID_PIN";
    return res.status(code === "PIN_LOCKED" ? 423 : code === "USER_NOT_FOUND" ? 404 : 401)
      .json({ success: false, code, message: friendlyPinError(code) });
  }

  try {
    const result = await internalTransfer(
      req.userId,
      body.recipientId,
      new Prisma.Decimal(body.amount.toFixed(2)),
      body.narration,
      idempotencyKey(req),
      body.senderId
    );
    res.json({
  success: true,
  transaction: result
});
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

app.post("/api/transfers/external/simulate", requireAuth, moneyLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    accountNumber: z.string().regex(/^\d{10}$/),
    bankCode: z.string().min(2).max(20),
    bankName: z.string().min(2).max(120),
    accountName: z.string().min(2).max(120),
    amount: z.coerce.number().positive().max(50000000),
    narration: z.string().max(140).optional(),
    pin: z.string().regex(/^\d{4}$/)
  }).parse(req.body);

  const user = await prisma.user.findUnique({ where: { id: req.userId }, include: { wallet: true } });
  if (!user?.wallet) return res.status(404).json({ success: false, code: "WALLET_NOT_FOUND", message: "Wallet not found." });
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
  const requestHash = hashRequest({ accountNumber: body.accountNumber, bankCode: body.bankCode, bankName: body.bankName, accountName: body.accountName, amount: amount.toFixed(2), narration: body.narration || null });

  const transaction = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.idempotencyKey.findUnique({
      where: {
        userId_key: {
          userId: req.userId!,
          key: requestKey
        }
      }
    });
    if (existing) {
      if (existing.requestHash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
      const existingTransaction = await tx.transaction.findUnique({ where: { id: existing.transactionId } });
      if (!existingTransaction) throw new Error("IDEMPOTENCY_TRANSACTION_NOT_FOUND");
      return existingTransaction;
    }
    const created = await tx.transaction.create({
      data: {
        reference: reference("BANKSIM"),
        senderId: user.id,
        type: "BANK_TRANSFER",
        status: "PROCESSING",
        amount,
        total: amount,
        narration: body.narration,
        recipientName: body.accountName,
        recipientAccount: body.accountNumber,
        recipientBank: body.bankName,
        metadata: {
          simulated: true,
          externalBank: true,
          bankCode: body.bankCode,
          provider: "Veyra Simulation"
        }
      }
    });

    const debit = await tx.wallet.updateMany({ where: { userId: user.id, status: "ACTIVE", balance: { gte: amount } }, data: { balance: { decrement: amount } } });
    if (debit.count !== 1) throw new Error("INSUFFICIENT_BALANCE");
    const completed = await tx.transaction.update({
      where: { id: created.id },
      data: { status: "SUCCESS", completedAt: new Date() }
    });
    await tx.transactionEntry.create({ data: { transactionId: completed.id, userId: user.id, type: "DEBIT", amount } });
    await tx.notification.create({
      data: {
        userId: user.id,
        type: "TRANSFER_SENT",
        title: "Transfer Successful",
        message: `₦${amount.toFixed(2)} simulated transfer to ${body.accountName} (${body.accountNumber}) at ${body.bankName}. No real money was sent.`
      }
    });
    await tx.idempotencyKey.create({ data: { key: requestKey, userId: req.userId, requestHash, transactionId: completed.id } });
    return completed;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  res.json({
    success: true,
    simulated: true,
    transaction,
    receipt: {
      title: "Transfer Successful",
      amount: amount.toFixed(2),
      accountName: body.accountName,
      accountNumber: body.accountNumber,
      bankName: body.bankName,
      disclaimer: "Simulation transfer • No real money received"
    }
  });
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
          userId: req.userId!,
          key: requestKey
        }
      }
    });
    if (existing) {
      if (existing.requestHash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
      const existingTransaction = await tx.transaction.findUnique({ where: { id: existing.transactionId } });
      if (!existingTransaction) throw new Error("IDEMPOTENCY_TRANSACTION_NOT_FOUND");
      return existingTransaction;
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
  const access = signAccess(req.userId);
  const refresh = signRefresh(req.userId);
  await prisma.session.create({ data: { userId: req.userId, refreshHash: hashToken(refresh), expiresAt: new Date(Date.now() + 365 * 86400000) } });
  res.json({ success: true, accessToken: access, refreshToken: refresh, message: "Password updated successfully." });
}));

app.post("/api/security/pin", requireAuth, moneyLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ currentPin: z.string().regex(/^\d{4}$/), newPin: z.string().regex(/^\d{4}$/) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { pinHash: true } });
  if (!user || !(await argon2.verify(user.pinHash, body.currentPin))) return res.status(401).json({ success: false, code: "INVALID_PIN", message: "Current transaction PIN is incorrect." });
  await prisma.user.update({ where: { id: req.userId }, data: { pinHash: await argon2.hash(body.newPin), pinFailures: 0, pinLockedUntil: null } });
  res.json({ success: true, message: "Transaction PIN updated successfully." });
}));

app.get("/api/security/face/verify", requireAuth, asyncRoute(async (_req: any, res: any) => {
  res.status(501).json({ success: false, code: "FACE_VERIFICATION_NOT_CONFIGURED", message: "Face verification is not configured in this backend." });
}));
app.post("/api/security/face/enroll", requireAuth, asyncRoute(async (_req: any, res: any) => {
  res.status(501).json({ success: false, code: "FACE_VERIFICATION_NOT_CONFIGURED", message: "Face verification is not configured in this backend." });
}));
app.post("/api/security/face/verify", requireAuth, asyncRoute(async (_req: any, res: any) => {
  res.status(501).json({ success: false, code: "FACE_VERIFICATION_NOT_CONFIGURED", message: "Face verification is not configured in this backend." });
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
      const requestHash = hashRequest({ savingsId: req.params.id, amount: amount.toFixed(2), direction: "deposit" });
      const existing = await tx.idempotencyKey.findUnique({
        where: { userId_key: { userId: req.userId!, key } }
      });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
        return tx.savingsAccount.findUnique({ where: { id: req.params.id } });
      }
      const savings = await tx.savingsAccount.findFirst({where:{id:req.params.id,userId:req.userId,active:true}});
      if (!savings) throw new Error("SAVINGS_NOT_FOUND");
      const debit = await tx.wallet.updateMany({where:{userId:req.userId,status:"ACTIVE",balance:{gte:amount}},data:{balance:{decrement:amount}}});
      if (debit.count!==1) throw new Error("INSUFFICIENT_BALANCE");
      const updated = await tx.savingsAccount.update({where:{id:savings.id},data:{balance:{increment:amount}}});
      const txr = await tx.transaction.create({data:{reference:reference("SAVE"),senderId:req.userId,type:"SAVINGS_DEPOSIT",status:"SUCCESS",amount,total:amount,completedAt:new Date(),metadata:{simulated:true,savingsAccountId:savings.id}}});
      await tx.transactionEntry.create({data:{transactionId:txr.id,userId:req.userId,type:"DEBIT",amount}});
      await tx.notification.create({data:{userId:req.userId,type:"SAVINGS",title:"Savings Deposit",message:`₦${amount.toFixed(2)} moved into ${savings.name}.`}});
      await tx.idempotencyKey.create({ data: { key, userId: req.userId!, requestHash, transactionId: txr.id } });
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
      const requestHash = hashRequest({ savingsId: req.params.id, amount: amount.toFixed(2), direction: "withdraw" });
      const existing = await tx.idempotencyKey.findUnique({
        where: { userId_key: { userId: req.userId!, key } }
      });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
        return tx.savingsAccount.findUnique({ where: { id: req.params.id } });
      }
      const savings = await tx.savingsAccount.findFirst({where:{id:req.params.id,userId:req.userId,active:true}});
      if (!savings) throw new Error("SAVINGS_NOT_FOUND");
      const debit = await tx.savingsAccount.updateMany({where:{id:savings.id,userId:req.userId,active:true,balance:{gte:amount}},data:{balance:{decrement:amount}}});
      if (debit.count!==1) throw new Error("INSUFFICIENT_SAVINGS_BALANCE");
      await tx.wallet.update({where:{userId:req.userId},data:{balance:{increment:amount}}});
      const txr = await tx.transaction.create({data:{reference:reference("SAVW"),senderId:req.userId,type:"SAVINGS_WITHDRAWAL",status:"SUCCESS",amount,total:amount,completedAt:new Date(),metadata:{simulated:true,savingsAccountId:savings.id}}});
      await tx.transactionEntry.create({data:{transactionId:txr.id,userId:req.userId,type:"CREDIT",amount}});
      await tx.notification.create({data:{userId:req.userId,type:"SAVINGS",title:"Savings Withdrawal",message:`₦${amount.toFixed(2)} withdrawn from ${savings.name}.`}});
      await tx.idempotencyKey.create({ data: { key, userId: req.userId!, requestHash, transactionId: txr.id } });
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

function friendlyError(code: string) {
  const map: Record<string, string> = {
    IDEMPOTENCY_KEY_REQUIRED: "A transaction request key is required.",
    IDEMPOTENCY_CONFLICT: "This request key was already used for different transaction details.",
    WALLET_NOT_ACTIVE: "One of the wallets is not active.",
    INVALID_AMOUNT: "Enter a valid amount.",
    SELF_TRANSFER: "You cannot transfer money to yourself.",
    ACCOUNT_NOT_FOUND: "Sender or recipient account was not found.",
    ACCOUNT_NOT_ACTIVE: "One of the accounts is not active.",
    INSUFFICIENT_BALANCE: "Insufficient wallet balance.",
    IDEMPOTENCY_TRANSACTION_NOT_FOUND: "The previous transaction record could not be found."
  };
  return map[code] || "The transaction could not be completed.";
}

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("API error:", err?.name || "unknown", err?.code || "unknown");
  if (err?.name === "ZodError") return res.status(400).json({ success: false, code: "VALIDATION_ERROR", message: "Check the submitted information." });
  if (err?.code === "P2002") return res.status(409).json({ success: false, code: "DUPLICATE_RESOURCE", message: "A unique account detail is already in use." });
  res.status(500).json({ success: false, code: "SERVER_ERROR", message: "Something went wrong." });
});

app.listen(port, () => console.log(`Backend running on http://localhost:${port}`));
