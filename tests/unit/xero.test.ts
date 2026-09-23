import { describe, expect, it, beforeAll, vi } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { companies, contacts, contractLines, contracts, invoiceDrafts, products, xeroContacts, xeroInvoices, outboundRequests, inboundEvents } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { LiveXeroClient, verifyWebhookSignature, xeroDate, xeroDateOnly } from "@/connectors/xero/live";
import { demoXeroAuthorise, demoXeroPay, demoXeroReset, demoXeroTouchContact } from "@/connectors/xero/demo";
import { approveAndCreateInvoice, companyFinancialSummary, createXeroContactForCompany, financeTotals, importAllRepeatingInvoices, importAllXeroCustomers, importRepeatingInvoiceAsContract, importXeroContactAsCompany, linkCompanyToXeroContact, listUnlinkedXeroCustomers, listXeroRepeatingInvoices, repeatingFrequency, prepareInvoiceDraft, processXeroInboundEvents, pushContactDetailsToXero, recordXeroWebhookEvents, suggestXeroContacts, syncXero } from "@/services/xero";
import { getLink, listOpenConflicts, setConnectionConfig, updateConnection } from "@/services/integrations";
import { ActionError } from "@/lib/action-result";
import { makeUser } from "./helpers";

let admin: { id: string };
let finance: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  delete process.env.XERO_CLIENT_ID;
  admin = await makeUser("admin", "xero admin");
  finance = await makeUser("finance", "xero finance");
  demoXeroReset();
});

describe("Xero live client", () => {
  it("refreshes rotating tokens once for concurrent requests and persists the new set", async () => {
    let refreshCalls = 0;
    let apiCalls = 0;
    const persisted: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/connect/token")) {
        refreshCalls++;
        const body = String(init?.body);
        expect(body).toContain("grant_type=refresh_token");
        expect(String((init?.headers as Record<string, string>).Authorization)).toMatch(/^Basic /);
        return new Response(JSON.stringify({ access_token: `at-${refreshCalls}`, refresh_token: `rt-${refreshCalls}`, expires_in: 1800 }));
      }
      apiCalls++;
      const h = init?.headers as Record<string, string>;
      expect(h["xero-tenant-id"]).toBe("tenant-1");
      expect(h.Authorization).toBe("Bearer at-1");
      return new Response(JSON.stringify({ Organisations: [{ OrganisationID: "org-1", Name: "Test Org", BaseCurrency: "GBP" }] }));
    }) as unknown as typeof fetch;
    const client = new LiveXeroClient({ clientId: "id", clientSecret: "secret", redirectUri: "https://x/cb" }, { accessToken: "expired", refreshToken: "rt-0", expiresAt: Date.now() - 1000 }, "tenant-1", async (t) => { persisted.push(t.refreshToken); }, fetchImpl);
    const [a, b] = await Promise.all([client.getOrganisation(), client.getOrganisation()]);
    expect(a.Name).toBe("Test Org");
    expect(b.Name).toBe("Test Org");
    expect(refreshCalls).toBe(1);
    expect(apiCalls).toBe(2);
    expect(persisted).toEqual(["rt-1"]);
  });

  it("sends Idempotency-Key and If-Modified-Since headers and creates DRAFT invoices only", async () => {
    const seen: { url: string; headers: Record<string, string>; body?: string }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init?.headers as Record<string, string>, body: init?.body ? String(init.body) : undefined });
      if (String(url).includes("/Invoices") && init?.method === "PUT") return new Response(JSON.stringify({ Invoices: [{ InvoiceID: "inv-1", InvoiceNumber: "INV-1", Status: "DRAFT", Type: "ACCREC" }] }));
      return new Response(JSON.stringify({ Contacts: [] }));
    }) as unknown as typeof fetch;
    const client = new LiveXeroClient({ clientId: "id", clientSecret: "s", redirectUri: "https://x/cb" }, { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 1e6 }, "t", async () => {}, fetchImpl);
    await client.listContacts({ page: 1, ifModifiedSince: new Date("2026-01-01T00:00:00Z") });
    expect(seen[0].headers["If-Modified-Since"]).toBe("2026-01-01T00:00:00.000Z");
    const inv = await client.createDraftInvoice({ contactId: "c1", reference: "CRM-ABC", date: "2026-09-22", dueDate: "2026-10-22", currencyCode: "GBP", lineAmountTypes: "Exclusive", lineItems: [{ description: "x", quantity: 1, unitAmount: 10, accountCode: "200", taxType: "OUTPUT2" }] }, "xero:invoice:abc");
    expect(inv.Status).toBe("DRAFT");
    const put = seen[1];
    expect(put.headers["Idempotency-Key"]).toBe("xero:invoice:abc");
    const body = JSON.parse(put.body!);
    expect(body.Invoices[0].Status).toBe("DRAFT");
    expect(body.Invoices[0].Type).toBe("ACCREC");
  });

  it("verifies webhook signatures with constant-time comparison and parses Xero dates", () => {
    const key = "secret-key";
    const raw = JSON.stringify({ events: [], firstEventSequence: 0, lastEventSequence: 0, entropy: "x" });
    const good = createHmac("sha256", key).update(raw).digest("base64");
    expect(verifyWebhookSignature(raw, good, key)).toBe(true);
    expect(verifyWebhookSignature(raw, good.slice(0, -2) + "==", key)).toBe(false);
    expect(verifyWebhookSignature(raw, null, key)).toBe(false);
    expect(xeroDate("/Date(1700000000000+0000)/")?.getTime()).toBe(1700000000000);
    expect(xeroDateOnly("/Date(1700000000000+0000)/", "2023-11-14T22:13:20")).toBe("2023-11-14");
    expect(xeroDate("garbage")).toBeNull();
  });
});

describe("Xero workflow (demo adapter)", () => {
  let companyId: string;
  it("syncs contacts, invoices and payments incrementally", async () => {
    const first = await syncXero("manual", admin.id);
    expect(first?.status).toBe("success");
    expect(first!.counters.created).toBeGreaterThanOrEqual(10);
    const contacts = await db.select().from(xeroContacts);
    expect(contacts.some((c) => c.name === "Northern Freight Solutions Ltd")).toBe(true);
    expect(contacts.find((c) => c.name === "Northern Freight Solutions Ltd")?.overdue).toBe("3611.04");
    const again = await syncXero("manual", admin.id);
    expect(again!.counters.created).toBe(0);
  });

  it("suggests matches by company number, VAT, domain and name but never links automatically", async () => {
    companyId = await createCompany(companySchema.parse({ name: "Northern Freight Solutions Limited", website: "northernfreight.co.uk", vatNumber: "GB 123 456 789" }), admin.id);
    const s = await suggestXeroContacts({ id: companyId, name: "Northern Freight Solutions Limited", companyNumber: null, vatNumber: "GB 123 456 789", domain: "northernfreight.co.uk", email: null });
    expect(s[0]).toMatchObject({ name: "Northern Freight Solutions Ltd", confidence: "high" });
    expect(["tax_number", "domain"]).toContain(s[0].reason);
    expect(await getLink("xero", "company", companyId)).toBeNull();
    const other = await createCompany(companySchema.parse({ name: "Ridgeway Architects LLP", website: "ridgeway-arch.example" }), admin.id);
    const s2 = await suggestXeroContacts({ id: other, name: "Ridgeway Architects LLP", companyNumber: null, vatNumber: null, domain: "ridgeway-arch.example", email: null });
    expect(s2.find((m) => m.name === "Ridgeway Architects")?.confidence).toBe("medium");
  });

  it("linking attaches mirrored invoices and financial summary reflects Xero balances", async () => {
    await linkCompanyToXeroContact(companyId, "demo-c-2", admin.id);
    const fin = await companyFinancialSummary(companyId);
    expect(fin.link?.externalId).toBe("demo-c-2");
    expect(fin.invoices.length).toBe(3);
    expect(Number(fin.xeroContact?.outstanding)).toBeCloseTo(7222.08);
    expect(fin.overdue).toBeCloseTo(3611.04);
    await expect(linkCompanyToXeroContact(companyId, "demo-c-1", admin.id)).rejects.toThrow(/already linked/);
  });

  it("refuses to create a Xero contact when a likely duplicate exists, and creates once otherwise", async () => {
    await expect(createXeroContactForCompany(await createCompany(companySchema.parse({ name: "Harrowgate Dental Practice", website: "hdp.example" }), admin.id), admin.id)).rejects.toThrow(/looks like this company/);
    const fresh = await createCompany(companySchema.parse({ name: "Brand New Customer Ltd", website: "brandnew.example", email: "hello@brandnew.example" }), admin.id);
    const a = await createXeroContactForCompany(fresh, admin.id);
    const b = await createXeroContactForCompany(fresh, admin.id);
    expect(a).toBe(b);
    const rows = await db.select().from(outboundRequests).where(eq(outboundRequests.idempotencyKey, `xero:contact:${fresh}`));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("succeeded");
  });

  it("prepare → approve creates one DRAFT in Xero, retries reuse it, and permissions are enforced by the action layer", async () => {
    await setConnectionConfig("xero", { defaultAccountCode: "201", defaultTaxType: "OUTPUT2", dueDays: 14 }, admin.id);
    const contractId = await createContract(
      contractSchema.parse({ companyId, name: "MSA", startDate: "2026-01-01", status: "active", billingFrequency: "monthly" }),
      [{ id: null, productId: null, siteId: null, description: "Managed users", revenueType: "recurring", pricingModel: "per_user", billingFrequency: "monthly", quantity: 32, unitPrice: 45, unitCost: 18, countsAsManagedDevice: false }, { id: null, productId: null, siteId: null, description: "Firewall (annual)", revenueType: "recurring", pricingModel: "fixed", billingFrequency: "annual", quantity: 1, unitPrice: 1200, unitCost: null, countsAsManagedDevice: false }, { id: null, productId: null, siteId: null, description: "Setup", revenueType: "one_off_project", pricingModel: "one_off", billingFrequency: "one_off", quantity: 1, unitPrice: 500, unitCost: null, countsAsManagedDevice: false }],
      admin.id,
    );
    const draftId = await prepareInvoiceDraft({ companyId, contractId, periodStart: "2026-09-01", periodEnd: "2026-09-30" }, finance.id);
    const [draft] = await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, draftId));
    expect(draft.reference).toMatch(/^CRM-[0-9A-F]{8}$/);
    expect(draft.lines).toHaveLength(2); // one-off excluded from a recurring period invoice
    expect(draft.lines[0]).toMatchObject({ quantity: 32, unitAmount: 45, accountCode: "201", taxType: "OUTPUT2" });
    expect(draft.lines[1].unitAmount).toBe(100); // annual 1200 normalised to the monthly period
    expect(Number(draft.subTotal)).toBe(32 * 45 + 100);

    const first = await approveAndCreateInvoice(draftId, finance.id);
    const second = await approveAndCreateInvoice(draftId, finance.id);
    expect(second).toEqual({ invoiceId: first.invoiceId, reused: true });
    const [after] = await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, draftId));
    expect(after.status).toBe("created");
    expect(after.approvedByUserId).toBe(finance.id);
    const [mirror] = await db.select().from(xeroInvoices).where(eq(xeroInvoices.invoiceId, first.invoiceId));
    expect(mirror.status).toBe("DRAFT");
    expect(mirror.companyId).toBe(companyId);
    expect(mirror.reference).toBe(draft.reference);
    expect((await db.select().from(outboundRequests).where(eq(outboundRequests.idempotencyKey, `xero:invoice:${draftId}`))).length).toBe(1);

    // Action-layer permission: the service is role-agnostic; the action requires invoice.approve (see permissions test).
    const { can } = await import("@/lib/permissions");
    expect(can("sales", "invoice.approve")).toBe(false);
    expect(can("account_manager", "invoice.prepare")).toBe(true);
    expect(can("account_manager", "invoice.approve")).toBe(false);
  });

  it("approval is refused when the company is not linked to Xero", async () => {
    const unlinked = await createCompany(companySchema.parse({ name: "Unlinked Co", website: "unlinked.example" }), admin.id);
    const cid = await createContract(contractSchema.parse({ companyId: unlinked, name: "MSA", startDate: "2026-01-01", status: "active" }), [{ id: null, productId: null, siteId: null, description: "x", revenueType: "recurring", pricingModel: "fixed", billingFrequency: "monthly", quantity: 1, unitPrice: 10, unitCost: null, countsAsManagedDevice: false }], admin.id);
    const d = await prepareInvoiceDraft({ companyId: unlinked, contractId: cid }, finance.id);
    await expect(approveAndCreateInvoice(d, finance.id)).rejects.toThrow(/Link this company/);
  });

  it("webhook events are recorded once and applied by the worker; payment updates reach the right company", async () => {
    demoXeroPay("demo-i-4"); // Northern Freight, linked to companyId
    const ev = { resourceId: "demo-i-4", eventDateUtc: "2026-09-22T10:00:00.000Z", eventType: "UPDATE", eventCategory: "INVOICE", tenantId: "demo" };
    expect(await recordXeroWebhookEvents([ev, ev])).toBe(1);
    expect(await recordXeroWebhookEvents([ev])).toBe(0);
    const res = await processXeroInboundEvents();
    expect(res.processed).toBe(1);
    const [inv] = await db.select().from(xeroInvoices).where(eq(xeroInvoices.invoiceId, "demo-i-4"));
    expect(inv.status).toBe("PAID");
    expect(inv.companyId).toBe(companyId);
    const pending = await db.select().from(inboundEvents).where(eq(inboundEvents.provider, "xero"));
    expect(pending.filter((e) => !e.processedAt && e.eventType === "invoice.update")).toHaveLength(0);
    const totals = await financeTotals();
    expect(totals.outstanding).toBeGreaterThan(0);
  });

  it("field ownership: pushing CRM email/phone is refused with a review item when Xero changed first", async () => {
    // Xero changes the email after our last sync, and it differs from the CRM value.
    demoXeroTouchContact("demo-c-2", { EmailAddress: "newbilling@northernfreight.co.uk" });
    await db.update(db._.fullSchema.companies).set({ email: "accounts@northernfreight.co.uk" }).where(eq(db._.fullSchema.companies.id, companyId));
    await expect(pushContactDetailsToXero(companyId, admin.id)).rejects.toThrow(/newer contact details/);
    const conflicts = await listOpenConflicts("xero");
    expect(conflicts.some((c) => c.kind === "field_conflict" && c.localId === companyId)).toBe(true);
    // After a sync (mirror now current) an explicit push goes through.
    await syncXero("manual", admin.id);
    const r = await pushContactDetailsToXero(companyId, admin.id);
    expect(r.changed).toBe(true);
    const [c] = await db.select().from(xeroContacts).where(eq(xeroContacts.contactId, "demo-c-2"));
    expect(c.emailAddress).toBe("accounts@northernfreight.co.uk");
  });

  it("status changes discovered by polling create one timeline event each", async () => {
    demoXeroAuthorise("demo-i-7");
    await syncXero("manual", admin.id);
    await syncXero("manual", admin.id);
    const evs = await db.select().from(inboundEvents).where(eq(inboundEvents.eventId, "invoice:demo-i-7:AUTHORISED:0"));
    expect(evs).toHaveLength(1);
  });

  it("the circuit breaker paused state does not block manual syncs", async () => {
    await updateConnection("xero", { pausedUntil: new Date(Date.now() + 3600_000) });
    expect(await syncXero("schedule")).toBeNull();
    expect((await syncXero("manual", admin.id))?.status).toBe("success");
    await updateConnection("xero", { pausedUntil: null });
  });

  it("rejects approval of a cancelled draft", async () => {
    const d = await prepareInvoiceDraft({ companyId, contractId: (await db.select().from(db._.fullSchema.contracts).where(eq(db._.fullSchema.contracts.companyId, companyId)))[0].id }, finance.id);
    const { cancelInvoiceDraft } = await import("@/services/xero");
    await cancelInvoiceDraft(d, finance.id);
    await expect(approveAndCreateInvoice(d, finance.id)).rejects.toThrow(ActionError);
  });

  it("imports unlinked Xero customers as companies: creates with address and contact, links obvious duplicates, never touches suppliers, idempotent", async () => {
    const before = await listUnlinkedXeroCustomers();
    expect(before.map((r) => r.contactId)).not.toContain("demo-c-2"); // already linked
    expect(before.map((r) => r.contactId)).not.toContain("demo-c-6"); // supplier, not a customer
    expect(before.some((r) => r.contactId === "demo-c-4")).toBe(true);

    const created = await importXeroContactAsCompany("demo-c-4", admin.id);
    expect(created.action).toBe("created");
    const [co] = await db.select().from(companies).where(eq(companies.id, created.companyId!));
    expect(co).toMatchObject({ name: "Greenfield Primary Academy", status: "customer", email: "finance@greenfieldacademy.org.uk", addressLine1: "1 High Street", city: "Leeds", postcode: "LS1 1AA", country: "GB" });
    expect((await getLink("xero", "company", co.id))?.externalId).toBe("demo-c-4");
    expect((await importXeroContactAsCompany("demo-c-4", admin.id)).action).toBe("skipped");

    // "Ridgeway Architects" in Xero vs the existing "Ridgeway Architects LLP" company: link, don't duplicate
    const ridgeway = await importXeroContactAsCompany("demo-c-3", admin.id);
    const [existing] = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, "Ridgeway Architects LLP"));
    if (ridgeway.action === "linked") expect(ridgeway.companyId).toBe(existing.id);
    else expect(ridgeway.action).toBe("skipped");
    expect((await db.select().from(companies).where(eq(companies.name, "Ridgeway Architects"))).length).toBe(0);

    const all = await importAllXeroCustomers(admin.id);
    expect(all.created + all.linked + all.skipped.length).toBe(all.results.length);
    expect(await listUnlinkedXeroCustomers()).toHaveLength(0);
    expect((await db.select().from(companies).where(eq(companies.name, "Old Supplier Ltd"))).length).toBe(0);
    const [bramley] = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, "Bramley Accountants Ltd"));
    expect(bramley).toBeTruthy();
    const people = await db.select().from(contacts).where(eq(contacts.companyId, bramley.id));
    expect(people.length).toBeLessThanOrEqual(1); // contact only when Xero has a person name
  });

  it("imports repeating invoices as draft contracts: frequency mapping, tax-exclusive pricing, catalogue matching, skips and idempotency", async () => {
    expect(repeatingFrequency({ Period: 1, Unit: "MONTHLY" })).toEqual({ frequency: "monthly" });
    expect(repeatingFrequency({ Period: 3, Unit: "MONTHLY" })).toEqual({ frequency: "quarterly" });
    expect(repeatingFrequency({ Period: 12, Unit: "MONTHLY" })).toEqual({ frequency: "annual" });
    expect(repeatingFrequency({ Period: 2, Unit: "WEEKLY" })).toHaveProperty("reason");
    expect(repeatingFrequency({ Period: 6, Unit: "MONTHLY" })).toHaveProperty("reason");

    await db.insert(products).values({ sku: "MIT-DEV", name: "Managed device", category: "managed_it", pricingModel: "per_device", revenueType: "recurring", billingFrequency: "monthly", unitPrice: "12.00", unitCost: "4.50", countsAsManagedDevice: true }).onConflictDoNothing();
    const listed = await listXeroRepeatingInvoices();
    const nf = listed.rows.find((r) => r.id === "demo-ri-1")!;
    expect(nf).toMatchObject({ companyId, frequency: "monthly", monthlyValue: 1990, lineCount: 3, contractId: null });
    expect(listed.rows.find((r) => r.id === "demo-ri-3")!.unsupportedReason).toMatch(/week/);
    expect(listed.rows.some((r) => r.id === "demo-ri-5")).toBe(false); // supplier bill excluded

    const created = await importRepeatingInvoiceAsContract("demo-ri-1", admin.id);
    expect(created.action).toBe("created");
    const [c] = await db.select().from(contracts).where(eq(contracts.id, created.contractId!));
    expect(c).toMatchObject({ companyId, status: "draft", billingFrequency: "monthly", name: "Managed IT & Security", startDate: "2026-01-01", autoRenew: true });
    expect(c.notes).toMatch(/Imported from Xero repeating invoice/);
    const lines = await db.select().from(contractLines).where(eq(contractLines.contractId, c.id)).orderBy(contractLines.sortOrder);
    expect(lines).toHaveLength(3);
    const dev = lines.find((l) => l.description.startsWith("Managed device"))!;
    expect(dev).toMatchObject({ pricingModel: "per_device", countsAsManagedDevice: true, quantity: "40.00", unitPrice: "12.00", unitCost: "4.50" });
    expect(dev.productId).toBeTruthy();
    // MIT-USER had no catalogue product: created from the Xero item (name, price) and used for the line
    const userLine = lines.find((l) => l.description === "Managed user support")!;
    expect(userLine).toMatchObject({ pricingModel: "per_user", countsAsManagedDevice: false });
    expect(userLine.productId).toBeTruthy();
    const [userProduct] = await db.select().from(products).where(eq(products.sku, "MIT-USER"));
    expect(userProduct).toMatchObject({ name: "Managed user support", pricingModel: "per_user", unitPrice: "45.00", unitCost: null, category: "managed_it", countsAsManagedDevice: false, active: true });
    expect(c.notes).toMatch(/Catalogue products created from Xero item codes: MIT-USER/);
    expect(created.productsCreated).toBe(1);
    expect(lines.find((l) => l.description === "Firewall monitoring")).toMatchObject({ pricingModel: "fixed", unitPrice: "35.00" });
    expect((await getLink("xero", "contract", c.id))?.externalId).toBe("demo-ri-1");
    expect((await importRepeatingInvoiceAsContract("demo-ri-1", admin.id)).action).toBe("skipped");

    // Quarterly, tax-inclusive, with an end date → exclusive unit price, quarterly frequency, renewal = end date
    const q = await importRepeatingInvoiceAsContract("demo-ri-2", admin.id);
    expect(q.action).toBe("created");
    const [qc] = await db.select().from(contracts).where(eq(contracts.id, q.contractId!));
    expect(qc).toMatchObject({ billingFrequency: "quarterly", endDate: "2027-03-31", renewalDate: "2027-03-31", autoRenew: false });
    const [ql] = await db.select().from(contractLines).where(eq(contractLines.contractId, qc.id));
    expect(ql).toMatchObject({ unitPrice: "15.00", quantity: "18.00", pricingModel: "per_device", countsAsManagedDevice: true, unitCost: "6.50" });
    // EDR-SEAT product created from the Xero item with its purchase price as cost, flagged for device comparison
    const [edr] = await db.select().from(products).where(eq(products.sku, "EDR-SEAT"));
    expect(edr).toMatchObject({ name: "Endpoint protection seat", category: "security", pricingModel: "per_device", unitPrice: "15.00", unitCost: "6.50", countsAsManagedDevice: true, billingFrequency: "quarterly" });
    expect((await db.select().from(products).where(eq(products.sku, "EDR-SEAT"))).length).toBe(1);

    const all = await importAllRepeatingInvoices(admin.id);
    expect(all.created).toBe(0);
    expect(all.skipped.map((s) => s.reference)).toEqual(expect.arrayContaining(["Weekly on-site", "Draft template"]));
    expect(all.skipped.find((s) => s.reference === "Draft template")!.reason).toMatch(/draft/);
  });
});
