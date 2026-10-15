import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import argon2 from "argon2";
import { z } from "zod";
import { prisma } from "./db.js";
import { asyncRoute, requireAuth } from "./middleware.js";
import { hashToken, signAccess, signRefresh, verifyRefresh } from "./auth.js";
import { internalTransfer } from "./transactionService.js";
import { idempotencyKey, reference } from "./utils.js";
import { Prisma } from "@prisma/client";

const app = express();
app.set("trust proxy", 1);
const port = Number(process.env.PORT || 4000);

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "100kb" }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50 });
const moneyLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30 });

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
  const accountNumber = `81${Math.floor(10000000 + Math.random() * 90000000)}`;

  const user = await prisma.$transaction(async (tx) => {
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
    data: { userId: user.id, refreshHash: hashToken(refresh), expiresAt: new Date(Date.now() + 7 * 86400000) }
  });

  res.status(201).json({ success: true, accessToken: access, refreshToken: refresh });
}));

app.post("/api/auth/login", authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    identifier: z.string(),
    password: z.string()
  }).parse(req.body);

  const user = await prisma.user.findFirst({
    where: { OR: [{ phone: body.identifier }, { email: body.identifier }] }
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
    data: { userId: user.id, refreshHash: hashToken(refresh), expiresAt: new Date(Date.now() + 7 * 86400000) }
  });

  res.json({ success: true, accessToken: access, refreshToken: refresh });
}));

app.post("/api/auth/refresh", asyncRoute(async (req: any, res: any) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
  try {
    const payload = verifyRefresh(refreshToken);
    const session = await prisma.session.findFirst({
      where: { userId: payload.sub, refreshHash: hashToken(refreshToken), expiresAt: { gt: new Date() } }
    });
    if (!session) return res.status(401).json({ success: false, code: "INVALID_REFRESH", message: "Refresh session invalid." });
    res.json({ success: true, accessToken: signAccess(payload.sub) });
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
    pin: z.string().regex(/^\d{4}$/)
  }).parse(req.body);

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ success: false, message: "User not found." });

  if (user.pinLockedUntil && user.pinLockedUntil > new Date()) {
    return res.status(423).json({ success: false, code: "PIN_LOCKED", message: "Transaction PIN is temporarily locked." });
  }

  const validPin = await argon2.verify(user.pinHash, body.pin);
  if (!validPin) {
    const failures = user.pinFailures + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        pinFailures: failures >= 5 ? 0 : failures,
        pinLockedUntil: failures >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null
      }
    });
    return res.status(401).json({ success: false, code: "INVALID_PIN", message: "Incorrect transaction PIN." });
  }

  await prisma.user.update({ where: { id: user.id }, data: { pinFailures: 0, pinLockedUntil: null } });

  try {
    const transaction = await internalTransfer(
      req.userId,
      body.recipientId,
      new Prisma.Decimal(body.amount.toFixed(2)),
      body.narration,
      idempotencyKey(req)
    );
    res.json({ success: true, transaction });
  } catch (e: any) {
    const code = e.message || "TRANSFER_FAILED";
    const status = code === "INSUFFICIENT_BALANCE" ? 400 : code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409;
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
  if (user.pinLockedUntil && user.pinLockedUntil > new Date()) {
    return res.status(423).json({ success: false, code: "PIN_LOCKED", message: "Transaction PIN is temporarily locked." });
  }
  const validPin = await argon2.verify(user.pinHash, body.pin);
  if (!validPin) {
    const failures = user.pinFailures + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        pinFailures: failures >= 5 ? 0 : failures,
        pinLockedUntil: failures >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null
      }
    });
    return res.status(401).json({ success: false, code: "INVALID_PIN", message: "Incorrect transaction PIN." });
  }
  await prisma.user.update({ where: { id: user.id }, data: { pinFailures: 0, pinLockedUntil: null } });

  const amount = new Prisma.Decimal(body.amount.toFixed(2));
  if (user.wallet.balance.lt(amount)) {
    return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", message: "Insufficient wallet balance." });
  }

  const transaction = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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

    await tx.wallet.update({ where: { userId: user.id }, data: { balance: { decrement: amount } } });
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
    return completed;
  });

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

  if (!(await argon2.verify(user.pinHash, body.pin))) {
    return res.status(401).json({ success: false, code: "INVALID_PIN", message: "Incorrect transaction PIN." });
  }

  const amount = new Prisma.Decimal(body.amount.toFixed(2));
  if (user.wallet.balance.lt(amount)) {
    return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", message: "Insufficient wallet balance." });
  }

  const transaction = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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

    await tx.wallet.update({ where: { userId: user.id }, data: { balance: { decrement: amount } } });
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
    return tx.transaction.findUnique({ where: { id: created.id } });
  });

  res.json({ success: true, transaction });
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
  res.json({ success: true, card: updated });
}));

app.get("/api/loans", requireAuth, asyncRoute(async (req: any, res: any) => {
  res.json({ success: true, loans: await prisma.loan.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } }) });
}));

app.post("/api/loans", requireAuth, asyncRoute(async (req: any, res: any) => {
  const body = z.object({
    amount: z.coerce.number().positive().max(100000000),
    durationMonths: z.coerce.number().int().min(1).max(60)
  }).parse(req.body);
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

app.get("/api/admin/users", requireAuth, asyncRoute(async (req: any, res: any) => {
  // Demo admin gate: a real production system should use a dedicated Role model.
  const me = await prisma.user.findUnique({ where: { id: req.userId } });
  if (me?.email !== "admin@example.com") return res.status(403).json({ success: false, message: "Admin only." });
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, firstName: true, lastName: true, username: true, phone: true, email: true, accountNumber: true, status: true, createdAt: true }
  });
  res.json({ success: true, users });
}));

function friendlyError(code: string) {
  const map: Record<string, string> = {
    IDEMPOTENCY_KEY_REQUIRED: "A transaction request key is required.",
    INVALID_AMOUNT: "Enter a valid amount.",
    SELF_TRANSFER: "You cannot transfer money to yourself.",
    ACCOUNT_NOT_FOUND: "Sender or recipient account was not found.",
    ACCOUNT_NOT_ACTIVE: "One of the accounts is not active.",
    INSUFFICIENT_BALANCE: "Insufficient wallet balance."
  };
  return map[code] || "The transaction could not be completed.";
}

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error(err);
  if (err?.name === "ZodError") return res.status(400).json({ success: false, code: "VALIDATION_ERROR", message: "Check the submitted information." });
  res.status(500).json({ success: false, code: "SERVER_ERROR", message: "Something went wrong." });
});

app.listen(port, () => console.log(`Backend running on http://localhost:${port}`));
