import { HttpClient, HttpError, describeError } from "@/lib/integrations/http";
import { TWENTYI_API_BASE, TWENTYI_CONSOLE, type TwentyIClient, type TwentyIDomainRaw, type TwentyIMailboxRaw, type TwentyIPackageRaw, type TwentyIUsageRaw } from "./types";

/**
 * Live 20i Reseller API connector (READ-ONLY).
 * Auth: `Authorization: Bearer <base64(general API key)>` per docs.20i.com/api.
 * The class exposes no write methods by design: nothing in the CRM can
 * provision, suspend, renew or change DNS at 20i.
 */
export class LiveTwentyIClient implements TwentyIClient {
  readonly mode = "live" as const;
  private http: HttpClient;

  constructor(
    private readonly creds: { apiKey: string; tokenMode?: "base64" | "raw" },
    fetchImpl?: typeof fetch,
  ) {
    const token = creds.tokenMode === "raw" ? creds.apiKey : Buffer.from(creds.apiKey, "utf8").toString("base64");
    this.http = new HttpClient({
      name: "twentyi",
      baseUrl: TWENTYI_API_BASE,
      headers: () => ({ Authorization: `Bearer ${token}`, Accept: "application/json" }),
      minIntervalMs: 150,
      timeoutMs: 40_000,
      maxAttempts: 4,
      fetchImpl,
    });
  }

  async testConnection() {
    try {
      const res = await this.http.get<unknown>("/reseller");
      const resellerId = resellerIdFrom(res.data);
      const packages = await this.listPackages();
      return { ok: true as const, resellerId, packageCount: packages.length };
    } catch (err) {
      return { ok: false as const, error: describeError(err) };
    }
  }

  async listPackages() {
    const res = await this.http.get<TwentyIPackageRaw[]>("/package");
    return Array.isArray(res.data) ? res.data : [];
  }

  async listDomains() {
    const res = await this.http.get<TwentyIDomainRaw[]>("/domain");
    return Array.isArray(res.data) ? res.data : [];
  }

  async listMailboxes(packageId: string | number, domain: string) {
    try {
      const res = await this.http.get<TwentyIMailboxRaw[] | Record<string, unknown>>(`/package/${encodeURIComponent(String(packageId))}/email/${encodeURIComponent(domain)}/mailbox`);
      const d = res.data;
      if (Array.isArray(d)) return d.filter((m) => m && typeof m === "object" && "local" in m) as TwentyIMailboxRaw[];
      // Some package types wrap the list.
      const inner = d && typeof d === "object" ? (Object.values(d).find((v) => Array.isArray(v)) as TwentyIMailboxRaw[] | undefined) : undefined;
      return inner?.filter((m) => m && typeof m === "object" && "local" in m) ?? [];
    } catch (err) {
      // 404 / 400: the package has no email service for that name.
      if (err instanceof HttpError && (err.status === 404 || err.status === 400)) return [];
      throw err;
    }
  }

  async packageUsage(packageId: string | number) {
    try {
      const res = await this.http.get<TwentyIUsageRaw>(`/package/${encodeURIComponent(String(packageId))}/web/usage`);
      const raw = (res.data ?? {}) as TwentyIUsageRaw;
      return { ...usageBytes(raw), raw };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 400 || err.status === 403)) return null;
      throw err;
    }
  }

  consoleUrl(kind: "package" | "domain", id: string | number) {
    return kind === "package" ? `${TWENTYI_CONSOLE}/services/manage/${id}` : `${TWENTYI_CONSOLE}/domains/manage/${id}`;
  }
}

/** `GET /reseller` returns an object, an id string, or a one-element array depending on account state. */
export function resellerIdFrom(data: unknown): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return resellerIdFrom(data[0]);
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const k of ["id", "resellerId", "reseller_id", "name"]) if (o[k] !== undefined && o[k] !== null) return String(o[k]);
  }
  return "unknown";
}

/** Pull disk figures out of whichever field names the usage endpoint uses; values may be bytes, MB strings or objects. */
export function usageBytes(raw: Record<string, unknown>): { diskUsedBytes: number | null; diskLimitBytes: number | null } {
  const num = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
    if (typeof v === "string") {
      const m = v.trim().match(/^([\d.]+)\s*(b|kb|mb|gb|tb)?$/i);
      if (!m) return null;
      const n = Number(m[1]);
      const unit = (m[2] ?? "b").toLowerCase();
      const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[unit] ?? 1;
      return Math.round(n * mult);
    }
    return null;
  };
  const pick = (keys: string[]): number | null => {
    for (const k of keys) {
      if (raw[k] !== undefined) {
        const v = raw[k];
        if (v && typeof v === "object") {
          const o = v as Record<string, unknown>;
          const inner = num(o.bytes ?? o.used ?? o.value);
          if (inner !== null) return inner;
        }
        const n = num(v);
        if (n !== null) return n;
      }
    }
    return null;
  };
  const used = pick(["diskUsedBytes", "diskUsage", "disk_used", "diskUsed", "usedBytes", "used", "DiskUsage"]);
  const limit = pick(["diskLimitBytes", "diskQuota", "disk_limit", "diskLimit", "quotaBytes", "quota", "limit", "DiskQuota"]);
  return { diskUsedBytes: used, diskLimitBytes: limit };
}
