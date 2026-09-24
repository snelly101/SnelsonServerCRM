import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { appSettings, customFieldDefs, tags, savedViews } from "@/db/schema";
import { audit } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import type { appSettingsSchema, customFieldDefSchema, tagSchema, savedViewSchema, securitySettingsSchema } from "@/lib/validation";

export async function updateAppSettings(input: z.infer<typeof appSettingsSchema>, actorUserId: string) {
  await db.transaction(async (tx) => {
    await tx
      .update(appSettings)
      .set({ ...input, defaultTaxRatePercent: String(input.defaultTaxRatePercent), updatedAt: new Date() })
      .where(eq(appSettings.id, 1));
    await audit({ actorUserId, action: "settings.update", entityType: "app_settings", entityId: "1", details: input }, tx);
  });
}

/** Settings → Security: which roles must use a second factor and from when. */
export async function updateSecuritySettings(input: z.infer<typeof securitySettingsSchema>, actorUserId: string) {
  await db.transaction(async (tx) => {
    await tx.update(appSettings).set({ twoFactorRequiredRoles: input.twoFactorRequiredRoles, twoFactorDeadline: input.twoFactorDeadline, updatedAt: new Date() }).where(eq(appSettings.id, 1));
    await audit({ actorUserId, action: "settings.security.update", entityType: "app_settings", entityId: "1", details: input }, tx);
  });
}

export async function createTag(input: z.infer<typeof tagSchema>, actorUserId: string) {
  const [row] = await db.insert(tags).values(input).onConflictDoNothing().returning({ id: tags.id });
  if (!row) throw new ActionError("A tag with that name already exists.", { name: ["Already exists"] });
  await audit({ actorUserId, action: "tag.create", entityType: "tag", entityId: row.id, details: input });
  return row.id;
}

export async function deleteTag(id: string, actorUserId: string) {
  await db.delete(tags).where(eq(tags.id, id));
  await audit({ actorUserId, action: "tag.delete", entityType: "tag", entityId: id });
}

export async function listCustomFieldDefs(entity?: "company" | "contact" | "opportunity") {
  const q = db.select().from(customFieldDefs).orderBy(asc(customFieldDefs.sortOrder), asc(customFieldDefs.label));
  return entity ? q.where(eq(customFieldDefs.entity, entity)) : q;
}

export async function createCustomFieldDef(input: z.infer<typeof customFieldDefSchema>, actorUserId: string) {
  const [row] = await db
    .insert(customFieldDefs)
    .values({ ...input, options: input.type === "select" ? input.options : null })
    .onConflictDoNothing()
    .returning({ id: customFieldDefs.id });
  if (!row) throw new ActionError("A field with that key already exists for this entity.", { key: ["Already exists"] });
  await audit({ actorUserId, action: "custom_field.create", entityType: "custom_field", entityId: row.id, details: input });
  return row.id;
}

export async function deleteCustomFieldDef(id: string, actorUserId: string) {
  await db.delete(customFieldDefs).where(eq(customFieldDefs.id, id));
  await audit({ actorUserId, action: "custom_field.delete", entityType: "custom_field", entityId: id });
}

/**
 * Validates custom field values against the definitions for an entity.
 * Unknown keys are dropped; typed values are coerced.
 */
export async function validateCustomFields(entity: "company" | "contact" | "opportunity", raw: Record<string, unknown>) {
  const defs = await listCustomFieldDefs(entity);
  const out: Record<string, unknown> = {};
  const errors: Record<string, string[]> = {};
  for (const def of defs) {
    const v = raw[def.key];
    const empty = v === undefined || v === null || v === "";
    if (empty) {
      if (def.required) errors[`customFields.${def.key}`] = [`${def.label} is required`];
      continue;
    }
    switch (def.type) {
      case "number": {
        const n = Number(v);
        if (!Number.isFinite(n)) errors[`customFields.${def.key}`] = [`${def.label} must be a number`];
        else out[def.key] = n;
        break;
      }
      case "boolean":
        out[def.key] = v === true || v === "true" || v === "on";
        break;
      case "date": {
        const d = new Date(String(v));
        if (Number.isNaN(d.getTime())) errors[`customFields.${def.key}`] = [`${def.label} must be a date`];
        else out[def.key] = d.toISOString().slice(0, 10);
        break;
      }
      case "select":
        if (def.options && !def.options.includes(String(v))) errors[`customFields.${def.key}`] = [`${def.label} must be one of: ${def.options.join(", ")}`];
        else out[def.key] = String(v);
        break;
      default:
        out[def.key] = String(v).slice(0, 2000);
    }
  }
  if (Object.keys(errors).length) throw new ActionError("Please correct the highlighted fields.", errors);
  return out;
}

export async function listSavedViews(userId: string, page: string) {
  return db
    .select()
    .from(savedViews)
    .where(eq(savedViews.page, page))
    .orderBy(asc(savedViews.name))
    .then((rows) => rows.filter((r) => r.userId === userId || r.isShared));
}

export async function createSavedView(input: z.infer<typeof savedViewSchema>, userId: string) {
  const [row] = await db.insert(savedViews).values({ ...input, userId }).returning({ id: savedViews.id });
  return row.id;
}

export async function deleteSavedView(id: string, userId: string) {
  const [row] = await db.select({ userId: savedViews.userId }).from(savedViews).where(eq(savedViews.id, id)).limit(1);
  if (!row) return;
  if (row.userId !== userId) throw new ActionError("You can only delete your own saved views.");
  await db.delete(savedViews).where(eq(savedViews.id, id));
}
