import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { listNotifications } from "@/services/helpdesk-notifications";
import { PageHeader, Card } from "@/components/ui/page";
import { NotificationList } from "./list";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const me = await requirePermission("helpdesk.read");
  const [rows, settings] = await Promise.all([
    listNotifications(me.id, 100),
    getAppSettings(),
  ]);
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Mentions, assignments, customer replies on tickets you follow, SLA warnings and rule actions. In-app only: nothing here is e-mailed."
      />
      <Card padded={false}>
        <NotificationList
          rows={rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            title: r.title,
            body: r.body,
            ticketId: r.ticketId,
            actorName: r.actorName,
            readAt: r.readAt ? r.readAt.toISOString() : null,
            createdAt: r.createdAt.toISOString(),
          }))}
          settings={settings}
        />
      </Card>
    </>
  );
}
