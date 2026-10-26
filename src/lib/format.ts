import { format as formatDate, formatDistanceToNow } from "date-fns";
import { toZonedTime } from "date-fns-tz";

export type DisplaySettings = {
  currency: string;
  dateFormat: string;
  timezone: string;
};

export const DEFAULT_DISPLAY: DisplaySettings = {
  currency: "GBP",
  dateFormat: "dd/MM/yyyy",
  timezone: "Europe/London",
};

export function fmtMoney(amount: number | string | null | undefined, currency = "GBP", locale = "en-GB") {
  if (amount === null || amount === undefined || amount === "") return "—";
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

export function fmtDate(d: Date | string | null | undefined, s: DisplaySettings = DEFAULT_DISPLAY) {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return formatDate(toZonedTime(date, s.timezone), s.dateFormat);
}

export function fmtDateTime(d: Date | string | null | undefined, s: DisplaySettings = DEFAULT_DISPLAY) {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return formatDate(toZonedTime(date, s.timezone), `${s.dateFormat} HH:mm`);
}

export type BilledParts = { monthlyBilled: number; quarterlyBilled: number; annualBilled: number };

/** The recurring value as the invoices carry it: each billing frequency at its own amount, nothing divided down to a month. */
export function billedParts(s: BilledParts, currency = "GBP") {
  const out: { key: "monthly" | "quarterly" | "annual"; amount: number; label: string; text: string }[] = [];
  if (s.monthlyBilled > 0) out.push({ key: "monthly", amount: s.monthlyBilled, label: "monthly", text: `${fmtMoney(s.monthlyBilled, currency)} monthly` });
  if (s.quarterlyBilled > 0) out.push({ key: "quarterly", amount: s.quarterlyBilled, label: "quarterly", text: `${fmtMoney(s.quarterlyBilled, currency)} quarterly` });
  if (s.annualBilled > 0) out.push({ key: "annual", amount: s.annualBilled, label: "annual", text: `${fmtMoney(s.annualBilled, currency)} annual` });
  return out;
}

/** "£566.75 monthly · £1,200.00 annual", or the fallback when nothing recurs. */
export function fmtBilled(s: BilledParts, currency = "GBP", empty = "—") {
  const parts = billedParts(s, currency);
  return parts.length ? parts.map((p) => p.text).join(" · ") : empty;
}

/** What a year of invoices adds up to: monthly × 12 + quarterly × 4 + annual. */
export function billedPerYear(s: BilledParts) {
  return Math.round((s.monthlyBilled * 12 + s.quarterlyBilled * 4 + s.annualBilled) * 100) / 100;
}

export function fmtRelative(d: Date | string | null | undefined) {
  if (!d) return "never";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return formatDistanceToNow(date, { addSuffix: true });
}

export function fmtPercent(n: number | string | null | undefined, digits = 0) {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

/** "512 B", "48 KB", "2.4 MB". */
export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
