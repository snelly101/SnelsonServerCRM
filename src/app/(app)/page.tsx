import Link from "next/link";
import { count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { activities, companies, contacts, user } from "@/db/schema";
import { requireUser } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { PageHeader, Stat, Card, EmptyState } from "@/components/ui/page";
import { fmtDateTime } from "@/lib/format";
import { Alert } from "@/components/ui/alert";

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
          Integrations without credentials are using synthetic data. Nothing shown from Better Proposals, Xero or NinjaOne is live until each is connected on the Integrations page.
        </Alert>
      )}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Prospects" value={stats.prospects} />
        <Stat label="Customers" value={stats.customers} />
        <Stat label="New companies (30 days)" value={stats.newThisMonth} hint={`${mine} owned by you`} />
        <Stat label="Contacts" value={stats.contacts} />
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
        <Card title="Coming in later phases">
          <ul className="space-y-1.5 text-sm text-slate-600">
            <li>Pipeline value and weighted forecast</li>
            <li>Monthly recurring revenue from active contracts</li>
            <li>Upcoming renewals and overdue tasks</li>
            <li>Outstanding invoices (Xero)</li>
            <li>Device totals and integration health (NinjaOne)</li>
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
