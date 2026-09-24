import { requirePermission } from "@/lib/session";
import { ticketBreakdown, ticketCounts } from "@/services/helpdesk";
import { PageHeader, Card, Stat } from "@/components/ui/page";
import {
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  type TicketPriority,
  type TicketStatus,
} from "@/lib/validation-helpdesk";

export const metadata = { title: "Helpdesk reports" };

export default async function HelpdeskReportsPage() {
  const me = await requirePermission("helpdesk.read");
  const [counts, breakdown] = await Promise.all([
    ticketCounts(me.id),
    ticketBreakdown(),
  ]);
  const table = (
    title: string,
    rows: { key: string; n: number }[],
    labels?: Record<string, string>,
  ) => (
    <Card title={title} padded={false}>
      <table className="tbl">
        <thead>
          <tr>
            <th>{title.replace(/^Open by |^By /, "")}</th>
            <th className="text-right">Tickets</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={2}
                className="py-4 text-center text-sm text-slate-500"
              >
                Nothing yet.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{labels?.[r.key] ?? r.key}</td>
              <td className="text-right tabular-nums">{r.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
  return (
    <>
      <PageHeader
        title="Helpdesk reports"
        description="Volumes and workload now. Response and resolution times, SLA attainment, backlog age and CSV export arrive with the SLA stage."
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Open" value={counts.open} />
        <Stat
          label="Unassigned"
          value={counts.unassigned}
          tone={counts.unassigned ? "warn" : "default"}
        />
        <Stat
          label="Overdue"
          value={counts.overdue}
          tone={counts.overdue ? "danger" : "default"}
        />
        <Stat label="Created today" value={counts.createdToday} />
        <Stat label="Resolved today" value={counts.resolvedToday} tone="good" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {table(
          "By status",
          breakdown.byStatus.map((r) => ({ key: r.key, n: Number(r.n) })),
          TICKET_STATUS_LABELS as Record<TicketStatus, string>,
        )}
        {table(
          "Open by priority",
          breakdown.byPriority.map((r) => ({ key: r.key, n: Number(r.n) })),
          TICKET_PRIORITY_LABELS as Record<TicketPriority, string>,
        )}
        {table(
          "Open by agent",
          breakdown.byAssignee.map((r) => ({ key: r.key, n: Number(r.n) })),
        )}
        {table(
          "Open by team",
          breakdown.byTeam.map((r) => ({ key: r.key, n: Number(r.n) })),
        )}
        {table(
          "Open by category",
          breakdown.byCategory.map((r) => ({ key: r.key, n: Number(r.n) })),
        )}
        {table(
          "Open by customer",
          breakdown.byCompany.map((r) => ({ key: r.key, n: Number(r.n) })),
        )}
      </div>
    </>
  );
}
