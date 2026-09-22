import Link from "next/link";
import { ClipboardList, ListChecks } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { listTasks, taskCounts } from "@/services/tasks";
import { listOnboardings } from "@/services/onboarding";
import { listOwners } from "@/services/companies";
import { companyOptions } from "@/services/lookups";
import { listSavedViews } from "@/services/settings";
import { PageHeader, Card, Stat, EmptyState } from "@/components/ui/page";
import { ButtonLink } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pagination } from "@/components/ui/pagination";
import { FilterBar } from "@/components/ui/filter-bar";
import { TaskList } from "@/components/task-list";
import { TaskDialog } from "@/components/task-dialog";
import { param, toInt } from "@/lib/utils";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Tasks & Onboarding" };

export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("task.read");
  const sp = await searchParams;
  const owner = param(sp, "owner");
  const [data, counts, owners, companies, views, settings, onboardings] = await Promise.all([
    listTasks({ q: param(sp, "q"), status: (param(sp, "status") as "open" | "done" | "all") ?? "open", ownerUserId: owner === "me" ? me.id : owner, priority: param(sp, "priority"), due: param(sp, "due") as "overdue" | "today" | "week" | "none" | undefined, page: toInt(param(sp, "page"), 1) }),
    taskCounts(me.id),
    listOwners(),
    companyOptions(),
    listSavedViews(me.id, "tasks"),
    getAppSettings(),
    listOnboardings(),
  ]);
  const canWrite = can(me.role, "task.write");
  const active = onboardings.filter((o) => o.status === "in_progress");

  return (
    <>
      <PageHeader
        title="Tasks & Onboarding"
        description="Follow-ups, reminders and onboarding checklists."
        actions={
          <>
            {can(me.role, "settings.write") && (
              <ButtonLink href="/tasks/templates" variant="secondary">
                <ClipboardList className="h-4 w-4" /> Checklist templates
              </ButtonLink>
            )}
            {canWrite && <TaskDialog owners={owners} companies={companies} label="New task" />}
          </>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="My open tasks" value={counts.mine} hint={counts.mineOverdue ? `${counts.mineOverdue} overdue` : "none overdue"} tone={counts.mineOverdue ? "danger" : "default"} />
        <Stat label="Overdue (everyone)" value={counts.allOverdue} tone={counts.allOverdue ? "warn" : "default"} />
        <Stat label="Due today" value={counts.dueToday} />
        <Stat label="Onboardings in progress" value={active.length} />
      </div>

      {active.length > 0 && (
        <Card title="Onboardings in progress" padded={false} className="mb-4">
          <ul className="divide-y divide-slate-100">
            {active.map((o) => (
              <li key={o.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <ListChecks className="h-4 w-4 text-slate-400" />
                <Link href={`/tasks/onboarding/${o.id}`} className="font-medium text-brand-700 hover:underline">
                  {o.name}
                </Link>
                <span className="text-xs text-slate-500">started {fmtDate(o.startedAt, settings)}{o.ownerName ? ` · ${o.ownerName}` : ""}</span>
                <span className="ml-auto flex items-center gap-2 text-xs">
                  <span className="h-1.5 w-24 overflow-hidden rounded bg-slate-200">
                    <span className="block h-full bg-green-500" style={{ width: `${o.total ? (o.done / o.total) * 100 : 0}%` }} />
                  </span>
                  {o.done}/{o.total}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <FilterBar
        page="tasks"
        currentUserId={me.id}
        savedViews={views}
        placeholder="Search tasks or company…"
        filters={[
          { key: "status", label: "Status", options: [{ value: "open", label: "Open" }, { value: "done", label: "Done" }, { value: "all", label: "All" }] },
          { key: "owner", label: "Owner", options: [{ value: "me", label: "Me" }, { value: "unassigned", label: "Unassigned" }, ...owners.map((o) => ({ value: o.id, label: o.name }))] },
          { key: "due", label: "Due", options: [{ value: "overdue", label: "Overdue" }, { value: "today", label: "Today" }, { value: "week", label: "Next 7 days" }, { value: "none", label: "No date" }] },
          { key: "priority", label: "Priority", options: ["urgent", "high", "normal", "low"].map((p) => ({ value: p, label: p })) },
        ]}
      />
      {data.total === 0 ? (
        <EmptyState title="No tasks match" description="You're all caught up, or try different filters." />
      ) : (
        <Card padded={false}>
          <TaskList tasks={data.rows} canWrite={canWrite} settings={settings} />
          <Pagination page={data.page} pageCount={data.pageCount} total={data.total} pageSize={data.pageSize} />
        </Card>
      )}
      {onboardings.some((o) => o.status !== "in_progress") && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-slate-600">Completed and cancelled onboardings</summary>
          <ul className="mt-2 space-y-1">
            {onboardings
              .filter((o) => o.status !== "in_progress")
              .map((o) => (
                <li key={o.id}>
                  <Link href={`/tasks/onboarding/${o.id}`} className="text-brand-700 hover:underline">
                    {o.name}
                  </Link>{" "}
                  <Badge tone={o.status === "completed" ? "green" : "slate"}>{o.status}</Badge>
                </li>
              ))}
          </ul>
        </details>
      )}
    </>
  );
}
