import Link from "next/link";
import { Plus, LayoutGrid, List } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { boardData, listOpportunities, listStages, pipelineTotals } from "@/services/opportunities";
import { listOwners } from "@/services/companies";
import { listSavedViews } from "@/services/settings";
import { getAppSettings } from "@/lib/settings";
import { PageHeader, Card, EmptyState, Stat } from "@/components/ui/page";
import { ButtonLink, buttonClass } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pagination, SortLink } from "@/components/ui/pagination";
import { FilterBar } from "@/components/ui/filter-bar";
import { Board } from "./board";
import { fmtDate, fmtMoney } from "@/lib/format";
import { param, toInt } from "@/lib/utils";

export const metadata = { title: "Sales Pipeline" };

export default async function PipelinePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("opportunity.read");
  const sp = await searchParams;
  const view = param(sp, "view") === "table" ? "table" : "board";
  const [owners, stages, views, settings, totals] = await Promise.all([listOwners(), listStages(), listSavedViews(me.id, "pipeline"), getAppSettings(), pipelineTotals()]);
  const canWrite = can(me.role, "opportunity.write");
  const toggle = (v: "board" | "table") => {
    const next = new URLSearchParams();
    for (const [k, val] of Object.entries(sp)) if (typeof val === "string" && k !== "view") next.set(k, val);
    next.set("view", v);
    return `/pipeline?${next.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Sales Pipeline"
        description="Open opportunities by stage. Drag cards between stages; values are first-year totals."
        actions={
          <>
            <div className="inline-flex rounded-md border border-slate-300 bg-surface p-0.5">
              <Link href={toggle("board")} className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-sm ${view === "board" ? "bg-fg text-surface" : "text-slate-600"}`} aria-current={view === "board" ? "page" : undefined}>
                <LayoutGrid className="h-4 w-4" /> Board
              </Link>
              <Link href={toggle("table")} className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-sm ${view === "table" ? "bg-fg text-surface" : "text-slate-600"}`} aria-current={view === "table" ? "page" : undefined}>
                <List className="h-4 w-4" /> Table
              </Link>
            </div>
            {canWrite && (
              <ButtonLink href="/pipeline/new">
                <Plus className="h-4 w-4" /> New opportunity
              </ButtonLink>
            )}
          </>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open opportunities" value={totals.count} hint={totals.overdueClose ? `${totals.overdueClose} past expected close` : undefined} tone={totals.overdueClose ? "warn" : "default"} />
        <Stat label="Pipeline value (first year)" value={fmtMoney(totals.total, settings.currency)} />
        <Stat label="Weighted forecast" value={fmtMoney(totals.weighted, settings.currency)} hint="value × probability" />
        <Stat label="Potential MRR" value={fmtMoney(totals.mrr, settings.currency)} hint="recurring lines only" />
      </div>
      <FilterBar
        page="pipeline"
        currentUserId={me.id}
        savedViews={views}
        placeholder="Search title or company…"
        filters={[
          { key: "owner", label: "Owner", options: owners.map((o) => ({ value: o.id, label: o.name })) },
          ...(view === "table"
            ? [
                { key: "status", label: "Status", options: [{ value: "open", label: "Open" }, { value: "won", label: "Won" }, { value: "lost", label: "Lost" }, { value: "all", label: "All" }] },
                { key: "stage", label: "Stage", options: stages.map((s) => ({ value: s.id, label: s.name })) },
              ]
            : []),
        ]}
      />
      {view === "board" ? (
        <BoardView ownerUserId={param(sp, "owner")} q={param(sp, "q")} canWrite={canWrite} currency={settings.currency} />
      ) : (
        <TableView sp={sp} currency={settings.currency} settings={settings} />
      )}
    </>
  );
}

async function BoardView({ ownerUserId, q, canWrite, currency }: { ownerUserId?: string; q?: string; canWrite: boolean; currency: string }) {
  const columns = await boardData({ ownerUserId, q });
  const empty = columns.every((c) => c.items.length === 0);
  if (empty) {
    return <EmptyState title="No open opportunities" description="Create one from a company page or with the button above." action={canWrite ? <Link href="/pipeline/new" className={buttonClass()}>New opportunity</Link> : undefined} />;
  }
  return <Board columns={columns} canWrite={canWrite} currency={currency} />;
}

async function TableView({ sp, currency, settings }: { sp: Record<string, string | string[] | undefined>; currency: string; settings: { dateFormat: string; timezone: string; currency: string } }) {
  const data = await listOpportunities({
    q: param(sp, "q"),
    status: param(sp, "status") ?? "open",
    stageId: param(sp, "stage"),
    ownerUserId: param(sp, "owner"),
    sort: param(sp, "sort"),
    dir: param(sp, "dir") === "asc" ? "asc" : "desc",
    page: toInt(param(sp, "page"), 1),
  });
  if (data.total === 0) return <EmptyState title="No opportunities match" />;
  return (
    <Card padded={false}>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>
                <SortLink column="title" label="Opportunity" />
              </th>
              <th>
                <SortLink column="company" label="Company" />
              </th>
              <th>
                <SortLink column="stage" label="Stage" />
              </th>
              <th>Owner</th>
              <th className="text-right">First-year value</th>
              <th className="text-right">MRR</th>
              <th className="text-right">
                <SortLink column="probability" label="Prob." />
              </th>
              <th className="text-right">Weighted</th>
              <th>
                <SortLink column="closeDate" label="Expected close" />
              </th>
              <th>Next action</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((o) => (
              <tr key={o.id}>
                <td>
                  <Link href={`/pipeline/${o.id}`} className="font-medium text-brand-700 hover:underline">
                    {o.title}
                  </Link>
                  {o.status !== "open" && <Badge className="ml-1" tone={o.status === "won" ? "green" : "red"}>{o.status}</Badge>}
                </td>
                <td>
                  <Link href={`/companies/${o.companyId}`} className="hover:underline">
                    {o.companyName}
                  </Link>
                </td>
                <td>
                  <Badge tone={o.stageColor}>{o.stageName}</Badge>
                </td>
                <td>{o.ownerName ?? "—"}</td>
                <td className="text-right tabular-nums">{fmtMoney(o.summary.firstYearValue, currency)}</td>
                <td className="text-right tabular-nums">{fmtMoney(o.summary.mrr, currency)}</td>
                <td className="text-right tabular-nums">{o.probability}%</td>
                <td className="text-right tabular-nums">{fmtMoney(o.weightedValue, currency)}</td>
                <td className={o.expectedCloseDate && o.status === "open" && o.expectedCloseDate < new Date().toISOString().slice(0, 10) ? "text-red-600" : ""}>{fmtDate(o.expectedCloseDate, settings)}</td>
                <td className="max-w-[200px] truncate text-slate-600">
                  {o.nextAction ?? "—"}
                  {o.overdueTasks > 0 && <Badge tone="red" className="ml-1">{o.overdueTasks} overdue</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={data.page} pageCount={data.pageCount} total={data.total} pageSize={data.pageSize} />
    </Card>
  );
}
