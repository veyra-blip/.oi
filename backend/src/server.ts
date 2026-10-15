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
import crypto from "node:crypto";
import { decryptTemplate, encryptTemplate, templateDistance } from "./face.js";

const app = express();
const port = Number(process.env.PORT || 4000);

app.use(helmet());
const allowedOrigins = String(process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || "*").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => { if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) return callback(null, true); callback(new Error("CORS_ORIGIN_NOT_ALLOWED")); }, methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"], allowedHeaders: ["Content-Type","Authorization","Idempotency-Key"], credentials: false }));
app.use(express.json({ limit: "100kb" }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50 });
const moneyLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30 });

app.get("/api/health", (_req: any, res: any) => res.json({ success: true, service: "veyra", status: "online" }));

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
        nin: body.nin || null,
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

app.post("/api/auth/reset/request", authLimiter, asyncRoute(async (req: any, res: any) => {
  const { identifier } = z.object({ identifier: z.string().min(3).max(120) }).parse(req.body);
  const user = await prisma.user.findFirst({ where: { OR: [{ email: identifier.toLowerCase() }, { phone: identifier }, { username: identifier.toLowerCase() }] } });
  if (!user) return res.status(404).json({ success: false, code: "ACCOUNT_NOT_FOUND", message: "No Veyra account matches that information." });
  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  await prisma.passwordReset.deleteMany({ where: { userId: user.id, usedAt: null } });
  await prisma.passwordReset.create({ data: { userId: user.id, codeHash, expiresAt: new Date(Date.now() + 10 * 60 * 1000) } });
  await prisma.securityEvent.create({ data: { userId: user.id, event: "PASSWORD_RESET_REQUEST" } });
  const response: any = { success: true, message: "Reset code created. It expires in 10 minutes." };
  if (process.env.RESET_DELIVERY_MODE === "display" || !process.env.RESET_DELIVERY_MODE) response.devCode = code;
  res.json(response);
}));

app.post("/api/auth/reset/face", authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ identifier: z.string().min(3).max(120), template: z.array(z.number().finite()).min(64).max(4096) }).parse(req.body);
  const user = await prisma.user.findFirst({ where: { OR: [{ email: body.identifier.toLowerCase() }, { phone: body.identifier }, { username: body.identifier.toLowerCase() }] } });
  if (!user) return res.status(404).json({ success: false, code: "ACCOUNT_NOT_FOUND", message: "No Veyra account matches that information." });
  const saved = await prisma.faceTemplate.findUnique({ where: { userId: user.id } });
  if (!saved) return res.status(404).json({ success: false, code: "FACE_NOT_ENROLLED", message: "This account has no enrolled face template." });
  const distance = templateDistance(decryptTemplate(saved.encrypted), body.template);
  if (distance > Number(process.env.FACE_MATCH_THRESHOLD || "0.32")) return res.status(401).json({ success: false, code: "FACE_MISMATCH", message: "Face verification did not match." });
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.passwordReset.deleteMany({ where: { userId: user.id, usedAt: null } });
  await prisma.passwordReset.create({ data: { userId: user.id, codeHash: "FACE", faceTokenHash: crypto.createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 10 * 60 * 1000) } });
  res.json({ success: true, faceToken: token, message: "Face matched. You may set a new password." });
}));

app.post("/api/auth/reset/confirm", authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ identifier: z.string().min(3).max(120), code: z.string().regex(/^\d{6}$/).optional(), faceToken: z.string().min(20).optional(), newPassword: z.string().min(8).max(128) }).parse(req.body);
  const user = await prisma.user.findFirst({ where: { OR: [{ email: body.identifier.toLowerCase() }, { phone: body.identifier }, { username: body.identifier.toLowerCase() }] } });
  if (!user) return res.status(400).json({ success: false, code: "INVALID_RESET", message: "Reset details are not valid." });
  const reset = await prisma.passwordReset.findFirst({ where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
  const codeHash = body.code ? crypto.createHash("sha256").update(body.code).digest("hex") : null;
  const faceHash = body.faceToken ? crypto.createHash("sha256").update(body.faceToken).digest("hex") : null;
  const valid = reset && reset.attempts < 5 && ((codeHash && reset.codeHash === codeHash) || (faceHash && reset.faceTokenHash === faceHash));
  if (!valid) return res.status(400).json({ success: false, code: "INVALID_RESET", message: "The reset code or face authorization is incorrect or expired." });
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await argon2.hash(body.newPassword) } }),
    prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
    prisma.session.deleteMany({ where: { userId: user.id } }),
    prisma.securityEvent.create({ data: { userId: user.id, event: "PASSWORD_RESET_SUCCESS" } })
  ]);
  res.json({ success: true, message: "Password changed. You can now sign in." });
}));

app.post("/api/auth/logout", requireAuth, asyncRoute(async (req: any, res: any) => {
  await prisma.session.deleteMany({ where: { userId: req.userId } });
  res.json({ success: true });
}));

app.post("/api/security/face/enroll", requireAuth, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ template: z.array(z.number().finite()).min(64).max(4096) }).parse(req.body);
  const encrypted = encryptTemplate(body.template);
  await prisma.faceTemplate.upsert({ where: { userId: req.userId! }, create: { userId: req.userId!, encrypted }, update: { encrypted } });
  await prisma.securityEvent.create({ data: { userId: req.userId!, event: "FACE_TEMPLATE_ENROLLED" } });
  res.json({ success: true, message: "Face template saved securely." });
}));

app.post("/api/security/face/verify", requireAuth, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ template: z.array(z.number().finite()).min(64).max(4096) }).parse(req.body);
  const saved = await prisma.faceTemplate.findUnique({ where: { userId: req.userId! } });
  if (!saved) return res.status(404).json({ success: false, code: "FACE_NOT_ENROLLED", message: "No face template is enrolled for this account." });
  const stored = decryptTemplate(saved.encrypted);
  const distance = templateDistance(stored, body.template);
  const threshold = Number(process.env.FACE_MATCH_THRESHOLD || "0.32");
  if (distance > threshold) return res.status(401).json({ success: false, code: "FACE_MISMATCH", message: "Face verification did not match." });
  await prisma.securityEvent.create({ data: { userId: req.userId!, event: "FACE_VERIFIED", metadata: { distance } } });
  res.json({ success: true, matched: true, distance });
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

app.post("/api/savings/:id/deposit", requireAuth, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ amount: z.coerce.number().positive().max(50000000), pin: z.string().regex(/^\d{4}$/) }).parse(req.body);
  const amount = new Prisma.Decimal(body.amount.toFixed(2));
  const user = await prisma.user.findUnique({ where: { id: req.userId! }, include: { wallet: true } });
  const savings = await prisma.savingsAccount.findFirst({ where: { id: req.params.id, userId: req.userId!, active: true } });
  if (!user?.wallet || !savings) return res.status(404).json({ success: false, message: "Savings account not found." });
  if (!(await argon2.verify(user.pinHash, body.pin))) return res.status(401).json({ success: false, message: "Incorrect transaction PIN." });
  if (user.wallet.balance.lt(amount)) return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", message: "Insufficient wallet balance." });
  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.wallet.update({ where: { userId: user.id }, data: { balance: { decrement: amount } } });
    return tx.savingsAccount.update({ where: { id: savings.id }, data: { balance: { increment: amount } } });
  });
  res.json({ success: true, savings: updated });
}));

app.post("/api/savings/:id/withdraw", requireAuth, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ amount: z.coerce.number().positive().max(50000000), pin: z.string().regex(/^\d{4}$/) }).parse(req.body);
  const amount = new Prisma.Decimal(body.amount.toFixed(2));
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  const savings = await prisma.savingsAccount.findFirst({ where: { id: req.params.id, userId: req.userId!, active: true } });
  if (!user || !savings) return res.status(404).json({ success: false, message: "Savings account not found." });
  if (!(await argon2.verify(user.pinHash, body.pin))) return res.status(401).json({ success: false, message: "Incorrect transaction PIN." });
  if (savings.balance.lt(amount)) return res.status(400).json({ success: false, code: "INSUFFICIENT_SAVINGS", message: "Insufficient savings balance." });
  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.savingsAccount.update({ where: { id: savings.id }, data: { balance: { decrement: amount } } });
    await tx.wallet.update({ where: { userId: user.id }, data: { balance: { increment: amount } } });
    return tx.savingsAccount.findUnique({ where: { id: savings.id } });
  });
  res.json({ success: true, savings: updated });
}));

app.get("/api/cards", requireAuth, asyncRoute(async (req: any, res: any) => {
  const cards = await prisma.card.findMany({
    where: { userId: req.userId },
    select: { id: true, maskedNumber: true, last4: true, expiryMonth: true, expiryYear: true, status: true, spendingLimit: true, createdAt: true }
  });
  res.json({ success: true, cards });
}));

app.post("/api/cards", requireAuth, asyncRoute(async (req: any, res: any) => {
  const exists = await prisma.card.findFirst({ where: { userId: req.userId!, status: { not: "BLOCKED" } } });
  if (exists) return res.status(409).json({ success: false, message: "You already have an active virtual card." });
  const number = Array.from({length: 16}, () => Math.floor(Math.random() * 10)).join("");
  const cvv = String(Math.floor(100 + Math.random() * 900));
  const card = await prisma.card.create({ data: { userId: req.userId!, last4: number.slice(-4), maskedNumber: `5399 •••• •••• ${number.slice(-4)}`, expiryMonth: new Date().getMonth()+1, expiryYear: new Date().getFullYear()+3, cvvHash: await argon2.hash(cvv), pinHash: await argon2.hash("0000") } });
  res.status(201).json({ success: true, card: { ...card, cvv } });
}));

app.delete("/api/cards/:id", requireAuth, asyncRoute(async (req: any, res: any) => {
  const card = await prisma.card.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!card) return res.status(404).json({ success: false, message: "Card not found." });
  await prisma.card.delete({ where: { id: card.id } });
  res.json({ success: true });
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

app.post("/api/security/password", requireAuth, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ currentPassword: z.string(), newPassword: z.string().min(8).max(128) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user || !(await argon2.verify(user.passwordHash, body.currentPassword))) return res.status(401).json({ success: false, message: "Current password is incorrect." });
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await argon2.hash(body.newPassword) } });
  await prisma.securityEvent.create({ data: { userId: user.id, event: "PASSWORD_CHANGED" } });
  res.json({ success: true, message: "Password updated." });
}));

app.post("/api/security/pin", requireAuth, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ currentPin: z.string().regex(/^\d{4}$/), newPin: z.string().regex(/^\d{4}$/) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user || !(await argon2.verify(user.pinHash, body.currentPin))) return res.status(401).json({ success: false, message: "Current transaction PIN is incorrect." });
  await prisma.user.update({ where: { id: user.id }, data: { pinHash: await argon2.hash(body.newPin), pinFailures: 0, pinLockedUntil: null } });
  await prisma.securityEvent.create({ data: { userId: user.id, event: "PIN_CHANGED" } });
  res.json({ success: true, message: "Transaction PIN updated." });
}));

app.post("/api/loans/:id/repay", requireAuth, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ amount: z.coerce.number().positive(), pin: z.string().regex(/^\d{4}$/) }).parse(req.body);
  const loan = await prisma.loan.findFirst({ where: { id: req.params.id, userId: req.userId!, status: { in: ["APPROVED","ACTIVE"] } } });
  const user = await prisma.user.findUnique({ where: { id: req.userId! }, include: { wallet: true } });
  if (!loan || !user?.wallet) return res.status(404).json({ success: false, message: "Active loan not found." });
  if (!(await argon2.verify(user.pinHash, body.pin))) return res.status(401).json({ success: false, message: "Incorrect transaction PIN." });
  const amount = new Prisma.Decimal(body.amount.toFixed(2));
  if (user.wallet.balance.lt(amount)) return res.status(400).json({ success: false, message: "Insufficient wallet balance." });
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.wallet.update({ where: { userId: user.id }, data: { balance: { decrement: amount } } });
    if (amount.gte(loan.totalRepayable)) await tx.loan.update({ where: { id: loan.id }, data: { status: "PAID" } });
  });
  res.json({ success: true, message: "Loan repayment recorded." });
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
