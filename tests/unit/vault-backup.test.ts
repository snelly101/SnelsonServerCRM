import { describe, expect, it, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { eq, and, like } from "drizzle-orm";
import Papa from "papaparse";
import { db } from "@/db";
import { tasks, vaultAudit, vaultItems } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createUser } from "@/services/users";
import { buildZip, crc32 } from "@/lib/zip";
import { openWithPassphrase, sealWithPassphrase } from "@/lib/vault-crypto";
import { archiveVaultItem, createVaultItem, revealSecret, verifyStepUp, type VaultActor } from "@/services/vault";
import { backupToCsv, exportRateStatus, exportVault, importVaultBackup, EXPORT_ACKNOWLEDGEMENT, IMPORT_ACKNOWLEDGEMENT, type BackupDocument } from "@/services/vault-backup";

const PASSWORD = "Backup-Horse-77!";
let admin: VaultActor;
let admin2: VaultActor;
let tech: VaultActor;
let acme: string;

async function mkActor(role: "admin" | "technician", name: string): Promise<VaultActor> {
  const id = await createUser({ name, email: `${name.toLowerCase().replace(/\s+/g, ".")}@backup.test`, role, password: PASSWORD }, null);
  return { id, name, role, ipAddress: "203.0.113.9", userAgent: "vitest", sessionId: "s-b" };
}

/** Reads a stored/deflated zip built by buildZip back into {name: content}. */
function readZip(buf: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const csize = buf.readUInt32LE(off + 18);
    const nlen = buf.readUInt16LE(off + 26);
    const xlen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nlen).toString("utf8");
    const start = off + 30 + nlen + xlen;
    const body = buf.subarray(start, start + csize);
    out[name] = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    off = start + csize;
  }
  return out;
}

beforeAll(async () => {
  admin = await mkActor("admin", "Backup Admin");
  admin2 = await mkActor("admin", "Second Admin");
  tech = await mkActor("technician", "Backup Tech");
  acme = await createCompany(companySchema.parse({ name: "Backup Customer Ltd" }), admin.id);
});

describe("zip writer", () => {
  it("produces a valid archive that unzip and a reader agree on", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    const zip = buildZip([
      { name: "a.txt", data: "hello hello hello hello hello hello" },
      { name: "dir/b.bin", data: Buffer.from([1, 2, 3]) },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const files = readZip(zip);
    expect(files["a.txt"].toString()).toBe("hello hello hello hello hello hello");
    expect([...files["dir/b.bin"]]).toEqual([1, 2, 3]);
    // Cross-check with the system unzip when present.
    try {
      const dir = mkdtempSync(join(tmpdir(), "zip-"));
      writeFileSync(join(dir, "t.zip"), zip);
      const listing = execFileSync("unzip", ["-t", join(dir, "t.zip")], { encoding: "utf8" });
      expect(listing).toMatch(/No errors detected/);
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if (!(e instanceof Error && /ENOENT/.test(e.message))) throw e;
    }
  });
});

describe("passphrase-protected file", () => {
  it("round-trips and rejects a wrong passphrase", () => {
    const plain = Buffer.from("top secret backup bytes");
    const sealed = sealWithPassphrase(plain, "correct horse battery staple");
    expect(sealed.subarray(0, 8).toString()).toBe("Salted__");
    expect(sealed.includes(plain)).toBe(false);
    expect(openWithPassphrase(sealed, "correct horse battery staple").equals(plain)).toBe(true);
    expect(() => openWithPassphrase(sealed, "wrong passphrase here")).toThrow();
    expect(() => sealWithPassphrase(plain, "short")).toThrow(/12 characters/);
  });

  it("is readable by the documented openssl command", () => {
    const plain = Buffer.from("openssl compatible payload");
    const sealed = sealWithPassphrase(plain, "a-long-enough-passphrase");
    try {
      const dir = mkdtempSync(join(tmpdir(), "enc-"));
      writeFileSync(join(dir, "f.enc"), sealed);
      execFileSync("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "600000", "-md", "sha256", "-in", join(dir, "f.enc"), "-out", join(dir, "f"), "-pass", "pass:a-long-enough-passphrase"]);
      expect(readFileSync(join(dir, "f")).equals(plain)).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if (!(e instanceof Error && /ENOENT/.test(e.message))) throw e;
    }
  });
});

describe("vault export", () => {
  let liveId: string;
  let archivedId: string;
  let exported: BackupDocument;

  beforeAll(async () => {
    liveId = await createVaultItem(admin, { companyId: acme, categoryId: "microsoft_365", name: "Global admin", username: "admin@backup.test", url: "https://portal.office.com", tags: ["m365", "tenant"], reviewAt: "2027-01-01" }, { password: "Pa55-live", totp: "JBSWY3DPEHPK3PXP", recoveryCodes: ["aaaa-bbbb", "cccc-dddd"], notes: "break glass, line two" });
    archivedId = await createVaultItem(admin, { companyId: acme, categoryId: "router", name: "Old router", username: "root" }, { password: "Pa55-old", apiKey: "key-123", custom: [{ label: "Serial", value: "SN-1", secret: false }] });
    await archiveVaultItem(admin, archivedId);
  });

  it("refuses non-admins, a stale step-up, a wrong acknowledgement and a thin reason", async () => {
    await verifyStepUp(admin, PASSWORD);
    await expect(exportVault(tech, { reason: "testing export", acknowledgement: EXPORT_ACKNOWLEDGEMENT })).rejects.toThrow(/Only administrators/);
    await expect(exportVault(admin, { reason: "testing export", acknowledgement: "export" })).rejects.toThrow(/Type "EXPORT ALL SECRETS"/);
    await expect(exportVault(admin, { reason: "ok", acknowledgement: EXPORT_ACKNOWLEDGEMENT })).rejects.toThrow(/reason/);
    await expect(exportVault(admin, { reason: "testing export", acknowledgement: EXPORT_ACKNOWLEDGEMENT, passphrase: "short" })).rejects.toThrow(/12 characters/);
    await expect(exportVault(admin2, { reason: "no password confirmed", acknowledgement: EXPORT_ACKNOWLEDGEMENT })).rejects.toThrow("STEP_UP_REQUIRED");
  });

  it("decrypts every item including archived ones into CSV + JSON, audits with hash, notifies the other admin", async () => {
    await verifyStepUp(admin, PASSWORD);
    const r = await exportVault(admin, { reason: "quarterly offline backup", acknowledgement: EXPORT_ACKNOWLEDGEMENT });
    expect(r.encrypted).toBe(false);
    expect(r.filename).toMatch(/^vault-backup-\d{8}T\d{6}\.zip$/);
    expect(r.items).toBeGreaterThanOrEqual(2);
    expect(r.archived).toBeGreaterThanOrEqual(1);
    expect(r.failed).toBe(0);
    expect(r.sha256).toBe(createHash("sha256").update(r.body).digest("hex"));

    const files = readZip(r.body);
    expect(Object.keys(files).sort()).toEqual(["README.txt", "vault-backup.csv", "vault-backup.json"]);
    exported = JSON.parse(files["vault-backup.json"].toString("utf8")) as BackupDocument;
    expect(exported.format).toBe("snelson-crm-vault-backup");
    const live = exported.items.find((i) => i.id === liveId)!;
    expect(live).toMatchObject({ company: "Backup Customer Ltd", category: "Microsoft 365", username: "admin@backup.test", tags: ["m365", "tenant"], reviewAt: "2027-01-01", archivedAt: null });
    expect(live.secrets).toMatchObject({ password: "Pa55-live", notes: "break glass, line two", recovery_codes: ["aaaa-bbbb", "cccc-dddd"] });
    expect(live.secrets.totp?.secret).toBe("JBSWY3DPEHPK3PXP");
    const old = exported.items.find((i) => i.id === archivedId)!;
    expect(old.archivedAt).toBeTruthy();
    expect(old.secrets).toMatchObject({ password: "Pa55-old", api_key: "key-123" });

    const csv = files["vault-backup.csv"].toString("utf8").replace(/^﻿/, "");
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const row = parsed.data.find((x) => x.id === liveId)!;
    expect(row).toMatchObject({ company: "Backup Customer Ltd", name: "Global admin", password: "Pa55-live", totp_secret: "JBSWY3DPEHPK3PXP", recovery_codes: "aaaa-bbbb\ncccc-dddd", tags: "m365, tenant", archived_at: "" });
    expect(row.totp_uri).toMatch(/^otpauth:\/\/totp\/.*secret=JBSWY3DPEHPK3PXP/);
    const oldRow = parsed.data.find((x) => x.id === archivedId)!;
    expect(oldRow.archived_at).not.toBe("");
    expect(oldRow.custom_fields).toContain("SN-1");

    // Audit row carries count + hash + reason, never a secret.
    const [row2] = await db.select().from(vaultAudit).where(and(eq(vaultAudit.action, "exported"), eq(vaultAudit.actorUserId, admin.id))).orderBy(vaultAudit.id);
    expect(row2.details).toMatchObject({ sha256: r.sha256, encrypted: false, reason: "quarterly offline backup" });
    expect(Number(row2.details?.items)).toBe(r.items);
    expect(JSON.stringify(row2.details)).not.toContain("Pa55-live");
    // Urgent task for the other administrator, not the exporter.
    const alerts = await db.select().from(tasks).where(like(tasks.title, "Vault exported in clear by Backup Admin%"));
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts.some((t) => t.ownerUserId === admin2.id && t.priority === "urgent")).toBe(true);
    expect(alerts.some((t) => t.ownerUserId === admin.id)).toBe(false);
    expect(alerts[0].description).toContain(r.sha256);
    expect(alerts[0].description).not.toContain("Pa55-live");
    expect(r.notified).toBe(1);
  });

  it("wraps the zip with a passphrase when asked, then hits the hourly limit", async () => {
    await verifyStepUp(admin, PASSWORD);
    const r = await exportVault(admin, { reason: "encrypted copy for the safe", acknowledgement: EXPORT_ACKNOWLEDGEMENT, passphrase: "safe-passphrase-2026" });
    expect(r.encrypted).toBe(true);
    expect(r.filename).toMatch(/\.zip\.enc$/);
    expect(r.body.subarray(0, 8).toString()).toBe("Salted__");
    const zip = openWithPassphrase(r.body, "safe-passphrase-2026");
    expect(createHash("sha256").update(zip).digest("hex")).toBe(r.sha256);
    expect(readZip(zip)["vault-backup.json"].toString()).toContain("Pa55-live");

    const status = await exportRateStatus();
    expect(status.usedThisHour).toBe(2);
    expect(status.allowed).toBe(false);
    expect(status.last?.encrypted).toBe(true);
    await expect(exportVault(admin, { reason: "one too many", acknowledgement: EXPORT_ACKNOWLEDGEMENT })).rejects.toThrow(/limit reached/);
  });

  it("imports a backup: skips existing ids, recreates missing items (and company) with working secrets", async () => {
    const json = JSON.stringify(exported);
    await verifyStepUp(admin, PASSWORD);
    await expect(importVaultBackup(tech, { json, reason: "restore test", acknowledgement: IMPORT_ACKNOWLEDGEMENT })).rejects.toThrow(/Only administrators/);
    await expect(importVaultBackup(admin, { json, reason: "restore test", acknowledgement: "nope" })).rejects.toThrow(/Type "IMPORT BACKUP"/);
    await expect(importVaultBackup(admin, { json: "{not json", reason: "restore test", acknowledgement: IMPORT_ACKNOWLEDGEMENT })).rejects.toThrow(/not valid JSON/);
    await expect(importVaultBackup(admin, { json: JSON.stringify({ format: "other", version: 1, items: [] }), reason: "restore test", acknowledgement: IMPORT_ACKNOWLEDGEMENT })).rejects.toThrow(/not a vault backup/);

    // Everything already present → all skipped.
    const first = await importVaultBackup(admin, { json, reason: "restore test, nothing new", acknowledgement: IMPORT_ACKNOWLEDGEMENT });
    expect(first.created).toBe(0);
    expect(first.skipped).toBe(exported.items.length);

    // Simulate a lost item and a lost customer: delete the live item, point the archived one at a company that does not exist.
    await db.delete(vaultItems).where(eq(vaultItems.id, liveId));
    const doc: BackupDocument = { ...exported, items: exported.items.filter((i) => i.id === liveId || i.id === archivedId).map((i) => (i.id === archivedId ? { ...i, id: "11111111-2222-4333-8444-555555555555", company: "Brand New Co", companyId: "00000000-0000-4000-8000-000000000000", categoryId: "legacy_kit", category: "Legacy kit" } : i)) };
    const second = await importVaultBackup(admin, { json: JSON.stringify(doc), reason: "restore after key loss", acknowledgement: IMPORT_ACKNOWLEDGEMENT });
    expect(second).toMatchObject({ created: 2, skipped: 0, companiesCreated: 1, categoriesCreated: 1, errors: [] });

    // The restored item decrypts under the current key with the same id and metadata.
    const [restored] = await db.select().from(vaultItems).where(eq(vaultItems.id, liveId));
    expect(restored).toMatchObject({ companyId: acme, name: "Global admin", username: "admin@backup.test", categoryId: "microsoft_365", archivedAt: null });
    expect(restored.secretKinds).toEqual(expect.arrayContaining(["password", "totp", "recovery_codes", "notes"]));
    const reveal = await revealSecret(admin, liveId, "password");
    expect(reveal.value).toBe("Pa55-live");
    const [moved] = await db.select().from(vaultItems).where(eq(vaultItems.id, "11111111-2222-4333-8444-555555555555"));
    expect(moved.archivedAt).toBeTruthy();
    expect(moved.categoryId).toBe("legacy_kit");

    const [auditRow] = await db.select().from(vaultAudit).where(and(eq(vaultAudit.action, "imported"), eq(vaultAudit.actorUserId, admin.id))).orderBy(vaultAudit.id);
    expect(auditRow.details).toMatchObject({ created: 0, skipped: exported.items.length });
    expect(JSON.stringify(auditRow.details)).not.toContain("Pa55");
  });

  it("CSV helper escapes multi-line notes and commas", () => {
    const csv = backupToCsv([{ id: "x", company: "A, B Ltd", companyId: "c", site: null, category: "Other", categoryId: "other", name: "N", username: null, url: null, reference: null, tags: [], favourite: false, reviewAt: null, expiresAt: null, archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastRevealedAt: null, revealCount: 0, secrets: { v: 1, notes: 'line "one"\nline two' } }]);
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true });
    expect(parsed.data[0].company).toBe("A, B Ltd");
    expect(parsed.data[0].notes).toBe('line "one"\nline two');
  });
});
