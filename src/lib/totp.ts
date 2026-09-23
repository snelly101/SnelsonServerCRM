import { createHmac } from "node:crypto";

/** RFC 4648 base32 decode (accepts lower case, spaces and missing padding). */
export function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function isValidBase32(input: string) {
  return /^[A-Za-z2-7 =]+$/.test(input) && base32Decode(input).length >= 10;
}

/** RFC 6238 TOTP (HMAC-SHA1/256/512). Returns the code and seconds until it changes. */
export function totp(secretBase32: string, opts: { digits?: number; period?: number; algorithm?: "sha1" | "sha256" | "sha512"; now?: number } = {}) {
  const digits = opts.digits ?? 6;
  const period = opts.period ?? 30;
  const algorithm = opts.algorithm ?? "sha1";
  const now = opts.now ?? Date.now();
  const counter = Math.floor(now / 1000 / period);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac(algorithm, base32Decode(secretBase32)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  const code = String(binary % 10 ** digits).padStart(digits, "0");
  const secondsRemaining = period - (Math.floor(now / 1000) % period);
  return { code, secondsRemaining, period };
}

/** Parses an otpauth:// URI or a bare base32 secret. */
export function parseTotpInput(input: string): { secret: string; issuer?: string; account?: string; digits?: number; period?: number; algorithm?: "sha1" | "sha256" | "sha512" } | null {
  const trimmed = input.trim();
  if (trimmed.toLowerCase().startsWith("otpauth://")) {
    try {
      const u = new URL(trimmed);
      const secret = u.searchParams.get("secret") ?? "";
      if (!isValidBase32(secret)) return null;
      const label = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
      const [issuerFromLabel, account] = label.includes(":") ? label.split(":", 2) : [undefined, label];
      const alg = (u.searchParams.get("algorithm") ?? "SHA1").toLowerCase();
      return { secret, issuer: u.searchParams.get("issuer") ?? issuerFromLabel, account, digits: Number(u.searchParams.get("digits") ?? 6), period: Number(u.searchParams.get("period") ?? 30), algorithm: alg === "sha256" ? "sha256" : alg === "sha512" ? "sha512" : "sha1" };
    } catch {
      return null;
    }
  }
  return isValidBase32(trimmed) ? { secret: trimmed.replace(/\s+/g, "").toUpperCase() } : null;
}
