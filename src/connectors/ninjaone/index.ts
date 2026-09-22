import { demoModeEnabled, getConnection, getCredentials, setCredentials } from "@/services/integrations";
import { DemoNinjaOneClient } from "./demo";
import { LiveNinjaOneClient, type NinjaToken } from "./live";
import type { NinjaOneClient, NinjaRegion } from "./types";

export type NinjaCredentials = { clientId: string; clientSecret: string; region: NinjaRegion; token?: NinjaToken | null };
export type NinjaConfig = {
  /** Device classes that count towards per-device contract lines. */
  billableNodeClasses?: string[];
  /** Only APPROVED devices count (default true). */
  approvedOnly?: boolean;
};

export const DEFAULT_BILLABLE_CLASSES = ["WINDOWS_WORKSTATION", "WINDOWS_SERVER", "MAC", "MAC_SERVER", "LINUX_WORKSTATION", "LINUX_SERVER", "VMWARE_VM_GUEST", "HYPERV_VMM_GUEST"];

export async function getNinjaOneClient(): Promise<{ client: NinjaOneClient; config: Required<NinjaConfig>; mode: "live" | "demo" } | null> {
  const conn = await getConnection("ninjaone");
  const raw = (conn.config ?? {}) as NinjaConfig;
  const config = { billableNodeClasses: raw.billableNodeClasses?.length ? raw.billableNodeClasses : DEFAULT_BILLABLE_CLASSES, approvedOnly: raw.approvedOnly ?? true };
  const creds = await getCredentials<NinjaCredentials>("ninjaone");
  if (creds?.clientId && creds.clientSecret) {
    const client = new LiveNinjaOneClient({ clientId: creds.clientId, clientSecret: creds.clientSecret, region: creds.region ?? "eu" }, creds.token ?? null, async (token) => {
      // Cache the short-lived access token alongside the credentials (encrypted).
      await setCredentials("ninjaone", { ...creds, token }, null);
    });
    return { client, config, mode: "live" };
  }
  if (demoModeEnabled()) return { client: new DemoNinjaOneClient(), config, mode: "demo" };
  return null;
}

export { LiveNinjaOneClient, DemoNinjaOneClient };
export type { NinjaOneClient };
