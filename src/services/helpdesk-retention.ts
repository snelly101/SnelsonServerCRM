import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  mailboxInboundQueue,
  mailboxOutbox,
  ticketAttachments,
  ticketDrafts,
  ticketMessages,
  ticketParticipants,
  tickets,
} from "@/db/schema";
import { helpdeskAutomationRuns, helpdeskNotifications } from "@/db/schema/helpdesk-sla";
import { audit } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { deleteAttachmentBytes } from "@/lib/email/storage";
import { logger } from "@/lib/logger";
import { setSystemStatus } from "@/lib/system-status";
import { ticketReference } from "@/lib/validation-helpdesk";
import { recordEvent, type Actor } from "./helpdesk";

/**
 * Helpdesk retention (documented in docs/helpdesk-operations.md):
 *  - inbound queue rows that finished (done/skipped/dead) and outbox rows that
 *    finished (accepted/cancelled/failed): 90 days
 *  - read notifications and automation run logs: 90 days
 *  - abandoned drafts: 30 days after their last save
 *  - closed or cancelled tickets: anonymised after HELPDESK_ANONYMISE_AFTER_DAYS
 *    (0 or unset = never); anonymising removes the requester's identity,
 *    participants, message addresses and attachments while keeping the
 *    conversation text, events and time so reports stay honest.
 * Tickets are never deleted by a job.
 */
export const HELPDESK_RETENTION = {
  queueDays: 90,
  notificationDays: 90,
  automationRunDays: 90,
  draftDays: 30,
  anonymiseAfterDays: Math.max(0, Number(process.env.HELPDESK_ANONYMISE_AFTER_DAYS ?? 0) || 0),
} as const;

const ANON_NAME = "Anonymised requester";
const ANON_EMAIL_DOMAIN = "anonymised.invalid";

export async function anonymiseTicket(ticketId: string, actor: Actor, reason: string) {
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!t) throw new ActionError("Ticket not found.");
  if (t.anonymizedAt) return { changed: false };
  if (!["closed", "cancelled", "resolved"].includes(t.status) && actor.type !== "user")
    throw new ActionError("Only closed, cancelled or resolved tickets are anonymised automatically.");
  const anonEmail = `ticket-${t.number}@${ANON_EMAIL_DOMAIN}`;
  const attachments = await db
    .select({ id: ticketAttachments.id, storagePath: ticketAttachments.storagePath })
    .from(ticketAttachments)
    .where(eq(ticketAttachments.ticketId, ticketId));
  await db.transaction(async (tx) => {
    await tx
      .update(tickets)
      .set({
        requesterName: ANON_NAME,
        requesterEmail: anonEmail,
        requesterNormalizedEmail: anonEmail,
        requesterContactId: null,
        requesterUnverified: false,
        anonymizedAt: new Date(),
        customFields: {},
      })
      .where(eq(tickets.id, ticketId));
    await tx.delete(ticketParticipants).where(and(eq(ticketParticipants.ticketId, ticketId), sql`${ticketParticipants.role} <> 'follower'`));
    await tx
      .update(ticketMessages)
      .set({
        // Inbound messages carry the requester (even when a staff member logged
        // them); outbound ones carry the mailbox or the agent, which stay.
        fromName: sql`case when ${ticketMessages.direction} = 'inbound' then ${ANON_NAME} else ${ticketMessages.fromName} end`,
        fromEmail: sql`case when ${ticketMessages.direction} = 'inbound' then ${anonEmail} else ${ticketMessages.fromEmail} end`,
        toRecipients: [],
        ccRecipients: [],
        bccRecipients: [],
        bodyHtml: null,
        quotedText: null,
        metadata: sql`coalesce(${ticketMessages.metadata}, '{}'::jsonb) || '{"anonymised": true}'::jsonb`,
      })
      .where(eq(ticketMessages.ticketId, ticketId));
    await tx.delete(ticketAttachments).where(eq(ticketAttachments.ticketId, ticketId));
    await tx.delete(ticketDrafts).where(eq(ticketDrafts.ticketId, ticketId));
    await recordEvent(ticketId, "anonymised", `Requester identity, addresses and attachments removed (${reason})`, actor, { attachments: attachments.length }, tx);
    await audit(
      {
        actorUserId: actor.id,
        actorType: actor.id ? "user" : "system",
        action: "ticket.anonymise",
        entityType: "ticket",
        entityId: ticketId,
        details: { reference: ticketReference(t.number), reason, attachments: attachments.length },
      },
      tx,
    );
  });
  for (const a of attachments) if (a.storagePath) await deleteAttachmentBytes(a.storagePath).catch(() => undefined);
  return { changed: true, attachments: attachments.length };
}

/** Anonymises every ticket by this contact's e-mail (a data-subject request). Open tickets are included on purpose. */
export async function anonymiseByEmail(email: string, actor: Actor) {
  const norm = email.trim().toLowerCase();
  if (!norm) throw new ActionError("E-mail is required.");
  const rows = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.requesterNormalizedEmail, norm), isNull(tickets.anonymizedAt)));
  let done = 0;
  for (const r of rows) {
    const res = await anonymiseTicket(r.id, actor, `data-subject request for ${norm}`);
    if (res.changed) done++;
  }
  return { tickets: done };
}

export async function runHelpdeskRetention() {
  const now = Date.now();
  const queueBefore = new Date(now - HELPDESK_RETENTION.queueDays * 86400000);
  const notifBefore = new Date(now - HELPDESK_RETENTION.notificationDays * 86400000);
  const runsBefore = new Date(now - HELPDESK_RETENTION.automationRunDays * 86400000);
  const draftsBefore = new Date(now - HELPDESK_RETENTION.draftDays * 86400000);
  const inbound = await db
    .delete(mailboxInboundQueue)
    .where(and(inArray(mailboxInboundQueue.status, ["done", "skipped", "dead"]), lt(mailboxInboundQueue.receivedAt, queueBefore)))
    .returning({ id: mailboxInboundQueue.id });
  const outbox = await db
    .delete(mailboxOutbox)
    .where(and(inArray(mailboxOutbox.status, ["accepted", "cancelled", "failed"]), lt(mailboxOutbox.updatedAt, queueBefore)))
    .returning({ id: mailboxOutbox.id });
  const notifications = await db
    .delete(helpdeskNotifications)
    .where(and(isNotNull(helpdeskNotifications.readAt), lt(helpdeskNotifications.createdAt, notifBefore)))
    .returning({ id: helpdeskNotifications.id });
  const runs = await db.delete(helpdeskAutomationRuns).where(lt(helpdeskAutomationRuns.at, runsBefore)).returning({ id: helpdeskAutomationRuns.id });
  const drafts = await db.delete(ticketDrafts).where(lt(ticketDrafts.updatedAt, draftsBefore)).returning({ id: ticketDrafts.ticketId });
  let anonymised = 0;
  if (HELPDESK_RETENTION.anonymiseAfterDays > 0) {
    const cutoff = new Date(now - HELPDESK_RETENTION.anonymiseAfterDays * 86400000);
    const due = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          inArray(tickets.status, ["closed", "cancelled"]),
          isNull(tickets.anonymizedAt),
          sql`coalesce(${tickets.closedAt}, ${tickets.updatedAt}) < ${cutoff}`,
        ),
      )
      .limit(500);
    for (const t of due) {
      try {
        const r = await anonymiseTicket(t.id, { id: null, type: "system" }, `retention after ${HELPDESK_RETENTION.anonymiseAfterDays} days`);
        if (r.changed) anonymised++;
      } catch (err) {
        logger.warn({ err, ticketId: t.id }, "anonymisation failed");
      }
    }
  }
  const result = {
    inboundDeleted: inbound.length,
    outboxDeleted: outbox.length,
    notificationsDeleted: notifications.length,
    automationRunsDeleted: runs.length,
    draftsDeleted: drafts.length,
    ticketsAnonymised: anonymised,
    at: new Date().toISOString(),
  };
  await setSystemStatus("helpdesk.retention.last", result);
  logger.info(result, "helpdesk retention run");
  return result;
}
