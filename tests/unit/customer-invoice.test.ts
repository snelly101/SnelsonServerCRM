import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contractLineChanges, contractLines, invoiceDrafts, type InvoiceDraftLine } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract, updateContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { previewBillingRun, runBillingRun } from "@/services/billing-run";
import { cancelInvoiceDraft, getInvoiceDraft, listInvoiceDrafts, reprepareInvoiceDraft } from "@/services/xero";
import { reviewPendingDrafts } from "@/services/draft-review";
import { customerExplanation } from "@/lib/customer-explanation";
import { customerSchedule } from "@/services/customer-schedule";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("finance", "customer invoice finance");
});

const money = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(n);
const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const dl = (over: Partial<InvoiceDraftLine> & { description: string; quantity: number; unitAmount: number }): InvoiceDraftLine => ({ accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1", calc: null, ...over });

describe("customer explanation (pure)", () => {
  it("reads the brief's example from the calculated lines", () => {
    const lines = [
      dl({ description: "Microsoft 365 Business Standard (1 Nov 2026 to 30 Nov 2026)", quantity: 16, unitAmount: 12, calc: { kind: "period", quantity: 16, unitPerPeriod: 12, from: "2026-11-01", to: "2026-11-30" } }),
      dl({ description: "Microsoft 365 Business Standard: 2 added from 14 Oct 2026", quantity: 2, unitAmount: 5.46, calc: { kind: "increase", quantity: 2, unitPerPeriod: 12, from: "2026-10-14", to: "2026-10-31", days: 18, fullDays: 31 } }),
    ];
    const e = customerExplanation(lines, { money, date });
    expect(e.summary).toBe("Your charge for 1 November 2026 to 30 November 2026 includes 16 × Microsoft 365 Business Standard, plus £10.92 for 2 × Microsoft 365 Business Standard added on 14 October 2026.");
    expect(e.lines).toHaveLength(2);
    expect(e).toMatchObject({ from: "2026-11-01", to: "2026-11-30" });
  });
  it("words credits, adjustments, pro rata and hand-typed lines", () => {
    const lines = [
      dl({ description: "Backup (15 Nov 2026 to 30 Nov 2026)", quantity: 1, unitAmount: 26.67, calc: { kind: "prorata", quantity: 1, unitPerPeriod: 50, from: "2026-11-15", to: "2026-11-30", days: 16, fullDays: 30 } }),
      dl({ description: "Users: 1 removed from 20 Nov 2026", quantity: -1, unitAmount: 14.67, calc: { kind: "decrease", quantity: 1, unitPerPeriod: 40, from: "2026-11-20", to: "2026-11-30", days: 11, fullDays: 30 } }),
      dl({ description: "Users: adjustment", quantity: 1, unitAmount: -8, calc: { kind: "catchup", quantity: -1, unitPerPeriod: 40, from: "2026-10-01", to: "2026-10-31", expected: 392, billedBefore: 400 } }),
      dl({ description: "Onboarding visit", quantity: 1, unitAmount: 150, contractLineId: null }),
    ];
    const e = customerExplanation(lines, { money, date });
    expect(e.summary).toBe("Your charge for 15 November 2026 to 30 November 2026 includes 1 × Backup from 15 November 2026 (16 of 30 days), plus a credit of £14.67 for 1 × Users removed on 20 November 2026, a credit of £8.00 for Users between 1 October 2026 and 31 October 2026 (changes made after that period was invoiced) and £150.00 for Onboarding visit.");
  });
});

describe("consolidated customer drafts and PO reference (demo adapter)", () => {
  it("drafts one invoice for several agreements, covers each, carries the PO, re-prepares and reviews as one", async () => {
    const companyId = await createCompany(companySchema.parse({ name: "Consolidated Customer Ltd", status: "customer", website: "consolidated.example" }), admin.id);
    const line = (over: Record<string, unknown>) => ({ id: null, productId: null, siteId: null, description: "x", revenueType: "recurring" as const, pricingModel: "per_user" as const, billingFrequency: "monthly" as const, quantity: 1, unitPrice: 10, unitCost: null, countsAsManagedDevice: false, ...over });
    const msa = await createContract(contractSchema.parse({ companyId, name: "Managed IT", startDate: "2026-01-01", status: "active", purchaseOrderRef: "PO-2026-118" }), [line({ description: "Users", quantity: 10, unitPrice: 40 })], admin.id);
    const hosting = await createContract(contractSchema.parse({ companyId, name: "Hosting", startDate: "2026-01-01", status: "active" }), [line({ description: "Web hosting", pricingModel: "fixed", quantity: 1, unitPrice: 30 })], admin.id);

    const run = await runBillingRun("2026-10-05", [msa, hosting], admin.id, { consolidate: true });
    expect(run.created).toHaveLength(1);
    expect(run.created[0]).toMatchObject({ consolidated: 2, net: 430, contractName: "Hosting + Managed IT" });
    const draft = (await getInvoiceDraft(run.created[0].draftId))!;
    expect(draft.contractId).toBeNull();
    expect(draft.contractIds).toEqual([hosting, msa]);
    expect(draft.purchaseOrderRef).toBe("PO-2026-118");
    expect(draft.lines.map((l) => l.description)).toEqual(["Hosting · Web hosting (2026-10-01 to 2026-10-31)", "Managed IT · Users (2026-10-01 to 2026-10-31)"]);
    expect(draft.periodStart).toBe("2026-10-01");
    // Both agreements are covered for October: the run proposes nothing more.
    const again = await previewBillingRun("2026-10-05");
    expect(again.find((r) => r.contractId === msa)!.skipReason).toMatch(/already drafted/);
    expect(again.find((r) => r.contractId === hosting)!.skipReason).toMatch(/already drafted/);
    // The schedule groups by agreement and carries the PO and the plain-language summary.
    const schedule = await customerSchedule(draft, { currency: "GBP", dateFormat: "d MMM yyyy", timezone: "Europe/London" } as never);
    expect(schedule.groups.map((g) => g.title)).toEqual(["Hosting", "Managed IT"]);
    expect(schedule.summary).toMatch(/^Your charge for 1 Oct 2026 to 31 Oct 2026 includes 1 × Web hosting and 10 × Users\.$/);

    // A change on one agreement makes the consolidated draft stale; re-preparing yields a fresh consolidated draft with the change.
    const [usersLine] = await db.select({ id: contractLines.id }).from(contractLines).where(eq(contractLines.contractId, msa));
    await updateContract(msa, contractSchema.parse({ companyId, name: "Managed IT", startDate: "2026-01-01", status: "active", purchaseOrderRef: "PO-2026-118" }), [line({ id: usersLine.id, description: "Users", quantity: 12, unitPrice: 40 })], admin.id, { quantityEffectiveFrom: "2026-10-10", changeReason: "two starters" });
    const stale = (await listInvoiceDrafts("all")).find((d) => d.id === draft.id)!;
    expect(stale.stale).toBe(true);
    const newId = await reprepareInvoiceDraft(draft.id, admin.id);
    const fresh = (await getInvoiceDraft(newId))!;
    expect(fresh.contractIds).toEqual([hosting, msa]);
    expect(fresh.lines.some((l) => l.calc?.kind === "increase")).toBe(true);
    expect(fresh.subTotal).toBe("486.77"); // 430 + 2 × 40 × 22/31
    expect((await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, draft.id)))[0].status).toBe("cancelled");
    const settled = await db.select().from(contractLineChanges).where(eq(contractLineChanges.contractId, msa));
    expect(settled.every((c) => c.settledByDraftId === newId)).toBe(true);
    // The review sees it as contract-sourced (first consolidated invoice); cancelling releases both agreements.
    const review = (await reviewPendingDrafts("GBP")).find((d) => d.id === newId)!;
    expect(review.flags).toContain("First consolidated invoice for these agreements");
    await cancelInvoiceDraft(newId, admin.id);
    const after = await previewBillingRun("2026-10-05");
    expect(after.find((r) => r.contractId === msa)!.skipReason).toBeNull();
    expect(after.find((r) => r.contractId === hosting)!.skipReason).toBeNull();
  });
});
