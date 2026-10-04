import { billingPeriodFor, PERIOD_MONTHS } from "./billing";

/**
 * The money consequence of acting on a billing discrepancy, worked out from
 * the same period rules as the engine so the dialog never promises an amount
 * the next invoice would not carry.
 *
 * - An increase charged from `effectiveFrom` is pro-rated for the rest of the
 *   current period and then charged in full every period.
 * - A decrease follows the line's reduction policy: credited for the unused
 *   days now (immediate), from the next period (next_period), or only from
 *   the renewal date (at_renewal).
 */
export type ImpactKind = "amend_line" | "reduce_at_renewal" | "exception";

export type DiscrepancyImpact = {
  /** Change to every future period, positive = more billed. */
  perPeriod: number;
  /** Change to the current period's invoice (pro rata), 0 when the change only starts later. */
  thisPeriod: number;
  /** First day the billing changes. */
  from: string | null;
  /** Revenue at stake per period while nothing is done (unbilled when positive). */
  atStake: number;
  note: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const dayCount = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
const addDay = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

export function discrepancyImpact(input: {
  difference: number;
  unitPrice: number;
  contract: { startDate: string; billingFrequency: string; endDate?: string | null; billingDay?: number | null; renewalDate?: string | null };
  reductionPolicy: "next_period" | "immediate" | "at_renewal";
  effectiveFrom: string;
  asOf: string;
  kind: ImpactKind;
}): DiscrepancyImpact {
  const { difference, unitPrice, contract, effectiveFrom, asOf } = input;
  const perPeriod = round2(difference * unitPrice);
  const atStake = perPeriod;
  const period = PERIOD_MONTHS[contract.billingFrequency] ? billingPeriodFor(contract.startDate, contract.billingFrequency, asOf, contract.endDate, contract.billingDay) : null;
  if (input.kind === "exception") return { perPeriod: 0, thisPeriod: 0, from: null, atStake, note: difference > 0 ? `${money(Math.abs(perPeriod))} per period stays unbilled while the exception stands` : `${money(Math.abs(perPeriod))} per period stays billed above the observed count while the exception stands` };
  if (!period) return { perPeriod, thisPeriod: 0, from: effectiveFrom, atStake, note: "The contract has no current billing period; the change applies when it next recurs" };
  const nextPeriodStart = addDay(period.periodEnd, 1);
  if (difference > 0) {
    const from = effectiveFrom > period.periodStart ? effectiveFrom : period.periodStart;
    const thisPeriod = from > period.periodEnd ? 0 : round2(perPeriod * (dayCount(from, period.periodEnd) / period.fullDays));
    const caughtUp = effectiveFrom < period.periodStart;
    return { perPeriod, thisPeriod, from: effectiveFrom, atStake, note: `${money(thisPeriod)} for ${dayCount(from, period.periodEnd)} of ${period.fullDays} days this period, then ${money(perPeriod)} every period${caughtUp ? "; the earlier period is caught up on the next invoice" : ""}` };
  }
  const policy = input.kind === "reduce_at_renewal" ? "at_renewal" : input.reductionPolicy;
  if (policy === "immediate") {
    const from = effectiveFrom > period.periodStart ? effectiveFrom : period.periodStart;
    const thisPeriod = from > period.periodEnd ? 0 : round2(perPeriod * (dayCount(from, period.periodEnd) / period.fullDays));
    return { perPeriod, thisPeriod, from, atStake, note: `${money(Math.abs(thisPeriod))} credited for the unused days this period, then ${money(Math.abs(perPeriod))} less every period` };
  }
  if (policy === "at_renewal") {
    const from = contract.renewalDate && contract.renewalDate > effectiveFrom ? contract.renewalDate : nextPeriodStart;
    return { perPeriod, thisPeriod: 0, from, atStake, note: contract.renewalDate ? `Billed at the current quantity until renewal on ${contract.renewalDate}, then ${money(Math.abs(perPeriod))} less every period` : `No renewal date on the contract: the reduction applies from the next period (${nextPeriodStart})` };
  }
  return { perPeriod, thisPeriod: 0, from: effectiveFrom <= period.periodEnd ? nextPeriodStart : effectiveFrom, atStake, note: `Nothing credited this period; ${money(Math.abs(perPeriod))} less from the next period (${nextPeriodStart})` };
}

const money = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(n);
