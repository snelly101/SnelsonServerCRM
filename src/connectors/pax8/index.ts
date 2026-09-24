import {
  demoModeEnabled,
  getConnection,
  getCredentials,
  setCredentials,
} from "@/services/integrations";
import { DemoPax8Client } from "./demo";
import { LivePax8Client, type Pax8Token } from "./live";
import type { Pax8Client } from "./types";

export type Pax8Credentials = {
  clientId: string;
  clientSecret: string;
  token?: Pax8Token | null;
};
export type Pax8Config = {
  /** Link Pax8 companies to CRM companies automatically on an exact domain or exact name match (default true). */
  autoLink?: boolean;
  /** How many recent partner invoices to mirror for the per-customer cost view (default 3). */
  invoiceCount?: number;
};

export const DEFAULT_PAX8_CONFIG: Required<Pax8Config> = {
  autoLink: true,
  invoiceCount: 3,
};

export async function getPax8Client(): Promise<{
  client: Pax8Client;
  config: Required<Pax8Config>;
  mode: "live" | "demo";
} | null> {
  const conn = await getConnection("pax8");
  const raw = (conn.config ?? {}) as Pax8Config;
  const config: Required<Pax8Config> = {
    autoLink: raw.autoLink ?? DEFAULT_PAX8_CONFIG.autoLink,
    invoiceCount: raw.invoiceCount ?? DEFAULT_PAX8_CONFIG.invoiceCount,
  };
  const creds = await getCredentials<Pax8Credentials>("pax8");
  if (creds?.clientId && creds.clientSecret) {
    const client = new LivePax8Client(
      { clientId: creds.clientId, clientSecret: creds.clientSecret },
      creds.token ?? null,
      async (token) => {
        // Cache the short-lived access token alongside the credentials (encrypted).
        await setCredentials("pax8", { ...creds, token }, null);
      },
    );
    return { client, config, mode: "live" };
  }
  if (demoModeEnabled())
    return { client: new DemoPax8Client(), config, mode: "demo" };
  return null;
}

export { LivePax8Client, DemoPax8Client };
export type { Pax8Client };
