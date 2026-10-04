import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { invoiceDrafts } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract, updateContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { createLink } from "@/services/integrations";
import { prepareInvoiceDraft } from "@/services/xero";
import { approveUnchangedDrafts, reviewPendingDrafts } from "@/services/draft-review";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("finance", "draft reviewer");
});

const lines = (q: number) => [{ id: null, productId: null, siteId: null, description: "Users", revenueType: "recurring", pricingModel: "per_user", billingFrequency: "monthly", quantity: q, unitPrice: 40, unitCost: null, countsAsManagedDevice: false }] as Parameters<typeof createContract>[1];
const terms = (companyId: string, name: string) => contractSchema.parse({ companyId, name, startDate: "2026-01-01", status: "active", billingFrequency: "monthly" });

describe("draft review and batch approval (demo adapter)", () => {
  it("tells unchanged drafts from exceptions and approves only the unchanged ones, re-checking at approval time", async () => {
    const linked = await createCompany(companySchema.parse({ name: "Review Linked Ltd", status: "customer", website: "review-linked.example" }), admin.id);
    const unlinked = await createCompany(companySchema.parse({ name: "Review Unlinked Ltd", status: "customer", website: "review-unlinked.example" }), admin.id);
    await createLink({ provider: "xero", entityType: "company", localId: linked, externalId: "demo-c-1", externalName: "Review Linked Ltd" }, admin.id);
    const steady = await createContract(terms(linked, "Steady"), lines(10), admin.id);
    const growing = await createContract(terms(linked, "Growing"), lines(10), admin.id);
    const noLink = await createContract(terms(unlinked, "No link"), lines(3), admin.id);
    // September drafts (the previous invoices), then October drafts to review.
    await prepareInvoiceDraft({ companyId: linked, contractId: steady, periodStart: "2026-09-01", periodEnd: "2026-09-30" }, admin.id);
    await prepareInvoiceDraft({ companyId: linked, contractId: growing, periodStart: "2026-09-01", periodEnd: "2026-09-30" }, admin.id);
    await updateContract(growing, terms(linked, "Growing"), lines(12), admin.id, { quantityEffectiveFrom: "2026-10-01", changeReason: "starters" });
    const steadyOct = await prepareInvoiceDraft({ companyId: linked, contractId: steady, periodStart: "2026-10-01", periodEnd: "2026-10-31" }, admin.id);
    const growingOct = await prepareInvoiceDraft({ companyId: linked, contractId: growing, periodStart: "2026-10-01", periodEnd: "2026-10-31" }, admin.id);
    const noLinkOct = await prepareInvoiceDraft({ companyId: unlinked, contractId: noLink, periodStart: "2026-10-01", periodEnd: "2026-10-31" }, admin.id);
    const [{ id: manual }] = await db.insert(invoiceDrafts).values({ companyId: linked, reference: "CRM-MANUAL1", currencyCode: "GBP", invoiceDate: "2026-10-01", dueDate: "2026-10-31", lines: [{ description: "Ad hoc", quantity: 1, unitAmount: 99, accountCode: "200", taxType: "OUTPUT2" }], subTotal: "99.00", preparedByUserId: admin.id }).returning({ id: invoiceDrafts.id });

    const review = await reviewPendingDrafts("GBP");
    const byId = new Map(review.map((r) => [r.id, r]));
    expect(byId.get(steadyOct)).toMatchObject({ verdict: "unchanged", delta: 0, flags: [], reasons: ["Same lines and quantities as the previous invoice"] });
    expect(byId.get(steadyOct)!.previous).toMatchObject({ periodStart: "2026-09-01", periodEnd: "2026-09-30", net: 400 });
    expect(byId.get(growingOct)).toMatchObject({ verdict: "exception", delta: 80, reasons: ["Users: 10 → 12"] });
    expect(byId.get(growingOct)!.flags).toEqual(["Amount or lines differ from the previous invoice"]);
    expect(byId.get(noLinkOct)!.flags).toEqual(["Company not linked to a Xero contact", "First invoice from the CRM for this contract"]);
    expect(byId.get(manual)!.flags).toEqual(["Hand-prepared draft"]);
    // The September drafts are first invoices from the CRM: exceptions too, never silently batched.
    expect(review.filter((r) => r.contractId === steady && r.id !== steadyOct)[0].flags).toContain("First invoice from the CRM for this contract");

    // Batch: the unchanged one is created in Xero; the changed one and the unlinked one are skipped with reasons.
    const result = await approveUnchangedDrafts([steadyOct, growingOct, noLinkOct], admin.id, "GBP");
    expect(result.approved.map((a) => a.id)).toEqual([steadyOct]);
    expect(result.skipped.map((s) => [s.id, s.reason])).toEqual([
      [growingOct, "Amount or lines differ from the previous invoice"],
      [noLinkOct, "Company not linked to a Xero contact; First invoice from the CRM for this contract"],
    ]);
    const [created] = await db.select({ status: invoiceDrafts.status, xeroInvoiceId: invoiceDrafts.xeroInvoiceId }).from(invoiceDrafts).where(eq(invoiceDrafts.id, steadyOct));
    expect(created.status).toBe("created");
    expect(created.xeroInvoiceId).toBeTruthy();
    // Approving again is a no-op: the draft is no longer awaiting approval.
    const again = await approveUnchangedDrafts([steadyOct], admin.id, "GBP");
    expect(again.approved).toEqual([]);
    expect(again.skipped[0].reason).toBe("No longer awaiting approval");
  });
});
