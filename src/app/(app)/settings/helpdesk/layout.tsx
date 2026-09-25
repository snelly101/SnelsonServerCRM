import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { HelpdeskNav } from "@/app/(app)/helpdesk/nav";

/** Helpdesk configuration lives under Settings; the tabs are filtered by what the role may manage. */
export default async function HelpdeskSettingsLayout({ children }: { children: React.ReactNode }) {
  const me = await requirePermission("helpdesk.manage");
  const admin = can(me.role, "helpdesk.admin");
  const items = [
    ...(admin ? [{ href: "/settings/helpdesk", label: "Teams & categories", exact: true }] : []),
    ...(admin ? [{ href: "/settings/helpdesk/mailbox", label: "Support mailbox" }] : []),
    ...(admin ? [{ href: "/settings/helpdesk/sla", label: "SLA policies" }] : []),
    ...(admin ? [{ href: "/settings/helpdesk/automation", label: "Automation rules" }] : []),
    { href: "/settings/helpdesk/templates", label: "Templates" },
    ...(admin ? [{ href: "/settings/helpdesk/operations", label: "Operations" }] : []),
  ];
  return (
    <>
      <HelpdeskNav items={items} />
      {children}
    </>
  );
}
