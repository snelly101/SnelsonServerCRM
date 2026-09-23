import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { inboundEvents, pipelineStages, syncRuns, tasks } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract } from "@/services/contracts";
import { createOpportunity } from "@/services/opportunities";
import { contractSchema, opportunitySchema } from "@/lib/validation-sales";
import { devicesReport, exportReportCsv, forecastByMonth, integrationHealthReport, mrrReport, outstandingInvoicesReport, overdueTasksReport, pipelineByStage, renewalsReport } from "@/services/reports";
import { runRetention, RETENTION } from "@/services/retention";
import { setSystemStatus, workerHealth } from "@/lib/system-status";
import { heartbeat } from "@/worker/jobs";
import { makeUser } from "./helpers";

let admin: { id: string };
const iso = (daysFromNow: number) => new Date(Date.now() + daysFromNow * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "reports admin");
});

describe("reports", () => {
  let companyA: string;
  let companyB: string;

  it("MRR report follows the documented formula, groups by customer and category, and flags missing costs", async () => {
    companyA = await createCompany(companySchema.parse({ name: "Report Co A" }), admin.id);
    companyB = await createCompany(companySchema.parse({ name: "Report Co B" }), admin.id);
    const line = (description: string, quantity: number, unitPrice: number, unitCost: number | null, billingFrequency: "monthly" | "quarterly" | "annual" = "monthly") => ({ id: null, productId: null, siteId: null, description, revenueType: "recurring" as const, pricingModel: "per_user" as const, billingFrequency, quantity, unitPrice, unitCost, countsAsManagedDevice: false });
    await createContract(contractSchema.parse({ companyId: companyA, name: "A MSA", startDate: "2026-01-01", status: "active", renewalDate: iso(20), noticePeriodDays: 30 }), [line("Users", 10, 50, 20), line("Annual firewall", 1, 1200, 600, "annual"), line("Quarterly backup", 1, 300, null, "quarterly"), { ...line("Setup", 1, 500, 100), revenueType: "one_off_project", pricingModel: "one_off", billingFrequency: "one_off" }], admin.id);
    await createContract(contractSchema.parse({ companyId: companyB, name: "B MSA", startDate: "2026-01-01", status: "active", renewalDate: iso(75) }), [line("Users", 4, 50, 20)], admin.id);
    await createContract(contractSchema.parse({ companyId: companyB, name: "B draft", startDate: "2026-01-01", status: "draft" }), [line("Ignored", 100, 100, 1)], admin.id);
    const r = await mrrReport();
    const a = r.byCompany.find((c) => c.companyId === companyA)!;
    const b = r.byCompany.find((c) => c.companyId === companyB)!;
    expect(a.mrr).toBeCloseTo(10 * 50 + 1200 / 12 + 300 / 3, 5); // 700
    expect(a.oneOff).toBe(500);
    expect(a.marginIsEstimate).toBe(true);
    expect(a.marginPercent).toBeNull();
    expect(b.mrr).toBe(200);
    expect(b.marginPercent).toBeCloseTo(60, 5);
    expect(b.marginIsEstimate).toBe(false);
    expect(r.mrr).toBeGreaterThanOrEqual(900);
    expect(r.arr).toBeCloseTo(r.mrr * 12, 5);
    expect(r.byCategory.find((k) => k.category === "other")!.mrr).toBeGreaterThanOrEqual(900);
    expect(r.formula).toContain("÷ months per billing period");
    expect(r.byCompany[0].share).toBeGreaterThan(r.byCompany[r.byCompany.length - 1].share);
    const csv = await exportReportCsv("mrr");
    expect(csv.split(/\r?\n/)[0]).toBe("company,activeContracts,mrr,arr,oneOff,hardware,marginPercent,marginIsEstimate,shareOfMrrPercent");
    expect(csv).toContain("Report Co A,1,700,8400,500,0,,true");
  });

  it("pipeline by stage and weighted forecast bucket by expected close month", async () => {
    const [stage] = await db.select().from(pipelineStages).where(eq(pipelineStages.isWon, false)).limit(1);
    const oppLine = (quantity: number, unitPrice: number) => ({ id: null, productId: null, description: "Users", revenueType: "recurring" as const, pricingModel: "per_user" as const, billingFrequency: "monthly" as const, quantity, unitPrice, unitCost: null });
    const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 15)).toISOString().slice(0, 10);
    await createOpportunity(opportunitySchema.parse({ companyId: companyA, title: "Forecast next month", stageId: stage.id, probability: 50, expectedCloseDate: nextMonth }), [oppLine(10, 100)], admin.id);
    await createOpportunity(opportunitySchema.parse({ companyId: companyA, title: "Forecast overdue", stageId: stage.id, probability: 20, expectedCloseDate: iso(-10) }), [oppLine(1, 1200)], admin.id);
    await createOpportunity(opportunitySchema.parse({ companyId: companyB, title: "Forecast unscheduled", stageId: stage.id, probability: 10 }), [oppLine(1, 100)], admin.id);
    const p = await pipelineByStage();
    const s = p.stages.find((x) => x.stageId === stage.id)!;
    expect(s.count).toBeGreaterThanOrEqual(3);
    expect(s.overdueClose).toBeGreaterThanOrEqual(1);
    expect(p.totals.weighted).toBeLessThan(p.totals.value);
    const f = await forecastByMonth(6);
    expect(f.isEstimate).toBe(true);
    expect(f.months[1].weighted).toBeCloseTo(12000 * 0.5, 5); // 10 × 100 × 12 first-year value × 50%
    expect(f.months[1].mrr).toBe(1000);
    expect(f.overdue.weighted).toBeCloseTo(14400 * 0.2, 5);
    expect(f.unscheduled.count).toBeGreaterThanOrEqual(1);
    expect((await exportReportCsv("forecast")).split(/\r?\n/).length).toBeGreaterThan(12);
  });

  it("renewals fall into 30/60/90-day buckets with notice deadlines; overdue tasks are grouped by owner", async () => {
    const r = await renewalsReport();
    const a = r.rows.find((x) => x.name === "A MSA")!;
    expect(a.bucket).toBe("30");
    expect(a.noticePassed).toBe(true); // renewal in 20 days, 30-day notice
    expect(r.rows.find((x) => x.name === "B MSA")!.bucket).toBe("90");
    expect(r.buckets.d30.mrr).toBeGreaterThanOrEqual(700);
    expect(r.rows.some((x) => x.name === "B draft")).toBe(false);

    await db.insert(tasks).values([
      { title: "Overdue one", status: "open", dueDate: iso(-3), ownerUserId: admin.id, companyId: companyA },
      { title: "Overdue two", status: "open", dueDate: iso(-1), ownerUserId: null },
      { title: "Done overdue", status: "done", dueDate: iso(-5), ownerUserId: admin.id },
      { title: "Future", status: "open", dueDate: iso(5), ownerUserId: admin.id },
    ]);
    const t = await overdueTasksReport();
    expect(t.byOwner.find((o) => o.ownerId === admin.id)!.overdue).toBeGreaterThanOrEqual(1);
    expect(t.byOwner.find((o) => o.owner === "Unassigned")!.overdue).toBeGreaterThanOrEqual(1);
    expect(t.overdue.some((x) => x.title === "Done overdue")).toBe(false);
    expect(t.overdue.some((x) => x.title === "Future")).toBe(false);
    expect(t.overdue[0].dueDate! <= t.overdue[t.overdue.length - 1].dueDate!).toBe(true);
  });

  it("finance, device and integration-health reports label demo data and never show a demo connector as connected", async () => {
    const inv = await outstandingInvoicesReport();
    expect(inv.demo).toBe(true);
    expect(["live", "cached", "stale", "unavailable"]).toContain(inv.freshness);
    expect(inv.source).toMatch(/Xero/);
    const dev = await devicesReport();
    expect(dev.demo).toBe(true);
    expect(dev.isEstimate).toBe(true);
    const h = await integrationHealthReport();
    expect(h.providers).toHaveLength(4);
    for (const p of h.providers) {
      expect(p.demo).toBe(true);
      expect(p.status).not.toBe("connected");
    }
    expect(h.worker.status).toBe("never");
  });
});

describe("worker heartbeat and retention", () => {
  it("heartbeat makes the worker alive; an old heartbeat is stale", async () => {
    await heartbeat("tick");
    const w = await workerHealth();
    expect(w.status).toBe("alive");
    expect(w.mode).toBe("tick");
    await db.execute(`update system_status set updated_at = now() - interval '20 minutes' where key = 'worker.heartbeat'`);
    expect((await workerHealth()).status).toBe("stale");
  });

  it("retention deletes old sync runs and processed inbound events but keeps recent and unprocessed rows", async () => {
    const old = new Date(Date.now() - (RETENTION.syncRunDays + 1) * 86400000);
    const oldEvent = new Date(Date.now() - (RETENTION.inboundEventDays + 1) * 86400000);
    await db.insert(syncRuns).values([
      { provider: "xero", kind: "test", trigger: "manual", status: "success", startedAt: old, finishedAt: old },
      { provider: "xero", kind: "test", trigger: "manual", status: "success" },
    ]);
    await db.insert(inboundEvents).values([
      { provider: "xero", eventId: "ret-old-processed", eventType: "x", receivedAt: oldEvent, processedAt: oldEvent },
      { provider: "xero", eventId: "ret-old-unprocessed", eventType: "x", receivedAt: oldEvent },
      { provider: "xero", eventId: "ret-new", eventType: "x", processedAt: new Date() },
    ]);
    const r = await runRetention();
    expect(r.syncRunsDeleted).toBeGreaterThanOrEqual(1);
    expect(r.inboundEventsDeleted).toBe(1);
    const remaining = await db.select({ id: inboundEvents.eventId }).from(inboundEvents);
    expect(remaining.map((x) => x.id)).toEqual(expect.arrayContaining(["ret-old-unprocessed", "ret-new"]));
    expect(remaining.map((x) => x.id)).not.toContain("ret-old-processed");
    await setSystemStatus("worker.heartbeat", { mode: "tick" });
  });
});
