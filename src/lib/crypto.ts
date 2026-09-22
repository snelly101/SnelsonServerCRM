import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for integration credentials at rest.
 * Format: base64("v1" || iv(12) || authTag(16) || ciphertext)
 * The key comes from APP_ENCRYPTION_KEY (32 bytes, base64). It never leaves the server.
 */
function getKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) throw new Error("APP_ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("APP_ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}

const VERSION = Buffer.from("v1");

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([VERSION, iv, tag, ct]).toString("base64");
}

export function decryptSecret(payload: string): string {
  const key = getKey();
  const buf = Buffer.from(payload, "base64");
  if (buf.subarray(0, 2).toString() !== "v1") throw new Error("Unknown ciphertext version");
  const iv = buf.subarray(2, 14);
  const tag = buf.subarray(14, 30);
  const ct = buf.subarray(30);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Masks a secret for display: shows the last 4 characters only. */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}
