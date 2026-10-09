import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, gte, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { companies, contacts, kbArticles, portalAccounts, portalLoginTokens, portalSessions, ticketAttachments, ticketFeedback, ticketMessages, ticketParticipants, tickets, user } from "@/db/schema";
import { ActionError } from "@/lib/action-result";
import { audit, logActivity } from "@/lib/audit";
import { checkAttachmentPolicy, scanBytes, sha256, storeAttachmentBytes } from "@/lib/email/storage";
import { logger } from "@/lib/logger";
import { markdownExcerpt, markdownToPlainText } from "@/lib/markdown-parse";
import { hashToken, newToken, PORTAL_INVITE_TOKEN_HOURS, PORTAL_LOGIN_TOKEN_MINUTES, PORTAL_SESSION_DAYS, portalUrl } from "@/lib/portal-session";
import { getAppSettings } from "@/lib/settings";
import { fullName, normalizeEmail } from "@/lib/utils";
import { ticketReference, TICKET_PRIORITIES, type TicketPriority } from "@/lib/validation-helpdesk";
import { changeStatus, createTicket, recordEvent, type Actor } from "./helpdesk";
import { afterTicketChange } from "./helpdesk-hooks";
import { notifyUsers, ticketAudience } from "./helpdesk-notifications";
import { getDefaultMailbox, mailboxIsLive, queueOutbound } from "./mailbox";

/**
 * Customer portal: the only code path customers reach. Every read here is
 * scoped to a portal account (a contact an agent invited) and returns only
 * what that contact may see: their own tickets (or the company's when they
 * are a company administrator), public messages, customer-visible
 * attachments, published customer-visible articles. Internal notes, time
 * entries, restricted attachments, other customers and staff data are not
 * selectable from these functions.
 */
export const PORTAL_ACTOR: Actor = { id: null, type: "portal" };
const LOGIN_REQUESTS_PER_HOUR = 5;
const LOGIN_REQUESTS_PER_IP_PER_HOUR = 30;

export type PortalAccount = {
  id: string;
  contactId: string;
  companyId: string;
  companyName: string;
  email: string;
  name: string;
  isCompanyAdmin: boolean;
};

// ---------------------------------------------------------------------------
// Agent side: invitations and access
// ---------------------------------------------------------------------------
export async function portalAccountForContact(contactId: string) {
  const [row] = await db.select().from(portalAccounts).where(eq(portalAccounts.contactId, contactId)).limit(1);
  return row ?? null;
}

async function signInEmail(to: { name: string; email: string }, link: string, purpose: "invite" | "login", companyName: string, actorUserId: string | null) {
  const m = await getDefaultMailbox();
  if (!m || (!mailboxIsLive(m) && process.env.DEMO_MODE !== "true")) return false;
  const minutes = purpose === "invite" ? PORTAL_INVITE_TOKEN_HOURS * 60 : PORTAL_LOGIN_TOKEN_MINUTES;
  const validity = purpose === "invite" ? `${PORTAL_INVITE_TOKEN_HOURS} hours` : `${PORTAL_LOGIN_TOKEN_MINUTES} minutes`;
  const markdown =
    purpose === "invite"
      ? `Hello ${to.name},\n\nYou have been given access to the ${companyName} support portal, where you can raise and follow support requests.\n\nUse this link to sign in (valid for ${validity}, one use):\n\n${link}\n\nAfter that, sign in any time at ${portalUrl("/portal/login")} with this e-mail address and we will send you a fresh link.\n\nIf you were not expecting this, you can ignore it.`
      : `Hello ${to.name},\n\nHere is your sign-in link for the ${companyName} support portal (valid for ${validity}, one use):\n\n${link}\n\nIf you did not ask for this, you can ignore it; nobody can sign in without this e-mail.`;
  void minutes;
  await queueOutbound({
    mailbox: m,
    ticketId: null,
    kind: "portal",
    subject: purpose === "invite" ? `Your ${companyName} support portal access` : `Sign in to the ${companyName} support portal`,
    markdown,
    to: [to],
    cc: [],
    bcc: [],
    replyToMessageId: null,
    attachmentIds: [],
    actor: { id: actorUserId, type: actorUserId ? "user" : "system" },
    isAutomated: true,
    appendSignature: false,
  });
  return true;
}

async function issueToken(accountId: string, purpose: "invite" | "login", ip: string | null) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + (purpose === "invite" ? PORTAL_INVITE_TOKEN_HOURS * 3600_000 : PORTAL_LOGIN_TOKEN_MINUTES * 60_000));
  await db.insert(portalLoginTokens).values({ accountId, tokenHash: hashToken(token), purpose, expiresAt, requestIp: ip });
  return { token, link: portalUrl(`/portal/login/${token}`), expiresAt };
}

/**
 * Gives a contact portal access (or re-sends their link). The contact needs
 * an e-mail address. Returns the one-time link so the agent can pass it on
 * when no support mailbox is connected.
 */
export async function invitePortalAccount(contactId: string, opts: { isCompanyAdmin?: boolean }, actorUserId: string) {
  const [c] = await db
    .select({ c: contacts, companyName: companies.name })
    .from(contacts)
    .innerJoin(companies, eq(companies.id, contacts.companyId))
    .where(eq(contacts.id, contactId))
    .limit(1);
  if (!c) throw new ActionError("Contact not found.");
  if (c.c.archivedAt) throw new ActionError("This contact is archived.");
  const email = normalizeEmail(c.c.email);
  if (!email) throw new ActionError("Give the contact an e-mail address first; the portal signs in by e-mailed link.");
  const existing = await portalAccountForContact(contactId);
  let accountId: string;
  if (existing) {
    accountId = existing.id;
    await db
      .update(portalAccounts)
      .set({ email, companyId: c.c.companyId, isCompanyAdmin: opts.isCompanyAdmin ?? existing.isCompanyAdmin, disabledAt: null, invitedByUserId: actorUserId, invitedAt: new Date(), updatedAt: new Date() })
      .where(eq(portalAccounts.id, accountId));
  } else {
    const [row] = await db.insert(portalAccounts).values({ contactId, companyId: c.c.companyId, email, isCompanyAdmin: Boolean(opts.isCompanyAdmin), invitedByUserId: actorUserId }).returning({ id: portalAccounts.id });
    accountId = row.id;
  }
  const { link, expiresAt } = await issueToken(accountId, "invite", null);
  const settings = await getAppSettings();
  const emailed = await signInEmail({ name: fullName(c.c), email }, link, "invite", settings.companyName, actorUserId);
  await audit({ actorUserId, action: existing ? "portal.reinvite" : "portal.invite", entityType: "contact", entityId: contactId, details: { email, isCompanyAdmin: Boolean(opts.isCompanyAdmin ?? existing?.isCompanyAdmin), emailed } });
  await logActivity({ type: "system", companyId: c.c.companyId, contactId, entityType: "portal_account", entityId: accountId, title: `${fullName(c.c)} ${existing ? "re-sent a" : "given"} support portal ${existing ? "sign-in link" : "access"}`, actorUserId });
  return { accountId, link, expiresAt, emailed };
}

export async function setPortalAccess(contactId: string, patch: { enabled?: boolean; isCompanyAdmin?: boolean }, actorUserId: string) {
  const existing = await portalAccountForContact(contactId);
  if (!existing) throw new ActionError("This contact has not been invited to the portal.");
  const set: Partial<typeof portalAccounts.$inferInsert> = { updatedAt: new Date() };
  if (patch.enabled !== undefined) set.disabledAt = patch.enabled ? null : new Date();
  if (patch.isCompanyAdmin !== undefined) set.isCompanyAdmin = patch.isCompanyAdmin;
  await db.update(portalAccounts).set(set).where(eq(portalAccounts.id, existing.id));
  if (patch.enabled === false) await db.update(portalSessions).set({ revokedAt: new Date() }).where(and(eq(portalSessions.accountId, existing.id), isNull(portalSessions.revokedAt)));
  await audit({ actorUserId, action: "portal.access", entityType: "contact", entityId: contactId, details: patch });
}

/** Everyone with portal access, for Settings and the company page. */
export async function listPortalAccounts(companyId?: string) {
  const invitedBy = alias(user, "invited_by");
  const rows = await db
    .select({ a: portalAccounts, firstName: contacts.firstName, lastName: contacts.lastName, companyName: companies.name, invitedByName: invitedBy.name })
    .from(portalAccounts)
    .innerJoin(contacts, eq(contacts.id, portalAccounts.contactId))
    .innerJoin(companies, eq(companies.id, portalAccounts.companyId))
    .leftJoin(invitedBy, eq(invitedBy.id, portalAccounts.invitedByUserId))
    .where(companyId ? eq(portalAccounts.companyId, companyId) : undefined)
    .orderBy(asc(companies.name), asc(contacts.lastName));
  return rows.map((r) => ({ ...r.a, name: fullName({ firstName: r.firstName, lastName: r.lastName }), companyName: r.companyName, invitedByName: r.invitedByName }));
}

// ---------------------------------------------------------------------------
// Customer side: sign-in
// ---------------------------------------------------------------------------
/**
 * Sends a sign-in link if the address belongs to an active portal account.
 * Always resolves without saying whether the address is known, so the form
 * cannot be used to enumerate customers. Rate limited per account and per
 * IP by counting recent tokens.
 */
export async function requestPortalLogin(emailRaw: string, ctx: { ip?: string | null }) {
  const email = normalizeEmail(emailRaw);
  if (!email) return { sent: false as const };
  const hourAgo = new Date(Date.now() - 3600_000);
  if (ctx.ip) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(portalLoginTokens).where(and(eq(portalLoginTokens.requestIp, ctx.ip), gte(portalLoginTokens.createdAt, hourAgo)));
    if (n >= LOGIN_REQUESTS_PER_IP_PER_HOUR) throw new ActionError("Too many sign-in requests. Try again in an hour.");
  }
  const [acct] = await db
    .select({ a: portalAccounts, firstName: contacts.firstName, lastName: contacts.lastName, archivedAt: contacts.archivedAt, companyName: companies.name })
    .from(portalAccounts)
    .innerJoin(contacts, eq(contacts.id, portalAccounts.contactId))
    .innerJoin(companies, eq(companies.id, portalAccounts.companyId))
    .where(eq(portalAccounts.email, email))
    .limit(1);
  if (!acct || acct.a.disabledAt || acct.archivedAt) return { sent: false as const };
  // Only customer-requested links count; an agent re-sending an invite must not use up the customer's allowance.
  const [{ n }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(portalLoginTokens).where(and(eq(portalLoginTokens.accountId, acct.a.id), eq(portalLoginTokens.purpose, "login"), gte(portalLoginTokens.createdAt, hourAgo)));
  if (n >= LOGIN_REQUESTS_PER_HOUR) return { sent: false as const };
  const { link } = await issueToken(acct.a.id, "login", ctx.ip ?? null);
  const settings = await getAppSettings();
  const emailed = await signInEmail({ name: fullName({ firstName: acct.firstName, lastName: acct.lastName }), email }, link, "login", settings.companyName, null);
  await audit({ actorUserId: null, actorType: "system", action: "portal.login_requested", entityType: "portal_account", entityId: acct.a.id, details: { emailed }, ipAddress: ctx.ip ?? null });
  return { sent: true as const };
}

/** Turns a one-time link into a session. Throws a customer-safe error. */
export async function redeemPortalToken(token: string, ctx: { ip?: string | null; userAgent?: string | null }) {
  const [row] = await db.select().from(portalLoginTokens).where(eq(portalLoginTokens.tokenHash, hashToken(token))).limit(1);
  if (!row || row.usedAt || row.expiresAt < new Date()) throw new ActionError("That sign-in link has expired or was already used. Request a new one.");
  const [acct] = await db
    .select({ a: portalAccounts, archivedAt: contacts.archivedAt })
    .from(portalAccounts)
    .innerJoin(contacts, eq(contacts.id, portalAccounts.contactId))
    .where(eq(portalAccounts.id, row.accountId))
    .limit(1);
  if (!acct || acct.a.disabledAt || acct.archivedAt) throw new ActionError("This portal account is not active. Contact your provider.");
  const session = newToken();
  const expiresAt = new Date(Date.now() + PORTAL_SESSION_DAYS * 86400_000);
  await db.transaction(async (tx) => {
    await tx.update(portalLoginTokens).set({ usedAt: new Date() }).where(eq(portalLoginTokens.id, row.id));
    await tx.insert(portalSessions).values({ accountId: acct.a.id, tokenHash: hashToken(session), expiresAt, userAgent: ctx.userAgent?.slice(0, 300) ?? null, ipAddress: ctx.ip ?? null });
    await tx.update(portalAccounts).set({ lastLoginAt: new Date() }).where(eq(portalAccounts.id, acct.a.id));
    await audit({ actorUserId: null, actorType: "system", action: "portal.login", entityType: "portal_account", entityId: acct.a.id, details: { purpose: row.purpose }, ipAddress: ctx.ip ?? null }, tx);
  });
  return { sessionToken: session, expiresAt };
}

export async function portalAccountFromSession(sessionToken: string | undefined | null): Promise<PortalAccount | null> {
  if (!sessionToken) return null;
  const [row] = await db
    .select({ s: portalSessions, a: portalAccounts, firstName: contacts.firstName, lastName: contacts.lastName, archivedAt: contacts.archivedAt, companyName: companies.name })
    .from(portalSessions)
    .innerJoin(portalAccounts, eq(portalAccounts.id, portalSessions.accountId))
    .innerJoin(contacts, eq(contacts.id, portalAccounts.contactId))
    .innerJoin(companies, eq(companies.id, portalAccounts.companyId))
    .where(and(eq(portalSessions.tokenHash, hashToken(sessionToken)), isNull(portalSessions.revokedAt), gt(portalSessions.expiresAt, new Date())))
    .limit(1);
  if (!row || row.a.disabledAt || row.archivedAt) return null;
  if (Date.now() - row.s.lastSeenAt.getTime() > 10 * 60_000) await db.update(portalSessions).set({ lastSeenAt: new Date() }).where(eq(portalSessions.id, row.s.id)).catch(() => undefined);
  return { id: row.a.id, contactId: row.a.contactId, companyId: row.a.companyId, companyName: row.companyName, email: row.a.email, name: fullName({ firstName: row.firstName, lastName: row.lastName }), isCompanyAdmin: row.a.isCompanyAdmin };
}

export async function signOutPortal(sessionToken: string | undefined | null) {
  if (!sessionToken) return;
  await db.update(portalSessions).set({ revokedAt: new Date() }).where(eq(portalSessions.tokenHash, hashToken(sessionToken)));
}

/** Nightly: expired tokens and sessions. */
export async function purgePortalTokens() {
  const cutoff = new Date(Date.now() - 7 * 86400_000);
  const t = await db.delete(portalLoginTokens).where(sql`${portalLoginTokens.expiresAt} < ${cutoff}`).returning({ id: portalLoginTokens.id });
  const s = await db.delete(portalSessions).where(or(sql`${portalSessions.expiresAt} < ${cutoff}`, sql`${portalSessions.revokedAt} < ${cutoff}`)).returning({ id: portalSessions.id });
  return { tokens: t.length, sessions: s.length };
}

// ---------------------------------------------------------------------------
// Customer side: tickets (scoped)
// ---------------------------------------------------------------------------
/** The SQL condition for "this account may see this ticket". Used by every ticket read and write. */
function visibleTo(account: PortalAccount) {
  const own = eq(tickets.requesterContactId, account.contactId);
  const cc = sql`exists (select 1 from ticket_participants p where p.ticket_id = ${tickets.id} and p.contact_id = ${account.contactId})`;
  const company = account.isCompanyAdmin ? eq(tickets.companyId, account.companyId) : undefined;
  return and(isNull(tickets.anonymizedAt), isNull(tickets.mergedIntoTicketId), company ? or(own, cc, company) : or(own, cc));
}

export type PortalTicketRow = {
  id: string;
  reference: string;
  subject: string;
  status: string;
  priority: string;
  requesterName: string | null;
  isMine: boolean;
  createdAt: Date;
  lastActivityAt: Date;
  lastAgentMessageAt: Date | null;
  lastCustomerMessageAt: Date | null;
  resolvedAt: Date | null;
  hasFeedback: boolean;
};

export async function portalListTickets(account: PortalAccount, p: { view?: "open" | "resolved" | "all"; q?: string | null; scope?: "mine" | "company" } = {}): Promise<PortalTicketRow[]> {
  const view = p.view ?? "open";
  const rows = await db
    .select({ t: tickets, feedbackId: ticketFeedback.id })
    .from(tickets)
    .leftJoin(ticketFeedback, eq(ticketFeedback.ticketId, tickets.id))
    .where(
      and(
        visibleTo(account),
        p.scope === "mine" ? eq(tickets.requesterContactId, account.contactId) : undefined,
        view === "open" ? inArray(tickets.status, ["new", "open", "in_progress", "awaiting_customer", "awaiting_third_party"]) : view === "resolved" ? inArray(tickets.status, ["resolved", "closed", "cancelled"]) : undefined,
        p.q ? or(ilike(tickets.subject, `%${p.q}%`), sql`cast(${tickets.number} as text) like ${"%" + p.q.replace(/\D/g, "") + "%"}`) : undefined,
      ),
    )
    .orderBy(desc(tickets.lastActivityAt))
    .limit(200);
  return rows.map((r) => ({
    id: r.t.id,
    reference: ticketReference(r.t.number),
    subject: r.t.subject,
    status: r.t.status,
    priority: r.t.priority,
    requesterName: r.t.requesterName,
    isMine: r.t.requesterContactId === account.contactId,
    createdAt: r.t.createdAt,
    lastActivityAt: r.t.lastActivityAt,
    lastAgentMessageAt: r.t.lastAgentMessageAt,
    lastCustomerMessageAt: r.t.lastCustomerMessageAt,
    resolvedAt: r.t.resolvedAt,
    hasFeedback: Boolean(r.feedbackId),
  }));
}

export async function portalTicketCounts(account: PortalAccount) {
  const rows = await db.select({ status: tickets.status, n: sql<number>`count(*)`.mapWith(Number) }).from(tickets).where(visibleTo(account)).groupBy(tickets.status);
  const open = rows.filter((r) => ["new", "open", "in_progress", "awaiting_customer", "awaiting_third_party"].includes(r.status)).reduce((a, r) => a + r.n, 0);
  const awaiting = rows.filter((r) => r.status === "awaiting_customer").reduce((a, r) => a + r.n, 0);
  const resolved = rows.filter((r) => ["resolved", "closed", "cancelled"].includes(r.status)).reduce((a, r) => a + r.n, 0);
  return { open, awaiting, resolved };
}

export type PortalMessage = {
  id: string;
  at: Date;
  fromCustomer: boolean;
  author: string;
  bodyMarkdown: string | null;
  bodyText: string;
  attachments: { id: string; fileName: string; sizeBytes: number; contentType: string }[];
};

/** Public conversation only. Internal notes, BCCs, staff identities beyond a display name, time and SLA data are never selected. */
export async function portalGetTicket(account: PortalAccount, ticketId: string) {
  const [row] = await db
    .select({ t: tickets, assigneeName: user.name, feedback: ticketFeedback })
    .from(tickets)
    .leftJoin(user, eq(user.id, tickets.assigneeUserId))
    .leftJoin(ticketFeedback, eq(ticketFeedback.ticketId, tickets.id))
    .where(and(eq(tickets.id, ticketId), visibleTo(account)))
    .limit(1);
  if (!row) return null;
  const msgs = await db
    .select({ m: ticketMessages, authorName: user.name })
    .from(ticketMessages)
    .leftJoin(user, eq(user.id, ticketMessages.authorUserId))
    .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.kind, "public"), eq(ticketMessages.isAutomated, false)))
    .orderBy(asc(ticketMessages.at));
  const atts = await db
    .select({ id: ticketAttachments.id, messageId: ticketAttachments.messageId, fileName: ticketAttachments.fileName, sizeBytes: ticketAttachments.sizeBytes, contentType: ticketAttachments.contentType })
    .from(ticketAttachments)
    .where(and(eq(ticketAttachments.ticketId, ticketId), eq(ticketAttachments.restricted, false), eq(ticketAttachments.inline, false), inArray(ticketAttachments.scanStatus, ["clean", "skipped"]), sql`${ticketAttachments.storagePath} is not null`));
  const byMessage = new Map<string | null, typeof atts>();
  for (const a of atts) byMessage.set(a.messageId, [...(byMessage.get(a.messageId) ?? []), a]);
  const messages: PortalMessage[] = msgs.map((r) => {
    const fromCustomer = r.m.direction === "inbound";
    return {
      id: r.m.id,
      at: r.m.at,
      fromCustomer,
      author: fromCustomer ? r.m.fromName || r.m.fromEmail || "You" : r.authorName || r.m.fromName || "Support",
      bodyMarkdown: r.m.bodyMarkdown,
      bodyText: r.m.bodyText,
      attachments: (byMessage.get(r.m.id) ?? []).map(({ id, fileName, sizeBytes, contentType }) => ({ id, fileName, sizeBytes, contentType })),
    };
  });
  const t = row.t;
  return {
    id: t.id,
    reference: ticketReference(t.number),
    subject: t.subject,
    description: t.description,
    status: t.status,
    priority: t.priority,
    type: t.type,
    requesterName: t.requesterName,
    isMine: t.requesterContactId === account.contactId,
    assigneeName: row.assigneeName,
    createdAt: t.createdAt,
    lastActivityAt: t.lastActivityAt,
    resolvedAt: t.resolvedAt,
    closedAt: t.closedAt,
    resolutionSummary: t.resolutionSummary,
    canReply: !["cancelled"].includes(t.status),
    canRate: ["resolved", "closed"].includes(t.status),
    feedback: row.feedback ? { rating: row.feedback.rating, comment: row.feedback.comment, at: row.feedback.updatedAt } : null,
    messages,
    looseAttachments: (byMessage.get(null) ?? []).map(({ id, fileName, sizeBytes, contentType }) => ({ id, fileName, sizeBytes, contentType })),
  };
}

/** Bytes for the portal download route; null unless the attachment is on a ticket the account may see and is customer-visible. */
export async function portalAttachment(account: PortalAccount, attachmentId: string) {
  const [a] = await db
    .select({ a: ticketAttachments })
    .from(ticketAttachments)
    .innerJoin(tickets, eq(tickets.id, ticketAttachments.ticketId))
    .where(and(eq(ticketAttachments.id, attachmentId), eq(ticketAttachments.restricted, false), inArray(ticketAttachments.scanStatus, ["clean", "skipped"]), visibleTo(account)))
    .limit(1);
  return a?.a ?? null;
}

export type PortalUpload = { name: string; type: string; bytes: Buffer };

async function storePortalUploads(ticketId: string, messageId: string | null, files: PortalUpload[]) {
  const stored: string[] = [];
  const refused: { fileName: string; error: string }[] = [];
  for (const f of files) {
    const policy = checkAttachmentPolicy(f.name, f.bytes.length);
    if (policy || !f.bytes.length) {
      refused.push({ fileName: f.name, error: policy ?? "empty file" });
      continue;
    }
    const scan = await scanBytes(f.bytes);
    const id = randomUUID();
    const rel = await storeAttachmentBytes("portal", id, f.bytes);
    await db.insert(ticketAttachments).values({ id, ticketId, messageId, fileName: f.name.split(/[\\/]/).pop()?.slice(0, 200) || "file", contentType: f.type || "application/octet-stream", sizeBytes: f.bytes.length, sha256: sha256(f.bytes), storagePath: rel, scanStatus: scan.status, scanDetail: scan.detail, restricted: false });
    if (scan.status === "blocked") refused.push({ fileName: f.name, error: `blocked by the virus scanner` });
    else stored.push(id);
  }
  return { stored, refused };
}

export async function portalCreateTicket(account: PortalAccount, input: { subject: string; description: string; priority?: TicketPriority }, files: PortalUpload[] = []) {
  const subject = input.subject.trim().slice(0, 300);
  const description = input.description.trim();
  if (!subject) throw new ActionError("Give the request a subject.");
  if (!description) throw new ActionError("Describe the problem or request.");
  const priority = input.priority && (TICKET_PRIORITIES as readonly string[]).includes(input.priority) && input.priority !== "critical" ? input.priority : "normal";
  const id = await createTicket(
    { subject, description, priority, type: "incident", categoryId: null, subcategoryId: null, tags: [], requesterContactId: account.contactId, requesterName: account.name, requesterEmail: account.email, companyId: account.companyId, assigneeUserId: null, teamId: null, customFields: {} },
    PORTAL_ACTOR,
    {
      source: "portal",
      initialMessage: { kind: "public", channel: "portal", direction: "inbound", fromName: account.name, fromEmail: account.email, subject, bodyMarkdown: description, bodyText: markdownToPlainText(description), metadata: { initial: true, portalAccountId: account.id } },
    },
  );
  const [created] = await db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, id)).limit(1);
  const [first] = await db.select({ id: ticketMessages.id }).from(ticketMessages).where(eq(ticketMessages.ticketId, id)).orderBy(asc(ticketMessages.at)).limit(1);
  const uploads = files.length ? await storePortalUploads(id, first?.id ?? null, files) : { stored: [], refused: [] };
  await db.update(tickets).set({ lastCustomerMessageAt: new Date() }).where(eq(tickets.id, id));
  const reference = ticketReference(created.number);
  await notifyUsers(await ticketAudience(id), { kind: "customer_replied", title: `${reference}: new portal request from ${account.name}`, body: description.slice(0, 300), ticketId: id });
  return { id, reference, refused: uploads.refused };
}

/** A customer reply: public inbound message, same status effects as an inbound e-mail. */
export async function portalReply(account: PortalAccount, ticketId: string, body: string, files: PortalUpload[] = []) {
  const text = body.trim();
  if (!text) throw new ActionError("Write a message first.");
  if (text.length > 50_000) throw new ActionError("That message is too long.");
  const [t] = await db.select().from(tickets).where(and(eq(tickets.id, ticketId), visibleTo(account))).limit(1);
  if (!t) throw new ActionError("Ticket not found.");
  if (t.status === "cancelled") throw new ActionError("This request was cancelled; open a new one instead.");
  const now = new Date();
  const messageId = await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(ticketMessages)
      .values({ ticketId, kind: "public", channel: "portal", direction: "inbound", at: now, fromName: account.name, fromEmail: account.email, subject: t.subject, bodyMarkdown: text, bodyText: markdownToPlainText(text), deliveryStatus: "not_applicable", metadata: { portalAccountId: account.id } })
      .returning({ id: ticketMessages.id });
    await tx.update(tickets).set({ lastCustomerMessageAt: now, lastActivityAt: now, updatedAt: now }).where(eq(tickets.id, ticketId));
    if (t.requesterContactId !== account.contactId)
      await tx.insert(ticketParticipants).values({ ticketId, role: "cc", name: account.name, email: account.email, normalizedEmail: account.email, contactId: account.contactId }).onConflictDoNothing();
    await recordEvent(ticketId, "message", `Portal reply from ${account.name}`, PORTAL_ACTOR, { messageId: m.id }, tx);
    if (t.companyId)
      await logActivity({ type: "ticket", companyId: t.companyId, contactId: account.contactId, entityType: "ticket_message", entityId: m.id, title: `Ticket ${ticketReference(t.number)}: portal reply from ${account.name}`, body: text.slice(0, 300), source: "portal" }, tx);
    return m.id;
  });
  const uploads = files.length ? await storePortalUploads(ticketId, messageId, files) : { stored: [], refused: [] };
  if (["resolved", "closed", "awaiting_customer"].includes(t.status)) await changeStatus(ticketId, "open", PORTAL_ACTOR, { reason: "customer replied in the portal" });
  await notifyUsers(await ticketAudience(ticketId), { kind: "customer_replied", title: `${ticketReference(t.number)}: portal reply from ${account.name}`, body: text.slice(0, 300), ticketId, messageId });
  await afterTicketChange(ticketId, "customer_replied", PORTAL_ACTOR, "customer replied in the portal").catch((err) => logger.warn({ err }, "portal reply hooks failed"));
  return { messageId, refused: uploads.refused };
}

export async function portalSubmitFeedback(account: PortalAccount, ticketId: string, rating: number, comment: string | null) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new ActionError("Choose a rating from 1 to 5.");
  const [t] = await db.select({ id: tickets.id, status: tickets.status, number: tickets.number, assigneeUserId: tickets.assigneeUserId, companyId: tickets.companyId }).from(tickets).where(and(eq(tickets.id, ticketId), visibleTo(account))).limit(1);
  if (!t) throw new ActionError("Ticket not found.");
  if (!["resolved", "closed"].includes(t.status)) throw new ActionError("You can rate a request once it is resolved.");
  const text = comment?.trim().slice(0, 2000) || null;
  await db
    .insert(ticketFeedback)
    .values({ ticketId, accountId: account.id, rating, comment: text })
    .onConflictDoUpdate({ target: ticketFeedback.ticketId, set: { rating, comment: text, accountId: account.id, updatedAt: new Date() } });
  await recordEvent(ticketId, "feedback", `Customer rated this ${rating}/5${text ? ": " + text.slice(0, 120) : ""}`, PORTAL_ACTOR, { rating });
  await notifyUsers([t.assigneeUserId], { kind: "followed_update", title: `${ticketReference(t.number)}: rated ${rating}/5 by ${account.name}`, body: text, ticketId });
}

// ---------------------------------------------------------------------------
// Customer side: knowledge base (published and customer-visible only)
// ---------------------------------------------------------------------------
export async function portalKbList(p: { q?: string | null; category?: string | null } = {}) {
  const rows = await db
    .select({ id: kbArticles.id, slug: kbArticles.slug, title: kbArticles.title, summary: kbArticles.summary, body: kbArticles.body, category: kbArticles.category, tags: kbArticles.tags, updatedAt: kbArticles.updatedAt })
    .from(kbArticles)
    .where(and(eq(kbArticles.status, "published"), eq(kbArticles.customerVisible, true), p.category ? eq(kbArticles.category, p.category) : undefined, p.q ? or(ilike(kbArticles.title, `%${p.q}%`), ilike(kbArticles.body, `%${p.q}%`), ilike(kbArticles.summary, `%${p.q}%`)) : undefined))
    .orderBy(asc(kbArticles.category), asc(kbArticles.title))
    .limit(200);
  return rows.map(({ body, ...r }) => ({ ...r, excerpt: r.summary ?? markdownExcerpt(body, 160) }));
}

export async function portalKbArticle(slug: string) {
  const [a] = await db.select().from(kbArticles).where(and(eq(kbArticles.slug, slug), eq(kbArticles.status, "published"), eq(kbArticles.customerVisible, true))).limit(1);
  if (!a) return null;
  await db.update(kbArticles).set({ viewCount: sql`${kbArticles.viewCount} + 1` }).where(eq(kbArticles.id, a.id)).catch(() => undefined);
  return { id: a.id, slug: a.slug, title: a.title, summary: a.summary, body: a.body, category: a.category, tags: a.tags, updatedAt: a.updatedAt };
}

export async function portalKbCategories() {
  const rows = await db.select({ category: kbArticles.category, n: sql<number>`count(*)`.mapWith(Number) }).from(kbArticles).where(and(eq(kbArticles.status, "published"), eq(kbArticles.customerVisible, true), sql`${kbArticles.category} is not null`)).groupBy(kbArticles.category).orderBy(asc(kbArticles.category));
  return rows.map((r) => ({ category: r.category!, n: r.n }));
}
