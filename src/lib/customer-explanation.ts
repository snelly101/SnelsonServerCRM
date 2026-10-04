import type { InvoiceDraftLine } from "@/db/schema";

/**
 * Customer-facing wording for a draft invoice, derived from the calculated
 * lines only (never guessed): what the charge covers, what was added or
 * removed part-way and when, and any adjustment for an earlier period.
 *
 *   "Your charge for 1 to 30 November 2026 includes 16 × Microsoft 365
 *    Business Standard and 1 × Managed backup, plus £10.92 for 2 × Microsoft
 *    365 Business Standard added on 14 October 2026."
 */
export type CustomerExplanation = {
  /** One paragraph for the invoice email or notes. */
  summary: string;
  /** One sentence per line, in invoice order, for the schedule. */
  lines: string[];
  /** Service dates covered by the whole-period lines. */
  from: string | null;
  to: string | null;
};

const stripDates = (d: string) => d.replace(/^.* · /, "").replace(/\s*\((?:\d{4}-\d{2}-\d{2}|\d{1,2} \w+ \d{4}).*$/, "").replace(/:\s.*$/, "").trim();
const joinAnd = (parts: string[]) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

export function customerExplanation(lines: InvoiceDraftLine[], opts: { money: (n: number) => string; date: (iso: string) => string }): CustomerExplanation {
  const { money, date } = opts;
  const included: string[] = [];
  const extras: string[] = [];
  const perLine: string[] = [];
  let from = null as string | null;
  let to = null as string | null;
  for (const l of lines) {
    const amount = Math.round(l.quantity * l.unitAmount * 100) / 100;
    const name = stripDates(l.description);
    const c = l.calc;
    if (!c) {
      perLine.push(`${l.description}: ${money(amount)}.`);
      extras.push(`${money(amount)} for ${l.description}`);
      continue;
    }
    if (c.kind === "period") {
      from = from === null || c.from < from ? c.from : from;
      to = to === null || c.to > to ? c.to : to;
      included.push(`${c.quantity} × ${name}`);
      perLine.push(`${c.quantity} × ${name} for ${date(c.from)} to ${date(c.to)}: ${money(amount)}.`);
    } else if (c.kind === "prorata") {
      from = from === null || c.from < from ? c.from : from;
      to = to === null || c.to > to ? c.to : to;
      included.push(`${c.quantity} × ${name} from ${date(c.from)} (${c.days} of ${c.fullDays} days)`);
      perLine.push(`${c.quantity} × ${name} for ${c.days} of the ${c.fullDays} days from ${date(c.from)} to ${date(c.to)}: ${money(amount)}.`);
    } else if (c.kind === "increase") {
      extras.push(`${money(amount)} for ${c.quantity} × ${name} added on ${date(c.from)}`);
      perLine.push(`${c.quantity} × ${name} added on ${date(c.from)}, charged for the ${c.days} remaining days to ${date(c.to)}: ${money(amount)}.`);
    } else if (c.kind === "decrease") {
      extras.push(`a credit of ${money(Math.abs(amount))} for ${c.quantity} × ${name} removed on ${date(c.from)}`);
      perLine.push(`${c.quantity} × ${name} removed on ${date(c.from)}, credited for the ${c.days} unused days to ${date(c.to)}: ${money(amount)}.`);
    } else if (c.kind === "catchup") {
      const word = amount >= 0 ? `an adjustment of ${money(amount)}` : `a credit of ${money(Math.abs(amount))}`;
      extras.push(`${word} for ${name} between ${date(c.from)} and ${date(c.to)} (changes made after that period was invoiced)`);
      perLine.push(`Adjustment for ${name}, ${date(c.from)} to ${date(c.to)}: that period should have cost ${money(c.expected ?? 0)} and ${money(c.billedBefore ?? 0)} was invoiced, so ${money(Math.abs(amount))} is ${amount >= 0 ? "added" : "credited"}.`);
    }
  }
  const period = from && to ? `for ${date(from)} to ${date(to)}` : "";
  let summary = included.length ? `Your charge ${period} includes ${joinAnd(included)}` : extras.length ? "Your charge includes" : "";
  if (extras.length) summary += `${included.length ? ", plus " : " "}${joinAnd(extras)}`;
  if (summary) summary = summary.replace(/\s+/g, " ").trim() + ".";
  return { summary, lines: perLine, from, to };
}
