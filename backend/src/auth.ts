import jwt from "jsonwebtoken";
import crypto from "node:crypto";

const JWT_SECRET = process.env.JWT_SECRET || "";
const REFRESH_SECRET = process.env.REFRESH_SECRET || "";

export function signAccess(userId: string) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "15m" });
}

export function verifyAccess(token: string) {
  try {
    return jwt.verify(token, JWT_SECRET) as any;
  } catch {
    return null;
  }
}

export function signRefresh(userId: string) {
  // create opaque refresh token (not a JWT)
  return crypto.randomBytes(48).toString("hex");
}

export function verifyRefresh(token: string) {
  // For this implementation we don't embed userId in the token itself.
  // Server verifies refresh token by hashing and checking the sessions table.
  return { sub: token };
}

export function hashToken(token: string) {
  return crypto.createHmac("sha256", REFRESH_SECRET || "fallback").update(token).digest("hex");
}

export function hashRequest(obj: any) {
  // deterministic JSON then HMAC
  const str = JSON.stringify(canonicalize(obj));
  return crypto.createHmac("sha256", REFRESH_SECRET || "fallback").update(str).digest("hex");
}

// canonicalize object keys recursively
function canonicalize(obj: any): any {
  if (Array.isArray(obj)) return obj.map(canonicalize);
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    const out: any = {};
    for (const k of keys) out[k] = canonicalize(obj[k]);
    return out;
  }
  return obj;
}