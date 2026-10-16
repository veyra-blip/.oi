import jwt from "jsonwebtoken";
import crypto from "node:crypto";

const jwtSecret = process.env.JWT_SECRET || "dev-secret";
const refreshSecret = process.env.REFRESH_SECRET || "dev-refresh-secret";

export function signAccess(userId: string) {
  return jwt.sign({ sub: userId }, jwtSecret, { expiresIn: "15m" });
}

export function signRefresh(userId: string) {
  return jwt.sign({ sub: userId, jti: crypto.randomUUID() }, refreshSecret, { expiresIn: "365d" });
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
