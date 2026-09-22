"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/page";
import { setTaskStatusAction, deleteTaskAction } from "@/actions/tasks";
import { fmtDate, type DisplaySettings } from "@/lib/format";
import { cn } from "@/lib/utils";

export type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  status: "open" | "done";
  priority: "low" | "normal" | "high" | "urgent";
  dueDate: string | null;
  ownerName: string | null;
  companyId: string | null;
  companyName: string | null;
  opportunityId: string | null;
  opportunityTitle: string | null;
  contractId: string | null;
  contractName: string | null;
  onboardingId: string | null;
  overdue: boolean;
};

const PRIORITY_TONE: Record<string, string> = { low: "slate", normal: "blue", high: "amber", urgent: "red" };

export function TaskList({ tasks, canWrite, settings, compact, showLinks = true }: { tasks: TaskRow[]; canWrite: boolean; settings: DisplaySettings; compact?: boolean; showLinks?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (tasks.length === 0) {
    return (
      <div className="p-4">
        <EmptyState title="No tasks" description="Nothing to do here yet." />
      </div>
    );
  }
  const toggle = (t: TaskRow) => start(async () => {
    await setTaskStatusAction(t.id, t.status === "done" ? "open" : "done");
    router.refresh();
  });
  return (
    <ul className={cn("divide-y divide-slate-100", pending && "opacity-70")}>
      {tasks.map((t) => (
        <li key={t.id} className="flex items-start gap-3 px-4 py-2.5">
          <button
            type="button"
            aria-label={t.status === "done" ? "Reopen task" : "Complete task"}
            disabled={!canWrite}
            onClick={() => toggle(t)}
            className={cn("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border", t.status === "done" ? "border-green-600 bg-green-600 text-white" : "border-slate-300 bg-white hover:border-brand-500", !canWrite && "cursor-default")}
          >
            {t.status === "done" ? <Check className="h-3.5 w-3.5" /> : null}
          </button>
          <div className="min-w-0 flex-1">
            <div className={cn("text-sm", t.status === "done" ? "text-slate-400 line-through" : "text-slate-800")}>{t.title}</div>
            {!compact && t.description && <div className="text-xs text-slate-500">{t.description}</div>}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
              {t.dueDate && <span className={cn(t.overdue && "font-medium text-red-600")}>Due {fmtDate(t.dueDate, settings)}</span>}
              {t.ownerName && <span>· {t.ownerName}</span>}
              {t.priority !== "normal" && <Badge tone={PRIORITY_TONE[t.priority]}>{t.priority}</Badge>}
              {showLinks && t.companyId && (
                <Link href={`/companies/${t.companyId}`} className="hover:underline">
                  · {t.companyName}
                </Link>
              )}
              {showLinks && t.opportunityId && (
                <Link href={`/pipeline/${t.opportunityId}`} className="hover:underline">
                  · {t.opportunityTitle}
                </Link>
              )}
              {showLinks && t.contractId && (
                <Link href={`/contracts/${t.contractId}`} className="hover:underline">
                  · {t.contractName}
                </Link>
              )}
              {showLinks && t.onboardingId && (
                <Link href={`/tasks/onboarding/${t.onboardingId}`} className="hover:underline">
                  · onboarding
                </Link>
              )}
            </div>
          </div>
          {canWrite && (
            <div className="flex shrink-0 items-center gap-1">
              {t.status === "done" && (
                <button type="button" aria-label="Reopen" className="rounded p-1 text-slate-400 hover:text-slate-700" onClick={() => toggle(t)}>
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                aria-label="Delete task"
                className="rounded p-1 text-slate-400 hover:text-red-600"
                onClick={() => {
                  if (confirm(`Delete task "${t.title}"?`)) start(async () => {
                    await deleteTaskAction(t.id);
                    router.refresh();
                  });
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
