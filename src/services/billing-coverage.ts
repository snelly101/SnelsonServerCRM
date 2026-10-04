import { and, eq, inArray, ne } from "drizzle-orm";
import { parseISO, subDays, addDays, format, differenceInCalendarDays } from "date-fns";
import { db } from "@/db";
import { contractLines, contracts, invoiceDrafts, type InvoiceDraftLine } from "@/db/schema";
import { billingPeriodFor, buildContractInvoiceLines, manualPeriod, PERIOD_MONTHS, type BillableLine, type BillingPeriod, type LineChange } from "@/lib/billing";
import { lineChangesFor } from "./contracts";

/**
 * Which periods of which contract lines have already been invoiced, and what
 * is due next. Shared by the billing run and *Prepare invoice*.
 *
 * Schedules: a line with `invoice_schedule = contract` is spread over the
 * contract's own periods (its price normalised to that period); one with
 * `own` is invoiced on its own cycle (an annual domain once a year), anchored
 * like the contract (start date or billing day).
 *
 * Coverage: a period of a line counts as invoiced when a non-cancelled draft
 * carries a period or pro-rata line for it (`calc.from` = period start).
 * Drafts from before `calc` existed cover their own `period_start` for every
 * contract line they mention. Increase, decrease and catch-up lines adjust a
 * period but never cover one on their own.
 *
 * Missed periods: when the contract has a billing commencement date
 * (`billing_from`), every period from that date to the current one with no
 * coverage is proposed as missed. Without one only the current period is
 * ever proposed, so a contract imported mid-life is never back-billed.
 */
export type ContractRow = typeof contracts.$inferSelect;
export type ContractLineRow = typeof contractLines.$inferSelect;

export type DraftLineEntry = { draftId: string; status: string; periodStart: string | null; periodEnd: string | null; line: InvoiceDraftLine };

export type PlannedItem = {
  lineId: string;
  description: string;
  period: BillingPeriod;
  months: number;
  /** An earlier period than the current one, found through billing_from. */
  missed: boolean;
};

const iso = (d: Date) => format(d, "yyyy-MM-dd");
const dayBefore = (d: string) => iso(subDays(parseISO(d), 1));
const dayAfter = (d: string) => iso(addDays(parseISO(d), 1));
const periodKey = (p: BillingPeriod) => `${p.periodStart}:${p.periodEnd}`;

/** The frequency a line is invoiced on under its schedule. */
export function lineSchedule(c: Pick<ContractRow, "billingFrequency">, l: Pick<ContractLineRow, "invoiceSchedule" | "billingFrequency">) {
  const frequency = l.invoiceSchedule === "own" ? l.billingFrequency : c.billingFrequency;
  return { frequency, months: PERIOD_MONTHS[frequency] ?? 0 };
}

export const isRecurring = (l: Pick<ContractLineRow, "revenueType" | "billingFrequency">) => l.revenueType === "recurring" && l.billingFrequency !== "one_off";

/** Every line of every non-cancelled draft of these contracts. */
export async function draftLineEntries(contractIds: string[]): Promise<Map<string, DraftLineEntry[]>> {
  const out = new Map<string, DraftLineEntry[]>();
  if (!contractIds.length) return out;
  const rows = await db
    .select({ id: invoiceDrafts.id, contractId: invoiceDrafts.contractId, status: invoiceDrafts.status, periodStart: invoiceDrafts.periodStart, periodEnd: invoiceDrafts.periodEnd, lines: invoiceDrafts.lines })
    .from(invoiceDrafts)
    .where(and(inArray(invoiceDrafts.contractId, contractIds), ne(invoiceDrafts.status, "cancelled")));
  for (const r of rows) {
    const list = out.get(r.contractId!) ?? [];
    for (const line of r.lines) list.push({ draftId: r.id, status: r.status, periodStart: r.periodStart, periodEnd: r.periodEnd, line });
    out.set(r.contractId!, list);
  }
  return out;
}

/** Does this draft line belong to (adjust or cover) the period? */
export function belongsTo(e: DraftLineEntry, lineId: string, p: { periodStart: string; periodEnd: string }): boolean {
  if (e.line.contractLineId !== lineId) return false;
  const c = e.line.calc;
  if (!c) return e.periodStart === p.periodStart;
  if (c.kind === "catchup") return c.from === p.periodStart;
  return c.from >= p.periodStart && c.from <= p.periodEnd;
}

/** Does a non-cancelled draft already carry this period of this line? */
export function isCovered(entries: DraftLineEntry[], lineId: string, p: BillingPeriod): boolean {
  return entries.some((e) => {
    if (e.line.contractLineId !== lineId) return false;
    const c = e.line.calc;
    if (!c) return e.periodStart === p.periodStart;
    return (c.kind === "period" || c.kind === "prorata") && c.from === p.periodStart;
  });
}

/** The draft that covers the current period of any of these lines, if one does. */
export function coveringDraft(entries: DraftLineEntry[], lineIds: string[], p: BillingPeriod) {
  return entries.find((e) => lineIds.some((id) => isCovered([e], id, p))) ?? null;
}

/** Periods of a schedule from `from` up to and including the one containing `asOf`. */
export function periodsBetween(c: Pick<ContractRow, "startDate" | "endDate" | "billingDay">, frequency: string, from: string, asOf: string): BillingPeriod[] {
  const out: BillingPeriod[] = [];
  let cursor = from < c.startDate ? c.startDate : from;
  for (let i = 0; i < 400; i++) {
    const p = billingPeriodFor(c.startDate, frequency, cursor, c.endDate, c.billingDay);
    if (!p || p.periodStart > asOf) break;
    out.push(p);
    if (p.periodEnd >= asOf) break;
    cursor = dayAfter(p.periodEnd);
  }
  return out;
}

/**
 * What the run on `asOf` should invoice for a contract: for each recurring
 * line, its current period under its schedule unless already covered, plus
 * (with billing_from) earlier uncovered periods marked missed.
 */
export function planItems(c: ContractRow, lines: ContractLineRow[], entries: DraftLineEntry[], asOf: string): PlannedItem[] {
  const items: PlannedItem[] = [];
  for (const l of lines) {
    if (!isRecurring(l)) continue;
    const { frequency, months } = lineSchedule(c, l);
    if (!months) continue;
    const current = billingPeriodFor(c.startDate, frequency, asOf, c.endDate, c.billingDay);
    if (!current) continue;
    const candidates = c.billingFrom ? periodsBetween(c, frequency, c.billingFrom, asOf) : [current];
    for (const p of candidates) {
      if (isCovered(entries, l.id, p)) continue;
      items.push({ lineId: l.id, description: l.description, period: p, months, missed: p.periodStart < current.periodStart });
    }
  }
  return items;
}

/** The items for a hand-chosen period: contract-schedule lines for that period, own-cycle lines whose own period starts inside it. */
export function planManualItems(c: ContractRow, lines: ContractLineRow[], periodStart: string, periodEnd: string): PlannedItem[] {
  const items: PlannedItem[] = [];
  const anchored = billingPeriodFor(c.startDate, c.billingFrequency, periodStart, c.endDate, c.billingDay);
  // The anchored period itself; a span inside one anchored period is pro-rated against it; a span crossing anchors is billed as typed.
  const contractPeriod: BillingPeriod =
    anchored && anchored.periodStart === periodStart && anchored.periodEnd === periodEnd
      ? anchored
      : anchored && periodStart >= anchored.periodStart && periodEnd <= anchored.periodEnd
        ? { periodStart, periodEnd, fullDays: anchored.fullDays, days: Math.max(1, differenceInCalendarDays(parseISO(periodEnd), parseISO(periodStart)) + 1) }
        : manualPeriod(periodStart, periodEnd);
  for (const l of lines) {
    if (!isRecurring(l)) continue;
    const { frequency, months } = lineSchedule(c, l);
    if (!months) continue;
    if (l.invoiceSchedule === "own") {
      const own = billingPeriodFor(c.startDate, frequency, periodEnd, c.endDate, c.billingDay);
      if (own && own.periodStart >= periodStart && own.periodStart <= periodEnd) items.push({ lineId: l.id, description: l.description, period: own, months, missed: false });
      continue;
    }
    items.push({ lineId: l.id, description: l.description, period: contractPeriod, months, missed: false });
  }
  return items;
}

/** Every uncovered line period whose start falls inside a span (used to re-prepare a draft for the same stretch after a change). */
export function planSpanItems(c: ContractRow, lines: ContractLineRow[], entries: DraftLineEntry[], periodStart: string, periodEnd: string): PlannedItem[] {
  const items: PlannedItem[] = [];
  for (const l of lines) {
    if (!isRecurring(l)) continue;
    const { frequency, months } = lineSchedule(c, l);
    if (!months) continue;
    for (const p of periodsBetween(c, frequency, periodStart, periodEnd)) {
      if (p.periodStart < periodStart || p.periodStart > periodEnd || isCovered(entries, l.id, p)) continue;
      items.push({ lineId: l.id, description: l.description, period: p, months, missed: false });
    }
  }
  return items;
}

function toBillable(c: ContractRow, l: ContractLineRow, changes: LineChange[]): BillableLine {
  return { ...l, changes, reductionPolicy: l.reductionPolicy as BillableLine["reductionPolicy"], decreasesFrom: c.renewalDate ?? c.endDate ?? null };
}

/** Builds the draft lines for a set of planned items, period by period, with the previous period's billed lines for catch-ups. */
export async function buildLinesForItems(c: ContractRow, lines: ContractLineRow[], items: PlannedItem[], entries: DraftLineEntry[], accountCode: string, taxType: string, history?: Map<string, LineChange[]>): Promise<InvoiceDraftLine[]> {
  const changes = history ?? (await lineChangesFor([c.id]));
  const byLine = new Map(lines.map((l) => [l.id, l]));
  const groups = new Map<string, { period: BillingPeriod; months: number; lines: BillableLine[] }>();
  for (const it of items.slice().sort((a, b) => a.period.periodStart.localeCompare(b.period.periodStart))) {
    const l = byLine.get(it.lineId);
    if (!l) continue;
    const key = `${periodKey(it.period)}:${it.months}`;
    const g = groups.get(key) ?? { period: it.period, months: it.months, lines: [] };
    g.lines.push(toBillable(c, l, changes.get(l.id) ?? []));
    groups.set(key, g);
  }
  const out: InvoiceDraftLine[] = [];
  for (const g of groups.values()) {
    const frequency = Object.entries(PERIOD_MONTHS).find(([, m]) => m === g.months)?.[0] ?? c.billingFrequency;
    const prev = g.period.periodStart > c.startDate ? billingPeriodFor(c.startDate, frequency, dayBefore(g.period.periodStart), c.endDate, c.billingDay) : null;
    const previous = prev ? { period: prev, lines: entries.filter((e) => g.lines.some((l) => belongsTo(e, l.id, prev))).map((e) => e.line) } : null;
    out.push(...buildContractInvoiceLines({ lines: g.lines, period: g.period, months: g.months, previous, accountCode, taxType }));
  }
  return out;
}

/** The span a set of items covers, for the draft's period columns. */
export function itemsSpan(items: PlannedItem[]) {
  if (!items.length) return null;
  return { periodStart: items.reduce((a, i) => (i.period.periodStart < a ? i.period.periodStart : a), items[0].period.periodStart), periodEnd: items.reduce((a, i) => (i.period.periodEnd > a ? i.period.periodEnd : a), items[0].period.periodEnd) };
}

export async function contractWithLines(contractId: string) {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
  if (!c) return null;
  const lines = await db.select().from(contractLines).where(eq(contractLines.contractId, contractId)).orderBy(contractLines.sortOrder);
  return { contract: c, lines };
}
