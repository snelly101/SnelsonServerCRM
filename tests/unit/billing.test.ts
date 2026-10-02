import { describe, expect, it } from "vitest";
import { billingPeriodFor, buildContractInvoiceLines, manualPeriod } from "@/lib/billing";

const line = (over: Record<string, unknown> = {}) => ({ id: "L1", description: "Users", revenueType: "recurring", billingFrequency: "monthly", quantity: 10, unitPrice: 40, previousQuantity: null, quantityChangedOn: null, ...over });
const ctx = { months: 1, accountCode: "200", taxType: "OUTPUT2" };

describe("billing periods with a billing day", () => {
  it("pro-rates the first period from the start date to the day before the anchor, then bills whole periods", () => {
    expect(billingPeriodFor("2026-01-17", "monthly", "2026-01-20", null, 1)).toEqual({ periodStart: "2026-01-17", periodEnd: "2026-01-31", fullDays: 31, days: 15 });
    expect(billingPeriodFor("2026-01-17", "monthly", "2026-02-10", null, 1)).toEqual({ periodStart: "2026-02-01", periodEnd: "2026-02-28", fullDays: 28, days: 28 });
    // Starting on the anchor day itself is a whole period.
    expect(billingPeriodFor("2026-02-01", "monthly", "2026-02-15", null, 1)).toEqual({ periodStart: "2026-02-01", periodEnd: "2026-02-28", fullDays: 28, days: 28 });
    // Anchor day earlier in the month than the start: the first anchor is in the same month.
    expect(billingPeriodFor("2026-03-20", "monthly", "2026-04-01", null, 15)).toEqual({ periodStart: "2026-03-20", periodEnd: "2026-04-14", fullDays: 31, days: 26 });
    // Quarterly anchored to the 1st, starting on the 10th of the first month.
    expect(billingPeriodFor("2026-02-10", "quarterly", "2026-02-20", null, 1)).toEqual({ periodStart: "2026-02-10", periodEnd: "2026-04-30", fullDays: 89, days: 80 });
    // No billing day: anchored to the start date, whole periods, as before.
    expect(billingPeriodFor("2026-01-15", "monthly", "2026-10-02", null, null)).toEqual({ periodStart: "2026-09-15", periodEnd: "2026-10-14", fullDays: 30, days: 30 });
    // An end date inside the period shortens it and marks it partial.
    expect(billingPeriodFor("2026-01-01", "monthly", "2026-10-02", "2026-10-20", 1)).toEqual({ periodStart: "2026-10-01", periodEnd: "2026-10-20", fullDays: 31, days: 20 });
    expect(manualPeriod("2026-10-01", "2026-10-31")).toEqual({ periodStart: "2026-10-01", periodEnd: "2026-10-31", fullDays: 31, days: 31 });
  });
});

describe("contract invoice lines", () => {
  const oct = { periodStart: "2026-10-01", periodEnd: "2026-10-31", fullDays: 31, days: 31 };
  it("bills a whole period at quantity × per-period price, normalising annual lines to the contract frequency", () => {
    const out = buildContractInvoiceLines({ ...ctx, period: oct, lines: [line(), line({ id: "L2", description: "Licence", billingFrequency: "annual", quantity: 1, unitPrice: 1200 }), line({ id: "L3", description: "Setup", revenueType: "one_off_project", billingFrequency: "one_off", unitPrice: 500 })] });
    expect(out).toEqual([
      { description: "Users (2026-10-01 to 2026-10-31)", quantity: 10, unitAmount: 40, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1" },
      { description: "Licence (2026-10-01 to 2026-10-31)", quantity: 1, unitAmount: 100, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L2" },
    ]);
  });

  it("pro-rates a partial period by calendar days as a single line", () => {
    const out = buildContractInvoiceLines({ ...ctx, period: { periodStart: "2026-10-17", periodEnd: "2026-10-31", fullDays: 31, days: 15 }, lines: [line()] });
    expect(out).toEqual([{ description: "Users (2026-10-17 to 2026-10-31): 10 × 40.00, 15 of 31 days (pro rata)", quantity: 1, unitAmount: 193.55, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1" }]);
  });

  it("a quantity increase inside the period bills the old quantity for the period plus the increase pro rata; a decrease is not credited", () => {
    const up = buildContractInvoiceLines({ ...ctx, period: oct, lines: [line({ quantity: 13, previousQuantity: 10, quantityChangedOn: "2026-10-12" })] });
    expect(up).toEqual([
      { description: "Users (2026-10-01 to 2026-10-31)", quantity: 10, unitAmount: 40, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1" },
      { description: "Users: 3 added from 2026-10-12, 20 of 31 days (pro rata)", quantity: 1, unitAmount: 77.42, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1" },
    ]);
    const down = buildContractInvoiceLines({ ...ctx, period: oct, lines: [line({ quantity: 8, previousQuantity: 10, quantityChangedOn: "2026-10-12" })] });
    expect(down).toEqual([{ description: "Users (2026-10-01 to 2026-10-31)", quantity: 10, unitAmount: 40, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1" }]);
    // A brand-new line added mid-period: nothing before, the whole quantity pro rata.
    const added = buildContractInvoiceLines({ ...ctx, period: oct, lines: [line({ id: "L9", description: "Backup", quantity: 5, unitPrice: 10, previousQuantity: 0, quantityChangedOn: "2026-10-22" })] });
    expect(added).toEqual([{ description: "Backup: 5 added from 2026-10-22, 10 of 31 days (pro rata)", quantity: 1, unitAmount: 16.13, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L9" }]);
  });

  it("catches up an increase that fell inside the previous, already invoiced, period", () => {
    const previous = { period: { periodStart: "2026-09-01", periodEnd: "2026-09-30", fullDays: 30 }, lines: [{ description: "Users (2026-09-01 to 2026-09-30)", quantity: 10, unitAmount: 40, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1" }] };
    const out = buildContractInvoiceLines({ ...ctx, period: oct, previous, lines: [line({ quantity: 13, previousQuantity: 10, quantityChangedOn: "2026-09-21" })] });
    expect(out).toEqual([
      { description: "Users: 3 added from 2026-09-21, 10 of 30 days (pro rata, previous period)", quantity: 1, unitAmount: 40, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1" },
      { description: "Users (2026-10-01 to 2026-10-31)", quantity: 13, unitAmount: 40, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1" },
    ]);
    // If the previous invoice already carried the new quantity (prepared after the change), nothing is caught up.
    const already = { ...previous, lines: [{ ...previous.lines[0], quantity: 13 }] };
    expect(buildContractInvoiceLines({ ...ctx, period: oct, previous: already, lines: [line({ quantity: 13, previousQuantity: 10, quantityChangedOn: "2026-09-21" })] })).toHaveLength(1);
  });
});
