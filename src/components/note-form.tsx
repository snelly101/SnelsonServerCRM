"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Field, Input, Select, Textarea, SubmitButton, FormMessage, fieldErrors } from "@/components/ui/form";
import { addNoteAction } from "@/actions/companies";

export function NoteForm({ companyId, contacts }: { companyId: string; contacts: { id: string; name: string }[] }) {
  const [result, formAction] = useActionState(addNoteAction, null);
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (result?.ok) {
      ref.current?.reset();
      router.refresh();
    }
  }, [result, router]);
  return (
    <form ref={ref} action={formAction} className="space-y-3">
      <input type="hidden" name="companyId" value={companyId} />
      <FormMessage result={result && !result.ok ? result : null} />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Type" htmlFor="note-type">
          <Select id="note-type" name="type" defaultValue="note">
            <option value="note">Note</option>
            <option value="call">Call</option>
            <option value="email">Email</option>
            <option value="meeting">Meeting</option>
          </Select>
        </Field>
        <Field label="Contact" htmlFor="note-contact">
          <Select id="note-contact" name="contactId" defaultValue="">
            <option value="">—</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Title" htmlFor="note-title" required error={fieldErrors(result, "title")}>
        <Input id="note-title" name="title" required maxLength={200} placeholder="Called about renewal" />
      </Field>
      <Field label="Details" htmlFor="note-body">
        <Textarea id="note-body" name="body" rows={3} />
      </Field>
      <SubmitButton size="sm">Add to timeline</SubmitButton>
    </form>
  );
}
