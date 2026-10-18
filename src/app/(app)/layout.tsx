import { currentTwoFactorPolicy, requireUser } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { can } from "@/lib/permissions";
import { AppShell } from "@/components/app-shell";
import { unreadCount } from "@/services/helpdesk-notifications";
import { ticketCounts } from "@/services/helpdesk";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // The layout must render for users who still have to enrol in two-factor authentication;
  // individual pages redirect them to /account/security.
  const [user, settings, policy] = await Promise.all([requireUser({ allowUnenrolled: true }), getAppSettings(), currentTwoFactorPolicy()]);
  const [unread, tickets] = await Promise.all([
    unreadCount(user.id).catch(() => 0),
    can(user.role, "helpdesk.read") ? ticketCounts(user.id).catch(() => null) : Promise.resolve(null),
  ]);
  return (
    <AppShell
      user={user}
      companyName={settings.companyName}
      demoMode={process.env.DEMO_MODE === "true"}
      twoFactorDueBy={policy?.dueBy ?? null}
      unreadNotifications={unread}
      counts={{ helpdeskOpen: tickets?.open }}
    >
      {children}
    </AppShell>
  );
}
