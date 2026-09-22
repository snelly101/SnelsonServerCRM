"use client";

import { useActionState, useState } from "react";
import { Field, Input, Select, Textarea, SubmitButton, FormMessage, fieldErrors } from "@/components/ui/form";
import { ButtonLink } from "@/components/ui/button";
import { LinesEditor, type EditableLine, type ProductOption } from "./lines-editor";
import { CustomFieldsInputs, type CustomFieldDef } from "./custom-fields";
import type { ActionResult } from "@/lib/action-result";

export type OpportunityFormValues = {
  id?: string;
  companyId?: string;
  contactId?: string | null;
  title?: string;
  stageId?: string;
  ownerUserId?: string | null;
  expectedCloseDate?: string | null;
  probability?: number;
  leadSource?: string | null;
  nextAction?: string | null;
  nextActionDate?: string | null;
  notes?: string | null;
  customFields?: Record<string, unknown>;
};

export function OpportunityForm({
  action,
  initial,
  lines,
  companies,
  contacts,
  stages,
  owners,
  products,
  customFieldDefs,
  currency,
  cancelHref,
  leadSources,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  action: (prev: any, fd: FormData) => Promise<ActionResult<unknown>>;
  initial: OpportunityFormValues;
  lines: EditableLine[];
  companies: { id: string; name: string }[];
  contacts: { id: string; name: string; companyId: string }[];
  stages: { id: string; name: string; probability: number }[];
  owners: { id: string; name: string }[];
  products: ProductOption[];
  customFieldDefs: CustomFieldDef[];
  currency: string;
  cancelHref: string;
  leadSources: string[];
}) {
  const [result, formAction] = useActionState<ActionResult<unknown> | null, FormData>(action, null);
  const [companyId, setCompanyId] = useState(initial.companyId ?? "");
  const [stageId, setStageId] = useState(initial.stageId ?? stages[0]?.id ?? "");
  const [probability, setProbability] = useState<number | "">(initial.probability ?? stages.find((s) => s.id === stageId)?.probability ?? 10);
  const e = (k: string) => fieldErrors(result, k);
  const companyContacts = contacts.filter((c) => c.companyId === companyId);

  return (
    <form action={formAction} className="space-y-6">
      <FormMessage result={result && !result.ok ? result : null} />
      <section className="grid gap-4 sm:grid-cols-2">
        <Field label="Title" htmlFor="title" required error={e("title")} className="sm:col-span-2">
          <Input id="title" name="title" required maxLength={200} defaultValue={initial.title ?? ""} placeholder="Managed IT for 25 users" />
        </Field>
        <Field label="Company" htmlFor="companyId" required error={e("companyId")}>
          {initial.id ? (
            <>
              <input type="hidden" name="companyId" value={companyId} />
              <Input value={companies.find((c) => c.id === companyId)?.name ?? ""} disabled />
            </>
          ) : (
            <Select id="companyId" name="companyId" required value={companyId} onChange={(ev) => setCompanyId(ev.target.value)}>
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
        <Field label="Primary contact" htmlFor="contactId" error={e("contactId")}>
          <Select id="contactId" name="contactId" defaultValue={initial.contactId ?? ""}>
            <option value="">—</option>
            {companyContacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Stage" htmlFor="stageId" required error={e("stageId")}>
          <Select
            id="stageId"
            name="stageId"
            value={stageId}
            onChange={(ev) => {
              setStageId(ev.target.value);
              const s = stages.find((x) => x.id === ev.target.value);
              if (s) setProbability(s.probability);
            }}
          >
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.probability}%)
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Probability (%)" htmlFor="probability" error={e("probability")} help="Defaults to the stage's probability">
          <Input id="probability" name="probability" type="number" min={0} max={100} value={probability} onChange={(ev) => setProbability(ev.target.value === "" ? "" : Number(ev.target.value))} />
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
        <Field label="Expected close date" htmlFor="expectedCloseDate" error={e("expectedCloseDate")}>
          <Input id="expectedCloseDate" name="expectedCloseDate" type="date" defaultValue={initial.expectedCloseDate ?? ""} />
        </Field>
        <Field label="Lead source" htmlFor="leadSource" error={e("leadSource")}>
          <Input id="leadSource" name="leadSource" defaultValue={initial.leadSource ?? ""} list="lead-sources" placeholder="Referral, website, event…" />
          <datalist id="lead-sources">
            {leadSources.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
        <Field label="Next action" htmlFor="nextAction" error={e("nextAction")}>
          <Input id="nextAction" name="nextAction" defaultValue={initial.nextAction ?? ""} placeholder="Send proposal" />
        </Field>
        <Field label="Next action date" htmlFor="nextActionDate" error={e("nextActionDate")}>
          <Input id="nextActionDate" name="nextActionDate" type="date" defaultValue={initial.nextActionDate ?? ""} />
        </Field>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-800">Products and services</h2>
        <p className="mb-3 text-xs text-slate-500">Recurring lines drive MRR; project and hardware lines are one-off. Leave cost blank if unknown and the margin will be marked as an estimate.</p>
        <LinesEditor initial={lines} products={products} currency={currency} />
        {e("lines") && <p className="field-error">{e("lines")?.[0]}</p>}
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
        <SubmitButton>{initial.id ? "Save changes" : "Create opportunity"}</SubmitButton>
        <ButtonLink href={cancelHref} variant="ghost">
          Cancel
        </ButtonLink>
      </div>
    </form>
  );
}
