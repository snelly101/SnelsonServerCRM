import { logger } from "@/lib/logger";

/**
 * Shared HTTP client for all connectors.
 * - timeout per request
 * - bounded retries with jittered exponential backoff on 429/5xx/network errors
 * - honours Retry-After (seconds or HTTP date)
 * - per-client minimum interval between requests (simple rate limiting)
 * - never logs headers or bodies (credentials)
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly bodyText: string,
    public readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status} from ${new URL(url).pathname}`);
    this.name = "HttpError";
  }
  /** Parsed JSON body when possible. */
  get body(): unknown {
    try {
      return JSON.parse(this.bodyText);
    } catch {
      return undefined;
    }
  }
}

export type HttpClientOptions = {
  baseUrl: string;
  /** Headers added to every request (e.g. auth). Evaluated per request so tokens can rotate. */
  headers?: () => Promise<Record<string, string>> | Record<string, string>;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Minimum gap between requests from this client, in ms. */
  minIntervalMs?: number;
  /** Called on 401 so the caller can refresh a token; return true to retry once. */
  onUnauthorized?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
  name: string;
};

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(h);
  return Number.isNaN(d) ? undefined : Math.max(0, d - Date.now());
}

export class HttpClient {
  private lastRequestAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly opts: HttpClientOptions) {}

  private async throttle() {
    const min = this.opts.minIntervalMs ?? 0;
    if (!min) return;
    // Serialise throttled requests so bursts space out.
    const prev = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((r) => (release = r));
    await prev;
    const wait = this.lastRequestAt + min - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
    release();
  }

  async request<T = unknown>(
    method: string,
    path: string,
    init?: { query?: Record<string, string | number | undefined>; body?: unknown; form?: Record<string, string>; headers?: Record<string, string>; raw?: boolean },
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const url = new URL(path.startsWith("http") ? path : this.opts.baseUrl.replace(/\/$/, "") + "/" + path.replace(/^\//, ""));
    for (const [k, v] of Object.entries(init?.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const maxAttempts = this.opts.maxAttempts ?? 5;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let refreshed = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.throttle();
      const headers: Record<string, string> = { Accept: "application/json", ...(await this.opts.headers?.()), ...(init?.headers ?? {}) };
      let body: string | undefined;
      if (init?.form) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(init.form).toString();
      } else if (init?.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(init.body);
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30_000);
      const started = Date.now();
      try {
        const res = await fetchImpl(url, { method, headers, body, signal: ctrl.signal });
        const text = await res.text();
        logger.debug({ provider: this.opts.name, method, path: url.pathname, status: res.status, ms: Date.now() - started, attempt }, "http");
        if (res.ok) {
          const data = (init?.raw ? text : text ? safeJson(text) : null) as T;
          return { status: res.status, data, headers: res.headers };
        }
        if (res.status === 401 && this.opts.onUnauthorized && !refreshed) {
          refreshed = true;
          if (await this.opts.onUnauthorized()) continue;
        }
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        const err = new HttpError(res.status, url.toString(), text, retryAfter);
        if (!RETRYABLE.has(res.status) || attempt === maxAttempts) throw err;
        await sleep(retryAfter ?? backoff(attempt));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        // Network error / timeout
        if (attempt === maxAttempts) throw new HttpError(0, url.toString(), e instanceof Error ? e.message : String(e));
        await sleep(backoff(attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new HttpError(0, url.toString(), "exhausted retries");
  }

  get<T = unknown>(path: string, query?: Record<string, string | number | undefined>, headers?: Record<string, string>) {
    return this.request<T>("GET", path, { query, headers });
  }
  post<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>("POST", path, { body, headers });
  }
  postForm<T = unknown>(path: string, form: Record<string, string>, headers?: Record<string, string>) {
    return this.request<T>("POST", path, { form, headers });
  }
  put<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>("PUT", path, { body, headers });
  }
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Exponential backoff with full jitter: 0.5s, 1s, 2s, 4s… capped at 20s. */
export function backoff(attempt: number) {
  const base = Math.min(20_000, 500 * 2 ** (attempt - 1));
  return Math.floor(Math.random() * base);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Turns any thrown error into a message safe to show on the Integrations page. */
export function describeError(err: unknown): string {
  if (err instanceof HttpError) {
    const b = err.body as { message?: string; Message?: string; error?: string; Detail?: string; resultCode?: string } | undefined;
    const detail = b?.message ?? b?.Message ?? b?.Detail ?? b?.error ?? b?.resultCode;
    if (err.status === 0) return `Network error: ${err.bodyText}`;
    if (err.status === 401) return `Authentication failed (401)${detail ? `: ${detail}` : ""}. Check the credentials.`;
    if (err.status === 403) return `Permission denied (403)${detail ? `: ${detail}` : ""}. Check the app's scopes or plan.`;
    if (err.status === 429) return `Rate limited (429). Try again ${err.retryAfterMs ? `in ${Math.ceil(err.retryAfterMs / 1000)}s` : "later"}.`;
    return `HTTP ${err.status}${detail ? `: ${detail}` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}
