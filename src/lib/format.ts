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
