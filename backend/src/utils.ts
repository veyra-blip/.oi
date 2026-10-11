import crypto from "node:crypto";

export function reference(prefix = "TXN") {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

export function idempotencyKey(req: any) {
  return String(req.headers["idempotency-key"] || "");
}
