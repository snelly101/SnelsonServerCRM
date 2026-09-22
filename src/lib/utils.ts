import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const LEGAL_SUFFIXES =
  /\b(ltd|limited|plc|llp|llc|inc|incorporated|co|company|corp|corporation|gmbh|the)\b/g;

/** Normalises a company name for duplicate detection: lower case, no punctuation, no legal suffixes. */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  return e.length ? e : null;
}

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "live.co.uk",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "btinternet.com",
  "sky.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
]);

/** Extracts a bare domain from a website URL or email address. Returns null for free mail providers. */
export function extractDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("@")) s = s.split("@")[1] ?? "";
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split(/[/?#:]/)[0] ?? "";
  if (!s.includes(".")) return null;
  if (FREE_EMAIL_DOMAINS.has(s)) return null;
  return s;
}

export function fullName(c: { firstName: string; lastName?: string | null }) {
  return [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

/** Reads a string search param, returning undefined for blanks. */
export function param(sp: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.length ? s : undefined;
}

export function toInt(v: string | undefined, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
