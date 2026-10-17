import jwt from "jsonwebtoken";
import crypto from "node:crypto";

function requiredSecret(name: string) {
  const value = process.env[name]?.trim();
  if (!value || value.length < 32) {
    throw new Error(`${name}_NOT_CONFIGURED_OR_TOO_SHORT`);
  }
  return value;
}

const jwtSecret = requiredSecret("JWT_SECRET");
const refreshSecret = requiredSecret("REFRESH_SECRET");

export function signAccess(userId: string) {
  return jwt.sign({ sub: userId }, jwtSecret, { expiresIn: "15m" });
}

export function signRefresh(userId: string) {
  return jwt.sign({ sub: userId, jti: crypto.randomUUID() }, refreshSecret, { expiresIn: "90d" });
}

export function verifyAccess(token: string) {
  return jwt.verify(token, jwtSecret) as { sub: string };
}

export function verifyRefresh(token: string) {
  return jwt.verify(token, refreshSecret) as { sub: string };
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
