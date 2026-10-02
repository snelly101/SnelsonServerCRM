import { addMonths, differenceInCalendarDays, format, parseISO, subDays } from "date-fns";
import type { InvoiceDraftLine } from "@/db/schema";
import { monthlyValue } from "@/lib/money";

/**
 * Pure billing maths shared by the billing run and "Prepare invoice".
 *
 * Periods: anchored to the contract start date, or to `billingDay` (1–28) of
 * the month when set. With an anchor day the first period runs from the start
 * date to the day before the next anchor and is pro-rated; later periods are
 * whole. Pro-rating is by calendar days against the length of the full period.
 *
 * Quantity changes: a line carries `previousQuantity` and `quantityChangedOn`
 * while a change is waiting to be invoiced. Billing in advance means the
 * period in which the change falls is billed at the old quantity for the whole
 * period plus the increase for the remaining days; a decrease is not credited.
 * When that period was already invoiced before the change, the next invoice
 * carries a catch-up line for the increase over the rest of that period.
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

export type BillableLine = {
  id: string;
  description: string;
  revenueType: string;
  billingFrequency: string;
  quantity: number | string;
  unitPrice: number | string;
  previousQuantity?: number | string | null;
  quantityChangedOn?: string | null;
};

export type PreviousInvoice = { period: { periodStart: string; periodEnd: string; fullDays: number }; lines: InvoiceDraftLine[] };

/**
 * Builds the draft lines for one contract period. `months` is the contract's
 * billing frequency in months; each recurring line's price is normalised to
 * that period whatever its own frequency (an annual line on a monthly contract
 * bills a twelfth each month).
 */
export function buildContractInvoiceLines(input: { lines: BillableLine[]; period: BillingPeriod; months: number; previous?: PreviousInvoice | null; accountCode: string; taxType: string }): InvoiceDraftLine[] {
  const { period, months, previous, accountCode, taxType } = input;
  const out: InvoiceDraftLine[] = [];
  const within = (d: string | null | undefined, p: { periodStart: string; periodEnd: string }) => Boolean(d && d >= p.periodStart && d <= p.periodEnd);
  const label = `${period.periodStart} to ${period.periodEnd}`;
  for (const l of input.lines) {
    if (l.revenueType !== "recurring" || l.billingFrequency === "one_off") continue;
    const qty = Number(l.quantity);
    const perMonthUnit = qty ? monthlyValue({ quantity: l.quantity, unitPrice: l.unitPrice, revenueType: l.revenueType, billingFrequency: l.billingFrequency as "monthly" }) / qty : 0;
    const unitPerPeriod = round2(perMonthUnit * months);
    const fraction = period.days / period.fullDays;
    const prev = l.previousQuantity === null || l.previousQuantity === undefined ? null : Number(l.previousQuantity);
    const changed = l.quantityChangedOn ?? null;

    // Catch-up for a change that fell inside the previous, already invoiced, period.
    if (previous && prev !== null && changed && within(changed, previous.period)) {
      const billedBefore = previous.lines.find((x) => x.contractLineId === l.id)?.quantity ?? prev;
      const delta = qty - billedBefore;
      if (delta > 0) {
        const n = days(changed, previous.period.periodEnd);
        out.push({ description: `${l.description}: ${delta} added from ${changed}, ${n} of ${previous.period.fullDays} days (pro rata, previous period)`, quantity: 1, unitAmount: round2(delta * unitPerPeriod * (n / previous.period.fullDays)), accountCode, taxType, contractLineId: l.id });
      }
    }

    if (prev !== null && changed && within(changed, period)) {
      // Old quantity for the whole period, plus the increase for the rest of it. Decreases are not credited.
      const base = Math.max(prev, 0);
      if (base > 0) out.push(baseLine(l, base, unitPerPeriod, fraction, period, label, accountCode, taxType));
      const delta = qty - prev;
      if (delta > 0) {
        const n = days(changed, period.periodEnd);
        out.push({ description: `${l.description}: ${delta} added from ${changed}, ${n} of ${period.fullDays} days (pro rata)`, quantity: 1, unitAmount: round2(delta * unitPerPeriod * (n / period.fullDays)), accountCode, taxType, contractLineId: l.id });
      }
      continue;
    }
    out.push(baseLine(l, qty, unitPerPeriod, fraction, period, label, accountCode, taxType));
  }
  return out;
}

function baseLine(l: BillableLine, qty: number, unitPerPeriod: number, fraction: number, period: BillingPeriod, label: string, accountCode: string, taxType: string): InvoiceDraftLine {
  if (fraction >= 1) return { description: `${l.description} (${label})`, quantity: qty, unitAmount: unitPerPeriod, accountCode, taxType, contractLineId: l.id };
  return { description: `${l.description} (${label}): ${qty} × ${unitPerPeriod.toFixed(2)}, ${period.days} of ${period.fullDays} days (pro rata)`, quantity: 1, unitAmount: round2(qty * unitPerPeriod * fraction), accountCode, taxType, contractLineId: l.id };
}
