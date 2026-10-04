import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contractLines, products } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract, listContractLineChanges } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { applyPriceReview, firstPeriodOnOrAfter, previewPriceReview, priceAfter } from "@/services/price-reviews";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "pricing admin");
});

describe("price review maths (pure)", () => {
  it("applies a percentage, a new price, or a supplier cost at the same margin", () => {
    expect(priceAfter({ kind: "percent", value: 10 }, 12, 8)).toEqual({ unitPrice: 13.2, unitCost: 8, note: null });
    expect(priceAfter({ kind: "unit_price", value: 15 }, 12, 8)).toEqual({ unitPrice: 15, unitCost: 8, note: null });
    // Cost 8 → 9 at a 33.3% margin keeps the margin: 12 × 9/8 = 13.50
    expect(priceAfter({ kind: "cost_passthrough", value: 9 }, 12, 8)).toEqual({ unitPrice: 13.5, unitCost: 9, note: null });
    expect(priceAfter({ kind: "cost_passthrough", value: 9 }, 12, null).unitPrice).toBe(21);
  });
  it("finds the first anchored period on or after the effective day", () => {
    const c = { startDate: "2026-01-15", billingFrequency: "monthly", endDate: null, billingDay: null };
    expect(firstPeriodOnOrAfter(c, "2026-10-15")).toBe("2026-10-15");
    expect(firstPeriodOnOrAfter(c, "2026-10-16")).toBe("2026-11-15");
    expect(firstPeriodOnOrAfter(c, "2025-12-01")).toBe("2026-01-15");
    expect(firstPeriodOnOrAfter({ ...c, billingFrequency: "one_off" }, "2026-10-16")).toBeNull();
  });
});

describe("price review (service)", () => {
  it("previews affected customers with margins and constraints, then applies dated, reasoned price changes", async () => {
    const [product] = await db.insert(products).values({ name: "Microsoft 365 Business Standard", pricingModel: "per_user", revenueType: "recurring", billingFrequency: "monthly", unitPrice: "12.00", unitCost: "8.00" }).returning({ id: products.id });
    const a = await createCompany(companySchema.parse({ name: "Pricing A Ltd", status: "customer", website: "pricing-a.example" }), admin.id);
    const b = await createCompany(companySchema.parse({ name: "Pricing B Ltd", status: "customer", website: "pricing-b.example" }), admin.id);
    const line = (over: Record<string, unknown>) => ({ id: null, productId: product.id, siteId: null, description: "Microsoft 365 Business Standard", revenueType: "recurring" as const, pricingModel: "per_user" as const, billingFrequency: "monthly" as const, quantity: 10, unitPrice: 12, unitCost: 8, countsAsManagedDevice: false, ...over });
    const free = await createContract(contractSchema.parse({ companyId: a, name: "Free to review", startDate: "2026-01-01", status: "active" }), [line({}), line({ productId: null, description: "Backup", quantity: 1, unitPrice: 50, unitCost: 20 })], admin.id);
    const locked = await createContract(contractSchema.parse({ companyId: b, name: "Locked", startDate: "2026-01-15", status: "active", renewalDate: "2027-01-14", priceLockedUntilRenewal: true }), [line({ quantity: 20 })], admin.id);

    const preview = await previewPriceReview({ scope: { productId: product.id }, change: { kind: "percent", value: 10 }, effectiveFrom: "2026-11-01", reason: "" }, "2026-10-04");
    expect(preview.product).toMatchObject({ name: "Microsoft 365 Business Standard", unitPrice: 12, unitCost: 8 });
    expect(preview.lines).toHaveLength(2);
    const la = preview.lines.find((l) => l.contractId === free)!;
    expect(la).toMatchObject({ unitPrice: 12, newUnitPrice: 13.2, marginNow: 33.33, marginAfter: 39.39, monthlyDelta: 12, appliedFrom: "2026-11-01", firstPeriodStart: "2026-11-01", applicable: true, constraints: [] });
    const lb = preview.lines.find((l) => l.contractId === locked)!;
    expect(lb).toMatchObject({ appliedFrom: "2027-01-14", firstPeriodStart: "2027-01-15", monthlyDelta: 24 });
    expect(lb.constraints[0]).toMatch(/Prices fixed until renewal on 2027-01-14/);
    expect(preview.totals).toMatchObject({ lines: 2, customers: 2, monthlyNow: 360, monthlyAfter: 396, monthlyDelta: 36, marginNow: 33.33, marginAfter: 39.39 });

    // Description scope reaches lines without a product; a reason is required to apply.
    const byText = await previewPriceReview({ scope: { descriptionContains: "backup" }, change: { kind: "unit_price", value: 55 }, effectiveFrom: "2026-11-01", reason: "" });
    expect(byText.lines.map((l) => l.description)).toEqual(["Backup"]);
    await expect(applyPriceReview({ scope: { productId: product.id }, change: { kind: "percent", value: 10 }, effectiveFrom: "2026-11-01", reason: "" }, admin.id)).rejects.toThrow(/reason/);

    const result = await applyPriceReview({ scope: { productId: product.id }, change: { kind: "percent", value: 10 }, effectiveFrom: "2026-11-01", reason: "Microsoft list price rise", updateCatalogue: true }, admin.id);
    expect(result.lines).toBe(2);
    expect(result.monthlyDelta).toBe(36);
    const freeLines = await db.select().from(contractLines).where(eq(contractLines.contractId, free));
    expect(freeLines.find((l) => l.productId === product.id)!.unitPrice).toBe("13.20");
    expect(freeLines.find((l) => l.description === "Backup")!.unitPrice).toBe("50.00");
    const freeHistory = await listContractLineChanges(free);
    expect(freeHistory[0]).toMatchObject({ field: "unit_price", previousValue: "12.00", newValue: "13.20", effectiveFrom: "2026-11-01", reason: "Microsoft list price rise" });
    const lockedHistory = await listContractLineChanges(locked);
    expect(lockedHistory[0]).toMatchObject({ field: "unit_price", newValue: "13.20", effectiveFrom: "2027-01-14" });
    expect((await db.select().from(products).where(eq(products.id, product.id)))[0].unitPrice).toBe("13.20");
  });
});
