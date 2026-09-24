import { demoModeEnabled } from "@/services/integrations";
import { DemoM365Client } from "./demo";
import { LiveM365Client, type M365Credentials, type M365Token } from "./live";
import type { M365Client } from "./types";

/** One demo client per process so tests and the demo mailbox share state across calls. */
let demo: DemoM365Client | null = null;
export function demoM365(
  address = process.env.HELPDESK_DEMO_MAILBOX ?? "support@example.com",
) {
  if (!demo || demo.address !== address.toLowerCase())
    demo = new DemoM365Client(address);
  return demo;
}
export function resetDemoM365() {
  demo = null;
}

export function m365ClientFor(
  creds: M365Credentials | null,
  address: string,
  onToken: (t: M365Token) => Promise<void>,
): { client: M365Client; mode: "live" | "demo" } | null {
  if (
    creds?.clientId &&
    creds.tenantId &&
    (creds.clientSecret || creds.privateKeyPem)
  )
    return { client: new LiveM365Client(creds, onToken), mode: "live" };
  if (demoModeEnabled()) return { client: demoM365(address), mode: "demo" };
  return null;
}

export { LiveM365Client, DemoM365Client };
export type { M365Client, M365Credentials, M365Token };
