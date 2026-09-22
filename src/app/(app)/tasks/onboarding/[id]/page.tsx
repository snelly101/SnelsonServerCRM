import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { getOnboarding } from "@/services/onboarding";
import { listTasks } from "@/services/tasks";
import { listOwners } from "@/services/companies";
import { db } from "@/db";
import { companies } from "@/db/schema";
import { eq } from "drizzle-orm";
import { completeOnboardingAction } from "@/actions/tasks";
import { PageHeader, Card, DescriptionList } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { TaskList } from "@/components/task-list";
import { TaskDialog } from "@/components/task-dialog";
import { fmtDate } from "@/lib/format";

export default async function OnboardingPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requirePermission("task.read");
  const { id } = await params;
  const ob = await getOnboarding(id);
  if (!ob) notFound();
  const [settings, tasks, owners, [company]] = await Promise.all([getAppSettings(), listTasks({ status: "all", pageSize: 200, companyId: ob.companyId }).then((r) => ({ ...r, rows: r.rows.filter((t) => t.onboardingId === id) })), listOwners(), db.select({ name: companies.name }).from(companies).where(eq(companies.id, ob.companyId))]);
  const done = tasks.rows.filter((t) => t.status === "done").length;
  const canWrite = can(me.role, "task.write");
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Tasks & Onboarding", href: "/tasks" }, { label: ob.name }]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {ob.name}
            <Badge tone={ob.status === "completed" ? "green" : ob.status === "cancelled" ? "slate" : "blue"}>{ob.status.replace("_", " ")}</Badge>
          </span>
        }
        description={
          <Link href={`/companies/${ob.companyId}`} className="text-brand-700 hover:underline">
            {company?.name}
          </Link>
        }
        actions={
          canWrite &&
          ob.status === "in_progress" && (
            <ConfirmButton action={completeOnboardingAction.bind(null, id)} title="Mark onboarding complete?" description="All checklist items must be done." confirmLabel="Complete" disabled={done < tasks.rows.length}>
              <CheckCircle2 className="h-4 w-4" /> Complete onboarding
            </ConfirmButton>
          )
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title={`Checklist · ${done}/${tasks.rows.length} done`} padded={false} actions={canWrite && ob.status === "in_progress" && <TaskDialog owners={owners} defaults={{ onboardingId: id, companyId: ob.companyId, opportunityId: ob.opportunityId }} label="Add item" />}>
          <div className="h-1.5 bg-slate-100">
            <div className="h-full bg-green-500 transition-all" style={{ width: `${tasks.rows.length ? (done / tasks.rows.length) * 100 : 0}%` }} />
          </div>
          <TaskList tasks={tasks.rows} canWrite={canWrite} settings={settings} showLinks={false} />
        </Card>
        <Card title="Details">
          <DescriptionList
            items={[
              { label: "Started", value: fmtDate(ob.startedAt, settings) },
              { label: "Completed", value: fmtDate(ob.completedAt, settings) },
              { label: "Owner", value: ob.ownerName },
              { label: "Template", value: ob.templateName },
              { label: "Source", value: ob.sourceKey?.split(":")[0] },
              { label: "Opportunity", value: ob.opportunityId ? <Link href={`/pipeline/${ob.opportunityId}`} className="text-brand-700 hover:underline">Open</Link> : null },
            ]}
          />
        </Card>
      </div>
    </>
  );
}
