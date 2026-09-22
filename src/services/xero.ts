import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { companies, contractLines, contracts, invoiceDrafts, opportunityLines, opportunities, xeroContacts, xeroInvoices, xeroPayments, type InvoiceDraftLine } from "@/db/schema";
import { audit, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { getAppSettings } from "@/lib/settings";
import { extractDomain, normalizeCompanyName } from "@/lib/utils";
import { getXeroClient, type XeroConfig, type XeroCredentials } from "@/connectors/xero";
import { buildAuthorizeUrl, exchangeCode, listTenants, xeroAppConfig, xeroDate, xeroDateOnly } from "@/connectors/xero/live";
import type { XeroContactRaw, XeroInvoiceRaw, XeroPaymentRaw } from "@/connectors/xero/types";
import { createLink, getConnection, getCredentials, getLink, getLinkByExternal, listLinks, markEventProcessed, raiseConflict, recordInboundEvent, runOutbound, runSync, setConnectionConfig, setCredentials, updateConnection } from "./integrations";
import { monthlyValue } from "@/lib/money";

// ---------------------------------------------------------------------------
// OAuth connect / tenant selection
// ---------------------------------------------------------------------------
export function xeroAppConfigured() {
  return Boolean(xeroAppConfig());
}

export async function startXeroConnect(actorUserId: string) {
  const app = xeroAppConfig();
  if (!app) throw new ActionError("XERO_CLIENT_ID and XERO_CLIENT_SECRET are not set on the server. Add them to .env and restart.");
  const state = randomBytes(24).toString("base64url");
  await setConnectionConfig("xero", { oauthState: state, oauthStateExpires: Date.now() + 10 * 60_000 }, actorUserId);
  await audit({ actorUserId, action: "integration.oauth.start", entityType: "integration", entityId: "xero" });
  return buildAuthorizeUrl(app, state);
}

/** Handles the OAuth callback: validates state, exchanges the code, stores tokens, lists tenants for explicit selection. */
export async function completeXeroConnect(code: string, state: string) {
  const app = xeroAppConfig();
  if (!app) throw new ActionError("Xero app credentials are not configured.");
  const conn = await getConnection("xero");
  const cfg = conn.config as XeroConfig;
  if (!cfg.oauthState || cfg.oauthState !== state || !cfg.oauthStateExpires || cfg.oauthStateExpires < Date.now()) throw new ActionError("The sign-in link has expired or was tampered with. Start again from the Integrations page.");
  const tokens = await exchangeCode(app, code);
  const tenants = await listTenants(tokens.accessToken);
  const orgs = tenants.filter((t) => t.tenantType === "ORGANISATION").map((t) => ({ tenantId: t.tenantId, tenantName: t.tenantName }));
  if (orgs.length === 0) throw new ActionError("No Xero organisation was authorised. Reconnect and choose an organisation.");
  // Keep the previously selected tenant only if it is still authorised.
  const keep = cfg.tenantId && orgs.some((o) => o.tenantId === cfg.tenantId) ? cfg.tenantId : undefined;
  await setCredentials("xero", { ...tokens, tenantId: keep }, null, { status: keep ? "connected" : "not_configured", lastError: null, consecutiveFailures: 0, pausedUntil: null });
  await db.update(db._.fullSchema.integrationConnections).set({ config: { ...cfg, oauthState: undefined, oauthStateExpires: undefined, pendingTenants: orgs, tenantId: keep, tenantName: keep ? orgs.find((o) => o.tenantId === keep)?.tenantName : undefined } }).where(eq(db._.fullSchema.integrationConnections.provider, "xero"));
  return { tenants: orgs, selected: keep ?? null };
}

export async function selectXeroTenant(tenantId: string, actorUserId: string) {
  const conn = await getConnection("xero");
  const cfg = conn.config as XeroConfig;
  const tenant = cfg.pendingTenants?.find((t) => t.tenantId === tenantId);
  if (!tenant) throw new ActionError("That organisation is not in the list returned by Xero. Reconnect first.");
  const creds = await getCredentials<XeroCredentials>("xero");
  if (!creds?.refreshToken) throw new ActionError("Connect to Xero first.");
  await setCredentials("xero", { ...creds, tenantId }, actorUserId, { status: "connected" });
  await setConnectionConfig("xero", { tenantId, tenantName: tenant.tenantName }, actorUserId);
  const resolved = await getXeroClient();
  const test = await resolved!.client.testConnection();
  if (!test.ok) throw new ActionError(`Connected, but the organisation could not be read: ${test.error}`);
  await updateConnection("xero", { status: "connected", externalAccountName: test.organisationName, externalAccountId: test.organisationId, lastTestedAt: new Date(), lastError: null });
  await audit({ actorUserId, action: "integration.tenant.select", entityType: "integration", entityId: "xero", details: { tenantId, tenantName: tenant.tenantName } });
  return test;
}

export async function testXero(actorUserId: string) {
  const resolved = await getXeroClient();
  if (!resolved) throw new ActionError("Xero is not configured.");
  const test = await resolved.client.testConnection();
  if (resolved.mode === "live") await updateConnection("xero", test.ok ? { status: "connected", externalAccountName: test.organisationName, externalAccountId: test.organisationId, lastTestedAt: new Date(), lastError: null } : { status: "error", lastTestedAt: new Date(), lastError: test.error });
  await audit({ actorUserId, action: "integration.test", entityType: "integration", entityId: "xero", details: { ok: test.ok, mode: resolved.mode } });
  return { ...test, mode: resolved.mode };
}

export async function xeroConnectionSummary() {
  const conn = await getConnection("xero");
  const resolved = await getXeroClient();
  const cfg = (conn.config ?? {}) as XeroConfig;
  return { ...conn, credentialsEnc: undefined, config: cfg, mode: resolved?.mode ?? null, configured: Boolean(resolved), demo: resolved?.mode === "demo", appConfigured: xeroAppConfigured(), needsTenant: Boolean(cfg.pendingTenants?.length && !cfg.tenantId) };
}

export async function xeroReferenceData() {
  const resolved = await getXeroClient();
  if (!resolved) return null;
  const [accounts, taxRates, themes] = await Promise.all([resolved.client.listAccounts(), resolved.client.listTaxRates(), resolved.client.listBrandingThemes()]);
  return { accounts: accounts.filter((a) => a.Class === "REVENUE" || a.Type === "REVENUE" || a.Type === "SALES" || a.Type === "OTHERINCOME"), taxRates: taxRates.filter((t) => t.CanApplyToRevenue !== false), themes, mode: resolved.mode };
}

// ---------------------------------------------------------------------------
// Sync: contacts, invoices, payments (incremental with If-Modified-Since)
// ---------------------------------------------------------------------------
const OVERLAP_MS = 10 * 60_000;

export async function syncXero(trigger: "schedule" | "manual" | "webhook", actorUserId?: string | null, opts?: { full?: boolean }) {
  const resolved = await getXeroClient();
  if (!resolved) return null;
  const conn = await getConnection("xero");
  const since = opts?.full || !conn.lastSuccessfulSyncAt ? undefined : new Date(conn.lastSuccessfulSyncAt.getTime() - OVERLAP_MS);
  return runSync(
    "xero",
    opts?.full ? "xero.reconcile" : "xero.sync",
    trigger,
    async ({ counters, fail }) => {
      // Contacts
      for (let page = 1; page <= 500; page++) {
        const batch = await resolved.client.listContacts({ page, ifModifiedSince: since, includeArchived: true });
        for (const c of batch) {
          try {
            counters.fetched++;
            const r = await upsertContact(c);
            if (r === "created") counters.created++;
            else if (r === "updated") counters.updated++;
            else counters.skipped++;
          } catch (err) {
            await fail(err instanceof Error ? err.message : String(err), { externalId: c.ContactID });
          }
        }
        if (batch.length < 100) break;
      }
      // Invoices (sales only)
      for (let page = 1; page <= 500; page++) {
        const batch = await resolved.client.listInvoices({ page, ifModifiedSince: since });
        for (const inv of batch) {
          if (inv.Type !== "ACCREC") continue;
          try {
            counters.fetched++;
            const r = await upsertInvoice(inv);
            if (r === "created") counters.created++;
            else if (r === "updated") counters.updated++;
            else counters.skipped++;
          } catch (err) {
            await fail(err instanceof Error ? err.message : String(err), { externalId: inv.InvoiceID });
          }
        }
        if (batch.length < 100) break;
      }
      // Payments
      for (let page = 1; page <= 500; page++) {
        const batch = await resolved.client.listPayments({ page, ifModifiedSince: since });
        for (const p of batch) {
          try {
            await upsertPayment(p);
          } catch (err) {
            await fail(err instanceof Error ? err.message : String(err), { externalId: p.PaymentID });
          }
        }
        if (batch.length < 100) break;
      }
      await detectArchivedLinks();
      return `${since ? `Changes since ${since.toISOString()}` : "Full reconciliation"}${resolved.mode === "demo" ? " (DEMO data)" : ""}`;
    },
    actorUserId,
  );
}

async function upsertContact(c: XeroContactRaw): Promise<"created" | "updated" | "unchanged"> {
  const [existing] = await db.select().from(xeroContacts).where(eq(xeroContacts.contactId, c.ContactID)).limit(1);
  const updated = xeroDate(c.UpdatedDateUTC);
  const values = {
    contactId: c.ContactID,
    name: c.Name,
    normalizedName: normalizeCompanyName(c.Name),
    firstName: c.FirstName ?? null,
    lastName: c.LastName ?? null,
    emailAddress: c.EmailAddress?.toLowerCase() ?? null,
    emailDomain: extractDomain(c.EmailAddress),
    taxNumber: c.TaxNumber ?? null,
    companyNumber: c.CompanyNumber ?? null,
    accountNumber: c.AccountNumber ?? null,
    contactStatus: c.ContactStatus ?? null,
    isCustomer: Boolean(c.IsCustomer),
    isSupplier: Boolean(c.IsSupplier),
    phones: (c.Phones ?? []).map((p) => ({ type: p.PhoneType, number: p.PhoneNumber ?? null, areaCode: p.PhoneAreaCode ?? null, countryCode: p.PhoneCountryCode ?? null })),
    addresses: (c.Addresses ?? []) as Record<string, unknown>[],
    outstanding: c.Balances?.AccountsReceivable?.Outstanding != null ? String(c.Balances.AccountsReceivable.Outstanding) : null,
    overdue: c.Balances?.AccountsReceivable?.Overdue != null ? String(c.Balances.AccountsReceivable.Overdue) : null,
    updatedDateUtc: updated,
    raw: c as Record<string, unknown>,
    fetchedAt: new Date(),
    updatedAt: new Date(),
  };
  if (!existing) {
    await db.insert(xeroContacts).values(values);
    return "created";
  }
  const changed = existing.updatedDateUtc?.getTime() !== updated?.getTime() || existing.outstanding !== values.outstanding || existing.overdue !== values.overdue;
  await db.update(xeroContacts).set(changed ? values : { fetchedAt: new Date() }).where(eq(xeroContacts.id, existing.id));
  return changed ? "updated" : "unchanged";
}

async function upsertInvoice(inv: XeroInvoiceRaw): Promise<"created" | "updated" | "unchanged"> {
  const [existing] = await db.select().from(xeroInvoices).where(eq(xeroInvoices.invoiceId, inv.InvoiceID)).limit(1);
  const contactId = inv.Contact?.ContactID ?? null;
  const link = contactId ? await getLinkByExternal("xero", "company", contactId) : null;
  const updated = xeroDate(inv.UpdatedDateUTC);
  const values = {
    invoiceId: inv.InvoiceID,
    invoiceNumber: inv.InvoiceNumber ?? null,
    reference: inv.Reference ?? null,
    type: inv.Type,
    status: inv.Status,
    contactId,
    companyId: link?.localId ?? existing?.companyId ?? null,
    date: xeroDateOnly(inv.Date, inv.DateString),
    dueDate: xeroDateOnly(inv.DueDate, inv.DueDateString),
    currencyCode: inv.CurrencyCode ?? null,
    subTotal: num(inv.SubTotal),
    totalTax: num(inv.TotalTax),
    total: num(inv.Total),
    amountDue: num(inv.AmountDue),
    amountPaid: num(inv.AmountPaid),
    amountCredited: num(inv.AmountCredited),
    fullyPaidOnDate: xeroDateOnly(inv.FullyPaidOnDate),
    sentToContact: inv.SentToContact ?? null,
    lineItems: (inv.LineItems ?? []) as Record<string, unknown>[],
    updatedDateUtc: updated,
    raw: inv as Record<string, unknown>,
    fetchedAt: new Date(),
    updatedAt: new Date(),
  };
  if (!existing) {
    await db.insert(xeroInvoices).values(values);
    if (values.companyId) await logActivity({ type: "invoice", companyId: values.companyId, entityType: "xero_invoice", entityId: inv.InvoiceID, title: `Invoice ${inv.InvoiceNumber ?? inv.InvoiceID} ${inv.Status.toLowerCase()} in Xero (${fmt(values.total, values.currencyCode)})`, source: "xero" });
    await linkDraftIfMatching(inv);
    return "created";
  }
  const changed = existing.updatedDateUtc?.getTime() !== updated?.getTime() || existing.status !== inv.Status || existing.amountDue !== values.amountDue || existing.companyId !== values.companyId;
  await db.update(xeroInvoices).set(changed ? values : { fetchedAt: new Date() }).where(eq(xeroInvoices.id, existing.id));
  if (existing.status !== inv.Status || existing.amountPaid !== values.amountPaid) {
    const evId = await recordInboundEvent("xero", `invoice:${inv.InvoiceID}:${inv.Status}:${values.amountPaid ?? 0}`, `invoice.${inv.Status.toLowerCase()}`, { from: existing.status, to: inv.Status }, inv.InvoiceID);
    if (evId) {
      if (values.companyId) {
        const title = inv.Status === "PAID" ? `Invoice ${inv.InvoiceNumber} paid in full` : existing.status !== inv.Status ? `Invoice ${inv.InvoiceNumber} ${inv.Status.toLowerCase()}` : `Payment received on invoice ${inv.InvoiceNumber} (${fmt(values.amountPaid, values.currencyCode)} paid)`;
        await logActivity({ type: "invoice", companyId: values.companyId, entityType: "xero_invoice", entityId: inv.InvoiceID, title, source: "xero" });
      }
      await markEventProcessed(evId);
    }
  }
  return changed ? "updated" : "unchanged";
}

async function upsertPayment(p: XeroPaymentRaw) {
  await db
    .insert(xeroPayments)
    .values({ paymentId: p.PaymentID, invoiceId: p.Invoice?.InvoiceID ?? null, date: xeroDateOnly(p.Date), amount: num(p.Amount), reference: p.Reference ?? null, status: p.Status ?? null, paymentType: p.PaymentType ?? null, isReconciled: p.IsReconciled ?? null, updatedDateUtc: xeroDate(p.UpdatedDateUTC), raw: p as Record<string, unknown>, fetchedAt: new Date() })
    .onConflictDoUpdate({ target: xeroPayments.paymentId, set: { amount: num(p.Amount), status: p.Status ?? null, isReconciled: p.IsReconciled ?? null, updatedDateUtc: xeroDate(p.UpdatedDateUTC), raw: p as Record<string, unknown>, fetchedAt: new Date() } });
}

/** A draft we created may have been created but the response lost: match by Reference. */
async function linkDraftIfMatching(inv: XeroInvoiceRaw) {
  if (!inv.Reference?.startsWith("CRM-")) return;
  await db.update(invoiceDrafts).set({ xeroInvoiceId: inv.InvoiceID, xeroInvoiceNumber: inv.InvoiceNumber ?? null, status: "created", createdInXeroAt: new Date(), updatedAt: new Date() }).where(and(eq(invoiceDrafts.reference, inv.Reference), isNull(invoiceDrafts.xeroInvoiceId)));
}

/** Policy for archived/deleted contacts: keep the link, mark it, raise a review item. */
async function detectArchivedLinks() {
  const links = await listLinks("xero", "company");
  for (const l of links) {
    const [c] = await db.select({ status: xeroContacts.contactStatus, name: xeroContacts.name }).from(xeroContacts).where(eq(xeroContacts.contactId, l.externalId)).limit(1);
    const archived = c?.status === "ARCHIVED" || c?.status === "GDPRREQUEST";
    if (archived && l.externalStatus === "active") {
      await db.update(db._.fullSchema.externalLinks).set({ externalStatus: "archived", updatedAt: new Date() }).where(eq(db._.fullSchema.externalLinks.id, l.id));
      await raiseConflict({ provider: "xero", entityType: "company", localId: l.localId, externalId: l.externalId, kind: "external_deleted", message: `Xero contact "${c?.name ?? l.externalId}" was archived in Xero but is still linked to a CRM company. Decide whether to unlink or re-map.` });
    } else if (!archived && l.externalStatus === "archived" && c) {
      await db.update(db._.fullSchema.externalLinks).set({ externalStatus: "active", updatedAt: new Date() }).where(eq(db._.fullSchema.externalLinks.id, l.id));
    }
  }
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------
export type XeroWebhookEvent = { resourceUrl?: string; resourceId: string; eventDateUtc: string; eventType: string; eventCategory: string; tenantId: string; tenantType?: string };

/** Records webhook events (idempotent) for the worker to process. Must be fast: no API calls here. */
export async function recordXeroWebhookEvents(events: XeroWebhookEvent[]) {
  let recorded = 0;
  for (const e of events) {
    const id = await recordInboundEvent("xero", `${e.eventCategory}:${e.resourceId}:${e.eventDateUtc}:${e.eventType}`, `${e.eventCategory}.${e.eventType}`.toLowerCase(), e as unknown as Record<string, unknown>, e.resourceId);
    if (id) recorded++;
  }
  const conn = await getConnection("xero");
  const cfg = conn.config as XeroConfig;
  await updateConnection("xero", { config: { ...cfg, lastWebhookAt: new Date().toISOString(), webhookEvents: (cfg.webhookEvents ?? 0) + recorded } });
  return recorded;
}

/** Processes unprocessed webhook events by fetching the changed resource. */
export async function processXeroInboundEvents() {
  const resolved = await getXeroClient();
  if (!resolved) return { processed: 0 };
  const { inboundEvents } = db._.fullSchema;
  const pending = await db.select().from(inboundEvents).where(and(eq(inboundEvents.provider, "xero"), isNull(inboundEvents.processedAt), or(eq(inboundEvents.eventType, "contact.update"), eq(inboundEvents.eventType, "contact.create"), eq(inboundEvents.eventType, "invoice.update"), eq(inboundEvents.eventType, "invoice.create")))).orderBy(inboundEvents.receivedAt).limit(200);
  if (!pending.length) return { processed: 0 };
  let processed = 0;
  await runSync("xero", "xero.webhook", "webhook", async ({ counters, fail }) => {
    for (const ev of pending) {
      try {
        counters.fetched++;
        if (ev.eventType.startsWith("contact") && ev.externalId) {
          const c = await resolved.client.getContact(ev.externalId);
          if (c) await upsertContact(c);
        } else if (ev.externalId) {
          const inv = await resolved.client.getInvoice(ev.externalId);
          if (inv && inv.Type === "ACCREC") await upsertInvoice(inv);
        }
        await markEventProcessed(ev.id);
        processed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await markEventProcessed(ev.id, msg);
        await fail(msg, { externalId: ev.externalId ?? undefined });
      }
    }
    return `${processed} webhook events applied`;
  });
  return { processed };
}

// ---------------------------------------------------------------------------
// Mapping: CRM companies ↔ Xero contacts
// ---------------------------------------------------------------------------
export type XeroMatch = { contactId: string; name: string; emailAddress: string | null; reason: "linked" | "company_number" | "tax_number" | "domain" | "exact_name" | "similar_name"; confidence: "linked" | "high" | "medium" | "low" };

export async function suggestXeroContacts(company: { id: string; name: string; companyNumber: string | null; vatNumber: string | null; domain: string | null; email: string | null }): Promise<XeroMatch[]> {
  const out = new Map<string, XeroMatch>();
  const add = (rows: { contactId: string; name: string; emailAddress: string | null }[], reason: XeroMatch["reason"], confidence: XeroMatch["confidence"]) => {
    for (const r of rows) if (!out.has(r.contactId)) out.set(r.contactId, { ...r, reason, confidence });
  };
  const sel = { contactId: xeroContacts.contactId, name: xeroContacts.name, emailAddress: xeroContacts.emailAddress };
  const active = eq(xeroContacts.contactStatus, "ACTIVE");
  const link = await getLink("xero", "company", company.id);
  if (link) add(await db.select(sel).from(xeroContacts).where(eq(xeroContacts.contactId, link.externalId)), "linked", "linked");
  if (company.companyNumber) add(await db.select(sel).from(xeroContacts).where(and(active, eq(xeroContacts.companyNumber, company.companyNumber))), "company_number", "high");
  if (company.vatNumber) add(await db.select(sel).from(xeroContacts).where(and(active, sql`replace(upper(${xeroContacts.taxNumber}), ' ', '') = ${company.vatNumber.replace(/\s/g, "").toUpperCase()}`)), "tax_number", "high");
  const domain = company.domain ?? extractDomain(company.email);
  if (domain) add(await db.select(sel).from(xeroContacts).where(and(active, eq(xeroContacts.emailDomain, domain))), "domain", "high");
  const norm = normalizeCompanyName(company.name);
  if (norm) {
    add(await db.select(sel).from(xeroContacts).where(and(active, eq(xeroContacts.normalizedName, norm))), "exact_name", "medium");
    add(await db.select(sel).from(xeroContacts).where(and(active, sql`similarity(${xeroContacts.normalizedName}, ${norm}) > 0.5`)).limit(5), "similar_name", "low");
  }
  return [...out.values()];
}

export async function mappingOverview() {
  const rows = await db.select({ id: companies.id, name: companies.name, status: companies.status, companyNumber: companies.companyNumber, vatNumber: companies.vatNumber, domain: companies.domain, email: companies.email }).from(companies).where(and(isNull(companies.archivedAt), inArray(companies.status, ["customer", "prospect"]))).orderBy(sql`case when ${companies.status} = 'customer' then 0 else 1 end`, companies.name);
  const links = await listLinks("xero", "company");
  const byLocal = new Map(links.map((l) => [l.localId, l]));
  const linkedExternal = new Set(links.map((l) => l.externalId));
  const out = [];
  for (const c of rows) {
    const link = byLocal.get(c.id) ?? null;
    const suggestions = link ? [] : (await suggestXeroContacts(c)).filter((s) => !linkedExternal.has(s.contactId));
    out.push({ ...c, link, suggestions });
  }
  const [{ total }] = await db.select({ total: sql<number>`count(*)`.mapWith(Number) }).from(xeroContacts).where(and(eq(xeroContacts.contactStatus, "ACTIVE"), eq(xeroContacts.isCustomer, true)));
  return { companies: out, xeroCustomerCount: total, linkedCount: links.length };
}

export async function searchXeroContacts(q: string) {
  const term = `%${q}%`;
  return db.select({ contactId: xeroContacts.contactId, name: xeroContacts.name, emailAddress: xeroContacts.emailAddress, contactStatus: xeroContacts.contactStatus }).from(xeroContacts).where(or(sql`${xeroContacts.name} ilike ${term}`, sql`${xeroContacts.emailAddress} ilike ${term}`)).orderBy(xeroContacts.name).limit(20);
}

export async function linkCompanyToXeroContact(companyId: string, contactId: string, actorUserId: string) {
  const [c] = await db.select({ name: xeroContacts.name }).from(xeroContacts).where(eq(xeroContacts.contactId, contactId)).limit(1);
  if (!c) throw new ActionError("That Xero contact is not in the mirror. Run a sync first.");
  await createLink({ provider: "xero", entityType: "company", localId: companyId, externalId: contactId, externalName: c.name, source: "manual" }, actorUserId);
  // Attach already-mirrored invoices for this contact.
  await db.update(xeroInvoices).set({ companyId }).where(and(eq(xeroInvoices.contactId, contactId), isNull(xeroInvoices.companyId)));
  await logActivity({ type: "sync", companyId, title: `Linked to Xero contact "${c.name}"`, actorUserId, source: "xero" });
}

/** Creates a Xero contact from CRM data (once per company) and links it. */
export async function createXeroContactForCompany(companyId: string, actorUserId: string) {
  const resolved = await getXeroClient();
  if (!resolved) throw new ActionError("Xero is not connected.");
  const [co] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!co) throw new ActionError("Company not found.");
  const existing = await getLink("xero", "company", companyId);
  if (existing) return existing.externalId;
  const dupes = (await suggestXeroContacts({ id: co.id, name: co.name, companyNumber: co.companyNumber, vatNumber: co.vatNumber, domain: co.domain, email: co.email })).filter((s) => s.confidence === "high" || s.confidence === "medium");
  if (dupes.length) throw new ActionError(`Xero already has a contact that looks like this company (${dupes[0].name}). Link it instead of creating a duplicate.`);
  const { result } = await runOutbound("xero", `xero:contact:${companyId}`, "contact.create", actorUserId, {
    requestSummary: { name: co.name },
    perform: async () => {
      const created = await resolved.client.createContact({ name: co.name, emailAddress: co.email, taxNumber: co.vatNumber, companyNumber: co.companyNumber, phone: co.phone, address: co.addressLine1 ? { AddressType: "POBOX", AddressLine1: co.addressLine1, AddressLine2: co.addressLine2 ?? undefined, City: co.city ?? undefined, Region: co.region ?? undefined, PostalCode: co.postcode ?? undefined, Country: co.country ?? undefined } : null }, `xero:contact:${companyId}`);
      return { externalId: created.ContactID, summary: { name: created.Name } };
    },
    reconcile: async () => {
      const hits = await resolved.client.listContacts({ page: 1, searchTerm: co.name });
      const hit = hits.find((h) => normalizeCompanyName(h.Name) === normalizeCompanyName(co.name));
      return hit ? { externalId: hit.ContactID, summary: { name: hit.Name, reconciled: true } } : null;
    },
  });
  const fetched = await resolved.client.getContact(result.externalId);
  if (fetched) await upsertContact(fetched);
  await createLink({ provider: "xero", entityType: "company", localId: companyId, externalId: result.externalId, externalName: co.name, source: "created_by_crm" }, actorUserId);
  await logActivity({ type: "sync", companyId, title: `Created Xero contact "${co.name}"${resolved.mode === "demo" ? " (DEMO)" : ""}`, actorUserId, source: "xero" });
  return result.externalId;
}

/**
 * Field ownership: Xero owns legal name, addresses, tax number, balances.
 * The CRM may push email/phone only on explicit request, and refuses when
 * Xero's copy changed after our last sync and differs (raises a conflict).
 */
export async function pushContactDetailsToXero(companyId: string, actorUserId: string) {
  const resolved = await getXeroClient();
  if (!resolved) throw new ActionError("Xero is not connected.");
  const link = await getLink("xero", "company", companyId);
  if (!link) throw new ActionError("This company is not linked to a Xero contact.");
  const [co] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const [mirror] = await db.select().from(xeroContacts).where(eq(xeroContacts.contactId, link.externalId)).limit(1);
  const live = await resolved.client.getContact(link.externalId);
  if (!live) throw new ActionError("The Xero contact no longer exists.");
  const liveUpdated = xeroDate(live.UpdatedDateUTC);
  const livePhone = live.Phones?.find((p) => p.PhoneType === "DEFAULT")?.PhoneNumber ?? null;
  const changedInXero = liveUpdated && mirror?.updatedDateUtc && liveUpdated > mirror.updatedDateUtc;
  const differs = (live.EmailAddress?.toLowerCase() ?? null) !== (co.email ?? null) || (livePhone ?? null) !== (co.phone ?? null);
  if (changedInXero && differs) {
    await raiseConflict({ provider: "xero", entityType: "company", localId: companyId, externalId: link.externalId, kind: "field_conflict", message: `Contact details for "${co.name}" were changed in Xero after the last sync (email ${live.EmailAddress ?? "—"}, phone ${livePhone ?? "—"}) and differ from the CRM (email ${co.email ?? "—"}, phone ${co.phone ?? "—"}). Decide which is right, then push again.` });
    await upsertContact(live);
    throw new ActionError("Xero has newer contact details that differ from the CRM. A review item was raised; nothing was overwritten.");
  }
  if (!differs) return { changed: false };
  await runOutbound("xero", `xero:contact-push:${companyId}:${Date.now()}`, "contact.update", actorUserId, {
    perform: async () => {
      const updated = await resolved.client.updateContact(link.externalId, { emailAddress: co.email, phone: co.phone }, `xero:contact-push:${companyId}:${Date.now()}`);
      await upsertContact(updated);
      return { externalId: updated.ContactID };
    },
  });
  await audit({ actorUserId, action: "xero.contact.push", entityType: "company", entityId: companyId, details: { email: co.email, phone: co.phone } });
  return { changed: true };
}

// ---------------------------------------------------------------------------
// Invoice drafts: prepare → approve → create in Xero (DRAFT) exactly once
// ---------------------------------------------------------------------------
function draftReference(id: string) {
  return `CRM-${id.slice(0, 8).toUpperCase()}`;
}

export async function prepareInvoiceDraft(input: { companyId: string; contractId?: string | null; opportunityId?: string | null; periodStart?: string | null; periodEnd?: string | null; description?: string | null }, actorUserId: string) {
  const conn = await getConnection("xero");
  const cfg = conn.config as XeroConfig;
  const settings = await getAppSettings();
  const accountCode = cfg.defaultAccountCode ?? "200";
  const taxType = cfg.defaultTaxType ?? "OUTPUT2";
  const lines: InvoiceDraftLine[] = [];
  let description = input.description ?? null;
  if (input.contractId) {
    const [c] = await db.select().from(contracts).where(eq(contracts.id, input.contractId)).limit(1);
    if (!c) throw new ActionError("Contract not found.");
    const cl = await db.select().from(contractLines).where(eq(contractLines.contractId, input.contractId)).orderBy(contractLines.sortOrder);
    const months = c.billingFrequency === "annual" ? 12 : c.billingFrequency === "quarterly" ? 3 : 1;
    for (const l of cl) {
      if (l.revenueType !== "recurring") continue;
      const perMonth = monthlyValue({ quantity: l.quantity, unitPrice: l.unitPrice, revenueType: l.revenueType, billingFrequency: l.billingFrequency });
      const unit = (perMonth * months) / Number(l.quantity || 1);
      lines.push({ description: `${l.description}${input.periodStart ? ` (${input.periodStart} to ${input.periodEnd ?? ""})` : ""}`, quantity: Number(l.quantity), unitAmount: round(unit), accountCode, taxType });
    }
    description ??= `${c.name} — ${c.billingFrequency} billing`;
  } else if (input.opportunityId) {
    const [o] = await db.select().from(opportunities).where(eq(opportunities.id, input.opportunityId)).limit(1);
    if (!o) throw new ActionError("Opportunity not found.");
    const ol = await db.select().from(opportunityLines).where(eq(opportunityLines.opportunityId, input.opportunityId)).orderBy(opportunityLines.sortOrder);
    for (const l of ol) {
      if (l.revenueType === "recurring") continue;
      lines.push({ description: l.description, quantity: Number(l.quantity), unitAmount: round(Number(l.unitPrice)), accountCode: l.revenueType === "hardware" ? (cfg.hardwareAccountCode ?? accountCode) : accountCode, taxType });
    }
    description ??= `${o.title} — one-off`;
  }
  if (!lines.length) throw new ActionError("Nothing to invoice: no recurring lines on the contract or no one-off lines on the opportunity.");
  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + (cfg.dueDays ?? 30) * 86400000).toISOString().slice(0, 10);
  const subTotal = lines.reduce((a, l) => a + l.quantity * l.unitAmount, 0);
  const id = await db.transaction(async (tx) => {
    const [row] = await tx.insert(invoiceDrafts).values({ companyId: input.companyId, contractId: input.contractId ?? null, opportunityId: input.opportunityId ?? null, reference: "pending", description, currencyCode: settings.currency, invoiceDate: today, dueDate: due, periodStart: input.periodStart ?? null, periodEnd: input.periodEnd ?? null, lines, subTotal: String(round(subTotal)), preparedByUserId: actorUserId }).returning({ id: invoiceDrafts.id });
    await tx.update(invoiceDrafts).set({ reference: draftReference(row.id) }).where(eq(invoiceDrafts.id, row.id));
    await audit({ actorUserId, action: "invoice.prepare", entityType: "invoice_draft", entityId: row.id, details: { companyId: input.companyId, lines: lines.length, subTotal } }, tx);
    return row.id;
  });
  return id;
}

export async function updateInvoiceDraft(id: string, patch: { invoiceDate: string; dueDate: string; description: string | null; lines: InvoiceDraftLine[]; notes: string | null }, actorUserId: string) {
  const [d] = await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, id)).limit(1);
  if (!d) throw new ActionError("Draft not found.");
  if (d.status !== "draft" && d.status !== "failed") throw new ActionError("Only unapproved drafts can be edited.");
  if (!patch.lines.length) throw new ActionError("Add at least one line.");
  const subTotal = patch.lines.reduce((a, l) => a + l.quantity * l.unitAmount, 0);
  await db.update(invoiceDrafts).set({ ...patch, subTotal: String(round(subTotal)), status: "draft", lastError: null, updatedAt: new Date() }).where(eq(invoiceDrafts.id, id));
  await audit({ actorUserId, action: "invoice.draft.update", entityType: "invoice_draft", entityId: id, details: { lines: patch.lines.length, subTotal } });
}

export async function cancelInvoiceDraft(id: string, actorUserId: string) {
  const [d] = await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, id)).limit(1);
  if (!d) throw new ActionError("Draft not found.");
  if (d.status === "created") throw new ActionError("This invoice already exists in Xero. Void it there if needed.");
  await db.update(invoiceDrafts).set({ status: "cancelled", updatedAt: new Date() }).where(eq(invoiceDrafts.id, id));
  await audit({ actorUserId, action: "invoice.draft.cancel", entityType: "invoice_draft", entityId: id });
}

/**
 * Approval by an authorised user creates the DRAFT invoice in Xero exactly
 * once (idempotency key = draft id; Xero also receives an Idempotency-Key).
 * On retry after a failure the draft is looked up by Reference first.
 */
export async function approveAndCreateInvoice(id: string, actorUserId: string) {
  const resolved = await getXeroClient();
  if (!resolved) throw new ActionError("Xero is not connected.");
  const [d] = await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, id)).limit(1);
  if (!d) throw new ActionError("Draft not found.");
  if (d.status === "created") return { invoiceId: d.xeroInvoiceId!, reused: true };
  if (d.status === "cancelled") throw new ActionError("This draft was cancelled.");
  if (!d.lines.length) throw new ActionError("The draft has no lines.");
  const link = await getLink("xero", "company", d.companyId);
  if (!link) throw new ActionError("Link this company to a Xero contact first (Integrations → Xero → Mapping).");
  const conn = await getConnection("xero");
  const cfg = conn.config as XeroConfig;
  await db.update(invoiceDrafts).set({ status: "approved", approvedByUserId: actorUserId, approvedAt: new Date(), updatedAt: new Date() }).where(eq(invoiceDrafts.id, id));
  await audit({ actorUserId, action: "invoice.approve", entityType: "invoice_draft", entityId: id, details: { reference: d.reference, subTotal: d.subTotal, currency: d.currencyCode } });
  try {
    const { result, reused } = await runOutbound("xero", `xero:invoice:${id}`, "invoice.create", actorUserId, {
      requestSummary: { reference: d.reference, contactId: link.externalId, lines: d.lines.length, subTotal: d.subTotal },
      perform: async () => {
        const inv = await resolved.client.createDraftInvoice({ contactId: link.externalId, reference: d.reference, date: d.invoiceDate, dueDate: d.dueDate, currencyCode: d.currencyCode, lineAmountTypes: d.lineAmountTypes as "Exclusive", brandingThemeId: cfg.brandingThemeId || undefined, url: `${process.env.APP_URL ?? ""}/finance/drafts/${id}`, lineItems: d.lines }, `xero:invoice:${id}`);
        await upsertInvoice(inv);
        return { externalId: inv.InvoiceID, summary: { invoiceNumber: inv.InvoiceNumber, total: inv.Total } as Record<string, unknown> };
      },
      reconcile: async () => {
        const hits = await resolved.client.listInvoices({ page: 1, where: `Reference=="${d.reference}"` });
        const hit = hits.find((h) => h.Status !== "DELETED" && h.Status !== "VOIDED");
        if (!hit) return null;
        await upsertInvoice(hit);
        return { externalId: hit.InvoiceID, summary: { invoiceNumber: hit.InvoiceNumber, reconciled: true } as Record<string, unknown> };
      },
    });
    const [mirror] = await db.select({ number: xeroInvoices.invoiceNumber }).from(xeroInvoices).where(eq(xeroInvoices.invoiceId, result.externalId)).limit(1);
    await db.update(invoiceDrafts).set({ status: "created", xeroInvoiceId: result.externalId, xeroInvoiceNumber: mirror?.number ?? (result.summary?.invoiceNumber as string | undefined) ?? null, createdInXeroAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(invoiceDrafts.id, id));
    await db.update(xeroInvoices).set({ companyId: d.companyId }).where(eq(xeroInvoices.invoiceId, result.externalId));
    await logActivity({ type: "invoice", companyId: d.companyId, entityType: "invoice_draft", entityId: id, title: `Draft invoice ${mirror?.number ?? ""} created in Xero${resolved.mode === "demo" ? " (DEMO)" : ""} — ${d.reference}, ${fmt(d.subTotal, d.currencyCode)} net`, actorUserId, source: "xero" });
    return { invoiceId: result.externalId, reused };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.update(invoiceDrafts).set({ status: "failed", lastError: msg.slice(0, 1000), updatedAt: new Date() }).where(eq(invoiceDrafts.id, id));
    throw new ActionError(`Xero did not accept the invoice: ${msg}. The draft is kept; fix and approve again.`);
  }
}

// ---------------------------------------------------------------------------
// Queries for Finance and company pages
// ---------------------------------------------------------------------------
export async function listXeroInvoices(p: { q?: string; status?: string; companyId?: string; overdueOnly?: boolean; page?: number; pageSize?: number }) {
  const page = p.page ?? 1;
  const pageSize = Math.min(p.pageSize ?? 25, 200);
  const conds = [
    eq(xeroInvoices.type, "ACCREC"),
    p.q ? or(sql`${xeroInvoices.invoiceNumber} ilike ${"%" + p.q + "%"}`, sql`${xeroInvoices.reference} ilike ${"%" + p.q + "%"}`, sql`${companies.name} ilike ${"%" + p.q + "%"}`, sql`${xeroContacts.name} ilike ${"%" + p.q + "%"}`) : undefined,
    p.status && p.status !== "all" ? eq(xeroInvoices.status, p.status as "DRAFT") : undefined,
    p.companyId ? eq(xeroInvoices.companyId, p.companyId) : undefined,
    p.overdueOnly ? and(eq(xeroInvoices.status, "AUTHORISED"), sql`${xeroInvoices.dueDate} < current_date`) : undefined,
  ].filter(Boolean);
  const where = and(...(conds as [ReturnType<typeof eq>]));
  const base = () => db.select({ inv: xeroInvoices, companyName: companies.name, contactName: xeroContacts.name }).from(xeroInvoices).leftJoin(companies, eq(companies.id, xeroInvoices.companyId)).leftJoin(xeroContacts, eq(xeroContacts.contactId, xeroInvoices.contactId));
  const [rows, [{ total }]] = await Promise.all([
    base().where(where).orderBy(desc(xeroInvoices.date), desc(xeroInvoices.invoiceNumber)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)`.mapWith(Number) }).from(xeroInvoices).leftJoin(companies, eq(companies.id, xeroInvoices.companyId)).leftJoin(xeroContacts, eq(xeroContacts.contactId, xeroInvoices.contactId)).where(where),
  ]);
  return { rows: rows.map((r) => ({ ...r.inv, companyName: r.companyName, contactName: r.contactName })), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function financeTotals() {
  const [row] = await db
    .select({
      outstanding: sql<number>`coalesce(sum(amount_due) filter (where status = 'AUTHORISED'), 0)`.mapWith(Number),
      overdue: sql<number>`coalesce(sum(amount_due) filter (where status = 'AUTHORISED' and due_date < current_date), 0)`.mapWith(Number),
      overdueCount: sql<number>`count(*) filter (where status = 'AUTHORISED' and due_date < current_date)`.mapWith(Number),
      draftsInXero: sql<number>`count(*) filter (where status = 'DRAFT')`.mapWith(Number),
      paidLast30: sql<number>`coalesce(sum(amount_paid) filter (where fully_paid_on_date >= current_date - 30), 0)`.mapWith(Number),
      lastFetched: sql<Date | null>`max(fetched_at)`,
    })
    .from(xeroInvoices)
    .where(eq(xeroInvoices.type, "ACCREC"));
  const [{ pendingDrafts }] = await db.select({ pendingDrafts: sql<number>`count(*)`.mapWith(Number) }).from(invoiceDrafts).where(inArray(invoiceDrafts.status, ["draft", "failed"]));
  return { ...row, pendingDrafts };
}

export async function companyFinancialSummary(companyId: string) {
  const link = await getLink("xero", "company", companyId);
  const [mirror] = link ? await db.select().from(xeroContacts).where(eq(xeroContacts.contactId, link.externalId)).limit(1) : [];
  const [agg] = await db
    .select({
      outstanding: sql<number>`coalesce(sum(amount_due) filter (where status = 'AUTHORISED'), 0)`.mapWith(Number),
      overdue: sql<number>`coalesce(sum(amount_due) filter (where status = 'AUTHORISED' and due_date < current_date), 0)`.mapWith(Number),
      paid12m: sql<number>`coalesce(sum(amount_paid) filter (where date >= current_date - 365), 0)`.mapWith(Number),
      invoiced12m: sql<number>`coalesce(sum(total) filter (where date >= current_date - 365 and status in ('AUTHORISED','PAID')), 0)`.mapWith(Number),
      count: sql<number>`count(*)`.mapWith(Number),
      lastFetched: sql<Date | null>`max(fetched_at)`,
    })
    .from(xeroInvoices)
    .where(and(eq(xeroInvoices.companyId, companyId), eq(xeroInvoices.type, "ACCREC")));
  const invoices = await listXeroInvoices({ companyId, pageSize: 50 });
  const drafts = await db.select().from(invoiceDrafts).where(and(eq(invoiceDrafts.companyId, companyId), inArray(invoiceDrafts.status, ["draft", "approved", "failed"]))).orderBy(desc(invoiceDrafts.createdAt));
  return { link, xeroContact: mirror ?? null, ...agg, invoices: invoices.rows, drafts };
}

export async function listInvoiceDrafts(status?: string) {
  const rows = await db
    .select({ draft: invoiceDrafts, companyName: companies.name, contractName: contracts.name, opportunityTitle: opportunities.title })
    .from(invoiceDrafts)
    .innerJoin(companies, eq(companies.id, invoiceDrafts.companyId))
    .leftJoin(contracts, eq(contracts.id, invoiceDrafts.contractId))
    .leftJoin(opportunities, eq(opportunities.id, invoiceDrafts.opportunityId))
    .where(status && status !== "all" ? eq(invoiceDrafts.status, status as "draft") : undefined)
    .orderBy(desc(invoiceDrafts.createdAt))
    .limit(200);
  return rows.map((r) => ({ ...r.draft, companyName: r.companyName, contractName: r.contractName, opportunityTitle: r.opportunityTitle }));
}

export async function getInvoiceDraft(id: string) {
  const [row] = await db.select({ draft: invoiceDrafts, companyName: companies.name }).from(invoiceDrafts).innerJoin(companies, eq(companies.id, invoiceDrafts.companyId)).where(eq(invoiceDrafts.id, id)).limit(1);
  if (!row) return null;
  const link = await getLink("xero", "company", row.draft.companyId);
  const mirror = row.draft.xeroInvoiceId ? (await db.select().from(xeroInvoices).where(eq(xeroInvoices.invoiceId, row.draft.xeroInvoiceId)).limit(1))[0] : null;
  return { ...row.draft, companyName: row.companyName, xeroLink: link, xeroInvoice: mirror ?? null };
}

const num = (v: unknown) => (v === null || v === undefined ? null : String(v));
const round = (n: number) => Math.round(n * 100) / 100;
const fmt = (v: string | number | null, currency: string | null) => {
  const n = v === null ? 0 : Number(v);
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency ?? "GBP" }).format(n);
};
