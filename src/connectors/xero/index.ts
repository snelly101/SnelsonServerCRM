import { demoModeEnabled, getConnection, getCredentials, setCredentials, updateConnection } from "@/services/integrations";
import { DemoXeroClient } from "./demo";
import { LiveXeroClient, xeroAppConfig } from "./live";
import type { XeroClient, XeroTokens } from "./types";

export type XeroCredentials = XeroTokens & { tenantId?: string };
export type XeroConfig = {
  tenantId?: string;
  tenantName?: string;
  /** Tenants returned at connect time, until one is selected. */
  pendingTenants?: { tenantId: string; tenantName: string }[];
  oauthState?: string;
  oauthStateExpires?: number;
  defaultAccountCode?: string;
  hardwareAccountCode?: string;
  defaultTaxType?: string;
  dueDays?: number;
  brandingThemeId?: string;
  lastWebhookAt?: string;
  webhookEvents?: number;
};

/**
 * Resolves the Xero client. Live requires the OAuth app in .env, stored
 * tokens and a selected tenant; otherwise the demo adapter (only with
 * DEMO_MODE=true), which never reports as connected.
 */
export async function getXeroClient(): Promise<{ client: XeroClient; config: XeroConfig; mode: "live" | "demo" } | null> {
  const conn = await getConnection("xero");
  const config = (conn.config ?? {}) as XeroConfig;
  const app = xeroAppConfig();
  const creds = await getCredentials<XeroCredentials>("xero");
  if (app && creds?.refreshToken && config.tenantId) {
    const client = new LiveXeroClient(app, creds, config.tenantId, async (t) => {
      // Refresh tokens rotate: persist immediately, keep the tenant.
      await setCredentials("xero", { ...t, tenantId: config.tenantId }, null, { status: "connected" });
    });
    return { client, config, mode: "live" };
  }
  if (demoModeEnabled() && !creds?.refreshToken) return { client: new DemoXeroClient(), config, mode: "demo" };
  return null;
}

export { LiveXeroClient, DemoXeroClient, updateConnection };
export type { XeroClient };
