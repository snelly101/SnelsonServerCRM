import { and, asc, eq, sql } from "drizzle-orm";

const dateOffset = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
import { db, type Tx } from "@/db";
import { checklistTemplateItems, checklistTemplates, onboardings, tasks, user } from "@/db/schema";
import { audit, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import type { z } from "zod";
import type { checklistTemplateSchema } from "@/lib/validation-sales";

// ---------------------------------------------------------------------------
// Checklist templates
// ---------------------------------------------------------------------------
export async function listTemplates() {
  const tpls = await db.select().from(checklistTemplates).where(eq(checklistTemplates.active, true)).orderBy(asc(checklistTemplates.name));
  const items = await db.select().from(checklistTemplateItems).orderBy(asc(checklistTemplateItems.sortOrder));
  return tpls.map((t) => ({ ...t, items: items.filter((i) => i.templateId === t.id) }));
}

export async function saveTemplate(input: z.infer<typeof checklistTemplateSchema>, actorUserId: string, id?: string) {
  return db.transaction(async (tx) => {
    if (input.isDefaultOnboarding) await tx.update(checklistTemplates).set({ isDefaultOnboarding: false });
    let templateId = id;
    if (id) {
      await tx.update(checklistTemplates).set({ name: input.name, description: input.description, isDefaultOnboarding: input.isDefaultOnboarding, updatedAt: new Date() }).where(eq(checklistTemplates.id, id));
      await tx.delete(checklistTemplateItems).where(eq(checklistTemplateItems.templateId, id));
    } else {
      const [row] = await tx.insert(checklistTemplates).values({ name: input.name, description: input.description, isDefaultOnboarding: input.isDefaultOnboarding }).returning({ id: checklistTemplates.id });
      templateId = row.id;
    }
    await tx.insert(checklistTemplateItems).values(input.items.map((it, i) => ({ templateId: templateId!, title: it.title, dueOffsetDays: it.dueOffsetDays, defaultOwnerRole: it.defaultOwnerRole, sortOrder: i })));
    await audit({ actorUserId, action: id ? "checklist_template.update" : "checklist_template.create", entityType: "checklist_template", entityId: templateId, details: { name: input.name, items: input.items.length } }, tx);
    return templateId!;
  });
}

export async function archiveTemplate(id: string, actorUserId: string) {
  await db.update(checklistTemplates).set({ active: false, isDefaultOnboarding: false }).where(eq(checklistTemplates.id, id));
  await audit({ actorUserId, action: "checklist_template.archive", entityType: "checklist_template", entityId: id });
}

// ---------------------------------------------------------------------------
// Onboardings
// ---------------------------------------------------------------------------
/**
 * Creates an onboarding and its tasks from the default template, exactly once
 * per `sourceKey`. A second call with the same key returns the existing id
 * and creates nothing. Safe under concurrent calls thanks to the unique index.
 */
export async function createOnboardingOnce(
  input: { companyId: string; opportunityId?: string | null; contractId?: string | null; sourceKey: string; name: string; ownerUserId?: string | null; templateId?: string | null },
  actorUserId: string | null,
  tx?: Tx,
): Promise<string> {
  const run = async (t: Tx) => {
    const [inserted] = await t
      .insert(onboardings)
      .values({ companyId: input.companyId, opportunityId: input.opportunityId ?? null, contractId: input.contractId ?? null, sourceKey: input.sourceKey, name: input.name, ownerUserId: input.ownerUserId ?? null, templateId: input.templateId ?? null })
      .onConflictDoNothing({ target: onboardings.sourceKey })
      .returning({ id: onboardings.id });
    if (!inserted) {
      const [existing] = await t.select({ id: onboardings.id }).from(onboardings).where(eq(onboardings.sourceKey, input.sourceKey)).limit(1);
      return existing.id;
    }
    // Resolve template: explicit, else the default.
    const [tpl] = input.templateId
      ? await t.select().from(checklistTemplates).where(eq(checklistTemplates.id, input.templateId)).limit(1)
      : await t.select().from(checklistTemplates).where(and(eq(checklistTemplates.isDefaultOnboarding, true), eq(checklistTemplates.active, true))).limit(1);
    if (tpl) {
      if (!input.templateId) await t.update(onboardings).set({ templateId: tpl.id }).where(eq(onboardings.id, inserted.id));
      const items = await t.select().from(checklistTemplateItems).where(eq(checklistTemplateItems.templateId, tpl.id)).orderBy(asc(checklistTemplateItems.sortOrder));
      // Assign each item to the first active user with the item's default role, if any.
      const roleOwners = new Map<string, string>();
      const users = await t.select({ id: user.id, role: user.role }).from(user).where(eq(user.active, true));
      for (const u of users) if (!roleOwners.has(u.role)) roleOwners.set(u.role, u.id);
      if (items.length) {
        await t.insert(tasks).values(
          items.map((it, i) => ({
            title: it.title,
            description: it.description,
            priority: "normal" as const,
            dueDate: dateOffset(it.dueOffsetDays),
            ownerUserId: (it.defaultOwnerRole && roleOwners.get(it.defaultOwnerRole)) || input.ownerUserId || null,
            companyId: input.companyId,
            opportunityId: input.opportunityId ?? null,
            onboardingId: inserted.id,
            sortOrder: i,
            sourceKey: `onboarding:${inserted.id}:${i}`,
            createdByUserId: actorUserId,
          })),
        );
      }
    }
    await audit({ actorUserId, action: "onboarding.create", entityType: "onboarding", entityId: inserted.id, details: { sourceKey: input.sourceKey, template: tpl?.name ?? null } }, t);
    await logActivity({ type: "task", companyId: input.companyId, entityType: "onboarding", entityId: inserted.id, title: `Onboarding started: ${input.name}`, actorUserId }, t);
    return inserted.id;
  };
  return tx ? run(tx) : db.transaction(run);
}

export async function getOnboarding(id: string) {
  const [row] = await db.select({ onboarding: onboardings, ownerName: user.name, templateName: checklistTemplates.name }).from(onboardings).leftJoin(user, eq(user.id, onboardings.ownerUserId)).leftJoin(checklistTemplates, eq(checklistTemplates.id, onboardings.templateId)).where(eq(onboardings.id, id)).limit(1);
  if (!row) return null;
  const items = await db.select({ task: tasks, ownerName: user.name }).from(tasks).leftJoin(user, eq(user.id, tasks.ownerUserId)).where(eq(tasks.onboardingId, id)).orderBy(asc(tasks.sortOrder));
  return { ...row.onboarding, ownerName: row.ownerName, templateName: row.templateName, items: items.map((i) => ({ ...i.task, ownerName: i.ownerName })) };
}

export async function listOnboardings(companyId?: string) {
  const rows = await db
    .select({
      onboarding: onboardings,
      ownerName: user.name,
      total: sql<number>`(select count(*) from tasks t where t.onboarding_id = onboardings.id)`.mapWith(Number),
      done: sql<number>`(select count(*) from tasks t where t.onboarding_id = onboardings.id and t.status = 'done')`.mapWith(Number),
    })
    .from(onboardings)
    .leftJoin(user, eq(user.id, onboardings.ownerUserId))
    .where(companyId ? eq(onboardings.companyId, companyId) : undefined)
    .orderBy(asc(onboardings.status), sql`${onboardings.startedAt} desc`);
  return rows.map((r) => ({ ...r.onboarding, ownerName: r.ownerName, total: r.total, done: r.done }));
}

export async function completeOnboarding(id: string, actorUserId: string) {
  const ob = await getOnboarding(id);
  if (!ob) throw new ActionError("Onboarding not found.");
  const open = ob.items.filter((i) => i.status === "open").length;
  if (open > 0) throw new ActionError(`${open} item${open === 1 ? "" : "s"} still open.`);
  await db.transaction(async (tx) => {
    await tx.update(onboardings).set({ status: "completed", completedAt: new Date(), updatedAt: new Date() }).where(eq(onboardings.id, id));
    await audit({ actorUserId, action: "onboarding.complete", entityType: "onboarding", entityId: id }, tx);
    await logActivity({ type: "task", companyId: ob.companyId, entityType: "onboarding", entityId: id, title: `Onboarding completed: ${ob.name}`, actorUserId }, tx);
  });
}
