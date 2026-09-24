"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Field,
  Input,
  Select,
  Textarea,
  SubmitButton,
  FormMessage,
  fieldErrors,
  Checkbox,
} from "@/components/ui/form";
import {
  saveBusinessHoursAction,
  saveSlaPolicyAction,
} from "@/actions/helpdesk-admin";
import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  type TicketStatus,
} from "@/lib/validation-helpdesk";

const DAYS = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
] as const;
const DEFAULT_DAYS = ["09:00-17:30", "09:00-17:30", "09:00-17:30", "09:00-17:30", "09:00-17:30", "", ""];

function useDialog<T>(action: T) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return { open, setOpen, router, action };
}

export function BusinessHoursDialog({
  hours,
}: {
  hours?: {
    id: string;
    name: string;
    timezone: string;
    always: boolean;
    days: string[];
    holidays: string[];
  };
}) {
  const { open, setOpen, router } = useDialog(null);
  const [result, formAction] = useActionState(
    saveBusinessHoursAction.bind(null, hours?.id ?? null),
    null,
  );
  const [always, setAlways] = useState(hours?.always ?? false);
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router, setOpen]);
  const days = hours?.days ?? DEFAULT_DAYS;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant={hours ? "ghost" : "primary"} onClick={() => setOpen(true)}>
        {hours ? (
          <>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </>
        ) : (
          <>
            <Plus className="h-4 w-4" /> New schedule
          </>
        )}
      </Button>
      <DialogContent title={hours ? `Edit ${hours.name}` : "New business hours"}>
        <form action={formAction} className="space-y-3">
          <FormMessage result={result && !result.ok ? result : null} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="bh-name" required error={fieldErrors(result, "name")}>
              <Input id="bh-name" name="name" defaultValue={hours?.name ?? ""} required />
            </Field>
            <Field
              label="Time zone (IANA)"
              htmlFor="bh-tz"
              required
              error={fieldErrors(result, "timezone")}
            >
              <Input
                id="bh-tz"
                name="timezone"
                defaultValue={hours?.timezone ?? "Europe/London"}
                required
              />
            </Field>
          </div>
          <Checkbox
            name="always"
            value="true"
            label="24×7 (ignore the weekly windows and holidays)"
            defaultChecked={always}
            onChange={(e) => setAlways(e.target.checked)}
          />
          {!always && (
            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="mb-1 text-xs text-slate-500">
                Windows per day as HH:MM-HH:MM, comma separated for a split day; blank = closed.
              </legend>
              {DAYS.map(([key, label], i) => (
                <Field key={key} label={label} htmlFor={`bh-${key}`}>
                  <Input
                    id={`bh-${key}`}
                    name={`day_${key}`}
                    defaultValue={days[i] ?? ""}
                    placeholder="closed"
                  />
                </Field>
              ))}
            </fieldset>
          )}
          <Field
            label="Holidays (one date per line, YYYY-MM-DD)"
            htmlFor="bh-holidays"
            error={fieldErrors(result, "holidays")}
          >
            <Textarea
              id="bh-holidays"
              name="holidays"
              rows={4}
              defaultValue={hours?.holidays.join("\n") ?? ""}
              placeholder={"2026-12-25\n2026-12-28"}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Save</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Policy = {
  id: string;
  name: string;
  description: string | null;
  businessHoursId: string | null;
  firstResponseMinutes: Record<string, number | null>;
  resolutionMinutes: Record<string, number | null>;
  pauseStatuses: string[];
  isDefault: boolean;
  active: boolean;
  companyIds: string[];
};
const toHours = (m: number | null | undefined) =>
  m === null || m === undefined ? "" : String(Math.round((m / 60) * 100) / 100);
const DEFAULT_FR: Record<string, number> = { low: 480, normal: 240, high: 60, critical: 30 };
const DEFAULT_RES: Record<string, number> = { low: 4800, normal: 2400, high: 480, critical: 240 };

export function SlaPolicyDialog({
  policy,
  businessHours,
  companies,
}: {
  policy?: Policy;
  businessHours: { id: string; name: string }[];
  companies: { id: string; name: string }[];
}) {
  const { open, setOpen, router } = useDialog(null);
  const [result, formAction] = useActionState(
    saveSlaPolicyAction.bind(null, policy?.id ?? null),
    null,
  );
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router, setOpen]);
  const fr = policy?.firstResponseMinutes ?? DEFAULT_FR;
  const res = policy?.resolutionMinutes ?? DEFAULT_RES;
  const pause = new Set(policy?.pauseStatuses ?? ["awaiting_customer"]);
  const assigned = new Set(policy?.companyIds ?? []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant={policy ? "ghost" : "primary"} onClick={() => setOpen(true)}>
        {policy ? (
          <>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </>
        ) : (
          <>
            <Plus className="h-4 w-4" /> New policy
          </>
        )}
      </Button>
      <DialogContent title={policy ? `Edit ${policy.name}` : "New SLA policy"} wide>
        <form action={formAction} className="space-y-3">
          <FormMessage result={result && !result.ok ? result : null} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="sla-name" required error={fieldErrors(result, "name")}>
              <Input id="sla-name" name="name" defaultValue={policy?.name ?? ""} required />
            </Field>
            <Field label="Business hours" htmlFor="sla-bh">
              <Select id="sla-bh" name="businessHoursId" defaultValue={policy?.businessHoursId ?? ""}>
                <option value="">24×7</option>
                {businessHours.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Description" htmlFor="sla-desc">
            <Input id="sla-desc" name="description" defaultValue={policy?.description ?? ""} />
          </Field>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500">
                <th className="text-left font-normal">Target (business hours)</th>
                {TICKET_PRIORITIES.map((p) => (
                  <th key={p} className="px-1 text-left font-normal">
                    {TICKET_PRIORITY_LABELS[p]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="py-1 pr-2">First response</td>
                {TICKET_PRIORITIES.map((p) => (
                  <td key={p} className="px-1">
                    <Input
                      name={`fr_${p}`}
                      type="number"
                      step="0.25"
                      min="0"
                      aria-label={`First response ${TICKET_PRIORITY_LABELS[p]} hours`}
                      defaultValue={toHours(fr[p])}
                      placeholder="none"
                    />
                  </td>
                ))}
              </tr>
              <tr>
                <td className="py-1 pr-2">Resolution</td>
                {TICKET_PRIORITIES.map((p) => (
                  <td key={p} className="px-1">
                    <Input
                      name={`res_${p}`}
                      type="number"
                      step="0.25"
                      min="0"
                      aria-label={`Resolution ${TICKET_PRIORITY_LABELS[p]} hours`}
                      defaultValue={toHours(res[p])}
                      placeholder="none"
                    />
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-slate-600">
              Pause the resolution clock while the ticket is
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {(["awaiting_customer", "awaiting_third_party"] as TicketStatus[]).map((s) => (
                <Checkbox
                  key={s}
                  name="pauseStatuses"
                  value={s}
                  label={TICKET_STATUS_LABELS[s]}
                  defaultChecked={pause.has(s)}
                />
              ))}
            </div>
          </fieldset>
          <Field
            label="Customers on this policy (leave empty for the default policy)"
            htmlFor="sla-companies"
          >
            <select
              id="sla-companies"
              name="companyIds"
              multiple
              size={6}
              defaultValue={[...assigned]}
              className="w-full rounded-md border border-slate-300 bg-surface p-1 text-sm"
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex flex-wrap gap-4">
            <Checkbox
              name="isDefault"
              value="true"
              label="Default policy for customers without one"
              defaultChecked={policy?.isDefault ?? false}
            />
            <Checkbox
              name="active"
              value="true"
              label="Active"
              defaultChecked={policy?.active ?? true}
            />
          </div>
          <input type="hidden" name="active" value="false" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Save policy</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
