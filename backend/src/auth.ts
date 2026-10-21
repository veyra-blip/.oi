import jwt from "jsonwebtoken";
import crypto from "node:crypto";

function secret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || value.length < 32) throw new Error(`${name}_NOT_CONFIGURED`);
  return value;
}

export function signAccess(userId: string, sessionId: string) {
  return jwt.sign({ sub: userId, sid: sessionId }, secret("JWT_SECRET"), { expiresIn: "15m" });
}

export function signRefresh(userId: string) {
  const jti = crypto.randomUUID();
  return jwt.sign({ sub: userId, jti }, secret("REFRESH_SECRET"), { expiresIn: "730d" });
}

export function verifyAccess(token: string) {
  return jwt.verify(token, secret("JWT_SECRET")) as { sub: string; sid: string };
}

export function verifyRefresh(token: string) {
  return jwt.verify(token, secret("REFRESH_SECRET")) as { sub: string; jti: string };
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function hashRequest(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
