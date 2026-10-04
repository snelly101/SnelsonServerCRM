import { HttpClient, HttpError, describeError } from "@/lib/integrations/http";
import {
  PAX8_API_BASE,
  PAX8_AUDIENCE,
  PAX8_CONSOLE,
  PAX8_TOKEN_URL,
  type Pax8Client,
  type Pax8CompanyCreate,
  type Pax8CompanyRaw,
  type Pax8ContactCreate,
  type Pax8ContactRaw,
  type Pax8InvoiceItemRaw,
  type Pax8InvoiceRaw,
  type Pax8Page,
  type Pax8ProductRaw,
  type Pax8SubscriptionRaw,
  type Pax8SubscriptionUpdate,
} from "./types";

export type Pax8Token = { accessToken: string; expiresAt: number };

/**
 * Live Pax8 Partner API connector.
 * Auth: OAuth 2.0 client_credentials with the client id/secret issued in the
 * Pax8 partner portal (audience api://p8p.client). The only writes are
 * `createCompany` (POST /companies) and `createContact`
 * (POST /companies/{id}/contacts), used by the opt-in auto-create setting:
 * nothing in the CRM can order, change quantities or cancel subscriptions.
 */
export class LivePax8Client implements Pax8Client {
  readonly mode = "live" as const;
  private http: HttpClient;
  private token: Pax8Token | null;
  private fetching: Promise<Pax8Token> | null = null;
  private fetchImpl: typeof fetch;

  constructor(
    private readonly creds: { clientId: string; clientSecret: string },
    cachedToken: Pax8Token | null,
    private readonly onToken: (t: Pax8Token) => Promise<void>,
    fetchImpl?: typeof fetch,
    private readonly pageSize = 200,
  ) {
    this.token = cachedToken;
    this.fetchImpl = fetchImpl ?? fetch;
    this.http = new HttpClient({
      name: "pax8",
      baseUrl: PAX8_API_BASE,
      headers: async () => ({
        Authorization: `Bearer ${(await this.getToken()).accessToken}`,
      }),
      minIntervalMs: 200,
      timeoutMs: 40_000,
      maxAttempts: 5,
      onUnauthorized: async () => {
        this.token = null;
        await this.getToken();
        return true;
      },
      fetchImpl,
    });
  }

  private async getToken(): Promise<Pax8Token> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token;
    if (!this.fetching) {
      this.fetching = (async () => {
        const res = await this.fetchImpl(PAX8_TOKEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            client_id: this.creds.clientId,
            client_secret: this.creds.clientSecret,
            audience: PAX8_AUDIENCE,
            grant_type: "client_credentials",
          }),
        });
        const text = await res.text();
        if (!res.ok) throw new HttpError(res.status, PAX8_TOKEN_URL, text);
        const j = JSON.parse(text) as {
          access_token: string;
          expires_in?: number;
        };
        const t = {
          accessToken: j.access_token,
          expiresAt:
            Date.now() + Math.max(60, (j.expires_in ?? 3600) - 60) * 1000,
        };
        this.token = t;
        await this.onToken(t);
        return t;
      })().finally(() => (this.fetching = null));
    }
    return this.fetching;
  }

  /** Walks every page of a list endpoint. Stops on an empty page or when the reported total is reached. */
  private async paged<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
    max = 50_000,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; page < 1000; page++) {
      const res = await this.http.get<Pax8Page<T> | T[]>(path, {
        ...query,
        page,
        size: this.pageSize,
      });
      const d = res.data;
      const content = Array.isArray(d)
        ? d
        : Array.isArray(d?.content)
          ? d.content
          : [];
      out.push(...content);
      const totalPages = Array.isArray(d) ? 1 : d?.page?.totalPages;
      if (
        content.length === 0 ||
        content.length < this.pageSize ||
        (typeof totalPages === "number" && page + 1 >= totalPages) ||
        out.length >= max
      )
        break;
    }
    return out;
  }

  async testConnection() {
    try {
      const res = await this.http.get<Pax8Page<Pax8CompanyRaw>>("/companies", {
        page: 0,
        size: 1,
      });
      const total =
        res.data?.page?.totalElements ?? res.data?.content?.length ?? 0;
      return { ok: true as const, companyCount: total, partnerName: null };
    } catch (err) {
      return { ok: false as const, error: describeError(err) };
    }
  }

  listCompanies() {
    return this.paged<Pax8CompanyRaw>("/companies", { sort: "name" });
  }

  listProducts() {
    return this.paged<Pax8ProductRaw>("/products");
  }

  listSubscriptions() {
    return this.paged<Pax8SubscriptionRaw>("/subscriptions");
  }

  async listInvoices(limit: number) {
    const rows = await this.paged<Pax8InvoiceRaw>(
      "/invoices",
      { sort: "invoiceDate", direction: "desc" },
      Math.max(limit, this.pageSize),
    );
    return rows
      .sort((a, b) =>
        String(b.invoiceDate ?? "").localeCompare(String(a.invoiceDate ?? "")),
      )
      .slice(0, limit);
  }

  async listInvoiceItems(invoiceId: string) {
    try {
      return await this.paged<Pax8InvoiceItemRaw>(
        `/invoices/${encodeURIComponent(invoiceId)}/items`,
      );
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return [];
      throw err;
    }
  }

  async createCompany(input: Pax8CompanyCreate) {
    const res = await this.http.post<Pax8CompanyRaw>("/companies", input);
    if (!res.data || typeof res.data.id !== "string" || !res.data.id)
      throw new Error("Pax8 did not return the created company.");
    return res.data;
  }

  async updateSubscription(subscriptionId: string, input: Pax8SubscriptionUpdate) {
    try {
      const res = await this.http.put<Pax8SubscriptionRaw>(
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        input,
      );
      if (!res.data || typeof res.data.id !== "string")
        throw new Error("Pax8 did not return the updated subscription.");
      return res.data;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404)
        throw new Error("Pax8 no longer has this subscription (404). Sync and try again.");
      if (err instanceof HttpError && err.status === 422)
        throw new Error(`Pax8 refused the change (422): ${describeError(err)}. Future-dated subscriptions and quantities below the product minimum cannot be changed through the API.`);
      throw err;
    }
  }

  listContacts(companyId: string) {
    return this.paged<Pax8ContactRaw>(
      `/companies/${encodeURIComponent(companyId)}/contacts`,
    );
  }

  async createContact(companyId: string, input: Pax8ContactCreate) {
    const res = await this.http.post<Pax8ContactRaw>(
      `/companies/${encodeURIComponent(companyId)}/contacts`,
      input,
    );
    if (!res.data || typeof res.data.id !== "string" || !res.data.id)
      throw new Error("Pax8 did not return the created contact.");
    return res.data;
  }

  consoleUrl(kind: "company" | "subscription", id: string) {
    return kind === "company"
      ? `${PAX8_CONSOLE}/companies/${id}`
      : `${PAX8_CONSOLE}/subscriptions/${id}`;
  }
}
