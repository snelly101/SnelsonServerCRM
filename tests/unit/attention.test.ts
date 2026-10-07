import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contractLines } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { syncPax8, runLicenceCheck } from "@/services/pax8";
import { syncTwentyI } from "@/services/twentyi";
import { syncNinjaOne, linkOrganization, runDiscrepancyCheck } from "@/services/ninjaone";
import { attentionQueue, ATTENTION_KINDS } from "@/services/attention";
import { customersBillingPicture } from "@/services/billing-picture";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "attention admin");
});

const line = (over: Record<string, unknown>) => ({ id: null, productId: null, siteId: null, description: "x", revenueType: "recurring" as const, pricingModel: "per_user" as const, billingFrequency: "monthly" as const, quantity: 1, unitPrice: 10, unitCost: null, countsAsManagedDevice: false, ...over });

describe("needs attention queue and the customers list", () => {
  it("gathers unmapped services, count differences (fixed vs synced), stale costs, unlinked provider accounts and renewals into one vocabulary with links", async () => {
    const dental = await createCompany(companySchema.parse({ name: "Harrowgate Dental Practice", status: "customer", website: "https://www.harrowgatedental.co.uk" }), admin.id);
    const contractId = await createContract(
      contractSchema.parse({ companyId: dental, name: "Managed IT", startDate: "2026-01-01", status: "active", billingDay: "1" }),
      [line({ description: "Microsoft 365 Business Standard", quantity: 12, unitPrice: 12, unitCost: 9 }), line({ description: "Managed device", pricingModel: "per_device", quantity: 18, unitPrice: 12, unitCost: 4, countsAsManagedDevice: true, quantityRule: "synced" })],
      admin.id,
    );
    await syncPax8("manual", admin.id);
    await syncTwentyI("manual", admin.id);
    await syncNinjaOne("manual", admin.id);
    await linkOrganization("101", dental, admin.id);
    await runLicenceCheck(admin.id, dental);
    await runDiscrepancyCheck(admin.id, dental);

    const q = await attentionQueue({ asOf: "2026-10-07" });
    expect(Object.keys(q.counts).sort()).toEqual(Object.keys(ATTENTION_KINDS).sort());
    const mine = q.items.filter((i) => i.companyId === dental);
    // Licences: 14 at Pax8 against 12 on a fixed line = a count difference to decide.
    const count = mine.find((i) => i.kind === "count_differs")!;
    expect(count).toMatchObject({ severity: "amber", provider: "pax8", href: `/companies/${dental}?tab=billing` });
    expect(count.title).toMatch(/agreed 12, Pax8 supplies 14/);
    expect(count.amount).toBe(24);
    // Devices: 19 at NinjaOne against 18 on a synced line = a quantity change to approve.
    const change = mine.find((i) => i.kind === "quantity_change")!;
    expect(change.title).toMatch(/agreed 18, NinjaOne supplies 19/);
    // The recorded cost (9) differs from the Pax8 partner price.
    expect(mine.some((i) => i.kind === "cost_stale" && /Business Standard/.test(i.title))).toBe(true);
    // The Acronis seats are supplied but mapped to nothing.
    expect(mine.some((i) => i.kind === "unmapped_service" && /Acronis/.test(i.title))).toBe(true);
    // Provider accounts nobody has matched (the other demo companies) are listed once each, with a link to the mapping page.
    const unlinked = q.items.filter((i) => i.kind === "unlinked_account");
    expect(unlinked.length).toBeGreaterThan(0);
    expect(unlinked.every((i) => i.companyId === null && i.href.startsWith("/integrations/"))).toBe(true);
    expect(q.groups.matching).toBeGreaterThanOrEqual(unlinked.length + 1);
    // Red before amber, and the group counts add up to the actionable total.
    const sev = q.items.map((i) => i.severity);
    expect(sev.indexOf("amber")).toBeGreaterThanOrEqual(sev.lastIndexOf("red") === -1 ? 0 : sev.lastIndexOf("red"));
    expect(Object.values(q.groups).reduce((a, n) => a + n, 0)).toBe(q.items.length);

    // Customers list: one row for the dental practice with charge, supplier-derived cost and attention.
    const customers = await customersBillingPicture("2026-10-07");
    const row = customers.find((r) => r.companyId === dental)!;
    expect(row).toMatchObject({ agreements: 1, frequencies: ["monthly"], nextInvoiceOn: "2026-11-01", chargeMonthly: 12 * 12 + 18 * 12, linesTotal: 2, linesSupplied: 2 });
    expect(row.costMonthly).not.toBeNull();
    expect(row.attention).toBeGreaterThanOrEqual(3);
    expect(row.unmapped).toBeGreaterThanOrEqual(1);

    // Fixing the line to the synced rule reclassifies the licence difference without re-running anything.
    const [m365] = await db.select().from(contractLines).where(eq(contractLines.description, "Microsoft 365 Business Standard"));
    await db.update(contractLines).set({ quantityRule: "synced" }).where(eq(contractLines.id, m365.id));
    const q2 = await attentionQueue({ asOf: "2026-10-07" });
    expect(q2.items.filter((i) => i.companyId === dental && i.kind === "quantity_change")).toHaveLength(2);
    void contractId;
  });
});
