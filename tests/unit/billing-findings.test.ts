import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contractLines, invoiceDrafts, pax8Subscriptions } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract, updateContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { syncPax8 } from "@/services/pax8";
import { prepareInvoiceDraft } from "@/services/xero";
import { setServiceCoverage } from "@/services/service-register";
import { billingFindings, FINDING_KINDS } from "@/services/billing-findings";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "findings admin");
});

const line = (over: Record<string, unknown>) => ({ id: null, productId: null, siteId: null, description: "x", revenueType: "recurring" as const, pricingModel: "per_user" as const, billingFrequency: "monthly" as const, quantity: 1, unitPrice: 10, unitCost: null, countsAsManagedDevice: false, ...over });

describe("billing findings", () => {
  it("reads unmapped services, covered services that cannot charge, expected charges not drafted, old drafts and supplier findings into one list with interpretations and links", async () => {
    const dental = await createCompany(companySchema.parse({ name: "Harrowgate Dental Practice", status: "customer", website: "https://www.harrowgatedental.co.uk" }), admin.id);
    const contractId = await createContract(contractSchema.parse({ companyId: dental, name: "Managed IT", startDate: "2026-01-01", status: "active", billingDay: "1" }), [line({ description: "Microsoft 365 Business Standard", quantity: 14, unitPrice: 12 })], admin.id);
    await syncPax8("manual", admin.id);
    const first = await billingFindings({ asOf: "2026-10-05" });
    expect(FINDING_KINDS.map((k) => k.kind).every((k) => k in first.counts)).toBe(true);
    // The Acronis seats have no line: unmapped. The October period is due and not drafted: expected charge missing.
    const acronis = first.findings.find((f) => f.kind === "unmapped_service" && /Acronis/.test(f.title) && f.companyId === dental)!;
    expect(acronis).toMatchObject({ severity: "amber", href: `/companies/${dental}?tab=subscriptions` });
    expect(acronis.amount).toBeCloseTo(21.7, 2);
    const due = first.findings.find((f) => f.kind === "expected_missing" && f.companyId === dental)!;
    expect(due).toMatchObject({ severity: "amber", amount: 168, href: "/billing/run?asOf=2026-10-05" });
    // Draft October, then age the draft: it becomes a waiting draft and the expected charge disappears.
    const draftId = await prepareInvoiceDraft({ companyId: dental, contractId, periodStart: "2026-10-01", periodEnd: "2026-10-31" }, admin.id);
    await db.update(invoiceDrafts).set({ createdAt: new Date(Date.now() - 10 * 86400000) }).where(eq(invoiceDrafts.id, draftId));
    const second = await billingFindings({ asOf: "2026-10-05" });
    expect(second.findings.some((f) => f.kind === "expected_missing" && f.companyId === dental)).toBe(false);
    const waiting = second.findings.find((f) => f.kind === "draft_waiting" && f.href === `/billing/drafts/${draftId}`)!;
    expect(waiting.title).toMatch(/draft for 10 days/);
    // A subscription bundled into a line of a contract that is then cancelled: covered, but nothing can charge it.
    const [std] = await db.select().from(contractLines).where(eq(contractLines.contractId, contractId));
    const sub = (await db.select().from(pax8Subscriptions).where(eq(pax8Subscriptions.companyId, dental))).find((s) => /Acronis/.test(s.productName))!;
    await setServiceCoverage({ source: "pax8_subscription", sourceRowId: sub.id, state: "bundle", contractLineId: std.id, reason: "part of the package" }, admin.id);
    await updateContract(contractId, contractSchema.parse({ companyId: dental, name: "Managed IT", startDate: "2026-01-01", status: "cancelled", billingDay: "1" }), null, admin.id);
    const third = await billingFindings({ asOf: "2026-10-05" });
    const covered = third.findings.find((f) => f.kind === "covered_no_charge" && f.companyId === dental)!;
    expect(covered).toMatchObject({ severity: "red", detail: "contract is cancelled", href: `/contracts/${contractId}` });
    expect(third.findings.some((f) => f.kind === "unmapped_service" && /Acronis/.test(f.title) && f.companyId === dental)).toBe(false);
    // Supplier side: the unlinked Pax8 company's charges are unallocated on every mirrored invoice.
    expect(third.counts.supplier_no_customer).toBeGreaterThanOrEqual(1);
    const supplier = third.findings.find((f) => f.kind === "supplier_no_customer")!;
    expect(supplier.href).toMatch(/\/integrations\/pax8\/invoices\//);
    expect(supplier.companyId).toBeNull();
    // Red before amber before grey.
    const sev = third.findings.map((f) => f.severity);
    expect(sev.indexOf("amber")).toBeGreaterThan(sev.indexOf("red"));
  });
});
