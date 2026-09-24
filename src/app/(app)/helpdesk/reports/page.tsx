import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { listCategories, listTeams, ticketCounts } from "@/services/helpdesk";
import {
  helpdeskBreakdowns,
  helpdeskSummary,
  helpdeskTimeReport,
  helpdeskTrend,
  parseRange,
} from "@/services/helpdesk-reports";
import { listOwners } from "@/services/companies";
import { companyOptions } from "@/services/lookups";
import { PageHeader, Card, Stat } from "@/components/ui/page";
import { Button, ButtonLink } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { param } from "@/lib/utils";
import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
} from "@/lib/validation-helpdesk";

export const metadata = { title: "Helpdesk reports" };

const mins = (n: number | null) =>
  n === null
    ? "—"
    : n >= 60 * 24
      ? `${(n / 1440).toFixed(1)}d`
      : n >= 60
        ? `${(n / 60).toFixed(1)}h`
        : `${Math.round(n)}m`;
const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
const hrs = (m: number) => `${(m / 60).toFixed(1)}h`;

export default async function HelpdeskReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requirePermission("helpdesk.read");
  const sp = await searchParams;
  const range = parseRange(param(sp, "from"), param(sp, "to"));
  const filters = {
    ...range,
    companyId: param(sp, "companyId") || null,
    assigneeUserId: param(sp, "assigneeUserId") || null,
    teamId: param(sp, "teamId") || null,
    categoryId: param(sp, "categoryId") || null,
    priority: param(sp, "priority") || null,
  };
  const [counts, summary, trend, breakdown, time, companies, agents, teams, categories] =
    await Promise.all([
      ticketCounts(me.id),
      helpdeskSummary(filters),
      helpdeskTrend(filters),
      helpdeskBreakdowns(filters),
      helpdeskTimeReport(range),
      companyOptions(),
      listOwners(),
      listTeams(),
      listCategories(),
    ]);
  const fromStr = range.from.toISOString().slice(0, 10);
  const toStr = new Date(range.to.getTime() - 1).toISOString().slice(0, 10);
  const qs = new URLSearchParams(
    Object.entries({
      from: fromStr,
      to: toStr,
      companyId: filters.companyId,
      assigneeUserId: filters.assigneeUserId,
      teamId: filters.teamId,
      categoryId: filters.categoryId,
      priority: filters.priority,
    }).filter((e): e is [string, string] => Boolean(e[1])),
  ).toString();
  const canExport = can(me.role, "helpdesk.manage");
  const table = (
    title: string,
    rows: { key: string; created: number; resolved: number; medianResolution: number | null; breached: number; minutes: number }[],
  ) => (
    <Card title={title} padded={false}>
      <table className="tbl">
        <thead>
          <tr>
            <th>{title.replace(/^By /, "")}</th>
            <th className="text-right">Created</th>
            <th className="text-right">Resolved</th>
            <th className="text-right">Median resolution</th>
            <th className="text-right">Breached</th>
            <th className="text-right">Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="py-4 text-center text-sm text-slate-500">
                Nothing in this period.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.key}</td>
              <td className="text-right tabular-nums">{r.created}</td>
              <td className="text-right tabular-nums">{r.resolved}</td>
              <td className="text-right tabular-nums">{mins(r.medianResolution)}</td>
              <td className={`text-right tabular-nums ${r.breached ? "text-red-700" : ""}`}>{r.breached}</td>
              <td className="text-right tabular-nums">{hrs(r.minutes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
  const max = Math.max(1, ...trend.map((t) => Math.max(t.created, t.resolved)));
  return (
    <>
      <PageHeader
        title="Helpdesk reports"
        description="Volumes, response and resolution times, SLA attainment, reopen rate, backlog age and time logged for the chosen period. Attainment counts tickets that had a target; response times are wall-clock from creation."
      />
      <form className="mb-4 grid gap-2 rounded-lg border border-slate-200 bg-surface p-3 sm:grid-cols-3 lg:grid-cols-7" aria-label="Report filters">
        <Field label="From" htmlFor="rp-from">
          <Input id="rp-from" name="from" type="date" defaultValue={fromStr} />
        </Field>
        <Field label="To" htmlFor="rp-to">
          <Input id="rp-to" name="to" type="date" defaultValue={toStr} />
        </Field>
        <Field label="Customer" htmlFor="rp-company">
          <Select id="rp-company" name="companyId" defaultValue={filters.companyId ?? ""}>
            <option value="">all</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Agent" htmlFor="rp-agent">
          <Select id="rp-agent" name="assigneeUserId" defaultValue={filters.assigneeUserId ?? ""}>
            <option value="">all</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Team" htmlFor="rp-team">
          <Select id="rp-team" name="teamId" defaultValue={filters.teamId ?? ""}>
            <option value="">all</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Category" htmlFor="rp-category">
          <Select id="rp-category" name="categoryId" defaultValue={filters.categoryId ?? ""}>
            <option value="">all</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority" htmlFor="rp-priority">
          <Select id="rp-priority" name="priority" defaultValue={filters.priority ?? ""}>
            <option value="">all</option>
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {TICKET_PRIORITY_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-end gap-2 sm:col-span-3 lg:col-span-7">
          <Button type="submit" size="sm">
            Apply
          </Button>
          {canExport && (
            <span className="ml-auto flex flex-wrap items-center gap-1 text-xs text-slate-500">
              Export CSV:
              {(["tickets", "sla", "time", "agents", "companies"] as const).map((k) => (
                <ButtonLink key={k} href={`/api/helpdesk/export/${k}?${qs}`} size="sm" variant="secondary">
                  {k}
                </ButtonLink>
              ))}
            </span>
          )}
        </div>
      </form>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="Created" value={summary.created} hint={`${summary.byEmail} by e-mail`} />
        <Stat label="Resolved" value={summary.resolved} tone="good" />
        <Stat label="Median first response" value={mins(summary.medianFirstResponseMinutes)} hint={`avg ${mins(summary.avgFirstResponseMinutes)}`} />
        <Stat label="Median resolution" value={mins(summary.medianResolutionMinutes)} hint={`avg ${mins(summary.avgResolutionMinutes)}`} />
        <Stat
          label="First response SLA"
          value={pct(summary.firstResponseAttainment)}
          hint={`${summary.firstResponseWithTarget} with a target`}
          tone={summary.firstResponseAttainment !== null && summary.firstResponseAttainment < 0.9 ? "warn" : "default"}
        />
        <Stat
          label="Resolution SLA"
          value={pct(summary.resolutionAttainment)}
          hint={`${summary.resolutionWithTarget} with a target`}
          tone={summary.resolutionAttainment !== null && summary.resolutionAttainment < 0.9 ? "warn" : "default"}
        />
        <Stat label="Reopened" value={pct(summary.reopenRate)} hint={`${summary.reopened} tickets`} tone={summary.reopened ? "warn" : "default"} />
        <Stat label="Time logged" value={hrs(summary.minutesLogged)} hint="on tickets resolved in period" />
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Open now" value={summary.backlog.open} hint={`${counts.unassigned} unassigned`} />
        <Stat label="Average age" value={summary.backlog.avgAgeHours === null ? "—" : mins(summary.backlog.avgAgeHours * 60)} />
        <Stat label="Oldest" value={summary.backlog.oldestHours === null ? "—" : mins(summary.backlog.oldestHours * 60)} />
        <Stat label="Older than 7 days" value={summary.backlog.over7d} tone={summary.backlog.over7d ? "warn" : "default"} />
        <Stat label="Breaching now" value={summary.backlog.breached} tone={summary.backlog.breached ? "danger" : "default"} />
      </div>
      <Card title="Created and resolved per day" className="mb-4">
        {trend.length > 62 ? (
          <p className="text-sm text-slate-500">Choose a period of up to two months to see the daily chart.</p>
        ) : (
          <div className="flex h-32 items-end gap-px" aria-label="Daily ticket volumes">
            {trend.map((t) => (
              <div key={t.day} className="flex min-w-0 flex-1 items-end gap-px" title={`${t.day}: ${t.created} created, ${t.resolved} resolved`}>
                <div className="flex-1 bg-brand-500" style={{ height: `${(t.created / max) * 100}%` }} />
                <div className="flex-1 bg-green-500" style={{ height: `${(t.resolved / max) * 100}%` }} />
              </div>
            ))}
          </div>
        )}
        <p className="mt-1 text-xs text-slate-500">
          <span className="inline-block h-2 w-2 bg-brand-500" /> created ·{" "}
          <span className="inline-block h-2 w-2 bg-green-500" /> resolved · {fromStr} to {toStr}
        </p>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        {table("By agent", breakdown.byAgent)}
        {table("By team", breakdown.byTeam)}
        {table("By category", breakdown.byCategory)}
        {table("By customer", breakdown.byCompany)}
        {table("By priority", breakdown.byPriority)}
        {table("By type", breakdown.byType.map((r) => ({ ...r, key: r.key.replace("_", " ") })))}
        <Card title="Time logged by agent" padded={false}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Agent</th>
                <th className="text-right">Entries</th>
                <th className="text-right">Billable</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {time.byAgent.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-sm text-slate-500">
                    No time logged in this period.
                  </td>
                </tr>
              )}
              {time.byAgent.map((r) => (
                <tr key={r.key}>
                  <td>{r.key}</td>
                  <td className="text-right tabular-nums">{r.entries}</td>
                  <td className="text-right tabular-nums">{hrs(r.billable ?? 0)}</td>
                  <td className="text-right tabular-nums">{hrs(r.minutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Time logged by customer" padded={false}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Customer</th>
                <th className="text-right">Entries</th>
                <th className="text-right">Billable</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {time.byCompany.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-sm text-slate-500">
                    No time logged in this period.
                  </td>
                </tr>
              )}
              {time.byCompany.map((r) => (
                <tr key={r.key}>
                  <td>{r.key}</td>
                  <td className="text-right tabular-nums">{r.entries}</td>
                  <td className="text-right tabular-nums">{hrs(r.billable ?? 0)}</td>
                  <td className="text-right tabular-nums">{hrs(r.minutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      <p className="mt-4 text-xs text-slate-500">
        Right now: {counts.open} open, {counts.awaitingCustomer} awaiting customer, {counts.review} needing review.
      </p>
    </>
  );
}
