import type { Metadata } from "next";
import { getAppSettings } from "@/lib/settings";
import { currentPortalAccount } from "@/lib/portal-auth";
import { PortalShell } from "@/components/portal/shell";

export const metadata: Metadata = { title: { default: "Support portal", template: "%s · Support portal" } };
export const dynamic = "force-dynamic";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const [settings, account] = await Promise.all([getAppSettings(), currentPortalAccount()]);
  return (
    <PortalShell providerName={settings.companyName} account={account ? { name: account.name, companyName: account.companyName } : null}>
      {children}
    </PortalShell>
  );
}
