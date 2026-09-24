import { and, asc, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import Papa from "papaparse";
import { db } from "@/db";
import {
  companies,
  helpdeskCategories,
  helpdeskTeams,
  ticketTimeEntries,
  tickets,
  user,
} from "@/db/schema";
import { helpdeskSlaPolicies } from "@/db/schema/helpdesk-sla";
import {
  OPEN_STATUSES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  ticketReference,
  type TicketPriority,
  type TicketStatus,
} from "@/lib/validation-helpdesk";

export type ReportRange = { from: Date; to: Date };
export type ReportFilters = ReportRange & {
  companyId?: string | null;
  assigneeUserId?: string | null;
  teamId?: string | null;
  categoryId?: string | null;
  priority?: string | null;
};

/** Parses ?from=YYYY-MM-DD&to=YYYY-MM-DD, defaulting to the last 30 days; `to` is inclusive of that day. */
export function parseRange(from?: string | null, to?: string | null): ReportRange {
  const ok = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
  const end = ok(to) ? new Date(`${to}T00:00:00Z`) : new Date();
  const toDate = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1));
  const fromDate = ok(from)
    ? new Date(`${from}T00:00:00Z`)
    : new Date(toDate.getTime() - 30 * 86400000);
  return { from: fromDate, to: toDate };
}

const assignee = alias(user, "assignee");

function filterWhere(f: ReportFilters, dateColumn: TsColumn) {
  return and(
    isNull(tickets.mergedIntoTicketId),
    gte(dateColumn, f.from),
    lt(dateColumn, f.to),
    f.companyId ? eq(tickets.companyId, f.companyId) : undefined,
    f.assigneeUserId ? eq(tickets.assigneeUserId, f.assigneeUserId) : undefined,
    f.teamId ? eq(tickets.teamId, f.teamId) : undefined,
    f.categoryId ? eq(tickets.categoryId, f.categoryId) : undefined,
    f.priority ? eq(tickets.priority, f.priority as TicketPriority) : undefined,
  );
}

type TsColumn = typeof tickets.createdAt | typeof tickets.firstResponseAt | typeof tickets.resolvedAt;
const minutesBetween = (a: TsColumn, b: TsColumn) =>
  sql<number>`extract(epoch from (${b} - ${a})) / 60`;

/** Headline numbers for a period: volumes, response and resolution times, SLA attainment, reopen rate, backlog age. */
export async function helpdeskSummary(f: ReportFilters) {
  const created = filterWhere(f, tickets.createdAt);
  const resolved = filterWhere(f, tickets.resolvedAt);
  const [c] = await db
    .select({
      created: sql<number>`count(*)`.mapWith(Number),
      responded: sql<number>`count(*) filter (where ${tickets.firstResponseAt} is not null)`.mapWith(Number),
      medianFirstResponse:
        sql<number | null>`percentile_cont(0.5) within group (order by ${minutesBetween(tickets.createdAt, tickets.firstResponseAt)}) filter (where ${tickets.firstResponseAt} is not null)`.mapWith(
          (v) => (v === null ? null : Number(v)),
        ),
      avgFirstResponse:
        sql<number | null>`avg(${minutesBetween(tickets.createdAt, tickets.firstResponseAt)}) filter (where ${tickets.firstResponseAt} is not null)`.mapWith(
          (v) => (v === null ? null : Number(v)),
        ),
      frWithTarget:
        sql<number>`count(*) filter (where ${tickets.firstResponseDueAt} is not null and ${tickets.firstResponseAt} is not null)`.mapWith(Number),
      frMet:
        sql<number>`count(*) filter (where ${tickets.firstResponseDueAt} is not null and ${tickets.firstResponseAt} is not null and not ${tickets.firstResponseBreached})`.mapWith(Number),
      byEmail: sql<number>`count(*) filter (where ${tickets.source} = 'email')`.mapWith(Number),
      reopened: sql<number>`count(*) filter (where ${tickets.reopenCount} > 0)`.mapWith(Number),
    })
    .from(tickets)
    .where(created);
  const [r] = await db
    .select({
      resolved: sql<number>`count(*)`.mapWith(Number),
      medianResolution:
        sql<number | null>`percentile_cont(0.5) within group (order by ${minutesBetween(tickets.createdAt, tickets.resolvedAt)})`.mapWith(
          (v) => (v === null ? null : Number(v)),
        ),
      avgResolution:
        sql<number | null>`avg(${minutesBetween(tickets.createdAt, tickets.resolvedAt)})`.mapWith(
          (v) => (v === null ? null : Number(v)),
        ),
      resWithTarget: sql<number>`count(*) filter (where ${tickets.resolutionDueAt} is not null)`.mapWith(Number),
      resMet:
        sql<number>`count(*) filter (where ${tickets.resolutionDueAt} is not null and not ${tickets.resolutionBreached})`.mapWith(Number),
      minutesLogged: sql<number>`coalesce(sum(${tickets.timeSpentMinutes}), 0)`.mapWith(Number),
    })
    .from(tickets)
    .where(resolved);
  const [b] = await db
    .select({
      open: sql<number>`count(*)`.mapWith(Number),
      avgAgeHours:
        sql<number | null>`avg(extract(epoch from (now() - ${tickets.createdAt})) / 3600)`.mapWith(
          (v) => (v === null ? null : Number(v)),
        ),
      oldestHours:
        sql<number | null>`max(extract(epoch from (now() - ${tickets.createdAt})) / 3600)`.mapWith(
          (v) => (v === null ? null : Number(v)),
        ),
      over7d: sql<number>`count(*) filter (where ${tickets.createdAt} < now() - interval '7 days')`.mapWith(Number),
      breached:
        sql<number>`count(*) filter (where ${tickets.firstResponseBreached} or ${tickets.resolutionBreached})`.mapWith(Number),
    })
    .from(tickets)
    .where(
      and(
        isNull(tickets.mergedIntoTicketId),
        sql`${tickets.status} in (${sql.join(OPEN_STATUSES.map((s) => sql`${s}`), sql`, `)})`,
        f.companyId ? eq(tickets.companyId, f.companyId) : undefined,
        f.assigneeUserId ? eq(tickets.assigneeUserId, f.assigneeUserId) : undefined,
        f.teamId ? eq(tickets.teamId, f.teamId) : undefined,
        f.categoryId ? eq(tickets.categoryId, f.categoryId) : undefined,
        f.priority ? eq(tickets.priority, f.priority as TicketPriority) : undefined,
      ),
    );
  return {
    created: c.created,
    byEmail: c.byEmail,
    resolved: r.resolved,
    responded: c.responded,
    medianFirstResponseMinutes: c.medianFirstResponse,
    avgFirstResponseMinutes: c.avgFirstResponse,
    medianResolutionMinutes: r.medianResolution,
    avgResolutionMinutes: r.avgResolution,
    firstResponseAttainment: c.frWithTarget ? c.frMet / c.frWithTarget : null,
    firstResponseWithTarget: c.frWithTarget,
    resolutionAttainment: r.resWithTarget ? r.resMet / r.resWithTarget : null,
    resolutionWithTarget: r.resWithTarget,
    reopenRate: c.created ? c.reopened / c.created : null,
    reopened: c.reopened,
    minutesLogged: r.minutesLogged,
    backlog: {
      open: b.open,
      avgAgeHours: b.avgAgeHours,
      oldestHours: b.oldestHours,
      over7d: b.over7d,
      breached: b.breached,
    },
  };
}

/** Tickets created per day in the range, with resolved per day alongside. */
export async function helpdeskTrend(f: ReportFilters) {
  const created = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${tickets.createdAt}), 'YYYY-MM-DD')`,
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(tickets)
    .where(filterWhere(f, tickets.createdAt))
    .groupBy(sql`date_trunc('day', ${tickets.createdAt})`)
    .orderBy(sql`date_trunc('day', ${tickets.createdAt})`);
  const resolved = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${tickets.resolvedAt}), 'YYYY-MM-DD')`,
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(tickets)
    .where(filterWhere(f, tickets.resolvedAt))
    .groupBy(sql`date_trunc('day', ${tickets.resolvedAt})`);
  const map = new Map<string, { day: string; created: number; resolved: number }>();
  for (let d = new Date(f.from); d < f.to; d = new Date(d.getTime() + 86400000)) {
    const key = d.toISOString().slice(0, 10);
    map.set(key, { day: key, created: 0, resolved: 0 });
  }
  for (const c of created) {
    const row = map.get(c.day);
    if (row) row.created = c.n;
  }
  for (const r of resolved) {
    const row = map.get(r.day);
    if (row) row.resolved = r.n;
  }
  return [...map.values()];
}

/** Per-dimension breakdowns over the period: created, resolved, median resolution, attainment. */
export async function helpdeskBreakdowns(f: ReportFilters) {
  const created = filterWhere(f, tickets.createdAt);
  const metric = {
    created: sql<number>`count(*)`.mapWith(Number),
    resolved: sql<number>`count(*) filter (where ${tickets.resolvedAt} is not null)`.mapWith(Number),
    medianResolution:
      sql<number | null>`percentile_cont(0.5) within group (order by ${minutesBetween(tickets.createdAt, tickets.resolvedAt)}) filter (where ${tickets.resolvedAt} is not null)`.mapWith(
        (v) => (v === null ? null : Number(v)),
      ),
    breached:
      sql<number>`count(*) filter (where ${tickets.firstResponseBreached} or ${tickets.resolutionBreached})`.mapWith(Number),
    minutes: sql<number>`coalesce(sum(${tickets.timeSpentMinutes}), 0)`.mapWith(Number),
  };
  const [byAgent, byTeam, byCategory, byCompany, byPriority, bySource, byType] = await Promise.all([
    db
      .select({ key: sql<string>`coalesce(${assignee.name}, 'Unassigned')`, ...metric })
      .from(tickets)
      .leftJoin(assignee, eq(assignee.id, tickets.assigneeUserId))
      .where(created)
      .groupBy(sql`coalesce(${assignee.name}, 'Unassigned')`)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({ key: sql<string>`coalesce(${helpdeskTeams.name}, 'No team')`, ...metric })
      .from(tickets)
      .leftJoin(helpdeskTeams, eq(helpdeskTeams.id, tickets.teamId))
      .where(created)
      .groupBy(sql`coalesce(${helpdeskTeams.name}, 'No team')`)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({ key: sql<string>`coalesce(${helpdeskCategories.name}, 'Uncategorised')`, ...metric })
      .from(tickets)
      .leftJoin(helpdeskCategories, eq(helpdeskCategories.id, tickets.categoryId))
      .where(created)
      .groupBy(sql`coalesce(${helpdeskCategories.name}, 'Uncategorised')`)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({ key: sql<string>`coalesce(${companies.name}, 'No company')`, ...metric })
      .from(tickets)
      .leftJoin(companies, eq(companies.id, tickets.companyId))
      .where(created)
      .groupBy(sql`coalesce(${companies.name}, 'No company')`)
      .orderBy(desc(sql`count(*)`))
      .limit(25),
    db
      .select({ key: tickets.priority, ...metric })
      .from(tickets)
      .where(created)
      .groupBy(tickets.priority),
    db
      .select({ key: tickets.source, ...metric })
      .from(tickets)
      .where(created)
      .groupBy(tickets.source),
    db
      .select({ key: tickets.type, ...metric })
      .from(tickets)
      .where(created)
      .groupBy(tickets.type),
  ]);
  return {
    byAgent,
    byTeam,
    byCategory,
    byCompany,
    byPriority: byPriority.map((r) => ({
      ...r,
      key: TICKET_PRIORITY_LABELS[r.key as TicketPriority] ?? r.key,
    })),
    bySource,
    byType,
  };
}

/** Time logged per agent and per customer in the range (by entry date, not ticket date). */
export async function helpdeskTimeReport(f: ReportRange) {
  const where = and(gte(ticketTimeEntries.createdAt, f.from), lt(ticketTimeEntries.createdAt, f.to));
  const [byAgent, byCompany] = await Promise.all([
    db
      .select({
        key: user.name,
        minutes: sql<number>`sum(${ticketTimeEntries.minutes})`.mapWith(Number),
        billable: sql<number>`sum(${ticketTimeEntries.minutes}) filter (where ${ticketTimeEntries.billable})`.mapWith(Number),
        entries: sql<number>`count(*)`.mapWith(Number),
      })
      .from(ticketTimeEntries)
      .innerJoin(user, eq(user.id, ticketTimeEntries.userId))
      .where(where)
      .groupBy(user.name)
      .orderBy(desc(sql`sum(${ticketTimeEntries.minutes})`)),
    db
      .select({
        key: sql<string>`coalesce(${companies.name}, 'No company')`,
        minutes: sql<number>`sum(${ticketTimeEntries.minutes})`.mapWith(Number),
        billable: sql<number>`sum(${ticketTimeEntries.minutes}) filter (where ${ticketTimeEntries.billable})`.mapWith(Number),
        entries: sql<number>`count(*)`.mapWith(Number),
      })
      .from(ticketTimeEntries)
      .innerJoin(tickets, eq(tickets.id, ticketTimeEntries.ticketId))
      .leftJoin(companies, eq(companies.id, tickets.companyId))
      .where(where)
      .groupBy(sql`coalesce(${companies.name}, 'No company')`)
      .orderBy(desc(sql`sum(${ticketTimeEntries.minutes})`)),
  ]);
  return { byAgent, byCompany };
}

export const HELPDESK_EXPORTS = ["tickets", "sla", "time", "agents", "companies"] as const;
export type HelpdeskExport = (typeof HELPDESK_EXPORTS)[number];

/** CSV exports for the period (helpdesk.manage). Ticket rows carry the fields a spreadsheet needs, never message bodies. */
export async function exportHelpdeskCsv(kind: HelpdeskExport, f: ReportFilters) {
  const iso = (d: Date | null) => (d ? d.toISOString() : "");
  if (kind === "tickets" || kind === "sla") {
    const rows = await db
      .select({
        number: tickets.number,
        subject: tickets.subject,
        status: tickets.status,
        priority: tickets.priority,
        type: tickets.type,
        source: tickets.source,
        company: companies.name,
        requester: tickets.requesterName,
        requesterEmail: tickets.requesterEmail,
        assignee: assignee.name,
        team: helpdeskTeams.name,
        category: helpdeskCategories.name,
        tags: tickets.tags,
        createdAt: tickets.createdAt,
        firstResponseAt: tickets.firstResponseAt,
        firstResponseDueAt: tickets.firstResponseDueAt,
        firstResponseBreached: tickets.firstResponseBreached,
        resolvedAt: tickets.resolvedAt,
        resolutionDueAt: tickets.resolutionDueAt,
        resolutionBreached: tickets.resolutionBreached,
        closedAt: tickets.closedAt,
        reopenCount: tickets.reopenCount,
        timeSpentMinutes: tickets.timeSpentMinutes,
        policy: helpdeskSlaPolicies.name,
        resolutionCategory: tickets.resolutionCategory,
      })
      .from(tickets)
      .leftJoin(companies, eq(companies.id, tickets.companyId))
      .leftJoin(assignee, eq(assignee.id, tickets.assigneeUserId))
      .leftJoin(helpdeskTeams, eq(helpdeskTeams.id, tickets.teamId))
      .leftJoin(helpdeskCategories, eq(helpdeskCategories.id, tickets.categoryId))
      .leftJoin(helpdeskSlaPolicies, eq(helpdeskSlaPolicies.id, tickets.slaPolicyId))
      .where(filterWhere(f, tickets.createdAt))
      .orderBy(asc(tickets.number));
    if (kind === "sla")
      return Papa.unparse(
        rows.map((r) => ({
          reference: ticketReference(r.number),
          subject: r.subject,
          company: r.company ?? "",
          priority: r.priority,
          policy: r.policy ?? "",
          createdAt: iso(r.createdAt),
          firstResponseDueAt: iso(r.firstResponseDueAt),
          firstResponseAt: iso(r.firstResponseAt),
          firstResponseMet: r.firstResponseDueAt ? (r.firstResponseBreached ? "no" : r.firstResponseAt ? "yes" : "pending") : "n/a",
          resolutionDueAt: iso(r.resolutionDueAt),
          resolvedAt: iso(r.resolvedAt),
          resolutionMet: r.resolutionDueAt ? (r.resolutionBreached ? "no" : r.resolvedAt ? "yes" : "pending") : "n/a",
          status: TICKET_STATUS_LABELS[r.status as TicketStatus] ?? r.status,
        })),
      );
    return Papa.unparse(
      rows.map((r) => ({
        reference: ticketReference(r.number),
        subject: r.subject,
        status: r.status,
        priority: r.priority,
        type: r.type,
        source: r.source,
        company: r.company ?? "",
        requester: r.requester ?? "",
        requesterEmail: r.requesterEmail ?? "",
        assignee: r.assignee ?? "",
        team: r.team ?? "",
        category: r.category ?? "",
        tags: r.tags.join("; "),
        createdAt: iso(r.createdAt),
        firstResponseAt: iso(r.firstResponseAt),
        resolvedAt: iso(r.resolvedAt),
        closedAt: iso(r.closedAt),
        reopenCount: r.reopenCount,
        timeSpentMinutes: r.timeSpentMinutes,
        resolutionCategory: r.resolutionCategory ?? "",
      })),
    );
  }
  if (kind === "time") {
    const rows = await db
      .select({
        number: tickets.number,
        subject: tickets.subject,
        company: companies.name,
        agent: user.name,
        minutes: ticketTimeEntries.minutes,
        billable: ticketTimeEntries.billable,
        note: ticketTimeEntries.note,
        at: ticketTimeEntries.createdAt,
      })
      .from(ticketTimeEntries)
      .innerJoin(tickets, eq(tickets.id, ticketTimeEntries.ticketId))
      .innerJoin(user, eq(user.id, ticketTimeEntries.userId))
      .leftJoin(companies, eq(companies.id, tickets.companyId))
      .where(and(gte(ticketTimeEntries.createdAt, f.from), lt(ticketTimeEntries.createdAt, f.to)))
      .orderBy(asc(ticketTimeEntries.createdAt));
    return Papa.unparse(
      rows.map((r) => ({
        at: iso(r.at),
        reference: ticketReference(r.number),
        subject: r.subject,
        company: r.company ?? "",
        agent: r.agent,
        minutes: r.minutes,
        billable: r.billable ? "yes" : "no",
        note: r.note ?? "",
      })),
    );
  }
  const b = await helpdeskBreakdowns(f);
  const rows = kind === "agents" ? b.byAgent : b.byCompany;
  return Papa.unparse(
    rows.map((r) => ({
      [kind === "agents" ? "agent" : "company"]: r.key,
      created: r.created,
      resolved: r.resolved,
      medianResolutionMinutes: r.medianResolution === null ? "" : Math.round(r.medianResolution),
      breached: r.breached,
      minutesLogged: r.minutes,
    })),
  );
}
