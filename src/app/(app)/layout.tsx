import { currentTwoFactorPolicy, requireUser } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { AppShell } from "@/components/app-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // The layout must render for users who still have to enrol in two-factor authentication;
  // individual pages redirect them to /account/security.
  const [user, settings, policy] = await Promise.all([requireUser({ allowUnenrolled: true }), getAppSettings(), currentTwoFactorPolicy()]);
  return (
    <AppShell user={user} companyName={settings.companyName} demoMode={process.env.DEMO_MODE === "true"} twoFactorDueBy={policy?.dueBy ?? null}>
      {children}
    </AppShell>
  );
}
