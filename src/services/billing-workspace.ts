import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { billingDiscrepancies, contracts, ninjaDevices, pax8Subscriptions, type InvoiceDraftLine } from "@/db/schema";
import { previewBillingRun, type BillingRunRow } from "./billing-run";
import { serviceRegisterRows } from "./service-register";

/**
 * The billing workspace: the billing run enriched with what finance needs to
 * decide quickly. For every contract due: the previous comparable amount,
 * plain-language reasons for the difference (from the calculated lines, never
 * guessed), blockers that stop preparation being useful, and attention items
 * that deserve a look before approval. Plus one summary line for the run.
 */
export type WorkspaceStatus = "ready" | "review" | "blocked" | "nothing";

export type WorkspaceRow = BillingRunRow & {
  status: WorkspaceStatus;
  /** Difference against the previous comparable draft, null when there is none. */
  delta: number | null;
  reasons: string[];
  blockers: string[];
  attention: string[];
};

export type WorkspaceSummary = {
  asOf: string;
  ready: number;
  review: number;
  blocked: number;
  nothing: number;
  expected: number;
  /** Monthly partner cost of unmapped services across customers (potential, not confirmed). */
  potentialMissed: number;
  unmappedServices: number;
  renewalsThisWeek: number;
  noticeDeadlinesThisWeek: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number, cur: string) => new Intl.NumberFormat("en-GB", { style: "currency", currency: cur }).format(n);
const STALE_MS = 3 * 3600_000;

/** Plain-language reasons the proposed amount differs from the previous comparable draft, derived line by line. */
export function explainDifference(current: InvoiceDraftLine[], previous: InvoiceDraftLine[] | null, currency: string, extras: { missed: number; ownCycleDue: string[] }): string[] {
  const reasons: string[] = [];
  const name = (d: string) => d.replace(/\s*\(.*$/, "").replace(/:.*$/, "");
  const baseOf = (lines: InvoiceDraftLine[]) => {
    const m = new Map<string, { qty: number; unit: number; amount: number; description: string }>();
    for (const l of lines) {
      if (!l.contractLineId) continue;
      if (l.calc && l.calc.kind !== "period" && l.calc.kind !== "prorata") continue;
      const prev = m.get(l.contractLineId);
      const qty = l.calc ? l.calc.quantity : l.quantity;
      const unit = l.calc ? l.calc.unitPerPeriod : l.unitAmount;
      m.set(l.contractLineId, { qty: (prev?.qty ?? 0) + qty, unit, amount: round2((prev?.amount ?? 0) + l.quantity * l.unitAmount), description: name(l.description) });
    }
    return m;
  };
  const cur = baseOf(current);
  const prev = previous ? baseOf(previous) : null;
  if (prev) {
    // Pair by contract line id first; a line that was re-created (new id, same description) is paired by description so it reads as a change, not as removed plus new.
    const unmatchedPrev = new Map([...prev].filter(([id]) => !cur.has(id)));
    type Base = NonNullable<ReturnType<typeof cur.get>>;
    const pairs: [Base, Base | null][] = [];
    for (const [id, c] of cur) {
      let p = prev.get(id) ?? null;
      if (!p) {
        const byName = [...unmatchedPrev].find(([, v]) => v.description === c.description);
        if (byName) {
          p = byName[1];
          unmatchedPrev.delete(byName[0]);
        }
      }
      pairs.push([c, p]);
    }
    for (const [c, p] of pairs) {
      if (!p) {
        reasons.push(`New: ${c.description} (${money(c.amount, currency)})`);
        continue;
      }
      if (c.qty !== p.qty) reasons.push(`${c.description}: ${p.qty} → ${c.qty}`);
      if (Math.abs(c.unit - p.unit) >= 0.005) reasons.push(`${c.description}: price ${money(p.unit, currency)} → ${money(c.unit, currency)} per unit`);
    }
    for (const p of unmatchedPrev.values()) reasons.push(`Removed: ${p.description} (was ${money(p.amount, currency)})`);
  }
  for (const l of current) {
    if (!l.calc) continue;
    if (l.calc.kind === "increase") reasons.push(`${name(l.description)}: ${l.calc.quantity} added from ${l.calc.from}, pro rata (${money(l.quantity * l.unitAmount, currency)})`);
    if (l.calc.kind === "decrease") reasons.push(`${name(l.description)}: ${l.calc.quantity} removed from ${l.calc.from}, credited (${money(l.quantity * l.unitAmount, currency)})`);
    if (l.calc.kind === "catchup") reasons.push(`${name(l.description)}: adjustment for the previous period (${money(l.quantity * l.unitAmount, currency)})`);
    if (l.calc.kind === "prorata" && l.calc.days && l.calc.fullDays && l.calc.days < l.calc.fullDays) reasons.push(`${name(l.description)}: ${l.calc.days} of ${l.calc.fullDays} days, pro rata`);
  }
  if (extras.missed) reasons.push(`Includes ${extras.missed} missed period${extras.missed === 1 ? "" : "s"}`);
  for (const d of extras.ownCycleDue) reasons.push(`${d}: due on its own cycle this period`);
  if (!reasons.length && prev) reasons.push("Same lines and quantities as the previous invoice");
  if (!prev) reasons.push("First invoice for this contract from the CRM");
  return [...new Set(reasons)];
}

export async function billingWorkspace(asOf: string, currency: string): Promise<{ rows: WorkspaceRow[]; summary: WorkspaceSummary }> {
  const run = await previewBillingRun(asOf);
  const companyIds = [...new Set(run.map((r) => r.companyId))];
  const [register, discrepancies, pax8Fresh, ninjaFresh, renewals] = await Promise.all([
    serviceRegisterRows(null),
    companyIds.length ? db.select({ companyId: billingDiscrepancies.companyId, n: sql<number>`count(*)`.mapWith(Number), unbilled: sql<number>`coalesce(sum(case when difference > 0 then difference * coalesce(unit_price, 0) else 0 end), 0)`.mapWith(Number) }).from(billingDiscrepancies).where(and(inArray(billingDiscrepancies.companyId, companyIds), eq(billingDiscrepancies.status, "open"))).groupBy(billingDiscrepancies.companyId) : Promise.resolve([]),
    companyIds.length ? db.select({ companyId: pax8Subscriptions.companyId, latest: sql<Date | null>`max(fetched_at)` }).from(pax8Subscriptions).where(inArray(pax8Subscriptions.companyId, companyIds)).groupBy(pax8Subscriptions.companyId) : Promise.resolve([]),
    companyIds.length ? db.select({ companyId: ninjaDevices.companyId, latest: sql<Date | null>`max(fetched_at)` }).from(ninjaDevices).where(inArray(ninjaDevices.companyId, companyIds)).groupBy(ninjaDevices.companyId) : Promise.resolve([]),
    db.select({ id: contracts.id, companyId: contracts.companyId, renewalDate: contracts.renewalDate, noticePeriodDays: contracts.noticePeriodDays }).from(contracts).where(and(eq(contracts.status, "active"), isNull(contracts.archivedAt), sql`${contracts.renewalDate} is not null`)),
  ]);
  const discByCompany = new Map(discrepancies.map((d) => [d.companyId, d]));
  const stalePax8 = new Set(pax8Fresh.filter((p) => p.latest && Date.now() - new Date(p.latest).getTime() > STALE_MS).map((p) => p.companyId!));
  const staleNinja = new Set(ninjaFresh.filter((p) => p.latest && Date.now() - new Date(p.latest).getTime() > STALE_MS).map((p) => p.companyId!));
  const unmappedByCompany = new Map<string, { n: number; cost: number }>();
  for (const r of register) {
    if (r.state !== "unmapped") continue;
    const cur = unmappedByCompany.get(r.companyId) ?? { n: 0, cost: 0 };
    unmappedByCompany.set(r.companyId, { n: cur.n + 1, cost: round2(cur.cost + (r.monthlyCost ?? 0)) });
  }
  const weekAhead = new Date(Date.parse(asOf) + 7 * 86400000).toISOString().slice(0, 10);
  let renewalsThisWeek = 0;
  let noticeDeadlinesThisWeek = 0;
  for (const c of renewals) {
    if (!c.renewalDate) continue;
    if (c.renewalDate >= asOf && c.renewalDate <= weekAhead) renewalsThisWeek++;
    const notice = new Date(Date.parse(c.renewalDate) - c.noticePeriodDays * 86400000).toISOString().slice(0, 10);
    if (notice >= asOf && notice <= weekAhead) noticeDeadlinesThisWeek++;
  }

  const rows: WorkspaceRow[] = run.map((r) => {
    const blockers: string[] = [];
    const attention: string[] = [];
    if (r.skipReason && !r.items.length) {
      return { ...r, status: "nothing", delta: null, reasons: [], blockers: [], attention: [] };
    }
    if (!r.xeroLinked) blockers.push("Company not linked to a Xero contact");
    const disc = discByCompany.get(r.companyId);
    if (disc) attention.push(`${disc.n} open licence/device discrepanc${disc.n === 1 ? "y" : "ies"}${disc.unbilled ? ` (≈ ${money(disc.unbilled, currency)} unbilled per period)` : ""}`);
    const unmapped = unmappedByCompany.get(r.companyId);
    if (unmapped) attention.push(`${unmapped.n} service${unmapped.n === 1 ? "" : "s"} without commercial coverage${unmapped.cost ? ` (≈ ${money(unmapped.cost, currency)}/month cost)` : ""}`);
    if (stalePax8.has(r.companyId)) attention.push("Pax8 data is stale (last fetched more than 3 hours ago)");
    if (staleNinja.has(r.companyId)) attention.push("NinjaOne data is stale (last fetched more than 3 hours ago)");
    if (r.missedCount) attention.push(`${r.missedCount} missed period${r.missedCount === 1 ? "" : "s"} included`);
    const ownCycleDue = r.items.filter((i) => i.months !== ({ monthly: 1, quarterly: 3, annual: 12 } as Record<string, number>)[r.billingFrequency]).map((i) => i.description);
    const reasons = explainDifference(r.lines, r.previous?.lines ?? null, currency, { missed: r.missedCount, ownCycleDue: [...new Set(ownCycleDue)] });
    const delta = r.previous ? round2(r.net - r.previous.net) : null;
    const changed = delta !== null && Math.abs(delta) >= 0.01;
    if (changed) attention.unshift(`${delta! > 0 ? "+" : ""}${money(delta!, currency)} against the previous invoice (${money(r.previous!.net, currency)})`);
    if (!r.previous) attention.push("First invoice from the CRM for this contract");
    const status: WorkspaceStatus = blockers.length ? "blocked" : attention.length ? "review" : "ready";
    return { ...r, status, delta, reasons, blockers, attention };
  });

  const summary: WorkspaceSummary = {
    asOf,
    ready: rows.filter((r) => r.status === "ready").length,
    review: rows.filter((r) => r.status === "review").length,
    blocked: rows.filter((r) => r.status === "blocked").length,
    nothing: rows.filter((r) => r.status === "nothing").length,
    expected: round2(rows.filter((r) => r.status !== "nothing").reduce((a, r) => a + r.net, 0)),
    potentialMissed: round2([...unmappedByCompany.values()].reduce((a, u) => a + u.cost, 0)),
    unmappedServices: [...unmappedByCompany.values()].reduce((a, u) => a + u.n, 0),
    renewalsThisWeek,
    noticeDeadlinesThisWeek,
  };
  return { rows, summary };
}
