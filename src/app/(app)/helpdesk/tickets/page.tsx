import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import {
  listCategories,
  listTeams,
  listTickets,
  myTeamIds,
  ticketCounts,
} from "@/services/helpdesk";
import { listOwners } from "@/services/companies";
import { companyOptions } from "@/services/lookups";
import { listSavedViews } from "@/services/settings";
import { PageHeader, Card } from "@/components/ui/page";
import { ButtonLink } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { FilterBar } from "@/components/ui/filter-bar";
import { TicketTable } from "@/components/helpdesk/ticket-table";
import { param, toInt } from "@/lib/utils";
import { cn } from "@/lib/utils";
import {
  DEFAULT_TICKET_COLUMNS,
  TICKET_COLUMNS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  TICKET_TYPES,
  TICKET_TYPE_LABELS,
  TICKET_VIEWS,
  TICKET_VIEW_LABELS,
  type TicketColumn,
  type TicketView,
} from "@/lib/validation-helpdesk";

export const metadata = { title: "Tickets" };

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requirePermission("helpdesk.read");
  const sp = await searchParams;
  const view = (TICKET_VIEWS as readonly string[]).includes(
    param(sp, "view") ?? "",
  )
    ? (param(sp, "view") as TicketView)
    : "open";
  const teamIds = await myTeamIds(me.id);
  const assigneeParam = param(sp, "assignee");
  const [data, counts, agents, teams, categories, companies, views] =
    await Promise.all([
      listTickets({
        view,
        q: param(sp, "q"),
        status: param(sp, "status"),
        priority: param(sp, "priority"),
        type: param(sp, "type"),
        assigneeUserId: assigneeParam === "me" ? me.id : assigneeParam,
        teamId: param(sp, "team"),
        categoryId: param(sp, "category"),
        companyId: param(sp, "company"),
        tag: param(sp, "tag"),
        sort: param(sp, "sort"),
        dir: param(sp, "dir") as "asc" | "desc" | undefined,
        page: toInt(param(sp, "page"), 1),
        me: { id: me.id, teamIds },
      }),
      ticketCounts(me.id),
      listOwners(),
      listTeams(),
      listCategories(),
      companyOptions(),
      listSavedViews(me.id, "helpdesk"),
    ]);
  const cols = (param(sp, "cols") ?? "")
    .split(",")
    .filter((c): c is TicketColumn =>
      (TICKET_COLUMNS as readonly string[]).includes(c),
    );
  const columns = cols.length ? cols : DEFAULT_TICKET_COLUMNS;
  const viewCounts: Partial<Record<TicketView, number>> = {
    my: counts.mine,
    unassigned: counts.unassigned,
    open: counts.open,
    awaiting_customer: counts.awaitingCustomer,
    awaiting_third_party: counts.awaitingThirdParty,
    overdue: counts.overdue,
    review: counts.review,
  };
  const keep = new URLSearchParams();
  for (const k of ["cols", "q"]) if (param(sp, k)) keep.set(k, param(sp, k)!);
  return (
    <>
      <PageHeader
        title="Tickets"
        description="Queues, filters and bulk actions. Every filter is in the address bar, so a view can be bookmarked or saved."
        actions={
          can(me.role, "helpdesk.agent") ? (
            <ButtonLink href="/helpdesk/tickets/new">New ticket</ButtonLink>
          ) : undefined
        }
      />
      <div
        className="mb-3 flex flex-wrap gap-1"
        role="tablist"
        aria-label="Ticket views"
      >
        {TICKET_VIEWS.filter((v) => v !== "review" || counts.review > 0).map(
          (v) => (
            <Link
              key={v}
              role="tab"
              aria-selected={view === v}
              href={`/helpdesk/tickets?view=${v}${keep.toString() ? `&${keep}` : ""}`}
              className={cn(
                "rounded-full px-3 py-1 text-sm",
                view === v
                  ? "bg-fg text-surface"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200",
              )}
            >
              {TICKET_VIEW_LABELS[v]}
              {typeof viewCounts[v] === "number" && (
                <span className="ml-1 text-xs opacity-70">{viewCounts[v]}</span>
              )}
            </Link>
          ),
        )}
      </div>
      <FilterBar
        page="helpdesk"
        placeholder="Search subject, requester, company, reference or message text…"
        filters={[
          {
            key: "status",
            label: "Status",
            options: TICKET_STATUSES.map((s) => ({
              value: s,
              label: TICKET_STATUS_LABELS[s],
            })),
          },
          {
            key: "priority",
            label: "Priority",
            options: TICKET_PRIORITIES.map((p) => ({
              value: p,
              label: TICKET_PRIORITY_LABELS[p],
            })),
          },
          {
            key: "type",
            label: "Type",
            options: TICKET_TYPES.map((t) => ({
              value: t,
              label: TICKET_TYPE_LABELS[t],
            })),
          },
          {
            key: "assignee",
            label: "Assignee",
            options: [
              { value: "me", label: "Me" },
              { value: "unassigned", label: "Unassigned" },
              ...agents.map((a) => ({ value: a.id, label: a.name })),
            ],
          },
          {
            key: "team",
            label: "Team",
            options: teams.map((t) => ({ value: t.id, label: t.name })),
          },
          {
            key: "category",
            label: "Category",
            options: categories.flatMap((c) => [
              { value: c.id, label: c.name },
              ...c.children.map((s) => ({
                value: s.id,
                label: `${c.name} › ${s.name}`,
              })),
            ]),
          },
          {
            key: "company",
            label: "Company",
            options: companies.map((c) => ({ value: c.id, label: c.name })),
          },
        ]}
        savedViews={views.map((v) => ({
          id: v.id,
          name: v.name,
          params: v.params as Record<string, string>,
          userId: v.userId,
          isShared: v.isShared,
        }))}
        currentUserId={me.id}
      />
      <Card padded={false}>
        <TicketTable
          rows={data.rows}
          canManage={can(me.role, "helpdesk.manage")}
          columns={columns}
          agents={agents}
          teams={teams.map((t) => ({ id: t.id, name: t.name }))}
        />
        <Pagination
          page={data.page}
          pageCount={data.pageCount}
          total={data.total}
          pageSize={data.pageSize}
        />
      </Card>
    </>
  );
}
