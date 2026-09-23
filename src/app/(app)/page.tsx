import Link from "next/link";
import { count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { activities, companies, contacts, user } from "@/db/schema";
import { requireUser } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { PageHeader, Stat, Card, EmptyState } from "@/components/ui/page";
import { fmtDateTime } from "@/lib/format";
import { Alert } from "@/components/ui/alert";
import { pipelineTotals } from "@/services/opportunities";
import { contractTotals, listContracts } from "@/services/contracts";
import { listTasks, taskCounts } from "@/services/tasks";
import { TaskList } from "@/components/task-list";
import { can } from "@/lib/permissions";
import { fmtMoney, fmtDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { deviceTotals, listDiscrepancies, ninjaConnectionSummary } from "@/services/ninjaone";
import { integrationHealth, PROVIDER_LABELS, type Provider } from "@/services/integrations";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const [me, settings] = await Promise.all([requireUser(), getAppSettings()]);
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const [[stats], recent] = await Promise.all([
    db
      .select({
        prospects: sql<number>`count(*) filter (where ${companies.status} = 'prospect')`.mapWith(Number),
        customers: sql<number>`count(*) filter (where ${companies.status} = 'customer')`.mapWith(Number),
        newThisMonth: sql<number>`count(*) filter (where ${companies.createdAt} >= ${since})`.mapWith(Number),
        contacts: sql<number>`(select count(*) from ${contacts} where archived_at is null)`.mapWith(Number),
      })
      .from(companies)
      .where(isNull(companies.archivedAt)),
    db
      .select({
        id: activities.id,
        at: activities.at,
        title: activities.title,
        type: activities.type,
        companyId: activities.companyId,
        companyName: companies.name,
        actorName: user.name,
      })
      .from(activities)
      .leftJoin(companies, eq(companies.id, activities.companyId))
      .leftJoin(user, eq(user.id, activities.actorUserId))
      .orderBy(desc(activities.at))
      .limit(12),
  ]);
  const [ninja, devices, openDiscrepancies, health] = await Promise.all([ninjaConnectionSummary(), deviceTotals(), listDiscrepancies({ status: "open" }), integrationHealth()]);
  const [pipeline, contractsTotals, myTasks, counts, renewals] = await Promise.all([
    pipelineTotals(),
    contractTotals(),
    listTasks({ ownerUserId: me.id, status: "open", pageSize: 8 }),
    taskCounts(me.id),
    listContracts({ status: "active", renewingWithinDays: 90, pageSize: 6 }),
  ]);
  const [{ mine }] = await db
    .select({ mine: count() })
    .from(companies)
    .where(sql`${companies.ownerUserId} = ${me.id} and ${companies.archivedAt} is null and ${companies.createdAt} >= ${since}`);
  void gte;

  return (
    <>
      <PageHeader title={`Good ${greeting()}, ${me.name.split(" ")[0]}`} description="Here's what's happening across your customers." />
      {process.env.DEMO_MODE === "true" && (
        <Alert tone="warn" title="Demo mode" className="mb-4">
          Integrations without credentials are using synthetic data. Nothing shown from Better Proposals, Xero, NinjaOne or 20i is live until each is connected on the Integrations page.
        </Alert>
      )}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Prospects" value={stats.prospects} />
        <Stat label="Customers" value={stats.customers} />
        <Stat label="New companies (30 days)" value={stats.newThisMonth} hint={`${mine} owned by you`} />
        <Stat label="Contacts" value={stats.contacts} />
      </div>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Pipeline (first year)" value={fmtMoney(pipeline.total, settings.currency)} hint={`${pipeline.count} open · weighted ${fmtMoney(pipeline.weighted, settings.currency)}`} />
        <Stat label="MRR (active contracts)" value={fmtMoney(contractsTotals.mrr, settings.currency)} hint={`${contractsTotals.active} active · ARR ${fmtMoney(contractsTotals.arr, settings.currency)}`} tone="good" />
        <Stat label="My open tasks" value={counts.mine} hint={counts.mineOverdue ? `${counts.mineOverdue} overdue` : "none overdue"} tone={counts.mineOverdue ? "danger" : "default"} />
        <Stat label="Renewals in 90 days" value={renewals.total} tone={renewals.total ? "warn" : "default"} />
      </div>
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title="My tasks" padded={false} actions={<Link href="/tasks?owner=me" className="text-xs text-brand-700 hover:underline">View all</Link>}>
          <TaskList tasks={myTasks.rows} canWrite={can(me.role, "task.write")} settings={settings} compact />
        </Card>
        <Card title="Upcoming renewals" padded={false} actions={<Link href="/contracts?renewing=90" className="text-xs text-brand-700 hover:underline">View all</Link>}>
          {renewals.rows.length === 0 ? (
            <div className="p-4 text-sm text-slate-500">No active contracts renew in the next 90 days.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {renewals.rows.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0">
                    <Link href={`/contracts/${c.id}`} className="font-medium text-brand-700 hover:underline">
                      {c.name}
                    </Link>
                    <div className="text-xs text-slate-500">{c.companyName} · MRR {fmtMoney(c.summary.mrr, settings.currency)}</div>
                  </div>
                  <div className="text-right text-xs">
                    <div>Renews {fmtDate(c.renewalDate, settings)}</div>
                    {c.noticeDeadline && <Badge tone={c.noticeDeadline <= new Date().toISOString().slice(0, 10) ? "red" : "amber"}>notice by {fmtDate(c.noticeDeadline, settings)}</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Recent activity" className="lg:col-span-2" padded={false}>
          {recent.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No activity yet" description="Activity appears here as companies, contacts and notes are added." />
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {recent.map((a) => (
                <li key={a.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                  <span className="mt-0.5 w-32 shrink-0 text-xs text-slate-500">{fmtDateTime(a.at, settings)}</span>
                  <div className="min-w-0">
                    <div className="text-slate-800">{a.title}</div>
                    <div className="text-xs text-slate-500">
                      {a.companyId && (
                        <Link href={`/companies/${a.companyId}`} className="text-brand-700 hover:underline">
                          {a.companyName}
                        </Link>
                      )}
                      {a.actorName && <> · {a.actorName}</>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Devices and integrations">
          {ninja.configured ? (
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Active devices</div>
                <div className="text-lg font-semibold">{devices.active}</div>
                <div className="text-[11px] text-slate-500">{ninja.demo ? "demo data" : `of ${devices.total} mirrored`}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Needs attention</div>
                <div className={`text-lg font-semibold ${devices.needsAttention ? "text-amber-700" : ""}`}>{devices.needsAttention}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Count discrepancies</div>
                <div className={`text-lg font-semibold ${openDiscrepancies.length ? "text-amber-700" : ""}`}>
                  <Link href="/devices" className="hover:underline">
                    {openDiscrepancies.length}
                  </Link>
                </div>
                <div className="text-[11px] text-slate-500">open for review</div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Connect NinjaOne to see device totals here.</p>
          )}
          <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-sm">
            {health.connections.map((c) => (
              <li key={c.provider} className="flex items-center justify-between">
                <Link href={`/integrations/${c.provider}`} className="text-slate-700 hover:underline">
                  {PROVIDER_LABELS[c.provider as Provider] ?? c.provider}
                </Link>
                <Badge tone={c.status === "connected" ? "green" : c.status === "not_configured" ? "amber" : "red"}>{c.status === "not_configured" ? "not connected" : c.status}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}
