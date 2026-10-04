import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { billingDiscrepancies, contractLines } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract, listContractLineChanges } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { demoNinjaAddDevice, demoNinjaReset } from "@/connectors/ninjaone/demo";
import { linkOrganization, listDiscrepancies, reopenExpiredExceptions, runDiscrepancyCheck, syncNinjaOne } from "@/services/ninjaone";
import { discrepancyOptions, previewDiscrepancyResolution, resolveDiscrepancy } from "@/services/discrepancy-actions";
import { discrepancyImpact } from "@/lib/discrepancy-impact";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  demoNinjaReset();
  admin = await makeUser("admin", "discrepancy admin");
});

const contract = { startDate: "2026-01-01", billingFrequency: "monthly", endDate: null, billingDay: null, renewalDate: "2026-12-31" };

describe("discrepancy impact (pure)", () => {
  it("pro-rates an increase for the rest of the current period and charges it in full after", () => {
    const i = discrepancyImpact({ difference: 2, unitPrice: 12, contract, reductionPolicy: "next_period", effectiveFrom: "2026-10-10", asOf: "2026-10-04", kind: "amend_line" });
    expect(i).toMatchObject({ perPeriod: 24, thisPeriod: 17.03, from: "2026-10-10", atStake: 24 });
    expect(i.note).toMatch(/22 of 31 days this period/);
  });
  it("applies a decrease by policy: next period, credited now, or at renewal", () => {
    expect(discrepancyImpact({ difference: -2, unitPrice: 12, contract, reductionPolicy: "next_period", effectiveFrom: "2026-10-10", asOf: "2026-10-04", kind: "amend_line" })).toMatchObject({ perPeriod: -24, thisPeriod: 0, from: "2026-11-01" });
    expect(discrepancyImpact({ difference: -2, unitPrice: 12, contract, reductionPolicy: "immediate", effectiveFrom: "2026-10-10", asOf: "2026-10-04", kind: "amend_line" })).toMatchObject({ perPeriod: -24, thisPeriod: -17.03, from: "2026-10-10" });
    expect(discrepancyImpact({ difference: -2, unitPrice: 12, contract, reductionPolicy: "next_period", effectiveFrom: "2026-10-10", asOf: "2026-10-04", kind: "reduce_at_renewal" })).toMatchObject({ perPeriod: -24, thisPeriod: 0, from: "2026-12-31" });
    expect(discrepancyImpact({ difference: -2, unitPrice: 12, contract: { ...contract, renewalDate: null }, reductionPolicy: "at_renewal", effectiveFrom: "2026-10-10", asOf: "2026-10-04", kind: "amend_line" }).from).toBe("2026-11-01");
  });
  it("states what stays at stake while an exception stands", () => {
    const i = discrepancyImpact({ difference: 3, unitPrice: 10, contract, reductionPolicy: "next_period", effectiveFrom: "2026-10-04", asOf: "2026-10-04", kind: "exception" });
    expect(i).toMatchObject({ perPeriod: 0, thisPeriod: 0, from: null, atStake: 30 });
    expect(i.note).toMatch(/£30.00 per period stays unbilled/);
  });
});

describe("discrepancy actions (NinjaOne demo adapter)", () => {
  it("amends the line as a dated change, reduces at renewal, accepts an exception with an owner and re-opens it after the review date", async () => {
    await syncNinjaOne("manual", admin.id);
    const dentalId = await createCompany(companySchema.parse({ name: "Harrowgate Dental Practice" }), admin.id);
    const freightId = await createCompany(companySchema.parse({ name: "Northern Freight Solutions Ltd" }), admin.id);
    await linkOrganization("101", dentalId, admin.id);
    await linkOrganization("102", freightId, admin.id);
    const line = (description: string, quantity: number) => ({ id: null, productId: null, siteId: null, description, revenueType: "recurring" as const, pricingModel: "per_device" as const, billingFrequency: "monthly" as const, quantity, unitPrice: 12, unitCost: 4, countsAsManagedDevice: true });
    const dentalContract = await createContract(contractSchema.parse({ companyId: dentalId, name: "MSA", startDate: "2026-01-01", status: "active" }), [line("Managed device", 18)], admin.id);
    const freightContract = await createContract(contractSchema.parse({ companyId: freightId, name: "MSA", startDate: "2026-01-01", status: "active", renewalDate: "2026-12-31" }), [line("Managed device", 40)], admin.id);
    await runDiscrepancyCheck(admin.id);
    const open = await listDiscrepancies({ status: "open" });
    const dental = open.find((d) => d.contractId === dentalContract)!;
    const freight = open.find((d) => d.contractId === freightContract)!;
    expect(dental.difference).toBe("1.00");
    expect(freight.difference).toBe("-2.00");

    // Options: an increase offers amend / exception / dismiss; a decrease with a renewal date also offers reduce at renewal.
    const dentalOpts = await discrepancyOptions(dental.id);
    expect(dentalOpts.kinds).toEqual(["amend_line", "exception", "dismiss"]);
    expect(dentalOpts.line).toMatchObject({ quantity: 18, newQuantity: 19 });
    expect(dentalOpts.impact.amend_line?.perPeriod).toBe(12);
    expect((await discrepancyOptions(freight.id)).kinds).toEqual(["amend_line", "reduce_at_renewal", "exception", "dismiss"]);
    expect((await previewDiscrepancyResolution(dental.id, "amend_line", "2026-10-10")).thisPeriod).toBe(8.52);

    // Amend: the line takes 19 from the chosen date, the change is in the history, the item is resolved and stays so after the re-check.
    const amended = await resolveDiscrepancy(dental.id, { kind: "amend_line", effectiveFrom: "2026-10-10", reason: "New PC agreed" }, admin.id);
    expect(amended).toMatchObject({ kind: "amend_line", newQuantity: 19, effectiveFrom: "2026-10-10" });
    const [dentalLine] = await db.select().from(contractLines).where(eq(contractLines.contractId, dentalContract));
    expect(Number(dentalLine.quantity)).toBe(19);
    const history = await listContractLineChanges(dentalContract);
    expect(history[0]).toMatchObject({ field: "quantity", previousValue: "18.00", newValue: "19.00", effectiveFrom: "2026-10-10", reason: "New PC agreed" });
    const [dentalAfter] = await db.select().from(billingDiscrepancies).where(eq(billingDiscrepancies.id, dental.id));
    expect(dentalAfter).toMatchObject({ status: "resolved", resolution: "amend_line", appliedChangeId: history[0].id });

    // Reduce at renewal: 38 from today but billed at 40 until the renewal date.
    const reduced = await resolveDiscrepancy(freight.id, { kind: "reduce_at_renewal", reason: "Two laptops returned" }, admin.id);
    expect(reduced).toMatchObject({ kind: "reduce_at_renewal", newQuantity: 38 });
    const [freightLine] = await db.select().from(contractLines).where(eq(contractLines.contractId, freightContract));
    expect(freightLine).toMatchObject({ quantity: "38.00", reductionPolicy: "at_renewal" });
    expect((await db.select().from(billingDiscrepancies).where(eq(billingDiscrepancies.id, freight.id)))[0]).toMatchObject({ status: "resolved", resolution: "reduce_at_renewal" });

    // A new device opens a fresh item; accept it as an exception with an owner and a review date, then let it expire.
    demoNinjaAddDevice(101, 1011, "HDP-EXTRA-PC");
    await syncNinjaOne("manual", admin.id);
    const [fresh] = await listDiscrepancies({ companyId: dentalId, status: "open" });
    expect(fresh.difference).toBe("1.00");
    await expect(resolveDiscrepancy(fresh.id, { kind: "exception", reason: "Leaving in March" }, admin.id)).rejects.toThrow(/needs an owner/);
    await expect(resolveDiscrepancy(fresh.id, { kind: "exception", ownerUserId: admin.id, reviewOn: "2020-01-01", reason: "x" }, admin.id)).rejects.toThrow(/review date in the future/);
    await resolveDiscrepancy(fresh.id, { kind: "exception", ownerUserId: admin.id, reviewOn: "2099-01-01", reason: "Customer leaving in March, agreed not to amend" }, admin.id);
    const [accepted] = await listDiscrepancies({ companyId: dentalId, status: "accepted" });
    expect(accepted).toMatchObject({ id: fresh.id, resolution: "exception", reviewOn: "2099-01-01", ownerName: "discrepancy admin" });
    // Still accepted on a re-check before the review date; re-opened once the date has passed.
    await runDiscrepancyCheck(admin.id, dentalId);
    expect((await db.select().from(billingDiscrepancies).where(eq(billingDiscrepancies.id, fresh.id)))[0].status).toBe("accepted");
    expect(await reopenExpiredExceptions("2099-01-02")).toBe(1);
    const [reopened] = await db.select().from(billingDiscrepancies).where(eq(billingDiscrepancies.id, fresh.id));
    expect(reopened.status).toBe("open");
    expect(reopened.note).toMatch(/^Exception expired on 2099-01-01 \(owner discrepancy admin\): Customer leaving/);
    // Dismiss closes it with the resolution recorded.
    await resolveDiscrepancy(fresh.id, { kind: "dismiss", reason: "Test device" }, admin.id);
    expect((await db.select().from(billingDiscrepancies).where(eq(billingDiscrepancies.id, fresh.id)))[0]).toMatchObject({ status: "dismissed", resolution: "dismiss" });
  });
});
