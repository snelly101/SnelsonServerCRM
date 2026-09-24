"use client";

import { useActionState } from "react";
import { Field, Input, SubmitButton, FormMessage, Checkbox } from "@/components/ui/form";
import { updateSecuritySettingsAction } from "@/actions/admin";
import { ROLE_LABELS, ROLES } from "@/lib/permissions";

export function SecuritySettingsForm({ requiredRoles, deadline, readOnly }: { requiredRoles: string[]; deadline: string | null; readOnly: boolean }) {
  const [result, formAction] = useActionState(updateSecuritySettingsAction, null);
  return (
    <form action={formAction} className="space-y-4">
      <FormMessage result={result} />
      <fieldset disabled={readOnly} className="space-y-4">
        <div>
          <p className="mb-1 text-sm font-medium text-slate-700">Roles that must use two-factor authentication</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {ROLES.map((r) => (
              <Checkbox key={r} name="twoFactorRequiredRoles[]" value={r} defaultChecked={requiredRoles.includes(r)} label={ROLE_LABELS[r]} />
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">Applies to accounts with a CRM password. Microsoft-only sign-ins are exempt (Entra handles their MFA).</p>
        </div>
        <Field label="Grace period ends" htmlFor="twoFactorDeadline" help="Until this date affected users see a reminder; after it they must enrol before using the CRM. Leave empty to enforce immediately.">
          <Input id="twoFactorDeadline" name="twoFactorDeadline" type="date" defaultValue={deadline ?? ""} className="w-48" />
        </Field>
      </fieldset>
      {!readOnly && <SubmitButton>Save policy</SubmitButton>}
      {readOnly && <p className="text-xs text-slate-500">Only administrators can change the policy.</p>}
    </form>
  );
}
