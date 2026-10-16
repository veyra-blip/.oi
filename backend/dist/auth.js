import jwt from "jsonwebtoken";
import crypto from "node:crypto";
const jwtSecret = process.env.JWT_SECRET || "dev-secret";
const refreshSecret = process.env.REFRESH_SECRET || "dev-refresh-secret";
export function signAccess(userId) {
    return jwt.sign({ sub: userId }, jwtSecret, { expiresIn: "15m" });
}
export function signRefresh(userId) {
    return jwt.sign({ sub: userId, jti: crypto.randomUUID() }, refreshSecret, { expiresIn: "7d" });
}
export function verifyAccess(token) {
    return jwt.verify(token, jwtSecret);
}
export function verifyRefresh(token) {
    return jwt.verify(token, refreshSecret);
}
export function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}
