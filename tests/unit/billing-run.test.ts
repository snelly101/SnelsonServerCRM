import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { invoiceDrafts } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { currentBillingPeriod, previewBillingRun, runBillingRun } from "@/services/billing-run";
import { cancelInvoiceDraft } from "@/services/xero";
import { makeUser } from "./helpers";

let admin: { id: string };
let companyId: string;

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("finance", "billing runner");
  companyId = await createCompany(companySchema.parse({ name: "Billing Run Customer Ltd", status: "customer", website: "billingrun.example" }), admin.id);
});

const line = (over: Record<string, unknown>) => ({ id: null, productId: null, siteId: null, description: "Line", revenueType: "recurring", pricingModel: "per_user", billingFrequency: "monthly", quantity: 1, unitPrice: 10, unitCost: null, countsAsManagedDevice: false, ...over }) as Parameters<typeof createContract>[1][number];

describe("billing periods", () => {
  it("anchors periods to the contract start date, bills in advance, clamps month ends and respects start/end dates", () => {
    expect(currentBillingPeriod("2026-01-15", "monthly", "2026-10-02")).toEqual({ periodStart: "2026-09-15", periodEnd: "2026-10-14" });
    expect(currentBillingPeriod("2026-01-15", "monthly", "2026-09-15")).toEqual({ periodStart: "2026-09-15", periodEnd: "2026-10-14" });
    expect(currentBillingPeriod("2026-01-15", "monthly", "2026-09-14")).toEqual({ periodStart: "2026-08-15", periodEnd: "2026-09-14" });
    expect(currentBillingPeriod("2026-01-01", "quarterly", "2026-10-02")).toEqual({ periodStart: "2026-10-01", periodEnd: "2026-12-31" });
    expect(currentBillingPeriod("2025-06-01", "annual", "2026-10-02")).toEqual({ periodStart: "2026-06-01", periodEnd: "2027-05-31" });
    // A 31st anchor keeps clamping to the month end rather than drifting.
    expect(currentBillingPeriod("2026-01-31", "monthly", "2026-03-05")).toEqual({ periodStart: "2026-02-28", periodEnd: "2026-03-30" });
    expect(currentBillingPeriod("2026-01-31", "monthly", "2026-04-01")).toEqual({ periodStart: "2026-03-31", periodEnd: "2026-04-29" });
    // Not started, ended, or one-off: nothing to bill. An end date inside the period shortens it.
    expect(currentBillingPeriod("2026-11-01", "monthly", "2026-10-02")).toBeNull();
    expect(currentBillingPeriod("2025-01-01", "monthly", "2026-10-02", "2026-09-30")).toBeNull();
    expect(currentBillingPeriod("2026-01-01", "one_off", "2026-10-02")).toBeNull();
    expect(currentBillingPeriod("2026-01-15", "monthly", "2026-10-02", "2026-10-05")).toEqual({ periodStart: "2026-09-15", periodEnd: "2026-10-05" });
  });
});

describe("billing run (demo adapter)", () => {
  it("previews the current period per active contract, skips drafts, one-off and recurring-less contracts, creates one draft each, and is safe to repeat", async () => {
    const monthly = await createContract(
      contractSchema.parse({ companyId, name: "Monthly MSA", startDate: "2026-01-15", status: "active", billingFrequency: "monthly" }),
      [line({ description: "Users", quantity: 10, unitPrice: 40 }), line({ description: "Annual licence", pricingModel: "fixed", billingFrequency: "annual", quantity: 1, unitPrice: 1200 }), line({ description: "Setup", revenueType: "one_off_project", pricingModel: "one_off", billingFrequency: "one_off", unitPrice: 500 })],
      admin.id,
    );
    const quarterly = await createContract(contractSchema.parse({ companyId, name: "Quarterly hosting", startDate: "2026-01-01", status: "active", billingFrequency: "quarterly" }), [line({ description: "Hosting", pricingModel: "fixed", billingFrequency: "quarterly", unitPrice: 300 })], admin.id);
    const oneOffOnly = await createContract(contractSchema.parse({ companyId, name: "Project only", startDate: "2026-01-01", status: "active", billingFrequency: "monthly" }), [line({ description: "Project", revenueType: "one_off_project", pricingModel: "one_off", billingFrequency: "one_off", unitPrice: 999 })], admin.id);
    await createContract(contractSchema.parse({ companyId, name: "Draft MSA", startDate: "2026-01-01", status: "draft" }), [line({})], admin.id);
    const future = await createContract(contractSchema.parse({ companyId, name: "Starts later", startDate: "2027-01-01", status: "active" }), [line({})], admin.id);

    const preview = await previewBillingRun("2026-10-02");
    const byId = new Map(preview.map((r) => [r.contractId, r]));
    expect(byId.has(monthly) && byId.has(quarterly) && byId.has(oneOffOnly) && byId.has(future)).toBe(true);
    expect(preview.some((r) => r.contractName === "Draft MSA")).toBe(false);
    // Monthly: 10 × 40 plus the annual licence spread (1200 / 12); the one-off line is not recurring.
    expect(byId.get(monthly)).toMatchObject({ period: { periodStart: "2026-09-15", periodEnd: "2026-10-14" }, net: 500, lineCount: 2, skipReason: null });
    expect(byId.get(quarterly)).toMatchObject({ period: { periodStart: "2026-10-01", periodEnd: "2026-12-31" }, net: 300, lineCount: 1, skipReason: null });
    expect(byId.get(oneOffOnly)!.skipReason).toBe("no recurring lines");
    expect(byId.get(future)!.skipReason).toBe("starts 2027-01-01");

    const run = await runBillingRun("2026-10-02", [monthly, quarterly, oneOffOnly, future], admin.id);
    expect(run.created.map((c) => c.contractId).sort()).toEqual([monthly, quarterly].sort());
    expect(run.skipped.map((s) => s.contractId).sort()).toEqual([oneOffOnly, future].sort());
    const monthlyDraft = (await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.contractId, monthly)))[0];
    expect(monthlyDraft).toMatchObject({ periodStart: "2026-09-15", periodEnd: "2026-10-14", status: "draft" });
    expect(Number(monthlyDraft.subTotal)).toBe(500);
    expect(monthlyDraft.lines.map((l) => l.description)).toEqual(["Users (2026-09-15 to 2026-10-14)", "Annual licence (2026-09-15 to 2026-10-14)"]);

    // Second run for the same date: the period is already drafted, nothing new.
    const again = await previewBillingRun("2026-10-02");
    expect(again.find((r) => r.contractId === monthly)!.skipReason).toMatch(/^already drafted \(CRM-/);
    const rerun = await runBillingRun("2026-10-02", [monthly, quarterly], admin.id);
    expect(rerun.created).toHaveLength(0);
    expect(rerun.skipped).toHaveLength(2);
    expect((await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.contractId, monthly))).length).toBe(1);

    // A cancelled draft does not count as billed; next month is a new period anyway.
    await cancelInvoiceDraft(monthlyDraft.id, admin.id);
    expect((await previewBillingRun("2026-10-02")).find((r) => r.contractId === monthly)!.skipReason).toBeNull();
    expect((await previewBillingRun("2026-10-20")).find((r) => r.contractId === monthly)).toMatchObject({ period: { periodStart: "2026-10-15", periodEnd: "2026-11-14" }, skipReason: null });
    expect((await previewBillingRun("2026-10-20")).find((r) => r.contractId === quarterly)!.skipReason).toMatch(/already drafted/);
  });
});
