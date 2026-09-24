import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import {
  listTickets,
  myTeamIds,
  ticketBreakdown,
  ticketCounts,
} from "@/services/helpdesk";
import { helpdeskSummary, parseRange } from "@/services/helpdesk-reports";
import { PageHeader, Card, Stat, EmptyState } from "@/components/ui/page";
import { ButtonLink } from "@/components/ui/button";
import {
  StatusBadge,
  PriorityBadge,
  dueLabel,
} from "@/components/helpdesk/badges";
import { Badge } from "@/components/ui/badge";
import { fmtRelative } from "@/lib/format";
import {
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  type TicketPriority,
  type TicketStatus,
} from "@/lib/validation-helpdesk";

export const metadata = { title: "Helpdesk" };

export default async function HelpdeskDashboard() {
  const me = await requirePermission("helpdesk.read");
  const teamIds = await myTeamIds(me.id);
  const week = parseRange(
    new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10),
    null,
  );
  const [counts, breakdown, mine, unassigned, recent, sla] = await Promise.all([
    ticketCounts(me.id),
    ticketBreakdown(),
    listTickets({
      view: "my",
      me: { id: me.id, teamIds },
      pageSize: 8,
      sort: "priority",
    }),
    listTickets({
      view: "unassigned",
      pageSize: 8,
      sort: "created",
      dir: "asc",
    }),
    listTickets({ view: "recent", pageSize: 8 }),
    helpdeskSummary(week),
  ]);
  const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
  const bar = (
    rows: { key: string; n: number }[],
    labels?: Record<string, string>,
  ) => {
    const max = Math.max(1, ...rows.map((r) => r.n));
    return (
      <ul className="space-y-1.5 text-sm">
        {rows.length === 0 && <li className="text-slate-400">Nothing yet.</li>}
        {rows.map((r) => (
          <li
            key={r.key}
            className="grid grid-cols-[minmax(0,1fr)_2fr_2.5rem] items-center gap-2"
          >
            <span className="truncate text-slate-700">
              {labels?.[r.key] ?? r.key}
            </span>
            <span className="h-2 overflow-hidden rounded bg-slate-100">
              <span
                className="block h-full bg-brand-500"
                style={{ width: `${(r.n / max) * 100}%` }}
              />
            </span>
            <span className="text-right tabular-nums text-slate-600">
              {r.n}
            </span>
          </li>
        ))}
      </ul>
    );
  };
  const list = (
    rows: Awaited<ReturnType<typeof listTickets>>["rows"],
    empty: string,
  ) =>
    rows.length === 0 ? (
      <p className="p-4 text-sm text-slate-500">{empty}</p>
    ) : (
      <ul className="divide-y divide-slate-100">
        {rows.map((t) => {
          const due = dueLabel(
            t.firstResponseAt ? t.resolutionDueAt : t.firstResponseDueAt,
            false,
          );
          return (
            <li key={t.id} className="px-4 py-2 text-sm">
              <div className="flex items-center gap-2">
                <Link
                  href={`/helpdesk/tickets/${t.id}`}
                  className="shrink-0 font-mono text-xs text-slate-500 hover:underline"
                >
                  {t.reference}
                </Link>
                <Link
                  href={`/helpdesk/tickets/${t.id}`}
                  className="min-w-0 flex-1 truncate font-medium text-slate-800 hover:text-brand-700"
                >
                  {t.subject}
                </Link>
                <span className="shrink-0 text-xs text-slate-500">
                  {fmtRelative(t.lastActivityAt)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-slate-500">
                <span className="truncate">
                  {t.companyName ?? t.requesterName ?? t.requesterEmail}
                </span>
                <PriorityBadge priority={t.priority} />
                <StatusBadge status={t.status} />
                {due && <Badge tone={due.tone}>{due.text}</Badge>}
              </div>
            </li>
          );
        })}
      </ul>
    );
  return (
    <>
      <PageHeader
        title="Helpdesk"
        description="Tickets from e-mail and the team, who is working on what, and what is due."
        actions={
          can(me.role, "helpdesk.agent") ? (
            <ButtonLink href="/helpdesk/tickets/new">New ticket</ButtonLink>
          ) : undefined
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Stat
          label="Open"
          value={counts.open}
          hint={`${counts.newCount} new`}
        />
        <Stat
          label="Unassigned"
          value={counts.unassigned}
          tone={counts.unassigned ? "warn" : "default"}
        />
        <Stat label="Mine" value={counts.mine} />
        <Stat
          label="Overdue"
          value={counts.overdue}
          tone={counts.overdue ? "danger" : "default"}
          hint={counts.dueSoon ? `${counts.dueSoon} due within 4h` : undefined}
        />
        <Stat
          label="Awaiting customer"
          value={counts.awaitingCustomer}
          hint={
            counts.awaitingThirdParty
              ? `${counts.awaitingThirdParty} awaiting third party`
              : undefined
          }
        />
        <Stat
          label="Today"
          value={`${counts.createdToday} / ${counts.resolvedToday}`}
          hint="created / resolved"
        />
        <Stat
          label="First response SLA"
          value={pct(sla.firstResponseAttainment)}
          hint="last 7 days"
          tone={
            sla.firstResponseAttainment !== null &&
            sla.firstResponseAttainment < 0.9
              ? "warn"
              : "default"
          }
        />
        <Stat
          label="Resolution SLA"
          value={pct(sla.resolutionAttainment)}
          hint={`last 7 days · ${sla.backlog.breached} breaching now`}
          tone={sla.backlog.breached ? "danger" : "default"}
        />
      </div>
      {counts.review > 0 && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <strong>{counts.review}</strong> ticket
          {counts.review === 1 ? "" : "s"} need{counts.review === 1 ? "s" : ""}{" "}
          review (unknown sender or an e-mail that could not be matched safely).{" "}
          <Link href="/helpdesk/tickets?view=review" className="underline">
            Open the review queue
          </Link>
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card
          title="My tickets"
          padded={false}
          actions={
            <Link
              href="/helpdesk/tickets?view=my"
              className="text-xs text-brand-700 hover:underline"
            >
              all
            </Link>
          }
        >
          {list(mine.rows, "Nothing assigned to you or your teams.")}
        </Card>
        <Card
          title="Unassigned"
          padded={false}
          actions={
            <Link
              href="/helpdesk/tickets?view=unassigned"
              className="text-xs text-brand-700 hover:underline"
            >
              all
            </Link>
          }
        >
          {list(unassigned.rows, "Every open ticket has an owner.")}
        </Card>
        <Card
          title="Recently updated"
          padded={false}
          actions={
            <Link
              href="/helpdesk/tickets?view=recent"
              className="text-xs text-brand-700 hover:underline"
            >
              all
            </Link>
          }
        >
          {list(recent.rows, "No activity in the last 7 days.")}
        </Card>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card title="By status">
          {bar(
            breakdown.byStatus.map((r) => ({ key: r.key, n: Number(r.n) })),
            TICKET_STATUS_LABELS as Record<TicketStatus, string>,
          )}
        </Card>
        <Card title="Open by priority">
          {bar(
            breakdown.byPriority.map((r) => ({ key: r.key, n: Number(r.n) })),
            TICKET_PRIORITY_LABELS as Record<TicketPriority, string>,
          )}
        </Card>
        <Card title="Open by agent">
          {bar(
            breakdown.byAssignee.map((r) => ({ key: r.key, n: Number(r.n) })),
          )}
        </Card>
        <Card title="Open by customer">
          {breakdown.byCompany.length ? (
            bar(
              breakdown.byCompany.map((r) => ({ key: r.key, n: Number(r.n) })),
            )
          ) : (
            <EmptyState title="No open tickets" />
          )}
        </Card>
      </div>
    </>
  );
}
