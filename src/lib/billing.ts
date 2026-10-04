import { addMonths, differenceInCalendarDays, format, parseISO, subDays } from "date-fns";
import type { InvoiceDraftLine, InvoiceLineCalc } from "@/db/schema";
import { monthlyValue } from "@/lib/money";

/**
 * Pure billing maths shared by the billing run and "Prepare invoice".
 *
 * Periods: anchored to the contract start date, or to `billingDay` (1–28) of
 * the month when set. With an anchor day the first period runs from the start
 * date to the day before the next anchor and is pro-rated; later periods are
 * whole. Pro-rating is by calendar days against the length of the full period.
 *
 * Changes: every dated change to a line (quantity, unit price) is kept as a
 * `LineChange` with the value before and after and the day it took effect, so
 * any number of changes can fall inside one period and the quantity on any
 * day can be reconstructed. Billing in advance means a period is charged at
 * the quantity in force on its first day; each increase inside the period is
 * added for the days it covers; a decrease is not credited inside the period
 * (it applies from the next one). Unit price changes apply from the first
 * period that starts on or after their effective date (never pro-rated).
 *
 * Catch-up: when the previous, already invoiced, period had a change inside it
 * that the invoice did not carry (it was prepared before the change was
 * entered), the difference between what that period should have cost and
 * what was actually billed for the line is added once, as its own line.
 *
 * Every line produced carries `calc`, the inputs behind the amount, so an
 * invoice can be explained later even if the contract has moved on.
 */
export const PERIOD_MONTHS: Record<string, number | undefined> = { monthly: 1, quarterly: 3, annual: 12 };
const iso = (d: Date) => format(d, "yyyy-MM-dd");
const days = (a: string, b: string) => differenceInCalendarDays(parseISO(b), parseISO(a)) + 1;
export const round2 = (n: number) => Math.round(n * 100) / 100;

export type BillingPeriod = {
  periodStart: string;
  periodEnd: string;
  /** Days in the whole anchor-to-anchor period (the denominator for pro-rating). */
  fullDays: number;
  /** Days actually covered (shorter on a mid-period start or an end date inside the period). */
  days: number;
};

/** Anchor dates: the start date itself, or `billingDay` of each month stepping by `months`, starting from the last anchor on or before the start date. */
function anchorAt(start: Date, billingDay: number | null | undefined, n: number, months: number): Date {
  if (!billingDay) return addMonths(start, n * months);
  const first = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - (start.getUTCDate() < billingDay ? 1 : 0), billingDay));
  return addMonths(first, n * months);
}

/** The billing period containing `asOf`, or null when the contract has not started, has ended, or does not recur. */
export function billingPeriodFor(startDate: string, frequency: string, asOf: string, endDate?: string | null, billingDay?: number | null): BillingPeriod | null {
  const months = PERIOD_MONTHS[frequency];
  if (!months) return null;
  const start = parseISO(startDate);
  const on = parseISO(asOf);
  if (on < start) return null;
  if (endDate && parseISO(endDate) < on) return null;
  for (let n = 0; n < 1200; n++) {
    const a = anchorAt(start, billingDay, n, months);
    const next = anchorAt(start, billingDay, n + 1, months);
    if (on >= a && on < next) {
      const fullStart = iso(a);
      const fullEnd = iso(subDays(next, 1));
      const periodStart = a < start ? startDate : fullStart;
      const periodEnd = endDate && endDate < fullEnd ? endDate : fullEnd;
      return { periodStart, periodEnd, fullDays: days(fullStart, fullEnd), days: days(periodStart, periodEnd) };
    }
  }
  return null;
}

/** For a hand-entered period: the whole period is assumed full. */
export function manualPeriod(periodStart: string, periodEnd: string): BillingPeriod {
  const d = Math.max(1, days(periodStart, periodEnd));
  return { periodStart, periodEnd, fullDays: d, days: d };
}

/** One dated change to a contract line, as kept in `contract_line_changes`. */
export type LineChange = {
  id?: string | null;
  field: "quantity" | "unit_price";
  previousValue: number | string | null;
  newValue: number | string | null;
  /** YYYY-MM-DD the new value applies from. */
  effectiveFrom: string;
};

export type BillableLine = {
  id: string;
  description: string;
  revenueType: string;
  billingFrequency: string;
  /** The quantity and price in force today. */
  quantity: number | string;
  unitPrice: number | string;
  /** Dated history; any order. */
  changes?: LineChange[] | null;
  /** next_period (default): decreases apply from the next period. immediate: credit the unused days. at_renewal: the old quantity is billed until `decreasesFrom`. */
  reductionPolicy?: "next_period" | "immediate" | "at_renewal" | null;
  /** For at_renewal: the day from which decreases count (the contract's renewal or end date). */
  decreasesFrom?: string | null;
};

export type PreviousInvoice = { period: { periodStart: string; periodEnd: string; fullDays: number }; lines: InvoiceDraftLine[] };

const num = (v: number | string | null | undefined, fallback = 0) => (v === null || v === undefined || v === "" ? fallback : Number(v));
const sortedChanges = (l: BillableLine, field: LineChange["field"]) => (l.changes ?? []).filter((c) => c.field === field).slice().sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || String(a.id ?? "").localeCompare(String(b.id ?? "")));

/**
 * The value of a field on a given day, walking back from today's value through
 * the changes that took effect after that day. Anchoring on today's value
 * (rather than the oldest change) keeps the answer right even when a line was
 * edited without history, e.g. while the contract was still a draft.
 */
export function valueOn(l: BillableLine, field: LineChange["field"], date: string): number {
  let v = num(field === "quantity" ? l.quantity : l.unitPrice);
  const list = sortedChanges(l, field);
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (c.effectiveFrom > date) v = num(c.previousValue, v);
    else break;
  }
  return v;
}

export const quantityOn = (l: BillableLine, date: string) => valueOn(l, "quantity", date);

/**
 * The quantity to bill on a day. Same as `quantityOn` unless the line's
 * reductions wait for renewal: then any decrease dated before `decreasesFrom`
 * is ignored (the old quantity stays billed), walking forward through the
 * recorded chain so a later rise still counts from the kept level.
 */
export function billingQuantityOn(l: BillableLine, date: string): number {
  if (l.reductionPolicy !== "at_renewal" || !l.decreasesFrom || date >= l.decreasesFrom) return quantityOn(l, date);
  const list = sortedChanges(l, "quantity");
  if (!list.length) return num(l.quantity);
  let q = num(list[0].previousValue, num(l.quantity));
  for (const c of list) {
    if (c.effectiveFrom > date) break;
    const next = num(c.newValue, q);
    q = c.effectiveFrom < l.decreasesFrom ? Math.max(q, next) : next;
  }
  return q;
}
export const unitPriceOn = (l: BillableLine, date: string) => valueOn(l, "unit_price", date);

/** The per-period unit price of a line on a date, normalised from the line's own frequency to a `months`-long period. */
function unitPerPeriodOn(l: BillableLine, months: number, date: string) {
  const unit = unitPriceOn(l, date);
  const perMonth = monthlyValue({ quantity: 1, unitPrice: unit, revenueType: l.revenueType as "recurring", billingFrequency: l.billingFrequency as "monthly" });
  return round2(perMonth * months);
}

export type ChargeSegment = {
  kind: "period" | "prorata" | "increase" | "decrease";
  quantity: number;
  unitPerPeriod: number;
  from: string;
  to: string;
  days: number;
  fullDays: number;
  amount: number;
  changeIds: string[];
};

/**
 * What one line costs for one period under the advance-billing rules above:
 * the quantity on the first day for the whole (or partial) period, plus each
 * increase inside the period for its remaining days. Decreases inside the
 * period are not credited.
 */
export function chargeSegments(l: BillableLine, period: BillingPeriod, months: number): ChargeSegment[] {
  const out: ChargeSegment[] = [];
  const unitPerPeriod = unitPerPeriodOn(l, months, period.periodStart);
  const startQty = billingQuantityOn(l, period.periodStart);
  const partial = period.days < period.fullDays;
  if (startQty > 0) {
    const amount = partial ? round2(startQty * unitPerPeriod * (period.days / period.fullDays)) : round2(startQty * unitPerPeriod);
    out.push({ kind: partial ? "prorata" : "period", quantity: startQty, unitPerPeriod, from: period.periodStart, to: period.periodEnd, days: period.days, fullDays: period.fullDays, amount, changeIds: [] });
  }
  let level = startQty;
  const inside = sortedChanges(l, "quantity").filter((c) => c.effectiveFrom > period.periodStart && c.effectiveFrom <= period.periodEnd);
  // Several changes on one day collapse to the last of them.
  const byDay = new Map<string, LineChange[]>();
  for (const c of inside) byDay.set(c.effectiveFrom, [...(byDay.get(c.effectiveFrom) ?? []), c]);
  for (const [day, cs] of byDay) {
    const q = billingQuantityOn(l, day);
    const n = days(day, period.periodEnd);
    const ids = cs.map((c) => c.id ?? "").filter(Boolean);
    if (q > level) {
      out.push({ kind: "increase", quantity: q - level, unitPerPeriod, from: day, to: period.periodEnd, days: n, fullDays: period.fullDays, amount: round2((q - level) * unitPerPeriod * (n / period.fullDays)), changeIds: ids });
      level = q;
    } else if (q < level && l.reductionPolicy === "immediate") {
      out.push({ kind: "decrease", quantity: level - q, unitPerPeriod, from: day, to: period.periodEnd, days: n, fullDays: period.fullDays, amount: -round2((level - q) * unitPerPeriod * (n / period.fullDays)), changeIds: ids });
      level = q;
    }
    // next_period and at_renewal: a drop is not credited; the billed level stays until the next period (or renewal).
  }
  return out;
}

const label = (p: { periodStart: string; periodEnd: string }) => `${p.periodStart} to ${p.periodEnd}`;

function toLine(l: BillableLine, s: ChargeSegment, accountCode: string, taxType: string): InvoiceDraftLine {
  const base = { accountCode, taxType, contractLineId: l.id };
  if (s.kind === "period") return { ...base, description: `${l.description} (${label({ periodStart: s.from, periodEnd: s.to })})`, quantity: s.quantity, unitAmount: s.unitPerPeriod, calc: { kind: "period", quantity: s.quantity, unitPerPeriod: s.unitPerPeriod, from: s.from, to: s.to, days: s.days, fullDays: s.fullDays, changeIds: s.changeIds } };
  if (s.kind === "prorata") return { ...base, description: `${l.description} (${label({ periodStart: s.from, periodEnd: s.to })}): ${s.quantity} × ${s.unitPerPeriod.toFixed(2)}, ${s.days} of ${s.fullDays} days (pro rata)`, quantity: 1, unitAmount: s.amount, calc: { kind: "prorata", quantity: s.quantity, unitPerPeriod: s.unitPerPeriod, from: s.from, to: s.to, days: s.days, fullDays: s.fullDays, changeIds: s.changeIds } };
  if (s.kind === "decrease") return { ...base, description: `${l.description}: ${s.quantity} removed from ${s.from}, ${s.days} of ${s.fullDays} days (credit)`, quantity: 1, unitAmount: s.amount, calc: { kind: "decrease", quantity: s.quantity, unitPerPeriod: s.unitPerPeriod, from: s.from, to: s.to, days: s.days, fullDays: s.fullDays, changeIds: s.changeIds } };
  return { ...base, description: `${l.description}: ${s.quantity} added from ${s.from}, ${s.days} of ${s.fullDays} days (pro rata)`, quantity: 1, unitAmount: s.amount, calc: { kind: "increase", quantity: s.quantity, unitPerPeriod: s.unitPerPeriod, from: s.from, to: s.to, days: s.days, fullDays: s.fullDays, changeIds: s.changeIds } };
}

/**
 * Builds the draft lines for one contract period. `months` is the contract's
 * billing frequency in months; each recurring line's price is normalised to
 * that period whatever its own frequency (an annual line on a monthly contract
 * bills a twelfth each month).
 */
export function buildContractInvoiceLines(input: { lines: BillableLine[]; period: BillingPeriod; months: number; previous?: PreviousInvoice | null; accountCode: string; taxType: string }): InvoiceDraftLine[] {
  const { period, months, previous, accountCode, taxType } = input;
  const out: InvoiceDraftLine[] = [];
  for (const l of input.lines) {
    if (l.revenueType !== "recurring" || l.billingFrequency === "one_off") continue;

    // Catch-up: a quantity change inside the previous, already invoiced, period that its invoice did not reflect.
    if (previous) {
      const prevPeriod: BillingPeriod = { ...previous.period, days: days(previous.period.periodStart, previous.period.periodEnd) };
      const changed = sortedChanges(l, "quantity").filter((c) => c.effectiveFrom > prevPeriod.periodStart && c.effectiveFrom <= prevPeriod.periodEnd);
      if (changed.length) {
        const segments = chargeSegments(l, prevPeriod, months);
        const expected = round2(segments.reduce((a, s) => a + s.amount, 0));
        const billedLines = previous.lines.filter((x) => x.contractLineId === l.id);
        const billed = round2(billedLines.reduce((a, x) => a + x.quantity * x.unitAmount, 0));
        const diff = round2(expected - billed);
        if (diff > 0.005 || (diff < -0.005 && l.reductionPolicy === "immediate")) {
          const moves = segments.filter((s) => s.kind === "increase" || s.kind === "decrease");
          const one = moves.length === 1 ? moves[0] : null;
          const detail = one ? `${one.quantity} ${one.kind === "increase" ? "added" : "removed"} from ${one.from}, ${one.days} of ${prevPeriod.fullDays} days (${one.kind === "increase" ? "pro rata" : "credit"}, previous period)` : `adjustment for ${label(prevPeriod)} (${moves.length} changes, previous period)`;
          out.push({ description: `${l.description}: ${detail}`, quantity: 1, unitAmount: diff, accountCode, taxType, contractLineId: l.id, calc: { kind: "catchup", quantity: moves.reduce((a, s) => a + (s.kind === "increase" ? s.quantity : -s.quantity), 0), unitPerPeriod: unitPerPeriodOn(l, months, prevPeriod.periodStart), from: prevPeriod.periodStart, to: prevPeriod.periodEnd, days: prevPeriod.days, fullDays: prevPeriod.fullDays, expected, billedBefore: billed, changeIds: changed.map((c) => c.id ?? "").filter(Boolean) } });
        }
      }
    }

    for (const s of chargeSegments(l, period, months)) out.push(toLine(l, s, accountCode, taxType));
  }
  return out;
}

/** Plain-language account of how a draft line's amount was arrived at, for the invoice explanation view. */
export function explainLineCalc(c: InvoiceLineCalc, money: (n: number) => string): string {
  const unit = money(c.unitPerPeriod);
  switch (c.kind) {
    case "period":
      return `${c.quantity} × ${unit} for ${c.from} to ${c.to}, a whole period.`;
    case "prorata":
      return `${c.quantity} × ${unit} for ${c.days} of the ${c.fullDays} days in the period (${c.from} to ${c.to}), pro rata.`;
    case "increase":
      return `${c.quantity} more from ${c.from}: ${c.quantity} × ${unit} × ${c.days}/${c.fullDays} days to ${c.to}.`;
    case "decrease":
      return `${c.quantity} fewer from ${c.from}: credit of ${c.quantity} × ${unit} × ${c.days}/${c.fullDays} days to ${c.to}.`;
    case "catchup":
      return `The previous period (${c.from} to ${c.to}) should have cost ${money(c.expected ?? 0)} once the changes inside it are counted; ${money(c.billedBefore ?? 0)} was invoiced, so the difference is ${(c.expected ?? 0) >= (c.billedBefore ?? 0) ? "added" : "credited"} here.`;
    default:
      return "";
  }
}
