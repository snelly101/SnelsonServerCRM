/**
 * Pure matching of Pax8 partner invoices to the Xero purchase bills raised
 * for the Pax8 supplier contact. Shared by the sync (auto-match) and the
 * tests; the service decides what to persist.
 *
 * Rules, in order, for each Pax8 invoice that has no match yet:
 * 1. A bill whose reference or invoice number contains the Pax8 invoice id
 *    (or Pax8's `externalId` when there is one) is the bill.
 * 2. Otherwise exactly one bill with the same total (to the penny) dated
 *    within `dateWindowDays` of the Pax8 invoice date.
 * Anything else stays unmatched for a person to decide.
 */
export type ReconcilablePax8Invoice = {
  id: string;
  pax8InvoiceId: string;
  externalId: string | null;
  total: number | null;
  invoiceDate: string | null;
};

export type ReconcilableBill = {
  invoiceId: string;
  invoiceNumber: string | null;
  reference: string | null;
  total: number | null;
  date: string | null;
};

export const PAX8_MATCH_DATE_WINDOW_DAYS = 10;

const dayDiff = (a: string | null, b: string | null) => {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
};
const sameMoney = (a: number | null, b: number | null) =>
  a !== null && b !== null && Math.abs(a - b) < 0.005;
const mentions = (hay: string | null, needle: string) =>
  Boolean(hay && needle && hay.toLowerCase().includes(needle.toLowerCase()));

/** Returns pax8 invoice row id → matched bill id. Each bill is used at most once. */
export function matchPax8Bills(
  invoices: ReconcilablePax8Invoice[],
  bills: ReconcilableBill[],
  dateWindowDays = PAX8_MATCH_DATE_WINDOW_DAYS,
): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  const free = () => bills.filter((b) => !used.has(b.invoiceId));
  // Pass 1: explicit references.
  for (const inv of invoices) {
    const keys = [inv.pax8InvoiceId, inv.externalId].filter((k): k is string => Boolean(k && k.length >= 4));
    const hit = free().find((b) => keys.some((k) => mentions(b.reference, k) || mentions(b.invoiceNumber, k)));
    if (hit) {
      out.set(inv.id, hit.invoiceId);
      used.add(hit.invoiceId);
    }
  }
  // Pass 2: unique total within the date window.
  for (const inv of invoices) {
    if (out.has(inv.id)) continue;
    const hits = free().filter((b) => sameMoney(b.total, inv.total) && dayDiff(b.date, inv.invoiceDate) <= dateWindowDays);
    if (hits.length === 1) {
      out.set(inv.id, hits[0].invoiceId);
      used.add(hits[0].invoiceId);
    }
  }
  return out;
}

export type ReconcileState = "matched" | "amount_differs" | "no_bill" | "no_pax8_invoice";

/** The state of one Pax8 invoice given its matched bill, if any. */
export function reconcileState(invoiceTotal: number | null, bill: { total: number | null } | null): Exclude<ReconcileState, "no_pax8_invoice"> {
  if (!bill) return "no_bill";
  return sameMoney(invoiceTotal, bill.total) ? "matched" : "amount_differs";
}
