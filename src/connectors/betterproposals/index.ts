import { demoModeEnabled, getConnection, getCredentials } from "@/services/integrations";
import { DemoBetterProposalsClient } from "./demo";
import { LiveBetterProposalsClient } from "./live";
import type { BetterProposalsClient } from "./types";

export type BpCredentials = { apiToken: string };
export type BpConfig = { defaultTemplateId?: string; defaultDocumentType?: string; pollMinutes?: number };

/**
 * Resolves the adapter to use. A live token always wins; the demo adapter is
 * only used when DEMO_MODE is on and nothing is configured, and is never
 * presented as connected.
 */
export async function getBetterProposalsClient(): Promise<{ client: BetterProposalsClient; config: BpConfig; mode: "live" | "demo" } | null> {
  const conn = await getConnection("betterproposals");
  const creds = await getCredentials<BpCredentials>("betterproposals");
  const config = (conn.config ?? {}) as BpConfig;
  if (creds?.apiToken) return { client: new LiveBetterProposalsClient(creds.apiToken), config, mode: "live" };
  if (demoModeEnabled()) return { client: new DemoBetterProposalsClient(), config, mode: "demo" };
  return null;
}

export { LiveBetterProposalsClient, DemoBetterProposalsClient };
export type { BetterProposalsClient };
