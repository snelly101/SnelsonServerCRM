"use client";

import { useActionState } from "react";
import { Field, Input, Select, Textarea, SubmitButton, FormMessage, fieldErrors, Checkbox } from "@/components/ui/form";
import { ButtonLink } from "@/components/ui/button";
import { CustomFieldsInputs, type CustomFieldDef } from "./custom-fields";
import { ROLE_LABELS_CONTACT } from "./ui/badge";
import type { ActionResult } from "@/lib/action-result";

export type ContactFormValues = {
  id?: string;
  companyId?: string;
  siteId?: string | null;
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  jobTitle?: string | null;
  roles?: string[];
  isPrimary?: boolean;
  notes?: string | null;
  customFields?: Record<string, unknown>;
};

export function ContactForm({
  action,
  initial,
  companies,
  sites,
  customFieldDefs,
  cancelHref,
  returnTo,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  action: (prev: any, fd: FormData) => Promise<ActionResult<unknown>>;
  initial: ContactFormValues;
  companies: { id: string; name: string }[];
  sites: { id: string; name: string; companyId: string }[];
  customFieldDefs: CustomFieldDef[];
  cancelHref: string;
  returnTo?: string;
}) {
  const [result, formAction] = useActionState<ActionResult<unknown> | null, FormData>(action, null);
  const e = (k: string) => fieldErrors(result, k);
  const lockedCompany = Boolean(initial.companyId);

  return (
    <form action={formAction} className="space-y-6">
      <FormMessage result={result && !result.ok ? result : null} />
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      <section className="grid gap-4 sm:grid-cols-2">
        <Field label="Company" htmlFor="companyId" required error={e("companyId")} className="sm:col-span-2">
          {lockedCompany ? (
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
        <Field label="First name" htmlFor="firstName" required error={e("firstName")}>
          <Input id="firstName" name="firstName" required defaultValue={initial.firstName ?? ""} autoComplete="given-name" />
        </Field>
        <Field label="Last name" htmlFor="lastName" error={e("lastName")}>
          <Input id="lastName" name="lastName" defaultValue={initial.lastName ?? ""} autoComplete="family-name" />
        </Field>
        <Field label="Email" htmlFor="email" error={e("email")} help="Used to detect duplicate contacts.">
          <Input id="email" name="email" type="email" defaultValue={initial.email ?? ""} invalid={Boolean(e("email"))} />
        </Field>
        <Field label="Job title" htmlFor="jobTitle" error={e("jobTitle")}>
          <Input id="jobTitle" name="jobTitle" defaultValue={initial.jobTitle ?? ""} />
        </Field>
        <Field label="Phone" htmlFor="phone" error={e("phone")}>
          <Input id="phone" name="phone" type="tel" defaultValue={initial.phone ?? ""} />
        </Field>
        <Field label="Mobile" htmlFor="mobile" error={e("mobile")}>
          <Input id="mobile" name="mobile" type="tel" defaultValue={initial.mobile ?? ""} />
        </Field>
        {sites.length > 0 && (
          <Field label="Site" htmlFor="siteId" error={e("siteId")}>
            <Select id="siteId" name="siteId" defaultValue={initial.siteId ?? ""}>
              <option value="">—</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-800">Roles</h2>
        <div className="flex flex-wrap gap-4">
          {Object.entries(ROLE_LABELS_CONTACT).map(([value, label]) => (
            <Checkbox key={value} name="roles[]" value={value} label={label} defaultChecked={initial.roles?.includes(value)} />
          ))}
        </div>
        <div className="mt-3">
          <Checkbox name="isPrimary" label="Primary contact for this company" defaultChecked={initial.isPrimary} />
        </div>
      </section>

      {customFieldDefs.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">Custom fields</h2>
          <CustomFieldsInputs defs={customFieldDefs} values={initial.customFields ?? {}} errors={result && !result.ok ? result.fieldErrors : undefined} />
        </section>
      )}

      <Field label="Notes" htmlFor="notes" error={e("notes")}>
        <Textarea id="notes" name="notes" defaultValue={initial.notes ?? ""} rows={3} />
      </Field>

      <div className="flex items-center gap-2 border-t border-slate-200 pt-4">
        <SubmitButton>{initial.id ? "Save changes" : "Create contact"}</SubmitButton>
        <ButtonLink href={cancelHref} variant="ghost">
          Cancel
        </ButtonLink>
      </div>
    </form>
  );
}
