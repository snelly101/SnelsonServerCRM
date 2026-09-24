"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Field, Input, Select, Textarea, SubmitButton, FormMessage, fieldErrors, Checkbox } from "@/components/ui/form";
import { createCustomFieldAction, createTagAction } from "@/actions/admin";

const COLORS = ["slate", "red", "orange", "amber", "green", "teal", "blue", "indigo", "purple", "pink"];

function useResetOnSuccess(result: { ok: boolean } | null) {
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (result?.ok) {
      ref.current?.reset();
      router.refresh();
    }
  }, [result, router]);
  return ref;
}

export function TagForm() {
  const [result, formAction] = useActionState(createTagAction, null);
  const ref = useResetOnSuccess(result);
  return (
    <form ref={ref} action={formAction} className="flex flex-wrap items-end gap-2">
      <FormMessage result={result && !result.ok ? result : null} />
      <Field label="New tag" htmlFor="tag-name" error={fieldErrors(result, "name")}>
        <Input id="tag-name" name="name" required maxLength={50} />
      </Field>
      <Field label="Colour" htmlFor="tag-color">
        <Select id="tag-color" name="color" defaultValue="slate">
          {COLORS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </Field>
      <SubmitButton>Add tag</SubmitButton>
    </form>
  );
}

export function CustomFieldForm() {
  const [result, formAction] = useActionState(createCustomFieldAction, null);
  const ref = useResetOnSuccess(result);
  const [type, setType] = useState("text");
  const e = (k: string) => fieldErrors(result, k);
  return (
    <form ref={ref} action={formAction} className="space-y-3">
      <FormMessage result={result && !result.ok ? result : null} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Applies to" htmlFor="cf-entity">
          <Select id="cf-entity" name="entity" defaultValue="company">
            <option value="company">Company</option>
            <option value="contact">Contact</option>
            <option value="opportunity">Opportunity</option>
            <option value="ticket">Helpdesk ticket</option>
          </Select>
        </Field>
        <Field label="Type" htmlFor="cf-type">
          <Select id="cf-type" name="type" value={type} onChange={(ev) => setType(ev.target.value)}>
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
            <option value="boolean">Yes / no</option>
            <option value="select">Dropdown</option>
          </Select>
        </Field>
        <Field label="Label" htmlFor="cf-label" required error={e("label")}>
          <Input id="cf-label" name="label" required maxLength={100} placeholder="Contract reference" />
        </Field>
        <Field label="Key" htmlFor="cf-key" required error={e("key")} help="lower_snake_case, cannot change later">
          <Input id="cf-key" name="key" required pattern="[a-z][a-z0-9_]*" placeholder="contract_ref" />
        </Field>
        {type === "select" && (
          <Field label="Options (one per line)" htmlFor="cf-options" className="sm:col-span-2" error={e("options")}>
            <Textarea id="cf-options" name="options" rows={3} />
          </Field>
        )}
      </div>
      <Checkbox name="required" label="Required" />
      <div>
        <SubmitButton>Add field</SubmitButton>
      </div>
    </form>
  );
}
