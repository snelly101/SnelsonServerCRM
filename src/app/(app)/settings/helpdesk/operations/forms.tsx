"use client";

import { useActionState } from "react";
import { Field, Input, SubmitButton, FormMessage, fieldErrors } from "@/components/ui/form";
import { anonymiseByEmailAction } from "@/actions/helpdesk-kb";

export function DataRequestForm() {
  const [result, formAction] = useActionState(anonymiseByEmailAction, null);
  return (
    <form action={formAction} className="space-y-2" aria-label="Data-subject request">
      <FormMessage result={result && !result.ok ? result : null} />
      {result?.ok && (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800" role="status">
          {result.data.tickets} ticket{result.data.tickets === 1 ? "" : "s"} anonymised.
        </p>
      )}
      <Field label="Requester e-mail" htmlFor="dsr-email" required error={fieldErrors(result, "email")}>
        <Input id="dsr-email" name="email" type="email" required placeholder="person@customer.co.uk" />
      </Field>
      <SubmitButton variant="secondary">Anonymise their tickets</SubmitButton>
    </form>
  );
}
