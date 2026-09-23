import { describe, expect, it, beforeAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { companies, contracts, contractLines, hostingItems, tasks, xeroInvoices } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { LiveTwentyIClient, resellerIdFrom, usageBytes } from "@/connectors/twentyi/live";
import { registrableDomain, twentyIDate } from "@/connectors/twentyi/types";
import { autoLinkHostingItems, companyHostingOverview, generateHostingReminders, hostingMappingOverview, hostingTotals, linkHostingItem, setHostingBillingLine, syncTwentyI, twentyIConnectionSummary, unlinkHostingItem } from "@/services/twentyi";
import { ActionError } from "@/lib/action-result";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "hosting admin");
});

describe("20i helpers", () => {
  it("reduces hostnames to a registrable domain, keeping two-part UK suffixes", () => {
    expect(registrableDomain("www.harrowgatedental.co.uk")).toBe("harrowgatedental.co.uk");
    expect(registrableDomain("crm.snelsonserver.com")).toBe("snelsonserver.com");
    expect(registrableDomain("https://portal.example.org.uk/path")).toBe("example.org.uk");
    expect(registrableDomain("localhost")).toBeNull();
  });
  it("parses ISO dates and tolerant usage shapes", () => {
    expect(twentyIDate("2026-11-03T00:00:00+00:00")).toBe("2026-11-03");
    expect(twentyIDate(null)).toBeNull();
    expect(usageBytes({ diskUsage: 1048576 })).toEqual({ diskUsedBytes: 1048576, diskLimitBytes: null });
    expect(usageBytes({ diskUsed: "2.5 GB", diskQuota: { bytes: 10737418240 } })).toEqual({ diskUsedBytes: Math.round(2.5 * 1024 ** 3), diskLimitBytes: 10737418240 });
    expect(resellerIdFrom({ id: 12345 })).toBe("12345");
    expect(resellerIdFrom("abc")).toBe("abc");
    expect(resellerIdFrom([{ resellerId: "r1" }])).toBe("r1");
  });
});

describe("20i live client (read-only)", () => {
  it("sends the base64 key as a bearer token, only ever GETs, and tolerates a missing mailbox service", async () => {
    const calls: { method: string; path: string; auth: string }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      calls.push({ method: init?.method ?? "GET", path: u.pathname, auth: String((init?.headers as Record<string, string>).Authorization) });
      if (u.pathname === "/reseller") return new Response(JSON.stringify({ id: 4242 }), { headers: { "content-type": "application/json" } });
      if (u.pathname === "/package") return new Response(JSON.stringify([{ id: 1, name: "a.co.uk", names: ["a.co.uk"], packageTypeName: "Linux", enabled: true }]), { headers: { "content-type": "application/json" } });
      if (u.pathname === "/domain") return new Response(JSON.stringify([{ id: 9, name: "a.co.uk", expiryDate: "2027-01-01" }]), { headers: { "content-type": "application/json" } });
      if (u.pathname.endsWith("/mailbox")) return new Response("Not found", { status: 404 });
      if (u.pathname.endsWith("/web/usage")) return new Response(JSON.stringify({ diskUsage: 2048 }), { headers: { "content-type": "application/json" } });
      return new Response("[]", { headers: { "content-type": "application/json" } });
    });
    const client = new LiveTwentyIClient({ apiKey: "my-general-key" }, fetchImpl as unknown as typeof fetch);
    const t = await client.testConnection();
    expect(t).toEqual({ ok: true, resellerId: "4242", packageCount: 1 });
    expect(await client.listDomains()).toHaveLength(1);
    expect(await client.listMailboxes(1, "a.co.uk")).toEqual([]);
    expect((await client.packageUsage(1))?.diskUsedBytes).toBe(2048);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.every((c) => c.auth === `Bearer ${Buffer.from("my-general-key").toString("base64")}`)).toBe(true);
    expect(Object.keys(LiveTwentyIClient.prototype).filter((k) => /create|update|delete|renew|suspend|add|set/i.test(k))).toEqual([]);
  });
});

describe("20i sync, matching, billing links and reminders (demo adapter)", () => {
  let dental: string;
  let freight: string;
  let lineId: string;

  it("mirrors packages, domains and mailboxes, and auto-links exact domain matches", async () => {
    dental = await createCompany(companySchema.parse({ name: "Harrowgate Dental Practice", status: "customer", website: "www.harrowgatedental.co.uk" }), admin.id);
    freight = await createCompany(companySchema.parse({ name: "Northern Freight Solutions Ltd", status: "customer", website: "https://northernfreight.co.uk" }), admin.id);
    const summary = await twentyIConnectionSummary();
    expect(summary.demo).toBe(true);
    const res = await syncTwentyI("manual", admin.id);
    expect(res?.status).toBe("success");
    const totals = await hostingTotals();
    expect(totals.packages).toBe(7);
    expect(totals.domains).toBe(8);
    expect(totals.mailboxes).toBeGreaterThanOrEqual(5);
    expect(totals.expired).toBe(1);
    const [pkg] = await db.select().from(hostingItems).where(and(eq(hostingItems.kind, "package"), eq(hostingItems.externalId, "900101")));
    expect(pkg.companyId).toBe(dental);
    expect(pkg.matchSource).toBe("auto");
    expect(pkg.matchDomain).toBe("harrowgatedental.co.uk");
    expect(pkg.diskUsedBytes).toBeGreaterThan(0);
    // Mailboxes follow the package's company; a .com domain of the same customer is not linked by itself.
    const boxes = await db.select().from(hostingItems).where(and(eq(hostingItems.kind, "mailbox"), eq(hostingItems.parentExternalId, "900101")));
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => b.companyId === dental && b.matchSource === "inherited")).toBe(true);
    const [dotcom] = await db.select().from(hostingItems).where(and(eq(hostingItems.kind, "domain"), eq(hostingItems.name, "northernfreight.com")));
    expect(dotcom.companyId).toBeNull();
    expect(dotcom.parentExternalId).toBeNull();
    const [couk] = await db.select().from(hostingItems).where(and(eq(hostingItems.kind, "domain"), eq(hostingItems.name, "northernfreight.co.uk")));
    expect(couk.companyId).toBe(freight);
    expect(couk.parentExternalId).toBe("900102");
    // Re-running is idempotent.
    const again = await syncTwentyI("manual", admin.id);
    expect(again?.counters.created).toBe(0);
    expect((await hostingTotals()).packages).toBe(7);
  });

  it("mapping overview suggests by domain and by name, and a second company with the same domain blocks auto-link", async () => {
    await createCompany(companySchema.parse({ name: "Yorkshire Craft Beer Co", status: "prospect" }), admin.id);
    const overview = await hostingMappingOverview();
    const beer = overview.items.find((i) => i.kind === "package" && i.name === "yorkshirecraftbeer.co.uk")!;
    expect(beer.companyId).toBeNull();
    expect(beer.suggestions.some((s) => s.reason === "name" && s.name === "Yorkshire Craft Beer Co")).toBe(true);
    // Two companies sharing the ridgewayarch.com domain: ambiguous, so nothing is linked automatically.
    await createCompany(companySchema.parse({ name: "Ridgeway Architects LLP", status: "customer", website: "ridgewayarch.com" }), admin.id);
    await createCompany(companySchema.parse({ name: "Ridgeway Holdings", status: "prospect", website: "ridgewayarch.com" }), admin.id, { skipDuplicateCheck: true });
    await autoLinkHostingItems(admin.id);
    const [ridge] = await db.select().from(hostingItems).where(and(eq(hostingItems.kind, "package"), eq(hostingItems.name, "ridgewayarch.com")));
    expect(ridge.companyId).toBeNull();
    const o2 = await hostingMappingOverview();
    expect(o2.items.find((i) => i.id === ridge.id)!.suggestions.filter((s) => s.reason === "domain")).toHaveLength(2);
  });

  it("manual link cascades to mailboxes, unlink is remembered across syncs, and billing lines must belong to the company", async () => {
    const [dotcom] = await db.select().from(hostingItems).where(and(eq(hostingItems.kind, "domain"), eq(hostingItems.name, "northernfreight.com")));
    await linkHostingItem(dotcom.id, freight, admin.id);
    const [beerPkg] = await db.select().from(hostingItems).where(and(eq(hostingItems.kind, "package"), eq(hostingItems.name, "yorkshirecraftbeer.co.uk")));
    await linkHostingItem(beerPkg.id, freight, admin.id);
    const beerBoxes = await db.select().from(hostingItems).where(and(eq(hostingItems.kind, "mailbox"), eq(hostingItems.parentExternalId, beerPkg.externalId)));
    expect(beerBoxes.every((b) => b.companyId === freight)).toBe(true);
    await unlinkHostingItem(beerPkg.id, admin.id);
    await syncTwentyI("manual", admin.id);
    const [afterSync] = await db.select().from(hostingItems).where(eq(hostingItems.id, beerPkg.id));
    expect(afterSync.companyId).toBeNull();
    expect(afterSync.matchSource).toBe("manual");
    expect((await db.select().from(hostingItems).where(and(eq(hostingItems.kind, "mailbox"), eq(hostingItems.parentExternalId, beerPkg.externalId)))).every((b) => b.companyId === null)).toBe(true);

    // Billing: a line on the freight contract can bill the freight .com domain; a dental line cannot.
    const contractId = await createContract(contractSchema.parse({ companyId: freight, name: "Hosting", status: "active", startDate: "2026-01-01", endDate: "2026-12-31", billingFrequency: "monthly", autoRenew: true, noticePeriodDays: 30 }), [{ id: null, description: "Domain renewal northernfreight.com", revenueType: "recurring", pricingModel: "fixed", billingFrequency: "annual", quantity: 1, unitPrice: 25, unitCost: 12, countsAsManagedDevice: false, productId: null, siteId: null }], admin.id);
    const [line] = await db.select({ id: contractLines.id }).from(contractLines).where(eq(contractLines.contractId, contractId));
    lineId = line.id;
    const dentalContract = await createContract(contractSchema.parse({ companyId: dental, name: "Dental hosting", status: "draft", startDate: "2026-01-01", endDate: "2026-12-31", billingFrequency: "monthly", autoRenew: false, noticePeriodDays: 30 }), [{ id: null, description: "Web hosting", revenueType: "recurring", pricingModel: "fixed", billingFrequency: "monthly", quantity: 1, unitPrice: 15, unitCost: 5, countsAsManagedDevice: false, productId: null, siteId: null }], admin.id);
    const [dentalLine] = await db.select({ id: contractLines.id }).from(contractLines).where(eq(contractLines.contractId, dentalContract));
    await expect(setHostingBillingLine(dotcom.id, dentalLine.id, admin.id)).rejects.toBeInstanceOf(ActionError);
    await setHostingBillingLine(dotcom.id, lineId, admin.id);
    const [billed] = await db.select().from(hostingItems).where(eq(hostingItems.id, dotcom.id));
    expect(billed.contractLineId).toBe(lineId);
    await expect(setHostingBillingLine(afterSync.id, lineId, admin.id)).rejects.toThrow(/Link the item/);
    expect((await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, contractId))).length).toBe(1);
  });

  it("company overview nests domains and mailboxes under packages, shows the billing line and finds invoices that mention the domain", async () => {
    await db.insert(xeroInvoices).values({ invoiceId: "inv-hosting-1", invoiceNumber: "INV-9001", type: "ACCREC", status: "AUTHORISED", companyId: freight, date: "2026-09-01", dueDate: "2026-09-30", currencyCode: "GBP", total: "30.00", amountDue: "30.00", lineItems: [{ Description: "Annual domain renewal: northernfreight.com", Quantity: 1 }] });
    await db.insert(xeroInvoices).values({ invoiceId: "inv-other-1", invoiceNumber: "INV-9002", type: "ACCREC", status: "PAID", companyId: freight, date: "2026-08-01", dueDate: "2026-08-30", currencyCode: "GBP", total: "500.00", amountDue: "0.00", lineItems: [{ Description: "Managed IT (per user)", Quantity: 32 }] });
    const o = await companyHostingOverview(freight);
    expect(o).not.toBeNull();
    const pkg = o!.packages.find((p) => p.name === "northernfreight.co.uk")!;
    expect(pkg.domains.map((d) => d.name)).toEqual(["northernfreight.co.uk"]);
    expect(pkg.mailboxes.map((m) => m.name)).toEqual(["info@northernfreight.co.uk"]);
    const loose = o!.looseDomains.find((d) => d.name === "northernfreight.com")!;
    expect(loose.billingLine?.id).toBe(lineId);
    expect(o!.expiring.map((e) => e.name)).toContain("northernfreight.com");
    expect(o!.invoices.map((i) => i.invoiceNumber)).toEqual(["INV-9001"]);
    expect(o!.invoices[0].mentions).toEqual(["northernfreight.com"]);
    expect(o!.lines.some((l) => l.id === lineId)).toBe(true);
    const [unknown] = await db.select({ id: companies.id }).from(companies).where(eq(companies.name, "Ridgeway Holdings"));
    expect(await companyHostingOverview(unknown.id)).toBeNull();
  });

  it("raises one reminder task per expiring or expired domain, idempotently, owned by the company owner when linked", async () => {
    const first = await generateHostingReminders();
    expect(first.created).toBeGreaterThanOrEqual(3); // dental 24d, freight .com 12d, bramley expired (unlinked)
    const rows = await db.select().from(tasks).where(eq(tasks.status, "open"));
    const expired = rows.find((t) => t.sourceKey?.startsWith("hosting-expiry:") && t.title.startsWith("Domain expired"));
    expect(expired?.priority).toBe("urgent");
    expect(expired?.title).toContain("no company linked");
    const freightTask = rows.find((t) => t.sourceKey?.startsWith("hosting-expiry:") && t.title.includes("northernfreight.com"));
    expect(freightTask?.companyId).toBe(freight);
    expect(freightTask?.priority).toBe("high");
    const second = await generateHostingReminders();
    expect(second.created).toBe(0);
  });
});
