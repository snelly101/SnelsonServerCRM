import { describe, expect, it, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { tickets, ticketEvents } from "@/db/schema";
import { helpdeskNotifications } from "@/db/schema/helpdesk-sla";
import { mailboxOutbox } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { createContact } from "@/services/contacts";
import { companySchema, contactSchema } from "@/lib/validation";
import {
  changeStatus,
  createTicket,
  getTicket,
  listTickets,
  snoozeTicket,
  ticketCounts,
  unsnoozeTicket,
  wakeSnoozedTickets,
} from "@/services/helpdesk";
import { afterTicketChange } from "@/services/helpdesk-hooks";
import { runScheduledRules, saveRule } from "@/services/helpdesk-automation";
import { reminderCount, sendCustomerReminder } from "@/services/mailbox";
import { ticketCreateSchema } from "@/lib/validation-helpdesk";
import { makeUser } from "./helpers";

let admin: { id: string; name: string };
let companyId: string;
let contactId: string;
const actor = () => ({ id: admin.id, type: "user" as const });
const stamp = Date.now();

async function newTicket(subject: string) {
  return createTicket(
    ticketCreateSchema.parse({ subject, description: "Details", priority: "normal", requesterContactId: contactId, companyId }),
    actor(),
  );
}
const inHours = (h: number) => new Date(Date.now() + h * 3600000);

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "Snooze Admin");
  companyId = await createCompany(companySchema.parse({ name: `Snooze Co ${stamp}`, status: "customer", website: `snooze-${stamp}.co.uk` }), admin.id);
  contactId = await createContact(contactSchema.parse({ firstName: "Nell", lastName: "Waiting", email: `nell-${stamp}@snooze.co.uk`, companyId }), admin.id);
});

describe("ticket snooze", () => {
  it("hides a snoozed ticket from the working queues and shows it in the snoozed view until it wakes", async () => {
    const id = await newTicket(`snooze-list-${stamp}`);
    const r = await snoozeTicket(id, { until: inHours(24), reason: "parts due" }, actor());
    expect(r.version).toBeGreaterThan(1);
    const ids = async (view: "open" | "snoozed" | "all" | "unassigned") => (await listTickets({ view, q: `snooze-list-${stamp}` })).rows.map((x) => x.id);
    expect(await ids("open")).not.toContain(id);
    expect(await ids("unassigned")).not.toContain(id);
    expect(await ids("snoozed")).toContain(id);
    expect(await ids("all")).toContain(id);
    const counts = await ticketCounts(admin.id);
    expect(counts.snoozed).toBeGreaterThanOrEqual(1);
    // Waking by hand puts it straight back.
    await unsnoozeTicket(id, actor());
    expect(await ids("open")).toContain(id);
    expect((await getTicket(id))!.snoozedUntil).toBeNull();
    const kinds = (await db.select({ kind: ticketEvents.kind }).from(ticketEvents).where(eq(ticketEvents.ticketId, id))).map((e) => e.kind);
    expect(kinds).toContain("snooze");
    expect(kinds).toContain("unsnooze");
  });

  it("rejects a past time, too long a snooze and non-open tickets", async () => {
    const id = await newTicket(`snooze-validate-${stamp}`);
    await expect(snoozeTicket(id, { until: new Date(Date.now() - 60000) }, actor())).rejects.toThrow(/future/);
    await expect(snoozeTicket(id, { until: inHours(24 * 120) }, actor())).rejects.toThrow(/at most/i);
    await changeStatus(id, "resolved", actor(), { resolutionSummary: "Done" });
    await expect(snoozeTicket(id, { until: inHours(2) }, actor())).rejects.toThrow(/open tickets/);
  });

  it("the worker wakes tickets whose time has passed and tells whoever snoozed them", async () => {
    const id = await newTicket(`snooze-wake-${stamp}`);
    await snoozeTicket(id, { until: inHours(2), reason: "waiting on courier" }, actor());
    // Pretend time has passed.
    await db.update(tickets).set({ snoozedUntil: new Date(Date.now() - 1000) }).where(eq(tickets.id, id));
    const r = await wakeSnoozedTickets();
    expect(r.woken).toBeGreaterThanOrEqual(1);
    const t = (await getTicket(id))!;
    expect(t.snoozedUntil).toBeNull();
    expect(t.snoozeReason).toBeNull();
    const [n] = await db
      .select({ title: helpdeskNotifications.title })
      .from(helpdeskNotifications)
      .where(and(eq(helpdeskNotifications.userId, admin.id), eq(helpdeskNotifications.ticketId, id), eq(helpdeskNotifications.kind, "snoozed")));
    expect(n?.title).toMatch(/is back: waiting on courier/);
  });

  it("a customer reply wakes a snoozed ticket early; resolving clears the snooze", async () => {
    const id = await newTicket(`snooze-reply-${stamp}`);
    await snoozeTicket(id, { until: inHours(48) }, actor());
    await afterTicketChange(id, "customer_replied", { id: null, type: "email" }, "test reply");
    expect((await getTicket(id))!.snoozedUntil).toBeNull();
    const [ev] = await db
      .select({ summary: ticketEvents.summary })
      .from(ticketEvents)
      .where(and(eq(ticketEvents.ticketId, id), eq(ticketEvents.kind, "unsnooze")));
    expect(ev.summary).toMatch(/customer replied/);

    const id2 = await newTicket(`snooze-resolve-${stamp}`);
    await snoozeTicket(id2, { until: inHours(48) }, actor());
    await changeStatus(id2, "resolved", actor(), { resolutionSummary: "Fixed" });
    expect((await getTicket(id2))!.snoozedUntil).toBeNull();
  });
});

describe("awaiting-customer reminders", () => {
  it("sends one reminder to the requester while awaiting the customer, never twice within 20 hours, and only in that status", async () => {
    const id = await newTicket(`nudge-${stamp}`);
    expect(await sendCustomerReminder(id)).toBe(false); // not awaiting the customer yet
    await changeStatus(id, "awaiting_customer", actor());
    expect(await sendCustomerReminder(id, { ruleName: "test" })).toBe(true);
    expect(await reminderCount(id)).toBe(1);
    expect(await sendCustomerReminder(id)).toBe(false); // floor of one per 20 hours
    const rows = await db.select({ kind: mailboxOutbox.kind, to: mailboxOutbox.toSummary }).from(mailboxOutbox).where(eq(mailboxOutbox.ticketId, id));
    expect(rows.some((r) => r.kind === "nudge" && r.to === `nell-${stamp}@snooze.co.uk`)).toBe(true);
    const t = (await getTicket(id))!;
    const nudge = t.messages.find((m) => m.isAutomated && m.automatedReason === "nudge");
    expect(nudge?.bodyText).toMatch(/still waiting to hear back/);
    // A snoozed ticket is left alone.
    const id2 = await newTicket(`nudge-snoozed-${stamp}`);
    await changeStatus(id2, "awaiting_customer", actor());
    await snoozeTicket(id2, { until: inHours(24) }, actor());
    expect(await sendCustomerReminder(id2)).toBe(false);
  });

  it("the recommended scheduled rule reminds after two business days since our last message and caps at two", async () => {
    const id = await newTicket(`nudge-rule-${stamp}`);
    await changeStatus(id, "awaiting_customer", actor());
    await saveRule(
      null,
      {
        name: `Nudge rule ${stamp}`,
        description: null,
        trigger: "schedule",
        match: "all",
        conditions: [
          { field: "status", op: "eq", value: "awaiting_customer" },
          { field: "subject", op: "contains", value: `nudge-rule-${stamp}` },
          { field: "businessHoursSinceAgentMessage", op: "gt", value: 16 },
          { field: "reminderCount", op: "lt", value: 2 },
        ],
        actions: [{ type: "nudge_customer", value: null }],
        sortOrder: 100,
        stopProcessing: false,
        cooldownMinutes: 0,
        afterMinutes: 0,
        active: true,
      },
      admin.id,
    );
    // Our last message was an hour ago: nothing yet.
    await db.update(tickets).set({ lastAgentMessageAt: new Date(Date.now() - 3600000) }).where(eq(tickets.id, id));
    await runScheduledRules();
    expect(await reminderCount(id)).toBe(0);
    // Three days ago: one reminder.
    await db.update(tickets).set({ lastAgentMessageAt: new Date(Date.now() - 72 * 3600000) }).where(eq(tickets.id, id));
    await runScheduledRules();
    expect(await reminderCount(id)).toBe(1);
    // The send itself moves "last agent message" forward only when accepted; force the clock on and age the first reminder past the floor.
    await db.update(tickets).set({ lastAgentMessageAt: new Date(Date.now() - 72 * 3600000) }).where(eq(tickets.id, id));
    await db.execute(`update ticket_messages set at = now() - interval '2 days' where ticket_id = '${id}' and automated_reason = 'nudge'`);
    await runScheduledRules();
    expect(await reminderCount(id)).toBe(2);
    // Capped at two.
    await db.execute(`update ticket_messages set at = now() - interval '2 days' where ticket_id = '${id}' and automated_reason = 'nudge'`);
    await runScheduledRules();
    expect(await reminderCount(id)).toBe(2);
  });
});
