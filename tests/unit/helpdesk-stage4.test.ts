import { describe, expect, it, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { ninjaDevices, ticketAttachments, ticketEvents, ticketMessages, ticketParticipants, tickets } from "@/db/schema";
import { kbArticleRevisions, ticketKbLinks } from "@/db/schema/helpdesk-kb";
import { helpdeskNotifications } from "@/db/schema/helpdesk-sla";
import { createCompany } from "@/services/companies";
import { createContact } from "@/services/contacts";
import { companySchema, contactSchema } from "@/lib/validation";
import { addMessage, changeStatus, createTicket, getTicket } from "@/services/helpdesk";
import {
  articleBodyForInsert,
  getArticle,
  insertableArticles,
  linkArticleToTicket,
  listArticles,
  restoreRevision,
  saveArticle,
  setArticleStatus,
  slugify,
  suggestArticles,
  ticketArticles,
} from "@/services/helpdesk-kb";
import { deviceOptionsForTicket, deviceTickets, linkDevice, ticketDevices, unlinkDevice } from "@/services/helpdesk-assets";
import { anonymiseByEmail, anonymiseTicket, runHelpdeskRetention } from "@/services/helpdesk-retention";
import { helpdeskHealth } from "@/services/helpdesk-monitoring";
import { globalSearch } from "@/services/search";
import { ticketCreateSchema } from "@/lib/validation-helpdesk";
import { ActionError } from "@/lib/action-result";
import { can } from "@/lib/permissions";
import { makeUser } from "./helpers";

let admin: { id: string; name: string };
let companyId: string;
let otherCompanyId: string;
let contactId: string;
const actor = () => ({ id: admin.id, type: "user" as const });
const stamp = Date.now();

async function newTicket(subject: string, email?: string) {
  // With a contact the requester e-mail comes from the contact; an explicit e-mail creates an unlinked requester.
  return createTicket(
    ticketCreateSchema.parse(
      email
        ? { subject, description: "Details", priority: "normal", requesterName: "Erase Me", requesterEmail: email, companyId }
        : { subject, description: "Details", priority: "normal", requesterContactId: contactId, companyId },
    ),
    actor(),
  );
}

beforeAll(async () => {
  admin = await makeUser("admin", "Stage4 Admin");
  companyId = await createCompany(companySchema.parse({ name: "Stage4 Test Co", status: "customer", website: "stage4test.co.uk" }), admin.id);
  otherCompanyId = await createCompany(companySchema.parse({ name: "Stage4 Other Co", status: "customer", website: "stage4other.co.uk" }), admin.id);
  contactId = await createContact(contactSchema.parse({ firstName: "Sam", lastName: "Stage", email: "sam@stage4test.co.uk", companyId }), admin.id);
});

describe("knowledge base", () => {
  it("creates drafts with revisions, publishes, searches, suggests by subject and restores an earlier version", async () => {
    const id = await saveArticle(null, { title: `Wi-Fi keeps dropping ${stamp}`, body: "## Fix\n\nForget the network and rejoin.", summary: "Roaming issue", category: "Network", tags: ["wifi", "Laptop"], customerVisible: true, reviewDueAt: null, changeNote: null }, admin.id);
    let a = await getArticle(id);
    expect(a!.status).toBe("draft");
    expect(a!.slug).toBe(slugify(`Wi-Fi keeps dropping ${stamp}`));
    expect(a!.tags).toEqual(["wifi", "laptop"]);
    expect(a!.revisions).toHaveLength(1);
    // Drafts are never suggested or insertable.
    expect((await suggestArticles(`wifi dropping ${stamp}`)).some((s) => s.id === id)).toBe(false);
    await expect(articleBodyForInsert(id, false)).rejects.toThrow(ActionError);

    await setArticleStatus(id, "published", admin.id);
    expect((await suggestArticles(`My wifi keeps dropping ${stamp}`)).some((s) => s.id === id)).toBe(true);
    expect((await listArticles({ q: `dropping ${stamp}` })).some((r) => r.id === id)).toBe(true);
    expect((await globalSearch(`Wi-Fi keeps dropping ${stamp}`)).some((h) => h.type === "article" && h.id === id)).toBe(true);

    await saveArticle(id, { title: `Wi-Fi keeps dropping ${stamp}`, body: "## Fix\n\nUpdate the driver.", summary: "Roaming issue", category: "Network", tags: ["wifi"], customerVisible: true, reviewDueAt: null, changeNote: "driver fix" }, admin.id);
    a = await getArticle(id);
    expect(a!.version).toBe(2);
    expect(a!.revisions.map((r) => r.version)).toEqual([2, 1]);
    await restoreRevision(id, 1, admin.id);
    a = await getArticle(id);
    expect(a!.version).toBe(3);
    expect(a!.body).toContain("Forget the network");
    const revs = await db.select().from(kbArticleRevisions).where(eq(kbArticleRevisions.articleId, id));
    expect(revs).toHaveLength(3);
  });

  it("links articles to tickets, counts sends, and never lets an internal-only article go to a customer", async () => {
    const internalId = await saveArticle(null, { title: `Internal runbook ${stamp}`, body: "Admin password rotation steps.", summary: null, category: null, tags: [], customerVisible: false, reviewDueAt: null, changeNote: null }, admin.id);
    await setArticleStatus(internalId, "published", admin.id);
    const publicId = await saveArticle(null, { title: `Customer how-to ${stamp}`, body: "Press the button.", summary: null, category: null, tags: [], customerVisible: true, reviewDueAt: null, changeNote: null }, admin.id);
    await setArticleStatus(publicId, "published", admin.id);
    const ticketId = await newTicket(`Article links ${stamp}`);

    expect((await insertableArticles(true)).some((x) => x.id === internalId)).toBe(false);
    expect((await insertableArticles(false)).some((x) => x.id === internalId)).toBe(true);
    await expect(articleBodyForInsert(internalId, true)).rejects.toThrow(/internal/);
    expect((await articleBodyForInsert(publicId, true)).body).toBe("Press the button.");

    await linkArticleToTicket(ticketId, internalId, actor(), "linked");
    await linkArticleToTicket(ticketId, publicId, actor(), "sent");
    await linkArticleToTicket(ticketId, publicId, actor(), "sent"); // idempotent link, counted twice as used
    const linked = await ticketArticles(ticketId);
    expect(linked.map((l) => l.id).sort()).toEqual([internalId, publicId].sort());
    expect(linked.find((l) => l.id === publicId)?.kind).toBe("sent");
    expect((await getArticle(publicId))!.usedCount).toBe(2);
    const links = await db.select().from(ticketKbLinks).where(eq(ticketKbLinks.ticketId, ticketId));
    expect(links).toHaveLength(2);

    // Writing an article from a ticket links it as the source and records an event.
    const fromId = await saveArticle(null, { title: `Written from ticket ${stamp}`, body: "Fix text", summary: null, category: null, tags: [], customerVisible: false, reviewDueAt: null, changeNote: null }, admin.id, { fromTicketId: ticketId });
    expect((await ticketArticles(ticketId)).find((l) => l.id === fromId)?.kind).toBe("created_from");
    expect((await db.select().from(ticketEvents).where(and(eq(ticketEvents.ticketId, ticketId), eq(ticketEvents.kind, "kb")))).length).toBeGreaterThanOrEqual(3);
  });
});

describe("assets", () => {
  it("links a customer's device to its ticket, refuses another customer's device, and lists tickets per device", async () => {
    const [mine] = await db
      .insert(ninjaDevices)
      .values({ deviceId: `s4-${stamp}-a`, orgId: `s4-org-${stamp}`, companyId, nodeClass: "WINDOWS_WORKSTATION", displayName: `S4-LAPTOP-${stamp}`, offline: false })
      .returning({ id: ninjaDevices.id });
    const [theirs] = await db
      .insert(ninjaDevices)
      .values({ deviceId: `s4-${stamp}-b`, orgId: `s4-org2-${stamp}`, companyId: otherCompanyId, nodeClass: "WINDOWS_SERVER", displayName: `S4-SERVER-${stamp}`, offline: true })
      .returning({ id: ninjaDevices.id });
    const ticketId = await newTicket(`Device links ${stamp}`);
    const options = await deviceOptionsForTicket(ticketId);
    expect(options.some((o) => o.id === mine.id)).toBe(true);
    expect(options.some((o) => o.id === theirs.id)).toBe(false);
    await linkDevice(ticketId, mine.id, actor(), "reception laptop");
    await linkDevice(ticketId, mine.id, actor()); // idempotent
    await expect(linkDevice(ticketId, theirs.id, actor())).rejects.toThrow(/different customer/);
    const linked = await ticketDevices(ticketId);
    expect(linked).toHaveLength(1);
    expect(linked[0].displayName).toBe(`S4-LAPTOP-${stamp}`);
    expect((await deviceTickets(mine.id)).some((t) => t.id === ticketId)).toBe(true);
    await unlinkDevice(ticketId, mine.id, actor());
    expect(await ticketDevices(ticketId)).toHaveLength(0);
  });
});

describe("retention and anonymisation", () => {
  it("anonymises a closed ticket: identity, participants, addresses and attachments go; text, notes and events stay", async () => {
    const email = `erase-${stamp}@stage4test.co.uk`;
    const ticketId = await newTicket(`Erase me ${stamp}`, email);
    await addMessage(ticketId, { kind: "internal", body: "Internal note stays", channel: "note", to: [], cc: [], bcc: [], status: null, replyToMessageId: null, version: undefined }, actor());
    await db.insert(ticketAttachments).values({ ticketId, fileName: "scan.pdf", contentType: "application/pdf", sizeBytes: 10, storagePath: null, scanStatus: "clean" });
    await changeStatus(ticketId, "resolved", actor(), { resolutionSummary: "Done" });
    await changeStatus(ticketId, "closed", actor());
    const r = await anonymiseTicket(ticketId, actor(), "test");
    expect(r.changed).toBe(true);
    const t = await getTicket(ticketId);
    expect(t!.anonymizedAt).not.toBeNull();
    expect(t!.requesterEmail).not.toContain("stage4test");
    expect(t!.requesterName).toBe("Anonymised requester");
    expect(t!.participants.filter((p) => p.role !== "follower")).toHaveLength(0);
    expect(t!.attachments).toHaveLength(0);
    const msgs = await db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, ticketId));
    expect(msgs.some((m) => m.bodyText?.includes("Internal note stays") || m.bodyMarkdown?.includes("Internal note stays"))).toBe(true);
    expect(msgs.every((m) => !m.fromEmail?.includes("stage4test"))).toBe(true);
    expect(msgs.every((m) => (m.metadata as Record<string, unknown> | null)?.anonymised === true)).toBe(true);
    expect((await db.select().from(ticketEvents).where(and(eq(ticketEvents.ticketId, ticketId), eq(ticketEvents.kind, "anonymised")))).length).toBe(1);
    // Second call is a no-op.
    expect((await anonymiseTicket(ticketId, actor(), "again")).changed).toBe(false);
  });

  it("anonymises every ticket for an e-mail (data-subject request) and the nightly run prunes finished rows only", async () => {
    const email = `dsr-${stamp}@stage4test.co.uk`;
    const a = await newTicket(`DSR one ${stamp}`, email);
    const b = await newTicket(`DSR two ${stamp}`, email);
    const res = await anonymiseByEmail(email, actor());
    expect(res.tickets).toBe(2);
    expect((await getTicket(a))!.anonymizedAt).not.toBeNull();
    expect((await getTicket(b))!.anonymizedAt).not.toBeNull();
    // Retention: an old read notification goes, an unread one stays.
    await db.insert(helpdeskNotifications).values([
      { userId: admin.id, kind: "automation", title: "old read", readAt: new Date(), createdAt: new Date(Date.now() - 100 * 86400000) },
      { userId: admin.id, kind: "automation", title: "old unread", createdAt: new Date(Date.now() - 100 * 86400000) },
    ]);
    const run = await runHelpdeskRetention();
    expect(run.notificationsDeleted).toBeGreaterThanOrEqual(1);
    const left = await db.select().from(helpdeskNotifications).where(and(eq(helpdeskNotifications.userId, admin.id), eq(helpdeskNotifications.title, "old unread")));
    expect(left).toHaveLength(1);
    expect(run.ticketsAnonymised).toBe(0); // HELPDESK_ANONYMISE_AFTER_DAYS is unset in tests
    const open = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, a));
    expect(open).toHaveLength(1); // never deleted
  });
});

describe("monitoring and permissions", () => {
  it("reports helpdesk health facts without content", async () => {
    const h = await helpdeskHealth();
    expect(["ok", "degraded"]).toContain(h.status);
    expect(typeof h.tickets.open).toBe("number");
    expect(JSON.stringify(h)).not.toMatch(/stage4test/);
  });
  it("keeps the helpdesk permission ladder", () => {
    expect(can("read_only", "helpdesk.read")).toBe(true);
    expect(can("read_only", "helpdesk.agent")).toBe(false);
    expect(can("technician", "helpdesk.agent")).toBe(true);
    expect(can("technician", "helpdesk.manage")).toBe(false);
    expect(can("account_manager", "helpdesk.manage")).toBe(true);
    expect(can("account_manager", "helpdesk.admin")).toBe(false);
    expect(can("admin", "helpdesk.admin")).toBe(true);
    expect(can("sales", "helpdesk.agent")).toBe(false);
  });
});

// Participants table is touched by anonymisation; keep the import used for the role filter above.
void ticketParticipants;
