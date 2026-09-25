import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { dueLabel } from "@/components/helpdesk/badges";
import { fmtDateTime, type DisplaySettings } from "@/lib/format";
import type { ticketSlaSummary } from "@/services/helpdesk-sla";

type Summary = NonNullable<Awaited<ReturnType<typeof ticketSlaSummary>>>;

const mins = (n: number) =>
  n >= 60 ? `${Math.floor(n / 60)}h${n % 60 ? ` ${n % 60}m` : ""}` : `${n}m`;

/** Both SLA clocks with the event history that explains each deadline. */
export function SlaPanel({
  summary,
  settings,
  showHistory,
  canAdmin,
}: {
  summary: Summary;
  settings: DisplaySettings;
  showHistory: boolean;
  canAdmin: boolean;
}) {
  const row = (
    label: string,
    c: Summary["first_response"],
    done: boolean,
  ) => {
    const due = c.finished
      ? { text: c.finished === "met" ? "met" : "breached", tone: c.finished === "met" ? "green" : "red" }
      : c.paused
        ? { text: "paused", tone: "slate" }
        : dueLabel(c.dueAt, done);
    return (
      <div className="text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-500">{label}</span>
          {c.targetMinutes === null ? (
            <span className="text-slate-400">no target</span>
          ) : due ? (
            <Badge tone={due.tone}>{due.text}</Badge>
          ) : null}
        </div>
        {c.targetMinutes !== null && (
          <div className="mt-0.5 flex items-center justify-between gap-2 text-slate-500">
            <span>
              {mins(c.elapsedMinutes)} of {mins(c.targetMinutes)} used
            </span>
            {c.dueAt && !c.finished && (
              <span title="Deadline in business time">
                {fmtDateTime(c.dueAt, settings)}
              </span>
            )}
          </div>
        )}
        {c.targetMinutes !== null && (
          <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-100">
            <div
              className={`h-full ${c.finished === "breach" || (c.dueAt && !c.finished && c.dueAt < new Date()) ? "bg-red-500" : c.finished === "met" ? "bg-green-500" : c.elapsedMinutes / c.targetMinutes > 0.75 ? "bg-amber-500" : "bg-brand-500"}`}
              style={{ width: `${Math.min(100, (c.elapsedMinutes / c.targetMinutes) * 100)}%` }}
            />
          </div>
        )}
      </div>
    );
  };
  const history = [...summary.first_response.events, ...summary.resolution.events].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );
  return (
    <section className="rounded-lg border border-slate-200 bg-surface p-3 text-sm" aria-label="SLA">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">SLA</h3>
        <span className="text-xs text-slate-500">
          {summary.policy ? (
            canAdmin ? (
              <Link href="/settings/helpdesk/sla" className="hover:underline">
                {summary.policy.name}
              </Link>
            ) : (
              summary.policy.name
            )
          ) : (
            "no policy"
          )}
        </span>
      </div>
      {summary.policy ? (
        <div className="space-y-3">
          {row("First response", summary.first_response, summary.first_response.finished !== null)}
          {row("Resolution", summary.resolution, summary.resolution.finished !== null)}
          <p className="text-[11px] text-slate-400">
            Business time{summary.businessHours.always ? " (24×7)" : ` in ${summary.businessHours.timezone}`}
            {summary.policy.pauseStatuses.length
              ? `; resolution pauses while ${summary.policy.pauseStatuses.map((s) => s.replace(/_/g, " ")).join(" / ")}`
              : ""}
            .
          </p>
          {showHistory && history.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-slate-500">
                Clock history ({history.length})
              </summary>
              <ul className="mt-1 space-y-0.5 text-slate-600">
                {history.map((e) => (
                  <li key={e.id}>
                    <span className="text-slate-400">{fmtDateTime(e.at, settings)}</span>{" "}
                    {e.target === "first_response" ? "First response" : "Resolution"}: {e.kind.replace("_", " ")}
                    {e.reason ? ` (${e.reason})` : ""}
                    {e.dueAt && e.kind !== "met" && e.kind !== "breach"
                      ? ` → due ${fmtDateTime(e.dueAt, settings)}`
                      : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-500">
          No SLA policy applies to this ticket.
          {canAdmin && (
            <>
              {" "}
              <Link href="/settings/helpdesk/sla" className="text-brand-700 hover:underline">
                Create one
              </Link>
              .
            </>
          )}
        </p>
      )}
    </section>
  );
}
