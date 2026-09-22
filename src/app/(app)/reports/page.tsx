import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { devicesReport, forecastByMonth, FORECAST_FORMULA, integrationHealthReport, mrrReport, outstandingInvoicesReport, overdueTasksReport, pipelineByStage, renewalsReport } from "@/services/reports";
import { PageHeader, Card, Stat } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { ExportLink } from "@/components/ui/export-link";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { fmtDate, fmtMoney, fmtPercent, fmtRelative } from "@/lib/format";

export const metadata = { title: "Reports" };

function Estimate({ children = "estimate" }: { children?: string }) {
  return <Badge tone="amber">{children}</Badge>;
}

function Bar({ value, max, tone = "bg-brand-500" }: { value: number; max: number; tone?: string }) {
  const w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-2 w-full rounded bg-slate-100">
      <div className={`h-2 rounded ${tone}`} style={{ width: `${w}%` }} />
    </div>
  );
}

const FRESH_TONE: Record<string, string> = { live: "green", cached: "blue", stale: "amber", unavailable: "slate" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const me = await requirePermission("report.read");
  const sp = await searchParams;
  const finance = can(me.role, "report.finance.read");
  const [settings, pipeline, forecast, mrr, renewals, tasksRep, invoices, devices, health] = await Promise.all([
    getAppSettings(),
    pipelineByStage(),
    forecastByMonth(6),
    mrrReport(),
    renewalsReport(),
    overdueTasksReport(),
    finance ? outstandingInvoicesReport() : Promise.resolve(null),
    devicesReport(),
    integrationHealthReport(),
  ]);
  const c = settings.currency;
  const maxStage = Math.max(...pipeline.stages.map((s) => s.value), 1);
  const maxMonth = Math.max(...forecast.months.map((m) => m.weighted), forecast.overdue.weighted, 1);
  const monthLabel = (m: string) => (m.match(/^\d{4}-\d{2}$/) ? new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) : m);

  return (
    <>
      <PageHeader title="Reports" description="Every figure states its basis. Amber badges mark estimates and mirrored data carries a freshness label." />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="MRR" value={fmtMoney(mrr.mrr, c)} hint={`${mrr.activeContracts} active contracts · ARR ${fmtMoney(mrr.arr, c)}`} tone="good" />
        <Stat label="Weighted pipeline" value={fmtMoney(pipeline.totals.weighted, c)} hint={<span>{pipeline.totals.count} open · unweighted {fmtMoney(pipeline.totals.value, c)} <Estimate /></span>} />
        <Stat label="Renewals in 90 days" value={renewals.buckets.d30.count + renewals.buckets.d60.count + renewals.buckets.d90.count} hint={`${fmtMoney(renewals.buckets.d30.mrr + renewals.buckets.d60.mrr + renewals.buckets.d90.mrr, c)} MRR at stake · ${renewals.buckets.overdue.count} past renewal date`} tone={renewals.buckets.overdue.count ? "warn" : "default"} />
        <Stat label="Overdue tasks" value={tasksRep.totals.overdue} hint={`${tasksRep.totals.dueToday} due today · ${tasksRep.totals.open} open`} tone={tasksRep.totals.overdue ? "danger" : "default"} />
      </div>

      <Tabs defaultValue={sp.tab ?? "pipeline"}>
        <TabsList>
          <TabsTrigger value="pipeline">Pipeline & forecast</TabsTrigger>
          <TabsTrigger value="mrr">Recurring revenue</TabsTrigger>
          <TabsTrigger value="renewals" count={renewals.rows.length}>
            Renewals
          </TabsTrigger>
          <TabsTrigger value="tasks" count={tasksRep.totals.overdue}>
            Overdue tasks
          </TabsTrigger>
          {finance && (
            <TabsTrigger value="invoices" count={invoices?.overdueCount}>
              Outstanding invoices
            </TabsTrigger>
          )}
          <TabsTrigger value="devices">Devices</TabsTrigger>
          <TabsTrigger value="health" count={health.openConflicts + health.providers.reduce((a, p) => a + p.failed24h, 0)}>
            Integration health
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pipeline">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Open pipeline by stage" padded={false} actions={<ExportLink href="/api/export/report-pipeline" />}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th className="text-right">Open</th>
                    <th className="w-1/3">First-year value</th>
                    <th className="text-right">Weighted</th>
                    <th className="text-right">MRR</th>
                  </tr>
                </thead>
                <tbody>
                  {pipeline.stages.map((s) => (
                    <tr key={s.stageId}>
                      <td>
                        <Badge tone={s.color}>{s.stage}</Badge> <span className="text-xs text-slate-500">{s.probability}%</span>
                        {s.overdueClose > 0 && <div className="text-[11px] text-amber-700">{s.overdueClose} past expected close</div>}
                      </td>
                      <td className="text-right tabular-nums">{s.count}</td>
                      <td>
                        <div className="text-xs tabular-nums">{fmtMoney(s.value, c)}</div>
                        <Bar value={s.value} max={maxStage} />
                      </td>
                      <td className="text-right tabular-nums">{fmtMoney(s.weighted, c)}</td>
                      <td className="text-right tabular-nums">{fmtMoney(s.mrr, c)}</td>
                    </tr>
                  ))}
                  <tr className="font-medium">
                    <td>Total</td>
                    <td className="text-right tabular-nums">{pipeline.totals.count}</td>
                    <td className="tabular-nums text-xs">{fmtMoney(pipeline.totals.value, c)}</td>
                    <td className="text-right tabular-nums">{fmtMoney(pipeline.totals.weighted, c)}</td>
                    <td className="text-right tabular-nums">{fmtMoney(pipeline.totals.mrr, c)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">First-year value = ARR + one-off + hardware. Weighted = value × each opportunity&apos;s own probability (defaults from its stage).</p>
            </Card>
            <Card title={<span className="flex items-center gap-2">Weighted forecast, next 6 months <Estimate /></span>} padded={false} actions={<ExportLink href="/api/export/report-forecast" />}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Expected close</th>
                    <th className="text-right">Open</th>
                    <th className="w-1/3">Weighted</th>
                    <th className="text-right">Unweighted</th>
                    <th className="text-right">MRR if won</th>
                  </tr>
                </thead>
                <tbody>
                  {[forecast.overdue, ...forecast.months, forecast.later, forecast.unscheduled]
                    .filter((b) => b.count > 0 || b.month.match(/^\d{4}/))
                    .map((b) => (
                      <tr key={b.month} className={b.month === "overdue" ? "text-amber-800" : ""}>
                        <td>{b.month === "overdue" ? "Past expected close" : b.month === "later" ? "Beyond 6 months" : b.month === "unscheduled" ? "No close date" : monthLabel(b.month)}</td>
                        <td className="text-right tabular-nums">{b.count}</td>
                        <td>
                          <div className="text-xs tabular-nums">{fmtMoney(b.weighted, c)}</div>
                          <Bar value={b.weighted} max={maxMonth} tone={b.month === "overdue" ? "bg-amber-400" : "bg-brand-500"} />
                        </td>
                        <td className="text-right tabular-nums">{fmtMoney(b.value, c)}</td>
                        <td className="text-right tabular-nums">{fmtMoney(b.mrr, c)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">{FORECAST_FORMULA}</p>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="mrr">
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="MRR" value={fmtMoney(mrr.mrr, c)} tone="good" hint={`${mrr.customers} paying customers`} />
            <Stat label="ARR" value={fmtMoney(mrr.arr, c)} hint="MRR × 12" />
            <Stat label="Gross margin on MRR" value={mrr.grossMarginPercent === null ? "—" : fmtPercent(mrr.grossMarginPercent)} hint={mrr.marginIsEstimate ? <span>some lines have no cost <Estimate /></span> : "all lines costed"} />
            <Stat label="Largest customer" value={mrr.concentration ? fmtPercent(mrr.concentration.share) : "—"} hint={mrr.concentration ? `${mrr.concentration.companyName} share of MRR` : undefined} tone={mrr.concentration && mrr.concentration.share > 30 ? "warn" : "default"} />
          </div>
          <Alert tone="info" className="mb-4">
            {mrr.formula}
          </Alert>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="MRR by customer" padded={false} className="lg:col-span-2" actions={<ExportLink href="/api/export/report-mrr" />}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th className="text-right">Contracts</th>
                    <th className="text-right">MRR</th>
                    <th className="text-right">Share</th>
                    <th className="text-right">Margin</th>
                    <th className="text-right">One-off + hardware</th>
                  </tr>
                </thead>
                <tbody>
                  {mrr.byCompany.map((r) => (
                    <tr key={r.companyId}>
                      <td>
                        <Link href={`/companies/${r.companyId}`} className="font-medium text-brand-700 hover:underline">
                          {r.companyName}
                        </Link>
                      </td>
                      <td className="text-right tabular-nums">{r.contracts}</td>
                      <td className="text-right tabular-nums">{fmtMoney(r.mrr, c)}</td>
                      <td className="text-right tabular-nums">{fmtPercent(r.share)}</td>
                      <td className="text-right tabular-nums">
                        {r.marginPercent === null ? <span className="text-slate-400">—</span> : fmtPercent(r.marginPercent)}
                        {r.marginIsEstimate && r.marginPercent !== null && <Estimate>partial</Estimate>}
                      </td>
                      <td className="text-right tabular-nums">{fmtMoney(r.oneOff + r.hardware, c)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="MRR by service category" padded={false}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th className="text-right">Lines</th>
                    <th className="text-right">MRR</th>
                  </tr>
                </thead>
                <tbody>
                  {mrr.byCategory.map((k) => (
                    <tr key={k.category}>
                      <td>{k.label}</td>
                      <td className="text-right tabular-nums">{k.lines}</td>
                      <td className="text-right tabular-nums">{fmtMoney(k.mrr, c)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">Lines without a catalogue product count as “Other”. One-off and hardware in active contracts: {fmtMoney(mrr.oneOff + mrr.hardware, c)}.</p>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="renewals">
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Past renewal date" value={renewals.buckets.overdue.count} hint={fmtMoney(renewals.buckets.overdue.mrr, c) + " MRR"} tone={renewals.buckets.overdue.count ? "danger" : "default"} />
            <Stat label="Next 30 days" value={renewals.buckets.d30.count} hint={fmtMoney(renewals.buckets.d30.mrr, c) + " MRR"} tone={renewals.buckets.d30.count ? "warn" : "default"} />
            <Stat label="31–60 days" value={renewals.buckets.d60.count} hint={fmtMoney(renewals.buckets.d60.mrr, c) + " MRR"} />
            <Stat label="61–90 days" value={renewals.buckets.d90.count} hint={fmtMoney(renewals.buckets.d90.mrr, c) + " MRR"} />
          </div>
          <Card title="Contracts renewing within 90 days" padded={false} actions={<ExportLink href="/api/export/report-renewals" />}>
            {renewals.rows.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">Nothing renews in the next 90 days.</p>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Owner</th>
                    <th>Renewal</th>
                    <th>Notice deadline</th>
                    <th>Review</th>
                    <th className="text-right">MRR</th>
                  </tr>
                </thead>
                <tbody>
                  {renewals.rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/contracts/${r.id}`} className="font-medium text-brand-700 hover:underline">
                          {r.name}
                        </Link>
                        <div className="text-xs text-slate-500">{r.companyName}</div>
                      </td>
                      <td>{r.owner ?? "—"}</td>
                      <td className="whitespace-nowrap">
                        {fmtDate(r.renewalDate, settings)}
                        <div className={`text-xs ${r.daysToRenewal !== null && r.daysToRenewal < 0 ? "text-red-700" : "text-slate-500"}`}>{r.daysToRenewal !== null && r.daysToRenewal < 0 ? `${-r.daysToRenewal} days ago` : `in ${r.daysToRenewal} days`}{r.autoRenew ? " · auto-renews" : ""}</div>
                      </td>
                      <td className="whitespace-nowrap">
                        {fmtDate(r.noticeDeadline, settings)}
                        {r.noticePassed && <Badge className="ml-1" tone="amber">passed</Badge>}
                      </td>
                      <td className="whitespace-nowrap">
                        {fmtDate(r.nextReviewDate, settings)}
                        {r.reviewOverdue && <Badge className="ml-1" tone="red">overdue</Badge>}
                      </td>
                      <td className="text-right tabular-nums">{fmtMoney(r.mrr, c)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">{renewals.reviewsOverdue} active contracts have an overdue review · {renewals.noRenewalDate} have no renewal date.</p>
          </Card>
        </TabsContent>

        <TabsContent value="tasks">
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Open tasks by owner" padded={false}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Owner</th>
                    <th className="text-right">Overdue</th>
                    <th className="text-right">Today</th>
                    <th className="text-right">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {tasksRep.byOwner.map((r) => (
                    <tr key={r.ownerId ?? "none"}>
                      <td>{r.owner}</td>
                      <td className={`text-right tabular-nums ${r.overdue ? "font-medium text-red-700" : ""}`}>{r.overdue}</td>
                      <td className="text-right tabular-nums">{r.dueToday}</td>
                      <td className="text-right tabular-nums">{r.open}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Overdue tasks" padded={false} className="lg:col-span-2" actions={<ExportLink href="/api/export/report-overdue-tasks" />}>
              {tasksRep.overdue.length === 0 ? (
                <p className="p-4 text-sm text-slate-500">No overdue tasks.</p>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Company</th>
                      <th>Owner</th>
                      <th>Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasksRep.overdue.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <Link href={`/tasks?q=${encodeURIComponent(t.title)}`} className="hover:underline">
                            {t.title}
                          </Link>{" "}
                          {t.priority !== "normal" && <Badge tone={t.priority === "urgent" ? "red" : t.priority === "high" ? "amber" : "slate"}>{t.priority}</Badge>}
                        </td>
                        <td>{t.companyId ? <Link href={`/companies/${t.companyId}`} className="text-brand-700 hover:underline">{t.companyName}</Link> : "—"}</td>
                        <td>{t.owner ?? "Unassigned"}</td>
                        <td className="whitespace-nowrap text-red-700">{fmtDate(t.dueDate, settings)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        </TabsContent>

        {finance && invoices && (
          <TabsContent value="invoices">
            {invoices.demo && (
              <Alert tone="warn" className="mb-4">
                Demo data: no Xero organisation is connected.
              </Alert>
            )}
            <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Outstanding (authorised)" value={fmtMoney(invoices.outstanding, c)} hint={<span>{invoices.source} <Badge tone={FRESH_TONE[invoices.freshness]}>{invoices.freshness}</Badge></span>} />
              <Stat label="Overdue" value={fmtMoney(invoices.overdue, c)} hint={`${invoices.overdueCount} invoices`} tone={invoices.overdue > 0 ? "danger" : "default"} />
              <Stat label="Paid, last 30 days" value={fmtMoney(invoices.paidLast30, c)} tone="good" />
              <Stat label="Drafts awaiting" value={invoices.pendingDrafts + invoices.draftsInXero} hint={`${invoices.pendingDrafts} in CRM review · ${invoices.draftsInXero} draft in Xero`} />
            </div>
            <Card title="Outstanding by customer" padded={false} actions={<ExportLink href="/api/export/report-outstanding-invoices" />}>
              {invoices.byCompany.length === 0 ? (
                <p className="p-4 text-sm text-slate-500">Nothing outstanding{invoices.configured ? "" : " (Xero not connected)"}.</p>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th className="text-right">Invoices</th>
                      <th className="text-right">Outstanding</th>
                      <th className="text-right">Overdue</th>
                      <th>Oldest overdue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.byCompany.map((r) => (
                      <tr key={r.companyId ?? r.companyName}>
                        <td>{r.companyId ? <Link href={`/companies/${r.companyId}`} className="font-medium text-brand-700 hover:underline">{r.companyName}</Link> : <span className="text-amber-700">{r.companyName}</span>}</td>
                        <td className="text-right tabular-nums">{r.count}</td>
                        <td className="text-right tabular-nums">{fmtMoney(r.outstanding, c)}</td>
                        <td className={`text-right tabular-nums ${r.overdue > 0 ? "text-red-700" : ""}`}>{fmtMoney(r.overdue, c)}</td>
                        <td className="whitespace-nowrap">{r.oldestDue ? fmtDate(r.oldestDue, settings) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
                Balances come from the Xero invoice mirror (hourly sync + webhooks). Xero is the source of truth; see the <Link href="/finance" className="text-brand-700 hover:underline">Finance</Link> page for invoice detail.
              </p>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="devices">
          {!devices.configured ? (
            <Alert tone="info">NinjaOne is not connected. Device totals appear once credentials are entered on the Integrations page.</Alert>
          ) : (
            <>
              {devices.demo && (
                <Alert tone="warn" className="mb-4">
                  Demo data: no NinjaOne tenant is connected.
                </Alert>
              )}
              <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="Devices mirrored" value={devices.totals.total} hint={<span><Badge tone={FRESH_TONE[devices.totals.freshness]}>{devices.totals.freshness}</Badge> {devices.totals.lastFetched ? fmtRelative(new Date(devices.totals.lastFetched)) : "never"}</span>} />
                <Stat label={`Active (${devices.totals.activeDays} days)`} value={devices.totals.active} hint={`${devices.totals.servers} servers · ${devices.totals.workstations} workstations`} tone="good" />
                <Stat label="Billable class, active" value={devices.totals.billable} hint={`${devices.totals.unmapped} not mapped to a company`} />
                <Stat label="Open count discrepancies" value={devices.discrepancies.open} hint={<span>≈ {fmtMoney(devices.discrepancies.unbilledPerPeriod, c)} unbilled, {fmtMoney(devices.discrepancies.overbilledPerPeriod, c)} over-billed per period <Estimate /></span>} tone={devices.discrepancies.open ? "warn" : "default"} />
              </div>
              <Card title="Where to act">
                <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                  <li>
                    Review discrepancies and device detail on the <Link href="/devices" className="text-brand-700 hover:underline">Devices</Link> page. {devices.discrepancies.accepted} items are accepted and will re-open if the gap grows.
                  </li>
                  <li>
                    Map remaining organisations on <Link href="/integrations/ninjaone" className="text-brand-700 hover:underline">Integrations → NinjaOne</Link>.
                  </li>
                  <li>Estimates use each line&apos;s unit price × difference; actual billing changes only when a contract is amended.</li>
                </ul>
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="health">
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Background worker" value={health.worker.status === "alive" ? "Alive" : health.worker.status === "stale" ? "Stale" : "Never seen"} hint={health.worker.lastSeen ? `last heartbeat ${fmtRelative(health.worker.lastSeen)} (${health.worker.mode})` : "start `npm run worker` or the cron tick"} tone={health.worker.status === "alive" ? "good" : "danger"} />
            <Stat label="Failed sync runs, 24h" value={health.providers.reduce((a, p) => a + p.failed24h, 0)} tone={health.providers.some((p) => p.failed24h) ? "danger" : "default"} />
            <Stat label="Partial runs, 24h" value={health.providers.reduce((a, p) => a + p.partial24h, 0)} hint="completed with item-level errors" tone={health.providers.some((p) => p.partial24h) ? "warn" : "default"} />
            <Stat label="Open conflicts" value={health.openConflicts} hint="need a person's decision" tone={health.openConflicts ? "warn" : "default"} />
          </div>
          <Card title="Connectors" padded={false}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Last successful sync</th>
                  <th>Last tested</th>
                  <th className="text-right">Runs 24h</th>
                  <th className="text-right">Failed</th>
                  <th className="text-right">Item errors</th>
                  <th className="text-right">Conflicts</th>
                </tr>
              </thead>
              <tbody>
                {health.providers.map((p) => (
                  <tr key={p.provider}>
                    <td>
                      <Link href={`/integrations/${p.provider}`} className="font-medium text-brand-700 hover:underline">
                        {p.label}
                      </Link>
                      {p.lastError && !p.demo && <div className="max-w-xs truncate text-[11px] text-red-700">{p.lastError}</div>}
                    </td>
                    <td>
                      <Badge tone={p.demo ? "amber" : p.status === "connected" ? "green" : p.status === "not_configured" ? "slate" : "red"}>{p.demo ? "Demo (not connected)" : p.status.replace("_", " ")}</Badge>
                      {p.pausedUntil && p.pausedUntil > new Date() && <div className="text-[11px] text-amber-700">scheduled syncs paused</div>}
                    </td>
                    <td className="whitespace-nowrap text-slate-600">{p.lastSuccessfulSyncAt ? fmtRelative(p.lastSuccessfulSyncAt) : "never"}</td>
                    <td className="whitespace-nowrap text-slate-600">{p.lastTestedAt ? fmtRelative(p.lastTestedAt) : "never"}</td>
                    <td className="text-right tabular-nums">{p.runs24h}</td>
                    <td className={`text-right tabular-nums ${p.failed24h ? "text-red-700" : ""}`}>{p.failed24h}</td>
                    <td className={`text-right tabular-nums ${p.errors24h ? "text-amber-700" : ""}`}>{p.errors24h}</td>
                    <td className={`text-right tabular-nums ${p.openConflicts ? "text-amber-700" : ""}`}>{p.openConflicts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
              Uptime monitors can poll <code>/api/health</code> (200 when the database answers and a heartbeat landed in the last 15 minutes, otherwise 503). Run history and error detail are on the <Link href="/integrations" className="text-brand-700 hover:underline">Integrations</Link> page.
            </p>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
