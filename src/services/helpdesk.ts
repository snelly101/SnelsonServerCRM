import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
  count,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type Tx } from "@/db";
import {
  companies,
  contacts,
  helpdeskCategories,
  helpdeskTeamMembers,
  helpdeskTeams,
  ticketAttachments,
  ticketDrafts,
  ticketEvents,
  ticketLinks,
  ticketMessages,
  ticketParticipants,
  ticketTimeEntries,
  ticketTimers,
  tickets,
  user,
} from "@/db/schema";
import { audit, diffFields, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { normalizeEmail } from "@/lib/utils";
import { markdownToHtml, markdownToPlainText } from "@/lib/markdown-parse";
import { validateCustomFields } from "./settings";
import {
  findTicketReferences,
  OPEN_STATUSES,
  ticketReference,
  TICKET_STATUS_LABELS,
  type TicketCreateInput,
  type TicketFieldsInput,
  type TicketMessageInput,
  type TicketPriority,
  type TicketStatus,
  type TicketView,
} from "@/lib/validation-helpdesk";

export type Ticket = typeof tickets.$inferSelect;
export type TicketMessage = typeof ticketMessages.$inferSelect;
export type Actor = {
  id: string | null;
  type?: "user" | "system" | "automation" | "email";
};
const SYSTEM: Actor = { id: null, type: "system" };

import { canTransition, TRANSITIONS } from "@/lib/helpdesk-transitions";
export { canTransition, TRANSITIONS };

// ---------------------------------------------------------------------------
// Events and helpers
// ---------------------------------------------------------------------------
export async function recordEvent(
  ticketId: string,
  kind: string,
  summary: string,
  actor: Actor,
  details?: Record<string, unknown>,
  tx: Tx | typeof db = db,
) {
  await tx.insert(ticketEvents).values({
    ticketId,
    kind,
    summary,
    actorType: actor.type ?? (actor.id ? "user" : "system"),
    actorUserId: actor.id,
    details,
  });
  await tx
    .update(tickets)
    .set({ lastActivityAt: new Date(), updatedAt: new Date() })
    .where(eq(tickets.id, ticketId));
}

async function bumpVersion(
  ticketId: string,
  expected: number | undefined,
  tx: Tx | typeof db = db,
) {
  const res = await tx
    .update(tickets)
    .set({ version: sql`${tickets.version} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(tickets.id, ticketId),
        expected ? eq(tickets.version, expected) : undefined,
      ),
    )
    .returning({ version: tickets.version });
  if (res.length === 0)
    throw new ActionError(
      "Someone else changed this ticket while you were editing it. Reload to see their changes, then try again.",
    );
  return res[0].version;
}

async function resolveRequester(input: {
  requesterContactId: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
  companyId: string | null;
}) {
  if (input.requesterContactId) {
    const [c] = await db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        companyId: contacts.companyId,
      })
      .from(contacts)
      .where(eq(contacts.id, input.requesterContactId))
      .limit(1);
    if (!c) throw new ActionError("Contact not found.");
    return {
      contactId: c.id,
      name: `${c.firstName} ${c.lastName}`.trim(),
      email: c.email?.toLowerCase() ?? null,
      companyId: input.companyId ?? c.companyId,
      unverified: false,
    };
  }
  // A known address on an existing contact links automatically; never infer the company from the domain alone.
  const norm = normalizeEmail(input.requesterEmail);
  if (norm) {
    const [c] = await db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        companyId: contacts.companyId,
      })
      .from(contacts)
      .where(
        and(eq(contacts.normalizedEmail, norm), isNull(contacts.archivedAt)),
      )
      .limit(1);
    if (c)
      return {
        contactId: c.id,
        name: input.requesterName ?? `${c.firstName} ${c.lastName}`.trim(),
        email: norm,
        companyId: input.companyId ?? c.companyId,
        unverified: false,
      };
  }
  return {
    contactId: null,
    name: input.requesterName,
    email: norm,
    companyId: input.companyId,
    unverified: Boolean(norm) && !input.companyId,
  };
}

async function assertAssignee(userId: string | null) {
  if (!userId) return null;
  const [u] = await db
    .select({ id: user.id, name: user.name, active: user.active })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!u || !u.active)
    throw new ActionError("That user cannot be assigned tickets.");
  return u;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export async function createTicket(
  input: TicketCreateInput,
  actor: Actor,
  opts: {
    source?: "email" | "manual" | "portal";
    initialMessage?: Omit<typeof ticketMessages.$inferInsert, "ticketId">;
    needsReview?: string | null;
  } = {},
) {
  const requester = await resolveRequester(input);
  await assertAssignee(input.assigneeUserId);
  const customFields = (await validateCustomFields(
    "ticket",
    input.customFields ?? {},
  )) as Record<string, unknown>;
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(tickets)
      .values({
        subject: input.subject,
        description: input.description,
        priority: input.priority,
        type: input.type,
        source: opts.source ?? "manual",
        categoryId: input.categoryId,
        subcategoryId: input.subcategoryId,
        tags: input.tags ?? [],
        requesterName: requester.name,
        requesterEmail: requester.email,
        requesterNormalizedEmail: requester.email,
        requesterContactId: requester.contactId,
        requesterUnverified: requester.unverified,
        companyId: requester.companyId,
        assigneeUserId: input.assigneeUserId,
        teamId: input.teamId,
        needsReview: Boolean(opts.needsReview),
        reviewReason: opts.needsReview ?? null,
        customFields,
        createdByUserId: actor.id,
        status: "new",
      })
      .returning({ id: tickets.id, number: tickets.number });
    if (requester.email || requester.contactId)
      await tx
        .insert(ticketParticipants)
        .values({
          ticketId: row.id,
          role: "requester",
          name: requester.name,
          email: requester.email,
          normalizedEmail: requester.email,
          contactId: requester.contactId,
        })
        .onConflictDoNothing();
    if (opts.initialMessage)
      await tx
        .insert(ticketMessages)
        .values({ ...opts.initialMessage, ticketId: row.id });
    else if (input.description)
      await tx.insert(ticketMessages).values({
        ticketId: row.id,
        kind: "public",
        channel: "manual",
        direction: "inbound",
        authorUserId: actor.id,
        fromName: requester.name,
        fromEmail: requester.email,
        subject: input.subject,
        bodyMarkdown: input.description,
        bodyText: markdownToPlainText(input.description),
        metadata: { initial: true },
      });
    await recordEvent(
      row.id,
      "created",
      `Ticket ${ticketReference(row.number)} created (${opts.source ?? "manual"})`,
      actor,
      { source: opts.source ?? "manual" },
      tx,
    );
    if (requester.companyId)
      await logActivity(
        {
          type: "ticket",
          companyId: requester.companyId,
          contactId: requester.contactId,
          entityType: "ticket",
          entityId: row.id,
          title: `Ticket ${ticketReference(row.number)} opened: ${input.subject}`,
          actorUserId: actor.id,
          source: actor.type === "email" ? "helpdesk-email" : "user",
        },
        tx,
      );
    await audit(
      {
        actorUserId: actor.id,
        actorType: actor.id ? "user" : "system",
        action: "ticket.create",
        entityType: "ticket",
        entityId: row.id,
        details: {
          reference: ticketReference(row.number),
          source: opts.source ?? "manual",
        },
      },
      tx,
    );
    return row.id;
  });
  return id;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
const assignee = alias(user, "assignee");
const creator = alias(user, "creator");

export type TicketListParams = {
  view?: TicketView;
  q?: string;
  status?: string;
  priority?: string;
  type?: string;
  assigneeUserId?: string;
  teamId?: string;
  categoryId?: string;
  companyId?: string;
  contactId?: string;
  tag?: string;
  sort?: string;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  /** The signed-in user, for "my" views and team membership. */
  me?: { id: string; teamIds?: string[] };
};

function listWhere(p: TicketListParams): SQL | undefined {
  const conds: (SQL | undefined)[] = [isNull(tickets.mergedIntoTicketId)];
  const view = p.view ?? "open";
  if (view === "my")
    conds.push(
      or(
        eq(tickets.assigneeUserId, p.me?.id ?? ""),
        p.me?.teamIds?.length
          ? and(
              isNull(tickets.assigneeUserId),
              inArray(tickets.teamId, p.me.teamIds),
            )
          : undefined,
      ),
      inArray(tickets.status, OPEN_STATUSES),
    );
  else if (view === "unassigned")
    conds.push(
      isNull(tickets.assigneeUserId),
      inArray(tickets.status, OPEN_STATUSES),
    );
  else if (view === "open") conds.push(inArray(tickets.status, OPEN_STATUSES));
  else if (view === "awaiting_customer")
    conds.push(eq(tickets.status, "awaiting_customer"));
  else if (view === "awaiting_third_party")
    conds.push(eq(tickets.status, "awaiting_third_party"));
  else if (view === "overdue")
    conds.push(
      inArray(tickets.status, OPEN_STATUSES),
      or(
        and(
          isNull(tickets.firstResponseAt),
          lt(tickets.firstResponseDueAt, sql`now()`),
        ),
        lt(tickets.resolutionDueAt, sql`now()`),
        eq(tickets.firstResponseBreached, true),
        eq(tickets.resolutionBreached, true),
      ),
    );
  else if (view === "recent")
    conds.push(gte(tickets.lastActivityAt, sql`now() - interval '7 days'`));
  else if (view === "resolved")
    conds.push(inArray(tickets.status, ["resolved", "closed"]));
  else if (view === "review") conds.push(eq(tickets.needsReview, true));
  if (p.status) conds.push(eq(tickets.status, p.status as TicketStatus));
  if (p.priority)
    conds.push(eq(tickets.priority, p.priority as TicketPriority));
  if (p.type) conds.push(eq(tickets.type, p.type as Ticket["type"]));
  if (p.assigneeUserId)
    conds.push(
      p.assigneeUserId === "unassigned"
        ? isNull(tickets.assigneeUserId)
        : eq(tickets.assigneeUserId, p.assigneeUserId),
    );
  if (p.teamId) conds.push(eq(tickets.teamId, p.teamId));
  if (p.categoryId)
    conds.push(
      or(
        eq(tickets.categoryId, p.categoryId),
        eq(tickets.subcategoryId, p.categoryId),
      ),
    );
  if (p.companyId) conds.push(eq(tickets.companyId, p.companyId));
  if (p.contactId) conds.push(eq(tickets.requesterContactId, p.contactId));
  if (p.tag) conds.push(sql`${p.tag} = any(${tickets.tags})`);
  if (p.q) {
    const refs = findTicketReferences(p.q);
    const like = `%${p.q}%`;
    conds.push(
      or(
        refs.length ? inArray(tickets.number, refs) : undefined,
        sql`${tickets.subject} ilike ${like}`,
        sql`${tickets.requesterName} ilike ${like}`,
        sql`${tickets.requesterEmail} ilike ${like}`,
        sql`${companies.name} ilike ${like}`,
        sql`exists (select 1 from ticket_messages m where m.ticket_id = tickets.id and m.body_text ilike ${like})`,
      ),
    );
  }
  return and(...conds.filter((c): c is SQL => Boolean(c)));
}

const PRIORITY_RANK = sql`case ${tickets.priority} when 'critical' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`;
const SORTS: Record<string, SQL> = {
  updated: sql`${tickets.lastActivityAt}`,
  created: sql`${tickets.createdAt}`,
  priority: PRIORITY_RANK,
  status: sql`${tickets.status}`,
  subject: sql`lower(${tickets.subject})`,
  reference: sql`${tickets.number}`,
  due: sql`coalesce(case when ${tickets.firstResponseAt} is null then ${tickets.firstResponseDueAt} end, ${tickets.resolutionDueAt})`,
  requester: sql`lower(coalesce(${tickets.requesterName}, ${tickets.requesterEmail}, ''))`,
  company: sql`lower(coalesce(${companies.name}, ''))`,
  assignee: sql`lower(coalesce(${assignee.name}, ''))`,
};

const listRow = {
  id: tickets.id,
  number: tickets.number,
  subject: tickets.subject,
  status: tickets.status,
  priority: tickets.priority,
  type: tickets.type,
  source: tickets.source,
  tags: tickets.tags,
  requesterName: tickets.requesterName,
  requesterEmail: tickets.requesterEmail,
  requesterContactId: tickets.requesterContactId,
  requesterUnverified: tickets.requesterUnverified,
  companyId: tickets.companyId,
  companyName: companies.name,
  assigneeUserId: tickets.assigneeUserId,
  assigneeName: assignee.name,
  teamId: tickets.teamId,
  teamName: helpdeskTeams.name,
  categoryId: tickets.categoryId,
  categoryName: helpdeskCategories.name,
  needsReview: tickets.needsReview,
  firstResponseAt: tickets.firstResponseAt,
  firstResponseDueAt: tickets.firstResponseDueAt,
  resolutionDueAt: tickets.resolutionDueAt,
  firstResponseBreached: tickets.firstResponseBreached,
  resolutionBreached: tickets.resolutionBreached,
  lastActivityAt: tickets.lastActivityAt,
  lastCustomerMessageAt: tickets.lastCustomerMessageAt,
  createdAt: tickets.createdAt,
  timeSpentMinutes: tickets.timeSpentMinutes,
  version: tickets.version,
};
export type TicketListRow = {
  [K in keyof typeof listRow]: (typeof listRow)[K] extends {
    _: { data: infer D };
  }
    ? D | null
    : never;
};

export async function listTickets(p: TicketListParams) {
  const page = p.page ?? 1;
  const pageSize = Math.min(p.pageSize ?? 50, 200);
  const w = listWhere(p);
  const sortKey = p.sort && SORTS[p.sort] ? p.sort : "updated";
  const dir =
    p.dir ?? (sortKey === "updated" || sortKey === "created" ? "desc" : "asc");
  const order = dir === "desc" ? desc(SORTS[sortKey]) : asc(SORTS[sortKey]);
  const base = () =>
    db
      .select(listRow)
      .from(tickets)
      .leftJoin(companies, eq(companies.id, tickets.companyId))
      .leftJoin(assignee, eq(assignee.id, tickets.assigneeUserId))
      .leftJoin(helpdeskTeams, eq(helpdeskTeams.id, tickets.teamId))
      .leftJoin(
        helpdeskCategories,
        eq(helpdeskCategories.id, tickets.categoryId),
      );
  const [rows, [{ total }]] = await Promise.all([
    base()
      .where(w)
      .orderBy(order, desc(tickets.lastActivityAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ total: count() })
      .from(tickets)
      .leftJoin(companies, eq(companies.id, tickets.companyId))
      .leftJoin(assignee, eq(assignee.id, tickets.assigneeUserId))
      .where(w),
  ]);
  return {
    rows: rows.map((r) => ({ ...r, reference: ticketReference(r.number) })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    sort: sortKey,
    dir,
  };
}

export async function myTeamIds(userId: string) {
  return (
    await db
      .select({ teamId: helpdeskTeamMembers.teamId })
      .from(helpdeskTeamMembers)
      .where(eq(helpdeskTeamMembers.userId, userId))
  ).map((r) => r.teamId);
}

export async function ticketCounts(userId: string) {
  const open = sql`${tickets.status} in ('new','open','in_progress','awaiting_customer','awaiting_third_party')`;
  const [row] = await db
    .select({
      open: sql<number>`count(*) filter (where ${open})`.mapWith(Number),
      mine: sql<number>`count(*) filter (where ${open} and ${tickets.assigneeUserId} = ${userId})`.mapWith(
        Number,
      ),
      unassigned:
        sql<number>`count(*) filter (where ${open} and ${tickets.assigneeUserId} is null)`.mapWith(
          Number,
        ),
      newCount:
        sql<number>`count(*) filter (where ${tickets.status} = 'new')`.mapWith(
          Number,
        ),
      awaitingCustomer:
        sql<number>`count(*) filter (where ${tickets.status} = 'awaiting_customer')`.mapWith(
          Number,
        ),
      awaitingThirdParty:
        sql<number>`count(*) filter (where ${tickets.status} = 'awaiting_third_party')`.mapWith(
          Number,
        ),
      review:
        sql<number>`count(*) filter (where ${tickets.needsReview} and ${open})`.mapWith(
          Number,
        ),
      overdue:
        sql<number>`count(*) filter (where ${open} and ((${tickets.firstResponseAt} is null and ${tickets.firstResponseDueAt} < now()) or ${tickets.resolutionDueAt} < now() or ${tickets.firstResponseBreached} or ${tickets.resolutionBreached}))`.mapWith(
          Number,
        ),
      dueSoon:
        sql<number>`count(*) filter (where ${open} and ((${tickets.firstResponseAt} is null and ${tickets.firstResponseDueAt} between now() and now() + interval '4 hours') or ${tickets.resolutionDueAt} between now() and now() + interval '4 hours'))`.mapWith(
          Number,
        ),
      resolvedToday:
        sql<number>`count(*) filter (where ${tickets.resolvedAt} >= date_trunc('day', now()))`.mapWith(
          Number,
        ),
      createdToday:
        sql<number>`count(*) filter (where ${tickets.createdAt} >= date_trunc('day', now()))`.mapWith(
          Number,
        ),
      critical:
        sql<number>`count(*) filter (where ${open} and ${tickets.priority} = 'critical')`.mapWith(
          Number,
        ),
    })
    .from(tickets)
    .where(isNull(tickets.mergedIntoTicketId));
  return row;
}

export async function ticketBreakdown() {
  const open = and(
    isNull(tickets.mergedIntoTicketId),
    inArray(tickets.status, OPEN_STATUSES),
  );
  const [byStatus, byPriority, byAssignee, byTeam, byCategory, byCompany] =
    await Promise.all([
      db
        .select({ key: tickets.status, n: count() })
        .from(tickets)
        .where(isNull(tickets.mergedIntoTicketId))
        .groupBy(tickets.status),
      db
        .select({ key: tickets.priority, n: count() })
        .from(tickets)
        .where(open)
        .groupBy(tickets.priority),
      db
        .select({
          key: sql<string>`coalesce(${assignee.name}, 'Unassigned')`,
          n: count(),
        })
        .from(tickets)
        .leftJoin(assignee, eq(assignee.id, tickets.assigneeUserId))
        .where(open)
        .groupBy(sql`coalesce(${assignee.name}, 'Unassigned')`)
        .orderBy(desc(count())),
      db
        .select({
          key: sql<string>`coalesce(${helpdeskTeams.name}, 'No team')`,
          n: count(),
        })
        .from(tickets)
        .leftJoin(helpdeskTeams, eq(helpdeskTeams.id, tickets.teamId))
        .where(open)
        .groupBy(sql`coalesce(${helpdeskTeams.name}, 'No team')`)
        .orderBy(desc(count())),
      db
        .select({
          key: sql<string>`coalesce(${helpdeskCategories.name}, 'Uncategorised')`,
          n: count(),
        })
        .from(tickets)
        .leftJoin(
          helpdeskCategories,
          eq(helpdeskCategories.id, tickets.categoryId),
        )
        .where(open)
        .groupBy(sql`coalesce(${helpdeskCategories.name}, 'Uncategorised')`)
        .orderBy(desc(count())),
      db
        .select({
          key: sql<string>`coalesce(${companies.name}, 'No company')`,
          id: companies.id,
          n: count(),
        })
        .from(tickets)
        .leftJoin(companies, eq(companies.id, tickets.companyId))
        .where(open)
        .groupBy(companies.id, companies.name)
        .orderBy(desc(count()))
        .limit(10),
    ]);
  return { byStatus, byPriority, byAssignee, byTeam, byCategory, byCompany };
}

export async function getTicket(id: string) {
  const [row] = await db
    .select({
      t: tickets,
      companyName: companies.name,
      assigneeName: assignee.name,
      creatorName: creator.name,
      teamName: helpdeskTeams.name,
      categoryName: helpdeskCategories.name,
      contactFirst: contacts.firstName,
      contactLast: contacts.lastName,
      contactPhone: contacts.phone,
      contactJob: contacts.jobTitle,
    })
    .from(tickets)
    .leftJoin(companies, eq(companies.id, tickets.companyId))
    .leftJoin(assignee, eq(assignee.id, tickets.assigneeUserId))
    .leftJoin(creator, eq(creator.id, tickets.createdByUserId))
    .leftJoin(helpdeskTeams, eq(helpdeskTeams.id, tickets.teamId))
    .leftJoin(helpdeskCategories, eq(helpdeskCategories.id, tickets.categoryId))
    .leftJoin(contacts, eq(contacts.id, tickets.requesterContactId))
    .where(eq(tickets.id, id))
    .limit(1);
  if (!row) return null;
  const t = row.t;
  const [
    messages,
    participants,
    events,
    links,
    backlinks,
    timeEntries,
    attachments,
    subcategory,
    mergedInto,
    children,
    timers,
  ] = await Promise.all([
    db
      .select({ m: ticketMessages, authorName: user.name })
      .from(ticketMessages)
      .leftJoin(user, eq(user.id, ticketMessages.authorUserId))
      .where(eq(ticketMessages.ticketId, id))
      .orderBy(asc(ticketMessages.at), asc(ticketMessages.createdAt)),
    db
      .select({ p: ticketParticipants, userName: user.name })
      .from(ticketParticipants)
      .leftJoin(user, eq(user.id, ticketParticipants.userId))
      .where(eq(ticketParticipants.ticketId, id))
      .orderBy(asc(ticketParticipants.role), asc(ticketParticipants.createdAt)),
    db
      .select({ e: ticketEvents, actorName: user.name })
      .from(ticketEvents)
      .leftJoin(user, eq(user.id, ticketEvents.actorUserId))
      .where(eq(ticketEvents.ticketId, id))
      .orderBy(asc(ticketEvents.at)),
    db
      .select({
        l: ticketLinks,
        number: tickets.number,
        subject: tickets.subject,
        status: tickets.status,
      })
      .from(ticketLinks)
      .innerJoin(tickets, eq(tickets.id, ticketLinks.relatedTicketId))
      .where(eq(ticketLinks.ticketId, id)),
    db
      .select({
        l: ticketLinks,
        number: tickets.number,
        subject: tickets.subject,
        status: tickets.status,
      })
      .from(ticketLinks)
      .innerJoin(tickets, eq(tickets.id, ticketLinks.ticketId))
      .where(eq(ticketLinks.relatedTicketId, id)),
    db
      .select({ e: ticketTimeEntries, userName: user.name })
      .from(ticketTimeEntries)
      .innerJoin(user, eq(user.id, ticketTimeEntries.userId))
      .where(eq(ticketTimeEntries.ticketId, id))
      .orderBy(desc(ticketTimeEntries.createdAt)),
    db
      .select()
      .from(ticketAttachments)
      .where(eq(ticketAttachments.ticketId, id))
      .orderBy(asc(ticketAttachments.createdAt)),
    t.subcategoryId
      ? db
          .select({ name: helpdeskCategories.name })
          .from(helpdeskCategories)
          .where(eq(helpdeskCategories.id, t.subcategoryId))
          .limit(1)
      : Promise.resolve([]),
    t.mergedIntoTicketId
      ? db
          .select({
            id: tickets.id,
            number: tickets.number,
            subject: tickets.subject,
          })
          .from(tickets)
          .where(eq(tickets.id, t.mergedIntoTicketId))
          .limit(1)
      : Promise.resolve([]),
    db
      .select({
        id: tickets.id,
        number: tickets.number,
        subject: tickets.subject,
        status: tickets.status,
      })
      .from(tickets)
      .where(eq(tickets.parentTicketId, id)),
    db
      .select({ tm: ticketTimers, userName: user.name })
      .from(ticketTimers)
      .innerJoin(user, eq(user.id, ticketTimers.userId))
      .where(eq(ticketTimers.ticketId, id)),
  ]);
  const attachmentsByMessage = new Map<string | null, typeof attachments>();
  for (const a of attachments)
    attachmentsByMessage.set(a.messageId, [
      ...(attachmentsByMessage.get(a.messageId) ?? []),
      a,
    ]);
  const parent = t.parentTicketId
    ? ((
        await db
          .select({
            id: tickets.id,
            number: tickets.number,
            subject: tickets.subject,
            status: tickets.status,
          })
          .from(tickets)
          .where(eq(tickets.id, t.parentTicketId))
          .limit(1)
      )[0] ?? null)
    : null;
  return {
    ...t,
    reference: ticketReference(t.number),
    companyName: row.companyName,
    assigneeName: row.assigneeName,
    creatorName: row.creatorName,
    teamName: row.teamName,
    categoryName: row.categoryName,
    subcategoryName: subcategory[0]?.name ?? null,
    contact: t.requesterContactId
      ? {
          id: t.requesterContactId,
          name: `${row.contactFirst ?? ""} ${row.contactLast ?? ""}`.trim(),
          phone: row.contactPhone,
          jobTitle: row.contactJob,
        }
      : null,
    messages: messages.map((m) => ({
      ...m.m,
      authorName: m.authorName,
      attachments: attachmentsByMessage.get(m.m.id) ?? [],
    })),
    participants: participants.map((p) => ({ ...p.p, userName: p.userName })),
    events: events.map((e) => ({ ...e.e, actorName: e.actorName })),
    links: [
      ...links.map((l) => ({
        id: l.l.id,
        kind: l.l.kind,
        direction: "out" as const,
        ticketId: l.l.relatedTicketId,
        reference: ticketReference(l.number),
        subject: l.subject,
        status: l.status,
      })),
      ...backlinks.map((l) => ({
        id: l.l.id,
        kind: l.l.kind,
        direction: "in" as const,
        ticketId: l.l.ticketId,
        reference: ticketReference(l.number),
        subject: l.subject,
        status: l.status,
      })),
    ],
    timeEntries: timeEntries.map((e) => ({ ...e.e, userName: e.userName })),
    attachments,
    looseAttachments: attachmentsByMessage.get(null) ?? [],
    mergedInto: mergedInto[0]
      ? { ...mergedInto[0], reference: ticketReference(mergedInto[0].number) }
      : null,
    parent: parent
      ? { ...parent, reference: ticketReference(parent.number) }
      : null,
    children: children.map((c) => ({
      ...c,
      reference: ticketReference(c.number),
    })),
    timers: timers.map((x) => ({ ...x.tm, userName: x.userName })),
  };
}
export type TicketDetail = NonNullable<Awaited<ReturnType<typeof getTicket>>>;

/** Looks a ticket up by IT-000123 (or a bare number), following merges to the surviving ticket. */
export async function findTicketByReference(
  ref: string | number,
  followMerges = true,
) {
  const n =
    typeof ref === "number"
      ? ref
      : (findTicketReferences(ref)[0] ??
        (/^\d+$/.test(ref.trim()) ? Number(ref.trim()) : null));
  if (!n) return null;
  let [t] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.number, n))
    .limit(1);
  let hops = 0;
  while (followMerges && t?.mergedIntoTicketId && hops++ < 10) {
    const [next] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, t.mergedIntoTicketId))
      .limit(1);
    if (!next) break;
    t = next;
  }
  return t ?? null;
}

// ---------------------------------------------------------------------------
// Update fields, status, assignment
// ---------------------------------------------------------------------------
const FIELD_LABELS: Record<string, string> = {
  subject: "Subject",
  priority: "Priority",
  type: "Type",
  categoryId: "Category",
  subcategoryId: "Subcategory",
  tags: "Tags",
  requesterContactId: "Requester",
  requesterName: "Requester name",
  requesterEmail: "Requester e-mail",
  companyId: "Company",
  assigneeUserId: "Assignee",
  teamId: "Team",
  customFields: "Custom fields",
};

export async function updateTicketFields(
  id: string,
  input: TicketFieldsInput,
  actor: Actor,
) {
  const existing = await getTicketRow(id);
  const requester = await resolveRequester({
    requesterContactId: input.requesterContactId,
    requesterName: input.requesterName,
    requesterEmail: input.requesterEmail,
    companyId: input.companyId,
  });
  const assigneeUser = await assertAssignee(input.assigneeUserId);
  const customFields = (await validateCustomFields(
    "ticket",
    input.customFields ?? {},
  )) as Record<string, unknown>;
  const after = {
    subject: input.subject,
    priority: input.priority,
    type: input.type,
    categoryId: input.categoryId,
    subcategoryId: input.subcategoryId,
    tags: input.tags ?? [],
    requesterContactId: requester.contactId,
    requesterName: requester.name,
    requesterEmail: requester.email,
    companyId: requester.companyId,
    assigneeUserId: input.assigneeUserId,
    teamId: input.teamId,
    customFields,
  };
  const before = {
    subject: existing.subject,
    priority: existing.priority,
    type: existing.type,
    categoryId: existing.categoryId,
    subcategoryId: existing.subcategoryId,
    tags: existing.tags,
    requesterContactId: existing.requesterContactId,
    requesterName: existing.requesterName,
    requesterEmail: existing.requesterEmail,
    companyId: existing.companyId,
    assigneeUserId: existing.assigneeUserId,
    teamId: existing.teamId,
    customFields: existing.customFields,
  };
  const changes = diffFields(before, after);
  if (Object.keys(changes).length === 0)
    return { changed: false, version: existing.version };
  const version = await db.transaction(async (tx) => {
    const v = await bumpVersion(id, input.version, tx);
    await tx
      .update(tickets)
      .set({
        ...after,
        requesterNormalizedEmail: requester.email,
        requesterUnverified: requester.contactId
          ? false
          : existing.requesterUnverified,
      })
      .where(eq(tickets.id, id));
    if (requester.email)
      await tx
        .update(ticketParticipants)
        .set({
          name: requester.name,
          email: requester.email,
          normalizedEmail: requester.email,
          contactId: requester.contactId,
        })
        .where(
          and(
            eq(ticketParticipants.ticketId, id),
            eq(ticketParticipants.role, "requester"),
          ),
        );
    for (const [key, ch] of Object.entries(changes)) {
      const label = FIELD_LABELS[key] ?? key;
      const to =
        key === "assigneeUserId"
          ? (assigneeUser?.name ?? "unassigned")
          : key === "tags"
            ? (ch.to as string[]).join(", ") || "none"
            : key === "customFields"
              ? "updated"
              : String(ch.to ?? "none");
      await recordEvent(
        id,
        key === "assigneeUserId"
          ? "assignee"
          : key === "teamId"
            ? "team"
            : key === "priority"
              ? "priority"
              : "field",
        `${label} → ${to}`,
        actor,
        { field: key, from: ch.from, to: ch.to },
        tx,
      );
    }
    await audit(
      {
        actorUserId: actor.id,
        action: "ticket.update",
        entityType: "ticket",
        entityId: id,
        details: { changes },
      },
      tx,
    );
    return v;
  });
  return { changed: true, version };
}

async function getTicketRow(id: string) {
  const [t] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, id))
    .limit(1);
  if (!t) throw new ActionError("Ticket not found.");
  return t;
}

export async function changeStatus(
  id: string,
  status: TicketStatus,
  actor: Actor,
  opts: {
    resolutionSummary?: string | null;
    resolutionCategory?: string | null;
    version?: number;
    reason?: string;
  } = {},
) {
  const t = await getTicketRow(id);
  if (t.mergedIntoTicketId)
    throw new ActionError(
      "This ticket was merged; work on the surviving ticket instead.",
    );
  if (t.status === status) return { changed: false, version: t.version };
  if (!canTransition(t.status, status))
    throw new ActionError(
      `A ${TICKET_STATUS_LABELS[t.status].toLowerCase()} ticket cannot move straight to ${TICKET_STATUS_LABELS[status].toLowerCase()}.`,
    );
  if (
    status === "resolved" &&
    !(opts.resolutionSummary ?? t.resolutionSummary) &&
    actor.type !== "automation"
  )
    throw new ActionError("Add a resolution summary before resolving.", {
      resolutionSummary: ["Required to resolve"],
    });
  const now = new Date();
  const reopening =
    (t.status === "resolved" ||
      t.status === "closed" ||
      t.status === "cancelled") &&
    OPEN_STATUSES.includes(status);
  const version = await db.transaction(async (tx) => {
    const v = await bumpVersion(id, opts.version, tx);
    await tx
      .update(tickets)
      .set({
        status,
        resolvedAt:
          status === "resolved" ? now : reopening ? null : t.resolvedAt,
        closedAt: status === "closed" ? now : reopening ? null : t.closedAt,
        resolutionSummary: opts.resolutionSummary ?? t.resolutionSummary,
        resolutionCategory: opts.resolutionCategory ?? t.resolutionCategory,
        reopenCount: reopening ? t.reopenCount + 1 : t.reopenCount,
        needsReview: status === "cancelled" ? false : t.needsReview,
      })
      .where(eq(tickets.id, id));
    await recordEvent(
      id,
      reopening
        ? "reopen"
        : status === "resolved"
          ? "resolve"
          : status === "closed"
            ? "close"
            : "status",
      `${TICKET_STATUS_LABELS[t.status]} → ${TICKET_STATUS_LABELS[status]}${opts.reason ? ` (${opts.reason})` : ""}`,
      actor,
      {
        from: t.status,
        to: status,
        reason: opts.reason ?? null,
        resolutionCategory: opts.resolutionCategory ?? null,
      },
      tx,
    );
    if (
      t.companyId &&
      (status === "resolved" || status === "closed" || reopening)
    )
      await logActivity(
        {
          type: "ticket",
          companyId: t.companyId,
          contactId: t.requesterContactId,
          entityType: "ticket",
          entityId: id,
          title: `Ticket ${ticketReference(t.number)} ${reopening ? "reopened" : status}: ${t.subject}`,
          body:
            status === "resolved"
              ? (opts.resolutionSummary ?? t.resolutionSummary)
              : null,
          actorUserId: actor.id,
          source:
            actor.type === "automation"
              ? "helpdesk-automation"
              : actor.type === "email"
                ? "helpdesk-email"
                : "user",
        },
        tx,
      );
    await audit(
      {
        actorUserId: actor.id,
        actorType: actor.id ? "user" : "system",
        action: "ticket.status",
        entityType: "ticket",
        entityId: id,
        details: { from: t.status, to: status, reason: opts.reason },
      },
      tx,
    );
    return v;
  });
  return { changed: true, version, reopened: reopening };
}

export async function assignTicket(
  id: string,
  target: { assigneeUserId?: string | null; teamId?: string | null },
  actor: Actor,
  version?: number,
) {
  const t = await getTicketRow(id);
  const patch: Partial<typeof tickets.$inferInsert> = {};
  const events: [string, string, Record<string, unknown>][] = [];
  if (
    target.assigneeUserId !== undefined &&
    target.assigneeUserId !== t.assigneeUserId
  ) {
    const u = await assertAssignee(target.assigneeUserId);
    patch.assigneeUserId = target.assigneeUserId;
    events.push([
      "assignee",
      `Assigned to ${u?.name ?? "nobody"}`,
      { from: t.assigneeUserId, to: target.assigneeUserId },
    ]);
  }
  if (target.teamId !== undefined && target.teamId !== t.teamId) {
    const [team] = target.teamId
      ? await db
          .select({ name: helpdeskTeams.name })
          .from(helpdeskTeams)
          .where(eq(helpdeskTeams.id, target.teamId))
          .limit(1)
      : [];
    if (target.teamId && !team) throw new ActionError("Team not found.");
    patch.teamId = target.teamId;
    events.push([
      "team",
      `Team → ${team?.name ?? "none"}`,
      { from: t.teamId, to: target.teamId },
    ]);
  }
  if (events.length === 0) return { changed: false };
  await db.transaction(async (tx) => {
    await bumpVersion(id, version, tx);
    await tx.update(tickets).set(patch).where(eq(tickets.id, id));
    for (const [kind, summary, details] of events)
      await recordEvent(id, kind, summary, actor, details, tx);
    await audit(
      {
        actorUserId: actor.id,
        actorType: actor.id ? "user" : "system",
        action: "ticket.assign",
        entityType: "ticket",
        entityId: id,
        details: { ...target },
      },
      tx,
    );
  });
  return { changed: true };
}

// ---------------------------------------------------------------------------
// Messages and notes
// ---------------------------------------------------------------------------
export async function addMessage(
  id: string,
  input: TicketMessageInput,
  actor: Actor & { name?: string; email?: string },
) {
  const t = await getTicketRow(id);
  if (t.mergedIntoTicketId)
    throw new ActionError(
      "This ticket was merged; reply on the surviving ticket.",
    );
  const internal = input.kind === "internal";
  if (!internal && input.channel === "email")
    throw new ActionError("E-mail sending is handled by the mailbox outbox.");
  const now = new Date();
  const messageId = await db.transaction(async (tx) => {
    await bumpVersion(id, input.version, tx);
    const [m] = await tx
      .insert(ticketMessages)
      .values({
        ticketId: id,
        kind: internal ? "internal" : "public",
        channel: internal ? "note" : "manual",
        direction: internal ? "internal" : "outbound",
        at: now,
        authorUserId: actor.id,
        fromName: actor.name ?? null,
        fromEmail: actor.email ?? null,
        subject: t.subject,
        bodyMarkdown: input.body,
        bodyText: markdownToPlainText(input.body),
        bodyHtml: internal ? null : markdownToHtml(input.body),
        deliveryStatus: "not_applicable",
        replyToMessageId: input.replyToMessageId,
      })
      .returning({ id: ticketMessages.id });
    const patch: Partial<typeof tickets.$inferInsert> = {};
    if (!internal) {
      patch.lastAgentMessageAt = now;
      if (!t.firstResponseAt) patch.firstResponseAt = now;
      if (t.status === "new") patch.status = "open";
    }
    if (Object.keys(patch).length)
      await tx.update(tickets).set(patch).where(eq(tickets.id, id));
    await recordEvent(
      id,
      internal ? "note" : "message",
      internal ? "Internal note added" : "Public message logged (not e-mailed)",
      actor,
      { messageId: m.id },
      tx,
    );
    if (!internal && t.companyId)
      await logActivity(
        {
          type: "ticket",
          companyId: t.companyId,
          contactId: t.requesterContactId,
          entityType: "ticket_message",
          entityId: m.id,
          title: `Ticket ${ticketReference(t.number)}: message logged`,
          body: markdownToPlainText(input.body).slice(0, 500),
          actorUserId: actor.id,
          source: "user",
        },
        tx,
      );
    return m.id;
  });
  if (
    input.status &&
    input.status !== (t.status === "new" && !internal ? "open" : t.status)
  )
    await changeStatus(id, input.status, actor);
  await deleteDraft(id, actor.id);
  return messageId;
}

// ---------------------------------------------------------------------------
// Drafts (auto-saved per user per ticket)
// ---------------------------------------------------------------------------
export async function saveDraft(
  ticketId: string,
  userId: string,
  draft: {
    kind: "public" | "internal";
    body: string;
    recipients?: { to: string[]; cc: string[]; bcc: string[] } | null;
    ticketVersion?: number | null;
  },
) {
  if (!draft.body.trim()) return deleteDraft(ticketId, userId);
  await db
    .insert(ticketDrafts)
    .values({
      ticketId,
      userId,
      kind: draft.kind,
      body: draft.body,
      recipients: draft.recipients ?? null,
      ticketVersion: draft.ticketVersion ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [ticketDrafts.ticketId, ticketDrafts.userId],
      set: {
        kind: draft.kind,
        body: draft.body,
        recipients: draft.recipients ?? null,
        ticketVersion: draft.ticketVersion ?? null,
        updatedAt: new Date(),
      },
    });
}
export async function getDraft(ticketId: string, userId: string) {
  const [d] = await db
    .select()
    .from(ticketDrafts)
    .where(
      and(eq(ticketDrafts.ticketId, ticketId), eq(ticketDrafts.userId, userId)),
    )
    .limit(1);
  return d ?? null;
}
export async function deleteDraft(ticketId: string, userId: string | null) {
  if (!userId) return;
  await db
    .delete(ticketDrafts)
    .where(
      and(eq(ticketDrafts.ticketId, ticketId), eq(ticketDrafts.userId, userId)),
    );
}

// ---------------------------------------------------------------------------
// Participants, links, time
// ---------------------------------------------------------------------------
export async function addParticipant(
  ticketId: string,
  input: { email: string; name: string | null; role: "cc" | "requester" },
  actor: Actor,
) {
  const norm = normalizeEmail(input.email)!;
  const [c] = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
    })
    .from(contacts)
    .where(and(eq(contacts.normalizedEmail, norm), isNull(contacts.archivedAt)))
    .limit(1);
  await db
    .insert(ticketParticipants)
    .values({
      ticketId,
      role: input.role,
      email: norm,
      normalizedEmail: norm,
      name: input.name ?? (c ? `${c.firstName} ${c.lastName}`.trim() : null),
      contactId: c?.id ?? null,
    })
    .onConflictDoUpdate({
      target: [ticketParticipants.ticketId, ticketParticipants.normalizedEmail],
      set: {
        role: input.role,
        name: input.name ?? undefined,
        updatedAt: new Date(),
      },
    });
  await recordEvent(
    ticketId,
    "participant",
    `${input.role === "cc" ? "CC" : "Requester"} added: ${norm}`,
    actor,
    { email: norm, role: input.role },
  );
}
export async function removeParticipant(
  ticketId: string,
  participantId: string,
  actor: Actor,
) {
  const [p] = await db
    .select()
    .from(ticketParticipants)
    .where(
      and(
        eq(ticketParticipants.id, participantId),
        eq(ticketParticipants.ticketId, ticketId),
      ),
    )
    .limit(1);
  if (!p) return;
  if (p.role === "requester")
    throw new ActionError(
      "The requester cannot be removed; change the requester instead.",
    );
  await db
    .delete(ticketParticipants)
    .where(eq(ticketParticipants.id, participantId));
  await recordEvent(
    ticketId,
    "participant",
    `${p.role === "follower" ? "Follower" : "CC"} removed: ${p.email ?? p.userId ?? ""}`.trim(),
    actor,
    { participantId },
  );
}
export async function toggleFollower(
  ticketId: string,
  userId: string,
  follow: boolean,
) {
  if (follow)
    await db
      .insert(ticketParticipants)
      .values({ ticketId, role: "follower", userId })
      .onConflictDoNothing();
  else
    await db
      .delete(ticketParticipants)
      .where(
        and(
          eq(ticketParticipants.ticketId, ticketId),
          eq(ticketParticipants.userId, userId),
          eq(ticketParticipants.role, "follower"),
        ),
      );
}

export async function linkTickets(
  ticketId: string,
  reference: string,
  kind: "related" | "parent" | "duplicate",
  actor: Actor,
) {
  const other = await findTicketByReference(reference, false);
  if (!other) throw new ActionError("No ticket with that reference.");
  if (other.id === ticketId)
    throw new ActionError("A ticket cannot be linked to itself.");
  await db.transaction(async (tx) => {
    await tx
      .insert(ticketLinks)
      .values({
        ticketId,
        relatedTicketId: other.id,
        kind,
        createdByUserId: actor.id,
      })
      .onConflictDoNothing();
    if (kind === "parent")
      await tx
        .update(tickets)
        .set({ parentTicketId: other.id, updatedAt: new Date() })
        .where(eq(tickets.id, ticketId));
    await recordEvent(
      ticketId,
      "link",
      `Linked ${kind === "parent" ? "as child of" : kind === "duplicate" ? "as duplicate of" : "to"} ${ticketReference(other.number)}`,
      actor,
      { relatedTicketId: other.id, kind },
      tx,
    );
    await recordEvent(
      other.id,
      "link",
      `${kind === "parent" ? "Child ticket" : "Linked ticket"} ${ticketReference((await getTicketRow(ticketId)).number)}`,
      actor,
      { relatedTicketId: ticketId, kind },
      tx,
    );
  });
}
export async function unlinkTickets(linkId: string, actor: Actor) {
  const [l] = await db
    .select()
    .from(ticketLinks)
    .where(eq(ticketLinks.id, linkId))
    .limit(1);
  if (!l) return;
  await db.transaction(async (tx) => {
    await tx.delete(ticketLinks).where(eq(ticketLinks.id, linkId));
    if (l.kind === "parent")
      await tx
        .update(tickets)
        .set({ parentTicketId: null })
        .where(
          and(
            eq(tickets.id, l.ticketId),
            eq(tickets.parentTicketId, l.relatedTicketId),
          ),
        );
    await recordEvent(
      l.ticketId,
      "link",
      "Link removed",
      actor,
      { linkId },
      tx,
    );
  });
}

export async function addTimeEntry(
  ticketId: string,
  userId: string,
  input: {
    minutes: number;
    note: string | null;
    billable: boolean;
    date?: string | null;
  },
  actor: Actor,
) {
  await getTicketRow(ticketId);
  await db.transaction(async (tx) => {
    const startedAt = input.date ? new Date(`${input.date}T12:00:00Z`) : null;
    await tx.insert(ticketTimeEntries).values({
      ticketId,
      userId,
      minutes: input.minutes,
      note: input.note,
      billable: input.billable,
      startedAt,
      endedAt: startedAt
        ? new Date(startedAt.getTime() + input.minutes * 60000)
        : null,
    });
    await tx
      .update(tickets)
      .set({
        timeSpentMinutes: sql`${tickets.timeSpentMinutes} + ${input.minutes}`,
        updatedAt: new Date(),
      })
      .where(eq(tickets.id, ticketId));
    await recordEvent(
      ticketId,
      "time",
      `${input.minutes} min logged${input.note ? `: ${input.note}` : ""}`,
      actor,
      { minutes: input.minutes, billable: input.billable },
      tx,
    );
  });
}
export async function deleteTimeEntry(
  entryId: string,
  actor: Actor & { canManage: boolean },
) {
  const [e] = await db
    .select()
    .from(ticketTimeEntries)
    .where(eq(ticketTimeEntries.id, entryId))
    .limit(1);
  if (!e) return;
  if (e.userId !== actor.id && !actor.canManage)
    throw new ActionError(
      "Only the person who logged this time (or a manager) can remove it.",
    );
  await db.transaction(async (tx) => {
    await tx.delete(ticketTimeEntries).where(eq(ticketTimeEntries.id, entryId));
    await tx
      .update(tickets)
      .set({
        timeSpentMinutes: sql`greatest(0, ${tickets.timeSpentMinutes} - ${e.minutes})`,
        updatedAt: new Date(),
      })
      .where(eq(tickets.id, e.ticketId));
    await recordEvent(
      e.ticketId,
      "time",
      `${e.minutes} min removed`,
      actor,
      { entryId },
      tx,
    );
  });
}
export async function startTimer(ticketId: string, userId: string) {
  await db
    .insert(ticketTimers)
    .values({ ticketId, userId })
    .onConflictDoNothing();
}
export async function stopTimer(
  ticketId: string,
  userId: string,
  note: string | null,
  actor: Actor,
) {
  const [tm] = await db
    .select()
    .from(ticketTimers)
    .where(
      and(eq(ticketTimers.ticketId, ticketId), eq(ticketTimers.userId, userId)),
    )
    .limit(1);
  if (!tm) return { minutes: 0 };
  const minutes = Math.max(
    1,
    Math.round((Date.now() - tm.startedAt.getTime()) / 60000),
  );
  await db
    .delete(ticketTimers)
    .where(
      and(eq(ticketTimers.ticketId, ticketId), eq(ticketTimers.userId, userId)),
    );
  await addTimeEntry(
    ticketId,
    userId,
    { minutes, note, billable: true },
    actor,
  );
  return { minutes };
}

// ---------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------
export async function bulkUpdate(
  ids: string[],
  action: "assign" | "team" | "priority" | "status",
  value: string,
  actor: Actor,
) {
  let done = 0;
  const errors: string[] = [];
  for (const id of ids) {
    try {
      if (action === "assign")
        await assignTicket(id, { assigneeUserId: value || null }, actor);
      else if (action === "team")
        await assignTicket(id, { teamId: value || null }, actor);
      else if (action === "priority") {
        const t = await getTicketRow(id);
        if (t.priority !== value) {
          await db
            .update(tickets)
            .set({
              priority: value as TicketPriority,
              version: sql`${tickets.version} + 1`,
            })
            .where(eq(tickets.id, id));
          await recordEvent(id, "priority", `Priority → ${value}`, actor, {
            from: t.priority,
            to: value,
          });
        }
      } else
        await changeStatus(id, value as TicketStatus, actor, {
          reason: "bulk update",
        });
      done++;
    } catch (err) {
      errors.push(
        `${ticketReference((await getTicketRow(id).catch(() => ({ number: 0 }))).number)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await audit({
    actorUserId: actor.id,
    action: "ticket.bulk",
    entityType: "ticket",
    details: { action, value, count: done, errors: errors.length },
  });
  return { done, errors };
}

// ---------------------------------------------------------------------------
// Merge and split
// ---------------------------------------------------------------------------
export async function mergePreview(sourceIds: string[], targetId: string) {
  const ids = [...new Set(sourceIds)].filter((s) => s !== targetId);
  const [target] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, targetId))
    .limit(1);
  if (!target) throw new ActionError("Target ticket not found.");
  if (target.mergedIntoTicketId)
    throw new ActionError(
      "The target ticket was itself merged; choose the surviving ticket.",
    );
  const sources = ids.length
    ? await db.select().from(tickets).where(inArray(tickets.id, ids))
    : [];
  if (sources.length !== ids.length)
    throw new ActionError("One of the tickets to merge no longer exists.");
  for (const s of sources)
    if (s.mergedIntoTicketId)
      throw new ActionError(`${ticketReference(s.number)} was already merged.`);
  const counts = ids.length
    ? await db
        .select({ ticketId: ticketMessages.ticketId, messages: count() })
        .from(ticketMessages)
        .where(inArray(ticketMessages.ticketId, ids))
        .groupBy(ticketMessages.ticketId)
    : [];
  const parts = ids.length
    ? await db
        .select({
          ticketId: ticketParticipants.ticketId,
          email: ticketParticipants.normalizedEmail,
          role: ticketParticipants.role,
        })
        .from(ticketParticipants)
        .where(inArray(ticketParticipants.ticketId, ids))
    : [];
  const targetParts = new Set(
    (
      await db
        .select({ email: ticketParticipants.normalizedEmail })
        .from(ticketParticipants)
        .where(eq(ticketParticipants.ticketId, targetId))
    ).map((p) => p.email),
  );
  return {
    target: {
      id: target.id,
      reference: ticketReference(target.number),
      subject: target.subject,
      status: target.status,
      requesterEmail: target.requesterEmail,
    },
    sources: sources.map((s) => ({
      id: s.id,
      reference: ticketReference(s.number),
      subject: s.subject,
      status: s.status,
      requesterEmail: s.requesterEmail,
      messages: counts.find((c) => c.ticketId === s.id)?.messages ?? 0,
      newParticipants: parts
        .filter(
          (p) => p.ticketId === s.id && p.email && !targetParts.has(p.email),
        )
        .map((p) => p.email!),
      differentRequester: Boolean(
        s.requesterNormalizedEmail &&
        target.requesterNormalizedEmail &&
        s.requesterNormalizedEmail !== target.requesterNormalizedEmail,
      ),
      timeMinutes: s.timeSpentMinutes,
    })),
  };
}

/** Moves conversations, participants, attachments, time and links into the target. Sources close and remember the target so later replies reach it. */
export async function mergeTickets(
  sourceIds: string[],
  targetId: string,
  actor: Actor,
) {
  const preview = await mergePreview(sourceIds, targetId);
  if (preview.sources.length === 0)
    throw new ActionError("Choose at least one other ticket to merge.");
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const s of preview.sources) {
      await tx
        .update(ticketMessages)
        .set({
          ticketId: targetId,
          metadata: sql`coalesce(${ticketMessages.metadata}, '{}'::jsonb) || ${JSON.stringify({ mergedFrom: s.reference })}::jsonb`,
        })
        .where(eq(ticketMessages.ticketId, s.id));
      await tx
        .update(ticketAttachments)
        .set({ ticketId: targetId })
        .where(eq(ticketAttachments.ticketId, s.id));
      await tx
        .update(ticketTimeEntries)
        .set({ ticketId: targetId })
        .where(eq(ticketTimeEntries.ticketId, s.id));
      const parts = await tx
        .select()
        .from(ticketParticipants)
        .where(eq(ticketParticipants.ticketId, s.id));
      for (const p of parts) {
        if (p.role === "requester" && p.normalizedEmail)
          await tx
            .insert(ticketParticipants)
            .values({
              ticketId: targetId,
              role: "cc",
              name: p.name,
              email: p.email,
              normalizedEmail: p.normalizedEmail,
              contactId: p.contactId,
            })
            .onConflictDoNothing();
        else
          await tx
            .insert(ticketParticipants)
            .values({
              ticketId: targetId,
              role: p.role,
              name: p.name,
              email: p.email,
              normalizedEmail: p.normalizedEmail,
              contactId: p.contactId,
              userId: p.userId,
            })
            .onConflictDoNothing();
      }
      await tx
        .update(ticketLinks)
        .set({ ticketId: targetId })
        .where(
          and(
            eq(ticketLinks.ticketId, s.id),
            ne(ticketLinks.relatedTicketId, targetId),
          ),
        );
      await tx
        .update(ticketLinks)
        .set({ relatedTicketId: targetId })
        .where(
          and(
            eq(ticketLinks.relatedTicketId, s.id),
            ne(ticketLinks.ticketId, targetId),
          ),
        );
      await tx
        .delete(ticketLinks)
        .where(eq(ticketLinks.ticketId, ticketLinks.relatedTicketId));
      await tx
        .update(tickets)
        .set({
          mergedIntoTicketId: targetId,
          status: "closed",
          closedAt: now,
          version: sql`${tickets.version} + 1`,
          updatedAt: now,
          lastActivityAt: now,
        })
        .where(eq(tickets.id, s.id));
      await tx
        .update(tickets)
        .set({ mergedIntoTicketId: targetId })
        .where(eq(tickets.mergedIntoTicketId, s.id));
      await tx
        .insert(ticketLinks)
        .values({
          ticketId: targetId,
          relatedTicketId: s.id,
          kind: "merged_from",
          createdByUserId: actor.id,
        })
        .onConflictDoNothing();
      await recordEvent(
        s.id,
        "merge",
        `Merged into ${preview.target.reference}`,
        actor,
        { targetId },
        tx,
      );
      await recordEvent(
        targetId,
        "merge",
        `${s.reference} merged into this ticket (${s.messages} messages)`,
        actor,
        { sourceId: s.id, messages: s.messages },
        tx,
      );
    }
    await tx
      .update(tickets)
      .set({
        timeSpentMinutes: sql`${tickets.timeSpentMinutes} + ${preview.sources.reduce((a, s) => a + s.timeMinutes, 0)}`,
        version: sql`${tickets.version} + 1`,
        updatedAt: now,
      })
      .where(eq(tickets.id, targetId));
    await audit(
      {
        actorUserId: actor.id,
        action: "ticket.merge",
        entityType: "ticket",
        entityId: targetId,
        details: { sources: preview.sources.map((s) => s.reference) },
      },
      tx,
    );
  });
  return preview;
}

/** Moves the chosen messages (and their attachments) into a new ticket that keeps the requester, company and links back. */
export async function splitTicket(
  sourceId: string,
  messageIds: string[],
  subject: string,
  actor: Actor,
) {
  const source = await getTicketRow(sourceId);
  const msgs = await db
    .select()
    .from(ticketMessages)
    .where(
      and(
        eq(ticketMessages.ticketId, sourceId),
        inArray(ticketMessages.id, messageIds),
      ),
    );
  if (msgs.length === 0)
    throw new ActionError("Choose at least one message to move.");
  const total = await db
    .select({ n: count() })
    .from(ticketMessages)
    .where(eq(ticketMessages.ticketId, sourceId));
  if (total[0].n <= msgs.length)
    throw new ActionError(
      "At least one message must stay on the original ticket.",
    );
  const newId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(tickets)
      .values({
        subject,
        priority: source.priority,
        type: source.type,
        source: source.source,
        categoryId: source.categoryId,
        subcategoryId: source.subcategoryId,
        tags: source.tags,
        requesterName: source.requesterName,
        requesterEmail: source.requesterEmail,
        requesterNormalizedEmail: source.requesterNormalizedEmail,
        requesterContactId: source.requesterContactId,
        requesterUnverified: source.requesterUnverified,
        companyId: source.companyId,
        teamId: source.teamId,
        assigneeUserId: source.assigneeUserId,
        status: "open",
        createdByUserId: actor.id,
        customFields: source.customFields,
      })
      .returning({ id: tickets.id, number: tickets.number });
    const parts = await tx
      .select()
      .from(ticketParticipants)
      .where(eq(ticketParticipants.ticketId, sourceId));
    for (const p of parts)
      await tx
        .insert(ticketParticipants)
        .values({
          ticketId: row.id,
          role: p.role,
          name: p.name,
          email: p.email,
          normalizedEmail: p.normalizedEmail,
          contactId: p.contactId,
          userId: p.userId,
        })
        .onConflictDoNothing();
    await tx
      .update(ticketMessages)
      .set({ ticketId: row.id })
      .where(
        inArray(
          ticketMessages.id,
          msgs.map((m) => m.id),
        ),
      );
    await tx
      .update(ticketAttachments)
      .set({ ticketId: row.id })
      .where(
        inArray(
          ticketAttachments.messageId,
          msgs.map((m) => m.id),
        ),
      );
    await tx.insert(ticketLinks).values({
      ticketId: row.id,
      relatedTicketId: sourceId,
      kind: "split_from",
      createdByUserId: actor.id,
    });
    await recordEvent(
      row.id,
      "split",
      `Split from ${ticketReference(source.number)} with ${msgs.length} message${msgs.length === 1 ? "" : "s"}`,
      actor,
      { sourceId, messageIds },
      tx,
    );
    await recordEvent(
      sourceId,
      "split",
      `${msgs.length} message${msgs.length === 1 ? "" : "s"} moved to ${ticketReference(row.number)}`,
      actor,
      { newTicketId: row.id, messageIds },
      tx,
    );
    await tx
      .update(tickets)
      .set({ version: sql`${tickets.version} + 1` })
      .where(eq(tickets.id, sourceId));
    await audit(
      {
        actorUserId: actor.id,
        action: "ticket.split",
        entityType: "ticket",
        entityId: sourceId,
        details: { newTicketId: row.id, messages: msgs.length },
      },
      tx,
    );
    return row.id;
  });
  return newId;
}

// ---------------------------------------------------------------------------
// Company / contact summaries
// ---------------------------------------------------------------------------
export async function companyTicketSummary(companyId: string) {
  const [row] = await db
    .select({
      open: sql<number>`count(*) filter (where ${tickets.status} in ('new','open','in_progress','awaiting_customer','awaiting_third_party'))`.mapWith(
        Number,
      ),
      total: sql<number>`count(*)`.mapWith(Number),
      lastAt: sql<Date | null>`max(${tickets.lastActivityAt})`,
    })
    .from(tickets)
    .where(
      and(eq(tickets.companyId, companyId), isNull(tickets.mergedIntoTicketId)),
    );
  return row;
}

// ---------------------------------------------------------------------------
// Teams and categories (admin)
// ---------------------------------------------------------------------------
export async function listTeams() {
  const rows = await db
    .select()
    .from(helpdeskTeams)
    .orderBy(asc(helpdeskTeams.name));
  const members = await db
    .select({
      teamId: helpdeskTeamMembers.teamId,
      userId: helpdeskTeamMembers.userId,
      isLead: helpdeskTeamMembers.isLead,
      name: user.name,
    })
    .from(helpdeskTeamMembers)
    .innerJoin(user, eq(user.id, helpdeskTeamMembers.userId))
    .orderBy(asc(user.name));
  return rows.map((t) => ({
    ...t,
    members: members.filter((m) => m.teamId === t.id),
  }));
}
export async function saveTeam(
  id: string | null,
  input: {
    name: string;
    description: string | null;
    memberIds: string[];
    leadUserId: string | null;
    active: boolean;
  },
  actorUserId: string,
) {
  const teamId = await db.transaction(async (tx) => {
    let tid = id;
    if (tid)
      await tx
        .update(helpdeskTeams)
        .set({
          name: input.name,
          description: input.description,
          active: input.active,
          updatedAt: new Date(),
        })
        .where(eq(helpdeskTeams.id, tid));
    else
      tid = (
        await tx
          .insert(helpdeskTeams)
          .values({
            name: input.name,
            description: input.description,
            active: input.active,
          })
          .returning({ id: helpdeskTeams.id })
      )[0].id;
    await tx
      .delete(helpdeskTeamMembers)
      .where(eq(helpdeskTeamMembers.teamId, tid));
    const ids = [
      ...new Set([
        ...input.memberIds,
        ...(input.leadUserId ? [input.leadUserId] : []),
      ]),
    ];
    if (ids.length)
      await tx.insert(helpdeskTeamMembers).values(
        ids.map((userId) => ({
          teamId: tid!,
          userId,
          isLead: userId === input.leadUserId,
        })),
      );
    await audit(
      {
        actorUserId,
        action: id ? "helpdesk.team.update" : "helpdesk.team.create",
        entityType: "helpdesk_team",
        entityId: tid,
        details: { name: input.name, members: ids.length },
      },
      tx,
    );
    return tid;
  });
  return teamId;
}
export async function deleteTeam(id: string, actorUserId: string) {
  await db.delete(helpdeskTeams).where(eq(helpdeskTeams.id, id));
  await audit({
    actorUserId,
    action: "helpdesk.team.delete",
    entityType: "helpdesk_team",
    entityId: id,
  });
}
export async function listCategories() {
  const rows = await db
    .select()
    .from(helpdeskCategories)
    .orderBy(asc(helpdeskCategories.sortOrder), asc(helpdeskCategories.name));
  return rows
    .filter((r) => !r.parentId)
    .map((c) => ({ ...c, children: rows.filter((r) => r.parentId === c.id) }));
}
export async function saveCategory(
  id: string | null,
  input: {
    name: string;
    parentId: string | null;
    sortOrder: number;
    active: boolean;
  },
  actorUserId: string,
) {
  if (input.parentId) {
    const [p] = await db
      .select({ parentId: helpdeskCategories.parentId })
      .from(helpdeskCategories)
      .where(eq(helpdeskCategories.id, input.parentId))
      .limit(1);
    if (!p || p.parentId)
      throw new ActionError(
        "Subcategories can only sit under a top-level category.",
      );
  }
  if (id)
    await db
      .update(helpdeskCategories)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(helpdeskCategories.id, id));
  else
    id = (
      await db
        .insert(helpdeskCategories)
        .values(input)
        .returning({ id: helpdeskCategories.id })
    )[0].id;
  await audit({
    actorUserId,
    action: "helpdesk.category.save",
    entityType: "helpdesk_category",
    entityId: id,
    details: input,
  });
  return id;
}
export async function deleteCategory(id: string, actorUserId: string) {
  await db
    .delete(helpdeskCategories)
    .where(
      or(eq(helpdeskCategories.id, id), eq(helpdeskCategories.parentId, id)),
    );
  await audit({
    actorUserId,
    action: "helpdesk.category.delete",
    entityType: "helpdesk_category",
    entityId: id,
  });
}

export { SYSTEM as SYSTEM_ACTOR };
