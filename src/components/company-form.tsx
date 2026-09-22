"use client";

import { useActionState, useEffect, useState } from "react";
import { Field, Input, Select, Textarea, SubmitButton, FormMessage, fieldErrors, Checkbox } from "@/components/ui/form";
import { ButtonLink } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { CustomFieldsInputs, type CustomFieldDef } from "./custom-fields";
import { checkDuplicatesAction } from "@/actions/companies";
import type { ActionResult } from "@/lib/action-result";
import type { DuplicateCandidate } from "@/services/companies";
import Link from "next/link";

export type CompanyFormValues = {
  id?: string;
  name?: string;
  status?: string;
  website?: string | null;
  industry?: string | null;
  phone?: string | null;
  email?: string | null;
  companyNumber?: string | null;
  vatNumber?: string | null;
  ownerUserId?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postcode?: string | null;
  country?: string | null;
  notes?: string | null;
  tagIds?: string[];
  customFields?: Record<string, unknown>;
};

export function CompanyForm({
  action,
  initial,
  owners,
  tags,
  customFieldDefs,
  cancelHref,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  action: (prev: any, fd: FormData) => Promise<ActionResult<unknown>>;
  initial: CompanyFormValues;
  owners: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  customFieldDefs: CustomFieldDef[];
  cancelHref: string;
}) {
  const [result, formAction] = useActionState<ActionResult<unknown> | null, FormData>(action, null);
  const [name, setName] = useState(initial.name ?? "");
  const [website, setWebsite] = useState(initial.website ?? "");
  const [companyNumber, setCompanyNumber] = useState(initial.companyNumber ?? "");
  const [dupes, setDupes] = useState<DuplicateCandidate[]>([]);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const e = (k: string) => fieldErrors(result, k);

  // Live duplicate check as the user types the identifying fields.
  useEffect(() => {
    if (!name.trim()) {
      setDupes([]);
      return;
    }
    const t = setTimeout(async () => {
      const res = await checkDuplicatesAction({ name, website, companyNumber, excludeId: initial.id });
      if (res.ok) setDupes(res.data);
    }, 400);
    return () => clearTimeout(t);
  }, [name, website, companyNumber, initial.id]);

  const blockedByDupes = !result?.ok && result?.fieldErrors?._duplicates;

  return (
    <form action={formAction} className="space-y-6">
      <FormMessage result={result && !result.ok ? result : null} />
      {dupes.length > 0 && (
        <Alert tone="warn" title="Possible duplicates">
          <ul className="mt-1 space-y-0.5">
            {dupes.map((d) => (
              <li key={d.id}>
                <Link href={`/companies/${d.id}`} className="font-medium underline" target="_blank">
                  {d.name}
                </Link>{" "}
                <span className="text-xs">
                  ({d.status}) — matches {d.reason.replace("_", " ")}, {d.confidence} confidence
                </span>
              </li>
            ))}
          </ul>
          {(blockedByDupes || dupes.some((d) => d.confidence === "high")) && (
            <div className="mt-2">
              <Checkbox label="This is a different company — create it anyway" checked={confirmDuplicate} onChange={(ev) => setConfirmDuplicate(ev.target.checked)} />
              <input type="hidden" name="confirmDuplicate" value={confirmDuplicate ? "true" : "false"} />
            </div>
          )}
        </Alert>
      )}

      <section className="grid gap-4 sm:grid-cols-2">
        <Field label="Company name" htmlFor="name" required error={e("name")} className="sm:col-span-2">
          <Input id="name" name="name" required maxLength={200} value={name} onChange={(ev) => setName(ev.target.value)} invalid={Boolean(e("name"))} />
        </Field>
        <Field label="Status" htmlFor="status" error={e("status")}>
          <Select id="status" name="status" defaultValue={initial.status ?? "prospect"}>
            <option value="prospect">Prospect</option>
            <option value="customer">Customer</option>
            <option value="former">Former customer</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <Field label="Account owner" htmlFor="ownerUserId" error={e("ownerUserId")}>
          <Select id="ownerUserId" name="ownerUserId" defaultValue={initial.ownerUserId ?? ""}>
            <option value="">Unassigned (defaults to you)</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Website" htmlFor="website" error={e("website")} help="Used to detect duplicates by domain.">
          <Input id="website" name="website" placeholder="example.co.uk" value={website} onChange={(ev) => setWebsite(ev.target.value)} invalid={Boolean(e("website"))} />
        </Field>
        <Field label="Industry" htmlFor="industry" error={e("industry")}>
          <Input id="industry" name="industry" defaultValue={initial.industry ?? ""} list="industry-list" />
        </Field>
        <Field label="Main phone" htmlFor="phone" error={e("phone")}>
          <Input id="phone" name="phone" type="tel" defaultValue={initial.phone ?? ""} />
        </Field>
        <Field label="Main email" htmlFor="email" error={e("email")}>
          <Input id="email" name="email" type="email" defaultValue={initial.email ?? ""} invalid={Boolean(e("email"))} />
        </Field>
        <Field label="Company number" htmlFor="companyNumber" error={e("companyNumber")}>
          <Input id="companyNumber" name="companyNumber" value={companyNumber} onChange={(ev) => setCompanyNumber(ev.target.value)} />
        </Field>
        <Field label="VAT number" htmlFor="vatNumber" error={e("vatNumber")}>
          <Input id="vatNumber" name="vatNumber" defaultValue={initial.vatNumber ?? ""} />
        </Field>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">Billing address</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Address line 1" htmlFor="addressLine1" className="sm:col-span-2">
            <Input id="addressLine1" name="addressLine1" defaultValue={initial.addressLine1 ?? ""} autoComplete="address-line1" />
          </Field>
          <Field label="Address line 2" htmlFor="addressLine2" className="sm:col-span-2">
            <Input id="addressLine2" name="addressLine2" defaultValue={initial.addressLine2 ?? ""} autoComplete="address-line2" />
          </Field>
          <Field label="Town / city" htmlFor="city">
            <Input id="city" name="city" defaultValue={initial.city ?? ""} />
          </Field>
          <Field label="County / region" htmlFor="region">
            <Input id="region" name="region" defaultValue={initial.region ?? ""} />
          </Field>
          <Field label="Postcode" htmlFor="postcode">
            <Input id="postcode" name="postcode" defaultValue={initial.postcode ?? ""} autoComplete="postal-code" />
          </Field>
          <Field label="Country" htmlFor="country" help="2-letter code">
            <Input id="country" name="country" defaultValue={initial.country ?? "GB"} maxLength={2} />
          </Field>
        </div>
      </section>

      {tags.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-800">Tags</h2>
          <div className="flex flex-wrap gap-3">
            {tags.map((t) => (
              <Checkbox key={t.id} name="tagIds[]" value={t.id} label={t.name} defaultChecked={initial.tagIds?.includes(t.id)} />
            ))}
          </div>
        </section>
      )}

      {customFieldDefs.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">Custom fields</h2>
          <CustomFieldsInputs defs={customFieldDefs} values={initial.customFields ?? {}} errors={result && !result.ok ? result.fieldErrors : undefined} />
        </section>
      )}

      <Field label="Internal notes" htmlFor="notes" error={e("notes")}>
        <Textarea id="notes" name="notes" defaultValue={initial.notes ?? ""} rows={4} />
      </Field>

      <div className="flex items-center gap-2 border-t border-slate-200 pt-4">
        <SubmitButton>{initial.id ? "Save changes" : "Create company"}</SubmitButton>
        <ButtonLink href={cancelHref} variant="ghost">
          Cancel
        </ButtonLink>
      </div>
    </form>
  );
}
