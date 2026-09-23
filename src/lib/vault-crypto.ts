import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Envelope encryption for Secure Vault items.
 *
 *  - KEK: VAULT_MASTER_KEY (32 bytes, base64), separate from APP_ENCRYPTION_KEY.
 *  - Each item has its own random DEK. The item's JSON document is encrypted
 *    with the DEK (AES-256-GCM); the DEK is wrapped with the KEK (AES-256-GCM).
 *  - AAD binds the ciphertext to the item id, company id and cipher version so
 *    a ciphertext copied onto another row fails to decrypt.
 *  - Rotation: re-wrap every DEK with a new KEK; blobs are untouched.
 *
 * Only Node's crypto primitives are used. Buffers holding keys and plaintext
 * are zeroed after use. Nothing here logs.
 */
export const VAULT_CIPHER_VERSION = 1;

type Wire = { nonce: Buffer; tag: Buffer; ct: Buffer };

function decodeKey(raw: string | undefined, name: string): Buffer {
  if (!raw) throw new VaultKeyError(`${name} is not set`);
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new VaultKeyError(`${name} must decode to 32 bytes`);
  return key;
}

export class VaultKeyError extends Error {}

/** Current master key and its version. Loaded on each call and zeroed by the caller; never cached as a string. */
export function currentMasterKey(): { key: Buffer; version: number } {
  const version = Number(process.env.VAULT_MASTER_KEY_VERSION ?? 1);
  return { key: decodeKey(process.env.VAULT_MASTER_KEY, "VAULT_MASTER_KEY"), version: Number.isFinite(version) && version > 0 ? version : 1 };
}

/** The previous master key during rotation (VAULT_MASTER_KEY_PREVIOUS), if configured. */
export function previousMasterKey(): { key: Buffer; version: number } | null {
  if (!process.env.VAULT_MASTER_KEY_PREVIOUS) return null;
  const version = Number(process.env.VAULT_MASTER_KEY_PREVIOUS_VERSION ?? 0);
  return { key: decodeKey(process.env.VAULT_MASTER_KEY_PREVIOUS, "VAULT_MASTER_KEY_PREVIOUS"), version };
}

export function vaultConfigured() {
  return Boolean(process.env.VAULT_MASTER_KEY);
}

/** sha256 of the key bytes, hex. Stored in vault_keys so a wrong key is detected before any decrypt attempt. */
export function keyFingerprint(key: Buffer) {
  return createHash("sha256").update(key).digest("hex");
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ct]);
}

function open(key: Buffer, wire: Buffer, aad: Buffer): Buffer {
  if (wire.length < 28) throw new Error("Ciphertext too short");
  const w: Wire = { nonce: wire.subarray(0, 12), tag: wire.subarray(12, 28), ct: wire.subarray(28) };
  const decipher = createDecipheriv("aes-256-gcm", key, w.nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(w.tag);
  return Buffer.concat([decipher.update(w.ct), decipher.final()]);
}

export function itemAad(itemId: string, companyId: string, cipherVersion = VAULT_CIPHER_VERSION) {
  return Buffer.from(`vault:${itemId}:${companyId}:${cipherVersion}`, "utf8");
}

const dekAad = (itemId: string, keyVersion: number) => Buffer.from(`vault-dek:${itemId}:${keyVersion}`, "utf8");

export type SealedItem = { wrappedDek: string; ciphertext: string; keyVersion: number; cipherVersion: number };

/** Encrypts a secret document for an item with a fresh DEK wrapped by the current master key. */
export function sealItem(itemId: string, companyId: string, document: Record<string, unknown>): SealedItem {
  const { key: kek, version } = currentMasterKey();
  const dek = randomBytes(32);
  const plaintext = Buffer.from(JSON.stringify(document), "utf8");
  try {
    const ciphertext = seal(dek, plaintext, itemAad(itemId, companyId));
    const wrappedDek = seal(kek, dek, dekAad(itemId, version));
    return { wrappedDek: wrappedDek.toString("base64"), ciphertext: ciphertext.toString("base64"), keyVersion: version, cipherVersion: VAULT_CIPHER_VERSION };
  } finally {
    dek.fill(0);
    kek.fill(0);
    plaintext.fill(0);
  }
}

function masterKeyFor(version: number): Buffer {
  const cur = currentMasterKey();
  if (cur.version === version) return cur.key;
  cur.key.fill(0);
  const prev = previousMasterKey();
  if (prev && prev.version === version) return prev.key;
  if (prev) prev.key.fill(0);
  throw new VaultKeyError(`No master key available for key version ${version}`);
}

/** Decrypts an item's secret document. Throws on any tampering or wrong key. */
export function openItem(itemId: string, companyId: string, sealed: SealedItem): Record<string, unknown> {
  const kek = masterKeyFor(sealed.keyVersion);
  let dek: Buffer | null = null;
  let plaintext: Buffer | null = null;
  try {
    dek = open(kek, Buffer.from(sealed.wrappedDek, "base64"), dekAad(itemId, sealed.keyVersion));
    plaintext = open(dek, Buffer.from(sealed.ciphertext, "base64"), itemAad(itemId, companyId, sealed.cipherVersion));
    return JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
  } finally {
    kek.fill(0);
    dek?.fill(0);
    plaintext?.fill(0);
  }
}

/** Re-wraps an item's DEK with the current master key without touching the blob. */
export function rewrapItem(itemId: string, sealed: SealedItem): SealedItem {
  const oldKek = masterKeyFor(sealed.keyVersion);
  const { key: newKek, version } = currentMasterKey();
  let dek: Buffer | null = null;
  try {
    dek = open(oldKek, Buffer.from(sealed.wrappedDek, "base64"), dekAad(itemId, sealed.keyVersion));
    const wrappedDek = seal(newKek, dek, dekAad(itemId, version));
    return { ...sealed, wrappedDek: wrappedDek.toString("base64"), keyVersion: version };
  } finally {
    oldKek.fill(0);
    newKek.fill(0);
    dek?.fill(0);
  }
}

/** Server-side password generator (CSPRNG, unbiased selection). */
export function generatePassword(opts: { length?: number; upper?: boolean; lower?: boolean; digits?: boolean; symbols?: boolean; excludeAmbiguous?: boolean } = {}) {
  const length = Math.min(128, Math.max(8, opts.length ?? 20));
  let alphabet = "";
  const sets: string[] = [];
  const add = (s: string) => {
    alphabet += s;
    sets.push(s);
  };
  const strip = (s: string) => (opts.excludeAmbiguous ? s.replace(/[O0Il1|`'"]/g, "") : s);
  if (opts.lower !== false) add(strip("abcdefghijklmnopqrstuvwxyz"));
  if (opts.upper !== false) add(strip("ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
  if (opts.digits !== false) add(strip("0123456789"));
  if (opts.symbols !== false) add(strip("!@#$%^&*()-_=+[]{};:,.?/~"));
  if (!alphabet) throw new Error("No character classes selected");
  const pick = (from: string) => {
    // rejection sampling to avoid modulo bias
    const max = Math.floor(256 / from.length) * from.length;
    for (;;) {
      const b = randomBytes(1)[0];
      if (b < max) return from[b % from.length];
    }
  };
  const out: string[] = [];
  for (const s of sets) out.push(pick(s)); // guarantee one of each selected class
  while (out.length < length) out.push(pick(alphabet));
  // Fisher–Yates with CSPRNG
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32BE(0) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

/** Rough strength estimate (bits of entropy from the character classes used). */
export function passwordStrengthBits(pw: string) {
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  return pool ? Math.round(pw.length * Math.log2(pool)) : 0;
}

export function constantTimeEquals(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
