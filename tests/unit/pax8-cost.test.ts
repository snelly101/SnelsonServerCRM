import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pax8InvoiceItems, pax8Invoices, pax8Subscriptions } from "@/db/schema";
import { syncPax8, pax8Totals, pax8InvoiceAllocation } from "@/services/pax8";
import { pax8BillingAdapter } from "@/connectors/pax8/billing";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "pax8 cost admin");
  // The demo Pax8 company links itself to a CRM company with the same website domain.
  await createCompany(companySchema.parse({ name: "Harrowgate Dental Practice", status: "customer", website: "https://www.harrowgatedental.co.uk" }), admin.id, { skipDuplicateCheck: true });
  await syncPax8("manual", admin.id);
});

describe("Pax8 cost is the partner cost, never the customer price", () => {
  it("mirrors both prices and every cost figure comes from partnerCost", async () => {
    const [s] = await db.select().from(pax8Subscriptions).where(eq(pax8Subscriptions.subscriptionId, "s-1001"));
    expect(s.partnerCost).toBe("9.4000");
    expect(s.price).toBe("11.2800");
    expect(s.companyId).toBeTruthy();
    const services = await pax8BillingAdapter.services([s.companyId!]);
    const svc = services.find((x) => x.rowId === s.id)!;
    expect(svc.monthlyCost).toBeCloseTo(14 * 9.4, 2);
    expect(svc.customerMonthlyPrice).toBeCloseTo(11.28, 2);
    const totals = await pax8Totals(s.companyId!);
    // Only recurring partner costs are summed; the customer prices are left out.
    expect(totals.monthlyCost).toBeCloseTo(14 * 9.4 + 14 * 1.55, 2);
  });

  it("a subscription without a partner cost reads as cost unknown, not as the customer price", async () => {
    const [s] = await db.select().from(pax8Subscriptions).where(eq(pax8Subscriptions.subscriptionId, "s-1001"));
    await db.update(pax8Subscriptions).set({ partnerCost: null }).where(eq(pax8Subscriptions.id, s.id));
    try {
      const svc = (await pax8BillingAdapter.services([s.companyId!])).find((x) => x.rowId === s.id)!;
      expect(svc.monthlyCost).toBeNull();
      expect(svc.costKnown).toBe(true);
      expect((await pax8Totals(s.companyId!)).monthlyCost).toBeCloseTo(14 * 1.55, 2);
    } finally {
      await db.update(pax8Subscriptions).set({ partnerCost: "9.4000" }).where(eq(pax8Subscriptions.id, s.id));
    }
  });

  it("invoice lines keep the partner cost apart from the customer price and reconcile on cost", async () => {
    const [inv] = await db.select({ id: pax8Invoices.pax8InvoiceId }).from(pax8Invoices).limit(1);
    const [item] = await db.select().from(pax8InvoiceItems).where(eq(pax8InvoiceItems.itemId, `${inv.id}:s-1001`));
    expect(Number(item.cost)).toBeCloseTo(9.4, 4);
    expect(Number(item.unitPrice)).toBeCloseTo(11.28, 4);
    expect(Number(item.costTotal)).toBeCloseTo(14 * 9.4, 2);
    expect(Number(item.total)).toBeCloseTo(14 * 11.28, 2);
    const alloc = (await pax8InvoiceAllocation(item.invoiceId))!;
    const line = alloc.customers.flatMap((c) => c.items).find((i) => i.itemId === item.itemId)!;
    expect(line).toMatchObject({ unitCost: 9.4, unitPrice: 11.28, finding: "ok" });
    expect(line.total).toBeCloseTo(14 * 9.4, 2);
    expect(line.customerTotal).toBeCloseTo(14 * 11.28, 2);
    // The invoice's lines add up to what we pay, which is what the Xero bill should carry.
    expect(alloc.invoice.itemsTotal).toBeCloseTo(alloc.summary.total, 2);
  });
});
