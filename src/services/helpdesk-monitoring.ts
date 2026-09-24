import { and, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { tickets } from "@/db/schema";
import { getSystemStatus } from "@/lib/system-status";
import { OPEN_STATUSES } from "@/lib/validation-helpdesk";
import { mailboxHealth } from "./mailbox";

/**
 * Helpdesk facts for /api/health and the operations page. Pass/fail only,
 * never message content. "degraded" when the connected mailbox has a
 * subscription problem or stale inbound sync, when dead inbound rows or
 * unknown/failed outbox rows are waiting, or when the SLA job has not run
 * for half an hour while tickets are open.
 */
export async function helpdeskHealth() {
  const [mail, sla, rules, retention, [open]] = await Promise.all([
    mailboxHealth().catch(() => null),
    getSystemStatus<{ breaches: number; dueSoon: number }>("helpdesk.sla.last"),
    getSystemStatus<{ applied: number }>("helpdesk.rules.last"),
    getSystemStatus<Record<string, unknown>>("helpdesk.retention.last"),
    db
      .select({
        open: sql<number>`count(*)`.mapWith(Number),
        review: sql<number>`count(*) filter (where ${tickets.needsReview})`.mapWith(Number),
        breaching: sql<number>`count(*) filter (where ${tickets.firstResponseBreached} or ${tickets.resolutionBreached})`.mapWith(Number),
      })
      .from(tickets)
      .where(and(isNull(tickets.mergedIntoTicketId), inArray(tickets.status, OPEN_STATUSES))),
  ]);
  const problems: string[] = [];
  const mailbox = mail
    ? {
        status: mail.mailbox.status,
        live: mail.live,
        subscription: mail.subscriptionState,
        staleInbound: mail.live ? mail.staleInbound : false,
        inboundPending: mail.queue.pending,
        inboundDead: mail.queue.failed,
        outboxQueued: mail.outbox.queued,
        outboxUnknown: mail.outbox.unknown,
        outboxFailed: mail.outbox.failed,
        credentialExpiringSoon: Boolean(mail.credentialExpiringSoon),
      }
    : null;
  if (mailbox && mail?.live) {
    if (mailbox.subscription === "error" || mailbox.subscription === "expired" || mailbox.subscription === "missing")
      problems.push(`mailbox subscription ${mailbox.subscription}`);
    if (mailbox.staleInbound) problems.push("inbound sync stale");
    if (mailbox.status === "error" || mailbox.status === "expired") problems.push(`mailbox ${mailbox.status}`);
    if (mailbox.inboundDead > 0) problems.push(`${mailbox.inboundDead} dead inbound rows`);
    if (mailbox.outboxUnknown + mailbox.outboxFailed > 0)
      problems.push(`${mailbox.outboxUnknown + mailbox.outboxFailed} outbox rows need attention`);
  }
  const slaAge = sla ? Date.now() - sla.updatedAt.getTime() : null;
  if (open.open > 0 && (slaAge === null || slaAge > 30 * 60_000)) problems.push("SLA check has not run in 30 minutes");
  return {
    status: problems.length ? ("degraded" as const) : ("ok" as const),
    problems,
    tickets: { open: open.open, needsReview: open.review, breaching: open.breaching },
    mailbox,
    slaCheckedAt: sla?.updatedAt.toISOString() ?? null,
    rulesRanAt: rules?.updatedAt.toISOString() ?? null,
    retentionRanAt: retention?.updatedAt.toISOString() ?? null,
  };
}
