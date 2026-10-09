import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, ilike, sql } from "drizzle-orm";
import Papa from "papaparse";
import { z } from "zod";
import { db } from "@/db";
import { companies, sites, user, vaultAudit, vaultCategories, vaultItems } from "@/db/schema";
import { ActionError } from "@/lib/action-result";
import { normalizeCompanyName } from "@/lib/utils";
import { openItem, sealItem, sealWithPassphrase } from "@/lib/vault-crypto";
import { buildZip } from "@/lib/zip";
import { assertVaultConfigured, ensureKeyVersion, requireFreshStepUp, requireVaultAdmin, writeVaultAudit, type VaultActor, type VaultSecrets } from "./vault";
import { createTask } from "./tasks";

/**
 * Plain-text backup of the whole vault (disaster recovery / migration).
 *
 * The export decrypts every item, archived ones included, into a ZIP holding
 * the same data as CSV and JSON plus a README. It is the single most
 * sensitive action in the CRM, so it needs vault.admin, a password confirmed
 * in the last five minutes, a typed acknowledgement and a reason; it is
 * limited to EXPORT_LIMIT_PER_HOUR across all administrators; every run is
 * written to the hash-chained audit trail with the item count and the SHA-256
 * of the plain ZIP; and every other administrator gets an urgent task so an
 * export is never silent. Optionally the ZIP is wrapped with a passphrase
 * (OpenSSL-compatible) so the browser download itself is not clear text.
 */
export const EXPORT_LIMIT_PER_HOUR = 2;
export const EXPORT_ACKNOWLEDGEMENT = "EXPORT ALL SECRETS";
export const IMPORT_ACKNOWLEDGEMENT = "IMPORT BACKUP";
export const BACKUP_FORMAT = "snelson-crm-vault-backup";
export const BACKUP_VERSION = 1;

export type BackupItem = {
  id: string;
  company: string;
  companyId: string;
  site: string | null;
  category: string;
  categoryId: string;
  name: string;
  username: string | null;
  url: string | null;
  reference: string | null;
  tags: string[];
  favourite: boolean;
  reviewAt: string | null;
  expiresAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastRevealedAt: string | null;
  revealCount: number;
  secrets: VaultSecrets;
};

export type BackupDocument = {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  exportedBy: string;
  categories: { id: string; name: string; icon: string; archived: boolean }[];
  items: BackupItem[];
};

export const CSV_COLUMNS = ["id", "company", "site", "category", "name", "username", "password", "url", "totp_secret", "totp_uri", "api_key", "recovery_codes", "notes", "custom_fields", "reference", "tags", "favourite", "review_at", "expires_at", "archived_at", "created_at", "updated_at"] as const;

function totpUri(t: VaultSecrets["totp"], name: string) {
  if (!t) return null;
  const label = encodeURIComponent(t.issuer ? `${t.issuer}:${t.account ?? name}` : (t.account ?? name));
  const q = new URLSearchParams({ secret: t.secret });
  if (t.issuer) q.set("issuer", t.issuer);
  if (t.digits) q.set("digits", String(t.digits));
  if (t.period) q.set("period", String(t.period));
  if (t.algorithm) q.set("algorithm", t.algorithm.toUpperCase());
  return `otpauth://totp/${label}?${q.toString()}`;
}

export function backupToCsv(items: BackupItem[]) {
  const rows = items.map((i) => ({
    id: i.id,
    company: i.company,
    site: i.site ?? "",
    category: i.category,
    name: i.name,
    username: i.username ?? "",
    password: i.secrets.password ?? "",
    url: i.url ?? "",
    totp_secret: i.secrets.totp?.secret ?? "",
    totp_uri: totpUri(i.secrets.totp, i.name) ?? "",
    api_key: i.secrets.api_key ?? "",
    recovery_codes: (i.secrets.recovery_codes ?? []).join("\n"),
    notes: i.secrets.notes ?? "",
    custom_fields: i.secrets.custom?.length ? JSON.stringify(i.secrets.custom) : "",
    reference: i.reference ?? "",
    tags: i.tags.join(", "),
    favourite: i.favourite ? "yes" : "",
    review_at: i.reviewAt ?? "",
    expires_at: i.expiresAt ?? "",
    archived_at: i.archivedAt ?? "",
    created_at: i.createdAt,
    updated_at: i.updatedAt,
  }));
  return Papa.unparse({ fields: [...CSV_COLUMNS], data: rows.map((r) => CSV_COLUMNS.map((c) => r[c])) }, { newline: "\r\n" });
}

function readme(doc: BackupDocument, archived: number) {
  return [
    "Snelson Server CRM - Secure Vault backup",
    "========================================",
    "",
    `Exported ${doc.exportedAt} by ${doc.exportedBy}.`,
    `${doc.items.length} items (${archived} archived) across ${new Set(doc.items.map((i) => i.companyId)).size} customers.`,
    "",
    "EVERY SECRET IN THIS ARCHIVE IS IN CLEAR TEXT.",
    "Keep it offline (password manager attachment or a sealed envelope), never in email,",
    "chat, a shared drive or a ticket. Destroy superseded copies.",
    "",
    "Files:",
    "  vault-backup.csv   one row per item, for reading or loading into another tool",
    "  vault-backup.json  the same data with full structure; the file the CRM imports",
    "",
    "Restore: Settings -> Secure Vault -> Import backup, choose vault-backup.json.",
    "Items whose id already exists are skipped, so re-importing is safe.",
    "",
    "Why this exists: the vault is only as recoverable as VAULT_MASTER_KEY. If the key",
    "or the database is lost, this file is the only copy of your customers' credentials.",
    "See docs/deployment.md, section 5a.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export type ExportOptions = { reason: string; acknowledgement: string; passphrase?: string | null };

export async function exportRateStatus() {
  const since = new Date(Date.now() - 60 * 60_000);
  const [{ n }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(vaultAudit).where(and(eq(vaultAudit.action, "exported"), gte(vaultAudit.at, since)));
  const [last] = await db.select({ at: vaultAudit.at, actorName: vaultAudit.actorName, details: vaultAudit.details }).from(vaultAudit).where(eq(vaultAudit.action, "exported")).orderBy(desc(vaultAudit.id)).limit(1);
  return { usedThisHour: n, limitPerHour: EXPORT_LIMIT_PER_HOUR, allowed: n < EXPORT_LIMIT_PER_HOUR, last: last ? { at: last.at, actorName: last.actorName, items: Number(last.details?.items ?? 0), encrypted: Boolean(last.details?.encrypted), sha256: String(last.details?.sha256 ?? "") } : null };
}

async function loadBackupDocument(actorName: string): Promise<{ doc: BackupDocument; archived: number; failed: string[] }> {
  const rows = await db
    .select({
      item: vaultItems,
      company: companies.name,
      site: sites.name,
      category: vaultCategories.name,
    })
    .from(vaultItems)
    .innerJoin(companies, eq(companies.id, vaultItems.companyId))
    .innerJoin(vaultCategories, eq(vaultCategories.id, vaultItems.categoryId))
    .leftJoin(sites, eq(sites.id, vaultItems.siteId))
    .orderBy(asc(companies.name), asc(vaultItems.name));
  const cats = await db.select().from(vaultCategories).orderBy(asc(vaultCategories.sortOrder), asc(vaultCategories.name));
  const items: BackupItem[] = [];
  const failed: string[] = [];
  let archived = 0;
  for (const r of rows) {
    let secrets: VaultSecrets;
    try {
      secrets = openItem(r.item.id, r.item.companyId, r.item) as VaultSecrets;
    } catch {
      failed.push(r.item.id);
      continue;
    }
    if (r.item.archivedAt) archived++;
    items.push({
      id: r.item.id,
      company: r.company,
      companyId: r.item.companyId,
      site: r.site ?? null,
      category: r.category,
      categoryId: r.item.categoryId,
      name: r.item.name,
      username: r.item.username,
      url: r.item.url,
      reference: r.item.reference,
      tags: r.item.tags,
      favourite: r.item.isFavourite,
      reviewAt: r.item.reviewAt,
      expiresAt: r.item.expiresAt,
      archivedAt: r.item.archivedAt?.toISOString() ?? null,
      createdAt: r.item.createdAt.toISOString(),
      updatedAt: r.item.updatedAt.toISOString(),
      lastRevealedAt: r.item.lastRevealedAt?.toISOString() ?? null,
      revealCount: r.item.revealCount,
      secrets,
    });
  }
  const doc: BackupDocument = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: actorName,
    categories: cats.map((c) => ({ id: c.id, name: c.name, icon: c.icon, archived: Boolean(c.archivedAt) })),
    items,
  };
  return { doc, archived, failed };
}

async function notifyAdmins(actor: VaultActor, title: string, description: string, key: string) {
  const admins = await db.select({ id: user.id }).from(user).where(and(eq(user.role, "admin"), eq(user.active, true)));
  const others = admins.filter((a) => a.id !== actor.id);
  const owners = others.length ? others : admins.length ? [{ id: actor.id }] : [{ id: null as string | null }];
  for (const o of owners) {
    await createTask({ title, description, priority: "urgent", dueDate: new Date().toISOString().slice(0, 10), ownerUserId: o.id, companyId: null, opportunityId: null, contractId: null, onboardingId: null }, null, `${key}:${o.id ?? "none"}`).catch(() => undefined);
  }
  return owners.length;
}

/**
 * Decrypts the whole vault into a ZIP (CSV + JSON + README). Returns the bytes
 * to send to the browser; nothing is written to disk or logged.
 */
export async function exportVault(actor: VaultActor, opts: ExportOptions) {
  requireVaultAdmin(actor);
  assertVaultConfigured();
  if (opts.acknowledgement.trim().toUpperCase() !== EXPORT_ACKNOWLEDGEMENT) throw new ActionError(`Type "${EXPORT_ACKNOWLEDGEMENT}" exactly to confirm.`);
  const reason = opts.reason.trim();
  if (reason.length < 5) throw new ActionError("Give a reason for the export (at least 5 characters). It is recorded in the audit trail.");
  if (opts.passphrase && opts.passphrase.length < 12) throw new ActionError("The passphrase must be at least 12 characters.");
  await requireFreshStepUp(actor);
  const rate = await exportRateStatus();
  if (!rate.allowed) throw new ActionError(`Export limit reached (${EXPORT_LIMIT_PER_HOUR} per hour across all administrators). Try again later.`);
  await ensureKeyVersion();

  const { doc, archived, failed } = await loadBackupDocument(actor.name);
  const stamp = doc.exportedAt.replace(/[-:]/g, "").slice(0, 15);
  const plainZip = buildZip([
    { name: "README.txt", data: readme(doc, archived) },
    { name: "vault-backup.csv", data: "﻿" + backupToCsv(doc.items) },
    { name: "vault-backup.json", data: JSON.stringify(doc, null, 2) },
  ]);
  const sha256 = createHash("sha256").update(plainZip).digest("hex");
  const encrypted = Boolean(opts.passphrase);
  const body = encrypted ? sealWithPassphrase(plainZip, opts.passphrase!) : plainZip;
  if (encrypted) plainZip.fill(0);
  const filename = `vault-backup-${stamp}.zip${encrypted ? ".enc" : ""}`;
  const companiesCount = new Set(doc.items.map((i) => i.companyId)).size;

  await writeVaultAudit(actor, { action: "exported", details: { items: doc.items.length, archived, companies: companiesCount, failed: failed.length, encrypted, sha256, bytes: body.length, filename, reason } });
  const notified = await notifyAdmins(
    actor,
    `Vault exported in clear by ${actor.name}: ${doc.items.length} credentials`,
    `${actor.name} downloaded a full plain-text backup of the Secure Vault (${doc.items.length} items across ${companiesCount} customers, ${encrypted ? "passphrase-protected file" : "UNENCRYPTED file"}).\nReason given: ${reason}\nSHA-256 of the backup: ${sha256}\n\nConfirm this was expected and that the file has been stored offline (password manager or sealed envelope). Review Settings → Secure Vault → Audit if not.`,
    `vault-export:${actor.id}:${doc.exportedAt}`,
  );
  return { filename, body, contentType: encrypted ? "application/octet-stream" : "application/zip", items: doc.items.length, archived, companies: companiesCount, failed: failed.length, sha256, encrypted, notified };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
const secretsSchema = z.object({
  v: z.literal(1).default(1),
  password: z.string().max(1024).optional(),
  notes: z.string().max(20000).optional(),
  totp: z.object({ secret: z.string().min(1).max(512), issuer: z.string().max(200).optional(), account: z.string().max(200).optional(), digits: z.number().int().min(6).max(8).optional(), period: z.number().int().min(15).max(120).optional(), algorithm: z.enum(["sha1", "sha256", "sha512"]).optional() }).optional(),
  recovery_codes: z.array(z.string().max(200)).max(50).optional(),
  api_key: z.string().max(4096).optional(),
  custom: z.array(z.object({ label: z.string().max(80), value: z.string().max(4096), secret: z.boolean() })).max(30).optional(),
});

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();

const backupItemSchema = z.object({
  id: z.uuid(),
  company: z.string().min(1).max(200),
  companyId: z.string().optional(),
  site: z.string().nullable().optional(),
  category: z.string().min(1).max(60),
  categoryId: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  username: z.string().max(300).nullable().optional(),
  url: z.string().max(2000).nullable().optional(),
  reference: z.string().max(200).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).default([]),
  favourite: z.boolean().default(false),
  reviewAt: dateOnly,
  expiresAt: dateOnly,
  archivedAt: z.string().nullable().optional(),
  secrets: secretsSchema,
});

const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_VERSION),
  categories: z.array(z.object({ id: z.string().min(1).max(40), name: z.string().min(1).max(60), icon: z.string().max(40).optional(), archived: z.boolean().optional() })).default([]),
  items: z.array(backupItemSchema),
});

export type ImportOptions = { json: string; acknowledgement: string; reason: string };
export type ImportResult = { created: number; skipped: number; companiesCreated: number; categoriesCreated: number; errors: { item: string; error: string }[]; sha256: string };

function secretKinds(s: VaultSecrets) {
  const kinds: string[] = [];
  if (s.password) kinds.push("password");
  if (s.notes) kinds.push("notes");
  if (s.totp) kinds.push("totp");
  if (s.recovery_codes?.length) kinds.push("recovery_codes");
  if (s.api_key) kinds.push("api_key");
  if (s.custom?.some((c) => c.secret)) kinds.push("custom");
  return kinds;
}

/**
 * Loads a vault-backup.json produced by exportVault. Items whose id already
 * exists are skipped (so re-running is safe); customers are matched by id
 * then by name and created when missing; categories are created when missing.
 */
export async function importVaultBackup(actor: VaultActor, opts: ImportOptions): Promise<ImportResult> {
  requireVaultAdmin(actor);
  assertVaultConfigured();
  if (opts.acknowledgement.trim().toUpperCase() !== IMPORT_ACKNOWLEDGEMENT) throw new ActionError(`Type "${IMPORT_ACKNOWLEDGEMENT}" exactly to confirm.`);
  const reason = opts.reason.trim();
  if (reason.length < 5) throw new ActionError("Give a reason for the import (at least 5 characters).");
  await requireFreshStepUp(actor);
  const keyVersion = await ensureKeyVersion();

  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.json);
  } catch {
    throw new ActionError("That file is not valid JSON. Choose the vault-backup.json from an export.");
  }
  const check = backupSchema.safeParse(parsed);
  if (!check.success) throw new ActionError(`That file is not a vault backup this CRM understands (${check.error.issues[0]?.path.join(".") || "root"}: ${check.error.issues[0]?.message ?? "invalid"}).`);
  const doc = check.data;
  const sha256 = createHash("sha256").update(opts.json).digest("hex");

  const result: ImportResult = { created: 0, skipped: 0, companiesCreated: 0, categoriesCreated: 0, errors: [], sha256 };
  const existingIds = new Set((await db.select({ id: vaultItems.id }).from(vaultItems)).map((r) => r.id));
  const cats = new Map((await db.select({ id: vaultCategories.id }).from(vaultCategories)).map((c) => [c.id, true]));
  const companyById = new Map((await db.select({ id: companies.id, name: companies.name }).from(companies)).map((c) => [c.id, c.name]));
  const companyByName = new Map([...companyById.entries()].map(([id, name]) => [name.trim().toLowerCase(), id]));

  const resolveCompany = async (item: z.infer<typeof backupItemSchema>) => {
    if (item.companyId && companyById.has(item.companyId)) return item.companyId;
    const byName = companyByName.get(item.company.trim().toLowerCase());
    if (byName) return byName;
    const [existing] = await db.select({ id: companies.id }).from(companies).where(ilike(companies.name, item.company.trim())).limit(1);
    if (existing) {
      companyByName.set(item.company.trim().toLowerCase(), existing.id);
      return existing.id;
    }
    const [created] = await db.insert(companies).values({ name: item.company.trim(), normalizedName: normalizeCompanyName(item.company), status: "customer" }).returning({ id: companies.id });
    companyById.set(created.id, item.company.trim());
    companyByName.set(item.company.trim().toLowerCase(), created.id);
    result.companiesCreated++;
    return created.id;
  };
  const resolveCategory = async (item: z.infer<typeof backupItemSchema>) => {
    if (cats.has(item.categoryId)) return item.categoryId;
    const fromDoc = doc.categories.find((c) => c.id === item.categoryId);
    await db.insert(vaultCategories).values({ id: item.categoryId, name: fromDoc?.name ?? item.category, icon: fromDoc?.icon ?? "key", sortOrder: 500 }).onConflictDoNothing();
    cats.set(item.categoryId, true);
    result.categoriesCreated++;
    return item.categoryId;
  };

  for (const item of doc.items) {
    if (existingIds.has(item.id)) {
      result.skipped++;
      continue;
    }
    try {
      const companyId = await resolveCompany(item);
      const categoryId = await resolveCategory(item);
      const secrets: VaultSecrets = { ...item.secrets, v: 1 };
      const sealed = sealItem(item.id, companyId, secrets);
      await db.transaction(async (tx) => {
        await tx.insert(vaultItems).values({
          id: item.id,
          companyId,
          siteId: null,
          categoryId,
          name: item.name,
          username: item.username ?? null,
          url: item.url ?? null,
          reference: item.reference ?? null,
          tags: item.tags,
          isFavourite: item.favourite,
          reviewAt: item.reviewAt ?? null,
          expiresAt: item.expiresAt ?? null,
          keyVersion,
          wrappedDek: sealed.wrappedDek,
          ciphertext: sealed.ciphertext,
          cipherVersion: sealed.cipherVersion,
          secretKinds: secretKinds(secrets),
          createdByUserId: actor.id,
          updatedByUserId: actor.id,
          archivedAt: item.archivedAt ? new Date(item.archivedAt) : null,
        });
        await writeVaultAudit(actor, { action: "created", companyId, itemId: item.id, itemName: item.name, details: { imported: true, kinds: secretKinds(secrets) } }, tx);
      });
      existingIds.add(item.id);
      result.created++;
    } catch (err) {
      result.errors.push({ item: `${item.company} / ${item.name}`, error: err instanceof Error ? err.message.slice(0, 200) : "failed" });
    }
  }

  await writeVaultAudit(actor, { action: "imported", details: { created: result.created, skipped: result.skipped, errors: result.errors.length, companiesCreated: result.companiesCreated, categoriesCreated: result.categoriesCreated, sha256, reason } });
  await notifyAdmins(
    actor,
    `Vault backup imported by ${actor.name}: ${result.created} credentials added`,
    `${actor.name} imported a plain-text vault backup (${result.created} created, ${result.skipped} already present, ${result.errors.length} failed).\nReason given: ${reason}\nSHA-256 of the file: ${sha256}\n\nMake sure the plain-text file used for the import has been destroyed or returned to offline storage.`,
    `vault-import:${actor.id}:${new Date().toISOString()}`,
  );
  return result;
}
