import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import Papa from "papaparse";
import { db } from "@/db";
import { billingDiscrepancies, companies, contractLines, contracts, mappingConflicts, opportunities, pipelineStages, products, syncRuns, tasks, user, xeroContacts, xeroInvoices } from "@/db/schema";
import { monthlyValue, summariseLines, weighted, type LineLike } from "@/lib/money";
import { workerHealth } from "@/lib/system-status";
import { CATEGORY_LABELS } from "@/lib/validation-sales";
import { listConnections, PROVIDER_LABELS, type Provider } from "./integrations";
import { deviceTotals, ninjaConnectionSummary } from "./ninjaone";
import { financeTotals } from "./xero";
import { xeroConnectionSummary } from "./xero";
import { bpConnectionSummary } from "./proposals";

/**
 * Reporting. Every figure states its basis; anything derived from a mirror
 * carries a freshness label and anything computed from incomplete data is
 * flagged `isEstimate`.
 */
export const MRR_FORMULA = "MRR = Σ over active contracts, over recurring lines: contracted quantity × unit price ÷ months per billing period (monthly ÷ 1, quarterly ÷ 3, annual ÷ 12). One-off and hardware lines are excluded and shown separately. ARR = MRR × 12.";
export const FORECAST_FORMULA = "Weighted forecast = Σ open opportunities: first-year value × stage probability. First-year value = ARR + one-off + hardware. Grouped by expected close month; opportunities past their expected close date are shown separately, those without a date as unscheduled.";

const oppLines = sql<string>`(
  select coalesce(json_agg(json_build_object(
    'quantity', l.quantity, 'unitPrice', l.unit_price, 'unitCost', l.unit_cost,
    'revenueType', l.revenue_type, 'billingFrequency', l.billing_frequency)), '[]'::json)
  from opportunity_lines l where l.opportunity_id = opportunities.id)`;

const parse = (v: unknown): LineLike[] => (Array.isArray(v) ? (v as LineLike[]) : typeof v === "string" ? (JSON.parse(v) as LineLike[]) : []);

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
export async function pipelineByStage() {
  const stages = await db.select().from(pipelineStages).where(and(isNull(pipelineStages.archivedAt), eq(pipelineStages.isWon, false), eq(pipelineStages.isLost, false))).orderBy(asc(pipelineStages.sortOrder));
  const rows = await db.select({ stageId: opportunities.stageId, probability: opportunities.probability, lines: oppLines, expectedCloseDate: opportunities.expectedCloseDate }).from(opportunities).where(and(eq(opportunities.status, "open"), isNull(opportunities.archivedAt)));
  const today = new Date().toISOString().slice(0, 10);
  const out = stages.map((s) => ({ stageId: s.id, stage: s.name, color: s.color, probability: s.probability, count: 0, value: 0, weighted: 0, mrr: 0, overdueClose: 0 }));
  const byId = new Map(out.map((o) => [o.stageId, o]));
  for (const r of rows) {
    const s = summariseLines(parse(r.lines));
    const o = byId.get(r.stageId);
    if (!o) continue;
    o.count++;
    o.value += s.firstYearValue;
    o.weighted += weighted(s.firstYearValue, r.probability);
    o.mrr += s.mrr;
    if (r.expectedCloseDate && r.expectedCloseDate < today) o.overdueClose++;
  }
  const totals = out.reduce((a, o) => ({ count: a.count + o.count, value: a.value + o.value, weighted: a.weighted + o.weighted, mrr: a.mrr + o.mrr, overdueClose: a.overdueClose + o.overdueClose }), { count: 0, value: 0, weighted: 0, mrr: 0, overdueClose: 0 });
  return { stages: out, totals };
}

/** Weighted forecast for the next `months` months by expected close month, plus unscheduled. */
export async function forecastByMonth(months = 6) {
  const rows = await db
    .select({ id: opportunities.id, title: opportunities.title, companyName: companies.name, probability: opportunities.probability, lines: oppLines, expectedCloseDate: opportunities.expectedCloseDate })
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(and(eq(opportunities.status, "open"), isNull(opportunities.archivedAt)));
  const now = new Date();
  const keys: string[] = [];
  for (let i = 0; i < months; i++) keys.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1)).toISOString().slice(0, 7));
  const buckets = new Map(keys.map((k) => [k, { month: k, count: 0, value: 0, weighted: 0, mrr: 0 }]));
  const overdue = { month: "overdue", count: 0, value: 0, weighted: 0, mrr: 0 };
  const later = { month: "later", count: 0, value: 0, weighted: 0, mrr: 0 };
  const unscheduled = { month: "unscheduled", count: 0, value: 0, weighted: 0, mrr: 0 };
  const today = now.toISOString().slice(0, 10);
  for (const r of rows) {
    const s = summariseLines(parse(r.lines));
    const key = r.expectedCloseDate?.slice(0, 7);
    const b = !key ? unscheduled : r.expectedCloseDate! < today ? overdue : (buckets.get(key) ?? later);
    b.count++;
    b.value += s.firstYearValue;
    b.weighted += weighted(s.firstYearValue, r.probability);
    b.mrr += s.mrr;
  }
  return { months: [...buckets.values()], overdue, later, unscheduled, isEstimate: true };
}

// ---------------------------------------------------------------------------
// Recurring revenue
// ---------------------------------------------------------------------------
export async function mrrReport() {
  const rows = await db
    .select({ contractId: contracts.id, contractName: contracts.name, companyId: companies.id, companyName: companies.name, category: products.category, line: contractLines })
    .from(contractLines)
    .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
    .innerJoin(companies, eq(companies.id, contracts.companyId))
    .leftJoin(products, eq(products.id, contractLines.productId))
    .where(and(eq(contracts.status, "active"), isNull(contracts.archivedAt)));
  const byCompany = new Map<string, { companyId: string; companyName: string; contracts: Set<string>; mrr: number; oneOff: number; hardware: number; cost: number; missingCost: boolean }>();
  const byCategory = new Map<string, { category: string; label: string; mrr: number; lines: number }>();
  let mrr = 0;
  let oneOff = 0;
  let hardware = 0;
  let missingCost = false;
  let monthlyCost = 0;
  for (const r of rows) {
    const l = r.line;
    const m = monthlyValue(l);
    const c = byCompany.get(r.companyId) ?? { companyId: r.companyId, companyName: r.companyName, contracts: new Set<string>(), mrr: 0, oneOff: 0, hardware: 0, cost: 0, missingCost: false };
    c.contracts.add(r.contractId);
    if (l.revenueType === "recurring") {
      mrr += m;
      c.mrr += m;
      const cat = r.category ?? "other";
      const k = byCategory.get(cat) ?? { category: cat, label: CATEGORY_LABELS[cat as keyof typeof CATEGORY_LABELS] ?? cat, mrr: 0, lines: 0 };
      k.mrr += m;
      k.lines++;
      byCategory.set(cat, k);
      if (l.unitCost === null || l.unitCost === undefined) {
        missingCost = true;
        c.missingCost = true;
      } else {
        const mc = monthlyValue({ ...l, unitPrice: l.unitCost });
        monthlyCost += mc;
        c.cost += mc;
      }
    } else if (l.revenueType === "one_off_project") {
      oneOff += Number(l.quantity) * Number(l.unitPrice);
      c.oneOff += Number(l.quantity) * Number(l.unitPrice);
    } else {
      hardware += Number(l.quantity) * Number(l.unitPrice);
      c.hardware += Number(l.quantity) * Number(l.unitPrice);
    }
    byCompany.set(r.companyId, c);
  }
  const companiesOut = [...byCompany.values()]
    .map((c) => ({ companyId: c.companyId, companyName: c.companyName, contracts: c.contracts.size, mrr: c.mrr, arr: c.mrr * 12, oneOff: c.oneOff, hardware: c.hardware, marginPercent: c.mrr > 0 && !c.missingCost ? ((c.mrr - c.cost) / c.mrr) * 100 : null, marginIsEstimate: c.missingCost, share: mrr > 0 ? (c.mrr / mrr) * 100 : 0 }))
    .sort((a, b) => b.mrr - a.mrr);
  const top = companiesOut[0];
  return {
    formula: MRR_FORMULA,
    mrr,
    arr: mrr * 12,
    oneOff,
    hardware,
    grossMarginPercent: mrr > 0 && !missingCost ? ((mrr - monthlyCost) / mrr) * 100 : mrr > 0 ? ((mrr - monthlyCost) / mrr) * 100 : null,
    marginIsEstimate: missingCost,
    activeContracts: new Set(rows.map((r) => r.contractId)).size,
    customers: companiesOut.length,
    concentration: top ? { companyName: top.companyName, share: top.share } : null,
    byCompany: companiesOut,
    byCategory: [...byCategory.values()].sort((a, b) => b.mrr - a.mrr),
  };
}

// ---------------------------------------------------------------------------
// Renewals and reviews
// ---------------------------------------------------------------------------
export async function renewalsReport() {
  const lines = sql<string>`(
    select coalesce(json_agg(json_build_object('quantity', l.quantity, 'unitPrice', l.unit_price, 'unitCost', l.unit_cost, 'revenueType', l.revenue_type, 'billingFrequency', l.billing_frequency)), '[]'::json)
    from contract_lines l where l.contract_id = contracts.id)`;
  const rows = await db
    .select({ id: contracts.id, name: contracts.name, companyId: contracts.companyId, companyName: companies.name, owner: user.name, status: contracts.status, renewalDate: contracts.renewalDate, endDate: contracts.endDate, noticePeriodDays: contracts.noticePeriodDays, autoRenew: contracts.autoRenew, nextReviewDate: contracts.nextReviewDate, lines })
    .from(contracts)
    .innerJoin(companies, eq(companies.id, contracts.companyId))
    .leftJoin(user, eq(user.id, contracts.ownerUserId))
    .where(and(isNull(contracts.archivedAt), eq(contracts.status, "active")))
    .orderBy(asc(contracts.renewalDate));
  const today = new Date();
  const dayDiff = (d: string | null) => (d ? Math.round((new Date(d).getTime() - today.getTime()) / 86400000) : null);
  const out = rows.map((r) => {
    const s = summariseLines(parse(r.lines));
    const days = dayDiff(r.renewalDate);
    const noticeDeadline = r.renewalDate ? new Date(new Date(r.renewalDate).getTime() - r.noticePeriodDays * 86400000).toISOString().slice(0, 10) : null;
    const bucket = days === null ? "none" : days < 0 ? "overdue" : days <= 30 ? "30" : days <= 60 ? "60" : days <= 90 ? "90" : "later";
    return { id: r.id, name: r.name, companyId: r.companyId, companyName: r.companyName, owner: r.owner, renewalDate: r.renewalDate, daysToRenewal: days, noticeDeadline, noticePassed: Boolean(noticeDeadline && noticeDeadline < today.toISOString().slice(0, 10)), autoRenew: r.autoRenew, nextReviewDate: r.nextReviewDate, reviewOverdue: Boolean(r.nextReviewDate && r.nextReviewDate < today.toISOString().slice(0, 10)), mrr: s.mrr, arr: s.arr, bucket };
  });
  const sum = (b: string[]) => out.filter((r) => b.includes(r.bucket)).reduce((a, r) => ({ count: a.count + 1, mrr: a.mrr + r.mrr }), { count: 0, mrr: 0 });
  return { rows: out.filter((r) => r.bucket !== "later" && r.bucket !== "none"), buckets: { overdue: sum(["overdue"]), d30: sum(["30"]), d60: sum(["60"]), d90: sum(["90"]) }, reviewsOverdue: out.filter((r) => r.reviewOverdue).length, noRenewalDate: out.filter((r) => r.bucket === "none").length };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
export async function overdueTasksReport() {
  const rows = await db
    .select({ ownerId: user.id, owner: user.name, overdue: sql<number>`count(*) filter (where ${tasks.dueDate} < current_date)`.mapWith(Number), dueToday: sql<number>`count(*) filter (where ${tasks.dueDate} = current_date)`.mapWith(Number), open: sql<number>`count(*)`.mapWith(Number), oldest: sql<string | null>`min(${tasks.dueDate}) filter (where ${tasks.dueDate} < current_date)` })
    .from(tasks)
    .leftJoin(user, eq(user.id, tasks.ownerUserId))
    .where(eq(tasks.status, "open"))
    .groupBy(user.id, user.name)
    .orderBy(desc(sql`count(*) filter (where ${tasks.dueDate} < current_date)`));
  const list = await db
    .select({ id: tasks.id, title: tasks.title, dueDate: tasks.dueDate, priority: tasks.priority, owner: user.name, companyId: tasks.companyId, companyName: companies.name })
    .from(tasks)
    .leftJoin(user, eq(user.id, tasks.ownerUserId))
    .leftJoin(companies, eq(companies.id, tasks.companyId))
    .where(and(eq(tasks.status, "open"), sql`${tasks.dueDate} < current_date`))
    .orderBy(asc(tasks.dueDate))
    .limit(50);
  const totals = rows.reduce((a, r) => ({ overdue: a.overdue + r.overdue, dueToday: a.dueToday + r.dueToday, open: a.open + r.open }), { overdue: 0, dueToday: 0, open: 0 });
  return { byOwner: rows.map((r) => ({ ...r, owner: r.owner ?? "Unassigned" })), overdue: list, totals };
}

// ---------------------------------------------------------------------------
// Finance (requires report.finance.read)
// ---------------------------------------------------------------------------
export async function outstandingInvoicesReport() {
  const xero = await xeroConnectionSummary();
  const totals = await financeTotals();
  const byCompany = await db
    .select({ companyId: companies.id, companyName: companies.name, contactName: xeroContacts.name, outstanding: sql<number>`coalesce(sum(xero_invoices.amount_due) filter (where xero_invoices.status = 'AUTHORISED'), 0)`.mapWith(Number), overdue: sql<number>`coalesce(sum(xero_invoices.amount_due) filter (where xero_invoices.status = 'AUTHORISED' and xero_invoices.due_date < current_date), 0)`.mapWith(Number), count: sql<number>`count(*) filter (where xero_invoices.status = 'AUTHORISED')`.mapWith(Number), oldestDue: sql<string | null>`min(xero_invoices.due_date) filter (where xero_invoices.status = 'AUTHORISED' and xero_invoices.due_date < current_date)` })
    .from(xeroInvoices)
    .leftJoin(companies, eq(companies.id, xeroInvoices.companyId))
    .leftJoin(xeroContacts, eq(xeroContacts.contactId, xeroInvoices.contactId))
    .where(and(eq(xeroInvoices.type, "ACCREC"), eq(xeroInvoices.status, "AUTHORISED")))
    .groupBy(companies.id, companies.name, xeroContacts.name)
    .orderBy(desc(sql`coalesce(sum(xero_invoices.amount_due) filter (where xero_invoices.status = 'AUTHORISED'), 0)`))
    .limit(50);
  const age = Date.now() - (totals.lastFetched ? new Date(totals.lastFetched).getTime() : 0);
  const freshness = !totals.lastFetched ? "unavailable" : age < 5 * 60_000 ? "live" : age < 3 * 3600_000 ? "cached" : "stale";
  return { ...totals, byCompany: byCompany.map((r) => ({ ...r, companyName: r.companyName ?? `${r.contactName ?? "Unknown"} (not linked)` })), demo: xero.demo, configured: xero.configured, freshness, source: "Xero mirror (invoice status and amounts are owned by Xero)" };
}

// ---------------------------------------------------------------------------
// Devices and integration health
// ---------------------------------------------------------------------------
export async function devicesReport() {
  const conn = await ninjaConnectionSummary();
  const totals = await deviceTotals();
  const [disc] = await db.select({ open: sql<number>`count(*) filter (where status = 'open')`.mapWith(Number), accepted: sql<number>`count(*) filter (where status = 'accepted')`.mapWith(Number), unbilledPerPeriod: sql<number>`coalesce(sum(case when status = 'open' and difference > 0 then difference * coalesce(unit_price, 0) else 0 end), 0)`.mapWith(Number), overbilledPerPeriod: sql<number>`coalesce(sum(case when status = 'open' and difference < 0 then -difference * coalesce(unit_price, 0) else 0 end), 0)`.mapWith(Number) }).from(billingDiscrepancies);
  return { configured: conn.configured, demo: conn.demo, totals, discrepancies: disc, isEstimate: true };
}

export async function integrationHealthReport() {
  const [conns, worker, bp, xero, ninja, failed, conflicts] = await Promise.all([
    listConnections(),
    workerHealth(),
    bpConnectionSummary(),
    xeroConnectionSummary(),
    ninjaConnectionSummary(),
    db.select({ provider: syncRuns.provider, failed: sql<number>`count(*) filter (where status = 'failed')`.mapWith(Number), partial: sql<number>`count(*) filter (where status = 'partial')`.mapWith(Number), runs: sql<number>`count(*)`.mapWith(Number), errors: sql<number>`coalesce(sum(errors), 0)`.mapWith(Number) }).from(syncRuns).where(gte(syncRuns.startedAt, new Date(Date.now() - 86400000))).groupBy(syncRuns.provider),
    db.select({ provider: mappingConflicts.provider, open: sql<number>`count(*)`.mapWith(Number) }).from(mappingConflicts).where(eq(mappingConflicts.status, "open")).groupBy(mappingConflicts.provider),
  ]);
  const demo: Record<Provider, boolean> = { betterproposals: bp.demo, xero: xero.demo, ninjaone: ninja.demo };
  const f = new Map(failed.map((r) => [r.provider, r]));
  const c = new Map(conflicts.map((r) => [r.provider, r.open]));
  const providers = conns.map((x) => {
    const p = x.provider as Provider;
    const stats = f.get(p);
    return { provider: p, label: PROVIDER_LABELS[p], status: x.status, demo: demo[p], lastSuccessfulSyncAt: x.lastSuccessfulSyncAt, lastTestedAt: x.lastTestedAt, lastError: x.lastError, pausedUntil: x.pausedUntil, runs24h: stats?.runs ?? 0, failed24h: stats?.failed ?? 0, partial24h: stats?.partial ?? 0, errors24h: stats?.errors ?? 0, openConflicts: c.get(p) ?? 0 };
  });
  return { worker, providers, openConflicts: providers.reduce((a, p) => a + p.openConflicts, 0) };
}

// ---------------------------------------------------------------------------
// CSV exports
// ---------------------------------------------------------------------------
export const REPORT_EXPORTS = ["pipeline", "forecast", "mrr", "renewals", "overdue-tasks", "outstanding-invoices"] as const;
export type ReportExport = (typeof REPORT_EXPORTS)[number];

export async function exportReportCsv(kind: ReportExport): Promise<string> {
  const round = (n: number) => Math.round(n * 100) / 100;
  switch (kind) {
    case "pipeline": {
      const r = await pipelineByStage();
      return Papa.unparse(r.stages.map((s) => ({ stage: s.stage, probability: s.probability, opportunities: s.count, firstYearValue: round(s.value), weighted: round(s.weighted), mrr: round(s.mrr), overdueClose: s.overdueClose })));
    }
    case "forecast": {
      const r = await forecastByMonth(12);
      return Papa.unparse([r.overdue, ...r.months, r.later, r.unscheduled].map((b) => ({ month: b.month, opportunities: b.count, firstYearValue: round(b.value), weighted: round(b.weighted), mrr: round(b.mrr) })));
    }
    case "mrr": {
      const r = await mrrReport();
      return Papa.unparse(r.byCompany.map((c) => ({ company: c.companyName, activeContracts: c.contracts, mrr: round(c.mrr), arr: round(c.arr), oneOff: round(c.oneOff), hardware: round(c.hardware), marginPercent: c.marginPercent === null ? "" : round(c.marginPercent), marginIsEstimate: c.marginIsEstimate, shareOfMrrPercent: round(c.share) })));
    }
    case "renewals": {
      const r = await renewalsReport();
      return Papa.unparse(r.rows.map((x) => ({ company: x.companyName, contract: x.name, owner: x.owner ?? "", renewalDate: x.renewalDate ?? "", daysToRenewal: x.daysToRenewal ?? "", noticeDeadline: x.noticeDeadline ?? "", noticePassed: x.noticePassed, autoRenew: x.autoRenew, nextReviewDate: x.nextReviewDate ?? "", mrr: round(x.mrr) })));
    }
    case "overdue-tasks": {
      const r = await overdueTasksReport();
      return Papa.unparse(r.overdue.map((t) => ({ title: t.title, dueDate: t.dueDate ?? "", priority: t.priority, owner: t.owner ?? "", company: t.companyName ?? "" })));
    }
    case "outstanding-invoices": {
      const r = await outstandingInvoicesReport();
      return Papa.unparse(r.byCompany.map((c) => ({ company: c.companyName, invoices: c.count, outstanding: round(c.outstanding), overdue: round(c.overdue), oldestOverdueDue: c.oldestDue ?? "" })));
    }
  }
}
