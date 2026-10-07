import { describe, expect, it, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contractLines, hostingItems, pax8Subscriptions, serviceLinks } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract, getContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { syncPax8 } from "@/services/pax8";
import { syncTwentyI, setHostingBillingLine } from "@/services/twentyi";
import { listDiscrepancies } from "@/services/ninjaone";
import { runQuantityChecks } from "@/services/quantity-check";
import { companyServiceRegister } from "@/services/service-register";
import { setServiceLink, clearServiceLink, linksFor } from "@/services/service-links";
import { BILLING_ADAPTERS } from "@/services/billing-adapters";
import { makeUser } from "./helpers";

let admin: { id: string };
let dental: string;

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "links admin");
});

const line = (over: Record<string, unknown>) => ({ id: null, productId: null, siteId: null, description: "x", revenueType: "recurring" as const, pricingModel: "per_user" as const, billingFrequency: "monthly" as const, quantity: 1, unitPrice: 10, unitCost: null, countsAsManagedDevice: false, ...over });

describe("service links: the shared billing model over every integration", () => {
  it("every adapter reports services in the shared shape, a sync records rule matches as links, and a person's choice is never overwritten", async () => {
    dental = await createCompany(companySchema.parse({ name: "Harrowgate Dental Practice", status: "customer", website: "https://www.harrowgatedental.co.uk" }), admin.id);
    const contractId = await createContract(
      contractSchema.parse({ companyId: dental, name: "Managed IT", startDate: "2026-01-01", status: "active" }),
      [line({ description: "Microsoft 365 Business Standard", quantity: 14, unitPrice: 12, quantityRule: "synced" }), line({ description: "Web hosting for harrowgatedental.co.uk", pricingModel: "fixed", quantity: 1, unitPrice: 15 }), line({ description: "Domain renewals", pricingModel: "fixed", quantity: 1, unitPrice: 2 })]
      ,
      admin.id,
    );
    expect((await getContract(contractId))!.lines.find((l) => l.description.startsWith("Microsoft"))!.quantityRule).toBe("synced");
    await syncPax8("manual", admin.id);
    await syncTwentyI("manual", admin.id);

    for (const a of BILLING_ADAPTERS) {
      const rows = await a.services([dental]);
      for (const r of rows) expect(r).toMatchObject({ provider: a.provider, companyId: dental, key: `${r.source}:${r.rowId}` });
      if (a.provider === "pax8") expect(rows.some((r) => r.monthlyCost !== null && r.costKnown)).toBe(true);
      if (a.provider === "twentyi") expect(rows.every((r) => r.monthlyCost === null && !r.costKnown)).toBe(true);
    }

    // The Pax8 sync recorded the product-name match as a link; the 20i sync matched the package by the line naming it.
    const links = await linksFor({ companyIds: [dental] });
    const std = (await db.select().from(pax8Subscriptions).where(eq(pax8Subscriptions.companyId, dental))).find((s) => /Business Standard/.test(s.productName))!;
    expect(links.get(`pax8_subscription:${std.id}`)).toMatchObject({ role: "charged", matchSource: "name", quantity: String(std.quantity) + ".00" });
    const pkg = (await db.select().from(hostingItems).where(and(eq(hostingItems.companyId, dental), eq(hostingItems.kind, "package"))))[0];
    expect(links.get(`hosting_item:${pkg.id}`)).toMatchObject({ role: "charged", matchSource: "name" });
    const reg = await companyServiceRegister(dental);
    expect(reg.rows.find((r) => r.rowId === std.id)).toMatchObject({ state: "charged", matchedBy: "name", providerLabel: "Pax8" });
    expect(reg.rows.find((r) => r.rowId === pkg.id)).toMatchObject({ state: "charged", matchedBy: "name", providerLabel: "20i", costKnown: false });

    // A person's choice stays through the next sync, even though the rule would pick differently.
    const lines = await db.select().from(contractLines).where(eq(contractLines.contractId, contractId));
    const domainsLine = lines.find((l) => l.description === "Domain renewals")!;
    await setHostingBillingLine(pkg.id, domainsLine.id, admin.id);
    await syncTwentyI("manual", admin.id);
    expect((await linksFor({ companyIds: [dental] })).get(`hosting_item:${pkg.id}`)).toMatchObject({ contractLineId: domainsLine.id, matchSource: "manual" });
    await setHostingBillingLine(pkg.id, null, admin.id);
    expect((await linksFor({ companyIds: [dental] })).has(`hosting_item:${pkg.id}`)).toBe(false);
  });

  it("the quantity check covers 20i too: items charged on one line are counted against it, and matching counts resolve the item", async () => {
    const lines = await db.select().from(contractLines).where(eq(contractLines.description, "Domain renewals"));
    const domainsLine = lines[0];
    const domains = (await db.select().from(hostingItems).where(and(eq(hostingItems.companyId, dental), eq(hostingItems.externalStatus, "active")))).filter((h) => h.kind === "domain" || h.kind === "package");
    expect(domains.length).toBeGreaterThanOrEqual(2);
    for (const d of domains) await setServiceLink({ source: "hosting_item", sourceRowId: d.id, role: "charged", contractLineId: domainsLine.id }, admin.id);
    const r = await runQuantityChecks(admin.id, { companyId: dental, providers: ["twentyi"] });
    expect(r.checked).toBeGreaterThanOrEqual(1);
    const open = (await listDiscrepancies({ companyId: dental, source: "twentyi", status: "open" })).find((d) => d.contractLineId === domainsLine.id)!;
    expect(open).toMatchObject({ contractedQty: "1.00", observedQty: domains.length, difference: `${domains.length - 1}.00`, source: "twentyi" });
    expect((open.basis as { quantityRule: string }).quantityRule).toBe("fixed");
    // One domain is in fact free: it leaves the count.
    for (const d of domains.slice(1)) await setServiceLink({ source: "hosting_item", sourceRowId: d.id, role: "free", reason: "included with the package", reviewOn: "2030-01-01" }, admin.id);
    await runQuantityChecks(admin.id, { companyId: dental, providers: ["twentyi"] });
    expect((await listDiscrepancies({ companyId: dental, source: "twentyi", status: "open" })).filter((d) => d.contractLineId === domainsLine.id)).toHaveLength(0);
    // Clearing every link on the line resolves its item rather than leaving a stale comparison.
    for (const d of domains) await clearServiceLink("hosting_item", d.id, admin.id);
    await runQuantityChecks(admin.id, { companyId: dental, providers: ["twentyi"] });
    expect((await db.select().from(serviceLinks).where(eq(serviceLinks.contractLineId, domainsLine.id)))).toHaveLength(0);
  });
});
