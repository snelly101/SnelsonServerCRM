import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/ui/page";

/** The settings section pills are rendered by the app shell (see components/nav-config.ts). */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requirePermission("settings.read");
  return (
    <>
      <PageHeader title="Settings" />
      <div className="min-w-0">{children}</div>
    </>
  );
}
