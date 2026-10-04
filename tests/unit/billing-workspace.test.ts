import { describe, expect, it, beforeAll } from "vitest";
import type { InvoiceDraftLine } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract, updateContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { createLink } from "@/services/integrations";
import { prepareInvoiceDraft } from "@/services/xero";
import { billingWorkspace, explainDifference } from "@/services/billing-workspace";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("finance", "workspace finance");
});

const dl = (over: Partial<InvoiceDraftLine> & { description: string; quantity: number; unitAmount: number }): InvoiceDraftLine => ({ accountCode: "200", taxType: "OUTPUT2", contractLineId: null, calc: null, ...over });
const period = (contractLineId: string, quantity: number, unitPerPeriod: number, extra: Partial<NonNullable<InvoiceDraftLine["calc"]>> = {}) => ({ kind: "period" as const, quantity, unitPerPeriod, from: "2026-10-01", to: "2026-10-31", ...extra });

describe("explainDifference", () => {
  const previous = [
    dl({ description: "Users (1 Sep 2026 to 30 Sep 2026)", quantity: 10, unitAmount: 40, contractLineId: "L1", calc: period("L1", 10, 40, { from: "2026-09-01", to: "2026-09-30" }) }),
    dl({ description: "Backup", quantity: 1, unitAmount: 50, contractLineId: "L2", calc: period("L2", 1, 50, { from: "2026-09-01", to: "2026-09-30" }) }),
  ];

  it("says so when nothing changed, and reports a first invoice", () => {
    const same = previous.map((l) => ({ ...l, calc: { ...l.calc!, from: "2026-10-01", to: "2026-10-31" } }));
    expect(explainDifference(same, previous, "GBP", { missed: 0, ownCycleDue: [] })).toEqual(["Same lines and quantities as the previous invoice"]);
    expect(explainDifference(same, null, "GBP", { missed: 0, ownCycleDue: [] })).toEqual(["First invoice for this contract from the CRM"]);
  });

  it("names quantity and price changes, new and removed lines, by contract line", () => {
    const current = [
      dl({ description: "Users (1 Oct 2026 to 31 Oct 2026)", quantity: 12, unitAmount: 42, contractLineId: "L1", calc: period("L1", 12, 42) }),
      dl({ description: "Firewall", quantity: 1, unitAmount: 30, contractLineId: "L3", calc: period("L3", 1, 30) }),
    ];
    expect(explainDifference(current, previous, "GBP", { missed: 0, ownCycleDue: [] })).toEqual([
      "Users: 10 → 12",
      "Users: price £40.00 → £42.00 per unit",
      "New: Firewall (£30.00)",
      "Removed: Backup (was £50.00)",
    ]);
  });

  it("explains pro-rata, increase, decrease and catch-up lines from their calc, plus missed periods and own-cycle lines", () => {
    const current = [
      dl({ description: "Users (1 Oct 2026 to 31 Oct 2026)", quantity: 10, unitAmount: 40, contractLineId: "L1", calc: period("L1", 10, 40) }),
      dl({ description: "Users: 2 added from 10 Oct 2026", quantity: 2, unitAmount: 28.39, contractLineId: "L1", calc: { kind: "increase", quantity: 2, unitPerPeriod: 40, from: "2026-10-10", to: "2026-10-31", days: 22, fullDays: 31 } }),
      dl({ description: "Users: 1 removed from 20 Oct 2026", quantity: -1, unitAmount: 15.48, contractLineId: "L1", calc: { kind: "decrease", quantity: 1, unitPerPeriod: 40, from: "2026-10-20", to: "2026-10-31", days: 12, fullDays: 31 } }),
      dl({ description: "Users: adjustment", quantity: 1, unitAmount: 12.9, contractLineId: "L1", calc: { kind: "catchup", quantity: 1, unitPerPeriod: 40, from: "2026-09-21", to: "2026-09-30" } }),
      dl({ description: "Backup (15 Oct 2026 to 31 Oct 2026)", quantity: 1, unitAmount: 27.42, contractLineId: "L2", calc: { kind: "prorata", quantity: 1, unitPerPeriod: 50, from: "2026-10-15", to: "2026-10-31", days: 17, fullDays: 31 } }),
    ];
    const reasons = explainDifference(current, previous, "GBP", { missed: 2, ownCycleDue: ["Domain renewal"] });
    expect(reasons).toEqual([
      "Users: 2 added from 2026-10-10, pro rata (£56.78)",
      "Users: 1 removed from 2026-10-20, credited (-£15.48)",
      "Users: adjustment for the previous period (£12.90)",
      "Backup: 17 of 31 days, pro rata",
      "Includes 2 missed periods",
      "Domain renewal: due on its own cycle this period",
    ]);
    // The base line of L1 is unchanged (10 × £40), so no quantity reason is produced for it.
    expect(reasons.some((r) => r.startsWith("Users: 10"))).toBe(false);
  });
});

describe("billing workspace (demo adapter)", () => {
  it("marks contracts blocked without a Xero link, ready when unchanged, and for review when the amount differs, with the previous draft and reasons", async () => {
    const unlinked = await createCompany(companySchema.parse({ name: "Workspace Unlinked Ltd", status: "customer", website: "ws-unlinked.example" }), admin.id);
    const linked = await createCompany(companySchema.parse({ name: "Workspace Linked Ltd", status: "customer", website: "ws-linked.example" }), admin.id);
    await createLink({ provider: "xero", entityType: "company", localId: linked, externalId: `ws-contact-${linked}`, externalName: "Workspace Linked Ltd" }, admin.id);
    const lines = (q: number) => [{ id: null, productId: null, siteId: null, description: "Users", revenueType: "recurring", pricingModel: "per_user", billingFrequency: "monthly", quantity: q, unitPrice: 40, unitCost: null, countsAsManagedDevice: false }] as Parameters<typeof createContract>[1];
    const blockedId = await createContract(contractSchema.parse({ companyId: unlinked, name: "Blocked MSA", startDate: "2026-01-01", status: "active", billingFrequency: "monthly" }), lines(5), admin.id);
    const steadyId = await createContract(contractSchema.parse({ companyId: linked, name: "Steady MSA", startDate: "2026-01-01", status: "active", billingFrequency: "monthly" }), lines(10), admin.id);
    const changedId = await createContract(contractSchema.parse({ companyId: linked, name: "Growing MSA", startDate: "2026-01-01", status: "active", billingFrequency: "monthly" }), lines(10), admin.id);
    // September drafts exist for the two linked contracts; the growing one adds users from 1 October.
    await prepareInvoiceDraft({ companyId: linked, contractId: steadyId, periodStart: "2026-09-01", periodEnd: "2026-09-30" }, admin.id);
    await prepareInvoiceDraft({ companyId: linked, contractId: changedId, periodStart: "2026-09-01", periodEnd: "2026-09-30" }, admin.id);
    await updateContract(changedId, contractSchema.parse({ companyId: linked, name: "Growing MSA", startDate: "2026-01-01", status: "active", billingFrequency: "monthly" }), lines(12), admin.id, { quantityEffectiveFrom: "2026-10-01", changeReason: "Two new starters" });

    const { rows, summary } = await billingWorkspace("2026-10-05", "GBP");
    const byId = new Map(rows.map((r) => [r.contractId, r]));
    const blocked = byId.get(blockedId)!;
    expect(blocked).toMatchObject({ status: "blocked", delta: null, previous: null });
    expect(blocked.blockers).toEqual(["Company not linked to a Xero contact"]);
    expect(blocked.attention).toContain("First invoice from the CRM for this contract");
    expect(blocked.reasons).toEqual(["First invoice for this contract from the CRM"]);

    const steady = byId.get(steadyId)!;
    expect(steady.status).toBe("ready");
    expect(steady.previous).toMatchObject({ periodStart: "2026-09-01", periodEnd: "2026-09-30", net: 400 });
    expect(steady.delta).toBe(0);
    expect(steady.reasons).toEqual(["Same lines and quantities as the previous invoice"]);
    expect(steady.attention).toEqual([]);

    const changed = byId.get(changedId)!;
    expect(changed.status).toBe("review");
    expect(changed.net).toBe(480);
    expect(changed.delta).toBe(80);
    expect(changed.attention[0]).toBe("+£80.00 against the previous invoice (£400.00)");
    expect(changed.reasons).toEqual(["Users: 10 → 12"]);

    expect(summary.ready).toBeGreaterThanOrEqual(1);
    expect(summary.review).toBeGreaterThanOrEqual(1);
    expect(summary.blocked).toBeGreaterThanOrEqual(1);
    expect(summary.expected).toBeGreaterThanOrEqual(400 + 480 + 200);
  });
});
