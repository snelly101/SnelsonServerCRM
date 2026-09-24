import { describe, expect, it, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { tickets, ticketEvents } from "@/db/schema";
import {
  helpdeskAutomationRuns,
  helpdeskNotifications,
  ticketSlaEvents,
} from "@/db/schema/helpdesk-sla";
import { createCompany } from "@/services/companies";
import { createContact } from "@/services/contacts";
import { companySchema, contactSchema } from "@/lib/validation";
import {
  addMessage,
  assignTicket,
  changeStatus,
  createTicket,
  getTicket,
  toggleFollower,
  updateTicketFields,
} from "@/services/helpdesk";
import {
  checkSlaDeadlines,
  recomputeTicketSla,
  saveBusinessHours,
  saveSlaPolicy,
  ticketSlaSummary,
} from "@/services/helpdesk-sla";
import {
  evaluateCondition,
  runAutomation,
  runScheduledRules,
  saveRule,
} from "@/services/helpdesk-automation";
import {
  listNotifications,
  markNotificationsRead,
  resolveMentions,
  unreadCount,
} from "@/services/helpdesk-notifications";
import {
  addChecklistItems,
  listChecklist,
  renderTemplate,
  saveTemplate,
  toggleChecklistItem,
} from "@/services/helpdesk-collab";
import {
  exportHelpdeskCsv,
  helpdeskBreakdowns,
  helpdeskSummary,
  parseRange,
} from "@/services/helpdesk-reports";
import {
  automationRuleSchema,
  slaPolicySchema,
  ticketCreateSchema,
} from "@/lib/validation-helpdesk";
import { DEFAULT_SCHEDULE } from "@/lib/helpdesk/business-hours";
import { makeUser } from "./helpers";

let admin: { id: string; name: string };
let tech: { id: string; name: string };
let companyId: string;
let contactId: string;
let policyId: string;
const actor = () => ({ id: admin.id, type: "user" as const });

async function newTicket(subject: string, priority: "low" | "normal" | "high" | "critical" = "high") {
  return createTicket(
    ticketCreateSchema.parse({
      subject,
      description: "Details",
      priority,
      requesterContactId: contactId,
      companyId,
    }),
    actor(),
  );
}

beforeAll(async () => {
  admin = await makeUser("admin", "Stage3 Admin");
  tech = await makeUser("technician", "Terry Stagethree");
  companyId = await createCompany(
    companySchema.parse({ name: "SLA Test Co", status: "customer", website: "slatest.co.uk" }),
    admin.id,
  );
  contactId = await createContact(
    contactSchema.parse({
      firstName: "Sam",
      lastName: "Requester",
      email: "sam@slatest.co.uk",
      companyId,
    }),
    admin.id,
  );
  const bh = await saveBusinessHours(
    null,
    { name: `Stage3 hours ${Date.now()}`, timezone: "Europe/London", schedule: DEFAULT_SCHEDULE, holidays: [], always: true },
    admin.id,
  );
  policyId = await saveSlaPolicy(
    null,
    {
      name: `Stage3 policy ${Date.now()}`,
      description: null,
      businessHoursId: bh,
      firstResponseMinutes: { low: 480, normal: 240, high: 60, critical: 30 },
      resolutionMinutes: { low: 4800, normal: 2400, high: 480, critical: 240 },
      pauseStatuses: ["awaiting_customer"],
      isDefault: false,
      active: true,
      companyIds: [companyId],
    },
    admin.id,
  );
});

describe("SLA clocks", () => {
  it("starts both clocks on creation, marks first response met on the first public reply, pauses and resumes resolution with status", async () => {
    const id = await newTicket("SLA lifecycle");
    let t = await getTicket(id);
    expect(t!.slaPolicyId).toBe(policyId);
    expect(t!.firstResponseDueAt).not.toBeNull();
    expect(t!.resolutionDueAt).not.toBeNull();
    const dueBefore = t!.resolutionDueAt!.getTime();
    // 24x7 policy: 60 minutes for a high first response.
    expect(t!.firstResponseDueAt!.getTime() - t!.createdAt.getTime()).toBeCloseTo(60 * 60000, -4);

    await addMessage(id, { kind: "public", body: "On it", channel: "manual", to: [], cc: [], bcc: [], status: null, replyToMessageId: null, version: undefined }, actor());
    let s = await ticketSlaSummary(id);
    expect(s!.first_response.finished).toBe("met");

    await changeStatus(id, "awaiting_customer", actor());
    s = await ticketSlaSummary(id);
    expect(s!.resolution.paused).toBe(true);
    t = await getTicket(id);
    expect(t!.resolutionDueAt).toBeNull();

    await changeStatus(id, "open", actor());
    s = await ticketSlaSummary(id);
    expect(s!.resolution.paused).toBe(false);
    t = await getTicket(id);
    expect(t!.resolutionDueAt!.getTime()).toBeGreaterThanOrEqual(dueBefore);
    const kinds = (await db.select().from(ticketSlaEvents).where(and(eq(ticketSlaEvents.ticketId, id), eq(ticketSlaEvents.target, "resolution")))).map((e) => e.kind);
    expect(kinds).toContain("pause");
    expect(kinds).toContain("resume");
  });

  it("recomputes when priority changes and records a breach when the deadline passes", async () => {
    const id = await newTicket("SLA priority", "low");
    const before = (await getTicket(id))!.firstResponseDueAt!.getTime();
    await updateTicketFields(id, { subject: "SLA priority", priority: "critical", type: "incident", categoryId: null, subcategoryId: null, tags: [], requesterContactId: contactId, requesterName: null, requesterEmail: null, companyId, assigneeUserId: null, teamId: null, customFields: {}, version: undefined }, actor());
    const after = (await getTicket(id))!.firstResponseDueAt!.getTime();
    expect(after).toBeLessThan(before);
    // Backdate creation so the deadline is in the past, then run the scheduled check.
    await db.update(tickets).set({ createdAt: new Date(Date.now() - 3 * 3600000) }).where(eq(tickets.id, id));
    await db.delete(ticketSlaEvents).where(eq(ticketSlaEvents.ticketId, id));
    await recomputeTicketSla(id, "test backdate");
    await toggleFollower(id, tech.id, true);
    const res = await checkSlaDeadlines();
    expect(res.breaches.some((b) => b.ticketId === id && b.target === "first_response")).toBe(true);
    const t = await getTicket(id);
    expect(t!.firstResponseBreached).toBe(true);
    const notes = await listNotifications(tech.id);
    expect(notes.some((n) => n.kind === "sla_breached" && n.ticketId === id)).toBe(true);
  });

  it("validates policy hours input", () => {
    const p = slaPolicySchema.parse({ name: "x", fr_high: "1.5", res_high: "", pauseStatuses: [], companyIds: [] });
    expect(p.fr_high).toBe(90);
    expect(p.res_high).toBeNull();
  });
});

describe("automation rules", () => {
  it("evaluates conditions", () => {
    const snap = { priority: "high", tags: ["vpn", "urgent"], subject: "VPN outage", hoursSinceActivity: 30, assigneeUserId: null };
    expect(evaluateCondition({ field: "priority", op: "eq", value: "high" }, snap)).toBe(true);
    expect(evaluateCondition({ field: "tags", op: "contains", value: "VPN" }, snap)).toBe(true);
    expect(evaluateCondition({ field: "subject", op: "contains", value: "outage" }, snap)).toBe(true);
    expect(evaluateCondition({ field: "assigneeUserId", op: "empty" }, snap)).toBe(true);
    expect(evaluateCondition({ field: "hoursSinceActivity", op: "gt", value: 24 }, snap)).toBe(true);
    expect(evaluateCondition({ field: "priority", op: "in", value: ["low", "normal"] }, snap)).toBe(false);
  });

  it("runs ordered rules on creation with stop-processing, cooldown and a run log; a status rule cannot loop", async () => {
    const stamp = Date.now();
    await saveRule(null, { name: `S3 tag ${stamp}`, description: null, trigger: "ticket_created", match: "all", conditions: [{ field: "subject", op: "contains", value: `rulecase-${stamp}` }], actions: [{ type: "add_tag", value: "auto" }, { type: "set_priority", value: "critical" }, { type: "assign_user", value: tech.id }], sortOrder: 1, stopProcessing: true, cooldownMinutes: 60, afterMinutes: null, active: true }, admin.id);
    await saveRule(null, { name: `S3 never ${stamp}`, description: null, trigger: "ticket_created", match: "all", conditions: [{ field: "subject", op: "contains", value: `rulecase-${stamp}` }], actions: [{ type: "add_tag", value: "should-not-apply" }], sortOrder: 2, stopProcessing: false, cooldownMinutes: 60, afterMinutes: null, active: true }, admin.id);
    // Ping-pong pair: open→in_progress and in_progress→open. Depth guard must end it.
    await saveRule(null, { name: `S3 pp1 ${stamp}`, description: null, trigger: "status_changed", match: "all", conditions: [{ field: "subject", op: "contains", value: `rulecase-${stamp}` }, { field: "status", op: "eq", value: "open" }], actions: [{ type: "set_status", value: "in_progress" }], sortOrder: 3, stopProcessing: false, cooldownMinutes: 0, afterMinutes: null, active: true }, admin.id);
    await saveRule(null, { name: `S3 pp2 ${stamp}`, description: null, trigger: "status_changed", match: "all", conditions: [{ field: "subject", op: "contains", value: `rulecase-${stamp}` }, { field: "status", op: "eq", value: "in_progress" }], actions: [{ type: "set_status", value: "open" }], sortOrder: 4, stopProcessing: false, cooldownMinutes: 0, afterMinutes: null, active: true }, admin.id);

    const id = await newTicket(`rulecase-${stamp} printer`, "low");
    const t = await getTicket(id);
    expect(t!.tags).toContain("auto");
    expect(t!.tags).not.toContain("should-not-apply");
    expect(t!.priority).toBe("critical");
    expect(t!.assigneeUserId).toBe(tech.id);
    // Priority change by a rule recomputed the deadline for critical (30 min on this policy).
    expect(t!.firstResponseDueAt!.getTime() - t!.createdAt.getTime()).toBeCloseTo(30 * 60000, -4);
    const runs = await db.select().from(helpdeskAutomationRuns).where(eq(helpdeskAutomationRuns.ticketId, id));
    expect(runs.filter((r) => r.trigger === "ticket_created")).toHaveLength(1);
    const events = await db.select().from(ticketEvents).where(and(eq(ticketEvents.ticketId, id), eq(ticketEvents.kind, "automation")));
    expect(events.length).toBeGreaterThanOrEqual(1);
    // Cooldown: running the same trigger again never re-applies the first rule.
    await runAutomation("ticket_created", id);
    const runsAfter = await db.select().from(helpdeskAutomationRuns).where(eq(helpdeskAutomationRuns.ticketId, id));
    expect(runsAfter.filter((r) => r.trigger === "ticket_created" && r.actionsApplied.some((a) => a.type === "set_priority"))).toHaveLength(1);
    // Assignment notified the technician.
    expect((await listNotifications(tech.id)).some((n) => n.kind === "assigned" && n.ticketId === id)).toBe(true);

    // Status ping-pong is bounded.
    await changeStatus(id, "open", actor());
    const statusRuns = await db.select().from(helpdeskAutomationRuns).where(and(eq(helpdeskAutomationRuns.ticketId, id), eq(helpdeskAutomationRuns.trigger, "status_changed")));
    expect(statusRuns.length).toBeGreaterThan(0);
    expect(statusRuns.length).toBeLessThanOrEqual(5);
    const final = await getTicket(id);
    expect(["open", "in_progress"]).toContain(final!.status);
  });

  it("closes resolved tickets on the schedule trigger after the idle period", async () => {
    const stamp = Date.now();
    await saveRule(null, { name: `S3 autoclose ${stamp}`, description: null, trigger: "schedule", match: "all", conditions: [{ field: "status", op: "eq", value: "resolved" }, { field: "subject", op: "contains", value: `autoclose-${stamp}` }], actions: [{ type: "close" }], sortOrder: 50, stopProcessing: false, cooldownMinutes: 1440, afterMinutes: 60, active: true }, admin.id);
    const id = await newTicket(`autoclose-${stamp}`);
    await changeStatus(id, "resolved", actor(), { resolutionSummary: "Done" });
    let r = await runScheduledRules();
    expect((await getTicket(id))!.status).toBe("resolved"); // not idle long enough
    await db.update(tickets).set({ lastActivityAt: new Date(Date.now() - 2 * 3600000) }).where(eq(tickets.id, id));
    r = await runScheduledRules();
    expect(r.applied).toBeGreaterThanOrEqual(1);
    expect((await getTicket(id))!.status).toBe("closed");
  });

  it("parses rule JSON from the form", () => {
    const r = automationRuleSchema.parse({ name: "x", trigger: "ticket_created", conditions: JSON.stringify([{ field: "priority", op: "eq", value: "high" }]), actions: JSON.stringify([{ type: "add_tag", value: "t" }]), afterMinutes: "" });
    expect(r.conditions[0].field).toBe("priority");
    expect(r.afterMinutes).toBeNull();
    expect(() => automationRuleSchema.parse({ name: "x", trigger: "ticket_created", conditions: "nope", actions: "[]" })).toThrow();
  });
});

describe("collaboration", () => {
  it("resolves @mentions and notifies mentioned users and followers, never the author", async () => {
    const id = await newTicket("Mentions");
    const other = await makeUser("account_manager", "Olive Watcher");
    await toggleFollower(id, other.id, true);
    const found = await resolveMentions("Can @Terry take a look? cc @olive.watcher");
    expect(found.map((f) => f.id).sort()).toEqual([tech.id, other.id].sort());
    const before = await unreadCount(tech.id);
    await addMessage(id, { kind: "internal", body: "@Terry please check the switch", channel: "note", to: [], cc: [], bcc: [], status: null, replyToMessageId: null, version: undefined }, { ...actor(), name: admin.name });
    expect(await unreadCount(tech.id)).toBe(before + 1);
    const mine = await listNotifications(tech.id);
    expect(mine[0].kind).toBe("mention");
    const theirs = await listNotifications(other.id);
    expect(theirs.some((n) => n.kind === "followed_update" && n.ticketId === id)).toBe(true);
    // The author gets nothing for their own note.
    expect((await listNotifications(admin.id)).some((n) => n.ticketId === id)).toBe(false);
    await markNotificationsRead(tech.id, "all");
    expect(await unreadCount(tech.id)).toBe(0);
    // Assignment via assignTicket notifies too.
    await assignTicket(id, { assigneeUserId: other.id }, actor());
    expect((await listNotifications(other.id)).some((n) => n.kind === "assigned")).toBe(true);
  });

  it("renders templates with ticket placeholders and manages a checklist", async () => {
    const id = await newTicket("Template ticket");
    const tid = await saveTemplate(null, { name: `S3 tpl ${Date.now()}`, scope: "public", subject: null, body: "Hi {{requester.first_name}}, re {{ticket.reference}} at {{company.name}} — {{agent.name}} {{unknown.thing}}", category: null, active: true }, admin.id);
    expect(tid).toBeTruthy();
    const t = await getTicket(id);
    const text = await renderTemplate("Hi {{requester.first_name}}, re {{ticket.reference}} at {{company.name}} — {{agent.name}} {{unknown.thing}}", id, admin.id);
    expect(text).toBe(`Hi Sam, re ${t!.reference} at SLA Test Co — Stage3 Admin {{unknown.thing}}`);

    const ids = await addChecklistItems(id, ["Back up mailbox", "Remove licence", ""], actor(), { assigneeUserId: tech.id });
    expect(ids).toHaveLength(2);
    await toggleChecklistItem(id, ids[0], true, actor());
    const list = await listChecklist(id);
    expect(list.filter((i) => i.done)).toHaveLength(1);
    expect(list[0].assigneeName).toBe("Terry Stagethree");
    const notes = await db.select().from(helpdeskNotifications).where(and(eq(helpdeskNotifications.userId, tech.id), eq(helpdeskNotifications.kind, "checklist")));
    expect(notes.length).toBeGreaterThanOrEqual(1);
  });
});

describe("reports", () => {
  it("summarises the period, breaks down by dimension and exports CSV", async () => {
    const id = await newTicket("Report ticket");
    await addMessage(id, { kind: "public", body: "Reply", channel: "manual", to: [], cc: [], bcc: [], status: null, replyToMessageId: null, version: undefined }, actor());
    await changeStatus(id, "resolved", actor(), { resolutionSummary: "Fixed" });
    const range = parseRange(null, null);
    expect(range.to.getTime() - range.from.getTime()).toBe(30 * 86400000);
    const f = { ...range, companyId };
    const s = await helpdeskSummary(f);
    expect(s.created).toBeGreaterThanOrEqual(1);
    expect(s.resolved).toBeGreaterThanOrEqual(1);
    expect(s.firstResponseAttainment).not.toBeNull();
    const b = await helpdeskBreakdowns(f);
    expect(b.byCompany.find((r) => r.key === "SLA Test Co")?.created).toBeGreaterThanOrEqual(1);
    const csv = await exportHelpdeskCsv("sla", f);
    const lines = csv.split(/\r?\n/);
    expect(lines[0]).toContain("firstResponseMet");
    expect(lines.some((l) => l.includes("Report ticket") && l.includes("yes"))).toBe(true);
    const tcsv = await exportHelpdeskCsv("tickets", f);
    expect(tcsv).not.toContain("Reply"); // message bodies are never exported
    const explicit = parseRange("2026-01-01", "2026-01-31");
    expect(explicit.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(explicit.to.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });
});
