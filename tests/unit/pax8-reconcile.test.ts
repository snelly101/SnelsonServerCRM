import { describe, expect, it } from "vitest";
import { matchPax8Bills, reconcileState } from "@/lib/pax8-reconcile";

const inv = (id: string, total: number, date: string, externalId: string | null = null) => ({
  id: `row-${id}`,
  pax8InvoiceId: id,
  externalId,
  total,
  invoiceDate: date,
});
const bill = (invoiceId: string, total: number, date: string, reference = "", invoiceNumber: string | null = null) => ({
  invoiceId,
  invoiceNumber,
  reference,
  total,
  date,
});

describe("Pax8 invoice vs Xero bill matching", () => {
  it("matches by reference or number first, then by a unique identical total within the window, never using a bill twice", () => {
    const m = matchPax8Bills(
      [inv("inv-2026-08-01", 1000, "2026-08-01"), inv("inv-2026-07-01", 900, "2026-07-01"), inv("inv-2026-06-01", 900, "2026-06-01", "ext-77")],
      [
        bill("b-ref", 1012.5, "2026-08-03", "Pax8 inv-2026-08-01"), // reference wins even though the total differs
        bill("b-amt", 900, "2026-07-04"), // unique total within 10 days of July
        bill("b-ext", 901, "2026-06-02", "", "EXT-77/1"), // external id in the number
        bill("b-far", 1000, "2026-09-20"), // right total, wrong month
      ],
    );
    expect(Object.fromEntries([...m].map(([k, v]) => [k, `${v.billId}:${v.basis}`]))).toEqual({
      "row-inv-2026-08-01": "b-ref:reference",
      "row-inv-2026-07-01": "b-amt:amount",
      "row-inv-2026-06-01": "b-ext:reference",
    });
  });

  it("leaves an invoice unmatched when two bills share the total in the window, or none is close enough", () => {
    const m = matchPax8Bills(
      [inv("inv-a", 500, "2026-05-01"), inv("inv-b", 250, "2026-05-01")],
      [bill("b1", 500, "2026-05-02"), bill("b2", 500, "2026-05-03"), bill("b3", 250, "2026-06-15")],
    );
    expect(m.size).toBe(0);
  });

  it("a reference must carry the whole id: a longer number that merely contains it does not match", () => {
    const m = matchPax8Bills([inv("inv-2026-10-01", 100, "2026-10-01")], [bill("b-longer", 999, "2026-10-02", "Pax8 inv-2026-10-011"), bill("b-exact", 999, "2026-10-02", "Pax8 inv-2026-10-01 October")]);
    expect(m.get("row-inv-2026-10-01")).toEqual({ billId: "b-exact", basis: "reference" });
  });

  it("ignores short keys so a four-digit id cannot match by accident, and reports states", () => {
    const m = matchPax8Bills([{ id: "r", pax8InvoiceId: "123", externalId: null, total: 10, invoiceDate: "2026-01-01" }], [bill("b", 99, "2026-01-01", "order 123")]);
    expect(m.size).toBe(0);
    expect(reconcileState(100, null)).toBe("no_bill");
    expect(reconcileState(100, { total: 100.004 })).toBe("matched");
    expect(reconcileState(100, { total: 112.5 })).toBe("amount_differs");
  });
});
