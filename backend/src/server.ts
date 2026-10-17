import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import argon2 from "argon2";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "./db.js";
import { asyncRoute, requireAuth, idempotencyKey } from "./middleware.js";
import { hashRequest, hashToken, signAccess, signRefresh, verifyRefresh } from "./auth.js";
import { internalTransfer } from "./transactionService.js";
import { Prisma } from "@prisma/client";
import { friendlyPinError, verifyTransactionPin } from "./security.js";

const app = express();
app.set("trust proxy", 1);
const port = Number(process.env.PORT || 4000);

app.use(helmet());
const FRONTEND = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
app.use(cors({ origin: FRONTEND, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "100kb" }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50 });
const moneyLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30 });

function requireSecret(name: string) {
  const value = process.env[name]?.trim();
  if (!value || value.length < 10) throw new Error(`${name}_NOT_CONFIGURED_OR_TOO_SHORT`);
  return value;
}

function setRefreshCookie(res: any, token: string) {
  const maxAge = 2 * 365 * 24 * 60 * 60 * 1000;
  res.cookie("refreshToken", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge
  });
}
function clearRefreshCookie(res: any) { res.clearCookie("refreshToken"); }

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

  const exists = await prisma.user.findFirst({ where: { OR: [{ phone: body.phone }, { email: body.email }, { username: body.username }] } });
  if (exists) return res.status(409).json({ success: false, code: "ACCOUNT_EXISTS", message: "Phone, email or username is already registered." });

  const passwordHash = await argon2.hash(body.password);
  const pinHash = await argon2.hash(body.pin);
  const user = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const accountNumber = `81${crypto.randomInt(10_000_000, 100_000_000)}`;
    const u = await tx.user.create({
      data: { firstName: body.firstName, lastName: body.lastName, username: body.username, phone: body.phone, email: body.email, passwordHash, pinHash, accountNumber }
    });
    await tx.wallet.create({ data: { userId: u.id, balance: 500000000 } });
    await tx.notification.create({ data: { userId: u.id, type: "SYSTEM", title: "Welcome", message: "Your internal wallet has been created." } });
    return u;
  });

  const access = signAccess(user.id);
  const refresh = signRefresh(user.id);
  await prisma.session.create({ data: { userId: user.id, refreshHash: hashToken(refresh), expiresAt: new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000) } });
  setRefreshCookie(res, refresh);
  res.status(201).json({ success: true, accessToken: access });
}));

app.post("/api/auth/login", authLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ identifier: z.string(), password: z.string() }).parse(req.body);
  const user = await prisma.user.findFirst({ where: { OR: [{ phone: body.identifier }, { email: body.identifier }, { username: body.identifier.toLowerCase() }] } });
  if (!user || !(await argon2.verify(user.passwordHash, body.password))) return res.status(401).json({ success: false, code: "INVALID_LOGIN", message: "Invalid login details." });
  if (user.status !== "ACTIVE") return res.status(403).json({ success: false, code: "ACCOUNT_LOCKED", message: "Account is not active." });

  const access = signAccess(user.id);
  const refresh = signRefresh(user.id);
  await prisma.session.create({ data: { userId: user.id, refreshHash: hashToken(refresh), expiresAt: new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000) } });
  setRefreshCookie(res, refresh);
  res.json({ success: true, accessToken: access });
}));

app.post("/api/auth/refresh", authLimiter, asyncRoute(async (req: any, res: any) => {
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!refreshToken) return res.status(401).json({ success: false, code: "INVALID_REFRESH", message: "Refresh session invalid." });
  const currentHash = hashToken(refreshToken);
  const session = await prisma.session.findFirst({ where: { refreshHash: currentHash, revokedAt: null, expiresAt: { gt: new Date() } } });
  if (!session) return res.status(401).json({ success: false, code: "INVALID_REFRESH", message: "Refresh session invalid." });

  const nextRefresh = signRefresh(session.userId);
  await prisma.session.update({ where: { id: session.id }, data: { refreshHash: hashToken(nextRefresh), previousRefreshHash: currentHash } });
  setRefreshCookie(res, nextRefresh);
  res.json({ success: true, accessToken: signAccess(session.userId) });
}));

app.post("/api/auth/logout", requireAuth, asyncRoute(async (req: any, res: any) => {
  await prisma.session.deleteMany({ where: { userId: req.userId } });
  clearRefreshCookie(res);
  res.json({ success: true });
}));

app.get("/api/me", requireAuth, asyncRoute(async (req: any, res: any) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId }, include: { wallet: true } });
  if (!user) return res.status(404).json({ success: false, message: "User not found" });
  res.json({ success: true, user: { id: user.id, firstName: user.firstName, lastName: user.lastName, username: user.username, phone: user.phone, email: user.email, accountNumber: user.accountNumber, balance: user.wallet?.balance.toString() ?? "0" } });
}));

app.get("/api/users/lookup", requireAuth, asyncRoute(async (req: any, res: any) => {
  const q = String(req.query.q || "").trim(); if (q.length < 3) return res.status(400).json({ success: false, message: "Search is too short." });
  const user = await prisma.user.findFirst({ where: { status: "ACTIVE", OR: [{ phone: q }, { accountNumber: q }, { username: q }] }, select: { id: true, firstName: true, lastName: true, username: true, accountNumber: true } });
  if (!user || user.id === req.userId) return res.status(404).json({ success: false, message: "Recipient not found." });
  res.json({ success: true, recipient: user });
}));

app.post("/api/transfers/internal", requireAuth, moneyLimiter, asyncRoute(async (req: any, res: any) => {
  const body = z.object({ recipientId: z.string(), amount: z.coerce.number().positive().max(50000000), narration: z.string().max(140).optional(), pin: z.string().regex(/^\d{4}$/), senderId: z.string().trim().max(30).optional() }).parse(req.body);
  try { await verifyTransactionPin(req.userId, body.pin); } catch (e: any) { const code = e?.message || "INVALID_PIN"; return res.status(code === "PIN_LOCKED" ? 423 : code === "USER_NOT_FOUND" ? 404 : 401).json({ success: false, code, message: friendlyPinError(code) }); }
  try {
    const result = await internalTransfer(req.userId, body.recipientId, new Prisma.Decimal(body.amount.toFixed(2)), body.narration, idempotencyKey(req), body.senderId);
    res.json({ success: true, transaction: result });
  } catch (e: any) {
    const code = e.message || "TRANSFER_FAILED";
    const status = code === "INSUFFICIENT_BALANCE" ? 400 : 409;
    res.status(status).json({ success: false, code, message: "The transaction could not be completed." });
  }
}));

app.get("/api/transactions", requireAuth, asyncRoute(async (req: any, res: any) => {
  const rows = await prisma.transaction.findMany({
    where: { OR: [{ senderId: req.userId }, { receiverId: req.userId }] },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      sender: { select: { firstName: true, lastName: true, accountNumber: true } },
      receiver: { select: { firstName: true, lastName: true, accountNumber: true } }
    }
  });

  // Parse metadata strings back into objects for clients
  const parsed = rows.map((r: any) => {
    let meta = null;
    try {
      if (typeof r.metadata === "string" && r.metadata.length) meta = JSON.parse(r.metadata);
    } catch {
      meta = null;
    }
    return { ...r, metadata: meta };
  });

  res.json({ success: true, transactions: parsed });
}));

// Paystack integration (account name lookup)
let paystackBanksCache: { expiresAt: number; banks: any[] } = { expiresAt: 0, banks: [] };

async function paystackRequest(path: string, init: RequestInit = {}) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error("PAYSTACK_NOT_CONFIGURED");
  const response = await fetch(`https://api.paystack.co${path}`, { ...init, headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  let data: any = {};
  try { data = await response.json(); } catch {}
  if (!response.ok || data.status === false) {
    const err: any = new Error(data.message || "Paystack request failed.");
    err.httpStatus = response.status;
    throw err;
  }
  return data;
}

app.get("/api/paystack/resolve", requireAuth, moneyLimiter, asyncRoute(async (req: any, res: any) => {
  const { accountNumber, bankCode } = z.object({ accountNumber: z.string().regex(/^\d{10}$/), bankCode: z.string().min(2).max(20) }).parse({ accountNumber: String(req.query.accountNumber || ""), bankCode: String(req.query.bankCode || "") });
  try {
    const data = await paystackRequest(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
    const account = data.data;
    if (!account?.account_name) return res.status(404).json({ success: false, code: "ACCOUNT_NOT_RESOLVED", message: "Could not resolve the account name." });
    res.json({ success: true, account: { accountNumber: String(account.account_number || accountNumber), accountName: String(account.account_name), bankId: account.bank_id ?? null, bankCode }, source: "paystack" });
  } catch (e: any) {
    const message = String(e?.message || "Could not resolve account.");
    if (message === "PAYSTACK_NOT_CONFIGURED") return res.status(503).json({ success: false, code: message, message: "Paystack account verification is not configured on the backend." });
    return res.status(404).json({ success: false, code: "ACCOUNT_NOT_RESOLVED", message: "Could not resolve account name." });
  }
}));

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("API error:", err?.name || "unknown", err?.code || "unknown");
  if (err?.name === "ZodError") return res.status(400).json({ success: false, code: "VALIDATION_ERROR", message: "Check the submitted information." });
  if (err?.code === "P2002") return res.status(409).json({ success: false, code: "DUPLICATE_RESOURCE", message: "A unique account detail is already in use." });
  res.status(500).json({ success: false, code: "SERVER_ERROR", message: "Something went wrong." });
});

app.listen(port, () => console.log(`Backend running on http://localhost:${port}`));