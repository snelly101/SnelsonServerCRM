import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contractLines, invoiceDrafts } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract, getContract, listContractLineChanges, updateContract } from "@/services/contracts";
import { prepareInvoiceDraft } from "@/services/xero";
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

  it("pro-rates: a billing-day contract starting mid-month bills the stub first; quantity changes keep the line id, are kept as dated history, billed pro rata, caught up next period, marked as accounted for, and handed back when the draft is cancelled", async () => {
    // Starts on the 20th, bills on the 1st: September is a 11-day stub.
    const id = await createContract(
      contractSchema.parse({ companyId, name: "Anchored MSA", startDate: "2026-09-20", status: "active", billingFrequency: "monthly", billingDay: "1" }),
      [line({ description: "Users", quantity: 10, unitPrice: 30 })],
      admin.id,
    );
    const stub = (await previewBillingRun("2026-09-25")).find((r) => r.contractId === id)!;
    expect(stub.period).toMatchObject({ periodStart: "2026-09-20", periodEnd: "2026-09-30", fullDays: 30, days: 11 });
    expect(stub.net).toBe(110);
    const sept = await runBillingRun("2026-09-25", [id], admin.id);
    const septDraft = (await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, sept.created[0].draftId)))[0];
    expect(septDraft.lines).toEqual([expect.objectContaining({ description: "Users (2026-09-20 to 2026-09-30): 10 × 30.00, 11 of 30 days (pro rata)", quantity: 1, unitAmount: 110 })]);

    // October is a whole month. Then on the 12th the customer adds 3 users; the edit keeps the line id and dates the change.
    const oct = await runBillingRun("2026-10-01", [id], admin.id);
    expect(Number((await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, oct.created[0].draftId)))[0].subTotal)).toBe(300);
    const before = (await getContract(id))!;
    const lineId = before.lines[0].id;
    await updateContract(
      id,
      contractSchema.parse({ companyId, name: "Anchored MSA", startDate: "2026-09-20", status: "active", billingFrequency: "monthly", billingDay: "1" }),
      [line({ id: lineId, description: "Users", quantity: 13, unitPrice: 30 })],
      admin.id,
      { quantityEffectiveFrom: "2026-10-12" },
    );
    const [changed] = await db.select().from(contractLines).where(eq(contractLines.contractId, id));
    expect(changed).toMatchObject({ id: lineId, quantity: "13.00" });
    let history = await listContractLineChanges(id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ contractLineId: lineId, field: "quantity", previousValue: "10.00", newValue: "13.00", effectiveFrom: "2026-10-12", settledByDraftId: null });
    // A second change before invoicing is its own dated row, with the reason kept.
    await updateContract(id, contractSchema.parse({ companyId, name: "Anchored MSA", startDate: "2026-09-20", status: "active", billingFrequency: "monthly", billingDay: "1" }), [line({ id: lineId, description: "Users", quantity: 14, unitPrice: 30 })], admin.id, { quantityEffectiveFrom: "2026-10-20", changeReason: "one more starter" });
    history = await listContractLineChanges(id);
    expect(history.map((h) => [h.previousValue, h.newValue, h.effectiveFrom, h.reason])).toEqual([
      ["13.00", "14.00", "2026-10-20", "one more starter"],
      ["10.00", "13.00", "2026-10-12", null],
    ]);
    expect((await getContract(id))!.lines[0].pendingChanges.map((h) => h.effectiveFrom)).toEqual(["2026-10-12", "2026-10-20"]);

    // November's run: catch-up for 3 users over 20 October days plus 1 user over 12, then November at 14. The changes are marked as accounted for by that draft.
    const nov = (await previewBillingRun("2026-11-01")).find((r) => r.contractId === id)!;
    expect(nov.net).toBe(420 + 69.67); // 3×30×20/31 = 58.06, 1×30×12/31 = 11.61
    const run = await runBillingRun("2026-11-01", [id], admin.id);
    const novDraft = (await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, run.created[0].draftId)))[0];
    expect(novDraft.lines.map((l) => [l.description, l.quantity, l.unitAmount])).toEqual([
      ["Users: adjustment for 2026-10-01 to 2026-10-31 (2 changes, previous period)", 1, 69.67],
      ["Users (2026-11-01 to 2026-11-30)", 14, 30],
    ]);
    expect(novDraft.lines[0].calc).toMatchObject({ kind: "catchup", expected: 369.67, billedBefore: 300 });
    history = await listContractLineChanges(id);
    expect(history.every((h) => h.settledByDraftId === novDraft.id)).toBe(true);
    expect((await getContract(id))!.lines[0].pendingChanges).toEqual([]);
    // Cancelling that draft hands the changes back, and the next run carries the same catch-up again: nothing lost, nothing doubled.
    await cancelInvoiceDraft(novDraft.id, admin.id);
    expect((await listContractLineChanges(id)).every((h) => h.settledByDraftId === null)).toBe(true);
    const again = await runBillingRun("2026-11-01", [id], admin.id);
    const redo = (await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, again.created[0].draftId)))[0];
    expect(redo.lines.map((l) => l.unitAmount)).toEqual([69.67, 30]);
    expect((await listContractLineChanges(id)).every((h) => h.settledByDraftId === redo.id)).toBe(true);
    // Removing the line on the active contract keeps its history with the description.
    await updateContract(id, contractSchema.parse({ companyId, name: "Anchored MSA", startDate: "2026-09-20", status: "active", billingFrequency: "monthly", billingDay: "1" }), [], admin.id, { quantityEffectiveFrom: "2026-12-01", changeReason: "service ended" });
    const after = await listContractLineChanges(id);
    expect(after[0]).toMatchObject({ contractLineId: null, lineDescription: "Users", previousValue: "14.00", newValue: "0.00", reason: "service ended" });
    expect(after).toHaveLength(3);
  });

  it("lines on their own cycle: an annual domain on a monthly contract is invoiced once a year, not a twelfth a month, and the run never proposes a covered period again", async () => {
    const id = await createContract(
      contractSchema.parse({ companyId, name: "Mixed cycles", startDate: "2026-03-10", status: "active", billingFrequency: "monthly" }),
      [line({ description: "Support", quantity: 5, unitPrice: 20 }), line({ description: "Domain", pricingModel: "fixed", billingFrequency: "annual", quantity: 1, unitPrice: 120, invoiceSchedule: "own" }), line({ description: "Spread licence", pricingModel: "fixed", billingFrequency: "annual", quantity: 1, unitPrice: 240 })],
      admin.id,
    );
    // First run in the first month: support for the month, the domain for the year, the spread licence as a twelfth.
    const first = (await previewBillingRun("2026-03-12")).find((r) => r.contractId === id)!;
    expect(first.items.map((i) => [i.description, i.period.periodStart, i.period.periodEnd, i.months])).toEqual([
      ["Support", "2026-03-10", "2026-04-09", 1],
      ["Domain", "2026-03-10", "2027-03-09", 12],
      ["Spread licence", "2026-03-10", "2026-04-09", 1],
    ]);
    expect(first.net).toBe(100 + 120 + 20);
    const run = await runBillingRun("2026-03-12", [id], admin.id);
    const draft = (await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, run.created[0].draftId)))[0];
    expect(draft).toMatchObject({ periodStart: "2026-03-10", periodEnd: "2027-03-09" });
    expect(draft.lines.map((l) => [l.description, l.unitAmount])).toEqual([
      ["Support (2026-03-10 to 2026-04-09)", 20],
      ["Spread licence (2026-03-10 to 2026-04-09)", 20],
      ["Domain (2026-03-10 to 2027-03-09)", 120],
    ]);
    // Next month: the domain's year is covered, only the monthly items are due.
    const second = (await previewBillingRun("2026-04-12")).find((r) => r.contractId === id)!;
    expect(second.items.map((i) => i.description)).toEqual(["Support", "Spread licence"]);
    expect(second.net).toBe(120);
    // Next year's first month: the domain is due again.
    const year = (await previewBillingRun("2027-03-12")).find((r) => r.contractId === id)!;
    expect(year.items.map((i) => [i.description, i.period.periodStart])).toContainEqual(["Domain", "2027-03-10"]);
    // Manual preparation for the April period picks up the monthly lines only; the domain's own period does not start inside it.
    const manual = await prepareInvoiceDraft({ companyId, contractId: id, periodStart: "2026-04-10", periodEnd: "2026-05-09" }, admin.id);
    const manualDraft = (await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, manual)))[0];
    expect(manualDraft.lines.map((l) => l.description)).toEqual(["Support (2026-04-10 to 2026-05-09)", "Spread licence (2026-04-10 to 2026-05-09)"]);
    expect((await previewBillingRun("2026-04-12")).find((r) => r.contractId === id)!.skipReason).toMatch(/already drafted/);
  });

  it("missed periods: with a billing-from date, earlier uncovered periods are proposed and flagged; without one only the current period is", async () => {
    const id = await createContract(
      contractSchema.parse({ companyId, name: "Imported mid-life", startDate: "2025-01-01", status: "active", billingFrequency: "monthly", billingDay: "1" }),
      [line({ description: "Users", quantity: 4, unitPrice: 25 })],
      admin.id,
    );
    const quiet = (await previewBillingRun("2026-10-05")).find((r) => r.contractId === id)!;
    expect(quiet.items).toHaveLength(1);
    expect(quiet.missedCount).toBe(0);
    // Billing in the CRM began on 1 August: August and September were never drafted.
    await updateContract(id, contractSchema.parse({ companyId, name: "Imported mid-life", startDate: "2025-01-01", status: "active", billingFrequency: "monthly", billingDay: "1", billingFrom: "2026-08-01" }), null, admin.id);
    const row = (await previewBillingRun("2026-10-05")).find((r) => r.contractId === id)!;
    expect(row.items.map((i) => [i.period.periodStart, i.missed])).toEqual([
      ["2026-08-01", true],
      ["2026-09-01", true],
      ["2026-10-01", false],
    ]);
    expect(row.missedCount).toBe(2);
    expect(row.net).toBe(300);
    const run = await runBillingRun("2026-10-05", [id], admin.id);
    expect(run.created[0].missed).toBe(2);
    const draft = (await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, run.created[0].draftId)))[0];
    expect(draft).toMatchObject({ periodStart: "2026-08-01", periodEnd: "2026-10-31" });
    expect(draft.description).toMatch(/includes 2 missed periods/);
    expect(draft.lines.map((l) => l.description)).toEqual(["Users (2026-08-01 to 2026-08-31)", "Users (2026-09-01 to 2026-09-30)", "Users (2026-10-01 to 2026-10-31)"]);
    // Everything up to October is covered now; November is the only thing due next month.
    expect((await previewBillingRun("2026-10-20")).find((r) => r.contractId === id)!.skipReason).toMatch(/already drafted/);
    const nov = (await previewBillingRun("2026-11-03")).find((r) => r.contractId === id)!;
    expect(nov.items.map((i) => [i.period.periodStart, i.missed])).toEqual([["2026-11-01", false]]);
  });
});
