/**
 * Pax8 Partner API shapes (subset). Base URL https://api.pax8.com/v1, OAuth
 * 2.0 client-credentials at https://login.pax8.com/oauth/token with
 * audience `api://p8p.client`. Field names follow the public API reference
 * (devx.pax8.com); anything not listed is kept verbatim in `raw`.
 * Every list endpoint is paged: `page` (0-based) and `size` (max 200), with
 * `{ content: [...], page: { size, totalElements, totalPages, number } }`.
 */
export const PAX8_API_BASE = "https://api.pax8.com/v1";
export const PAX8_TOKEN_URL = "https://login.pax8.com/oauth/token";
export const PAX8_AUDIENCE = "api://p8p.client";
export const PAX8_CONSOLE = "https://app.pax8.com";

export type Pax8Page<T> = {
  content?: T[];
  page?: {
    size?: number;
    totalElements?: number;
    totalPages?: number;
    number?: number;
  };
};

export type Pax8CompanyRaw = {
  id: string;
  name: string;
  address?: {
    street?: string;
    street2?: string;
    city?: string;
    stateOrProvince?: string;
    postalCode?: string;
    country?: string;
  } | null;
  phone?: string | null;
  website?: string | null;
  externalId?: string | null;
  billOnBehalfEnabled?: boolean;
  selfServiceAllowed?: boolean;
  orderApprovalRequired?: boolean;
  /** Active | Inactive | Deleted */
  status?: string | null;
  [k: string]: unknown;
};

export type Pax8ProductRaw = {
  id: string;
  name: string;
  vendorName?: string | null;
  shortDescription?: string | null;
  sku?: string | null;
  altVendorName?: string | null;
  vendorSku?: string | null;
  [k: string]: unknown;
};

export type Pax8SubscriptionRaw = {
  id: string;
  companyId: string;
  productId: string;
  quantity?: number | null;
  /** ISO dates */
  startDate?: string | null;
  createdDate?: string | null;
  billingStart?: string | null;
  endDate?: string | null;
  status?: string | null;
  /** Partner buy price per unit per billing term. */
  price?: number | string | null;
  currency?: string | null;
  /** Monthly | Annual | 2-Year | 3-Year | One-Time | Trial | Activation */
  billingTerm?: string | null;
  commitmentTerm?:
    | { term?: string | null; endDate?: string | null }
    | string
    | null;
  [k: string]: unknown;
};

export type Pax8InvoiceRaw = {
  id: string;
  status?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  balance?: number | string | null;
  carriedBalance?: number | string | null;
  total?: number | string | null;
  currency?: string | null;
  partnerName?: string | null;
  externalId?: string | null;
  [k: string]: unknown;
};

export type Pax8InvoiceItemRaw = {
  id: string;
  purchaseOrderNumber?: string | null;
  type?: string | null;
  companyId?: string | null;
  productId?: string | null;
  sku?: string | null;
  description?: string | null;
  quantity?: number | string | null;
  unitPrice?: number | string | null;
  total?: number | string | null;
  currency?: string | null;
  term?: string | null;
  startPeriod?: string | null;
  endPeriod?: string | null;
  chargeType?: string | null;
  [k: string]: unknown;
};

export interface Pax8Client {
  readonly mode: "live" | "demo";
  testConnection(): Promise<
    | { ok: true; companyCount: number; partnerName: string | null }
    | { ok: false; error: string }
  >;
  listCompanies(): Promise<Pax8CompanyRaw[]>;
  listProducts(): Promise<Pax8ProductRaw[]>;
  listSubscriptions(): Promise<Pax8SubscriptionRaw[]>;
  /** Partner invoices from Pax8, newest first. */
  listInvoices(limit: number): Promise<Pax8InvoiceRaw[]>;
  listInvoiceItems(invoiceId: string): Promise<Pax8InvoiceItemRaw[]>;
  /** Deep link into the Pax8 partner portal. */
  consoleUrl(kind: "company" | "subscription", id: string): string;
}

/** Pax8 dates are ISO 8601 (date or datetime). Returns YYYY-MM-DD or null. */
export function pax8Date(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export function pax8Time(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function pax8Number(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))
    return Number(v);
  return null;
}

/** Months in a Pax8 billing term, for converting a per-term price to a monthly cost. Null for one-off terms. */
export function termMonths(term: string | null | undefined): number | null {
  const t = (term ?? "").toLowerCase().replace(/[\s_-]/g, "");
  if (t === "monthly" || t === "month") return 1;
  if (t === "quarterly") return 3;
  if (t === "annual" || t === "annually" || t === "yearly" || t === "1year")
    return 12;
  const m = t.match(/^(\d+)year/);
  if (m) return Number(m[1]) * 12;
  return null;
}

export function commitmentOf(v: Pax8SubscriptionRaw["commitmentTerm"]): {
  term: string | null;
  endsOn: string | null;
} {
  if (!v) return { term: null, endsOn: null };
  if (typeof v === "string") return { term: v, endsOn: null };
  return { term: v.term ?? null, endsOn: pax8Date(v.endDate) };
}
