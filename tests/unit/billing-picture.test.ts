import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contractLines } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { syncPax8, runLicenceCheck } from "@/services/pax8";
import { syncNinjaOne, linkOrganization, runDiscrepancyCheck } from "@/services/ninjaone";
import { companyBillingPicture, contractBillingPicture } from "@/services/billing-picture";
import { setServiceLink } from "@/services/service-links";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "picture admin");
});

const line = (over: Record<string, unknown>) => ({ id: null, productId: null, siteId: null, description: "x", revenueType: "recurring" as const, pricingModel: "per_user" as const, billingFrequency: "monthly" as const, quantity: 1, unitPrice: 10, unitCost: null, countsAsManagedDevice: false, ...over });

describe("billing picture: what we bill, what it costs, where it comes from", () => {
  it("joins each line to its sources, derives cost from the supplier where it prices, keeps cost unknown where it does not, and flags count and cost differences", async () => {
    const dental = await createCompany(companySchema.parse({ name: "Harrowgate Dental Practice", status: "customer", website: "https://www.harrowgatedental.co.uk" }), admin.id);
    const contractId = await createContract(
      contractSchema.parse({ companyId: dental, name: "Managed IT", startDate: "2026-01-01", status: "active", billingDay: "1" }),
      [line({ description: "Microsoft 365 Business Standard", quantity: 14, unitPrice: 12, unitCost: 9 }), line({ description: "Managed device", pricingModel: "per_device", quantity: 18, unitPrice: 12, unitCost: 4, countsAsManagedDevice: true }), line({ description: "Onboarding", revenueType: "one_off_project", pricingModel: "fixed", billingFrequency: "one_off", quantity: 1, unitPrice: 500 })],
      admin.id,
    );
    await syncPax8("manual", admin.id);
    await syncNinjaOne("manual", admin.id);
    await linkOrganization("101", dental, admin.id);
    await runLicenceCheck(admin.id, dental);
    await runDiscrepancyCheck(admin.id, dental);

    const p = await companyBillingPicture(dental, "2026-10-07");
    expect(p.agreements).toHaveLength(1);
    const a = p.agreements[0];
    expect(a.currentPeriod).toEqual({ periodStart: "2026-10-01", periodEnd: "2026-10-31" });
    expect(a.nextInvoiceOn).toBe("2026-11-01");
    const m365 = a.lines.find((l) => l.description.startsWith("Microsoft"))!;
    expect(m365.sources.map((s) => s.providerLabel)).toEqual(["Pax8"]);
    expect(m365.observed).toBe(14);
    expect(m365.costBasis).toBe("supplier");
    expect(m365.supplierMonthlyCost).toBeGreaterThan(0);
    expect(m365.costStale).toBe(true); // recorded 9/unit differs from the Pax8 partner price
    expect(m365.status).toBe("cost_stale");
    const devices = a.lines.find((l) => l.description === "Managed device")!;
    expect(devices.sources[0]).toMatchObject({ providerLabel: "NinjaOne", pool: true, costKnown: false });
    expect(devices.observed).toBe(19);
    expect(devices.costBasis).toBe("recorded"); // NinjaOne has no pricing, so the recorded cost stands
    expect(devices.costMonthlyPerUnit).toBe(4);
    expect(devices.status).toBe("count_differs");
    expect(devices.discrepancy).toMatchObject({ source: "ninjaone", status: "open", contracted: 18, observed: 19 });
    const onboarding = a.lines.find((l) => l.description === "Onboarding")!;
    expect(onboarding.status).toBe("not_recurring");
    expect(a.chargeMonthly).toBe(14 * 12 + 18 * 12);
    // Both lines are billed monthly, so what is invoiced equals the normalised figure and a year is 12 invoices.
    expect(a.billed).toEqual({ monthly: a.chargeMonthly, quarterly: 0, annual: 0, perYear: a.chargeMonthly * 12 });
    expect(p.totals.billed).toEqual(a.billed);
    expect(m365.chargePerPeriod).toBe(14 * 12);
    expect(onboarding.chargePerPeriod).toBe(0);
    expect(a.costMonthly).not.toBeNull();
    expect(a.marginMonthly).toBe(Math.round((a.chargeMonthly - a.costMonthly!) * 100) / 100);
    expect(p.totals.attention).toBeGreaterThanOrEqual(2);
    // The Acronis seats are supplied but on no line: listed under "other services" as unmapped.
    expect(p.otherServices.some((r) => /Acronis/.test(r.name) && r.state === "unmapped")).toBe(true);

    // A synced line turns the open count difference into a proposed change.
    const [devLine] = await db.select().from(contractLines).where(eq(contractLines.description, "Managed device"));
    await db.update(contractLines).set({ quantityRule: "synced" }).where(eq(contractLines.id, devLine.id));
    const c = (await contractBillingPicture(contractId, "2026-10-07"))!;
    expect(c.lines.find((l) => l.id === devLine.id)!.status).toBe("proposed_change");

    // Marking the Acronis seats free takes them out of "unmapped" but keeps them listed with the reason.
    const acronis = p.otherServices.find((r) => /Acronis/.test(r.name))!;
    await setServiceLink({ source: "pax8_subscription", sourceRowId: acronis.rowId, role: "free", reason: "goodwill", reviewOn: "2030-01-01" }, admin.id);
    const after = await companyBillingPicture(dental, "2026-10-07");
    expect(after.otherServices.find((r) => r.rowId === acronis.rowId)).toMatchObject({ state: "free", reason: "goodwill" });
  });
});
