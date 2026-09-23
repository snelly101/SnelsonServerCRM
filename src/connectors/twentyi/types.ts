/**
 * 20i Reseller API shapes (subset). Base URL https://api.20i.com, bearer auth
 * with the base64-encoded "general API key" from My20i → Reseller → API.
 * Field names from the public docs (docs.20i.com/api) and the Apiary reference;
 * everything not listed is kept verbatim in `raw`.
 */
export const TWENTYI_API_BASE = "https://api.20i.com";
export const TWENTYI_CONSOLE = "https://my.20i.com";

export type TwentyIPackageRaw = {
  id: number | string;
  name: string;
  /** All domain names attached to the package (primary first). */
  names?: string[];
  packageTypeName?: string;
  typeRef?: number | string;
  enabled?: boolean;
  /** ISO 8601 */
  created?: string;
  stackUsers?: string[];
  packageLabels?: string[];
  productSpec?: unknown;
  [k: string]: unknown;
};

export type TwentyIDomainRaw = {
  id: number | string;
  name: string;
  /** ISO date or datetime */
  expiryDate?: string | null;
  deadDate?: string | null;
  closeToAnniversary?: boolean;
  hasPrivacy?: boolean;
  registrantIsVerified?: boolean;
  [k: string]: unknown;
};

export type TwentyIMailboxRaw = {
  id?: number | string;
  local: string;
  domain: string;
  forUser?: string | null;
  [k: string]: unknown;
};

/** Usage figures vary by package type; the client normalises to bytes where it can. */
export type TwentyIUsageRaw = Record<string, unknown>;

export interface TwentyIClient {
  readonly mode: "live" | "demo";
  testConnection(): Promise<{ ok: true; resellerId: string; packageCount: number } | { ok: false; error: string }>;
  listPackages(): Promise<TwentyIPackageRaw[]>;
  listDomains(): Promise<TwentyIDomainRaw[]>;
  /** Mailboxes for one domain on a package. Best effort: packages without email return []. */
  listMailboxes(packageId: string | number, domain: string): Promise<TwentyIMailboxRaw[]>;
  /** Disk usage for a package in bytes, when the API exposes it. */
  packageUsage(packageId: string | number): Promise<{ diskUsedBytes: number | null; diskLimitBytes: number | null; raw: TwentyIUsageRaw } | null>;
  /** Deep link into My20i / StackCP. */
  consoleUrl(kind: "package" | "domain", id: string | number): string;
}

const TWO_PART_TLDS = new Set(["co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "ac.uk", "gov.uk", "nhs.uk", "sch.uk", "net.uk", "com.au", "net.au", "org.au", "co.nz", "co.za", "com.br", "co.jp", "co.in", "com.mx", "org.nz", "co.il", "com.sg"]);

/** Registrable domain for matching: strips subdomains, keeps two-part public suffixes (example.co.uk). */
export function registrableDomain(host: string | null | undefined): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0] ?? "";
  const parts = h.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const last2 = parts.slice(-2).join(".");
  if (TWO_PART_TLDS.has(last2) && parts.length >= 3) return parts.slice(-3).join(".");
  return last2;
}

/** 20i dates are ISO 8601; some fields are date-only. Returns YYYY-MM-DD or null. */
export function twentyIDate(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export function twentyITime(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
