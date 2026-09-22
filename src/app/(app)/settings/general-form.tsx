"use client";

import { useActionState } from "react";
import { Field, Input, Select, SubmitButton, FormMessage, fieldErrors } from "@/components/ui/form";
import { updateSettingsAction } from "@/actions/admin";

const TIMEZONES = ["Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney", "Pacific/Auckland"];

export function GeneralSettingsForm({
  settings,
  readOnly,
}: {
  settings: { companyName: string; currency: string; dateFormat: string; timezone: string; defaultTaxRatePercent: number; taxLabel: string; deviceActiveDays: number };
  readOnly: boolean;
}) {
  const [result, formAction] = useActionState(updateSettingsAction, null);
  const e = (k: string) => fieldErrors(result, k);
  return (
    <form action={formAction} className="space-y-4">
      <FormMessage result={result} />
      <fieldset disabled={readOnly} className="grid gap-4 sm:grid-cols-2">
        <Field label="Your company name" htmlFor="companyName" required error={e("companyName")} className="sm:col-span-2">
          <Input id="companyName" name="companyName" defaultValue={settings.companyName} required />
        </Field>
        <Field label="Currency" htmlFor="currency" error={e("currency")} help="ISO 4217 code, e.g. GBP">
          <Input id="currency" name="currency" defaultValue={settings.currency} maxLength={3} required />
        </Field>
        <Field label="Date format" htmlFor="dateFormat" error={e("dateFormat")}>
          <Select id="dateFormat" name="dateFormat" defaultValue={settings.dateFormat}>
            <option value="dd/MM/yyyy">31/12/2026</option>
            <option value="d MMM yyyy">31 Dec 2026</option>
            <option value="yyyy-MM-dd">2026-12-31</option>
            <option value="MM/dd/yyyy">12/31/2026</option>
          </Select>
        </Field>
        <Field label="Timezone" htmlFor="timezone" error={e("timezone")}>
          <Select id="timezone" name="timezone" defaultValue={settings.timezone}>
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Tax label" htmlFor="taxLabel" error={e("taxLabel")}>
          <Input id="taxLabel" name="taxLabel" defaultValue={settings.taxLabel} required />
        </Field>
        <Field label="Default tax rate (%)" htmlFor="defaultTaxRatePercent" error={e("defaultTaxRatePercent")}>
          <Input id="defaultTaxRatePercent" name="defaultTaxRatePercent" type="number" step="0.01" min={0} max={100} defaultValue={settings.defaultTaxRatePercent} required />
        </Field>
        <Field label="Device 'active' window (days)" htmlFor="deviceActiveDays" error={e("deviceActiveDays")} help="Devices not seen within this window are excluded from billable device counts.">
          <Input id="deviceActiveDays" name="deviceActiveDays" type="number" min={1} max={365} defaultValue={settings.deviceActiveDays} required />
        </Field>
      </fieldset>
      {!readOnly && <SubmitButton>Save settings</SubmitButton>}
      {readOnly && <p className="text-xs text-slate-500">Only administrators can change settings.</p>}
    </form>
  );
}
