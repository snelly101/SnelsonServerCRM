import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { companies, tickets } from "@/db/schema";
import {
  helpdeskBusinessHours,
  helpdeskSlaAssignments,
  helpdeskSlaPolicies,
  ticketSlaEvents,
} from "@/db/schema/helpdesk-sla";
import { getAppSettings } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import {
  addBusinessMinutes,
  businessMinutesBetween,
  DEFAULT_SCHEDULE,
  type BusinessHours,
  type WeeklySchedule,
} from "@/lib/helpdesk/business-hours";
import {
  OPEN_STATUSES,
  type TicketPriority,
  type TicketStatus,
} from "@/lib/validation-helpdesk";
import { notifyUsers, ticketAudience } from "./helpdesk-notifications";

export type SlaPolicy = typeof helpdeskSlaPolicies.$inferSelect;
export type SlaTarget = "first_response" | "resolution";
const DUE_SOON_MINUTES = 60;

// ---------------------------------------------------------------------------
// Business hours and policies (admin)
// ---------------------------------------------------------------------------
export async function listBusinessHours() {
  return db
    .select()
    .from(helpdeskBusinessHours)
    .orderBy(asc(helpdeskBusinessHours.name));
}
export async function saveBusinessHours(
  id: string | null,
  input: {
    name: string;
    timezone: string;
    schedule: WeeklySchedule;
    holidays: string[];
    always: boolean;
  },
  actorUserId: string,
) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: input.timezone });
  } catch {
    throw new ActionError("Unknown time zone.", {
      timezone: ["Use an IANA name such as Europe/London"],
    });
  }
  if (id)
    await db
      .update(helpdeskBusinessHours)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(helpdeskBusinessHours.id, id));
  else
    id = (
      await db
        .insert(helpdeskBusinessHours)
        .values(input)
        .returning({ id: helpdeskBusinessHours.id })
    )[0].id;
  await audit({
    actorUserId,
    action: "helpdesk.business_hours.save",
    entityType: "helpdesk_business_hours",
    entityId: id,
    details: {
      name: input.name,
      timezone: input.timezone,
      holidays: input.holidays.length,
    },
  });
  await recomputeAll("business hours changed");
  return id;
}
export async function deleteBusinessHours(id: string, actorUserId: string) {
  await db
    .delete(helpdeskBusinessHours)
    .where(eq(helpdeskBusinessHours.id, id));
  await audit({
    actorUserId,
    action: "helpdesk.business_hours.delete",
    entityType: "helpdesk_business_hours",
    entityId: id,
  });
}
async function businessHoursFor(
  policy: SlaPolicy | null,
): Promise<BusinessHours> {
  const settings = await getAppSettings();
  const row = policy?.businessHoursId
    ? (
        await db
          .select()
          .from(helpdeskBusinessHours)
          .where(eq(helpdeskBusinessHours.id, policy.businessHoursId))
          .limit(1)
      )[0]
    : null;
  if (row)
    return {
      timezone: row.timezone,
      schedule: row.schedule,
      holidays: row.holidays,
      always: row.always,
    };
  // No schedule on the policy means round-the-clock cover.
  return {
    timezone: settings.timezone || "Europe/London",
    schedule: DEFAULT_SCHEDULE,
    holidays: [],
    always: true,
  };
}

export async function listSlaPolicies() {
  const policies = await db
    .select()
    .from(helpdeskSlaPolicies)
    .orderBy(
      desc(helpdeskSlaPolicies.isDefault),
      asc(helpdeskSlaPolicies.name),
    );
  const assignments = await db
    .select({
      policyId: helpdeskSlaAssignments.policyId,
      companyId: helpdeskSlaAssignments.companyId,
      companyName: companies.name,
    })
    .from(helpdeskSlaAssignments)
    .innerJoin(companies, eq(companies.id, helpdeskSlaAssignments.companyId))
    .orderBy(asc(companies.name));
  const hours = await db
    .select({ id: helpdeskBusinessHours.id, name: helpdeskBusinessHours.name })
    .from(helpdeskBusinessHours);
  return policies.map((p) => ({
    ...p,
    businessHoursName:
      hours.find((h) => h.id === p.businessHoursId)?.name ?? null,
    companies: assignments
      .filter((a) => a.policyId === p.id)
      .map((a) => ({ id: a.companyId, name: a.companyName })),
    companyIds: assignments
      .filter((a) => a.policyId === p.id)
      .map((a) => a.companyId),
  }));
}
export async function saveSlaPolicy(
  id: string | null,
  input: {
    name: string;
    description: string | null;
    businessHoursId: string | null;
    firstResponseMinutes: Record<string, number | null>;
    resolutionMinutes: Record<string, number | null>;
    pauseStatuses: string[];
    isDefault: boolean;
    active: boolean;
    companyIds: string[];
  },
  actorUserId: string,
) {
  const { companyIds, ...values } = input;
  await db.transaction(async (tx) => {
    if (values.isDefault)
      await tx
        .update(helpdeskSlaPolicies)
        .set({ isDefault: false })
        .where(id ? sql`${helpdeskSlaPolicies.id} <> ${id}` : sql`true`);
    if (id)
      await tx
        .update(helpdeskSlaPolicies)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(helpdeskSlaPolicies.id, id));
    else
      id = (
        await tx
          .insert(helpdeskSlaPolicies)
          .values(values)
          .returning({ id: helpdeskSlaPolicies.id })
      )[0].id;
    await tx
      .delete(helpdeskSlaAssignments)
      .where(eq(helpdeskSlaAssignments.policyId, id));
    if (companyIds.length) {
      await tx
        .delete(helpdeskSlaAssignments)
        .where(inArray(helpdeskSlaAssignments.companyId, companyIds));
      await tx
        .insert(helpdeskSlaAssignments)
        .values(companyIds.map((companyId) => ({ companyId, policyId: id! })));
    }
    await audit(
      {
        actorUserId,
        action: "helpdesk.sla.save",
        entityType: "helpdesk_sla_policy",
        entityId: id,
        details: {
          name: values.name,
          companies: companyIds.length,
          isDefault: values.isDefault,
        },
      },
      tx,
    );
  });
  await recomputeAll("policy changed");
  return id!;
}
export async function deleteSlaPolicy(id: string, actorUserId: string) {
  await db.delete(helpdeskSlaPolicies).where(eq(helpdeskSlaPolicies.id, id));
  await audit({
    actorUserId,
    action: "helpdesk.sla.delete",
    entityType: "helpdesk_sla_policy",
    entityId: id,
  });
  await recomputeAll("policy deleted");
}

/** Company agreement first, then the default policy. */
export async function resolvePolicy(
  companyId: string | null,
): Promise<SlaPolicy | null> {
  if (companyId) {
    const [a] = await db
      .select({ p: helpdeskSlaPolicies })
      .from(helpdeskSlaAssignments)
      .innerJoin(
        helpdeskSlaPolicies,
        eq(helpdeskSlaPolicies.id, helpdeskSlaAssignments.policyId),
      )
      .where(
        and(
          eq(helpdeskSlaAssignments.companyId, companyId),
          eq(helpdeskSlaPolicies.active, true),
        ),
      )
      .limit(1);
    if (a) return a.p;
  }
  const [d] = await db
    .select()
    .from(helpdeskSlaPolicies)
    .where(
      and(
        eq(helpdeskSlaPolicies.isDefault, true),
        eq(helpdeskSlaPolicies.active, true),
      ),
    )
    .limit(1);
  return d ?? null;
}

// ---------------------------------------------------------------------------
// Clock state from the event history
// ---------------------------------------------------------------------------
type Clock = {
  started: Date | null;
  paused: boolean;
  finished: "met" | "breach" | null;
  elapsedMinutes: number;
  dueAt: Date | null;
  intervals: { from: Date; to: Date | null }[];
};

async function eventsFor(
  ticketId: string,
  target: SlaTarget,
  tx: Tx | typeof db = db,
) {
  return tx
    .select()
    .from(ticketSlaEvents)
    .where(
      and(
        eq(ticketSlaEvents.ticketId, ticketId),
        eq(ticketSlaEvents.target, target),
      ),
    )
    .orderBy(asc(ticketSlaEvents.at), asc(ticketSlaEvents.id));
}

/** Replays the events into intervals of running time and the business minutes they consumed. */
function replay(
  events: (typeof ticketSlaEvents.$inferSelect)[],
  bh: BusinessHours,
  now: Date,
): Clock {
  const clock: Clock = {
    started: null,
    paused: false,
    finished: null,
    elapsedMinutes: 0,
    dueAt: null,
    intervals: [],
  };
  let open: Date | null = null;
  for (const e of events) {
    if (e.kind === "reset") {
      clock.intervals = [];
      open = null;
      clock.finished = null;
      clock.started = null;
      continue;
    }
    if (e.kind === "start") {
      clock.started = e.at;
      open = e.at;
      clock.finished = null;
    } else if (e.kind === "pause" && open) {
      clock.intervals.push({ from: open, to: e.at });
      open = null;
    } else if (e.kind === "resume" && !open && !clock.finished) open = e.at;
    else if (e.kind === "met" || e.kind === "breach") {
      if (open) {
        clock.intervals.push({ from: open, to: e.at });
        open = null;
      }
      if (e.kind === "met") clock.finished = "met";
      else if (!clock.finished) clock.finished = "breach";
    }
    if (e.dueAt) clock.dueAt = e.dueAt;
  }
  if (open) clock.intervals.push({ from: open, to: null });
  clock.paused = clock.started !== null && !open && !clock.finished;
  clock.elapsedMinutes = clock.intervals.reduce(
    (a, i) => a + businessMinutesBetween(i.from, i.to ?? now, bh),
    0,
  );
  return clock;
}

async function targetMinutes(
  policy: SlaPolicy | null,
  target: SlaTarget,
  priority: TicketPriority,
) {
  if (!policy) return null;
  const v = (
    target === "first_response"
      ? policy.firstResponseMinutes
      : policy.resolutionMinutes
  )[priority];
  return typeof v === "number" && v > 0 ? v : null;
}

async function write(
  ticketId: string,
  target: SlaTarget,
  kind: typeof ticketSlaEvents.$inferInsert.kind,
  extra: Partial<typeof ticketSlaEvents.$inferInsert> = {},
  tx: Tx | typeof db = db,
) {
  await tx.insert(ticketSlaEvents).values({ ticketId, target, kind, ...extra });
}

/**
 * Recomputes both clocks for a ticket from its events and the current policy,
 * then stores the projected deadlines on the ticket. Called on creation,
 * status change, priority/company change, first response and resolution.
 */
export async function recomputeTicketSla(
  ticketId: string,
  reason: string,
  tx: Tx | typeof db = db,
) {
  const [t] = await tx
    .select()
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!t || t.mergedIntoTicketId) return null;
  const policy = await resolvePolicy(t.companyId);
  const bh = await businessHoursFor(policy);
  const now = new Date();
  const out: Partial<typeof tickets.$inferInsert> = {
    slaPolicyId: policy?.id ?? null,
  };
  for (const target of ["first_response", "resolution"] as const) {
    const minutes = await targetMinutes(
      policy,
      target,
      t.priority as TicketPriority,
    );
    let events = await eventsFor(ticketId, target, tx);
    let clock = replay(events, bh, now);
    if (!minutes) {
      // No target for this priority/policy: clear the deadline but keep history.
      if (target === "first_response") out.firstResponseDueAt = null;
      else out.resolutionDueAt = null;
      continue;
    }
    // Start the clock on first sight.
    if (!clock.started) {
      await write(
        ticketId,
        target,
        "start",
        { at: t.createdAt, policyId: policy?.id ?? null, reason },
        tx,
      );
      events = await eventsFor(ticketId, target, tx);
      clock = replay(events, bh, now);
    }
    // Completion.
    const doneAt =
      target === "first_response" ? t.firstResponseAt : t.resolvedAt;
    if (doneAt && !clock.finished) {
      const elapsed = clock.intervals.reduce(
        (a, i) =>
          a +
          businessMinutesBetween(
            i.from,
            i.to && i.to < doneAt ? i.to : doneAt,
            bh,
          ),
        0,
      );
      await write(
        ticketId,
        target,
        elapsed <= minutes ? "met" : "breach",
        {
          at: doneAt,
          elapsedMinutes: Math.round(elapsed),
          dueAt: clock.dueAt,
          policyId: policy?.id ?? null,
          reason:
            elapsed <= minutes
              ? "completed within target"
              : "completed after target",
        },
        tx,
      );
      events = await eventsFor(ticketId, target, tx);
      clock = replay(events, bh, now);
    }
    // Reopened after completion: a fresh clock from now (history kept).
    if (!doneAt && clock.finished) {
      await write(
        ticketId,
        target,
        "reset",
        { at: now, reason: "reopened" },
        tx,
      );
      await write(
        ticketId,
        target,
        "start",
        { at: now, policyId: policy?.id ?? null, reason: "reopened" },
        tx,
      );
      events = await eventsFor(ticketId, target, tx);
      clock = replay(events, bh, now);
    }
    // Pause / resume for the resolution clock only.
    if (target === "resolution" && !clock.finished) {
      const shouldPause = policy?.pauseStatuses.includes(t.status) ?? false;
      if (shouldPause && !clock.paused) {
        await write(
          ticketId,
          target,
          "pause",
          {
            at: now,
            elapsedMinutes: Math.round(clock.elapsedMinutes),
            reason: `status ${t.status}`,
          },
          tx,
        );
        events = await eventsFor(ticketId, target, tx);
        clock = replay(events, bh, now);
      } else if (!shouldPause && clock.paused) {
        await write(
          ticketId,
          target,
          "resume",
          {
            at: now,
            elapsedMinutes: Math.round(clock.elapsedMinutes),
            reason: `status ${t.status}`,
          },
          tx,
        );
        events = await eventsFor(ticketId, target, tx);
        clock = replay(events, bh, now);
      }
    }
    // Projected deadline.
    let dueAt: Date | null = null;
    if (!clock.finished && !clock.paused) {
      const openInterval = clock.intervals[clock.intervals.length - 1];
      const consumedBefore = clock.intervals
        .slice(0, -1)
        .reduce(
          (a, i) => a + businessMinutesBetween(i.from, i.to ?? now, bh),
          0,
        );
      const remaining = Math.max(0, minutes - consumedBefore);
      dueAt = addBusinessMinutes(openInterval?.from ?? now, remaining, bh);
    }
    const stored = clock.dueAt?.getTime() ?? null;
    if (!clock.finished && (dueAt?.getTime() ?? null) !== stored)
      await write(
        ticketId,
        target,
        "policy_changed",
        {
          at: now,
          dueAt,
          elapsedMinutes: Math.round(clock.elapsedMinutes),
          policyId: policy?.id ?? null,
          reason: clock.paused ? "paused" : reason,
        },
        tx,
      );
    if (target === "first_response") {
      out.firstResponseDueAt = clock.finished ? clock.dueAt : dueAt;
      // An open clock past its deadline is flagged by checkSlaDeadlines (which
      // writes the breach event and notifies); here we only keep or clear it.
      out.firstResponseBreached = clock.finished
        ? clock.finished === "breach"
        : dueAt !== null && dueAt < now
          ? t.firstResponseBreached
          : false;
    } else {
      out.resolutionDueAt = clock.finished ? clock.dueAt : dueAt;
      out.resolutionBreached = clock.finished
        ? clock.finished === "breach"
        : dueAt !== null && dueAt < now
          ? t.resolutionBreached
          : false;
    }
  }
  await tx.update(tickets).set(out).where(eq(tickets.id, ticketId));
  return out;
}

async function recomputeAll(reason: string) {
  const rows = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(
      and(
        isNull(tickets.mergedIntoTicketId),
        inArray(tickets.status, OPEN_STATUSES),
      ),
    );
  for (const r of rows)
    await recomputeTicketSla(r.id, reason).catch(() => undefined);
}

/** Scheduled: flags breaches and warns assignees about deadlines within the hour. Returns what changed so automation can react. */
export async function checkSlaDeadlines() {
  const now = new Date();
  const soon = new Date(now.getTime() + DUE_SOON_MINUTES * 60000);
  const open = and(
    isNull(tickets.mergedIntoTicketId),
    inArray(tickets.status, OPEN_STATUSES),
  );
  const breaches: { ticketId: string; target: SlaTarget }[] = [];
  const dueSoon: { ticketId: string; target: SlaTarget }[] = [];
  const frRows = await db
    .select({
      id: tickets.id,
      number: tickets.number,
      subject: tickets.subject,
      due: tickets.firstResponseDueAt,
    })
    .from(tickets)
    .where(
      and(
        open,
        isNull(tickets.firstResponseAt),
        eq(tickets.firstResponseBreached, false),
        lt(tickets.firstResponseDueAt, now),
      ),
    );
  for (const r of frRows) {
    await db
      .update(tickets)
      .set({ firstResponseBreached: true })
      .where(eq(tickets.id, r.id));
    await write(r.id, "first_response", "breach", {
      at: now,
      dueAt: r.due,
      reason: "deadline passed without a response",
    });
    breaches.push({ ticketId: r.id, target: "first_response" });
    await notifyUsers(await ticketAudience(r.id), {
      kind: "sla_breached",
      title: `First response overdue on IT-${String(r.number).padStart(6, "0")}`,
      body: r.subject,
      ticketId: r.id,
    });
  }
  const resRows = await db
    .select({
      id: tickets.id,
      number: tickets.number,
      subject: tickets.subject,
      due: tickets.resolutionDueAt,
    })
    .from(tickets)
    .where(
      and(
        open,
        isNull(tickets.resolvedAt),
        eq(tickets.resolutionBreached, false),
        lt(tickets.resolutionDueAt, now),
      ),
    );
  for (const r of resRows) {
    await db
      .update(tickets)
      .set({ resolutionBreached: true })
      .where(eq(tickets.id, r.id));
    await write(r.id, "resolution", "breach", {
      at: now,
      dueAt: r.due,
      reason: "deadline passed without resolution",
    });
    breaches.push({ ticketId: r.id, target: "resolution" });
    await notifyUsers(await ticketAudience(r.id), {
      kind: "sla_breached",
      title: `Resolution overdue on IT-${String(r.number).padStart(6, "0")}`,
      body: r.subject,
      ticketId: r.id,
    });
  }
  const soonRows = await db
    .select({
      id: tickets.id,
      number: tickets.number,
      subject: tickets.subject,
      fr: tickets.firstResponseDueAt,
      res: tickets.resolutionDueAt,
      frDone: tickets.firstResponseAt,
    })
    .from(tickets)
    .where(
      and(
        open,
        sql`((${tickets.firstResponseAt} is null and ${tickets.firstResponseDueAt} between ${now} and ${soon}) or (${tickets.resolvedAt} is null and ${tickets.resolutionDueAt} between ${now} and ${soon}))`,
      ),
    );
  for (const r of soonRows) {
    const target: SlaTarget =
      !r.frDone && r.fr && r.fr <= soon ? "first_response" : "resolution";
    dueSoon.push({ ticketId: r.id, target });
    await notifyUsers(await ticketAudience(r.id), {
      kind: "sla_due",
      title: `${target === "first_response" ? "First response" : "Resolution"} due within the hour on IT-${String(r.number).padStart(6, "0")}`,
      body: r.subject,
      ticketId: r.id,
    });
  }
  return { breaches, dueSoon };
}

/** Human-readable clock state for the ticket page. */
export async function ticketSlaSummary(ticketId: string) {
  const [t] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!t) return null;
  const policy = t.slaPolicyId
    ? ((
        await db
          .select()
          .from(helpdeskSlaPolicies)
          .where(eq(helpdeskSlaPolicies.id, t.slaPolicyId))
          .limit(1)
      )[0] ?? null)
    : null;
  const bh = await businessHoursFor(policy);
  const now = new Date();
  const out: Record<
    SlaTarget,
    {
      targetMinutes: number | null;
      elapsedMinutes: number;
      paused: boolean;
      finished: "met" | "breach" | null;
      dueAt: Date | null;
      events: (typeof ticketSlaEvents.$inferSelect)[];
    }
  > = {
    first_response: {
      targetMinutes: null,
      elapsedMinutes: 0,
      paused: false,
      finished: null,
      dueAt: null,
      events: [],
    },
    resolution: {
      targetMinutes: null,
      elapsedMinutes: 0,
      paused: false,
      finished: null,
      dueAt: null,
      events: [],
    },
  };
  for (const target of ["first_response", "resolution"] as const) {
    const events = await eventsFor(ticketId, target);
    const clock = replay(events, bh, now);
    out[target] = {
      targetMinutes: await targetMinutes(
        policy,
        target,
        t.priority as TicketPriority,
      ),
      elapsedMinutes: Math.round(clock.elapsedMinutes),
      paused: clock.paused,
      finished: clock.finished,
      dueAt: clock.finished
        ? clock.dueAt
        : target === "first_response"
          ? t.firstResponseDueAt
          : t.resolutionDueAt,
      events,
    };
  }
  return {
    policy: policy
      ? {
          id: policy.id,
          name: policy.name,
          pauseStatuses: policy.pauseStatuses as TicketStatus[],
        }
      : null,
    businessHours: { timezone: bh.timezone, always: Boolean(bh.always) },
    ...out,
  };
}
