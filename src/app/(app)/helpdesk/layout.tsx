import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { ticketCounts } from "@/services/helpdesk";
import { unreadCount } from "@/services/helpdesk-notifications";
import { HelpdeskNav } from "./nav";

export default async function HelpdeskLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await requirePermission("helpdesk.read");
  const [counts, unread] = await Promise.all([
    ticketCounts(me.id),
    unreadCount(me.id),
  ]);
  const items = [
    { href: "/helpdesk", label: "Dashboard", exact: true },
    { href: "/helpdesk/tickets", label: "Tickets", count: counts.open },
    ...(can(me.role, "helpdesk.agent")
      ? [{ href: "/helpdesk/tickets/new", label: "New ticket" }]
      : []),
    { href: "/helpdesk/reports", label: "Reports" },
    { href: "/helpdesk/notifications", label: "Notifications", count: unread },
    ...(can(me.role, "helpdesk.admin")
      ? [{ href: "/helpdesk/admin", label: "Administration" }]
      : []),
  ];
  return (
    <>
      <HelpdeskNav items={items} />
      {children}
    </>
  );
}
