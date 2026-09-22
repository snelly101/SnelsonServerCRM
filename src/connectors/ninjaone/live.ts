import { HttpClient, HttpError, describeError } from "@/lib/integrations/http";
import { NINJA_REGION_HOSTS, type NinjaCursorReport, type NinjaDeviceHealthRaw, type NinjaDeviceRaw, type NinjaLocationRaw, type NinjaOneClient, type NinjaOrganizationRaw, type NinjaRegion } from "./types";

export type NinjaToken = { accessToken: string; expiresAt: number };

/**
 * Live NinjaOne connector (READ-ONLY).
 * Auth: OAuth 2.0 client_credentials for an "API Services (machine-to-machine)"
 * client with the `monitoring` scope, at https://<instance>.ninjarmm.com/ws/oauth/token.
 * The class exposes no write methods by design.
 */
export class LiveNinjaOneClient implements NinjaOneClient {
  readonly mode = "live" as const;
  private http: HttpClient;
  private token: NinjaToken | null;
  private fetching: Promise<NinjaToken> | null = null;
  private readonly host: string;

  constructor(
    private readonly creds: { clientId: string; clientSecret: string; region: NinjaRegion },
    cachedToken: NinjaToken | null,
    private readonly onToken: (t: NinjaToken) => Promise<void>,
    fetchImpl?: typeof fetch,
  ) {
    this.host = NINJA_REGION_HOSTS[creds.region] ?? NINJA_REGION_HOSTS.eu;
    this.token = cachedToken;
    this.fetchImpl = fetchImpl ?? fetch;
    this.http = new HttpClient({
      name: "ninjaone",
      baseUrl: `${this.host}/api/v2`,
      headers: async () => ({ Authorization: `Bearer ${(await this.getToken()).accessToken}` }),
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
  private fetchImpl: typeof fetch;

  private async getToken(): Promise<NinjaToken> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token;
    if (!this.fetching) {
      this.fetching = (async () => {
        const res = await this.fetchImpl(`${this.host}/ws/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.creds.clientId, client_secret: this.creds.clientSecret, scope: "monitoring" }).toString(),
        });
        const text = await res.text();
        if (!res.ok) throw new HttpError(res.status, `${this.host}/ws/oauth/token`, text);
        const j = JSON.parse(text) as { access_token: string; expires_in: number };
        const t = { accessToken: j.access_token, expiresAt: Date.now() + Math.max(60, j.expires_in - 60) * 1000 };
        this.token = t;
        await this.onToken(t);
        return t;
      })().finally(() => (this.fetching = null));
    }
    return this.fetching;
  }

  async testConnection() {
    try {
      const orgs = await this.listOrganizations(undefined, 5);
      return { ok: true as const, organisationCount: orgs.length, region: this.creds.region, instance: this.host };
    } catch (err) {
      return { ok: false as const, error: describeError(err) };
    }
  }

  async listOrganizations(after?: number, pageSize = 200) {
    const res = await this.http.get<NinjaOrganizationRaw[]>("/organizations", { pageSize, after });
    return Array.isArray(res.data) ? res.data : [];
  }

  async listLocations(orgId: number) {
    const res = await this.http.get<NinjaLocationRaw[]>(`/organization/${orgId}/locations`);
    return Array.isArray(res.data) ? res.data : [];
  }

  async listDevicesDetailed(after?: number, pageSize = 500, filter?: string) {
    const res = await this.http.get<NinjaDeviceRaw[]>("/devices-detailed", { pageSize, after, df: filter });
    return Array.isArray(res.data) ? res.data : [];
  }

  async getDevice(deviceId: number) {
    try {
      const res = await this.http.get<NinjaDeviceRaw>(`/device/${deviceId}`);
      return res.data ?? null;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  async deviceHealth(cursor?: string, pageSize = 500) {
    const res = await this.http.get<NinjaCursorReport<NinjaDeviceHealthRaw>>("/queries/device-health", { pageSize, cursor });
    const results = res.data?.results ?? [];
    const next = res.data?.cursor?.name && results.length >= pageSize ? res.data.cursor.name : null;
    return { results, nextCursor: next };
  }

  consoleUrl(kind: "device" | "organization", id: string | number) {
    return kind === "device" ? `${this.host}/#/deviceDashboard/${id}/overview` : `${this.host}/#/customerDashboard/${id}/overview`;
  }
}

/** NinjaOne timestamps are epoch seconds (sometimes fractional). */
export function ninjaTime(v: unknown): Date | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return new Date(v * 1000);
}
