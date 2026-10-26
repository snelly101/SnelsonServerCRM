import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract, getContract, quickUpdateContracts } from "@/services/contracts";
import { contractQuickPatchSchema, contractSchema } from "@/lib/validation-sales";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  admin = await makeUser("admin", "quick admin");
});

describe("quick edits from the contracts list", () => {
  it("applies a status and dates to several contracts, audits each one, and reports missing ids", async () => {
    const companyId = await createCompany(companySchema.parse({ name: "Quick Edit Co" }), admin.id);
    const a = await createContract(contractSchema.parse({ companyId, name: "Alpha", startDate: "2026-01-01" }), [], admin.id);
    const b = await createContract(contractSchema.parse({ companyId, name: "Beta", startDate: "2026-02-01", status: "active" }), [], admin.id);
    const missing = "00000000-0000-0000-0000-000000000000";

    const r = await quickUpdateContracts([a, b, missing, a], contractQuickPatchSchema.parse({ status: "active", renewalDate: "2027-01-01", nextReviewDate: "2026-07-01" }), admin.id);
    expect(r).toEqual({ done: 2, unchanged: 0, errors: ["One of the contracts no longer exists."] });
    for (const id of [a, b]) {
      const row = await getContract(id);
      expect(row?.status).toBe("active");
      expect(row?.renewalDate).toBe("2027-01-01");
      expect(row?.nextReviewDate).toBe("2026-07-01");
      // The start date and notice period were not in the patch, so they are untouched.
      expect(row?.noticePeriodDays).toBe(90);
    }
    expect((await getContract(a))?.startDate).toBe("2026-01-01");
    const audits = await db.select({ action: auditLog.action, details: auditLog.details }).from(auditLog).where(eq(auditLog.entityId, a));
    const quick = audits.find((x) => x.action === "contract.update");
    expect(quick).toBeTruthy();
    expect((quick?.details as { changes: Record<string, unknown> }).changes).toHaveProperty("status");
    expect((quick?.details as { changes: Record<string, unknown> }).changes).not.toHaveProperty("startDate");

    // Clearing an optional date and a no-op patch.
    const r2 = await quickUpdateContracts([a, b], contractQuickPatchSchema.parse({ nextReviewDate: null }), admin.id);
    expect(r2).toEqual({ done: 2, unchanged: 0, errors: [] });
    expect((await getContract(a))?.nextReviewDate).toBeNull();
    const r3 = await quickUpdateContracts([a], contractQuickPatchSchema.parse({ status: "active" }), admin.id);
    expect(r3).toEqual({ done: 0, unchanged: 1, errors: [] });
  });

  it("rejects an empty patch and a bad date before touching the database", () => {
    expect(() => contractQuickPatchSchema.parse({})).toThrow(/nothing to change/i);
    expect(() => contractQuickPatchSchema.parse({ renewalDate: "next week" })).toThrow();
    expect(() => contractQuickPatchSchema.parse({ status: "paused" })).toThrow();
    expect(contractQuickPatchSchema.parse({ noticePeriodDays: "30" })).toEqual({ noticePeriodDays: 30 });
  });
});
