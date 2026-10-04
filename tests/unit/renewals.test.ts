import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, pax8Subscriptions } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract, updateContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { syncPax8 } from "@/services/pax8";
import { clearRenewalDecision, recordRenewalDecision, renewalQueue, supplierMismatch } from "@/services/renewals";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "renewals admin");
});

describe("supplier mismatch (pure)", () => {
  it("flags a commitment that outlasts the renewal, one that renews first, and nothing otherwise", () => {
    expect(supplierMismatch("2026-12-31", "2027-09-30", "2026-10-04")).toBe("supplier_outlasts");
    expect(supplierMismatch("2026-12-31", "2026-11-15", "2026-10-04")).toBe("supplier_renews_first");
    expect(supplierMismatch("2026-12-31", "2026-12-31", "2026-10-04")).toBeNull();
    expect(supplierMismatch("2026-12-31", "2026-09-01", "2026-10-04")).toBeNull(); // already passed: nothing to decide
    expect(supplierMismatch("2026-12-31", null, "2026-10-04")).toBeNull();
  });
});

describe("renewal queue (Pax8 demo adapter)", () => {
  it("orders contracts by decision deadline with the lead time, sets supplier commitments against the renewal, and records decisions per renewal date", async () => {
    await db.update(appSettings).set({ renewalLeadDays: 30 }).where(eq(appSettings.id, 1));
    const dental = await createCompany(companySchema.parse({ name: "Harrowgate Dental Practice", status: "customer", website: "https://www.harrowgatedental.co.uk" }), admin.id);
    const line = (over: Record<string, unknown>) => ({ id: null, productId: null, siteId: null, description: "x", revenueType: "recurring" as const, pricingModel: "per_user" as const, billingFrequency: "monthly" as const, quantity: 1, unitPrice: 10, unitCost: null, countsAsManagedDevice: false, ...over });
    // Renewal 31 Dec, 90 days notice → notice by 2 Oct, decide by 2 Sep: overdue on 4 Oct.
    const terms = contractSchema.parse({ companyId: dental, name: "Managed IT", startDate: "2026-01-01", status: "active", renewalDate: "2026-12-31", noticePeriodDays: 90 });
    const contractId = await createContract(terms, [line({ description: "Microsoft 365 Business Standard", quantity: 14, unitPrice: 12 })], admin.id);
    await syncPax8("manual", admin.id);
    // Give the matched subscription a commitment that outlasts the agreement.
    const [sub] = await db.select().from(pax8Subscriptions).where(eq(pax8Subscriptions.companyId, dental));
    expect(sub).toBeTruthy();
    const m365 = (await db.select().from(pax8Subscriptions).where(eq(pax8Subscriptions.companyId, dental))).find((s) => /Business Standard/.test(s.productName))!;
    await db.update(pax8Subscriptions).set({ commitmentEndsOn: "2027-09-30", commitmentTerm: "Annual" }).where(eq(pax8Subscriptions.id, m365.id));

    const queue = await renewalQueue("2026-10-04");
    const row = queue.find((r) => r.contractId === contractId)!;
    expect(row).toMatchObject({ renewalDate: "2026-12-31", noticeDeadline: "2026-10-02", decideBy: "2026-09-02", daysToDecide: -32, status: "overdue", mrr: 168, decision: null });
    const svc = row.services.find((s) => /Business Standard/.test(s.name))!;
    expect(svc).toMatchObject({ mismatch: "supplier_outlasts", supplierEndsOn: "2027-09-30", exposureMonths: 9, lineDescription: "Microsoft 365 Business Standard" });
    expect(svc.exposure).toBeGreaterThan(0);
    expect(row.exposureTotal).toBe(svc.exposure);
    expect(row.mismatches[0]).toMatch(/^Microsoft 365 Business Standard: the agreement renews on 2026-12-31 but the supplier commitment runs to 2027-09-30/);

    // A planned change after the run date shows as planned quantities.
    await updateContract(contractId, terms, [line({ id: null, description: "Microsoft 365 Business Standard", quantity: 16, unitPrice: 12 })], admin.id, { quantityEffectiveFrom: "2026-12-31", changeReason: "agreed at renewal" });
    const planned = (await renewalQueue("2026-10-04")).find((r) => r.contractId === contractId)!;
    expect(planned.planned.some((p) => p.effectiveFrom === "2026-12-31" && p.newValue === "16.00")).toBe(true);

    // With a longer lead the same contract is merely "due"; a decision moves it to decided and is tied to the renewal date.
    await db.update(appSettings).set({ renewalLeadDays: 120 }).where(eq(appSettings.id, 1));
    expect((await renewalQueue("2026-06-01")).find((r) => r.contractId === contractId)!.status).toBe("due");
    await expect(recordRenewalDecision(contractId, { decision: "not_renewing" }, admin.id)).rejects.toThrow(/why/);
    await recordRenewalDecision(contractId, { decision: "amend", note: "Drop to 12 users, confirmed by email" }, admin.id);
    const decided = (await renewalQueue("2026-10-04")).find((r) => r.contractId === contractId)!;
    expect(decided.status).toBe("decided");
    expect(decided.decision).toMatchObject({ kind: "amend", by: "renewals admin", note: "Drop to 12 users, confirmed by email" });
    // Moving the renewal date makes the old decision irrelevant.
    await updateContract(contractId, { ...terms, renewalDate: "2027-12-31" }, null, admin.id);
    expect((await renewalQueue("2026-10-04")).find((r) => r.contractId === contractId)!.decision).toBeNull();
    await clearRenewalDecision(contractId, admin.id);
    const [cleared] = await renewalQueue("2026-10-04", { contractId });
    expect(cleared.decision).toBeNull();
  });
});
