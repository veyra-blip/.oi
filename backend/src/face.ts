import crypto from "node:crypto";

function key() {
  const raw = process.env.FACE_ENCRYPTION_KEY || process.env.JWT_SECRET || "veyra-face-dev-key";
  return crypto.createHash("sha256").update(raw).digest();
}

export function encryptTemplate(template: number[]) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.from(JSON.stringify(template));
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptTemplate(value: string): number[] {
  const [ivRaw, tagRaw, bodyRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !bodyRaw) throw new Error("INVALID_FACE_TEMPLATE");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  const body = Buffer.concat([decipher.update(Buffer.from(bodyRaw, "base64url")), decipher.final()]);
  const parsed = JSON.parse(body.toString("utf8"));
  if (!Array.isArray(parsed) || parsed.some((n) => typeof n !== "number")) throw new Error("INVALID_FACE_TEMPLATE");
  return parsed;
}

export function templateDistance(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum / a.length);
}
