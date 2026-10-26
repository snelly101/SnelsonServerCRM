import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contractLineChanges, contractLines, invoiceDrafts } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { addContractLine, createContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { prepareInvoiceDraft, cancelInvoiceDraft } from "@/services/xero";
import { previewBillingRun, runBillingRun } from "@/services/billing-run";
import { oneOffLinesFor } from "@/services/billing-coverage";
import { setConnectionConfig } from "@/services/integrations";
import { makeUser } from "./helpers";

let admin: { id: string };
let companyId: string;
const recurring = (description: string, over: Record<string, unknown> = {}) => ({ id: null, productId: null, siteId: null, description, revenueType: "recurring" as const, pricingModel: "per_user" as const, billingFrequency: "monthly" as const, quantity: 10, unitPrice: 20, unitCost: null, countsAsManagedDevice: false, ...over });
const oneOff = (description: string, over: Record<string, unknown> = {}) => ({ id: null, productId: null, siteId: null, description, revenueType: "one_off_project" as const, pricingModel: "one_off" as const, billingFrequency: "one_off" as const, quantity: 1, unitPrice: 500, unitCost: null, countsAsManagedDevice: false, ...over });

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "one-off admin");
  await setConnectionConfig("xero", { defaultAccountCode: "200", hardwareAccountCode: "210", defaultTaxType: "OUTPUT2", dueDays: 30 }, admin.id);
  companyId = await createCompany(companySchema.parse({ name: "One-off Billing Ltd", status: "customer" }), admin.id);
});

describe("billing one-off lines on a contract", () => {
  it("the run proposes uninvoiced one-offs with the recurring period, bills each once, and a contract with only one-offs still gets a row", async () => {
    const contractId = await createContract(contractSchema.parse({ companyId, name: "Project agreement", reference: "PRJ-1", startDate: "2026-01-01", status: "active" }), [recurring("Users"), oneOff("Onboarding project"), oneOff("Firewall appliance", { revenueType: "hardware", pricingModel: "one_off", unitPrice: 1200 })], admin.id);
    const before = await oneOffLinesFor(contractId);
    expect(before.map((l) => [l.description, l.amount, l.invoicedOn])).toEqual([["Onboarding project", 500, null], ["Firewall appliance", 1200, null]]);

    const row = (await previewBillingRun("2026-10-05")).find((r) => r.contractId === contractId)!;
    expect(row.oneOffs.map((o) => o.description)).toEqual(["Onboarding project", "Firewall appliance"]);
    expect(row.oneOffNet).toBe(1700);
    expect(row.net).toBe(10 * 20 + 1700);

    const run = await runBillingRun("2026-10-05", [contractId], admin.id, { invoiceDate: "2026-10-01" });
    expect(run.created).toHaveLength(1);
    const [d] = await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, run.created[0].draftId));
    expect(d.reference).toBe("PRJ-1 2026-10");
    expect(d.description).toMatch(/includes 2 one-off lines/);
    const hardware = d.lines.find((l) => l.description === "Firewall appliance")!;
    expect(hardware).toMatchObject({ quantity: 1, unitAmount: 1200, accountCode: "210" });
    expect(hardware.calc).toBeUndefined();
    expect(d.lines.find((l) => l.description === "Onboarding project")!.accountCode).toBe("200");

    // Invoiced once: the next run proposes neither one-off again, and the contract page shows which draft carries them.
    const next = (await previewBillingRun("2026-11-05")).find((r) => r.contractId === contractId)!;
    expect(next.oneOffs).toEqual([]);
    expect((await oneOffLinesFor(contractId)).every((l) => l.invoicedOn?.draftId === d.id)).toBe(true);
    await expect(prepareInvoiceDraft({ companyId, contractId, oneOffLineIds: [before[0].id] }, admin.id)).rejects.toThrow(/already on draft PRJ-1 2026-10/);

    // Cancelling the draft hands the one-offs back.
    await cancelInvoiceDraft(d.id, admin.id);
    expect((await oneOffLinesFor(contractId)).every((l) => l.invoicedOn === null)).toBe(true);

    // A contract with nothing recurring is still billable for its one-offs, on its own draft, named as such.
    const projectOnly = await createContract(contractSchema.parse({ companyId, name: "Office move", reference: "MOVE-7", startDate: "2026-09-01", status: "active", billingFrequency: "one_off" }), [oneOff("Cabling"), oneOff("Rack and patch panel", { unitPrice: 300 })], admin.id);
    const pr = (await previewBillingRun("2026-10-05")).find((r) => r.contractId === projectOnly)!;
    expect(pr.skipReason).toBeNull();
    expect(pr.net).toBe(800);
    const only = await prepareInvoiceDraft({ companyId, contractId: projectOnly, oneOffLineIds: pr.oneOffs.map((o) => o.lineId), invoiceDate: "2026-10-03" }, admin.id);
    const [po] = await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, only));
    expect(po).toMatchObject({ reference: "MOVE-7 one-off 2026-10", invoiceDate: "2026-10-03", dueDate: "2026-11-02", periodStart: null, description: "Office move — one-off" });
    expect(Number(po.subTotal)).toBe(800);
    expect((await previewBillingRun("2026-10-05")).find((r) => r.contractId === projectOnly)!.skipReason).toBe("one-off contract: nothing recurs");
    await expect(prepareInvoiceDraft({ companyId, contractId: projectOnly, oneOffLineIds: [row.items[0].lineId] }, admin.id)).rejects.toThrow(/not a one-off line of this contract/);
  });

  it("a line added later starts on the day given and bills pro rata from it", async () => {
    const contractId = await createContract(contractSchema.parse({ companyId, name: "Growing agreement", startDate: "2026-01-01", status: "active" }), [recurring("Users")], admin.id);
    const added = await addContractLine(contractId, { ...recurring("Extra licences", { quantity: 4, unitPrice: 30 }), id: null }, admin.id, "started mid-month", "2026-10-16");
    const [change] = await db.select().from(contractLineChanges).where(eq(contractLineChanges.contractLineId, added.lineId));
    expect(change).toMatchObject({ previousValue: "0.00", newValue: "4.00", effectiveFrom: "2026-10-16" });
    const row = (await previewBillingRun("2026-10-20")).find((r) => r.contractId === contractId)!;
    const extra = row.lines.find((l) => l.contractLineId === added.lineId)!;
    // October: 4 added from the 16th, 16 of 31 days of 4 × 30, as an increase inside the period.
    expect(extra.calc).toMatchObject({ kind: "increase", quantity: 4, from: "2026-10-16", days: 16, fullDays: 31 });
    expect(extra.quantity * extra.unitAmount).toBeCloseTo(Math.round(((4 * 30 * 16) / 31) * 100) / 100, 2);
    await expect(addContractLine(contractId, { ...recurring("Bad date"), id: null }, admin.id, null, "16/10/2026")).rejects.toThrow(/YYYY-MM-DD/);
    expect(await db.select().from(contractLines).where(eq(contractLines.contractId, contractId))).toHaveLength(2);
  });
});

describe("ad hoc invoices", () => {
  it("drafts typed lines for a customer with the reference and date given, hardware to the hardware account", async () => {
    const id = await prepareInvoiceDraft({ companyId, adHoc: { reference: "CALLOUT-14NOV", lines: [{ description: "Out-of-hours call-out", quantity: 2, unitAmount: 95 }, { description: "Replacement switch", quantity: 1, unitAmount: 180, hardware: true }] }, invoiceDate: "2026-11-14" }, admin.id);
    const [d] = await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, id));
    expect(d).toMatchObject({ reference: "CALLOUT-14NOV 2026-11", invoiceDate: "2026-11-14", dueDate: "2026-12-14", contractId: null, opportunityId: null, description: "One-off Billing Ltd — ad hoc invoice" });
    expect(d.lines).toEqual([
      { description: "Out-of-hours call-out", quantity: 2, unitAmount: 95, accountCode: "200", taxType: "OUTPUT2" },
      { description: "Replacement switch", quantity: 1, unitAmount: 180, accountCode: "210", taxType: "OUTPUT2" },
    ]);
    expect(Number(d.subTotal)).toBe(370);
    // No reference typed: the customer's name.
    const id2 = await prepareInvoiceDraft({ companyId, adHoc: { lines: [{ description: "Advice", quantity: 1, unitAmount: 50 }] }, invoiceDate: "2026-11-14" }, admin.id);
    expect((await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, id2)))[0].reference).toBe("One-off Billing Ltd 2026-11");
    await expect(prepareInvoiceDraft({ companyId, adHoc: { lines: [] } }, admin.id)).rejects.toThrow(/at least one line/);
  });
});
