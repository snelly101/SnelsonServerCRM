import { describe, expect, it, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { helpdeskNotifications, mailboxOutbox, portalAccounts, portalLoginTokens, portalSessions, ticketAttachments, ticketEvents, ticketFeedback, ticketMessages, tickets } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { createContact } from "@/services/contacts";
import { companySchema, contactSchema } from "@/lib/validation";
import { addMessage, addTimeEntry, assignTicket, changeStatus, createTicket, getTicket } from "@/services/helpdesk";
import { saveArticle, setArticleStatus } from "@/services/helpdesk-kb";
import { storeUpload } from "@/services/mailbox";
import { hashToken, PORTAL_LOGIN_TOKEN_MINUTES } from "@/lib/portal-session";
import { totp } from "@/lib/totp";
import { beginPortalTotpSetup, confirmPortalTotpSetup, invitePortalAccount, listPortalAccounts, pendingPortalSession, portalAccountFromSession, resetPortalTotp, verifyPortalSecondFactor, portalAttachment, portalCreateTicket, portalGetTicket, portalKbArticle, portalKbList, portalListTickets, portalReply, portalSubmitFeedback, portalTicketCounts, purgePortalTokens, redeemPortalToken, requestPortalLogin, setPortalAccess, signOutPortal, type PortalAccount } from "@/services/portal";
import { ActionError } from "@/lib/action-result";
import { makeUser } from "./helpers";

const SECRET_NOTE = "INTERNAL-NOTE-SECRET-7f3a";
const RESTRICTED_FILE = "restricted-runbook-9c1d.txt";
const STAFF_BCC = "bcc-hidden@staff.test";

let admin: { id: string; name: string };
let tech: { id: string; name: string };
let companyId: string;
let otherCompanyId: string;
let ann: string; // ordinary contact
let bob: string; // company administrator
let stranger: string; // contact at another company
let annAccount: PortalAccount;
let bobAccount: PortalAccount;
let strangerAccount: PortalAccount;
let annTicket: string;
let otherTicket: string;
let strangerTicket: string;

const stamp = Date.now().toString(36);

/** Authenticator secrets per contact, as a customer's phone would hold them. */
const secrets = new Map<string, string>();

/** Completes the second factor on a pending session: sets up the authenticator the first time, otherwise gives the current code. */
async function secondFactor(contactId: string, sessionToken: string) {
  const pending = await pendingPortalSession(sessionToken);
  if (!pending) throw new Error("no pending session");
  if (!pending.enrolled) {
    const { secret } = await beginPortalTotpSetup(sessionToken);
    secrets.set(contactId, secret);
    return (await confirmPortalTotpSetup(sessionToken, totp(secret).code)).recoveryCodes;
  }
  await verifyPortalSecondFactor(sessionToken, totp(secrets.get(contactId)!).code);
  return null;
}

async function redeemAndVerify(contactId: string, token: string) {
  const { sessionToken } = await redeemPortalToken(token, { ip: "203.0.113.7", userAgent: "vitest" });
  await secondFactor(contactId, sessionToken);
  return sessionToken;
}

async function signIn(contactId: string): Promise<PortalAccount> {
  const invite = await invitePortalAccount(contactId, {}, admin.id);
  const sessionToken = await redeemAndVerify(contactId, invite.link.split("/portal/login/")[1]);
  const account = await portalAccountFromSession(sessionToken);
  if (!account) throw new Error("session not created");
  return account;
}

beforeAll(async () => {
  admin = await makeUser("admin", "Portal Admin");
  tech = await makeUser("technician", "Portal Tech");
  companyId = await createCompany(companySchema.parse({ name: `Portal Test Co ${stamp}`, status: "customer" }), admin.id);
  otherCompanyId = await createCompany(companySchema.parse({ name: `Portal Other Co ${stamp}`, status: "customer" }), admin.id);
  ann = await createContact(contactSchema.parse({ companyId, firstName: "Ann", lastName: "Portal", email: `ann.${stamp}@portaltest.co.uk` }), admin.id);
  bob = await createContact(contactSchema.parse({ companyId, firstName: "Bob", lastName: "Boss", email: `bob.${stamp}@portaltest.co.uk` }), admin.id);
  stranger = await createContact(contactSchema.parse({ companyId: otherCompanyId, firstName: "Sid", lastName: "Stranger", email: `sid.${stamp}@portalother.co.uk` }), admin.id);

  // Tickets created by agents, with things a customer must never see.
  annTicket = await createTicket({ subject: `Printer offline ${stamp}`, description: "The 2nd floor printer shows a paper jam.", priority: "normal", type: "incident", categoryId: null, subcategoryId: null, tags: [], requesterContactId: ann, requesterName: null, requesterEmail: null, companyId: null, assigneeUserId: tech.id, teamId: null, customFields: {} }, { id: admin.id, type: "user" }, { source: "manual" });
  await addMessage(annTicket, { kind: "internal", body: `${SECRET_NOTE} customer is on the cheap plan`, channel: "note", to: [], cc: [], bcc: [], status: undefined, replyToMessageId: null, version: undefined } as never, { id: tech.id, type: "user", name: tech.name });
  await addMessage(annTicket, { kind: "public", body: "We have cleared the jam remotely, please try again.", channel: "manual", to: [], cc: [], bcc: [], status: undefined, replyToMessageId: null, version: undefined } as never, { id: tech.id, type: "user", name: tech.name });
  await addTimeEntry(annTicket, tech.id, { minutes: 15, note: "remote fix", billable: true } as never, { id: tech.id, type: "user" });
  // A restricted attachment and a normal one on the same ticket.
  await storeUpload(annTicket, { name: RESTRICTED_FILE, type: "text/plain", bytes: Buffer.from("admin password rotation") }, tech.id, true);
  await storeUpload(annTicket, { name: "jam-photo.txt", type: "text/plain", bytes: Buffer.from("photo placeholder") }, tech.id, false);
  // A BCC on an outbound-looking message.
  await db.insert(ticketMessages).values({ ticketId: annTicket, kind: "public", channel: "manual", direction: "outbound", authorUserId: tech.id, fromName: tech.name, bccRecipients: [{ email: STAFF_BCC }], bodyText: "Follow-up with a hidden copy", subject: "x" });

  otherTicket = await createTicket({ subject: `Bob's own VPN issue ${stamp}`, description: "VPN drops hourly.", priority: "normal", type: "incident", categoryId: null, subcategoryId: null, tags: [], requesterContactId: bob, requesterName: null, requesterEmail: null, companyId: null, assigneeUserId: null, teamId: null, customFields: {} }, { id: admin.id, type: "user" });
  strangerTicket = await createTicket({ subject: `Stranger's secret project ${stamp}`, description: "Confidential migration.", priority: "normal", type: "incident", categoryId: null, subcategoryId: null, tags: [], requesterContactId: stranger, requesterName: null, requesterEmail: null, companyId: null, assigneeUserId: null, teamId: null, customFields: {} }, { id: admin.id, type: "user" });
});

describe("portal sign-in", () => {
  it("invites a contact, redeems the one-time link once, and resolves a session", async () => {
    await expect(invitePortalAccount(stranger, {}, admin.id).then(() => setPortalAccess(stranger, { enabled: true }, admin.id))).resolves.toBeUndefined();
    const noEmail = await createContact(contactSchema.parse({ companyId, firstName: "No", lastName: "Email" }), admin.id);
    await expect(invitePortalAccount(noEmail, {}, admin.id)).rejects.toThrow(/e-mail address/);

    const invite = await invitePortalAccount(ann, {}, admin.id);
    expect(invite.link).toMatch(/\/portal\/login\/[A-Za-z0-9_-]{40,}$/);
    const token = invite.link.split("/portal/login/")[1];
    const [stored] = await db.select().from(portalLoginTokens).where(eq(portalLoginTokens.tokenHash, hashToken(token)));
    expect(stored.purpose).toBe("invite");
    expect(stored.tokenHash).not.toBe(token);
    const { sessionToken, needsSetup } = await redeemPortalToken(token, { ip: "203.0.113.7", userAgent: "vitest" });
    expect(needsSetup).toBe(true);
    // The link alone opens nothing: the session is pending until the authenticator code is given.
    expect(await portalAccountFromSession(sessionToken)).toBeNull();
    expect(await pendingPortalSession(sessionToken)).toMatchObject({ email: `ann.${stamp}@portaltest.co.uk`, enrolled: false });
    const recovery = await secondFactor(ann, sessionToken);
    expect(recovery).toHaveLength(8);
    const account = await portalAccountFromSession(sessionToken);
    expect(account).toMatchObject({ contactId: ann, companyId, email: `ann.${stamp}@portaltest.co.uk`, name: "Ann Portal", isCompanyAdmin: false });
    expect(await pendingPortalSession(sessionToken)).toBeNull();
    // Single use.
    await expect(redeemPortalToken(token, {})).rejects.toThrow(/expired or was already used/);
    await expect(redeemPortalToken("not-a-real-token", {})).rejects.toThrow(/expired or was already used/);
    annAccount = account!;
    bobAccount = await signIn(bob);
    await setPortalAccess(bob, { isCompanyAdmin: true }, admin.id);
    bobAccount = (await portalAccountFromSession(await redeemAndVerify(bob, (await invitePortalAccount(bob, {}, admin.id)).link.split("/portal/login/")[1])))!;
    expect(bobAccount.isCompanyAdmin).toBe(true);
    strangerAccount = await signIn(stranger);
    expect((await listPortalAccounts(companyId)).map((a) => a.name).sort()).toEqual(["Ann Portal", "Bob Boss"]);
  });

  it("login requests never reveal whether an address exists, are rate limited, and sign-out revokes the session", async () => {
    expect(await requestPortalLogin("nobody@nowhere.test", { ip: "198.51.100.1" })).toEqual({ sent: false });
    expect(await requestPortalLogin(`ANN.${stamp}@portaltest.co.uk`, { ip: "198.51.100.1" })).toEqual({ sent: true });
    const [acct] = await db.select().from(portalAccounts).where(eq(portalAccounts.contactId, ann));
    const [t] = await db.select().from(portalLoginTokens).where(and(eq(portalLoginTokens.accountId, acct.id), eq(portalLoginTokens.purpose, "login")));
    expect(t.expiresAt.getTime() - t.createdAt.getTime()).toBeLessThanOrEqual(PORTAL_LOGIN_TOKEN_MINUTES * 60_000 + 1000);
    // With a (demo) mailbox the mail is queued as a ticket-less outbox row carrying its own subject and body with the link;
    // without one (CI) nothing is queued and the customer still gets the same answer.
    const queued = await db.select().from(mailboxOutbox).where(eq(mailboxOutbox.kind, "portal"));
    if (process.env.DEMO_MODE === "true") {
      expect(queued.length).toBeGreaterThanOrEqual(1);
      expect(queued.every((q) => q.ticketId === null && q.messageId === null && /support portal/.test(q.subject ?? "") && /\/portal\/login\//.test(q.bodyMarkdown ?? ""))).toBe(true);
      expect(queued.some((q) => q.toSummary === `ann.${stamp}@portaltest.co.uk`)).toBe(true);
    } else {
      expect(queued.length).toBe(0);
    }
    // Per-account limit: five an hour.
    for (let i = 0; i < 6; i++) await requestPortalLogin(`ann.${stamp}@portaltest.co.uk`, { ip: "198.51.100.1" });
    const tokens = await db.select().from(portalLoginTokens).where(and(eq(portalLoginTokens.accountId, acct.id), eq(portalLoginTokens.purpose, "login")));
    expect(tokens.length).toBe(5);

    const session = await signIn(ann);
    const [row] = await db.select().from(portalSessions).where(eq(portalSessions.accountId, session.id)).orderBy(portalSessions.createdAt);
    void row;
    const fresh = (await invitePortalAccount(ann, {}, admin.id)).link.split("/portal/login/")[1];
    const sessionToken = await redeemAndVerify(ann, fresh);
    expect(await portalAccountFromSession(sessionToken)).not.toBeNull();
    await signOutPortal(sessionToken);
    expect(await portalAccountFromSession(sessionToken)).toBeNull();
  });

  it("switching access off ends every session and blocks new links", async () => {
    const s = await signIn(stranger);
    const [{ tokenHash }] = await db.select({ tokenHash: portalSessions.tokenHash }).from(portalSessions).where(and(eq(portalSessions.accountId, s.id))).orderBy(portalSessions.createdAt);
    void tokenHash;
    await setPortalAccess(stranger, { enabled: false }, admin.id);
    const live = await db.select().from(portalSessions).where(and(eq(portalSessions.accountId, s.id)));
    expect(live.every((x) => x.revokedAt)).toBe(true);
    expect(await requestPortalLogin(`sid.${stamp}@portalother.co.uk`, {})).toEqual({ sent: false });
    await setPortalAccess(stranger, { enabled: true }, admin.id);
    strangerAccount = await signIn(stranger);
  });
});

describe("portal second factor", () => {
  it("a later sign-in needs the authenticator code; wrong codes are limited; a recovery code works once", async () => {
    const link = (await invitePortalAccount(ann, {}, admin.id)).link.split("/portal/login/")[1];
    const { sessionToken, needsSetup } = await redeemPortalToken(link, {});
    expect(needsSetup).toBe(false);
    expect(await portalAccountFromSession(sessionToken)).toBeNull();
    await expect(beginPortalTotpSetup(sessionToken)).rejects.toThrow(/already set up/);
    await expect(verifyPortalSecondFactor(sessionToken, "000000")).rejects.toThrow(/did not match/);
    const secret = secrets.get(ann)!;
    const r = await verifyPortalSecondFactor(sessionToken, totp(secret).code);
    expect(r.factor).toBe("totp");
    expect(await portalAccountFromSession(sessionToken)).not.toBeNull();
    // A code cannot be reused to verify a second pending session? Each session verifies independently; five wrong codes end the attempt.
    const again = (await redeemPortalToken((await invitePortalAccount(ann, {}, admin.id)).link.split("/portal/login/")[1], {})).sessionToken;
    for (let i = 0; i < 4; i++) await expect(verifyPortalSecondFactor(again, "111111")).rejects.toThrow(/did not match/);
    await expect(verifyPortalSecondFactor(again, "111111")).rejects.toThrow(/Too many wrong codes/);
    await expect(verifyPortalSecondFactor(again, totp(secret).code)).rejects.toThrow(/expired/);
    // Recovery code: works once, then is gone.
    const [acct] = await db.select().from(portalAccounts).where(eq(portalAccounts.contactId, ann));
    expect(acct.recoveryCodes).toHaveLength(8);
    expect(acct.totpSecretEnc).not.toContain(secret);
    const fresh = (await redeemPortalToken((await invitePortalAccount(ann, {}, admin.id)).link.split("/portal/login/")[1], {})).sessionToken;
    // The plaintext codes were returned at setup; we kept none, so mint a known one by resetting and re-enrolling below.
    await resetPortalTotp(ann, admin.id);
    expect(await portalAccountFromSession(fresh)).toBeNull(); // reset ends sessions, pending ones too
    const after = (await redeemPortalToken((await invitePortalAccount(ann, {}, admin.id)).link.split("/portal/login/")[1], {}));
    expect(after.needsSetup).toBe(true);
    await expect(verifyPortalSecondFactor(after.sessionToken, "123456")).rejects.toThrow("SETUP_REQUIRED");
    const codes = (await secondFactor(ann, after.sessionToken))!;
    const s2 = (await redeemPortalToken((await invitePortalAccount(ann, {}, admin.id)).link.split("/portal/login/")[1], {})).sessionToken;
    const used = await verifyPortalSecondFactor(s2, codes[0].toLowerCase());
    expect(used).toMatchObject({ factor: "recovery", recoveryCodesLeft: 7 });
    const s3 = (await redeemPortalToken((await invitePortalAccount(ann, {}, admin.id)).link.split("/portal/login/")[1], {})).sessionToken;
    await expect(verifyPortalSecondFactor(s3, codes[0])).rejects.toThrow(/did not match/);
    await verifyPortalSecondFactor(s3, codes[1]);
    annAccount = (await portalAccountFromSession(s3))!;
  });
});

describe("portal tickets: scope and leakage", () => {
  it("a contact sees only their own tickets; a company administrator sees the company's; another company sees nothing", async () => {
    const annRows = await portalListTickets(annAccount, { view: "all" });
    expect(annRows.map((r) => r.id)).toEqual([annTicket]);
    const bobRows = await portalListTickets(bobAccount, { view: "all" });
    expect(bobRows.map((r) => r.id).sort()).toEqual([annTicket, otherTicket].sort());
    expect((await portalListTickets(bobAccount, { view: "all", scope: "mine" })).map((r) => r.id)).toEqual([otherTicket]);
    const sidRows = await portalListTickets(strangerAccount, { view: "all" });
    expect(sidRows.map((r) => r.id)).toEqual([strangerTicket]);
    expect(await portalGetTicket(annAccount, otherTicket)).toBeNull();
    expect(await portalGetTicket(annAccount, strangerTicket)).toBeNull();
    expect(await portalGetTicket(strangerAccount, annTicket)).toBeNull();
    expect(await portalTicketCounts(bobAccount)).toMatchObject({ open: 2 });
  });

  it("internal notes, restricted attachments, BCCs and time entries never leak", async () => {
    const t = (await portalGetTicket(annAccount, annTicket))!;
    const dump = JSON.stringify(t);
    expect(dump).not.toContain(SECRET_NOTE);
    expect(dump).not.toContain(RESTRICTED_FILE);
    expect(dump).not.toContain(STAFF_BCC);
    expect(dump).not.toContain("timeSpent");
    // Field names only: a random id can contain "bcc" by chance.
    expect(dump).not.toMatch(/"bcc[A-Za-z]*":/);
    expect(t.messages.map((m) => m.bodyText)).toEqual(expect.arrayContaining(["We have cleared the jam remotely, please try again."]));
    expect(t.messages.some((m) => m.bodyText.includes(SECRET_NOTE))).toBe(false);
    const visibleFiles = [...t.messages.flatMap((m) => m.attachments), ...t.looseAttachments].map((a) => a.fileName);
    expect(visibleFiles).toEqual(["jam-photo.txt"]);
    expect(t.assigneeName).toBe("Portal Tech");
    // The download route's lookup refuses the restricted file even by id, and any file on a foreign ticket.
    const [restricted] = await db.select().from(ticketAttachments).where(and(eq(ticketAttachments.ticketId, annTicket), eq(ticketAttachments.restricted, true)));
    const [normal] = await db.select().from(ticketAttachments).where(and(eq(ticketAttachments.ticketId, annTicket), eq(ticketAttachments.restricted, false)));
    expect(await portalAttachment(annAccount, restricted.id)).toBeNull();
    expect((await portalAttachment(annAccount, normal.id))?.fileName).toBe("jam-photo.txt");
    expect(await portalAttachment(strangerAccount, normal.id)).toBeNull();
    // Staff view is unchanged.
    const staff = await getTicket(annTicket);
    expect(JSON.stringify(staff)).toContain(SECRET_NOTE);
  });

  it("creates a ticket from the portal with attachments, notifies agents, and shows it to the agent as a portal ticket", async () => {
    const r = await portalCreateTicket(annAccount, { subject: `Laptop battery ${stamp}`, description: "Dies after 20 minutes.\n\nStarted yesterday.", priority: "high" }, [
      { name: "battery-report.txt", type: "text/plain", bytes: Buffer.from("report") },
      { name: "virus.exe", type: "application/octet-stream", bytes: Buffer.from("MZ") },
    ]);
    expect(r.reference).toMatch(/^IT-\d{6}$/);
    expect(r.refused).toEqual([{ fileName: "virus.exe", error: expect.stringContaining("not accepted") }]);
    const [t] = await db.select().from(tickets).where(eq(tickets.id, r.id));
    expect(t).toMatchObject({ source: "portal", status: "new", priority: "high", requesterContactId: ann, companyId, requesterEmail: `ann.${stamp}@portaltest.co.uk` });
    expect(t.lastCustomerMessageAt).not.toBeNull();
    const msgs = await db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, r.id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: "public", channel: "portal", direction: "inbound", fromEmail: `ann.${stamp}@portaltest.co.uk` });
    const atts = await db.select().from(ticketAttachments).where(eq(ticketAttachments.ticketId, r.id));
    expect(atts.map((a) => a.fileName)).toEqual(["battery-report.txt"]);
    expect(atts[0].messageId).toBe(msgs[0].id);
    expect(atts[0].restricted).toBe(false);
    // Critical cannot be chosen by a customer.
    const low = await portalCreateTicket(annAccount, { subject: `Urgent? ${stamp}`, description: "x", priority: "critical" as never });
    expect((await db.select().from(tickets).where(eq(tickets.id, low.id)))[0].priority).toBe("normal");
    await expect(portalCreateTicket(annAccount, { subject: "", description: "x" })).rejects.toThrow(/subject/);
    const mine = await portalGetTicket(annAccount, r.id);
    expect(mine?.isMine).toBe(true);
    expect(mine?.messages[0].fromCustomer).toBe(true);
  });

  it("a portal reply is a public inbound message that reopens resolved and awaiting tickets and alerts the assignee", async () => {
    await changeStatus(annTicket, "awaiting_customer", { id: tech.id, type: "user" });
    const r = await portalReply(annAccount, annTicket, "Still jammed after trying again.", [{ name: "second-photo.txt", type: "text/plain", bytes: Buffer.from("photo 2") }]);
    const [m] = await db.select().from(ticketMessages).where(eq(ticketMessages.id, r.messageId));
    expect(m).toMatchObject({ kind: "public", channel: "portal", direction: "inbound", fromName: "Ann Portal" });
    const [t] = await db.select().from(tickets).where(eq(tickets.id, annTicket));
    expect(t.status).toBe("open");
    const notes = await db.select().from(helpdeskNotifications).where(and(eq(helpdeskNotifications.userId, tech.id), eq(helpdeskNotifications.ticketId, annTicket), eq(helpdeskNotifications.kind, "customer_replied")));
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0].title).toContain("portal reply from Ann Portal");
    const events = await db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, annTicket));
    expect(events.some((e) => e.summary === "Portal reply from Ann Portal")).toBe(true);
    // Cannot reply to someone else's ticket, even when it exists.
    await expect(portalReply(strangerAccount, annTicket, "hello")).rejects.toThrow(/not found/i);
    // A company administrator replying to a colleague's ticket is added as a CC.
    await portalReply(bobAccount, annTicket, "Boss here, this is affecting the whole floor.");
    const bobView = await portalGetTicket(bobAccount, annTicket);
    expect(bobView?.messages.at(-1)?.author).toBe("Bob Boss");
    await changeStatus(annTicket, "resolved", { id: tech.id, type: "user" }, { resolutionSummary: "Replaced the roller." });
    await portalReply(annAccount, annTicket, "It broke again.");
    expect((await db.select().from(tickets).where(eq(tickets.id, annTicket)))[0].status).toBe("open");
  });

  it("feedback is only possible on resolved or closed tickets the account can see, one per ticket, and reaches the assignee", async () => {
    await assignTicket(otherTicket, { assigneeUserId: tech.id }, { id: admin.id, type: "user" });
    await expect(portalSubmitFeedback(bobAccount, otherTicket, 5, "great")).rejects.toThrow(/once it is resolved/);
    await changeStatus(otherTicket, "resolved", { id: tech.id, type: "user" }, { resolutionSummary: "Updated the VPN client." });
    await expect(portalSubmitFeedback(annAccount, otherTicket, 5, null)).rejects.toThrow(/not found/i); // Ann is not an admin and it is not hers
    await portalSubmitFeedback(bobAccount, otherTicket, 4, "Quick, thanks");
    await expect(portalSubmitFeedback(bobAccount, otherTicket, 9, null)).rejects.toThrow(/1 to 5/);
    await portalSubmitFeedback(bobAccount, otherTicket, 5, "Even better on reflection");
    const rows = await db.select().from(ticketFeedback).where(eq(ticketFeedback.ticketId, otherTicket));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rating: 5, comment: "Even better on reflection" });
    const view = await portalGetTicket(bobAccount, otherTicket);
    expect(view?.feedback).toMatchObject({ rating: 5 });
    expect(view?.canRate).toBe(true);
    const notes = await db.select().from(helpdeskNotifications).where(and(eq(helpdeskNotifications.userId, tech.id), eq(helpdeskNotifications.ticketId, otherTicket)));
    // Two ratings within ten minutes collapse into one unread notification, so either rating may be the one recorded.
    expect(notes.some((n) => /rated [45]\/5 by Bob Boss/.test(n.title))).toBe(true);
    expect((await portalListTickets(bobAccount, { view: "resolved" })).find((r) => r.id === otherTicket)?.hasFeedback).toBe(true);
  });
});

describe("portal knowledge base", () => {
  it("lists and opens only published, customer-visible articles", async () => {
    const pub = await saveArticle(null, { title: `Reset your Wi-Fi ${stamp}`, body: "## Steps\n\n1. Forget the network\n2. Rejoin", summary: "Two steps", category: "Network", tags: [], customerVisible: true, reviewDueAt: null, changeNote: null }, admin.id);
    await setArticleStatus(pub, "published", admin.id);
    const draft = await saveArticle(null, { title: `Draft how-to ${stamp}`, body: "not yet", summary: null, category: "Network", tags: [], customerVisible: true, reviewDueAt: null, changeNote: null }, admin.id);
    const internal = await saveArticle(null, { title: `Internal runbook ${stamp}`, body: "admin steps", summary: null, category: "Network", tags: [], customerVisible: false, reviewDueAt: null, changeNote: null }, admin.id);
    await setArticleStatus(internal, "published", admin.id);
    const list = await portalKbList({ q: stamp });
    expect(list.map((a) => a.id)).toEqual([pub]);
    expect(list[0].excerpt).toBe("Two steps");
    const slugOf = async (id: string) => (await db.query.kbArticles.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!.slug;
    expect(await portalKbArticle(await slugOf(pub))).toMatchObject({ title: `Reset your Wi-Fi ${stamp}` });
    expect(await portalKbArticle(await slugOf(draft))).toBeNull();
    expect(await portalKbArticle(await slugOf(internal))).toBeNull();
  });
});

describe("portal housekeeping", () => {
  it("purges expired tokens and sessions after a week", async () => {
    const [acct] = await db.select().from(portalAccounts).where(eq(portalAccounts.contactId, ann));
    await db.insert(portalLoginTokens).values({ accountId: acct.id, tokenHash: "old-token", expiresAt: new Date(Date.now() - 10 * 86400000) });
    await db.insert(portalSessions).values({ accountId: acct.id, tokenHash: "old-session", expiresAt: new Date(Date.now() - 10 * 86400000) });
    const r = await purgePortalTokens();
    expect(r.tokens).toBeGreaterThanOrEqual(1);
    expect(r.sessions).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(portalLoginTokens).where(eq(portalLoginTokens.tokenHash, "old-token"))).length).toBe(0);
  });
  it("ActionError is what customers see for bad input", () => {
    expect(new ActionError("x")).toBeInstanceOf(Error);
  });
});
