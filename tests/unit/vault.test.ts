import { describe, expect, it, beforeAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, tasks, vaultAudit, vaultItems } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createUser } from "@/services/users";
import { generatePassword, openItem, passwordStrengthBits, rewrapItem, sealItem } from "@/lib/vault-crypto";
import { base32Decode, parseTotpInput, totp } from "@/lib/totp";
import { archiveVaultItem, createVaultItem, generateVaultReminders, getVaultItem, listVaultAudit, listVaultItems, resolveCapabilities, revealSecret, revokeGrant, rewrapAllItems, saveGrant, stepUpStatus, totpCode, updateVaultItem, verifyAuditChain, verifyStepUp, type VaultActor } from "@/services/vault";
import { ActionError } from "@/lib/action-result";

const PASSWORD = "Correct-Horse-9!";
let admin: VaultActor;
let tech: VaultActor;
let sales: VaultActor;
let acme: string;
let other: string;

async function mkActor(role: "admin" | "technician" | "sales", name: string): Promise<VaultActor> {
  const id = await createUser({ name, email: `${name.toLowerCase().replace(/\s+/g, ".")}@vault.test`, role, password: PASSWORD }, null);
  return { id, name, role, ipAddress: "203.0.113.5", userAgent: "vitest", sessionId: "s-1" };
}

beforeAll(async () => {
  admin = await mkActor("admin", "Vault Admin");
  tech = await mkActor("technician", "Tech One");
  sales = await mkActor("sales", "Sales Person");
  acme = await createCompany(companySchema.parse({ name: "Acme Vault Ltd" }), admin.id);
  other = await createCompany(companySchema.parse({ name: "Other Vault Co" }), admin.id);
});

describe("vault crypto", () => {
  it("seals and opens with per-item keys; ciphertext is bound to item and company", () => {
    const sealed = sealItem("item-1", "company-1", { v: 1, password: "p@ss" });
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.ciphertext).not.toContain("p@ss");
    expect(openItem("item-1", "company-1", sealed)).toEqual({ v: 1, password: "p@ss" });
    expect(() => openItem("item-1", "company-2", sealed)).toThrow();
    expect(() => openItem("item-2", "company-1", sealed)).toThrow();
    const tampered = { ...sealed, ciphertext: Buffer.from(Buffer.from(sealed.ciphertext, "base64").map((b, i) => (i === 40 ? b ^ 1 : b))).toString("base64") };
    expect(() => openItem("item-1", "company-1", tampered)).toThrow();
  });

  it("re-wraps a data key under a rotated master key without touching the blob", () => {
    const sealed = sealItem("item-r", "c", { v: 1, notes: "keep" });
    process.env.VAULT_MASTER_KEY_PREVIOUS = process.env.VAULT_MASTER_KEY;
    process.env.VAULT_MASTER_KEY_PREVIOUS_VERSION = "1";
    process.env.VAULT_MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
    process.env.VAULT_MASTER_KEY_VERSION = "2";
    try {
      const next = rewrapItem("item-r", sealed);
      expect(next.keyVersion).toBe(2);
      expect(next.ciphertext).toBe(sealed.ciphertext);
      expect(openItem("item-r", "c", next)).toEqual({ v: 1, notes: "keep" });
    } finally {
      process.env.VAULT_MASTER_KEY = process.env.VAULT_MASTER_KEY_PREVIOUS;
      process.env.VAULT_MASTER_KEY_VERSION = "1";
      delete process.env.VAULT_MASTER_KEY_PREVIOUS;
      delete process.env.VAULT_MASTER_KEY_PREVIOUS_VERSION;
    }
  });

  it("generates passwords with every selected class and estimates strength", () => {
    const pw = generatePassword({ length: 24 });
    expect(pw).toHaveLength(24);
    expect(pw).toMatch(/[a-z]/);
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[0-9]/);
    expect(pw).toMatch(/[^A-Za-z0-9]/);
    expect(generatePassword({ length: 12, symbols: false })).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(passwordStrengthBits(pw)).toBeGreaterThan(100);
    expect(new Set([generatePassword(), generatePassword(), generatePassword()]).size).toBe(3);
  });

  it("computes RFC 6238 test vectors and parses otpauth URIs", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    expect(totp(secret, { digits: 8, now: 59_000 }).code).toBe("94287082");
    expect(totp(secret, { digits: 8, now: 1_111_111_109_000 }).code).toBe("07081804");
    expect(totp(secret, { now: 59_000 }).code).toHaveLength(6);
    expect(parseTotpInput("otpauth://totp/Acme:admin@acme.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme&digits=6&period=30")).toMatchObject({ secret: "JBSWY3DPEHPK3PXP", issuer: "Acme", account: "admin@acme.com", digits: 6, period: 30, algorithm: "sha1" });
    expect(parseTotpInput("jbsw y3dp ehpk 3pxp")).toMatchObject({ secret: "JBSWY3DPEHPK3PXP" });
    expect(parseTotpInput("not base32!")).toBeNull();
  });
});

describe("vault service", () => {
  let itemId: string;

  it("capabilities: admin has all, technician nothing until granted, sales can never be granted", async () => {
    expect(await resolveCapabilities(admin.id, "admin", acme)).toMatchObject({ reveal: true, delete: true, audit: true });
    expect(await resolveCapabilities(tech.id, "technician", acme)).toMatchObject({ list: false, reveal: false });
    await expect(saveGrant(admin, { userId: sales.id, scope: "all", canList: true, canViewUsername: true, canReveal: true, canCopy: true, canCreate: false, canEdit: false, canDelete: false, canAudit: false })).rejects.toThrow(/cannot hold vault access/);
    await expect(saveGrant(tech, { userId: tech.id, scope: "all", canList: true, canViewUsername: true, canReveal: true, canCopy: true, canCreate: true, canEdit: true, canDelete: true, canAudit: true })).rejects.toThrow(/Only administrators/);
    // Company-scoped grant: list + username for Acme only, no reveal
    await saveGrant(admin, { userId: tech.id, scope: "company", companyId: acme, canList: true, canViewUsername: true, canReveal: false, canCopy: true, canCreate: false, canEdit: false, canDelete: false, canAudit: false });
    const caps = await resolveCapabilities(tech.id, "technician", acme);
    expect(caps).toMatchObject({ list: true, view_username: true, reveal: false, copy: false }); // copy cannot exceed reveal
    expect(await resolveCapabilities(tech.id, "technician", other)).toMatchObject({ list: false });
  });

  it("creates an item with secrets encrypted at rest, lists metadata only, masks usernames without the capability", async () => {
    itemId = await createVaultItem(admin, { companyId: acme, categoryId: "firewall", name: "Edge firewall", username: "admin", url: "https://192.168.1.1", tags: ["Core", "core", "hq"], reviewAt: "2027-01-01" }, { password: "FwPass-123", notes: "Serial ABC", totp: "JBSWY3DPEHPK3PXP", recoveryCodes: ["aaaa-bbbb", "cccc-dddd"], custom: [{ label: "Console PIN", value: "4321", secret: true }] });
    const [raw] = await db.select().from(vaultItems).where(eq(vaultItems.id, itemId));
    expect(raw.ciphertext).not.toMatch(/FwPass|Serial|JBSWY3DP|aaaa-bbbb|4321/);
    expect(raw.wrappedDek).not.toContain("FwPass");
    expect(raw.tags).toEqual(["core", "hq"]);
    expect(raw.secretKinds).toEqual(["password", "notes", "totp", "recovery_codes", "custom:1"]);
    const asAdmin = await listVaultItems(admin, acme);
    expect(asAdmin.items[0]).toMatchObject({ name: "Edge firewall", username: "admin", categoryName: "Firewall" });
    expect(JSON.stringify(asAdmin)).not.toContain("FwPass");
    await expect(createVaultItem(tech, { companyId: acme, categoryId: "server", name: "x" }, { password: "y" })).rejects.toThrow(/"create" permission/);
    await expect(listVaultItems(sales, acme)).rejects.toThrow(/"list" permission/);
    // A grant without view_username masks the username
    await saveGrant(admin, { userId: tech.id, scope: "company", companyId: acme, canList: true, canViewUsername: false, canReveal: false, canCopy: false, canCreate: false, canEdit: false, canDelete: false, canAudit: false }, (await db.select().from(sql`vault_grants`).then(() => db.execute(sql`select id from vault_grants where user_id = ${tech.id} and revoked_at is null limit 1`))).rows[0].id as string);
    expect((await listVaultItems(tech, acme)).items[0].username).toBe("••••••");
  });

  it("reveal needs the capability, a step-up, and is audited; wrong password is refused and audited", async () => {
    await expect(revealSecret(tech, itemId, "password")).rejects.toThrow(/"reveal" permission/);
    await expect(revealSecret(admin, itemId, "password")).rejects.toThrow("STEP_UP_REQUIRED");
    await expect(verifyStepUp(admin, "wrong-password")).rejects.toThrow(/not recognised/);
    expect((await stepUpStatus(admin.id)).verified).toBe(false);
    const s = await verifyStepUp(admin, PASSWORD);
    expect(s.verified).toBe(true);
    const r = await revealSecret(admin, itemId, "password");
    expect(r.value).toBe("FwPass-123");
    expect((await revealSecret(admin, itemId, "custom:0", "copy")).value).toBe("4321");
    expect((await revealSecret(admin, itemId, "recovery_codes")).value).toBe("aaaa-bbbb\ncccc-dddd");
    const code = await totpCode(admin, itemId);
    expect(code.code).toMatch(/^\d{6}$/);
    const [row] = await db.select().from(vaultItems).where(eq(vaultItems.id, itemId));
    expect(row.revealCount).toBe(3);
    const history = await listVaultAudit(admin, { companyId: acme, itemId });
    expect(history.rows.map((h) => h.action)).toEqual(expect.arrayContaining(["created", "revealed", "copied", "totp_code"]));
    const revealed = history.rows.find((h) => h.action === "revealed" && h.field === "password")!;
    expect(revealed).toMatchObject({ field: "password", ipAddress: "203.0.113.5", userAgent: "vitest", actorName: "Vault Admin" });
    expect(JSON.stringify(history)).not.toContain("FwPass");
    const stepFail = (await listVaultAudit(admin, { actorUserId: admin.id, action: "step_up_failed" })).total;
    expect(stepFail).toBeGreaterThanOrEqual(1);
  });

  it("update keeps untouched secrets, replaces provided ones, clears on request, and records only field names", async () => {
    await updateVaultItem(admin, itemId, { categoryId: "firewall", name: "Edge firewall (HQ)", username: "admin", tags: ["hq"] }, { notes: "Serial XYZ", clear: ["recovery_codes"] });
    expect((await revealSecret(admin, itemId, "password")).value).toBe("FwPass-123");
    expect((await revealSecret(admin, itemId, "notes")).value).toBe("Serial XYZ");
    expect((await revealSecret(admin, itemId, "recovery_codes")).value).toBe("");
    const [row] = await db.select().from(vaultItems).where(eq(vaultItems.id, itemId));
    expect(row.secretKinds).toEqual(["password", "notes", "totp", "custom:1"]);
    const mod = (await listVaultAudit(admin, { companyId: acme, itemId, action: "modified" })).rows[0];
    expect(mod.details).toMatchObject({ metadataChanged: expect.arrayContaining(["name", "tags"]), secretsChanged: ["notes", "recovery_codes"] });
    expect(JSON.stringify(mod.details)).not.toContain("XYZ");
  });

  it("archived items cannot be revealed; restore brings them back; delete needs the capability", async () => {
    await expect(archiveVaultItem(tech, itemId)).rejects.toThrow(/"delete" permission/);
    await archiveVaultItem(admin, itemId);
    await expect(revealSecret(admin, itemId, "password")).rejects.toThrow(/archived/);
    expect((await listVaultItems(admin, acme)).items).toHaveLength(0);
    expect((await listVaultItems(admin, acme, { includeArchived: true })).items).toHaveLength(1);
    await archiveVaultItem(admin, itemId, true);
    expect((await getVaultItem(admin, itemId)).archivedAt).toBeNull();
  });

  it("the audit chain verifies, the table refuses updates and deletes, and a forged row is detected", async () => {
    const before = await verifyAuditChain(admin);
    expect(before.ok).toBe(true);
    expect(before.checked).toBeGreaterThan(5);
    const firstAction = (await db.execute(sql`select action from vault_audit order by id limit 1`)).rows[0].action;
    await expect(db.execute(sql`update vault_audit set action = 'x' where id = (select min(id) from vault_audit)`)).rejects.toThrow();
    await expect(db.execute(sql`delete from vault_audit where id = (select min(id) from vault_audit)`)).rejects.toThrow();
    expect((await db.execute(sql`select action from vault_audit order by id limit 1`)).rows[0].action).toBe(firstAction);
    // Someone with raw DB access appends a row with a made-up hash: the chain breaks at that row.
    const [{ id: forgedId }] = await db.insert(vaultAudit).values({ action: "revealed", actorUserId: "forged", prevHash: "deadbeef", hash: "deadbeef" }).returning({ id: vaultAudit.id });
    const after = await verifyAuditChain();
    expect(after.ok).toBe(false);
    expect(after.brokenAt).toBe(forgedId);
  });

  it("reveal rate limit blocks further reveals and raises an admin task", async () => {
    await db.update(appSettings).set({ vaultRevealLimit: 2 }).where(eq(appSettings.id, 1));
    const limited = await mkActor("admin", "Limit Admin");
    await verifyStepUp(limited, PASSWORD);
    const fresh = await createVaultItem(limited, { companyId: other, categoryId: "server", name: "DC01" }, { password: "one" });
    await revealSecret(limited, fresh, "password");
    await revealSecret(limited, fresh, "password");
    await expect(revealSecret(limited, fresh, "password")).rejects.toThrow(/Reveal limit reached/);
    const alert = await db.select().from(tasks).where(sql`${tasks.sourceKey} like 'vault-ratelimit:%'`);
    expect(alert.length).toBe(1);
    expect(alert[0].priority).toBe("urgent");
    await db.update(appSettings).set({ vaultRevealLimit: 60 }).where(eq(appSettings.id, 1));
  });

  it("review and expiry reminders create tasks once; revoked grants stop access; re-wrap is a no-op on the current key", async () => {
    const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const id = await createVaultItem(admin, { companyId: acme, categoryId: "domain_dns", name: "Registrar", expiresAt: soon }, { password: "x" });
    const r1 = await generateVaultReminders();
    expect(r1.created).toBeGreaterThanOrEqual(1);
    const r2 = await generateVaultReminders();
    expect(r2.created).toBe(0);
    const [t] = await db.select().from(tasks).where(eq(tasks.sourceKey, `vault-review:${id}:${soon}`));
    expect(t.title).toMatch(/Credential expires: Registrar/);
    const grants = await db.execute(sql`select id from vault_grants where user_id = ${tech.id} and revoked_at is null`);
    for (const g of grants.rows) await revokeGrant(admin, g.id as string);
    expect(await resolveCapabilities(tech.id, "technician", acme)).toMatchObject({ list: false });
    expect(await rewrapAllItems(admin)).toMatchObject({ rewrapped: 0, keyVersion: 1 });
  });

  it("errors never carry secrets", async () => {
    try {
      await createVaultItem(admin, { companyId: acme, categoryId: "other", name: "bad totp" }, { totp: "not base32!!" });
      throw new Error("should have failed");
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as Error).message).not.toContain("not base32!!");
    }
  });
});
