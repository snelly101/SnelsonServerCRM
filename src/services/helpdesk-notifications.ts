import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { ticketParticipants, tickets, user } from "@/db/schema";
import { helpdeskNotifications } from "@/db/schema/helpdesk-sla";

export type NotificationKind =
  | "mention"
  | "assigned"
  | "customer_replied"
  | "sla_due"
  | "sla_breached"
  | "followed_update"
  | "automation"
  | "bounce"
  | "checklist";

/** Writes one in-app notification per user (never to the actor themselves). Deduplicates same kind+ticket per user within 10 minutes. */
export async function notifyUsers(
  userIds: (string | null | undefined)[],
  input: {
    kind: NotificationKind;
    title: string;
    body?: string | null;
    ticketId?: string | null;
    messageId?: string | null;
    actorUserId?: string | null;
  },
) {
  const ids = [
    ...new Set(
      userIds.filter((u): u is string => Boolean(u) && u !== input.actorUserId),
    ),
  ];
  if (ids.length === 0) return 0;
  const recent = input.ticketId
    ? await db
        .select({ userId: helpdeskNotifications.userId })
        .from(helpdeskNotifications)
        .where(
          and(
            inArray(helpdeskNotifications.userId, ids),
            eq(helpdeskNotifications.kind, input.kind),
            eq(helpdeskNotifications.ticketId, input.ticketId),
            isNull(helpdeskNotifications.readAt),
            sql`${helpdeskNotifications.createdAt} > now() - interval '10 minutes'`,
          ),
        )
    : [];
  const skip = new Set(recent.map((r) => r.userId));
  const rows = ids
    .filter((u) => !skip.has(u))
    .map((userId) => ({
      userId,
      kind: input.kind,
      title: input.title.slice(0, 300),
      body: input.body?.slice(0, 1000) ?? null,
      ticketId: input.ticketId ?? null,
      messageId: input.messageId ?? null,
      actorUserId: input.actorUserId ?? null,
    }));
  if (rows.length) await db.insert(helpdeskNotifications).values(rows);
  return rows.length;
}

/** Everyone who should hear about a ticket change: assignee plus staff followers. */
export async function ticketAudience(ticketId: string) {
  const [t] = await db
    .select({ assigneeUserId: tickets.assigneeUserId })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  const followers = await db
    .select({ userId: ticketParticipants.userId })
    .from(ticketParticipants)
    .where(
      and(
        eq(ticketParticipants.ticketId, ticketId),
        eq(ticketParticipants.role, "follower"),
      ),
    );
  return [
    ...new Set(
      [t?.assigneeUserId ?? null, ...followers.map((f) => f.userId)].filter(
        (x): x is string => Boolean(x),
      ),
    ),
  ];
}

/** Finds @mentions in a note: `@Terry`, `@Terry Tech`, `@terry.tech` matched against active users (unique prefix of the name or the e-mail local part). */
export async function resolveMentions(text: string) {
  const tokens = [
    ...text.matchAll(/(^|[\s(])@([A-Za-z][\w.'-]*(?:\s[A-Z][\w'-]*)?)/g),
  ].map((m) => m[2].trim());
  if (tokens.length === 0) return [];
  const users = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.active, true));
  const found = new Map<string, { id: string; name: string }>();
  for (const raw of tokens) {
    const candidates = [raw, raw.split(/\s/)[0]];
    for (const tok of candidates) {
      const lower = tok.toLowerCase().replace(/[.,;:!?]+$/, "");
      const matches = users.filter(
        (u) =>
          u.name.toLowerCase() === lower ||
          u.name.toLowerCase().startsWith(lower) ||
          u.email.split("@")[0].toLowerCase() === lower ||
          u.name.toLowerCase().replace(/\s+/g, ".") === lower,
      );
      if (matches.length === 1) {
        found.set(matches[0].id, { id: matches[0].id, name: matches[0].name });
        break;
      }
    }
  }
  return [...found.values()];
}

export async function unreadCount(userId: string) {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(helpdeskNotifications)
    .where(
      and(
        eq(helpdeskNotifications.userId, userId),
        isNull(helpdeskNotifications.readAt),
      ),
    );
  return n;
}
export async function listNotifications(userId: string, limit = 50) {
  return db
    .select({
      n: helpdeskNotifications,
      ticketNumber: tickets.number,
      ticketSubject: tickets.subject,
      actorName: user.name,
    })
    .from(helpdeskNotifications)
    .leftJoin(tickets, eq(tickets.id, helpdeskNotifications.ticketId))
    .leftJoin(user, eq(user.id, helpdeskNotifications.actorUserId))
    .where(eq(helpdeskNotifications.userId, userId))
    .orderBy(desc(helpdeskNotifications.createdAt))
    .limit(limit)
    .then((rows) =>
      rows.map((r) => ({
        ...r.n,
        ticketNumber: r.ticketNumber,
        ticketSubject: r.ticketSubject,
        actorName: r.actorName,
      })),
    );
}
export async function markNotificationsRead(
  userId: string,
  ids: string[] | "all",
) {
  await db
    .update(helpdeskNotifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(helpdeskNotifications.userId, userId),
        isNull(helpdeskNotifications.readAt),
        ids === "all" ? undefined : inArray(helpdeskNotifications.id, ids),
      ),
    );
}
