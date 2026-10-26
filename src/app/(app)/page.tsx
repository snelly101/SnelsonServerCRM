import Link from "next/link";
import { count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { activities, companies, contacts, user } from "@/db/schema";
import { requireUser } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { PageHeader, Card, EmptyState, FeatureCard, MiniStat } from "@/components/ui/page";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { buttonClass } from "@/components/ui/button";
import { ArrowRight, Building2, CalendarClock, KanbanSquare, Landmark, ListChecks, Plus, Sparkles, TrendingUp, Users } from "lucide-react";
import { billedPerYear, fmtBilled, fmtDateTime } from "@/lib/format";
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
  const [ninja, devices, openDiscrepancies, health] = await Promise.all([ninjaConnectionSummary(), deviceTotals(), listDiscrepancies({ status: "open", source: "ninjaone" }), integrationHealth()]);
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
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <FeatureCard
          eyebrow={<><Landmark /> {contractsTotals.active} active contract{contractsTotals.active === 1 ? "" : "s"}</>}
          meta={`${fmtMoney(billedPerYear(contractsTotals), settings.currency)} over a year of invoices`}
          value={<AnimatedNumber value={contractsTotals.monthlyBilled} format="money" currency={settings.currency} />}
          unit="billed monthly"
          progress={{
            value: Math.max(0, contractsTotals.active - renewals.total),
            max: Math.max(1, contractsTotals.active),
            left: `${Math.max(0, contractsTotals.active - renewals.total)} secure beyond 90 days`,
            right: `${renewals.total} renew${renewals.total === 1 ? "s" : ""} within 90 days`,
          }}
          facts={[
            { label: "Billed quarterly", value: fmtMoney(contractsTotals.quarterlyBilled, settings.currency) },
            { label: "Billed annually", value: fmtMoney(contractsTotals.annualBilled, settings.currency) },
            { label: "One-off in contracts", value: fmtMoney(contractsTotals.oneOff + contractsTotals.hardware, settings.currency) },
          ]}
          action={
            <Link href="/billing" className={buttonClass("secondary", "md", "border-transparent bg-white text-[#242329] hover:bg-white/90 hover:text-[#242329]")}>
              <ArrowRight className="h-4 w-4" /> Open billing
            </Link>
          }
          note={renewals.total ? `${renewals.total} renewal decision${renewals.total === 1 ? "" : "s"} coming up` : "No renewals due in the next 90 days"}
        />
        <Card title="Pipeline and work" description="Open opportunities and what is on your plate.">
          <div className="grid grid-cols-2 gap-3">
            <MiniStat label="Pipeline (first year)" value={fmtMoney(pipeline.total, settings.currency)} hint={`${pipeline.count} open`} icon={<KanbanSquare />} />
            <MiniStat label="Weighted" value={fmtMoney(pipeline.weighted, settings.currency)} hint="by stage probability" icon={<TrendingUp />} />
            <MiniStat label="My open tasks" value={counts.mine} hint={counts.mineOverdue ? `${counts.mineOverdue} overdue` : "none overdue"} tone={counts.mineOverdue ? "danger" : "default"} icon={<ListChecks />} />
            <MiniStat label="Renewals in 90 days" value={renewals.total} hint="active contracts" tone={renewals.total ? "warn" : "default"} icon={<CalendarClock />} />
          </div>
        </Card>
        <Card title="Customers" description="Companies and the people at them.">
          <div className="grid grid-cols-2 gap-3">
            <MiniStat label="Prospects" value={stats.prospects} icon={<Sparkles />} />
            <MiniStat label="Customers" value={stats.customers} icon={<Building2 />} />
            <MiniStat label="New (30 days)" value={stats.newThisMonth} hint={`${mine} owned by you`} icon={<Plus />} />
            <MiniStat label="Contacts" value={stats.contacts} icon={<Users />} />
          </div>
        </Card>
      </div>
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title="My tasks" padded={false} actions={<Link href="/tasks?owner=me" className="text-xs link">View all</Link>}>
          <TaskList tasks={myTasks.rows} canWrite={can(me.role, "task.write")} settings={settings} compact />
        </Card>
        <Card title="Upcoming renewals" padded={false} actions={<Link href="/contracts?renewing=90" className="text-xs link">View all</Link>}>
          {renewals.rows.length === 0 ? (
            <div className="p-4 text-sm text-slate-500">No active contracts renew in the next 90 days.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {renewals.rows.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0">
                    <Link href={`/contracts/${c.id}`} className="font-medium link">
                      {c.name}
                    </Link>
                    <div className="text-xs text-slate-500">{c.companyName} · {fmtBilled(c.summary, settings.currency)}</div>
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
                        <Link href={`/companies/${a.companyId}`} className="link">
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
