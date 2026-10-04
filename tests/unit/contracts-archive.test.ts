import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { archiveContract, createContract, getContract, listContracts } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  admin = await makeUser("admin", "archive admin");
});

describe("archiving a contract", () => {
  it("hides it from the current list, shows it in the archived view, records audit and activity, and restores it", async () => {
    const companyId = await createCompany(companySchema.parse({ name: "Archive Test Co" }), admin.id);
    const id = await createContract(contractSchema.parse({ companyId, name: "Archive me", startDate: "2026-01-01", status: "active" }), [], admin.id);

    await archiveContract(id, admin.id);
    const archived = await getContract(id);
    expect(archived?.archivedAt).toBeInstanceOf(Date);
    expect((await listContracts({ companyId })).rows.map((r) => r.id)).not.toContain(id);
    expect((await listContracts({ companyId, archived: true })).rows.map((r) => r.id)).toContain(id);
    const audits = await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, id));
    expect(audits.map((a) => a.action)).toContain("contract.archive");

    await archiveContract(id, admin.id, true);
    expect((await getContract(id))?.archivedAt).toBeNull();
    expect((await listContracts({ companyId })).rows.map((r) => r.id)).toContain(id);
    expect((await listContracts({ companyId, archived: true })).rows.map((r) => r.id)).not.toContain(id);
    const after = await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, id));
    expect(after.map((a) => a.action)).toContain("contract.restore");

    await expect(archiveContract("00000000-0000-0000-0000-000000000000", admin.id)).rejects.toThrow(/not found/i);
  });
});
