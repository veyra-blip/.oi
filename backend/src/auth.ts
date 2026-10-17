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

// Access token: short-lived.
// The refresh token keeps the user signed in when the website is reopened.
export function signAccess(userId: string) {
  return jwt.sign(
    { sub: userId },
    jwtSecret,
    { expiresIn: "15m" }
  );
}

// Refresh token: 2 years.
// This allows the user to remain signed in for up to two years
// without entering their username/password again, unless the
// refresh token is revoked, expires, or the account is locked.
export function signRefresh(userId: string) {
  return jwt.sign(
    {
      sub: userId,
      jti: crypto.randomUUID()
    },
    refreshSecret,
    { expiresIn: "2y" }
  );
}

export function verifyAccess(token: string) {
  return jwt.verify(token, jwtSecret) as {
    sub: string;
  };
}

export function verifyRefresh(token: string) {
  return jwt.verify(token, refreshSecret) as {
    sub: string;
    jti: string;
  };
}

export function hashToken(token: string) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

export function hashRequest(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}
