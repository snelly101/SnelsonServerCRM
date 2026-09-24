import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { ticketCounts } from "@/services/helpdesk";
import { HelpdeskNav } from "./nav";

export default async function HelpdeskLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await requirePermission("helpdesk.read");
  const counts = await ticketCounts(me.id);
  const items = [
    { href: "/helpdesk", label: "Dashboard", exact: true },
    { href: "/helpdesk/tickets", label: "Tickets", count: counts.open },
    ...(can(me.role, "helpdesk.agent")
      ? [{ href: "/helpdesk/tickets/new", label: "New ticket" }]
      : []),
    { href: "/helpdesk/reports", label: "Reports" },
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
