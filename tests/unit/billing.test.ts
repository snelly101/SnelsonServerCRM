import { describe, expect, it } from "vitest";
import { billingPeriodFor, buildContractInvoiceLines, chargeSegments, explainLineCalc, manualPeriod, quantityOn, unitPriceOn, type LineChange } from "@/lib/billing";

const line = (over: Record<string, unknown> = {}) => ({ id: "L1", description: "Users", revenueType: "recurring", billingFrequency: "monthly", quantity: 10, unitPrice: 40, changes: [] as LineChange[], ...over });
const qty = (previousValue: number, newValue: number, effectiveFrom: string, id = `${effectiveFrom}:${newValue}`): LineChange => ({ id, field: "quantity", previousValue, newValue, effectiveFrom });
const price = (previousValue: number, newValue: number, effectiveFrom: string): LineChange => ({ id: `p:${effectiveFrom}`, field: "unit_price", previousValue, newValue, effectiveFrom });
const ctx = { months: 1, accountCode: "200", taxType: "OUTPUT2" };
const strip = (ls: ReturnType<typeof buildContractInvoiceLines>) => ls.map((l) => { const { calc, ...rest } = l; void calc; return rest; });

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
    // Leap day inside a February period.
    expect(billingPeriodFor("2028-01-01", "monthly", "2028-02-10", null, 1)).toEqual({ periodStart: "2028-02-01", periodEnd: "2028-02-29", fullDays: 29, days: 29 });
  });
});

describe("quantity and price on a day", () => {
  it("walks back from today's value through the dated changes, in any input order", () => {
    const l = line({ quantity: 18, changes: [qty(19, 18, "2026-10-25"), qty(14, 16, "2026-10-08"), qty(16, 19, "2026-10-17")] });
    expect(quantityOn(l, "2026-10-01")).toBe(14);
    expect(quantityOn(l, "2026-10-08")).toBe(16);
    expect(quantityOn(l, "2026-10-16")).toBe(16);
    expect(quantityOn(l, "2026-10-17")).toBe(19);
    expect(quantityOn(l, "2026-10-31")).toBe(18);
    // A line edited without history (while the contract was a draft) still answers with today's value.
    expect(quantityOn(line({ quantity: 7, changes: [] }), "2020-01-01")).toBe(7);
    expect(unitPriceOn(line({ unitPrice: 45, changes: [price(40, 45, "2026-11-01")] }), "2026-10-15")).toBe(40);
  });
});

describe("contract invoice lines", () => {
  const oct = { periodStart: "2026-10-01", periodEnd: "2026-10-31", fullDays: 31, days: 31 };
  it("bills a whole period at quantity × per-period price, normalising annual lines to the contract frequency, and records how", () => {
    const out = buildContractInvoiceLines({ ...ctx, period: oct, lines: [line(), line({ id: "L2", description: "Licence", billingFrequency: "annual", quantity: 1, unitPrice: 1200 }), line({ id: "L3", description: "Setup", revenueType: "one_off_project", billingFrequency: "one_off", unitPrice: 500 })] });
    expect(strip(out)).toEqual([
      { description: "Users (2026-10-01 to 2026-10-31)", quantity: 10, unitAmount: 40, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1" },
      { description: "Licence (2026-10-01 to 2026-10-31)", quantity: 1, unitAmount: 100, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L2" },
    ]);
    expect(out[0].calc).toEqual({ kind: "period", quantity: 10, unitPerPeriod: 40, from: "2026-10-01", to: "2026-10-31", days: 31, fullDays: 31, changeIds: [] });
    expect(explainLineCalc(out[0].calc!, (n) => `£${n.toFixed(2)}`)).toBe("10 × £40.00 for 2026-10-01 to 2026-10-31, a whole period.");
  });

  it("pro-rates a partial period by calendar days as a single line", () => {
    const out = buildContractInvoiceLines({ ...ctx, period: { periodStart: "2026-10-17", periodEnd: "2026-10-31", fullDays: 31, days: 15 }, lines: [line()] });
    expect(strip(out)).toEqual([{ description: "Users (2026-10-17 to 2026-10-31): 10 × 40.00, 15 of 31 days (pro rata)", quantity: 1, unitAmount: 193.55, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1" }]);
    expect(out[0].calc?.kind).toBe("prorata");
  });

  it("a quantity increase inside the period bills the old quantity for the period plus the increase pro rata; a decrease is not credited", () => {
    const up = buildContractInvoiceLines({ ...ctx, period: oct, lines: [line({ quantity: 13, changes: [qty(10, 13, "2026-10-12")] })] });
    expect(strip(up)).toEqual([
      { description: "Users (2026-10-01 to 2026-10-31)", quantity: 10, unitAmount: 40, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1" },
      { description: "Users: 3 added from 2026-10-12, 20 of 31 days (pro rata)", quantity: 1, unitAmount: 77.42, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1" },
    ]);
    expect(up[1].calc?.changeIds).toEqual(["2026-10-12:13"]);
    const down = buildContractInvoiceLines({ ...ctx, period: oct, lines: [line({ quantity: 8, changes: [qty(10, 8, "2026-10-12")] })] });
    expect(strip(down)).toEqual([{ description: "Users (2026-10-01 to 2026-10-31)", quantity: 10, unitAmount: 40, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1" }]);
    // A brand-new line added mid-period: nothing before, the whole quantity pro rata.
    const added = buildContractInvoiceLines({ ...ctx, period: oct, lines: [line({ id: "L9", description: "Backup", quantity: 5, unitPrice: 10, changes: [qty(0, 5, "2026-10-22")] })] });
    expect(strip(added)).toEqual([{ description: "Backup: 5 added from 2026-10-22, 10 of 31 days (pro rata)", quantity: 1, unitAmount: 16.13, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L9" }]);
  });

  it("several changes inside one period each count for their own days: 14 → 16 on the 8th, → 19 on the 17th, → 18 on the 25th", () => {
    const l = line({ quantity: 18, changes: [qty(14, 16, "2026-10-08"), qty(16, 19, "2026-10-17"), qty(19, 18, "2026-10-25")] });
    const segs = chargeSegments(l, oct, 1);
    expect(segs.map((s) => [s.kind, s.quantity, s.days, s.amount])).toEqual([
      ["period", 14, 31, 560],
      ["increase", 2, 24, 61.94], // 2 × 40 × 24/31
      ["increase", 3, 15, 58.06], // 3 × 40 × 15/31; the drop to 18 is not credited
    ]);
    // Two changes on one day collapse to the last; a rise then fall back below the billed level adds nothing.
    const bounce = line({ quantity: 10, changes: [qty(10, 12, "2026-10-10", "a"), qty(12, 10, "2026-10-10", "b")] });
    expect(chargeSegments(bounce, oct, 1).map((s) => s.kind)).toEqual(["period"]);
  });

  it("unit price changes apply from the first period starting on or after their effective day, never pro rata", () => {
    const l = line({ unitPrice: 45, changes: [price(40, 45, "2026-10-15")] });
    expect(strip(buildContractInvoiceLines({ ...ctx, period: oct, lines: [l] }))[0]).toMatchObject({ quantity: 10, unitAmount: 40 });
    const nov = { periodStart: "2026-11-01", periodEnd: "2026-11-30", fullDays: 30, days: 30 };
    expect(strip(buildContractInvoiceLines({ ...ctx, period: nov, lines: [l] }))[0]).toMatchObject({ quantity: 10, unitAmount: 45 });
  });

  it("catches up an increase that fell inside the previous, already invoiced, period as the difference between what it should have cost and what was billed", () => {
    const previous = { period: { periodStart: "2026-09-01", periodEnd: "2026-09-30", fullDays: 30 }, lines: [{ description: "Users (2026-09-01 to 2026-09-30)", quantity: 10, unitAmount: 40, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1" }] };
    const out = buildContractInvoiceLines({ ...ctx, period: oct, previous, lines: [line({ quantity: 13, changes: [qty(10, 13, "2026-09-21")] })] });
    expect(strip(out)).toEqual([
      { description: "Users: 3 added from 2026-09-21, 10 of 30 days (pro rata, previous period)", quantity: 1, unitAmount: 40, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1" },
      { description: "Users (2026-10-01 to 2026-10-31)", quantity: 13, unitAmount: 40, accountCode: "200", taxType: "OUTPUT2", contractLineId: "L1" },
    ]);
    expect(out[0].calc).toMatchObject({ kind: "catchup", expected: 440, billedBefore: 400 });
    expect(explainLineCalc(out[0].calc!, (n) => `£${n.toFixed(2)}`)).toMatch(/should have cost £440.00.*£400.00 was invoiced/);
    // If the previous invoice already carried the new quantity (prepared after the change), nothing is caught up.
    const already = { ...previous, lines: [{ ...previous.lines[0], quantity: 13 }] };
    expect(buildContractInvoiceLines({ ...ctx, period: oct, previous: already, lines: [line({ quantity: 13, changes: [qty(10, 13, "2026-09-21")] })] })).toHaveLength(1);
    // Two backdated changes in the previous period: one adjustment line for both.
    const two = buildContractInvoiceLines({ ...ctx, period: oct, previous, lines: [line({ quantity: 14, changes: [qty(10, 13, "2026-09-11"), qty(13, 14, "2026-09-21")] })] });
    expect(two[0]).toMatchObject({ description: "Users: adjustment for 2026-09-01 to 2026-09-30 (2 changes, previous period)", unitAmount: 93.33 }); // 3×40×20/30 + 1×40×10/30
    // A decrease in the previous period never produces a credit line.
    expect(buildContractInvoiceLines({ ...ctx, period: oct, previous, lines: [line({ quantity: 8, changes: [qty(10, 8, "2026-09-21")] })] })).toHaveLength(1);
  });
});
