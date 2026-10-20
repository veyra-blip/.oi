import jwt from "jsonwebtoken";
import crypto from "node:crypto";

const jwtSecret = process.env.JWT_SECRET?.trim();
const refreshSecret = process.env.REFRESH_SECRET?.trim();

if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error("JWT_SECRET_NOT_CONFIGURED_OR_TOO_SHORT");
}

if (!refreshSecret || refreshSecret.length < 32) {
  throw new Error("REFRESH_SECRET_NOT_CONFIGURED_OR_TOO_SHORT");
}

export function signAccess(userId: string) {
  return jwt.sign({ sub: userId }, jwtSecret, { expiresIn: "15m" });
}

// Veyra long-lived login: 730 days (2 years).
export function signRefresh(userId: string) {
  return jwt.sign(
    { sub: userId, jti: crypto.randomUUID() },
    refreshSecret,
    { expiresIn: "730d" }
  );
}

export function verifyAccess(token: string) {
  return jwt.verify(token, jwtSecret) as { sub: string };
}

export function verifyRefresh(token: string) {
  return jwt.verify(token, refreshSecret) as { sub: string; jti?: string };
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
