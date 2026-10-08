import type { ProposalLineItem } from "@/db/schema/integrations";

/**
 * Extracts priced line items from a Better Proposals proposal and its
 * quote. The public API documents only totals for a proposal and nothing
 * at all for a quote, so this walks whatever JSON came back and treats any
 * array of objects that carry a name and a price as a pricing table: rows
 * get a description, a quantity (default 1), a unit price, a total where
 * given, and a billing frequency read from the row itself, its section or
 * the key it sits under (monthly, quarterly, annual, otherwise one-off).
 * Anything it cannot read is left out rather than guessed; the raw JSON is
 * kept on the mirror so a person can check what the API actually sent.
 */
const NAME_KEYS = ["Name", "ItemName", "Title", "Item", "Product", "ProductName", "Service", "Label", "Description"];
const PRICE_KEYS = ["UnitPrice", "Price", "Rate", "UnitCost", "Cost", "Amount", "PricePerUnit"];
const QTY_KEYS = ["Quantity", "Qty", "Units", "Count"];
const TOTAL_KEYS = ["Total", "LineTotal", "SubTotal", "Subtotal", "TotalPrice"];
const FREQ_KEYS = ["BillingType", "Billing", "Frequency", "Recurring", "RecurringType", "Period", "Type", "PaymentType", "Interval", "Term"];

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/[^0-9.-]/g, ""));
  return v.trim() === "" || Number.isNaN(n) ? null : n;
};

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower.get(k.toLowerCase());
    if (real !== undefined && obj[real] !== null && obj[real] !== undefined && obj[real] !== "") return obj[real];
  }
  return undefined;
}

export function frequencyOf(text: unknown): ProposalLineItem["billingFrequency"] | null {
  if (typeof text === "number") return null;
  if (typeof text === "boolean") return text ? "monthly" : "one_off";
  if (typeof text !== "string") return null;
  const t = text.toLowerCase();
  if (/quarter/.test(t)) return "quarterly";
  if (/annual|year/.test(t)) return "annual";
  if (/month|recurring|subscription/.test(t)) return "monthly";
  if (/one.?off|once|single|setup|set-up|one.?time|fixed/.test(t)) return "one_off";
  return null;
}

type Ctx = { frequency: ProposalLineItem["billingFrequency"] | null; section: string | null };

function rowItem(row: Record<string, unknown>, ctx: Ctx, path: string): ProposalLineItem | null {
  const name = pick(row, NAME_KEYS);
  const price = num(pick(row, PRICE_KEYS));
  const qty = num(pick(row, QTY_KEYS)) ?? 1;
  const total = num(pick(row, TOTAL_KEYS));
  // A row whose only price is its total and whose quantity is known gives the unit price by division.
  const unit = price ?? (total !== null && qty ? total / qty : null);
  if (typeof name !== "string" || !name.trim() || unit === null) return null;
  const own = FREQ_KEYS.map((k) => frequencyOf(pick(row, [k]))).find((f) => f !== null) ?? null;
  const description = [name.trim(), typeof row.Description === "string" && row.Description.trim() && row.Description.trim() !== name.trim() && !NAME_KEYS.slice(0, -1).some((k) => pick(row, [k]) === row.Description) ? row.Description.trim() : null].filter(Boolean).join(" · ");
  return { description, quantity: qty, unitPrice: Math.round(unit * 100) / 100, total: total === null ? Math.round(unit * qty * 100) / 100 : total, billingFrequency: own ?? ctx.frequency ?? "one_off", section: ctx.section, path };
}

function walk(node: unknown, ctx: Ctx, path: string, out: ProposalLineItem[], depth: number) {
  if (depth > 8 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    const objects = node.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x));
    const items = objects.map((row, i) => rowItem(row, ctx, `${path}[${i}]`)).filter((x): x is ProposalLineItem => x !== null);
    // An array where most objects price up is a pricing table; otherwise keep walking into it.
    if (items.length && items.length >= Math.ceil(objects.length / 2)) {
      out.push(...items);
      return;
    }
    node.forEach((child, i) => walk(child, ctx, `${path}[${i}]`, out, depth + 1));
    return;
  }
  const obj = node as Record<string, unknown>;
  const sectionTitle = pick(obj, ["Title", "SectionName", "Name", "Heading"]);
  const next: Ctx = {
    frequency: FREQ_KEYS.map((k) => frequencyOf(pick(obj, [k]))).find((f) => f !== null) ?? frequencyOf(typeof sectionTitle === "string" ? sectionTitle : null) ?? ctx.frequency,
    section: typeof sectionTitle === "string" && sectionTitle.trim() ? sectionTitle.trim() : ctx.section,
  };
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || typeof v !== "object") continue;
    const keyFreq = frequencyOf(k);
    walk(v, { frequency: keyFreq ?? next.frequency, section: next.section }, path ? `${path}.${k}` : k, out, depth + 1);
  }
}

export function extractProposalItems(proposalRaw: Record<string, unknown> | null | undefined, quoteRaw: Record<string, unknown> | null | undefined): ProposalLineItem[] {
  const out: ProposalLineItem[] = [];
  if (quoteRaw) walk(quoteRaw, { frequency: null, section: null }, "quote", out, 0);
  if (!out.length && proposalRaw) walk(proposalRaw, { frequency: null, section: null }, "proposal", out, 0);
  // Drop duplicates the walk may reach by two paths.
  const seen = new Set<string>();
  return out.filter((i) => {
    const k = `${i.description}|${i.quantity}|${i.unitPrice}|${i.billingFrequency}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Monthly-equivalent and one-off totals of a set of items, for checking against the proposal's own totals. */
export function itemTotals(items: ProposalLineItem[]) {
  const sum = (f: ProposalLineItem["billingFrequency"]) => Math.round(items.filter((i) => i.billingFrequency === f).reduce((a, i) => a + i.quantity * i.unitPrice, 0) * 100) / 100;
  return { oneOff: sum("one_off"), monthly: sum("monthly"), quarterly: sum("quarterly"), annual: sum("annual") };
}
