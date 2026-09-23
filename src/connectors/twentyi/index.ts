import { demoModeEnabled, getConnection, getCredentials } from "@/services/integrations";
import { DemoTwentyIClient } from "./demo";
import { LiveTwentyIClient } from "./live";
import type { TwentyIClient } from "./types";

export type TwentyICredentials = { apiKey: string; tokenMode?: "base64" | "raw" };
export type TwentyIConfig = {
  /** Days before a domain/certificate expiry to raise a reminder task (default 30). */
  expiryReminderDays?: number;
  /** Link packages and domains to a company automatically when the registrable domain matches exactly (default true). */
  autoLink?: boolean;
  /** Fetch mailboxes per package name (one call per name; default true). */
  syncMailboxes?: boolean;
};

export const DEFAULT_TWENTYI_CONFIG: Required<TwentyIConfig> = { expiryReminderDays: 30, autoLink: true, syncMailboxes: true };

export async function getTwentyIClient(): Promise<{ client: TwentyIClient; config: Required<TwentyIConfig>; mode: "live" | "demo" } | null> {
  const conn = await getConnection("twentyi");
  const raw = (conn.config ?? {}) as TwentyIConfig;
  const config: Required<TwentyIConfig> = { expiryReminderDays: raw.expiryReminderDays ?? DEFAULT_TWENTYI_CONFIG.expiryReminderDays, autoLink: raw.autoLink ?? DEFAULT_TWENTYI_CONFIG.autoLink, syncMailboxes: raw.syncMailboxes ?? DEFAULT_TWENTYI_CONFIG.syncMailboxes };
  const creds = await getCredentials<TwentyICredentials>("twentyi");
  if (creds?.apiKey) return { client: new LiveTwentyIClient(creds), config, mode: "live" };
  if (demoModeEnabled()) return { client: new DemoTwentyIClient(), config, mode: "demo" };
  return null;
}

export { LiveTwentyIClient, DemoTwentyIClient };
export type { TwentyIClient };
