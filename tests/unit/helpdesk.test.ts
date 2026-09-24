import { describe, expect, it, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  activities,
  ticketEvents,
  ticketMessages,
  ticketParticipants,
  tickets,
} from "@/db/schema";
import { createCompany } from "@/services/companies";
import { createContact } from "@/services/contacts";
import { companySchema, contactSchema } from "@/lib/validation";
import {
  addMessage,
  addTimeEntry,
  assignTicket,
  bulkUpdate,
  canTransition,
  changeStatus,
  createTicket,
  findTicketByReference,
  getDraft,
  getTicket,
  linkTickets,
  listTickets,
  mergePreview,
  mergeTickets,
  saveDraft,
  saveTeam,
  splitTicket,
  ticketCounts,
  updateTicketFields,
} from "@/services/helpdesk";
import {
  findTicketReferences,
  ticketCreateSchema,
  ticketReference,
} from "@/lib/validation-helpdesk";
import { markdownToHtml, markdownToPlainText } from "@/lib/markdown-parse";
import { globalSearch } from "@/services/search";
import { can } from "@/lib/permissions";
import { ActionError } from "@/lib/action-result";
import { makeUser } from "./helpers";

let admin: { id: string };
let tech: { id: string };
let companyId: string;
let contactId: string;

beforeAll(async () => {
  admin = await makeUser("admin", "helpdesk admin");
  tech = await makeUser("technician", "helpdesk tech");
  companyId = await createCompany(
    companySchema.parse({
      name: "Ticket Test Co",
      status: "customer",
      website: "tickettest.co.uk",
    }),
    admin.id,
  );
  contactId = await createContact(
    contactSchema.parse({
      companyId,
      firstName: "Ann",
      lastName: "Requester",
      email: "ann@tickettest.co.uk",
    }),
    admin.id,
  );
});

describe("helpdesk helpers", () => {
  it("formats and finds ticket references, converts Markdown to text and safe HTML, and maps roles", () => {
    expect(ticketReference(123)).toBe("IT-000123");
    expect(
      findTicketReferences("Re: [IT-000123] VPN down (see it-000045)"),
    ).toEqual([123, 45]);
    expect(findTicketReferences("no refs here")).toEqual([]);
    expect(markdownToPlainText("## Title\n\nHello **there**\n\n- a\n- b")).toBe(
      "TITLE\n\nHello there\n\n- a\n- b",
    );
    expect(
      markdownToHtml(
        "Hi **Sam** <script>x</script> [portal](https://p.example) [bad](javascript:alert(1))",
      ),
    ).toBe(
      '<p>Hi <strong>Sam</strong> &lt;script&gt;x&lt;/script&gt; <a href="https://p.example">portal</a> [bad](javascript:alert(1))</p>',
    );
    expect(can("technician", "helpdesk.agent")).toBe(true);
    expect(can("technician", "helpdesk.manage")).toBe(false);
    expect(can("account_manager", "helpdesk.manage")).toBe(true);
    expect(can("account_manager", "helpdesk.admin")).toBe(false);
    expect(can("read_only", "helpdesk.read")).toBe(true);
    expect(can("read_only", "helpdesk.agent")).toBe(false);
    expect(canTransition("new", "resolved")).toBe(true);
    expect(canTransition("closed", "in_progress")).toBe(false);
    expect(canTransition("resolved", "closed")).toBe(true);
  });
  it("validates ticket creation input", () => {
    expect(() => ticketCreateSchema.parse({ subject: "x" })).toThrow();
    const v = ticketCreateSchema.parse({
      subject: "x",
      requesterEmail: "Bob@Example.com",
      tags: "VPN, laptop,vpn",
    });
    expect(v.requesterEmail).toBe("bob@example.com");
    expect(v.tags).toEqual(["vpn", "laptop"]);
  });
});

describe("tickets", () => {
  let id: string;
  it("creates a ticket from a known contact, links the company, records the initial message, event and timeline entry", async () => {
    id = await createTicket(
      ticketCreateSchema.parse({
        subject: "Laptop will not boot",
        description: "Black screen after the update.",
        priority: "high",
        requesterContactId: contactId,
        tags: "laptop",
      }),
      { id: admin.id, type: "user" },
    );
    const t = (await getTicket(id))!;
    expect(t.reference).toMatch(/^IT-\d{6}$/);
    expect(t).toMatchObject({
      status: "new",
      priority: "high",
      companyId,
      requesterContactId: contactId,
      requesterEmail: "ann@tickettest.co.uk",
      requesterName: "Ann Requester",
      requesterUnverified: false,
      version: 1,
    });
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]).toMatchObject({
      kind: "public",
      channel: "manual",
      bodyText: "Black screen after the update.",
    });
    expect(t.participants.find((p) => p.role === "requester")?.email).toBe(
      "ann@tickettest.co.uk",
    );
    expect(t.events.map((e) => e.kind)).toContain("created");
    const tl = await db
      .select({ title: activities.title, type: activities.type })
      .from(activities)
      .where(
        and(eq(activities.companyId, companyId), eq(activities.type, "ticket")),
      );
    expect(tl.some((a) => a.title.includes(t.reference))).toBe(true);
    expect((await findTicketByReference(t.reference))?.id).toBe(id);
    expect(
      (await globalSearch(t.reference)).some(
        (h) => h.type === "ticket" && h.id === id,
      ),
    ).toBe(true);
  });

  it("matches an unknown e-mail to an existing contact, and never infers a company from the domain alone", async () => {
    const matched = await createTicket(
      ticketCreateSchema.parse({
        subject: "By email",
        requesterEmail: "ANN@tickettest.co.uk",
      }),
      { id: admin.id, type: "user" },
    );
    expect((await getTicket(matched))!).toMatchObject({
      requesterContactId: contactId,
      companyId,
      requesterUnverified: false,
    });
    const unknown = await createTicket(
      ticketCreateSchema.parse({
        subject: "Stranger",
        requesterEmail: "someone@tickettest.co.uk",
        requesterName: "Some One",
      }),
      { id: admin.id, type: "user" },
    );
    expect((await getTicket(unknown))!).toMatchObject({
      requesterContactId: null,
      companyId: null,
      requesterUnverified: true,
    });
  });

  it("enforces status transitions, requires a resolution summary, stamps timestamps and counts reopens", async () => {
    await expect(changeStatus(id, "closed", { id: admin.id })).rejects.toThrow(
      /cannot move straight/,
    );
    await expect(
      changeStatus(id, "resolved", { id: admin.id }),
    ).rejects.toBeInstanceOf(ActionError);
    const r = await changeStatus(
      id,
      "resolved",
      { id: admin.id },
      {
        resolutionSummary: "Reinstalled the display driver.",
        resolutionCategory: "fixed",
      },
    );
    expect(r.changed).toBe(true);
    let t = (await getTicket(id))!;
    expect(t.resolvedAt).not.toBeNull();
    expect(t.resolutionSummary).toBe("Reinstalled the display driver.");
    await changeStatus(
      id,
      "open",
      { id: admin.id },
      { reason: "customer replied" },
    );
    t = (await getTicket(id))!;
    expect(t).toMatchObject({
      status: "open",
      resolvedAt: null,
      reopenCount: 1,
    });
    expect(t.events.some((e) => e.kind === "reopen")).toBe(true);
    // Stale version is refused.
    await expect(
      changeStatus(id, "in_progress", { id: admin.id }, { version: 1 }),
    ).rejects.toThrow(/Someone else changed/);
    await changeStatus(
      id,
      "in_progress",
      { id: admin.id },
      { version: t.version },
    );
  });

  it("updates fields with an audited diff and optimistic concurrency, assigns, and logs notes vs public messages", async () => {
    let t = (await getTicket(id))!;
    const r = await updateTicketFields(
      id,
      {
        subject: "Laptop will not boot after update",
        priority: "critical",
        type: "incident",
        categoryId: null,
        subcategoryId: null,
        tags: ["laptop", "urgent"],
        requesterContactId: contactId,
        requesterName: null,
        requesterEmail: null,
        companyId,
        assigneeUserId: tech.id,
        teamId: null,
        customFields: {},
        version: t.version,
      },
      { id: admin.id },
    );
    expect(r.changed).toBe(true);
    t = (await getTicket(id))!;
    expect(t).toMatchObject({
      subject: "Laptop will not boot after update",
      priority: "critical",
      assigneeUserId: tech.id,
      tags: ["laptop", "urgent"],
    });
    expect(
      t.events.filter((e) => e.kind === "assignee").length,
    ).toBeGreaterThanOrEqual(1);
    await expect(
      updateTicketFields(
        id,
        {
          subject: "x",
          priority: "low",
          type: "incident",
          categoryId: null,
          subcategoryId: null,
          tags: [],
          requesterContactId: contactId,
          requesterName: null,
          requesterEmail: null,
          companyId,
          assigneeUserId: null,
          teamId: null,
          customFields: {},
          version: 1,
        },
        { id: admin.id },
      ),
    ).rejects.toThrow(/Someone else/);

    const noteId = await addMessage(
      id,
      {
        kind: "internal",
        body: "Checked the **BIOS**, looks fine.",
        channel: "note",
        to: [],
        cc: [],
        bcc: [],
        status: null,
        replyToMessageId: null,
      },
      { id: tech.id, name: "helpdesk tech" },
    );
    const before = (await getTicket(id))!;
    expect(before.firstResponseAt).toBeNull(); // internal notes are not a first response
    await addMessage(
      id,
      {
        kind: "public",
        body: "Called Ann; driver reinstalled, please reboot.",
        channel: "manual",
        to: [],
        cc: [],
        bcc: [],
        status: "awaiting_customer",
        replyToMessageId: null,
      },
      { id: tech.id, name: "helpdesk tech" },
    );
    t = (await getTicket(id))!;
    expect(t.firstResponseAt).not.toBeNull();
    expect(t.status).toBe("awaiting_customer");
    const note = t.messages.find((m) => m.id === noteId)!;
    expect(note.kind).toBe("internal");
    expect(note.bodyHtml).toBeNull();
    expect(
      t.messages.find(
        (m) => m.channel === "manual" && m.direction === "outbound",
      )?.bodyHtml,
    ).toContain("<p>");
    await saveDraft(id, tech.id, {
      kind: "internal",
      body: "wip",
      ticketVersion: t.version,
    });
    expect((await getDraft(id, tech.id))?.body).toBe("wip");
    await saveDraft(id, tech.id, {
      kind: "internal",
      body: "  ",
      ticketVersion: t.version,
    });
    expect(await getDraft(id, tech.id)).toBeNull();
    await addTimeEntry(
      id,
      tech.id,
      { minutes: 25, note: "phone", billable: true },
      { id: tech.id },
    );
    expect((await getTicket(id))!.timeSpentMinutes).toBe(25);
  });

  it("lists by view with filters, search by reference and text, sorting and counts", async () => {
    const [team] = [
      await saveTeam(
        null,
        {
          name: "Desk",
          description: null,
          memberIds: [tech.id],
          leadUserId: tech.id,
          active: true,
        },
        admin.id,
      ),
    ];
    await assignTicket(id, { teamId: team }, { id: admin.id });
    const mine = await listTickets({
      view: "my",
      me: { id: tech.id, teamIds: [team] },
    });
    expect(mine.rows.some((r) => r.id === id)).toBe(true);
    expect(
      (await listTickets({ view: "awaiting_customer" })).rows.map((r) => r.id),
    ).toContain(id);
    expect(
      (await listTickets({ view: "open", priority: "critical" })).rows.map(
        (r) => r.id,
      ),
    ).toContain(id);
    expect(
      (await listTickets({ view: "open", q: "BIOS" })).rows.map((r) => r.id),
    ).toContain(id);
    expect(
      (
        await listTickets({
          view: "all",
          q: ticketReference((await getTicket(id))!.number),
        })
      ).total,
    ).toBe(1);
    const sorted = await listTickets({
      view: "all",
      sort: "priority",
      dir: "asc",
    });
    expect(sorted.rows[0].priority).toBe("critical");
    const counts = await ticketCounts(tech.id);
    expect(counts.mine).toBeGreaterThanOrEqual(1);
    expect(counts.open).toBeGreaterThanOrEqual(3);
  });

  it("bulk actions apply per ticket and report failures instead of stopping", async () => {
    const other = await createTicket(
      ticketCreateSchema.parse({
        subject: "Bulk me",
        requesterContactId: contactId,
      }),
      { id: admin.id },
    );
    const r = await bulkUpdate([id, other], "priority", "low", {
      id: admin.id,
    });
    expect(r.done).toBe(2);
    const r2 = await bulkUpdate([id, other], "status", "closed", {
      id: admin.id,
    }); // neither is resolved → both refused
    expect(r2.done).toBe(0);
    expect(r2.errors).toHaveLength(2);
    const r3 = await bulkUpdate([other], "assign", tech.id, { id: admin.id });
    expect(r3.done).toBe(1);
    expect((await getTicket(other))!.assigneeUserId).toBe(tech.id);
  });

  it("merges with a preview, keeps the old reference reachable, and splits messages into a new ticket", async () => {
    const dup = await createTicket(
      ticketCreateSchema.parse({
        subject: "Laptop still broken",
        description: "Same laptop, still black.",
        requesterEmail: "other@tickettest.co.uk",
        requesterName: "Other Person",
      }),
      { id: admin.id },
    );
    await addTimeEntry(
      dup,
      tech.id,
      { minutes: 10, note: null, billable: true },
      { id: tech.id },
    );
    const preview = await mergePreview([dup], id);
    expect(preview.sources[0]).toMatchObject({
      messages: 1,
      differentRequester: true,
      newParticipants: ["other@tickettest.co.uk"],
      timeMinutes: 10,
    });
    await mergeTickets([dup], id, { id: admin.id });
    const merged = (await getTicket(dup))!;
    expect(merged.status).toBe("closed");
    expect(merged.mergedInto?.id).toBe(id);
    const target = (await getTicket(id))!;
    expect(
      target.messages.some((m) => m.bodyText === "Same laptop, still black."),
    ).toBe(true);
    expect(
      target.participants.some(
        (p) => p.email === "other@tickettest.co.uk" && p.role === "cc",
      ),
    ).toBe(true);
    expect(target.timeSpentMinutes).toBe(35);
    expect(
      target.links.some((l) => l.kind === "merged_from" && l.ticketId === dup),
    ).toBe(true);
    // A reply to the merged ticket's reference resolves to the survivor.
    expect((await findTicketByReference(merged.reference))?.id).toBe(id);
    expect(
      (await listTickets({ view: "all" })).rows.some((r) => r.id === dup),
    ).toBe(false);
    await expect(
      addMessage(
        dup,
        {
          kind: "internal",
          body: "x",
          channel: "note",
          to: [],
          cc: [],
          bcc: [],
          status: null,
          replyToMessageId: null,
        },
        { id: admin.id },
      ),
    ).rejects.toThrow(/merged/);

    const moved = target.messages
      .filter((m) => m.bodyText === "Same laptop, still black.")
      .map((m) => m.id);
    const newId = await splitTicket(id, moved, "Second laptop issue", {
      id: admin.id,
    });
    const split = (await getTicket(newId))!;
    expect(split.messages).toHaveLength(1);
    expect(split).toMatchObject({
      requesterContactId: contactId,
      companyId,
      status: "open",
    });
    expect(
      split.links.some((l) => l.kind === "split_from" && l.ticketId === id),
    ).toBe(true);
    expect(
      (await getTicket(id))!.messages.some((m) => moved.includes(m.id)),
    ).toBe(false);
    await expect(
      splitTicket(
        newId,
        split.messages.map((m) => m.id),
        "all of them",
        { id: admin.id },
      ),
    ).rejects.toThrow(/must stay/);
    await linkTickets(newId, (await getTicket(id))!.reference, "parent", {
      id: admin.id,
    });
    expect((await getTicket(newId))!.parent?.id).toBe(id);
    expect((await getTicket(id))!.children.map((c) => c.id)).toContain(newId);
  });

  it("keeps internal notes out of the customer-facing message set", async () => {
    const t = (await getTicket(id))!;
    const publicMessages = t.messages.filter((m) => m.kind === "public");
    const internal = t.messages.filter((m) => m.kind === "internal");
    expect(internal.length).toBeGreaterThan(0);
    expect(publicMessages.every((m) => !m.bodyText.includes("BIOS"))).toBe(
      true,
    );
    const rows = await db
      .select()
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.ticketId, id),
          eq(ticketMessages.kind, "internal"),
        ),
      );
    expect(
      rows.every(
        (r) =>
          r.direction === "internal" &&
          r.deliveryStatus === "not_applicable" &&
          r.toRecipients.length === 0,
      ),
    ).toBe(true);
    void ticketEvents;
    void ticketParticipants;
    void tickets;
  });
});
