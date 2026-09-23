import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import { db, type Tx } from "@/db";
import { account, appSettings, companies, user, vaultAudit, vaultCategories, vaultGrants, vaultItems, vaultKeys, vaultStepUps } from "@/db/schema";
import { audit, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { can, type Role } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { setSystemStatus } from "@/lib/system-status";
import { currentMasterKey, keyFingerprint, openItem, rewrapItem, sealItem, vaultConfigured, VaultKeyError, type SealedItem } from "@/lib/vault-crypto";
import { parseTotpInput, totp } from "@/lib/totp";
import { createTask } from "./tasks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type VaultActor = { id: string; name: string; role: Role; ipAddress?: string | null; userAgent?: string | null; sessionId?: string | null };
export type VaultCapability = "list" | "view_username" | "reveal" | "copy" | "create" | "edit" | "delete" | "audit";
export type VaultCapabilities = Record<VaultCapability, boolean>;
export const VAULT_CAPABILITIES: VaultCapability[] = ["list", "view_username", "reveal", "copy", "create", "edit", "delete", "audit"];

/** Secret document stored inside the encrypted blob. Additive: new kinds never need a schema change. */
export type VaultSecrets = {
  v: 1;
  password?: string;
  notes?: string;
  totp?: { secret: string; issuer?: string; account?: string; digits?: number; period?: number; algorithm?: "sha1" | "sha256" | "sha512" };
  recovery_codes?: string[];
  api_key?: string;
  custom?: { label: string; value: string; secret: boolean }[];
};
export type SecretField = "password" | "notes" | "api_key" | "recovery_codes" | "totp_secret" | `custom:${number}`;

export type VaultItemInput = { companyId: string; siteId?: string | null; categoryId: string; name: string; username?: string | null; url?: string | null; reference?: string | null; tags?: string[]; isFavourite?: boolean; reviewAt?: string | null; expiresAt?: string | null };
export type VaultSecretPatch = { password?: string | null; notes?: string | null; totp?: string | null; recoveryCodes?: string[] | null; apiKey?: string | null; custom?: { label: string; value: string; secret: boolean }[] | null; clear?: ("password" | "notes" | "totp" | "recovery_codes" | "api_key")[] };

const NONE: VaultCapabilities = { list: false, view_username: false, reveal: false, copy: false, create: false, edit: false, delete: false, audit: false };
const ALL: VaultCapabilities = { list: true, view_username: true, reveal: true, copy: true, create: true, edit: true, delete: true, audit: true };

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------
/** Resolves what a user may do in a company's vault: role gate, then the union of active grants (all-scope or that company). */
export async function resolveCapabilities(userId: string, role: Role, companyId?: string | null): Promise<VaultCapabilities> {
  if (role === "admin") return { ...ALL };
  if (!can(role, "vault.use")) return { ...NONE };
  const now = new Date();
  const rows = await db
    .select()
    .from(vaultGrants)
    .where(and(eq(vaultGrants.userId, userId), isNull(vaultGrants.revokedAt), or(isNull(vaultGrants.expiresAt), gte(vaultGrants.expiresAt, now)), companyId ? or(eq(vaultGrants.scope, "all"), eq(vaultGrants.companyId, companyId)) : eq(vaultGrants.scope, "all")));
  const caps = { ...NONE };
  for (const g of rows) {
    caps.list ||= g.canList;
    caps.view_username ||= g.canViewUsername;
    caps.reveal ||= g.canReveal;
    caps.copy ||= g.canCopy;
    caps.create ||= g.canCreate;
    caps.edit ||= g.canEdit;
    caps.delete ||= g.canDelete;
    caps.audit ||= g.canAudit;
  }
  // Implications: reveal ⇒ view_username ⇒ list; copy ⇒ reveal; edit/create/delete/audit ⇒ list
  if (caps.copy) caps.reveal = true;
  if (caps.reveal) caps.view_username = true;
  if (caps.view_username || caps.create || caps.edit || caps.delete || caps.audit) caps.list = true;
  return caps;
}

/** True when the user could see a vault anywhere (used to decide whether to render navigation). */
export async function hasAnyVaultAccess(userId: string, role: Role) {
  if (role === "admin") return true;
  if (!can(role, "vault.use")) return false;
  const [g] = await db.select({ id: vaultGrants.id }).from(vaultGrants).where(and(eq(vaultGrants.userId, userId), isNull(vaultGrants.revokedAt), or(isNull(vaultGrants.expiresAt), gte(vaultGrants.expiresAt, new Date())))).limit(1);
  return Boolean(g);
}

export async function requireCapability(actor: VaultActor, companyId: string, cap: VaultCapability) {
  const caps = await resolveCapabilities(actor.id, actor.role, companyId);
  if (!caps[cap]) throw new ActionError(`You do not have the "${cap.replace("_", " ")}" permission for this customer's vault.`);
  return caps;
}

function requireVaultAdmin(actor: VaultActor) {
  if (!can(actor.role, "vault.admin")) throw new ActionError("Only administrators can manage the vault.");
}

// ---------------------------------------------------------------------------
// Master key bookkeeping
// ---------------------------------------------------------------------------
export function assertVaultConfigured() {
  if (!vaultConfigured()) throw new ActionError("The Secure Vault is not configured on this server (VAULT_MASTER_KEY is missing).");
}

/** Records the current key version's fingerprint, and refuses to run with a different key under the same version number. */
export async function ensureKeyVersion() {
  const { key, version } = currentMasterKey();
  const fp = keyFingerprint(key);
  key.fill(0);
  const [row] = await db.select().from(vaultKeys).where(eq(vaultKeys.keyVersion, version)).limit(1);
  if (!row) {
    await db.insert(vaultKeys).values({ keyVersion: version, fingerprint: fp }).onConflictDoNothing();
    return version;
  }
  if (row.fingerprint !== fp) throw new VaultKeyError(`VAULT_MASTER_KEY does not match the key recorded for version ${version}. If you rotated the key, increase VAULT_MASTER_KEY_VERSION.`);
  return version;
}

export async function vaultHealth() {
  const configured = vaultConfigured();
  let keyMatches: boolean | null = null;
  let version: number | null = null;
  if (configured) {
    try {
      version = await ensureKeyVersion();
      keyMatches = true;
    } catch {
      keyMatches = false;
    }
  }
  const [{ items }] = await db.select({ items: sql<number>`count(*)`.mapWith(Number) }).from(vaultItems).where(isNull(vaultItems.archivedAt));
  return { configured, keyMatches, keyVersion: version, items };
}

// ---------------------------------------------------------------------------
// Audit trail (append-only, hash-chained)
// ---------------------------------------------------------------------------
export type VaultAuditAction = "created" | "viewed" | "revealed" | "copied" | "totp_code" | "modified" | "archived" | "restored" | "grant_changed" | "grant_revoked" | "category_changed" | "step_up_succeeded" | "step_up_failed" | "rate_limited" | "rewrapped" | "chain_verified";

const GENESIS = "0".repeat(64);

/** Stable JSON: object keys sorted recursively, so a jsonb round-trip (which reorders keys) hashes identically. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

function chainHash(prevHash: string, row: { at: Date; actorUserId: string | null; companyId: string | null; itemId: string | null; action: string; field: string | null; ipAddress: string | null; details: Record<string, unknown> | null }) {
  const canonical = canonicalJson([row.at.toISOString(), row.actorUserId, row.companyId, row.itemId, row.action, row.field, row.ipAddress, row.details ?? null]);
  return createHash("sha256").update(prevHash).update("|").update(canonical).digest("hex");
}

/** Writes one immutable audit row inside a transaction-scoped advisory lock so the chain never forks. Never call with a secret in `details`. */
export async function writeVaultAudit(actor: VaultActor | null, entry: { action: VaultAuditAction; companyId?: string | null; itemId?: string | null; itemName?: string | null; field?: string | null; details?: Record<string, unknown> | null }, tx?: Tx) {
  const run = async (t: Tx) => {
    await t.execute(sql`select pg_advisory_xact_lock(hashtext('vault_audit'))`);
    const [last] = await t.select({ hash: vaultAudit.hash }).from(vaultAudit).orderBy(desc(vaultAudit.id)).limit(1);
    const prevHash = last?.hash ?? GENESIS;
    const at = new Date();
    const row = { at, actorUserId: actor?.id ?? null, companyId: entry.companyId ?? null, itemId: entry.itemId ?? null, action: entry.action, field: entry.field ?? null, ipAddress: actor?.ipAddress ?? null, details: entry.details ?? null };
    await t.insert(vaultAudit).values({ ...row, actorName: actor?.name ?? null, itemName: entry.itemName ?? null, userAgent: actor?.userAgent ?? null, sessionId: actor?.sessionId ?? null, prevHash, hash: chainHash(prevHash, row) });
    // Also surface in the general audit log (Settings → Audit), scrubbed there too.
    await audit({ actorUserId: actor?.id ?? null, action: `vault.${entry.action}`, entityType: "vault_item", entityId: entry.itemId ?? entry.companyId ?? null, details: { field: entry.field ?? undefined, item: entry.itemName ?? undefined, ...(entry.details ?? {}) }, ipAddress: actor?.ipAddress ?? null }, t);
  };
  if (tx) return run(tx);
  return db.transaction(run);
}

/** Recomputes every hash from genesis. Returns the first broken row id, if any. */
export async function verifyAuditChain(actor?: VaultActor | null) {
  const rows = await db.select().from(vaultAudit).orderBy(asc(vaultAudit.id));
  let prev = GENESIS;
  let brokenAt: number | null = null;
  for (const r of rows) {
    const expected = chainHash(prev, { at: r.at, actorUserId: r.actorUserId, companyId: r.companyId, itemId: r.itemId, action: r.action, field: r.field, ipAddress: r.ipAddress, details: r.details });
    if (r.prevHash !== prev || r.hash !== expected) {
      brokenAt = r.id;
      break;
    }
    prev = r.hash;
  }
  const result = { ok: brokenAt === null, checked: rows.length, brokenAt, at: new Date().toISOString() };
  await setSystemStatus("vault.chain", result);
  if (actor) await writeVaultAudit(actor, { action: "chain_verified", details: { ok: result.ok, checked: result.checked, brokenAt } });
  return result;
}

export async function listVaultAudit(actor: VaultActor, p: { companyId?: string; itemId?: string; actorUserId?: string; action?: string; from?: string; to?: string; page?: number; pageSize?: number }) {
  if (p.companyId) await requireCapability(actor, p.companyId, "audit");
  else requireVaultAdmin(actor);
  const page = p.page ?? 1;
  const pageSize = Math.min(p.pageSize ?? 50, 200);
  const where = and(
    p.companyId ? eq(vaultAudit.companyId, p.companyId) : undefined,
    p.itemId ? eq(vaultAudit.itemId, p.itemId) : undefined,
    p.actorUserId ? eq(vaultAudit.actorUserId, p.actorUserId) : undefined,
    p.action ? eq(vaultAudit.action, p.action) : undefined,
    p.from ? gte(vaultAudit.at, new Date(p.from)) : undefined,
    p.to ? lte(vaultAudit.at, new Date(`${p.to}T23:59:59.999Z`)) : undefined,
  );
  const [rows, [{ total }]] = await Promise.all([
    db.select({ a: vaultAudit, companyName: companies.name }).from(vaultAudit).leftJoin(companies, eq(companies.id, vaultAudit.companyId)).where(where).orderBy(desc(vaultAudit.id)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)`.mapWith(Number) }).from(vaultAudit).where(where),
  ]);
  return { rows: rows.map((r) => ({ ...r.a, companyName: r.companyName })), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

// ---------------------------------------------------------------------------
// Step-up authentication and reveal rate limit
// ---------------------------------------------------------------------------
export async function stepUpStatus(userId: string) {
  const settings = await getAppSettings();
  const [row] = await db.select().from(vaultStepUps).where(eq(vaultStepUps.userId, userId)).limit(1);
  const expiresAt = row ? new Date(row.verifiedAt.getTime() + settings.vaultStepUpMinutes * 60_000) : null;
  const locked = Boolean(row && row.failedAttempts >= 5 && row.lastFailedAt && Date.now() - row.lastFailedAt.getTime() < 15 * 60_000);
  return { verified: Boolean(expiresAt && expiresAt > new Date()), expiresAt, locked, windowMinutes: settings.vaultStepUpMinutes };
}

/** Confirms the user's CRM password and opens the step-up window. Five failures lock step-up for 15 minutes. */
export async function verifyStepUp(actor: VaultActor, password: string) {
  const status = await stepUpStatus(actor.id);
  if (status.locked) throw new ActionError("Too many failed attempts. Try again in 15 minutes.");
  const [cred] = await db.select({ hash: account.password }).from(account).where(and(eq(account.userId, actor.id), eq(account.providerId, "credential"))).limit(1);
  if (!cred?.hash) throw new ActionError("Your account has no CRM password (single sign-on only). Ask an administrator to set one under Settings → Users, then try again.");
  const ok = await verifyPassword({ hash: cred.hash, password });
  if (!ok) {
    await db
      .insert(vaultStepUps)
      .values({ userId: actor.id, verifiedAt: new Date(0), failedAttempts: 1, lastFailedAt: new Date() })
      .onConflictDoUpdate({ target: vaultStepUps.userId, set: { failedAttempts: sql`${vaultStepUps.failedAttempts} + 1`, lastFailedAt: new Date() } });
    await writeVaultAudit(actor, { action: "step_up_failed" });
    throw new ActionError("Password not recognised.");
  }
  await db.insert(vaultStepUps).values({ userId: actor.id, verifiedAt: new Date(), failedAttempts: 0, lastFailedAt: null }).onConflictDoUpdate({ target: vaultStepUps.userId, set: { verifiedAt: new Date(), failedAttempts: 0, lastFailedAt: null } });
  await writeVaultAudit(actor, { action: "step_up_succeeded" });
  return stepUpStatus(actor.id);
}

async function requireStepUp(actor: VaultActor) {
  const s = await stepUpStatus(actor.id);
  if (!s.verified) throw new ActionError("STEP_UP_REQUIRED");
}

async function enforceRevealLimit(actor: VaultActor, companyId: string, itemId: string, itemName: string) {
  const settings = await getAppSettings();
  const since = new Date(Date.now() - 10 * 60_000);
  const [{ n }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(vaultAudit).where(and(eq(vaultAudit.actorUserId, actor.id), inArray(vaultAudit.action, ["revealed", "copied", "totp_code"]), gte(vaultAudit.at, since)));
  if (n < settings.vaultRevealLimit) return;
  await writeVaultAudit(actor, { action: "rate_limited", companyId, itemId, itemName, details: { inLast10Min: n, limit: settings.vaultRevealLimit } });
  // Alert administrators once per user per hour via a high-priority task.
  const admins = await db.select({ id: user.id }).from(user).where(and(eq(user.role, "admin"), eq(user.active, true))).limit(1);
  const bucket = new Date().toISOString().slice(0, 13);
  await createTask({ title: `Vault alert: ${actor.name} hit the reveal limit (${n} in 10 minutes)`, description: "Review Settings → Secure Vault → Audit for this user and confirm the activity is expected.", priority: "urgent", dueDate: new Date().toISOString().slice(0, 10), ownerUserId: admins[0]?.id ?? null, companyId: null, opportunityId: null, contractId: null, onboardingId: null }, null, `vault-ratelimit:${actor.id}:${bucket}`).catch(() => undefined);
  throw new ActionError(`Reveal limit reached (${settings.vaultRevealLimit} in 10 minutes). An administrator has been notified.`);
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
export async function listCategories(includeArchived = false) {
  const rows = await db.select().from(vaultCategories).orderBy(asc(vaultCategories.sortOrder), asc(vaultCategories.name));
  return includeArchived ? rows : rows.filter((c) => !c.archivedAt);
}

export async function createCategory(actor: VaultActor, input: { name: string; icon?: string }) {
  requireVaultAdmin(actor);
  const id = input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || randomUUID();
  const [row] = await db.insert(vaultCategories).values({ id, name: input.name.trim(), icon: input.icon?.trim() || "key", sortOrder: 500 }).onConflictDoNothing().returning({ id: vaultCategories.id });
  if (!row) throw new ActionError("A category with that name already exists.", { name: ["Already in use"] });
  await writeVaultAudit(actor, { action: "category_changed", details: { id, name: input.name, change: "created" } });
  return id;
}

export async function archiveCategory(actor: VaultActor, id: string, restore = false) {
  requireVaultAdmin(actor);
  const [cat] = await db.select().from(vaultCategories).where(eq(vaultCategories.id, id)).limit(1);
  if (!cat) throw new ActionError("Category not found.");
  if (cat.isSystem && !restore) throw new ActionError("Built-in categories cannot be archived.");
  await db.update(vaultCategories).set({ archivedAt: restore ? null : new Date(), updatedAt: new Date() }).where(eq(vaultCategories.id, id));
  await writeVaultAudit(actor, { action: "category_changed", details: { id, change: restore ? "restored" : "archived" } });
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------
export async function listGrants() {
  return db
    .select({ g: vaultGrants, userName: user.name, userEmail: user.email, userRole: user.role, companyName: companies.name })
    .from(vaultGrants)
    .innerJoin(user, eq(user.id, vaultGrants.userId))
    .leftJoin(companies, eq(companies.id, vaultGrants.companyId))
    .where(isNull(vaultGrants.revokedAt))
    .orderBy(asc(user.name))
    .then((rows) => rows.map((r) => ({ ...r.g, userName: r.userName, userEmail: r.userEmail, userRole: r.userRole, companyName: r.companyName })));
}

export type GrantInput = { userId: string; scope: "all" | "company"; companyId?: string | null; canList: boolean; canViewUsername: boolean; canReveal: boolean; canCopy: boolean; canCreate: boolean; canEdit: boolean; canDelete: boolean; canAudit: boolean; expiresAt?: string | null };

export async function saveGrant(actor: VaultActor, input: GrantInput, grantId?: string | null) {
  requireVaultAdmin(actor);
  const [target] = await db.select({ role: user.role, name: user.name }).from(user).where(eq(user.id, input.userId)).limit(1);
  if (!target) throw new ActionError("User not found.");
  if (!can(target.role, "vault.use")) throw new ActionError(`${target.name} has the ${target.role.replace("_", " ")} role, which cannot hold vault access. Only administrators and technicians can.`);
  if (input.scope === "company" && !input.companyId) throw new ActionError("Choose a customer for a customer-scoped grant.");
  const values = { userId: input.userId, scope: input.scope, companyId: input.scope === "company" ? input.companyId : null, canList: input.canList, canViewUsername: input.canViewUsername, canReveal: input.canReveal, canCopy: input.canCopy && input.canReveal, canCreate: input.canCreate, canEdit: input.canEdit, canDelete: input.canDelete, canAudit: input.canAudit, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, grantedByUserId: actor.id, updatedAt: new Date() };
  let id = grantId ?? null;
  if (id) await db.update(vaultGrants).set(values).where(eq(vaultGrants.id, id));
  else {
    const [row] = await db.insert(vaultGrants).values(values).returning({ id: vaultGrants.id });
    id = row.id;
  }
  await writeVaultAudit(actor, { action: "grant_changed", companyId: values.companyId ?? null, details: { grantId: id, userId: input.userId, user: target.name, scope: input.scope, capabilities: VAULT_CAPABILITIES.filter((c) => values[`can${c.split("_").map((s) => s[0].toUpperCase() + s.slice(1)).join("")}` as keyof typeof values]), expiresAt: values.expiresAt?.toISOString() ?? null } });
  return id;
}

export async function revokeGrant(actor: VaultActor, grantId: string) {
  requireVaultAdmin(actor);
  const [g] = await db.select().from(vaultGrants).where(eq(vaultGrants.id, grantId)).limit(1);
  if (!g) throw new ActionError("Grant not found.");
  await db.update(vaultGrants).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(vaultGrants.id, grantId));
  await writeVaultAudit(actor, { action: "grant_revoked", companyId: g.companyId, details: { grantId, userId: g.userId } });
}

// ---------------------------------------------------------------------------
// Items: metadata reads
// ---------------------------------------------------------------------------
const itemSelect = { id: vaultItems.id, companyId: vaultItems.companyId, siteId: vaultItems.siteId, categoryId: vaultItems.categoryId, categoryName: vaultCategories.name, categoryIcon: vaultCategories.icon, name: vaultItems.name, username: vaultItems.username, url: vaultItems.url, reference: vaultItems.reference, tags: vaultItems.tags, isFavourite: vaultItems.isFavourite, reviewAt: vaultItems.reviewAt, expiresAt: vaultItems.expiresAt, secretKinds: vaultItems.secretKinds, createdByUserId: vaultItems.createdByUserId, updatedByUserId: vaultItems.updatedByUserId, lastRevealedAt: vaultItems.lastRevealedAt, revealCount: vaultItems.revealCount, archivedAt: vaultItems.archivedAt, createdAt: vaultItems.createdAt, updatedAt: vaultItems.updatedAt };

export async function listVaultItems(actor: VaultActor, companyId: string, p: { q?: string; categoryId?: string; tag?: string; includeArchived?: boolean } = {}) {
  const caps = await requireCapability(actor, companyId, "list");
  const term = p.q ? `%${p.q}%` : null;
  const rows = await db
    .select({ ...itemSelect, createdBy: user.name })
    .from(vaultItems)
    .innerJoin(vaultCategories, eq(vaultCategories.id, vaultItems.categoryId))
    .leftJoin(user, eq(user.id, vaultItems.updatedByUserId))
    .where(and(eq(vaultItems.companyId, companyId), p.includeArchived ? undefined : isNull(vaultItems.archivedAt), p.categoryId ? eq(vaultItems.categoryId, p.categoryId) : undefined, p.tag ? sql`${p.tag} = any(${vaultItems.tags})` : undefined, term ? or(ilike(vaultItems.name, term), ilike(vaultItems.username, term), ilike(vaultItems.url, term), ilike(vaultItems.reference, term), ilike(vaultCategories.name, term)) : undefined))
    .orderBy(desc(vaultItems.isFavourite), asc(vaultCategories.sortOrder), asc(vaultItems.name));
  return { caps, items: rows.map((r) => ({ ...r, updatedBy: r.createdBy, username: caps.view_username ? r.username : r.username ? "••••••" : null })) };
}

export async function countVaultItems(companyId: string) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(vaultItems).where(and(eq(vaultItems.companyId, companyId), isNull(vaultItems.archivedAt)));
  return n;
}

async function loadItem(id: string) {
  const [row] = await db.select().from(vaultItems).where(eq(vaultItems.id, id)).limit(1);
  if (!row) throw new ActionError("Vault item not found.");
  return row;
}

export async function getVaultItem(actor: VaultActor, id: string) {
  const row = await loadItem(id);
  const caps = await requireCapability(actor, row.companyId, "list");
  await writeVaultAudit(actor, { action: "viewed", companyId: row.companyId, itemId: id, itemName: row.name });
  const { wrappedDek: _w, ciphertext: _c, ...meta } = row;
  void _w;
  void _c;
  return { ...meta, username: caps.view_username ? row.username : row.username ? "••••••" : null, caps };
}

// ---------------------------------------------------------------------------
// Items: writes (secrets encrypted immediately, never logged)
// ---------------------------------------------------------------------------
function buildSecrets(base: VaultSecrets, patch: VaultSecretPatch): VaultSecrets {
  const next: VaultSecrets = { ...base, v: 1 };
  for (const k of patch.clear ?? []) delete next[k];
  if (patch.password) next.password = patch.password;
  if (patch.notes !== undefined && patch.notes !== null && patch.notes !== "") next.notes = patch.notes;
  if (patch.apiKey) next.api_key = patch.apiKey;
  if (patch.recoveryCodes && patch.recoveryCodes.length) next.recovery_codes = patch.recoveryCodes.map((c) => c.trim()).filter(Boolean);
  if (patch.totp) {
    const parsed = parseTotpInput(patch.totp);
    if (!parsed) throw new ActionError("The TOTP secret must be a base32 key or an otpauth:// URI.", { totp: ["Invalid secret"] });
    next.totp = parsed;
  }
  if (patch.custom) next.custom = patch.custom.filter((c) => c.label.trim() && c.value !== "").map((c) => ({ label: c.label.trim().slice(0, 80), value: c.value, secret: Boolean(c.secret) }));
  return next;
}

function secretKindsOf(s: VaultSecrets): string[] {
  const kinds: string[] = [];
  if (s.password) kinds.push("password");
  if (s.notes) kinds.push("notes");
  if (s.totp) kinds.push("totp");
  if (s.recovery_codes?.length) kinds.push("recovery_codes");
  if (s.api_key) kinds.push("api_key");
  if (s.custom?.length) kinds.push(`custom:${s.custom.length}`);
  return kinds;
}

function metaValues(input: VaultItemInput) {
  return { siteId: input.siteId || null, categoryId: input.categoryId, name: input.name.trim(), username: input.username?.trim() || null, url: input.url?.trim() || null, reference: input.reference?.trim() || null, tags: [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20), isFavourite: Boolean(input.isFavourite), reviewAt: input.reviewAt || null, expiresAt: input.expiresAt || null };
}

export async function createVaultItem(actor: VaultActor, input: VaultItemInput, secrets: VaultSecretPatch) {
  assertVaultConfigured();
  await requireCapability(actor, input.companyId, "create");
  const keyVersion = await ensureKeyVersion();
  const [cat] = await db.select({ id: vaultCategories.id }).from(vaultCategories).where(and(eq(vaultCategories.id, input.categoryId), isNull(vaultCategories.archivedAt))).limit(1);
  if (!cat) throw new ActionError("Choose a category.", { categoryId: ["Required"] });
  const id = randomUUID();
  const doc = buildSecrets({ v: 1 }, secrets);
  const sealed = sealItem(id, input.companyId, doc);
  await db.transaction(async (tx) => {
    await tx.insert(vaultItems).values({ id, companyId: input.companyId, ...metaValues(input), keyVersion, wrappedDek: sealed.wrappedDek, ciphertext: sealed.ciphertext, cipherVersion: sealed.cipherVersion, secretKinds: secretKindsOf(doc), createdByUserId: actor.id, updatedByUserId: actor.id });
    await writeVaultAudit(actor, { action: "created", companyId: input.companyId, itemId: id, itemName: input.name, details: { category: input.categoryId, secretKinds: secretKindsOf(doc) } }, tx);
    await logActivity({ type: "system", companyId: input.companyId, entityType: "vault_item", entityId: id, title: `Vault item added: ${input.name.trim()}`, actorUserId: actor.id }, tx);
  });
  return id;
}

export async function updateVaultItem(actor: VaultActor, id: string, input: Omit<VaultItemInput, "companyId">, secrets: VaultSecretPatch) {
  assertVaultConfigured();
  const row = await loadItem(id);
  await requireCapability(actor, row.companyId, "edit");
  const keyVersion = await ensureKeyVersion();
  const existing = openItem(id, row.companyId, row) as VaultSecrets;
  const doc = buildSecrets(existing, secrets);
  const changedSecrets = (["password", "notes", "totp", "recovery_codes", "api_key", "custom"] as const).filter((k) => JSON.stringify(existing[k] ?? null) !== JSON.stringify(doc[k] ?? null));
  const meta = metaValues({ ...input, companyId: row.companyId });
  const changedMeta = (Object.keys(meta) as (keyof typeof meta)[]).filter((k) => JSON.stringify(meta[k]) !== JSON.stringify(row[k]));
  const sealed = sealItem(id, row.companyId, doc); // fresh DEK on every save
  await db.transaction(async (tx) => {
    await tx.update(vaultItems).set({ ...meta, keyVersion, wrappedDek: sealed.wrappedDek, ciphertext: sealed.ciphertext, cipherVersion: sealed.cipherVersion, secretKinds: secretKindsOf(doc), updatedByUserId: actor.id, updatedAt: new Date() }).where(eq(vaultItems.id, id));
    await writeVaultAudit(actor, { action: "modified", companyId: row.companyId, itemId: id, itemName: meta.name, details: { metadataChanged: changedMeta, secretsChanged: changedSecrets } }, tx);
  });
}

export async function toggleFavourite(actor: VaultActor, id: string) {
  const row = await loadItem(id);
  await requireCapability(actor, row.companyId, "list");
  await db.update(vaultItems).set({ isFavourite: !row.isFavourite, updatedAt: new Date() }).where(eq(vaultItems.id, id));
  return !row.isFavourite;
}

export async function archiveVaultItem(actor: VaultActor, id: string, restore = false) {
  const row = await loadItem(id);
  await requireCapability(actor, row.companyId, "delete");
  await db.transaction(async (tx) => {
    await tx.update(vaultItems).set({ archivedAt: restore ? null : new Date(), updatedByUserId: actor.id, updatedAt: new Date() }).where(eq(vaultItems.id, id));
    await writeVaultAudit(actor, { action: restore ? "restored" : "archived", companyId: row.companyId, itemId: id, itemName: row.name }, tx);
    await logActivity({ type: "system", companyId: row.companyId, entityType: "vault_item", entityId: id, title: `Vault item ${restore ? "restored" : "archived"}: ${row.name}`, actorUserId: actor.id }, tx);
  });
}

// ---------------------------------------------------------------------------
// Items: secret access (the only paths that return plaintext)
// ---------------------------------------------------------------------------
function pickField(doc: VaultSecrets, field: SecretField): string {
  if (field === "password") return doc.password ?? "";
  if (field === "notes") return doc.notes ?? "";
  if (field === "api_key") return doc.api_key ?? "";
  if (field === "recovery_codes") return (doc.recovery_codes ?? []).join("\n");
  if (field === "totp_secret") return doc.totp?.secret ?? "";
  if (field.startsWith("custom:")) return doc.custom?.[Number(field.slice(7))]?.value ?? "";
  return "";
}

/** Returns one plaintext field. Requires reveal (or copy) capability, a fresh step-up, and stays under the rate limit. Audited per call. */
export async function revealSecret(actor: VaultActor, id: string, field: SecretField, mode: "reveal" | "copy" = "reveal") {
  assertVaultConfigured();
  const row = await loadItem(id);
  if (row.archivedAt) throw new ActionError("This item is archived. Restore it to reveal its secrets.");
  await requireCapability(actor, row.companyId, mode === "copy" ? "copy" : "reveal");
  await requireStepUp(actor);
  await enforceRevealLimit(actor, row.companyId, id, row.name);
  const doc = openItem(id, row.companyId, row) as VaultSecrets;
  const value = pickField(doc, field);
  await db.transaction(async (tx) => {
    await tx.update(vaultItems).set({ lastRevealedAt: new Date(), revealCount: sql`${vaultItems.revealCount} + 1` }).where(eq(vaultItems.id, id));
    await writeVaultAudit(actor, { action: mode === "copy" ? "copied" : "revealed", companyId: row.companyId, itemId: id, itemName: row.name, field }, tx);
  });
  const settings = await getAppSettings();
  return { value, hideAfterSeconds: settings.vaultRevealSeconds, clipboardClearSeconds: settings.vaultClipboardSeconds };
}

/** Returns the current TOTP code without exposing the seed. */
export async function totpCode(actor: VaultActor, id: string) {
  assertVaultConfigured();
  const row = await loadItem(id);
  if (row.archivedAt) throw new ActionError("This item is archived.");
  await requireCapability(actor, row.companyId, "reveal");
  await requireStepUp(actor);
  await enforceRevealLimit(actor, row.companyId, id, row.name);
  const doc = openItem(id, row.companyId, row) as VaultSecrets;
  if (!doc.totp) throw new ActionError("This item has no authenticator secret.");
  const result = totp(doc.totp.secret, { digits: doc.totp.digits, period: doc.totp.period, algorithm: doc.totp.algorithm });
  await writeVaultAudit(actor, { action: "totp_code", companyId: row.companyId, itemId: id, itemName: row.name, field: "totp" });
  return { ...result, issuer: doc.totp.issuer ?? null, account: doc.totp.account ?? null };
}

// ---------------------------------------------------------------------------
// Maintenance: key rotation, reminders
// ---------------------------------------------------------------------------
export async function rewrapAllItems(actor: VaultActor) {
  requireVaultAdmin(actor);
  assertVaultConfigured();
  const version = await ensureKeyVersion();
  const rows = await db.select({ id: vaultItems.id, keyVersion: vaultItems.keyVersion, wrappedDek: vaultItems.wrappedDek, ciphertext: vaultItems.ciphertext, cipherVersion: vaultItems.cipherVersion }).from(vaultItems).where(sql`${vaultItems.keyVersion} <> ${version}`);
  let done = 0;
  for (const r of rows) {
    const sealed: SealedItem = { wrappedDek: r.wrappedDek, ciphertext: r.ciphertext, keyVersion: r.keyVersion, cipherVersion: r.cipherVersion };
    const next = rewrapItem(r.id, sealed);
    await db.update(vaultItems).set({ wrappedDek: next.wrappedDek, keyVersion: next.keyVersion }).where(eq(vaultItems.id, r.id));
    done++;
  }
  if (done) await db.update(vaultKeys).set({ retiredAt: new Date() }).where(sql`${vaultKeys.keyVersion} <> ${version} and ${vaultKeys.retiredAt} is null`);
  await writeVaultAudit(actor, { action: "rewrapped", details: { items: done, toVersion: version } });
  return { rewrapped: done, keyVersion: version };
}

/** Daily: tasks for credentials whose review or expiry date is near. Metadata only, so it runs in the worker without the key. */
export async function generateVaultReminders() {
  const settings = await getAppSettings();
  const horizon = new Date(Date.now() + settings.vaultReviewReminderDays * 86400000).toISOString().slice(0, 10);
  const rows = await db
    .select({ id: vaultItems.id, name: vaultItems.name, companyId: vaultItems.companyId, reviewAt: vaultItems.reviewAt, expiresAt: vaultItems.expiresAt, owner: vaultItems.updatedByUserId, companyName: companies.name })
    .from(vaultItems)
    .innerJoin(companies, eq(companies.id, vaultItems.companyId))
    .where(and(isNull(vaultItems.archivedAt), or(lte(vaultItems.reviewAt, horizon), lte(vaultItems.expiresAt, horizon))));
  let created = 0;
  for (const r of rows) {
    const due = [r.reviewAt, r.expiresAt].filter((d): d is string => Boolean(d) && (d as string) <= horizon).sort()[0];
    if (!due) continue;
    const kind = r.expiresAt && r.expiresAt <= horizon ? "expires" : "review due";
    const id = await createTask({ title: `Credential ${kind}: ${r.name} (${r.companyName})`, description: "Open the customer's Secure Vault tab, rotate or confirm the credential, and update its review date.", priority: kind === "expires" ? "high" : "normal", dueDate: due, ownerUserId: r.owner, companyId: r.companyId, opportunityId: null, contractId: null, onboardingId: null }, null, `vault-review:${r.id}:${due}`);
    if (id) created++;
  }
  return { created, checked: rows.length };
}

export async function vaultSettings() {
  const [s] = await db.select({ vaultRevealSeconds: appSettings.vaultRevealSeconds, vaultClipboardSeconds: appSettings.vaultClipboardSeconds, vaultStepUpMinutes: appSettings.vaultStepUpMinutes, vaultReviewReminderDays: appSettings.vaultReviewReminderDays, vaultRevealLimit: appSettings.vaultRevealLimit }).from(appSettings).where(eq(appSettings.id, 1));
  return s;
}
