/**
 * Revenue maths shared by opportunities, contracts and reports.
 * All amounts are numbers in the app currency; the database stores numerics as strings.
 */
export type LineLike = {
  quantity: number | string;
  unitPrice: number | string;
  unitCost?: number | string | null;
  revenueType: "recurring" | "one_off_project" | "hardware";
  billingFrequency: "monthly" | "quarterly" | "annual" | "one_off";
};

export const n = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" ? 0 : Number(v));

/** Total value of a line for one billing period. */
export function lineTotal(l: LineLike) {
  return n(l.quantity) * n(l.unitPrice);
}

/** Cost of a line for one billing period, or null when the cost is unknown. */
export function lineCost(l: LineLike): number | null {
  if (l.unitCost === null || l.unitCost === undefined || l.unitCost === "") return null;
  return n(l.quantity) * n(l.unitCost);
}

/**
 * Monthly-normalised value of a recurring line.
 * MRR = quantity × unit price ÷ months per billing period. Non-recurring lines contribute 0.
 */
export function monthlyValue(l: LineLike) {
  if (l.revenueType !== "recurring" || l.billingFrequency === "one_off") return 0;
  const divisor = l.billingFrequency === "annual" ? 12 : l.billingFrequency === "quarterly" ? 3 : 1;
  return lineTotal(l) / divisor;
}

/** Annualised value of a recurring line. */
export function annualValue(l: LineLike) {
  return monthlyValue(l) * 12;
}

export type RevenueSummary = {
  /** Monthly recurring revenue (normalised). */
  mrr: number;
  /** Annual recurring revenue. */
  arr: number;
  /** One-off project revenue. */
  oneOff: number;
  /** Hardware revenue. */
  hardware: number;
  /** First-year total: ARR + one-off + hardware. Used as "opportunity value". */
  firstYearValue: number;
  /** Margin over first-year value; null when any line lacks a cost. */
  marginPercent: number | null;
  /** True when at least one line has no cost, so margin is partial/estimated. */
  marginIsEstimate: boolean;
  lineCount: number;
};

export function summariseLines(lines: LineLike[]): RevenueSummary {
  let mrr = 0;
  let oneOff = 0;
  let hardware = 0;
  let revenue = 0;
  let cost = 0;
  let missingCost = false;
  for (const l of lines) {
    if (l.revenueType === "recurring") {
      mrr += monthlyValue(l);
      revenue += annualValue(l);
    } else if (l.revenueType === "one_off_project") {
      oneOff += lineTotal(l);
      revenue += lineTotal(l);
    } else {
      hardware += lineTotal(l);
      revenue += lineTotal(l);
    }
    const c = lineCost(l);
    if (c === null) missingCost = true;
    else cost += l.revenueType === "recurring" ? (c / (l.billingFrequency === "annual" ? 12 : l.billingFrequency === "quarterly" ? 3 : 1)) * 12 : c;
  }
  const marginPercent = lines.length === 0 || revenue === 0 ? null : ((revenue - cost) / revenue) * 100;
  return {
    mrr,
    arr: mrr * 12,
    oneOff,
    hardware,
    firstYearValue: revenue,
    marginPercent: missingCost && cost === 0 ? null : marginPercent,
    marginIsEstimate: missingCost,
    lineCount: lines.length,
  };
}

export function weighted(value: number, probability: number) {
  return (value * Math.min(100, Math.max(0, probability))) / 100;
}
