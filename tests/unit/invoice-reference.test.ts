import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { invoiceDrafts } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { prepareInvoiceDraft } from "@/services/xero";
import { runBillingRun } from "@/services/billing-run";
import { setConnectionConfig } from "@/services/integrations";
import { makeUser } from "./helpers";

let admin: { id: string };
let companyId: string;
const line = (description: string, over: Record<string, unknown> = {}) => ({ id: null, productId: null, siteId: null, description, revenueType: "recurring" as const, pricingModel: "per_user" as const, billingFrequency: "monthly" as const, quantity: 2, unitPrice: 50, unitCost: null, countsAsManagedDevice: false, ...over });

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "reference admin");
  await setConnectionConfig("xero", { defaultAccountCode: "200", defaultTaxType: "OUTPUT2", dueDays: 14 }, admin.id);
  companyId = await createCompany(companySchema.parse({ name: "Reference Test Ltd", status: "customer" }), admin.id);
});

describe("draft invoice reference and date", () => {
  it("uses the agreement's CRM reference and the month, keeps it unique, and dates the draft as asked", async () => {
    const contractId = await createContract(contractSchema.parse({ companyId, name: "Managed IT Agreement", reference: "MSA-9125", startDate: "2026-01-01", status: "active" }), [line("Users")], admin.id);
    const a = await prepareInvoiceDraft({ companyId, contractId, periodStart: "2026-11-01", periodEnd: "2026-11-30", invoiceDate: "2026-11-03" }, admin.id);
    const [da] = await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, a));
    expect(da.reference).toBe("MSA-9125 2026-11");
    expect(da.invoiceDate).toBe("2026-11-03");
    expect(da.dueDate).toBe("2026-11-17"); // payment terms count from the invoice date, not from today
    // The same agreement and month again (a deliberate manual draft) gets a counter rather than a clash.
    const b = await prepareInvoiceDraft({ companyId, contractId, periodStart: "2026-11-01", periodEnd: "2026-11-30" }, admin.id);
    expect((await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, b)))[0].reference).toBe("MSA-9125 2026-11 (2)");
    await expect(prepareInvoiceDraft({ companyId, contractId, periodStart: "2026-12-01", periodEnd: "2026-12-31", invoiceDate: "3rd Dec" }, admin.id)).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("the billing run dates every draft with the chosen invoice date and names consolidated drafts after both agreements", async () => {
    const one = await createContract(contractSchema.parse({ companyId, name: "Hosting", reference: "HST-1", startDate: "2026-01-01", status: "active" }), [line("Web hosting")], admin.id);
    const two = await createContract(contractSchema.parse({ companyId, name: "Backup Agreement", startDate: "2026-01-01", status: "active" }), [line("Backup seats")], admin.id);
    const run = await runBillingRun("2027-02-05", [one, two], admin.id, { consolidate: true, invoiceDate: "2027-02-01" });
    expect(run.invoiceDate).toBe("2027-02-01");
    expect(run.created).toHaveLength(1);
    const [d] = await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, run.created[0].draftId));
    expect(d.invoiceDate).toBe("2027-02-01");
    expect(d.dueDate).toBe("2027-02-15");
    // The agreement without a CRM reference contributes its name; the month is the period's.
    expect(d.reference).toBe("Backup Agreement + HST-1 2027-02"); // agreements in the run's order (by name)
    await expect(runBillingRun("2027-03-05", [one], admin.id, { invoiceDate: "soon" })).rejects.toThrow(/YYYY-MM-DD/);
  });
});
