import { logger } from "@/lib/logger";
import type { Actor } from "./helpdesk";
import { notifyUsers, resolveMentions, ticketAudience } from "./helpdesk-notifications";

export type TicketTrigger =
  | "ticket_created"
  | "ticket_updated"
  | "customer_replied"
  | "agent_replied"
  | "status_changed";

/**
 * Runs after a ticket change has been committed: recompute the SLA clocks,
 * then evaluate automation rules for the trigger. Changes made by the
 * automation engine itself skip the rule pass (the engine chains follow-on
 * triggers with its own depth guard), which is what stops a rule that sets a
 * status from re-firing for ever. Failures are logged, never thrown: the
 * user's action already succeeded.
 *
 * Imports are dynamic so the core service, the SLA engine and the rule engine
 * can reference each other without a module cycle at load time.
 */
export async function afterTicketChange(
  ticketId: string,
  trigger: TicketTrigger,
  actor: Actor | null,
  reason: string,
) {
  try {
    const { recomputeTicketSla } = await import("./helpdesk-sla");
    await recomputeTicketSla(ticketId, reason);
  } catch (err) {
    logger.warn({ err, ticketId, reason }, "SLA recompute failed");
  }
  if (actor?.type === "automation") return;
  try {
    const { runAutomation } = await import("./helpdesk-automation");
    await runAutomation(trigger, ticketId);
  } catch (err) {
    logger.warn({ err, ticketId, trigger }, "automation run failed");
  }
}

/** Tells the new assignee (unless they assigned it to themselves). */
export async function notifyAssigned(
  ticketId: string,
  assigneeUserId: string | null | undefined,
  actor: Actor | null,
  reference: string,
  subject: string,
) {
  if (!assigneeUserId) return;
  await notifyUsers([assigneeUserId], {
    kind: "assigned",
    title: `${reference} assigned to you: ${subject}`,
    ticketId,
    actorUserId: actor?.id ?? null,
  }).catch((err) => logger.warn({ err, ticketId }, "assign notification failed"));
}

/** @mentions in a note plus followers/assignee for any message; the author is never told about their own message. */
export async function notifyMessage(
  ticketId: string,
  messageId: string,
  body: string,
  internal: boolean,
  actor: Actor | null,
  reference: string,
  subject: string,
) {
  try {
    const mentioned = await resolveMentions(body);
    if (mentioned.length)
      await notifyUsers(
        mentioned.map((m) => m.id),
        {
          kind: "mention",
          title: `You were mentioned on ${reference}: ${subject}`,
          body: body.slice(0, 300),
          ticketId,
          messageId,
          actorUserId: actor?.id ?? null,
        },
      );
    const audience = (await ticketAudience(ticketId)).filter(
      (u) => !mentioned.some((m) => m.id === u),
    );
    if (audience.length)
      await notifyUsers(audience, {
        kind: "followed_update",
        title: `${internal ? "Internal note" : "Message"} on ${reference}: ${subject}`,
        body: body.slice(0, 300),
        ticketId,
        messageId,
        actorUserId: actor?.id ?? null,
      });
  } catch (err) {
    logger.warn({ err, ticketId }, "message notification failed");
  }
}
