import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import {
  listRuleRuns,
  listRules,
  ruleOptions,
} from "@/services/helpdesk-automation";
import { PageHeader, Card } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { deleteRuleAction } from "@/actions/helpdesk-admin";
import { fmtDateTime } from "@/lib/format";
import {
  AUTOMATION_TRIGGER_LABELS,
  RULE_ACTION_LABELS,
  RULE_OP_LABELS,
  ticketReference,
} from "@/lib/validation-helpdesk";
import { RuleDialog } from "./forms";

export const metadata = { title: "Automation rules" };

export default async function AutomationAdminPage() {
  await requirePermission("helpdesk.admin");
  const [rules, runs, options, settings] = await Promise.all([
    listRules(),
    listRuleRuns(40),
    ruleOptions(),
    getAppSettings(),
  ]);
  const opts = {
    agents: options.agents,
    teams: options.teams,
    categories: options.categories.map((c) => ({ id: c.id, name: c.name })),
  };
  return (
    <>
      <nav aria-label="Breadcrumb" className="py-2 text-xs text-slate-500">
        <Link href="/settings/helpdesk" className="hover:text-slate-800">
          Helpdesk settings
        </Link>{" "}
        / Automation rules
      </nav>
      <PageHeader
        title="Automation rules"
        description="Rules run in order for their trigger. Each rule runs at most once per ticket within its cooldown, a rule can stop later rules, and a rule's own changes never re-trigger rules beyond three chained steps. Every run is logged below and on the ticket."
        actions={<RuleDialog options={opts} />}
      />
      <Card title="Rules" padded={false}>
        {rules.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">
            No rules yet. Typical first rules: assign new e-mail tickets to the
            service desk team; set critical priority when the subject contains
            “outage”; close resolved tickets after 5 days on the schedule
            trigger.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rules.map((r) => (
              <li key={r.id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-6 text-right font-mono text-xs text-slate-400">
                    {r.sortOrder}
                  </span>
                  <span className="font-medium">{r.name}</span>
                  <Badge tone="blue">{AUTOMATION_TRIGGER_LABELS[r.trigger]}</Badge>
                  {!r.active && <Badge tone="slate">inactive</Badge>}
                  {r.stopProcessing && <Badge tone="amber">stops later rules</Badge>}
                  <span className="ml-auto flex gap-1">
                    <RuleDialog
                      rule={{
                        id: r.id,
                        name: r.name,
                        description: r.description,
                        trigger: r.trigger,
                        match: r.match as "all" | "any",
                        conditions: r.conditions,
                        actions: r.actions,
                        sortOrder: r.sortOrder,
                        stopProcessing: r.stopProcessing,
                        cooldownMinutes: r.cooldownMinutes,
                        afterMinutes: r.afterMinutes,
                        active: r.active,
                      }}
                      options={opts}
                    />
                    <ConfirmButton
                      size="sm"
                      variant="ghost"
                      action={deleteRuleAction.bind(null, r.id)}
                      title={`Delete rule ${r.name}?`}
                      description="Its run history is deleted too; ticket events it wrote are kept."
                      confirmLabel="Delete"
                    >
                      Delete
                    </ConfirmButton>
                  </span>
                </div>
                {r.description && (
                  <p className="mt-0.5 pl-8 text-xs text-slate-500">{r.description}</p>
                )}
                <div className="mt-1 pl-8 text-xs text-slate-600">
                  <span className="text-slate-400">If {r.match === "any" ? "any" : "all"}: </span>
                  {r.conditions.length === 0
                    ? "always"
                    : r.conditions
                        .map(
                          (c) =>
                            `${c.field} ${RULE_OP_LABELS[c.op]}${c.value !== undefined && c.value !== null && c.op !== "empty" && c.op !== "not_empty" ? ` ${Array.isArray(c.value) ? c.value.join("|") : c.value}` : ""}`,
                        )
                        .join(" · ")}
                  {r.trigger === "schedule" && r.afterMinutes
                    ? ` · idle for ${Math.round(r.afterMinutes / 60)}h`
                    : ""}
                  <br />
                  <span className="text-slate-400">Then: </span>
                  {r.actions
                    .map(
                      (a) =>
                        `${RULE_ACTION_LABELS[a.type]}${a.value ? ` (${Array.isArray(a.value) ? a.value.length + " values" : String(a.value).slice(0, 40)})` : ""}`,
                    )
                    .join(" · ")}
                  {" · "}
                  <span className="text-slate-400">cooldown {r.cooldownMinutes} min</span>
                  {r.stats.last && (
                    <span className="text-slate-400">
                      {" · "}last matched {fmtDateTime(r.stats.last, settings)} ({r.stats.matched} in 7 days)
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Recent runs" padded={false} className="mt-4">
        {runs.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No rule has matched a ticket yet.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Rule</th>
                <th>Ticket</th>
                <th>Trigger</th>
                <th>Applied</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap text-xs">{fmtDateTime(r.at, settings)}</td>
                  <td>{r.ruleName}</td>
                  <td>
                    <Link
                      href={`/helpdesk/tickets/${r.ticketId}`}
                      className="text-brand-700 hover:underline"
                    >
                      {ticketReference(r.ticketNumber)}
                    </Link>{" "}
                    <span className="text-xs text-slate-500">{r.ticketSubject}</span>
                  </td>
                  <td className="text-xs">{AUTOMATION_TRIGGER_LABELS[r.trigger]}</td>
                  <td className="text-xs">
                    {r.actionsApplied.length
                      ? r.actionsApplied.map((a) => RULE_ACTION_LABELS[a.type]).join(", ")
                      : "nothing to change"}
                  </td>
                  <td className="text-xs text-red-700">{r.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
