import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { listBusinessHours, listSlaPolicies } from "@/services/helpdesk-sla";
import { companyOptions } from "@/services/lookups";
import { PageHeader, Card } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import {
  deleteBusinessHoursAction,
  deleteSlaPolicyAction,
} from "@/actions/helpdesk-admin";
import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  type TicketStatus,
} from "@/lib/validation-helpdesk";
import { BusinessHoursDialog, SlaPolicyDialog } from "./forms";

export const metadata = { title: "SLA policies" };

const DAYS: ["mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", string][] = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
];
const hours = (m: number | null | undefined) =>
  m === null || m === undefined ? "—" : m % 60 === 0 ? `${m / 60}h` : `${(m / 60).toFixed(1)}h`;

export default async function SlaAdminPage() {
  await requirePermission("helpdesk.admin");
  const [policies, bh, companies] = await Promise.all([
    listSlaPolicies(),
    listBusinessHours(),
    companyOptions(),
  ]);
  return (
    <>
      <nav aria-label="Breadcrumb" className="py-2 text-xs text-slate-500">
        <Link href="/settings/helpdesk" className="hover:text-slate-800">
          Helpdesk settings
        </Link>{" "}
        / SLA policies
      </nav>
      <PageHeader
        title="SLA policies and business hours"
        description="Targets are business time: the clock only runs inside the policy's working hours, skips holidays and follows daylight-saving changes. The resolution clock pauses in the statuses you choose; the first-response clock never pauses. Every ticket keeps an event history that explains its deadline."
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card
          title="Policies"
          padded={false}
          actions={
            <SlaPolicyDialog
              businessHours={bh.map((b) => ({ id: b.id, name: b.name }))}
              companies={companies}
            />
          }
        >
          {policies.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">
              No policies yet, so tickets have no deadlines. Create one and mark
              it as the default; assign others to specific customers.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {policies.map((p) => (
                <li key={p.id} className="px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    {p.isDefault && <Badge tone="blue">default</Badge>}
                    {!p.active && <Badge tone="slate">inactive</Badge>}
                    <span className="text-xs text-slate-500">
                      {p.businessHoursName ?? "24×7"}
                    </span>
                    <span className="ml-auto flex gap-1">
                      <SlaPolicyDialog
                        policy={{
                          id: p.id,
                          name: p.name,
                          description: p.description,
                          businessHoursId: p.businessHoursId,
                          firstResponseMinutes: p.firstResponseMinutes,
                          resolutionMinutes: p.resolutionMinutes,
                          pauseStatuses: p.pauseStatuses,
                          isDefault: p.isDefault,
                          active: p.active,
                          companyIds: p.companies.map((c) => c.id),
                        }}
                        businessHours={bh.map((b) => ({ id: b.id, name: b.name }))}
                        companies={companies}
                      />
                      <ConfirmButton
                        size="sm"
                        variant="ghost"
                        action={deleteSlaPolicyAction.bind(null, p.id)}
                        title={`Delete policy ${p.name}?`}
                        description="Tickets under it fall back to the default policy (or no targets). Their SLA history is kept."
                        confirmLabel="Delete"
                      >
                        Delete
                      </ConfirmButton>
                    </span>
                  </div>
                  {p.description && (
                    <p className="mt-0.5 text-xs text-slate-500">{p.description}</p>
                  )}
                  <table className="mt-2 text-xs">
                    <thead>
                      <tr className="text-slate-500">
                        <th className="pr-3 text-left font-normal">Priority</th>
                        {TICKET_PRIORITIES.map((pr) => (
                          <th key={pr} className="px-2 text-right font-normal">
                            {TICKET_PRIORITY_LABELS[pr]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="pr-3 text-slate-500">First response</td>
                        {TICKET_PRIORITIES.map((pr) => (
                          <td key={pr} className="px-2 text-right tabular-nums">
                            {hours(p.firstResponseMinutes[pr])}
                          </td>
                        ))}
                      </tr>
                      <tr>
                        <td className="pr-3 text-slate-500">Resolution</td>
                        {TICKET_PRIORITIES.map((pr) => (
                          <td key={pr} className="px-2 text-right tabular-nums">
                            {hours(p.resolutionMinutes[pr])}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                  <p className="mt-1 text-xs text-slate-500">
                    Pauses while:{" "}
                    {p.pauseStatuses.length
                      ? p.pauseStatuses
                          .map((s) => TICKET_STATUS_LABELS[s as TicketStatus] ?? s)
                          .join(", ")
                      : "never"}
                    {" · "}
                    Customers:{" "}
                    {p.companies.length
                      ? p.companies.map((c) => c.name).join(", ")
                      : p.isDefault
                        ? "everyone else"
                        : "none"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card
          title="Business hours"
          padded={false}
          actions={<BusinessHoursDialog />}
        >
          {bh.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">
              No schedules yet. Policies without one run 24×7.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {bh.map((b) => (
                <li key={b.id} className="px-4 py-3 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{b.name}</span>
                    <span className="text-xs text-slate-500">{b.timezone}</span>
                    {b.always && <Badge tone="slate">24×7</Badge>}
                    <span className="ml-auto flex gap-1">
                      <BusinessHoursDialog
                        hours={{
                          id: b.id,
                          name: b.name,
                          timezone: b.timezone,
                          always: b.always,
                          days: DAYS.map(([k]) =>
                            b.schedule[k].map((w) => `${w.start}-${w.end}`).join(", "),
                          ),
                          holidays: b.holidays,
                        }}
                      />
                      <ConfirmButton
                        size="sm"
                        variant="ghost"
                        action={deleteBusinessHoursAction.bind(null, b.id)}
                        title={`Delete ${b.name}?`}
                        description="Policies using it switch to 24×7 until you pick another schedule."
                        confirmLabel="Delete"
                      >
                        Delete
                      </ConfirmButton>
                    </span>
                  </div>
                  {!b.always && (
                    <ul className="mt-1 grid grid-cols-2 gap-x-3 text-xs text-slate-600">
                      {DAYS.map(([k, label]) => (
                        <li key={k}>
                          <span className="inline-block w-8 text-slate-400">{label}</span>
                          {b.schedule[k].length
                            ? b.schedule[k].map((w) => `${w.start}–${w.end}`).join(", ")
                            : "closed"}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-1 text-xs text-slate-500">
                    {b.holidays.length
                      ? `${b.holidays.length} holiday${b.holidays.length === 1 ? "" : "s"}: ${b.holidays.slice(0, 6).join(", ")}${b.holidays.length > 6 ? "…" : ""}`
                      : "No holidays"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
