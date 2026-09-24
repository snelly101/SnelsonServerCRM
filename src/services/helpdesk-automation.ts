import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { helpdeskCategories, helpdeskTeams, tickets, user } from "@/db/schema";
import {
  helpdeskAutomationRules,
  helpdeskAutomationRuns,
  type RuleAction,
  type RuleCondition,
} from "@/db/schema/helpdesk-sla";
import { audit } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { logger } from "@/lib/logger";
import {
  OPEN_STATUSES,
  type TicketPriority,
  type TicketStatus,
} from "@/lib/validation-helpdesk";
import {
  addMessage,
  assignTicket,
  changeStatus,
  recordEvent,
  type Actor,
} from "./helpdesk";
import { notifyUsers } from "./helpdesk-notifications";
import { recomputeTicketSla } from "./helpdesk-sla";

export type Trigger = typeof helpdeskAutomationRules.$inferSelect.trigger;
export type Rule = typeof helpdeskAutomationRules.$inferSelect;
const AUTOMATION: Actor = { id: null, type: "automation" };
const MAX_CHAIN_DEPTH = 3;

export const RULE_FIELDS = [
  "status",
  "priority",
  "type",
  "source",
  "categoryId",
  "subcategoryId",
  "teamId",
  "assigneeUserId",
  "companyId",
  "tags",
  "subject",
  "requesterEmail",
  "requesterDomain",
  "requesterUnverified",
  "needsReview",
  "hoursSinceActivity",
  "hoursSinceCreated",
  "hoursSinceResolved",
] as const;

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
export async function listRules() {
  const rules = await db
    .select()
    .from(helpdeskAutomationRules)
    .orderBy(
      asc(helpdeskAutomationRules.sortOrder),
      asc(helpdeskAutomationRules.createdAt),
    );
  const stats = await db
    .select({
      ruleId: helpdeskAutomationRuns.ruleId,
      runs: sql<number>`count(*)`.mapWith(Number),
      matched: sql<number>`count(*) filter (where matched)`.mapWith(Number),
      last: sql<Date | null>`max(at)`,
    })
    .from(helpdeskAutomationRuns)
    .where(gte(helpdeskAutomationRuns.at, new Date(Date.now() - 7 * 86400000)))
    .groupBy(helpdeskAutomationRuns.ruleId);
  return rules.map((r) => ({
    ...r,
    stats: stats.find((s) => s.ruleId === r.id) ?? {
      runs: 0,
      matched: 0,
      last: null,
    },
  }));
}
export async function saveRule(
  id: string | null,
  input: {
    name: string;
    description: string | null;
    trigger: Trigger;
    match: "all" | "any";
    conditions: RuleCondition[];
    actions: RuleAction[];
    sortOrder: number;
    stopProcessing: boolean;
    cooldownMinutes: number;
    afterMinutes: number | null;
    active: boolean;
  },
  actorUserId: string,
) {
  if (input.actions.length === 0)
    throw new ActionError("Add at least one action.");
  for (const c of input.conditions)
    if (!(RULE_FIELDS as readonly string[]).includes(c.field))
      throw new ActionError(`Unknown condition field "${c.field}".`);
  if (id)
    await db
      .update(helpdeskAutomationRules)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(helpdeskAutomationRules.id, id));
  else
    id = (
      await db
        .insert(helpdeskAutomationRules)
        .values({ ...input, createdByUserId: actorUserId })
        .returning({ id: helpdeskAutomationRules.id })
    )[0].id;
  await audit({
    actorUserId,
    action: "helpdesk.rule.save",
    entityType: "helpdesk_rule",
    entityId: id,
    details: {
      name: input.name,
      trigger: input.trigger,
      actions: input.actions.map((a) => a.type),
    },
  });
  return id;
}
export async function deleteRule(id: string, actorUserId: string) {
  await db
    .delete(helpdeskAutomationRules)
    .where(eq(helpdeskAutomationRules.id, id));
  await audit({
    actorUserId,
    action: "helpdesk.rule.delete",
    entityType: "helpdesk_rule",
    entityId: id,
  });
}
export async function listRuleRuns(limit = 50) {
  return db
    .select({
      run: helpdeskAutomationRuns,
      ruleName: helpdeskAutomationRules.name,
      ticketNumber: tickets.number,
      ticketSubject: tickets.subject,
    })
    .from(helpdeskAutomationRuns)
    .innerJoin(
      helpdeskAutomationRules,
      eq(helpdeskAutomationRules.id, helpdeskAutomationRuns.ruleId),
    )
    .innerJoin(tickets, eq(tickets.id, helpdeskAutomationRuns.ticketId))
    .orderBy(desc(helpdeskAutomationRuns.at))
    .limit(limit)
    .then((rows) =>
      rows.map((r) => ({
        ...r.run,
        ruleName: r.ruleName,
        ticketNumber: r.ticketNumber,
        ticketSubject: r.ticketSubject,
      })),
    );
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
type Snapshot = Record<string, unknown>;
async function snapshot(
  ticketId: string,
): Promise<(Snapshot & { id: string; number: number }) | null> {
  const [t] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!t) return null;
  const h = (d: Date | null) =>
    d ? (Date.now() - d.getTime()) / 3600000 : null;
  return {
    ...t,
    requesterDomain: t.requesterEmail?.split("@")[1] ?? null,
    hoursSinceActivity: h(t.lastActivityAt),
    hoursSinceCreated: h(t.createdAt),
    hoursSinceResolved: h(t.resolvedAt),
  };
}

export function evaluateCondition(c: RuleCondition, snap: Snapshot): boolean {
  const v = snap[c.field];
  const val = c.value;
  const list = Array.isArray(val)
    ? val.map(String)
    : val === null || val === undefined
      ? []
      : [String(val)];
  const str = (x: unknown) =>
    (x === null || x === undefined ? "" : String(x)).toLowerCase();
  switch (c.op) {
    case "eq":
      return Array.isArray(v)
        ? v.map(String).includes(String(val))
        : str(v) === str(val);
    case "neq":
      return Array.isArray(v)
        ? !v.map(String).includes(String(val))
        : str(v) !== str(val);
    case "in":
      return Array.isArray(v)
        ? v.some((x) => list.includes(String(x)))
        : list.map((x) => x.toLowerCase()).includes(str(v));
    case "contains":
      return Array.isArray(v)
        ? v.map(String).some((x) => x.toLowerCase().includes(str(val)))
        : str(v).includes(str(val));
    case "empty":
      return (
        v === null ||
        v === undefined ||
        v === "" ||
        (Array.isArray(v) && v.length === 0)
      );
    case "not_empty":
      return !(
        v === null ||
        v === undefined ||
        v === "" ||
        (Array.isArray(v) && v.length === 0)
      );
    case "gt":
      return typeof v === "number" && v > Number(val);
    case "lt":
      return typeof v === "number" && v < Number(val);
    default:
      return false;
  }
}
export function ruleMatches(
  rule: Pick<Rule, "match" | "conditions">,
  snap: Snapshot,
) {
  if (rule.conditions.length === 0) return true;
  const results = rule.conditions.map((c) => evaluateCondition(c, snap));
  return rule.match === "any" ? results.some(Boolean) : results.every(Boolean);
}

async function applyAction(
  a: RuleAction,
  snap: Snapshot & { id: string; number: number },
  rule: Rule,
  depth: number,
): Promise<boolean> {
  const id = snap.id;
  const val = Array.isArray(a.value) ? a.value[0] : (a.value ?? null);
  switch (a.type) {
    case "assign_user": {
      if (!val || snap.assigneeUserId === val) return false;
      await assignTicket(id, { assigneeUserId: val }, AUTOMATION);
      const [u] = await db
        .select({ name: user.name })
        .from(user)
        .where(eq(user.id, val))
        .limit(1);
      await notifyUsers([val], {
        kind: "assigned",
        title: `Assigned to you by rule "${rule.name}": IT-${String(snap.number).padStart(6, "0")}`,
        body: String(snap.subject),
        ticketId: id,
      });
      return Boolean(u);
    }
    case "assign_team":
      if (!val || snap.teamId === val) return false;
      await assignTicket(id, { teamId: val }, AUTOMATION);
      return true;
    case "set_priority":
      if (!val || snap.priority === val) return false;
      await db
        .update(tickets)
        .set({
          priority: val as TicketPriority,
          version: sql`${tickets.version} + 1`,
        })
        .where(eq(tickets.id, id));
      await recordEvent(
        id,
        "priority",
        `Priority → ${val} (rule "${rule.name}")`,
        AUTOMATION,
        { from: snap.priority, to: val, ruleId: rule.id },
      );
      await recomputeTicketSla(id, `priority set by rule "${rule.name}"`);
      return true;
    case "set_type":
      if (!val || snap.type === val) return false;
      await db
        .update(tickets)
        .set({ type: val as "incident", version: sql`${tickets.version} + 1` })
        .where(eq(tickets.id, id));
      await recordEvent(
        id,
        "field",
        `Type → ${val} (rule "${rule.name}")`,
        AUTOMATION,
        { ruleId: rule.id },
      );
      return true;
    case "set_category": {
      if (!val || snap.categoryId === val) return false;
      const [c] = await db
        .select({
          id: helpdeskCategories.id,
          parentId: helpdeskCategories.parentId,
          name: helpdeskCategories.name,
        })
        .from(helpdeskCategories)
        .where(eq(helpdeskCategories.id, val))
        .limit(1);
      if (!c) return false;
      await db
        .update(tickets)
        .set(
          c.parentId
            ? { categoryId: c.parentId, subcategoryId: c.id }
            : { categoryId: c.id, subcategoryId: null },
        )
        .where(eq(tickets.id, id));
      await recordEvent(
        id,
        "field",
        `Category → ${c.name} (rule "${rule.name}")`,
        AUTOMATION,
        { ruleId: rule.id },
      );
      return true;
    }
    case "add_tag": {
      const tags = (snap.tags as string[]) ?? [];
      const add = (Array.isArray(a.value) ? a.value : [val])
        .map((x) =>
          String(x ?? "")
            .toLowerCase()
            .trim(),
        )
        .filter((x) => x && !tags.includes(x));
      if (add.length === 0) return false;
      await db
        .update(tickets)
        .set({ tags: [...tags, ...add] })
        .where(eq(tickets.id, id));
      await recordEvent(
        id,
        "field",
        `Tags + ${add.join(", ")} (rule "${rule.name}")`,
        AUTOMATION,
        { ruleId: rule.id },
      );
      return true;
    }
    case "remove_tag": {
      const tags = (snap.tags as string[]) ?? [];
      const remove = new Set(
        (Array.isArray(a.value) ? a.value : [val]).map((x) =>
          String(x ?? "")
            .toLowerCase()
            .trim(),
        ),
      );
      const next = tags.filter((t) => !remove.has(t));
      if (next.length === tags.length) return false;
      await db.update(tickets).set({ tags: next }).where(eq(tickets.id, id));
      return true;
    }
    case "set_status":
      if (!val || snap.status === val) return false;
      await changeStatus(id, val as TicketStatus, AUTOMATION, {
        reason: `rule "${rule.name}"`,
        resolutionSummary:
          val === "resolved"
            ? `Resolved automatically by rule "${rule.name}".`
            : undefined,
      });
      if (depth < MAX_CHAIN_DEPTH)
        await runAutomation("status_changed", id, depth + 1);
      return true;
    case "close":
      if (snap.status !== "resolved") return false;
      await changeStatus(id, "closed", AUTOMATION, {
        reason: `rule "${rule.name}"`,
      });
      return true;
    case "add_note":
      if (!val) return false;
      await addMessage(
        id,
        {
          kind: "internal",
          body: String(val),
          channel: "note",
          to: [],
          cc: [],
          bcc: [],
          status: null,
          replyToMessageId: null,
        },
        { ...AUTOMATION, name: `Rule: ${rule.name}` },
      );
      return true;
    case "notify_users": {
      const ids = Array.isArray(a.value) ? a.value : val ? [val] : [];
      if (ids.length === 0) return false;
      await notifyUsers(ids, {
        kind: "automation",
        title: `Rule "${rule.name}": IT-${String(snap.number).padStart(6, "0")} ${snap.subject}`,
        ticketId: id,
      });
      return true;
    }
    case "notify_assignee":
      if (!snap.assigneeUserId) return false;
      await notifyUsers([snap.assigneeUserId as string], {
        kind: "automation",
        title: `Rule "${rule.name}": IT-${String(snap.number).padStart(6, "0")} ${snap.subject}`,
        ticketId: id,
      });
      return true;
    default:
      return false;
  }
}

/**
 * Runs the active rules for a trigger against one ticket, in order. Guards:
 * per-rule cooldown per ticket, `stopProcessing`, and a chain depth limit
 * so a status change made by a rule cannot ping-pong for ever.
 */
export async function runAutomation(
  trigger: Trigger,
  ticketId: string,
  depth = 0,
): Promise<{ applied: number; matched: number }> {
  const rules = await db
    .select()
    .from(helpdeskAutomationRules)
    .where(
      and(
        eq(helpdeskAutomationRules.trigger, trigger),
        eq(helpdeskAutomationRules.active, true),
      ),
    )
    .orderBy(
      asc(helpdeskAutomationRules.sortOrder),
      asc(helpdeskAutomationRules.createdAt),
    );
  let applied = 0;
  let matched = 0;
  for (const rule of rules) {
    const snap = await snapshot(ticketId);
    if (!snap || snap.mergedIntoTicketId) break;
    const [recent] = await db
      .select({ id: helpdeskAutomationRuns.id })
      .from(helpdeskAutomationRuns)
      .where(
        and(
          eq(helpdeskAutomationRuns.ruleId, rule.id),
          eq(helpdeskAutomationRuns.ticketId, ticketId),
          eq(helpdeskAutomationRuns.matched, true),
          gte(
            helpdeskAutomationRuns.at,
            new Date(Date.now() - rule.cooldownMinutes * 60000),
          ),
        ),
      )
      .limit(1);
    if (recent) continue;
    const ok = ruleMatches(rule, snap);
    if (!ok) continue;
    matched++;
    const done: RuleAction[] = [];
    let error: string | null = null;
    try {
      for (const a of rule.actions)
        if (await applyAction(a, snap, rule, depth)) done.push(a);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.warn(
        { rule: rule.name, ticketId, err: error },
        "automation action failed",
      );
    }
    await db
      .insert(helpdeskAutomationRuns)
      .values({
        ruleId: rule.id,
        ticketId,
        trigger,
        matched: true,
        actionsApplied: done,
        error,
      });
    if (done.length) {
      applied++;
      await recordEvent(
        ticketId,
        "automation",
        `Rule "${rule.name}" applied ${done.map((a) => a.type.replace("_", " ")).join(", ")}`,
        AUTOMATION,
        { ruleId: rule.id, actions: done },
      );
    }
    if (rule.stopProcessing) break;
  }
  return { applied, matched };
}

/** Scheduled rules (e.g. close resolved tickets after N days, escalate untouched tickets). Cooldown stops repeats. */
export async function runScheduledRules() {
  const rules = await db
    .select()
    .from(helpdeskAutomationRules)
    .where(
      and(
        eq(helpdeskAutomationRules.trigger, "schedule"),
        eq(helpdeskAutomationRules.active, true),
      ),
    )
    .orderBy(asc(helpdeskAutomationRules.sortOrder));
  let applied = 0;
  for (const rule of rules) {
    const cutoff = new Date(Date.now() - (rule.afterMinutes ?? 0) * 60000);
    const candidates = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          isNull(tickets.mergedIntoTicketId),
          inArray(tickets.status, [...OPEN_STATUSES, "resolved"]),
          lt(tickets.lastActivityAt, cutoff),
        ),
      )
      .limit(500);
    for (const c of candidates) {
      const snap = await snapshot(c.id);
      if (!snap || !ruleMatches(rule, snap)) continue;
      const [recent] = await db
        .select({ id: helpdeskAutomationRuns.id })
        .from(helpdeskAutomationRuns)
        .where(
          and(
            eq(helpdeskAutomationRuns.ruleId, rule.id),
            eq(helpdeskAutomationRuns.ticketId, c.id),
            eq(helpdeskAutomationRuns.matched, true),
            gte(
              helpdeskAutomationRuns.at,
              new Date(Date.now() - rule.cooldownMinutes * 60000),
            ),
          ),
        )
        .limit(1);
      if (recent) continue;
      const done: RuleAction[] = [];
      let error: string | null = null;
      try {
        for (const a of rule.actions)
          if (await applyAction(a, snap, rule, 0)) done.push(a);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      await db
        .insert(helpdeskAutomationRuns)
        .values({
          ruleId: rule.id,
          ticketId: c.id,
          trigger: "schedule",
          matched: true,
          actionsApplied: done,
          error,
        });
      if (done.length) {
        applied++;
        await recordEvent(
          c.id,
          "automation",
          `Rule "${rule.name}" applied ${done.map((a) => a.type.replace("_", " ")).join(", ")}`,
          AUTOMATION,
          { ruleId: rule.id, actions: done },
        );
      }
    }
  }
  return { applied };
}

export async function ruleOptions() {
  const [agents, teams, categories] = await Promise.all([
    db
      .select({ id: user.id, name: user.name })
      .from(user)
      .where(eq(user.active, true))
      .orderBy(asc(user.name)),
    db
      .select({ id: helpdeskTeams.id, name: helpdeskTeams.name })
      .from(helpdeskTeams)
      .where(eq(helpdeskTeams.active, true))
      .orderBy(asc(helpdeskTeams.name)),
    db
      .select({
        id: helpdeskCategories.id,
        name: helpdeskCategories.name,
        parentId: helpdeskCategories.parentId,
      })
      .from(helpdeskCategories)
      .where(eq(helpdeskCategories.active, true))
      .orderBy(asc(helpdeskCategories.sortOrder)),
  ]);
  return { agents, teams, categories };
}
