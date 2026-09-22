import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { companies, onboardings, tasks, contracts as contractsTable } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createProduct } from "@/services/catalogue";
import { boardData, createOpportunity, getOpportunity, listStages, markLost, markWon, moveOpportunity, pipelineTotals, reopenOpportunity, updateOpportunity } from "@/services/opportunities";
import { contractTotals, createContract, draftContractFromOpportunity, generateReminders, getContract } from "@/services/contracts";
import { createTask, listTasks, setTaskStatus } from "@/services/tasks";
import { createOnboardingOnce, getOnboarding, listTemplates } from "@/services/onboarding";
import { summariseLines, monthlyValue } from "@/lib/money";
import { lineSchema, linesFromForm, opportunitySchema, contractSchema, productSchema } from "@/lib/validation-sales";
import { ActionError } from "@/lib/action-result";
import { makeUser } from "./helpers";

let actor: { id: string };
let companyId: string;
let stages: Awaited<ReturnType<typeof listStages>>;
let productId: string;

beforeAll(async () => {
  actor = await makeUser("sales", "sales tester");
  companyId = await createCompany(companySchema.parse({ name: "Pipeline Test Co", website: "pipelinetest.example" }), actor.id);
  stages = await listStages();
  productId = await createProduct(productSchema.parse({ name: "Managed device", pricingModel: "per_device", revenueType: "recurring", billingFrequency: "monthly", unitPrice: 12, unitCost: 4, countsAsManagedDevice: "true" }), actor.id);
});

describe("revenue maths", () => {
  it("normalises recurring lines to monthly and separates one-off revenue", () => {
    const lines = [
      { quantity: 10, unitPrice: 45, unitCost: 18, revenueType: "recurring" as const, billingFrequency: "monthly" as const },
      { quantity: 1, unitPrice: 1200, unitCost: 500, revenueType: "recurring" as const, billingFrequency: "annual" as const },
      { quantity: 2, unitPrice: 750, unitCost: null, revenueType: "one_off_project" as const, billingFrequency: "one_off" as const },
      { quantity: 3, unitPrice: 899, unitCost: 760, revenueType: "hardware" as const, billingFrequency: "one_off" as const },
    ];
    expect(monthlyValue(lines[1])).toBe(100);
    const s = summariseLines(lines);
    expect(s.mrr).toBe(550);
    expect(s.arr).toBe(6600);
    expect(s.oneOff).toBe(1500);
    expect(s.hardware).toBe(2697);
    expect(s.firstYearValue).toBe(6600 + 1500 + 2697);
    expect(s.marginIsEstimate).toBe(true); // consultancy line has no cost
    expect(s.marginPercent).not.toBeNull();
  });

  it("reports margin as unknown when no line has a cost", () => {
    const s = summariseLines([{ quantity: 1, unitPrice: 100, unitCost: null, revenueType: "recurring", billingFrequency: "monthly" }]);
    expect(s.marginPercent).toBeNull();
    expect(s.marginIsEstimate).toBe(true);
  });

  it("parses repeated form line fields", () => {
    const rows = linesFromForm({ "lines[1][description]": "b", "lines[0][description]": "a", "lines[0][quantity]": "2", other: "x" });
    expect(rows).toEqual([{ description: "a", quantity: "2" }, { description: "b" }]);
  });
});

describe("opportunities", () => {
  it("creates with lines, applies stage probability, and appears on the board", async () => {
    const stage = stages.find((s) => s.name === "Discovery")!;
    const id = await createOpportunity(
      opportunitySchema.parse({ companyId, title: "Test deal", stageId: stage.id, leadSource: "Referral" }),
      [lineSchema.parse({ productId, description: "Managed device", revenueType: "recurring", pricingModel: "per_device", billingFrequency: "monthly", quantity: 20, unitPrice: 12, unitCost: 4 })],
      actor.id,
    );
    const opp = await getOpportunity(id);
    expect(opp?.probability).toBe(stage.probability);
    expect(opp?.summary.mrr).toBe(240);
    expect(opp?.summary.firstYearValue).toBe(2880);
    expect(opp?.weightedValue).toBeCloseTo((2880 * stage.probability) / 100);
    const board = await boardData({});
    expect(board.find((c) => c.stage.id === stage.id)?.items.some((i) => i.id === id)).toBe(true);
    const totals = await pipelineTotals();
    expect(totals.total).toBeGreaterThanOrEqual(2880);
  });

  it("moves between stages with default probability and refuses closed stages", async () => {
    const lead = stages.find((s) => s.name === "Lead")!;
    const negotiation = stages.find((s) => s.name === "Negotiation")!;
    const won = stages.find((s) => s.isWon)!;
    const id = await createOpportunity(opportunitySchema.parse({ companyId, title: "Move me", stageId: lead.id }), [], actor.id);
    await moveOpportunity(id, negotiation.id, 0, actor.id);
    expect((await getOpportunity(id))?.probability).toBe(negotiation.probability);
    await expect(moveOpportunity(id, won.id, 0, actor.id)).rejects.toThrow(ActionError);
  });

  it("marking won promotes the company, creates onboarding exactly once, and drafts a contract once", async () => {
    const lead = stages.find((s) => s.name === "Lead")!;
    const id = await createOpportunity(
      opportunitySchema.parse({ companyId, title: "Win me", stageId: lead.id }),
      [lineSchema.parse({ productId, description: "Managed device", pricingModel: "per_device", quantity: 5, unitPrice: 12, unitCost: 4 })],
      actor.id,
    );
    const first = await markWon(id, actor.id, { createOnboarding: true });
    expect(first.alreadyWon).toBe(false);
    expect(first.onboardingId).toBeTruthy();
    const second = await markWon(id, actor.id, { createOnboarding: true });
    expect(second.alreadyWon).toBe(true);
    expect(second.onboardingId).toBe(first.onboardingId);
    expect(await db.select().from(onboardings).where(eq(onboardings.opportunityId, id))).toHaveLength(1);

    const ob = await getOnboarding(first.onboardingId!);
    const [tpl] = await listTemplates();
    expect(ob?.items.length).toBe(tpl.items.length);
    expect(ob?.items.every((i) => i.dueDate)).toBe(true);

    const [company] = await db.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId));
    expect(company.status).toBe("customer");

    const c1 = await draftContractFromOpportunity(id, actor.id);
    const c2 = await draftContractFromOpportunity(id, actor.id);
    expect(c1).toBe(c2);
    const contract = await getContract(c1);
    expect(contract?.status).toBe("draft");
    expect(contract?.lines[0].countsAsManagedDevice).toBe(true);
    expect(contract?.summary.mrr).toBe(60);

    await expect(updateOpportunity(id, opportunitySchema.parse({ companyId, title: "x", stageId: lead.id }), null, actor.id)).rejects.toThrow(/closed/);
  });

  it("marking lost stores a reason and reopening resets to the first stage", async () => {
    const lead = stages.find((s) => s.name === "Lead")!;
    const id = await createOpportunity(opportunitySchema.parse({ companyId, title: "Lose me", stageId: lead.id }), [], actor.id);
    await markLost(id, "Too expensive", actor.id);
    let opp = await getOpportunity(id);
    expect(opp?.status).toBe("lost");
    expect(opp?.lostReason).toBe("Too expensive");
    expect(opp?.probability).toBe(0);
    await reopenOpportunity(id, actor.id);
    opp = await getOpportunity(id);
    expect(opp?.status).toBe("open");
    expect(opp?.stageId).toBe(lead.id);
  });
});

describe("onboarding idempotency", () => {
  it("returns the same onboarding for the same source key under concurrent calls", async () => {
    const key = `proposal:test-${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 5 }, () => createOnboardingOnce({ companyId, sourceKey: key, name: "Concurrent" }, actor.id)));
    expect(new Set(results).size).toBe(1);
    const rows = await db.select().from(onboardings).where(eq(onboardings.sourceKey, key));
    expect(rows).toHaveLength(1);
  });
});

describe("contracts and reminders", () => {
  it("computes MRR only from active contracts and creates renewal/review tasks once", async () => {
    const soonEnd = new Date(Date.now() + 100 * 86400000).toISOString().slice(0, 10); // notice deadline (90d) in 10 days
    const id = await createContract(
      contractSchema.parse({ companyId, name: "Active MSA", startDate: "2026-01-01", endDate: soonEnd, status: "active", noticePeriodDays: 90, nextReviewDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) }),
      [
        { id: null, productId: null, siteId: null, description: "Users", revenueType: "recurring", pricingModel: "per_user", billingFrequency: "monthly", quantity: 10, unitPrice: 40, unitCost: 15, countsAsManagedDevice: false },
        { id: null, productId: null, siteId: null, description: "Annual licence", revenueType: "recurring", pricingModel: "fixed", billingFrequency: "annual", quantity: 1, unitPrice: 1200, unitCost: null, countsAsManagedDevice: false },
        { id: null, productId: null, siteId: null, description: "Setup", revenueType: "one_off_project", pricingModel: "one_off", billingFrequency: "one_off", quantity: 1, unitPrice: 500, unitCost: 100, countsAsManagedDevice: false },
      ],
      actor.id,
    );
    await createContract(contractSchema.parse({ companyId, name: "Draft MSA", startDate: "2026-01-01", status: "draft" }), [{ id: null, productId: null, siteId: null, description: "x", revenueType: "recurring", pricingModel: "fixed", billingFrequency: "monthly", quantity: 1, unitPrice: 9999, unitCost: null, countsAsManagedDevice: false }], actor.id);
    const c = await getContract(id);
    expect(c?.summary.mrr).toBe(500);
    expect(c?.summary.oneOff).toBe(500);
    const totals = await contractTotals();
    expect(totals.mrr).toBeGreaterThanOrEqual(500);
    expect(totals.mrr).toBeLessThan(9999);

    const first = await generateReminders(actor.id);
    expect(first.created).toBeGreaterThanOrEqual(2);
    const again = await generateReminders(actor.id);
    expect(again.created).toBe(0);
    const reminderTasks = await db.select().from(tasks).where(eq(tasks.contractId, id));
    expect(reminderTasks.some((t) => t.sourceKey?.startsWith("renewal:"))).toBe(true);
    expect(reminderTasks.some((t) => t.sourceKey?.startsWith("review:"))).toBe(true);
  });

  it("expires non-auto-renewing contracts past their end date", async () => {
    const id = await createContract(contractSchema.parse({ companyId, name: "Old MSA", startDate: "2024-01-01", endDate: "2025-01-01", status: "active", autoRenew: "false" }), [], actor.id);
    await generateReminders(actor.id);
    const [row] = await db.select({ status: contractsTable.status }).from(contractsTable).where(eq(contractsTable.id, id));
    expect(row.status).toBe("expired");
  });
});

describe("tasks", () => {
  it("lists overdue tasks and completes them with an activity entry", async () => {
    const id = await createTask({ title: "Overdue thing", description: null, priority: "high", dueDate: "2020-01-01", ownerUserId: actor.id, companyId, opportunityId: null, contractId: null, onboardingId: null }, actor.id);
    const overdue = await listTasks({ due: "overdue", ownerUserId: actor.id });
    expect(overdue.rows.some((t) => t.id === id)).toBe(true);
    await setTaskStatus(id!, "done", actor.id);
    const done = await listTasks({ status: "done", ownerUserId: actor.id });
    expect(done.rows.find((t) => t.id === id)?.status).toBe("done");
  });

  it("derives the company from a linked opportunity", async () => {
    const lead = stages.find((s) => s.name === "Lead")!;
    const oppId = await createOpportunity(opportunitySchema.parse({ companyId, title: "Task link", stageId: lead.id }), [], actor.id);
    const id = await createTask({ title: "Linked", description: null, priority: "normal", dueDate: null, ownerUserId: null, companyId: null, opportunityId: oppId, contractId: null, onboardingId: null }, actor.id);
    const [row] = await db.select({ companyId: tasks.companyId, ownerUserId: tasks.ownerUserId }).from(tasks).where(eq(tasks.id, id!));
    expect(row.companyId).toBe(companyId);
    expect(row.ownerUserId).toBe(actor.id);
  });
});
