"use client";

import { useActionState, useState } from "react";
import { Field, Input, Select, Textarea, SubmitButton, FormMessage, fieldErrors, Checkbox } from "@/components/ui/form";
import { ButtonLink } from "@/components/ui/button";
import { LinesEditor, type EditableLine, type ProductOption } from "./lines-editor";
import type { ActionResult } from "@/lib/action-result";
import { FREQUENCY_LABELS, billingFrequencyValues } from "@/lib/validation-sales";

export type ContractFormValues = {
  id?: string;
  companyId?: string;
  opportunityId?: string | null;
  name?: string;
  reference?: string | null;
  status?: string;
  startDate?: string;
  endDate?: string | null;
  renewalDate?: string | null;
  noticePeriodDays?: number;
  autoRenew?: boolean;
  billingFrequency?: string;
  billingDay?: number | null;
  billingFrom?: string | null;
  nextReviewDate?: string | null;
  reviewIntervalMonths?: number;
  ownerUserId?: string | null;
  notes?: string | null;
};

export function ContractForm({
  action,
  initial,
  lines,
  companies,
  sites,
  owners,
  products,
  currency,
  cancelHref,
  defaultEffectiveFrom,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  action: (prev: any, fd: FormData) => Promise<ActionResult<unknown>>;
  initial: ContractFormValues;
  lines: EditableLine[];
  companies: { id: string; name: string }[];
  sites: { id: string; name: string }[];
  owners: { id: string; name: string }[];
  products: ProductOption[];
  currency: string;
  cancelHref: string;
  /** Pre-fills "Changes take effect from" (an amendment prepared for a renewal date). */
  defaultEffectiveFrom?: string | null;
}) {
  const [result, formAction] = useActionState<ActionResult<unknown> | null, FormData>(action, null);
  const [autoRenew, setAutoRenew] = useState(initial.autoRenew ?? true);
  const e = (k: string) => fieldErrors(result, k);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <form action={formAction} className="space-y-6">
      <FormMessage result={result && !result.ok ? result : null} />
      {initial.opportunityId && <input type="hidden" name="opportunityId" value={initial.opportunityId} />}
      <input type="hidden" name="autoRenew" value={autoRenew ? "true" : "false"} />
      <section className="grid gap-4 sm:grid-cols-2">
        <Field label="Contract name" htmlFor="name" required error={e("name")} className="sm:col-span-2">
          <Input id="name" name="name" required maxLength={200} defaultValue={initial.name ?? ""} placeholder="Managed IT Agreement 2026" />
        </Field>
        <Field label="Company" htmlFor="companyId" required error={e("companyId")}>
          {initial.id || initial.companyId ? (
            <>
              <input type="hidden" name="companyId" value={initial.companyId} />
              <Input value={companies.find((c) => c.id === initial.companyId)?.name ?? ""} disabled />
            </>
          ) : (
            <Select id="companyId" name="companyId" required defaultValue="">
              <option value="" disabled>
                Choose a company…
              </option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Reference" htmlFor="reference" error={e("reference")}>
          <Input id="reference" name="reference" defaultValue={initial.reference ?? ""} placeholder="MSA-0042" />
        </Field>
        <Field label="Status" htmlFor="status" error={e("status")}>
          <Select id="status" name="status" defaultValue={initial.status ?? "draft"}>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
            <option value="cancelled">Cancelled</option>
          </Select>
        </Field>
        <Field label="Owner" htmlFor="ownerUserId" error={e("ownerUserId")}>
          <Select id="ownerUserId" name="ownerUserId" defaultValue={initial.ownerUserId ?? ""}>
            <option value="">Me</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Start date" htmlFor="startDate" required error={e("startDate")}>
          <Input id="startDate" name="startDate" type="date" required defaultValue={initial.startDate ?? today} />
        </Field>
        <Field label="End date" htmlFor="endDate" error={e("endDate")}>
          <Input id="endDate" name="endDate" type="date" defaultValue={initial.endDate ?? ""} />
        </Field>
        <Field label="Renewal date" htmlFor="renewalDate" error={e("renewalDate")} help="Defaults to the end date">
          <Input id="renewalDate" name="renewalDate" type="date" defaultValue={initial.renewalDate ?? ""} />
        </Field>
        <Field label="Notice period (days)" htmlFor="noticePeriodDays" error={e("noticePeriodDays")} help="A renewal task is created 30 days before the notice deadline">
          <Input id="noticePeriodDays" name="noticePeriodDays" type="number" min={0} max={730} defaultValue={initial.noticePeriodDays ?? 90} />
        </Field>
        <Field label="Billing frequency" htmlFor="billingFrequency" error={e("billingFrequency")}>
          <Select id="billingFrequency" name="billingFrequency" defaultValue={initial.billingFrequency ?? "monthly"}>
            {billingFrequencyValues.filter((f) => f !== "one_off").map((f) => (
              <option key={f} value={f}>
                {FREQUENCY_LABELS[f]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Billing day" htmlFor="billingDay" error={e("billingDay")} help="Periods start on this day of the month; a start part-way through is pro-rated on the first invoice.">
          <Select id="billingDay" name="billingDay" defaultValue={initial.billingDay ? String(initial.billingDay) : ""}>
            <option value="">On the start date each period</option>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}{d === 1 || d === 21 ? "st" : d === 2 || d === 22 ? "nd" : d === 3 || d === 23 ? "rd" : "th"} of the month
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Bill from (CRM)" htmlFor="billingFrom" error={e("billingFrom")} help="Billing commencement in the CRM. Periods from this date that have no draft invoice are proposed by the billing run as missed. Leave empty to only ever propose the current period (nothing earlier is back-billed).">
          <Input id="billingFrom" name="billingFrom" type="date" defaultValue={initial.billingFrom ?? ""} />
        </Field>
        <div className="flex items-end pb-2">
          <Checkbox label="Auto-renews at the renewal date" checked={autoRenew} onChange={(ev) => setAutoRenew(ev.target.checked)} />
        </div>
        <Field label="Next account review" htmlFor="nextReviewDate" error={e("nextReviewDate")}>
          <Input id="nextReviewDate" name="nextReviewDate" type="date" defaultValue={initial.nextReviewDate ?? ""} />
        </Field>
        <Field label="Review every (months)" htmlFor="reviewIntervalMonths" error={e("reviewIntervalMonths")}>
          <Input id="reviewIntervalMonths" name="reviewIntervalMonths" type="number" min={1} max={36} defaultValue={initial.reviewIntervalMonths ?? 6} />
        </Field>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-800">Contracted services</h2>
        <p className="mb-3 text-xs text-slate-500">Quantity is the <strong>contracted</strong> (billable) amount. Per-device lines marked for comparison are checked against NinjaOne device counts (Phase 5) and discrepancies are flagged for review, never billed automatically.</p>
        <LinesEditor initial={lines} products={products} currency={currency} showSite sites={sites} quantityLabel="Contracted qty" />
        {initial.status === "active" && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Changes take effect from" htmlFor="quantityEffectiveFrom" help="The next invoice bills the old quantity for the period and any increase pro rata from this day. Decreases apply from the next period. Price changes apply from the next period that starts on or after this day.">
              <Input id="quantityEffectiveFrom" name="quantityEffectiveFrom" type="date" defaultValue={defaultEffectiveFrom ?? today} />
            </Field>
            <Field label="Reason for the change" htmlFor="changeReason" help="Kept with the change in the contract's history and the audit log.">
              <Input id="changeReason" name="changeReason" placeholder="e.g. two new starters, requested by Pat on 3 Oct" maxLength={500} />
            </Field>
          </div>
        )}
      </section>

      <Field label="Notes" htmlFor="notes" error={e("notes")}>
        <Textarea id="notes" name="notes" defaultValue={initial.notes ?? ""} rows={3} />
      </Field>

      <div className="flex items-center gap-2 border-t border-slate-200 pt-4">
        <SubmitButton>{initial.id ? "Save changes" : "Create contract"}</SubmitButton>
        <ButtonLink href={cancelHref} variant="ghost">
          Cancel
        </ButtonLink>
      </div>
    </form>
  );
}
