import { describe, expect, it, beforeAll } from "vitest";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, auditLog, invoiceDrafts } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { createLink } from "@/services/integrations";
import { prepareInvoiceDraft } from "@/services/xero";
import { runBillingAutomation, lastAutomationRun } from "@/services/billing-automation";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "automation admin");
});

const setPolicy = (level: number, day = 1) => db.update(appSettings).set({ billingAutomationLevel: level, billingAutomationDay: day, billingAutomationConsolidate: true }).where(eq(appSettings.id, 1));

describe("billing automation (demo adapters)", () => {
  it("stays detect-only at level 0, prepares ready contracts at level 1 once a month, and approves only unchanged drafts at level 2", async () => {
    const linked = await createCompany(companySchema.parse({ name: "Automation Linked Ltd", status: "customer", website: "auto-linked.example" }), admin.id);
    const unlinked = await createCompany(companySchema.parse({ name: "Automation Unlinked Ltd", status: "customer", website: "auto-unlinked.example" }), admin.id);
    await createLink({ provider: "xero", entityType: "company", localId: linked, externalId: "demo-c-1", externalName: "Automation Linked Ltd" }, admin.id);
    const lines = (q: number) => [{ id: null, productId: null, siteId: null, description: "Users", revenueType: "recurring", pricingModel: "per_user", billingFrequency: "monthly", quantity: q, unitPrice: 40, unitCost: null, countsAsManagedDevice: false }] as Parameters<typeof createContract>[1];
    const steady = await createContract(contractSchema.parse({ companyId: linked, name: "Steady", startDate: "2026-01-01", status: "active" }), lines(10), admin.id);
    const blocked = await createContract(contractSchema.parse({ companyId: unlinked, name: "No link", startDate: "2026-01-01", status: "active" }), lines(3), admin.id);
    // A September draft makes October "ready" (same amount as last time); the unlinked company is blocked.
    await prepareInvoiceDraft({ companyId: linked, contractId: steady, periodStart: "2026-09-01", periodEnd: "2026-09-30" }, admin.id);

    await setPolicy(0);
    const detect = await runBillingAutomation({ asOf: "2026-10-05", trigger: "manual", actorUserId: admin.id });
    expect(detect).toMatchObject({ level: 0, ran: true, prepared: [], approved: [] });
    expect(detect.readyContracts).toBeGreaterThanOrEqual(1);
    expect(detect.blockedContracts).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.contractId, blocked))).length).toBe(0);

    // Scheduled runs respect the run day and run once per month.
    await setPolicy(1, 10);
    expect((await runBillingAutomation({ asOf: "2026-10-05", trigger: "schedule" })).reason).toMatch(/Run day is the 10/);
    const prepared = await runBillingAutomation({ asOf: "2026-10-12", trigger: "schedule" });
    expect(prepared.ran).toBe(true);
    expect(prepared.prepared.some((p) => p.contractName === "Steady")).toBe(true);
    expect(prepared.prepared.some((p) => p.contractName === "No link")).toBe(false);
    const steadyOct = (await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.contractId, steady))).find((d) => d.periodStart === "2026-10-01")!;
    expect(steadyOct).toMatchObject({ status: "draft", preparedByUserId: null });
    expect((await runBillingAutomation({ asOf: "2026-10-20", trigger: "schedule" })).reason).toMatch(/Already ran this month/);
    const last = await lastAutomationRun();
    expect(last?.value).toMatchObject({ asOf: "2026-10-12", level: 1, trigger: "schedule" });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "billing.automation.run")).orderBy(desc(auditLog.at)).limit(1);
    expect(entry).toMatchObject({ actorType: "system", actorUserId: null });
    expect((entry.details as { policy: string }).policy).toBe("level 1");

    // Level 2: the unchanged October draft is created in Xero; a first-ever draft is left for a person.
    await setPolicy(2, 1);
    const approved = await runBillingAutomation({ asOf: "2026-11-02", trigger: "manual", actorUserId: admin.id });
    expect(approved.approved.some((a) => a.id === steadyOct.id)).toBe(true);
    expect((await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.id, steadyOct.id)))[0]).toMatchObject({ status: "created", approvedByUserId: admin.id });
    // November for Steady was prepared in this run too; it is a plain unchanged draft and so also created.
    const novDraft = (await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.contractId, steady))).find((d) => d.periodStart === "2026-11-01")!;
    expect(novDraft).toBeTruthy();
    expect(approved.approvalSkipped.every((s) => s.id !== steadyOct.id)).toBe(true);
  });
});
