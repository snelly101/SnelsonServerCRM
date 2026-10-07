import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { billingDiscrepancies, companies, contractLines, contracts, sites } from "@/db/schema";
import { billingPeriodFor, PERIOD_MONTHS } from "@/lib/billing";
import { summariseLines } from "@/lib/money";
import { lineChangesFor } from "./contracts";
import { serviceRegisterRows, type RegisterRow } from "./service-register";

/**
 * The billing picture: what we bill a customer, what each service costs us,
 * where each quantity comes from and whether it agrees with the agreement,
 * built per agreement and per line from the contract, the dated history,
 * the service register and the review queue. Read by the company Billing
 * tab and the contract page so both answer the same questions the same way.
 */
const round2 = (n: number) => Math.round(n * 100) / 100;

import { LINE_STATUS_LABELS, type LineStatus } from "@/lib/billing-model";
export { LINE_STATUS_LABELS, type LineStatus };

export type LineView = {
  id: string;
  description: string;
  revenueType: string;
  pricingModel: string;
  billingFrequency: string;
  invoiceSchedule: string;
  reductionPolicy: string;
  quantityRule: string;
  siteName: string | null;
  countsAsManagedDevice: boolean;
  /** The agreed (billed) quantity. */
  quantity: number;
  unitPrice: number;
  /** The cost recorded on the line, per unit per line period. */
  unitCost: number | null;
  /** Services the integrations supply against this line (charged on it, or bundled into it). */
  sources: RegisterRow[];
  /** Sum of the sources' quantities; null when nothing supplies the line. */
  observed: number | null;
  /** Supplier cost per month for the whole line, from sources whose supplier prices them. */
  supplierMonthlyCost: number | null;
  /** Sources whose provider carries no pricing (cost unknown, not zero). */
  unknownCostSources: number;
  /** Sell price per month per unit, and cost per month per unit (live from the supplier where known, else the recorded cost). */
  sellMonthlyPerUnit: number;
  costMonthlyPerUnit: number | null;
  costBasis: "supplier" | "recorded" | "unknown";
  /** Charge, cost and margin per month for the agreed quantity. */
  chargeMonthly: number;
  costMonthly: number | null;
  marginMonthly: number | null;
  /** True when the recorded cost and the supplier's cost differ by more than a penny a month per unit. */
  costStale: boolean;
  discrepancy: { id: string; source: string; status: string; contracted: number; observed: number; difference: number } | null;
  pendingChanges: { id: string; field: string; previousValue: string | null; newValue: string | null; effectiveFrom: string }[];
  status: LineStatus;
};

export type AgreementView = {
  id: string;
  name: string;
  reference: string | null;
  status: string;
  billingFrequency: string;
  billingDay: number | null;
  startDate: string;
  endDate: string | null;
  renewalDate: string | null;
  purchaseOrderRef: string | null;
  lines: LineView[];
  /** The period in force on asOf and the first day of the one after it (when the next invoice falls due), or null when not recurring or ended. */
  currentPeriod: { periodStart: string; periodEnd: string } | null;
  nextInvoiceOn: string | null;
  /** Normalised monthly figures across the agreement's recurring lines. */
  chargeMonthly: number;
  costMonthly: number | null;
  marginMonthly: number | null;
  unknownCostLines: number;
  attention: number;
};

type LineRow = typeof contractLines.$inferSelect & { siteName: string | null };
type ContractRow = typeof contracts.$inferSelect;

function lineView(l: LineRow, register: RegisterRow[], disc: (typeof billingDiscrepancies.$inferSelect)[], pending: LineView["pendingChanges"]): LineView {
  const months = PERIOD_MONTHS[l.billingFrequency] ?? null;
  const recurring = l.revenueType === "recurring" && months !== null;
  const qty = Number(l.quantity);
  const sources = register.filter((r) => r.line?.id === l.id && (r.state === "charged" || r.state === "bundle"));
  const observed = sources.length ? sources.reduce((a, s) => a + s.quantity, 0) : null;
  const priced = sources.filter((s) => s.monthlyCost !== null);
  const supplierMonthlyCost = priced.length ? round2(priced.reduce((a, s) => a + (s.monthlyCost ?? 0), 0)) : null;
  const unknownCostSources = sources.filter((s) => s.monthlyCost === null && !s.costKnown).length;
  const sellMonthlyPerUnit = recurring ? Number(l.unitPrice) / months! : Number(l.unitPrice);
  const recordedMonthlyPerUnit = l.unitCost === null ? null : recurring ? Number(l.unitCost) / months! : Number(l.unitCost);
  const supplierPerUnit = supplierMonthlyCost !== null && observed ? supplierMonthlyCost / observed : null;
  const costBasis: LineView["costBasis"] = supplierPerUnit !== null && priced.length === sources.length ? "supplier" : recordedMonthlyPerUnit !== null ? "recorded" : "unknown";
  const costMonthlyPerUnit = costBasis === "supplier" ? supplierPerUnit : costBasis === "recorded" ? recordedMonthlyPerUnit : null;
  const costStale = supplierPerUnit !== null && (recordedMonthlyPerUnit === null || Math.abs(supplierPerUnit - recordedMonthlyPerUnit) > 0.01);
  const chargeMonthly = recurring ? round2(qty * sellMonthlyPerUnit) : 0;
  const costMonthly = recurring && costMonthlyPerUnit !== null ? round2(qty * costMonthlyPerUnit) : null;
  const d = disc.find((x) => x.contractLineId === l.id && (x.status === "open" || x.status === "accepted")) ?? null;
  const discrepancy = d ? { id: d.id, source: d.source, status: d.status, contracted: Number(d.contractedQty), observed: d.observedQty, difference: Number(d.difference) } : null;
  let status: LineStatus = "ok";
  if (!recurring) status = "not_recurring";
  else if (discrepancy && discrepancy.status === "open") status = l.quantityRule === "synced" ? "proposed_change" : "count_differs";
  else if (discrepancy) status = "exception_accepted";
  else if (costStale) status = "cost_stale";
  else if (!sources.length && (l.pricingModel === "per_user" || l.pricingModel === "per_device")) status = "no_source";
  return {
    id: l.id,
    description: l.description,
    revenueType: l.revenueType,
    pricingModel: l.pricingModel,
    billingFrequency: l.billingFrequency,
    invoiceSchedule: l.invoiceSchedule,
    reductionPolicy: l.reductionPolicy,
    quantityRule: l.quantityRule,
    siteName: l.siteName,
    countsAsManagedDevice: l.countsAsManagedDevice,
    quantity: qty,
    unitPrice: Number(l.unitPrice),
    unitCost: l.unitCost === null ? null : Number(l.unitCost),
    sources,
    observed,
    supplierMonthlyCost,
    unknownCostSources,
    sellMonthlyPerUnit,
    costMonthlyPerUnit,
    costBasis,
    chargeMonthly,
    costMonthly,
    marginMonthly: costMonthly === null ? null : round2(chargeMonthly - costMonthly),
    costStale,
    discrepancy,
    pendingChanges: pending,
    status,
  };
}

function agreementView(c: ContractRow, lines: LineRow[], register: RegisterRow[], disc: (typeof billingDiscrepancies.$inferSelect)[], pending: Map<string, LineView["pendingChanges"]>, asOf: string): AgreementView {
  const views = lines.map((l) => lineView(l, register, disc, pending.get(l.id) ?? []));
  const period = c.status === "active" ? billingPeriodFor(c.startDate, c.billingFrequency, asOf, c.endDate, c.billingDay) : null;
  let nextInvoiceOn: string | null = null;
  if (period) {
    const d = new Date(period.periodEnd + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    const next = d.toISOString().slice(0, 10);
    nextInvoiceOn = c.endDate && next > c.endDate ? null : next;
  }
  const recurring = views.filter((v) => v.status !== "not_recurring");
  const chargeMonthly = round2(recurring.reduce((a, v) => a + v.chargeMonthly, 0));
  const known = recurring.filter((v) => v.costMonthly !== null);
  const costMonthly = known.length ? round2(known.reduce((a, v) => a + (v.costMonthly ?? 0), 0)) : null;
  return {
    id: c.id,
    name: c.name,
    reference: c.reference,
    status: c.status,
    billingFrequency: c.billingFrequency,
    billingDay: c.billingDay,
    startDate: c.startDate,
    endDate: c.endDate,
    renewalDate: c.renewalDate,
    purchaseOrderRef: c.purchaseOrderRef,
    lines: views,
    currentPeriod: period ? { periodStart: period.periodStart, periodEnd: period.periodEnd } : null,
    nextInvoiceOn,
    chargeMonthly,
    costMonthly,
    marginMonthly: costMonthly === null ? null : round2(chargeMonthly - costMonthly),
    unknownCostLines: recurring.length - known.length,
    attention: views.filter((v) => v.status === "count_differs" || v.status === "proposed_change" || v.status === "cost_stale").length,
  };
}

async function linesOf(contractIds: string[]) {
  if (!contractIds.length) return new Map<string, LineRow[]>();
  const rows = await db.select({ line: contractLines, siteName: sites.name }).from(contractLines).leftJoin(sites, eq(sites.id, contractLines.siteId)).where(inArray(contractLines.contractId, contractIds)).orderBy(asc(contractLines.sortOrder));
  const out = new Map<string, LineRow[]>();
  for (const r of rows) out.set(r.line.contractId, [...(out.get(r.line.contractId) ?? []), { ...r.line, siteName: r.siteName }]);
  return out;
}

async function pendingChangesOf(contractIds: string[]) {
  const changes = await lineChangesFor(contractIds);
  const today = new Date().toISOString().slice(0, 10);
  const out = new Map<string, LineView["pendingChanges"]>();
  for (const [lineId, list] of changes) out.set(lineId, list.filter((h) => h.effectiveFrom > today).map((h) => ({ id: h.id, field: h.field, previousValue: h.previousValue, newValue: h.newValue, effectiveFrom: h.effectiveFrom })));
  return out;
}

export type CompanyBillingPicture = {
  asOf: string;
  agreements: AgreementView[];
  /** Supplied services no active agreement line accounts for: unmapped, free, internal, commitment, investigate, or charged on a line of an inactive agreement. */
  otherServices: RegisterRow[];
  register: RegisterRow[];
  totals: { chargeMonthly: number; costMonthly: number | null; marginMonthly: number | null; unknownCostLines: number; nextInvoiceOn: string | null; attention: number };
};

export async function companyBillingPicture(companyId: string, asOf = new Date().toISOString().slice(0, 10)): Promise<CompanyBillingPicture> {
  const [rows, register] = await Promise.all([
    db.select().from(contracts).where(and(eq(contracts.companyId, companyId), isNull(contracts.archivedAt), inArray(contracts.status, ["active", "draft"]))).orderBy(asc(contracts.status), asc(contracts.name)),
    serviceRegisterRows([companyId]),
  ]);
  const ids = rows.map((c) => c.id);
  const [lines, disc, pending] = await Promise.all([linesOf(ids), ids.length ? db.select().from(billingDiscrepancies).where(and(eq(billingDiscrepancies.companyId, companyId), inArray(billingDiscrepancies.status, ["open", "accepted"]))) : Promise.resolve([]), pendingChangesOf(ids)]);
  const agreements = rows.map((c) => agreementView(c, lines.get(c.id) ?? [], register, disc, pending, asOf));
  const accounted = new Set(agreements.filter((a) => a.status === "active").flatMap((a) => a.lines.flatMap((l) => l.sources.map((s) => s.key))));
  const otherServices = register.filter((r) => !accounted.has(r.key) && !(r.pool && r.state === "charged"));
  const active = agreements.filter((a) => a.status === "active");
  const known = active.filter((a) => a.costMonthly !== null);
  const chargeMonthly = round2(active.reduce((a, x) => a + x.chargeMonthly, 0));
  const costMonthly = known.length ? round2(known.reduce((a, x) => a + (x.costMonthly ?? 0), 0)) : null;
  const nextInvoiceOn = active.map((a) => a.nextInvoiceOn).filter((x): x is string => Boolean(x)).sort()[0] ?? null;
  return {
    asOf,
    agreements,
    otherServices,
    register,
    totals: { chargeMonthly, costMonthly, marginMonthly: costMonthly === null ? null : round2(chargeMonthly - costMonthly), unknownCostLines: active.reduce((a, x) => a + x.unknownCostLines, 0), nextInvoiceOn, attention: active.reduce((a, x) => a + x.attention, 0) + otherServices.filter((r) => r.state === "unmapped" || r.state === "investigate" || r.reviewOverdue).length },
  };
}

export type CustomerBillingRow = {
  companyId: string;
  companyName: string;
  agreements: number;
  frequencies: string[];
  nextInvoiceOn: string | null;
  chargeMonthly: number;
  costMonthly: number | null;
  marginMonthly: number | null;
  unknownCostLines: number;
  unmapped: number;
  attention: number;
  linesTotal: number;
  linesSupplied: number;
};

/** One row per customer with an active agreement or a supplied service: the Billing → Customers list. */
export async function customersBillingPicture(asOf = new Date().toISOString().slice(0, 10)): Promise<CustomerBillingRow[]> {
  const [rows, register, names] = await Promise.all([
    db.select().from(contracts).where(and(isNull(contracts.archivedAt), eq(contracts.status, "active"))).orderBy(asc(contracts.name)),
    serviceRegisterRows(null),
    db.select({ id: companies.id, name: companies.name }).from(companies).where(isNull(companies.archivedAt)),
  ]);
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  const ids = rows.map((c) => c.id);
  const [lines, disc, pending] = await Promise.all([linesOf(ids), db.select().from(billingDiscrepancies).where(inArray(billingDiscrepancies.status, ["open", "accepted"])), pendingChangesOf(ids)]);
  const byCompany = new Map<string, AgreementView[]>();
  for (const c of rows) {
    const regs = register.filter((r) => r.companyId === c.companyId);
    byCompany.set(c.companyId, [...(byCompany.get(c.companyId) ?? []), agreementView(c, lines.get(c.id) ?? [], regs, disc.filter((d) => d.companyId === c.companyId), pending, asOf)]);
  }
  for (const r of register) if (!byCompany.has(r.companyId)) byCompany.set(r.companyId, []);
  const out: CustomerBillingRow[] = [];
  for (const [companyId, agreements] of byCompany) {
    const accounted = new Set(agreements.flatMap((a) => a.lines.flatMap((l) => l.sources.map((s) => s.key))));
    const other = register.filter((r) => r.companyId === companyId && !accounted.has(r.key) && !(r.pool && r.state === "charged"));
    const known = agreements.filter((a) => a.costMonthly !== null);
    const chargeMonthly = round2(agreements.reduce((a, x) => a + x.chargeMonthly, 0));
    const costMonthly = known.length ? round2(known.reduce((a, x) => a + (x.costMonthly ?? 0), 0)) : null;
    const recurring = agreements.flatMap((a) => a.lines.filter((l) => l.status !== "not_recurring"));
    const unmapped = other.filter((r) => r.state === "unmapped").length;
    out.push({
      companyId,
      companyName: nameOf.get(companyId) ?? "—",
      agreements: agreements.length,
      frequencies: [...new Set(agreements.map((a) => a.billingFrequency))],
      nextInvoiceOn: agreements.map((a) => a.nextInvoiceOn).filter((x): x is string => Boolean(x)).sort()[0] ?? null,
      chargeMonthly,
      costMonthly,
      marginMonthly: costMonthly === null ? null : round2(chargeMonthly - costMonthly),
      unknownCostLines: agreements.reduce((a, x) => a + x.unknownCostLines, 0),
      unmapped,
      attention: agreements.reduce((a, x) => a + x.attention, 0) + unmapped + other.filter((r) => r.state === "investigate" || r.reviewOverdue).length,
      linesTotal: recurring.length,
      linesSupplied: recurring.filter((l) => l.sources.length > 0).length,
    });
  }
  return out.sort((a, b) => b.attention - a.attention || b.chargeMonthly - a.chargeMonthly || a.companyName.localeCompare(b.companyName));
}

/** One agreement's picture for the contract page. */
export async function contractBillingPicture(contractId: string, asOf = new Date().toISOString().slice(0, 10)): Promise<AgreementView | null> {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
  if (!c) return null;
  const [lines, register, disc, pending] = await Promise.all([linesOf([c.id]), serviceRegisterRows([c.companyId]), db.select().from(billingDiscrepancies).where(and(eq(billingDiscrepancies.contractId, c.id), inArray(billingDiscrepancies.status, ["open", "accepted"]))), pendingChangesOf([c.id])]);
  return agreementView(c, lines.get(c.id) ?? [], register, disc, pending, asOf);
}

export { summariseLines };
