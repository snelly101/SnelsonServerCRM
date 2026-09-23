import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpClient, HttpError, describeError } from "@/lib/integrations/http";
import type { CreateInvoiceInput, XeroAccount, XeroBrandingTheme, XeroClient, XeroContactRaw, XeroInvoiceRaw, XeroOrganisation, XeroPaymentRaw, XeroTaxRate, XeroTenant, XeroTokens, XeroRepeatingInvoiceRaw, XeroItemRaw } from "./types";

export const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
export const XERO_IDENTITY = "https://identity.xero.com";
export const XERO_CONNECTIONS = "https://api.xero.com/connections";
export const XERO_AUTHORIZE = "https://login.xero.com/identity/connect/authorize";
/**
 * Granular scopes (required for apps created on or after 2 March 2026; the broad
 * accounting.transactions scope is rejected with invalid_scope for those apps):
 *  - accounting.contacts      read contacts, create/update the ones the CRM owns
 *  - accounting.invoices      read sales invoices, create DRAFT invoices
 *  - accounting.payments.read read payments (never written)
 *  - accounting.settings.read accounts, tax rates, branding themes, organisation
 */
export const XERO_SCOPES = "openid profile email offline_access accounting.contacts accounting.invoices accounting.payments.read accounting.settings.read";

export type XeroAppConfig = { clientId: string; clientSecret: string; redirectUri: string };

export function xeroAppConfig(): XeroAppConfig | null {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: `${(process.env.APP_URL ?? "").replace(/\/$/, "")}/api/integrations/xero/callback` };
}

// ---------------------------------------------------------------------------
// OAuth 2.0 (authorization code). Refresh tokens rotate: every refresh returns
// a new refresh token and invalidates the old one, so the caller must persist
// the result immediately (see `onTokens`).
// ---------------------------------------------------------------------------
export function buildAuthorizeUrl(app: XeroAppConfig, state: string) {
  const u = new URL(XERO_AUTHORIZE);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", app.clientId);
  u.searchParams.set("redirect_uri", app.redirectUri);
  u.searchParams.set("scope", XERO_SCOPES);
  u.searchParams.set("state", state);
  return u.toString();
}

async function tokenRequest(app: XeroAppConfig, form: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<XeroTokens> {
  const res = await fetchImpl(`${XERO_IDENTITY}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}` },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `${XERO_IDENTITY}/connect/token`, text);
  const j = JSON.parse(text) as { access_token: string; refresh_token: string; expires_in: number; id_token?: string; scope?: string };
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + (j.expires_in - 60) * 1000, idToken: j.id_token, scope: j.scope };
}

export function exchangeCode(app: XeroAppConfig, code: string, fetchImpl?: typeof fetch) {
  return tokenRequest(app, { grant_type: "authorization_code", code, redirect_uri: app.redirectUri }, fetchImpl);
}

export function refreshTokens(app: XeroAppConfig, refreshToken: string, fetchImpl?: typeof fetch) {
  return tokenRequest(app, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}

export async function listTenants(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<XeroTenant[]> {
  const res = await fetchImpl(XERO_CONNECTIONS, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, XERO_CONNECTIONS, text);
  return JSON.parse(text) as XeroTenant[];
}

/** Verifies a webhook payload: base64(HMAC-SHA256(rawBody, key)) must equal x-xero-signature. */
export function verifyWebhookSignature(rawBody: string, signature: string | null, key: string): boolean {
  if (!signature || !key) return false;
  const expected = createHmac("sha256", key).update(rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
type Envelope<K extends string, T> = { [k in K]: T } & { Status?: string };

export class LiveXeroClient implements XeroClient {
  readonly mode = "live" as const;
  private http: HttpClient;
  private tokens: XeroTokens;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly app: XeroAppConfig,
    tokens: XeroTokens,
    private readonly tenantId: string,
    /** Called with the new token set after every refresh so it can be stored. */
    private readonly onTokens: (t: XeroTokens) => Promise<void>,
    fetchImpl?: typeof fetch,
  ) {
    this.tokens = tokens;
    this.http = new HttpClient({
      name: "xero",
      baseUrl: XERO_API_BASE,
      headers: async () => {
        await this.ensureFresh();
        return { Authorization: `Bearer ${this.tokens.accessToken}`, "xero-tenant-id": this.tenantId };
      },
      // 60/min per tenant: 1.1 s spacing keeps a long sync under the limit; bursts still honour Retry-After.
      minIntervalMs: 1100,
      timeoutMs: 40_000,
      maxAttempts: 5,
      onUnauthorized: async () => {
        await this.refresh();
        return true;
      },
      fetchImpl,
    });
    this.fetchImpl = fetchImpl ?? fetch;
  }
  private fetchImpl: typeof fetch;

  private async ensureFresh() {
    if (Date.now() < this.tokens.expiresAt) return;
    await this.refresh();
  }

  /** Single-flight refresh so concurrent requests don't burn the rotating refresh token twice. */
  private async refresh() {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const next = await refreshTokens(this.app, this.tokens.refreshToken, this.fetchImpl);
        this.tokens = next;
        await this.onTokens(next);
      })().finally(() => (this.refreshing = null));
    }
    await this.refreshing;
  }

  private headersFor(ifModifiedSince?: Date, idempotencyKey?: string) {
    const h: Record<string, string> = {};
    if (ifModifiedSince) h["If-Modified-Since"] = ifModifiedSince.toISOString();
    if (idempotencyKey) h["Idempotency-Key"] = idempotencyKey.slice(0, 128);
    return h;
  }

  async testConnection() {
    try {
      const org = await this.getOrganisation();
      return { ok: true as const, organisationName: org.Name, organisationId: org.OrganisationID, baseCurrency: org.BaseCurrency ?? null, tenantId: this.tenantId };
    } catch (err) {
      return { ok: false as const, error: describeError(err) };
    }
  }

  async getOrganisation() {
    const res = await this.http.get<Envelope<"Organisations", XeroOrganisation[]>>("/Organisation");
    return res.data.Organisations[0];
  }

  async listContacts(opts: { page: number; ifModifiedSince?: Date; includeArchived?: boolean; searchTerm?: string }) {
    const res = await this.http.get<Envelope<"Contacts", XeroContactRaw[]>>("/Contacts", { page: opts.page, includeArchived: opts.includeArchived ? "true" : undefined, searchTerm: opts.searchTerm, summaryOnly: "false" }, this.headersFor(opts.ifModifiedSince));
    return res.data.Contacts ?? [];
  }

  async getContact(contactId: string) {
    try {
      const res = await this.http.get<Envelope<"Contacts", XeroContactRaw[]>>(`/Contacts/${encodeURIComponent(contactId)}`);
      return res.data.Contacts?.[0] ?? null;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  async createContact(input: { name: string; emailAddress?: string | null; firstName?: string | null; lastName?: string | null; taxNumber?: string | null; companyNumber?: string | null; phone?: string | null; address?: XeroContactRaw["Addresses"] extends (infer A)[] | undefined ? A | null : never }, idempotencyKey: string) {
    const body = {
      Contacts: [
        {
          Name: input.name,
          FirstName: input.firstName ?? undefined,
          LastName: input.lastName ?? undefined,
          EmailAddress: input.emailAddress ?? undefined,
          TaxNumber: input.taxNumber ?? undefined,
          CompanyNumber: input.companyNumber ?? undefined,
          IsCustomer: true,
          Phones: input.phone ? [{ PhoneType: "DEFAULT", PhoneNumber: input.phone }] : undefined,
          Addresses: input.address ? [input.address] : undefined,
        },
      ],
    };
    const res = await this.http.request<Envelope<"Contacts", XeroContactRaw[]>>("PUT", "/Contacts", { body, headers: this.headersFor(undefined, idempotencyKey) });
    return res.data.Contacts[0];
  }

  async updateContact(contactId: string, patch: { emailAddress?: string | null; phone?: string | null }, idempotencyKey: string) {
    const body = { Contacts: [{ ContactID: contactId, EmailAddress: patch.emailAddress ?? undefined, Phones: patch.phone ? [{ PhoneType: "DEFAULT", PhoneNumber: patch.phone }] : undefined }] };
    const res = await this.http.request<Envelope<"Contacts", XeroContactRaw[]>>("POST", `/Contacts/${encodeURIComponent(contactId)}`, { body, headers: this.headersFor(undefined, idempotencyKey) });
    return res.data.Contacts[0];
  }

  async listInvoices(opts: { page: number; ifModifiedSince?: Date; statuses?: string[]; contactIds?: string[]; where?: string }) {
    const res = await this.http.get<Envelope<"Invoices", XeroInvoiceRaw[]>>("/Invoices", { page: opts.page, Statuses: opts.statuses?.join(","), ContactIDs: opts.contactIds?.join(","), where: opts.where, unitdp: 4 }, this.headersFor(opts.ifModifiedSince));
    return res.data.Invoices ?? [];
  }

  async getInvoice(invoiceId: string) {
    try {
      const res = await this.http.get<Envelope<"Invoices", XeroInvoiceRaw[]>>(`/Invoices/${encodeURIComponent(invoiceId)}`, { unitdp: 4 });
      return res.data.Invoices?.[0] ?? null;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  /** PUT /Invoices with Status=DRAFT. The CRM never authorises or sends. */
  async createDraftInvoice(input: CreateInvoiceInput, idempotencyKey: string) {
    const body = {
      Invoices: [
        {
          Type: "ACCREC",
          Status: "DRAFT",
          Contact: { ContactID: input.contactId },
          Reference: input.reference,
          Date: input.date,
          DueDate: input.dueDate,
          CurrencyCode: input.currencyCode,
          LineAmountTypes: input.lineAmountTypes,
          BrandingThemeID: input.brandingThemeId,
          Url: input.url,
          LineItems: input.lineItems.map((l) => ({ Description: l.description, Quantity: l.quantity, UnitAmount: l.unitAmount, AccountCode: l.accountCode, TaxType: l.taxType, ItemCode: l.itemCode ?? undefined })),
        },
      ],
    };
    const res = await this.http.request<Envelope<"Invoices", XeroInvoiceRaw[]>>("PUT", "/Invoices", { body, query: { unitdp: 4 }, headers: this.headersFor(undefined, idempotencyKey) });
    const inv = res.data.Invoices?.[0];
    if (!inv) throw new Error("Xero returned no invoice");
    const errs = (inv as { ValidationErrors?: { Message: string }[] }).ValidationErrors;
    if (errs?.length) throw new Error(`Xero rejected the invoice: ${errs.map((e) => e.Message).join("; ")}`);
    return inv;
  }

  async getOnlineInvoiceUrl(invoiceId: string) {
    try {
      const res = await this.http.get<Envelope<"OnlineInvoices", { OnlineInvoiceUrl: string }[]>>(`/Invoices/${encodeURIComponent(invoiceId)}/OnlineInvoice`);
      return res.data.OnlineInvoices?.[0]?.OnlineInvoiceUrl ?? null;
    } catch {
      return null; // only available for AUTHORISED invoices
    }
  }

  async listPayments(opts: { page: number; ifModifiedSince?: Date }) {
    const res = await this.http.get<Envelope<"Payments", XeroPaymentRaw[]>>("/Payments", { page: opts.page }, this.headersFor(opts.ifModifiedSince));
    return res.data.Payments ?? [];
  }

  async listRepeatingInvoices() {
    const res = await this.http.get<Envelope<"RepeatingInvoices", XeroRepeatingInvoiceRaw[]>>("/RepeatingInvoices", { unitdp: 4 });
    return res.data.RepeatingInvoices ?? [];
  }

  async listItems() {
    const res = await this.http.get<Envelope<"Items", XeroItemRaw[]>>("/Items", { unitdp: 4 });
    return res.data.Items ?? [];
  }

  async listAccounts() {
    const res = await this.http.get<Envelope<"Accounts", XeroAccount[]>>("/Accounts", { where: 'Status=="ACTIVE"' });
    return res.data.Accounts ?? [];
  }

  async listTaxRates() {
    const res = await this.http.get<Envelope<"TaxRates", XeroTaxRate[]>>("/TaxRates");
    return (res.data.TaxRates ?? []).filter((t) => t.Status !== "DELETED" && t.Status !== "ARCHIVED");
  }

  async listBrandingThemes() {
    const res = await this.http.get<Envelope<"BrandingThemes", XeroBrandingTheme[]>>("/BrandingThemes");
    return res.data.BrandingThemes ?? [];
  }
}

/** Xero dates come as "/Date(1700000000000+0000)/" or ISO strings. */
export function xeroDate(v: unknown): Date | null {
  if (!v || typeof v !== "string") return null;
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(v);
  if (m) return new Date(Number(m[1]));
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function xeroDateOnly(v: unknown, fallbackString?: unknown): string | null {
  if (typeof fallbackString === "string" && /^\d{4}-\d{2}-\d{2}/.test(fallbackString)) return fallbackString.slice(0, 10);
  const d = xeroDate(v);
  return d ? d.toISOString().slice(0, 10) : null;
}
