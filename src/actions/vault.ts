"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getRequestContext, requireActionPermission, requireUser } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { generatePassword, passwordStrengthBits } from "@/lib/vault-crypto";
import { vaultSettingsSchema } from "@/lib/validation";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { audit } from "@/lib/audit";
import { archiveCategory, archiveVaultItem, createCategory, createVaultItem, listVaultAudit, revealSecret, revokeGrant, rewrapAllItems, saveGrant, stepUpStatus, toggleFavourite, totpCode, updateVaultItem, verifyAuditChain, verifyStepUp, type SecretField, type VaultActor } from "@/services/vault";

async function actor(): Promise<VaultActor> {
  const u = await requireUser();
  const ctx = await getRequestContext();
  return { id: u.id, name: u.name, role: u.role, ...ctx };
}

const revalidate = (companyId?: string) => {
  if (companyId) revalidatePath(`/companies/${companyId}`);
  revalidatePath("/settings/vault", "layout");
};

const optionalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")).transform((v) => (v ? v : null));

const itemSchema = z.object({
  companyId: z.uuid(),
  siteId: z.uuid().optional().or(z.literal("")).transform((v) => (v ? v : null)),
  categoryId: z.string().min(1, "Choose a category").max(40),
  name: z.string().trim().min(1, "Name is required").max(200),
  username: z.string().trim().max(300).optional(),
  url: z.string().trim().max(2000).optional(),
  reference: z.string().trim().max(200).optional(),
  tags: z.array(z.string().max(40)).max(20).default([]),
  isFavourite: z.boolean().default(false),
  reviewAt: optionalDate,
  expiresAt: optionalDate,
});

const secretsSchema = z.object({
  password: z.string().max(1024).optional().nullable(),
  notes: z.string().max(20000).optional().nullable(),
  totp: z.string().max(2048).optional().nullable(),
  recoveryCodes: z.array(z.string().max(200)).max(50).optional().nullable(),
  apiKey: z.string().max(4096).optional().nullable(),
  custom: z.array(z.object({ label: z.string().max(80), value: z.string().max(4096), secret: z.boolean() })).max(30).optional().nullable(),
  clear: z.array(z.enum(["password", "notes", "totp", "recovery_codes", "api_key"])).optional(),
});

export type VaultItemFormInput = z.input<typeof itemSchema>;
export type VaultSecretsFormInput = z.input<typeof secretsSchema>;

export async function createVaultItemAction(input: VaultItemFormInput, secrets: VaultSecretsFormInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const a = await actor();
    const item = itemSchema.parse(input);
    const id = await createVaultItem(a, item, secretsSchema.parse(secrets));
    revalidate(item.companyId);
    return { id };
  });
}

export async function updateVaultItemAction(id: string, companyId: string, input: Omit<VaultItemFormInput, "companyId">, secrets: VaultSecretsFormInput): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const a = await actor();
    const item = itemSchema.parse({ ...input, companyId });
    const { companyId: _c, ...rest } = item;
    void _c;
    await updateVaultItem(a, z.uuid().parse(id), rest, secretsSchema.parse(secrets));
    revalidate(companyId);
    return undefined;
  });
}

export async function archiveVaultItemAction(id: string, companyId: string, restore = false): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    await archiveVaultItem(await actor(), z.uuid().parse(id), restore);
    revalidate(companyId);
    return undefined;
  });
}

export async function toggleFavouriteAction(id: string, companyId: string): Promise<ActionResult<{ isFavourite: boolean }>> {
  return runAction(async () => {
    const isFavourite = await toggleFavourite(await actor(), z.uuid().parse(id));
    revalidate(companyId);
    return { isFavourite };
  });
}

/** The only action that returns plaintext. Returns { stepUpRequired: true } instead of an error when the window has lapsed. */
export async function revealSecretAction(id: string, field: string, mode: "reveal" | "copy"): Promise<ActionResult<{ value: string; hideAfterSeconds: number; clipboardClearSeconds: number } | { stepUpRequired: true }>> {
  return runAction(async () => {
    const f = z.string().regex(/^(password|notes|api_key|recovery_codes|totp_secret|custom:\d{1,2})$/).parse(field) as SecretField;
    try {
      return await revealSecret(await actor(), z.uuid().parse(id), f, mode);
    } catch (err) {
      if (err instanceof Error && err.message === "STEP_UP_REQUIRED") return { stepUpRequired: true as const };
      throw err;
    }
  });
}

export async function totpCodeAction(id: string): Promise<ActionResult<{ code: string; secondsRemaining: number; period: number; issuer: string | null; account: string | null } | { stepUpRequired: true }>> {
  return runAction(async () => {
    try {
      return await totpCode(await actor(), z.uuid().parse(id));
    } catch (err) {
      if (err instanceof Error && err.message === "STEP_UP_REQUIRED") return { stepUpRequired: true as const };
      throw err;
    }
  });
}

export async function stepUpStatusAction(): Promise<ActionResult<{ verified: boolean; expiresAt: string | null; locked: boolean; windowMinutes: number }>> {
  return runAction(async () => {
    const u = await requireUser();
    const s = await stepUpStatus(u.id);
    return { ...s, expiresAt: s.expiresAt?.toISOString() ?? null };
  });
}

export async function verifyStepUpAction(password: string): Promise<ActionResult<{ verified: boolean; expiresAt: string | null }>> {
  return runAction(async () => {
    const s = await verifyStepUp(await actor(), z.string().min(1).max(1024).parse(password));
    return { verified: s.verified, expiresAt: s.expiresAt?.toISOString() ?? null };
  });
}

export async function generatePasswordAction(opts: { length?: number; upper?: boolean; lower?: boolean; digits?: boolean; symbols?: boolean; excludeAmbiguous?: boolean }): Promise<ActionResult<{ password: string; bits: number }>> {
  return runAction(async () => {
    await requireActionPermission("vault.use");
    const pw = generatePassword(opts);
    return { password: pw, bits: passwordStrengthBits(pw) };
  });
}

// ---- Admin: grants, categories, audit, maintenance ----
const grantSchema = z.object({
  userId: z.string().min(1),
  scope: z.enum(["all", "company"]),
  companyId: z.uuid().optional().nullable(),
  canList: z.boolean(),
  canViewUsername: z.boolean(),
  canReveal: z.boolean(),
  canCopy: z.boolean(),
  canCreate: z.boolean(),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  canAudit: z.boolean(),
  expiresAt: z.string().optional().nullable(),
});

export async function saveGrantAction(input: z.input<typeof grantSchema>, grantId?: string | null): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    await requireActionPermission("vault.admin");
    const id = await saveGrant(await actor(), grantSchema.parse(input), grantId ? z.uuid().parse(grantId) : null);
    revalidate();
    return { id: id! };
  });
}

export async function revokeGrantAction(grantId: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    await requireActionPermission("vault.admin");
    await revokeGrant(await actor(), z.uuid().parse(grantId));
    revalidate();
    return undefined;
  });
}

export async function createCategoryAction(_prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    await requireActionPermission("vault.admin");
    const id = await createCategory(await actor(), z.object({ name: z.string().trim().min(1, "Name is required").max(60), icon: z.string().trim().max(40).optional() }).parse({ name: fd.get("name"), icon: fd.get("icon") ?? undefined }));
    revalidate();
    return { id };
  });
}

export async function archiveCategoryAction(id: string, restore = false): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    await requireActionPermission("vault.admin");
    await archiveCategory(await actor(), z.string().min(1).parse(id), restore);
    revalidate();
    return undefined;
  });
}

export async function verifyAuditChainAction(): Promise<ActionResult<{ ok: boolean; checked: number; brokenAt: number | null }>> {
  return runAction(async () => {
    await requireActionPermission("vault.admin");
    const r = await verifyAuditChain(await actor());
    revalidate();
    return { ok: r.ok, checked: r.checked, brokenAt: r.brokenAt };
  });
}

export async function rewrapAllItemsAction(): Promise<ActionResult<{ rewrapped: number; keyVersion: number }>> {
  return runAction(async () => {
    await requireActionPermission("vault.admin");
    const r = await rewrapAllItems(await actor());
    revalidate();
    return r;
  });
}

export async function listItemHistoryAction(itemId: string, companyId: string): Promise<ActionResult<{ rows: { id: number; at: string; actorName: string | null; action: string; field: string | null; ipAddress: string | null; details: Record<string, unknown> | null }[] }>> {
  return runAction(async () => {
    const r = await listVaultAudit(await actor(), { companyId: z.uuid().parse(companyId), itemId: z.uuid().parse(itemId), pageSize: 100 });
    return { rows: r.rows.map((x) => ({ id: x.id, at: x.at.toISOString(), actorName: x.actorName, action: x.action, field: x.field, ipAddress: x.ipAddress, details: x.details })) };
  });
}

export async function saveVaultSettingsAction(_prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("vault.admin");
    const input = vaultSettingsSchema.parse(Object.fromEntries(["vaultRevealSeconds", "vaultClipboardSeconds", "vaultStepUpMinutes", "vaultReviewReminderDays", "vaultRevealLimit"].map((k) => [k, fd.get(k)])));
    await db.update(appSettings).set({ ...input, updatedAt: new Date() }).where(eq(appSettings.id, 1));
    await audit({ actorUserId: u.id, action: "vault.settings.update", entityType: "app_settings", entityId: "1", details: input });
    revalidate();
    return undefined;
  });
}
