import { describe, expect, it, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, contractLineChanges, contractLines, contracts, hostingItems, pax8Subscriptions, serviceLinks } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract, getContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { createLineForService } from "@/services/service-matching";
import { companyServiceRegister } from "@/services/service-register";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  admin = await makeUser("admin", "matching admin");
});

const line = (over: Record<string, unknown>) => ({ id: null, productId: null, siteId: null, description: "x", revenueType: "recurring" as const, pricingModel: "per_user" as const, billingFrequency: "monthly" as const, quantity: 1, unitPrice: 10, unitCost: null, countsAsManagedDevice: false, ...over });

describe("creating the contract line an integration service is charged on", () => {
  it("adds the line to an active agreement as dated history, charges the service on it, and the register reads it as in step", async () => {
    const companyId = await createCompany(companySchema.parse({ name: "Matching Test Ltd", status: "customer" }), admin.id);
    const contractId = await createContract(contractSchema.parse({ companyId, name: "Managed IT", startDate: "2026-01-01", status: "active" }), [line({ description: "Managed user", quantity: 5, unitPrice: 30 })], admin.id);
    const [sub] = await db
      .insert(pax8Subscriptions)
      .values({ subscriptionId: "match-sub-1", pax8CompanyId: "match-co-1", companyId, productId: "p-1", productName: "Microsoft 365 Business Premium", vendorName: "Microsoft", sku: "CFQ7TTC0LCHC:0002", quantity: 7, status: "Active", price: "16.60", billingTerm: "Monthly", externalStatus: "active" })
      .returning({ id: pax8Subscriptions.id });

    const r = await createLineForService(
      { source: "pax8_subscription", sourceRowId: sub.id, contractId, line: { productId: null, siteId: null, description: "Microsoft 365 Business Premium", revenueType: "recurring", pricingModel: "per_user", billingFrequency: "monthly", quantity: 7, unitPrice: 19.5, unitCost: 16.6, countsAsManagedDevice: false, invoiceSchedule: "contract", reductionPolicy: "next_period", quantityRule: "synced" } },
      admin.id,
    );
    expect(r.contractId).toBe(contractId);
    expect(r.contractName).toBe("Managed IT");

    const c = (await getContract(contractId))!;
    const added = c.lines.find((l) => l.id === r.contractLineId)!;
    expect(added).toMatchObject({ description: "Microsoft 365 Business Premium", quantityRule: "synced", sortOrder: 1 });
    expect(Number(added.quantity)).toBe(7);
    // An active agreement records the new quantity as history from today, so the next invoice pro-rates it.
    const history = await db.select().from(contractLineChanges).where(eq(contractLineChanges.contractLineId, r.contractLineId));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ field: "quantity", previousValue: "0.00", newValue: "7.00" });
    expect(history[0].reason).toMatch(/pax8/i);
    // The service is charged on it, by a person.
    const [link] = await db.select().from(serviceLinks).where(and(eq(serviceLinks.source, "pax8_subscription"), eq(serviceLinks.sourceRowId, sub.id)));
    expect(link).toMatchObject({ role: "charged", contractLineId: r.contractLineId, matchSource: "manual" });
    const reg = await companyServiceRegister(companyId);
    expect(reg.rows.find((x) => x.rowId === sub.id)).toMatchObject({ state: "charged", line: { id: r.contractLineId } });
    expect(reg.summary.unmapped).toBe(0);
    const audits = await db.select({ action: auditLog.action, details: auditLog.details }).from(auditLog).where(eq(auditLog.entityId, contractId));
    expect(audits.some((a) => a.action === "contract.update" && (a.details as { lineAdded?: { id: string } }).lineAdded?.id === r.contractLineId)).toBe(true);
  });

  it("can start a new draft agreement for a customer without one, and refuses another company's contract", async () => {
    const companyId = await createCompany(companySchema.parse({ name: "Fresh Hosting Customer", status: "customer" }), admin.id);
    const other = await createCompany(companySchema.parse({ name: "Unrelated Co" }), admin.id);
    const otherContract = await createContract(contractSchema.parse({ companyId: other, name: "Other", startDate: "2026-01-01" }), [], admin.id);
    const [item] = await db.insert(hostingItems).values({ kind: "domain", externalId: "dom-match-1", name: "freshhosting.co.uk", matchDomain: "freshhosting.co.uk", typeName: "co.uk", enabled: true, expiresOn: "2027-03-01", companyId, externalStatus: "active" }).returning({ id: hostingItems.id });

    const base = { source: "hosting_item" as const, sourceRowId: item.id, line: { productId: null, siteId: null, description: "Domain renewal freshhosting.co.uk", revenueType: "recurring" as const, pricingModel: "fixed" as const, billingFrequency: "annual" as const, quantity: 1, unitPrice: 24, unitCost: null, countsAsManagedDevice: false, invoiceSchedule: "own" as const, reductionPolicy: "next_period" as const, quantityRule: "fixed" as const } };
    await expect(createLineForService({ ...base, contractId: otherContract }, admin.id)).rejects.toThrow(/different company/);
    await expect(createLineForService({ ...base }, admin.id)).rejects.toThrow(/Choose the agreement/);

    const r = await createLineForService({ ...base, newContract: { name: "Fresh Hosting agreement", startDate: "2026-11-01", billingFrequency: "monthly" } }, admin.id);
    const [c] = await db.select().from(contracts).where(eq(contracts.id, r.contractId));
    expect(c).toMatchObject({ companyId, name: "Fresh Hosting agreement", status: "draft", billingFrequency: "monthly", startDate: "2026-11-01" });
    const [l] = await db.select().from(contractLines).where(eq(contractLines.id, r.contractLineId));
    expect(l).toMatchObject({ contractId: r.contractId, billingFrequency: "annual", invoiceSchedule: "own", pricingModel: "fixed" });
    // A draft has never been invoiced, so no dated history is written for it.
    expect(await db.select().from(contractLineChanges).where(eq(contractLineChanges.contractLineId, r.contractLineId))).toHaveLength(0);
    const [link] = await db.select().from(serviceLinks).where(and(eq(serviceLinks.source, "hosting_item"), eq(serviceLinks.sourceRowId, item.id)));
    expect(link).toMatchObject({ role: "charged", contractLineId: r.contractLineId });
  });
});
