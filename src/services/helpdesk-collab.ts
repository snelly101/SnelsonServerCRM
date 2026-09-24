import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { tickets, user, companies, contacts } from "@/db/schema";
import {
  helpdeskTemplates,
  ticketChecklistItems,
} from "@/db/schema/helpdesk-sla";
import { audit } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { ticketReference } from "@/lib/validation-helpdesk";
import { recordEvent, type Actor } from "./helpdesk";
import { notifyUsers } from "./helpdesk-notifications";

// ---------------------------------------------------------------------------
// Response templates
// ---------------------------------------------------------------------------
export type TemplateScope = "public" | "internal" | "both";

export async function listTemplates(opts: { activeOnly?: boolean } = {}) {
  return db
    .select()
    .from(helpdeskTemplates)
    .where(opts.activeOnly ? eq(helpdeskTemplates.active, true) : undefined)
    .orderBy(asc(helpdeskTemplates.category), asc(helpdeskTemplates.name));
}

export async function saveTemplate(
  id: string | null,
  input: {
    name: string;
    scope: TemplateScope;
    subject: string | null;
    body: string;
    category: string | null;
    active: boolean;
  },
  actorUserId: string,
) {
  if (id)
    await db
      .update(helpdeskTemplates)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(helpdeskTemplates.id, id));
  else
    id = (
      await db
        .insert(helpdeskTemplates)
        .values({ ...input, createdByUserId: actorUserId })
        .returning({ id: helpdeskTemplates.id })
    )[0].id;
  await audit({
    actorUserId,
    action: "helpdesk.template.save",
    entityType: "helpdesk_template",
    entityId: id,
    details: { name: input.name, scope: input.scope },
  });
  return id;
}

export async function deleteTemplate(id: string, actorUserId: string) {
  await db.delete(helpdeskTemplates).where(eq(helpdeskTemplates.id, id));
  await audit({
    actorUserId,
    action: "helpdesk.template.delete",
    entityType: "helpdesk_template",
    entityId: id,
  });
}

/** Placeholders a template may use; unknown ones are left as typed so nothing silently disappears. */
export const TEMPLATE_PLACEHOLDERS = [
  "requester.first_name",
  "requester.name",
  "company.name",
  "ticket.reference",
  "ticket.subject",
  "agent.name",
] as const;

export async function renderTemplate(
  body: string,
  ticketId: string,
  agentUserId: string | null,
) {
  const [t] = await db
    .select({
      number: tickets.number,
      subject: tickets.subject,
      requesterName: tickets.requesterName,
      companyName: companies.name,
      contactFirst: contacts.firstName,
    })
    .from(tickets)
    .leftJoin(companies, eq(companies.id, tickets.companyId))
    .leftJoin(contacts, eq(contacts.id, tickets.requesterContactId))
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!t) throw new ActionError("Ticket not found.");
  const [agent] = agentUserId
    ? await db
        .select({ name: user.name })
        .from(user)
        .where(eq(user.id, agentUserId))
        .limit(1)
    : [];
  const requesterName = t.requesterName ?? "";
  const values: Record<(typeof TEMPLATE_PLACEHOLDERS)[number], string> = {
    "requester.first_name":
      t.contactFirst ?? requesterName.split(/\s+/)[0] ?? "",
    "requester.name": requesterName,
    "company.name": t.companyName ?? "",
    "ticket.reference": ticketReference(t.number),
    "ticket.subject": t.subject,
    "agent.name": agent?.name ?? "",
  };
  return body.replace(/\{\{\s*([a-z_.]+)\s*\}\}/g, (m, key: string) =>
    key in values ? values[key as keyof typeof values] : m,
  );
}

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------
export async function listChecklist(ticketId: string) {
  return db
    .select({ i: ticketChecklistItems, assigneeName: user.name })
    .from(ticketChecklistItems)
    .leftJoin(user, eq(user.id, ticketChecklistItems.assigneeUserId))
    .where(eq(ticketChecklistItems.ticketId, ticketId))
    .orderBy(asc(ticketChecklistItems.sortOrder), asc(ticketChecklistItems.createdAt))
    .then((rows) => rows.map((r) => ({ ...r.i, assigneeName: r.assigneeName })));
}

export async function addChecklistItems(
  ticketId: string,
  titles: string[],
  actor: Actor,
  opts: { assigneeUserId?: string | null; dueDate?: string | null } = {},
) {
  const clean = titles.map((t) => t.trim()).filter(Boolean).slice(0, 50);
  if (clean.length === 0) throw new ActionError("Enter at least one item.");
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${ticketChecklistItems.sortOrder}), -1)`.mapWith(Number) })
    .from(ticketChecklistItems)
    .where(eq(ticketChecklistItems.ticketId, ticketId));
  const rows = await db
    .insert(ticketChecklistItems)
    .values(
      clean.map((title, i) => ({
        ticketId,
        title: title.slice(0, 300),
        sortOrder: max + 1 + i,
        assigneeUserId: opts.assigneeUserId ?? null,
        dueDate: opts.dueDate ?? null,
        createdByUserId: actor.id,
      })),
    )
    .returning({ id: ticketChecklistItems.id });
  await recordEvent(
    ticketId,
    "checklist",
    `${clean.length} checklist item${clean.length === 1 ? "" : "s"} added`,
    actor,
    { titles: clean },
  );
  if (opts.assigneeUserId) {
    const [t] = await db
      .select({ number: tickets.number, subject: tickets.subject })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);
    if (t)
      await notifyUsers([opts.assigneeUserId], {
        kind: "checklist",
        title: `Checklist item${clean.length === 1 ? "" : "s"} for you on ${ticketReference(t.number)}: ${clean[0]}`,
        ticketId,
        actorUserId: actor.id,
      });
  }
  return rows.map((r) => r.id);
}

export async function toggleChecklistItem(
  ticketId: string,
  itemId: string,
  done: boolean,
  actor: Actor,
) {
  const [item] = await db
    .select()
    .from(ticketChecklistItems)
    .where(
      and(eq(ticketChecklistItems.id, itemId), eq(ticketChecklistItems.ticketId, ticketId)),
    )
    .limit(1);
  if (!item) throw new ActionError("Checklist item not found.");
  if (item.done === done) return;
  await db
    .update(ticketChecklistItems)
    .set({
      done,
      doneAt: done ? new Date() : null,
      doneByUserId: done ? actor.id : null,
      updatedAt: new Date(),
    })
    .where(eq(ticketChecklistItems.id, itemId));
  await recordEvent(
    ticketId,
    "checklist",
    `${done ? "Completed" : "Reopened"} checklist item: ${item.title}`,
    actor,
    { itemId, done },
  );
}

export async function updateChecklistItem(
  ticketId: string,
  itemId: string,
  patch: { title?: string; assigneeUserId?: string | null; dueDate?: string | null },
  actor: Actor,
) {
  const [item] = await db
    .select({ id: ticketChecklistItems.id, assigneeUserId: ticketChecklistItems.assigneeUserId })
    .from(ticketChecklistItems)
    .where(
      and(eq(ticketChecklistItems.id, itemId), eq(ticketChecklistItems.ticketId, ticketId)),
    )
    .limit(1);
  if (!item) throw new ActionError("Checklist item not found.");
  await db
    .update(ticketChecklistItems)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(ticketChecklistItems.id, itemId));
  if (patch.assigneeUserId && patch.assigneeUserId !== item.assigneeUserId) {
    const [t] = await db
      .select({ number: tickets.number })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);
    if (t)
      await notifyUsers([patch.assigneeUserId], {
        kind: "checklist",
        title: `Checklist item assigned to you on ${ticketReference(t.number)}`,
        body: patch.title ?? null,
        ticketId,
        actorUserId: actor.id,
      });
  }
}

export async function deleteChecklistItem(
  ticketId: string,
  itemId: string,
  actor: Actor,
) {
  const [item] = await db
    .delete(ticketChecklistItems)
    .where(
      and(eq(ticketChecklistItems.id, itemId), eq(ticketChecklistItems.ticketId, ticketId)),
    )
    .returning({ title: ticketChecklistItems.title });
  if (item)
    await recordEvent(ticketId, "checklist", `Checklist item removed: ${item.title}`, actor, {
      itemId,
    });
}

/** Resolving with open checklist items is allowed but the agent is told. */
export async function openChecklistCount(ticketId: string) {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(ticketChecklistItems)
    .where(and(eq(ticketChecklistItems.ticketId, ticketId), eq(ticketChecklistItems.done, false)));
  return n;
}
