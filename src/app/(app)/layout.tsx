import { requireUser } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { AppShell } from "@/components/app-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [user, settings] = await Promise.all([requireUser(), getAppSettings()]);
  return (
    <AppShell user={user} companyName={settings.companyName} demoMode={process.env.DEMO_MODE === "true"}>
      {children}
    </AppShell>
  );
}
