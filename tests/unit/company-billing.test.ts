import { describe, expect, it, beforeAll } from "vitest";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { createLink } from "@/services/integrations";
import { prepareInvoiceDraft } from "@/services/xero";
import { companyBilling } from "@/services/company-billing";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("finance", "company billing finance");
});

describe("company billing tab data", () => {
  it("narrows the billing picture to one customer with next actions in order of urgency", async () => {
    const linked = await createCompany(companySchema.parse({ name: "Tab Linked Ltd", status: "customer", website: "tab-linked.example" }), admin.id);
    const other = await createCompany(companySchema.parse({ name: "Tab Other Ltd", status: "customer", website: "tab-other.example" }), admin.id);
    await createLink({ provider: "xero", entityType: "company", localId: linked, externalId: "demo-c-1", externalName: "Tab Linked Ltd" }, admin.id);
    const lines = (q: number) => [{ id: null, productId: null, siteId: null, description: "Users", revenueType: "recurring", pricingModel: "per_user", billingFrequency: "monthly", quantity: q, unitPrice: 40, unitCost: null, countsAsManagedDevice: false }] as Parameters<typeof createContract>[1];
    const steady = await createContract(contractSchema.parse({ companyId: linked, name: "Steady", startDate: "2026-01-01", status: "active", renewalDate: "2026-12-31", noticePeriodDays: 90 }), lines(10), admin.id);
    await createContract(contractSchema.parse({ companyId: other, name: "Elsewhere", startDate: "2026-01-01", status: "active" }), lines(3), admin.id);
    await prepareInvoiceDraft({ companyId: linked, contractId: steady, periodStart: "2026-09-01", periodEnd: "2026-09-30" }, admin.id);

    const data = await companyBilling(linked, "2026-10-05");
    expect(data.rows.map((r) => r.contractId)).toEqual([steady]);
    expect(data.rows[0].status).toBe("ready");
    // The September draft is a first invoice from the CRM, so it waits as an exception; the renewal decision (due 2 Sep) is overdue.
    expect(data.pending).toHaveLength(1);
    expect(data.renewals.map((r) => r.status)).toEqual(["overdue"]);
    expect(data.next[0]).toMatchObject({ tone: "red", href: `/contracts/${steady}` });
    expect(data.next.some((n) => n.label.startsWith("Prepare 1 ready agreement"))).toBe(true);
    expect(data.next.some((n) => n.label.startsWith("Review 1 draft exception"))).toBe(true);
    expect(data.issued).toEqual([]);
    // The other customer sees nothing of this one.
    const otherData = await companyBilling(other, "2026-10-05");
    expect(otherData.rows.map((r) => r.contractName)).toEqual(["Elsewhere"]);
    expect(otherData.pending).toEqual([]);
    expect(otherData.next.some((n) => n.label.startsWith("Link this customer to its Xero contact"))).toBe(true);
  });
});
