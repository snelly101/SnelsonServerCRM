"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Field,
  Input,
  Select,
  SubmitButton,
  FormMessage,
  fieldErrors,
} from "@/components/ui/form";
import { MarkdownEditor } from "@/components/helpdesk/markdown-editor";
import { createTicketAction } from "@/actions/helpdesk";
import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_TYPES,
  TICKET_TYPE_LABELS,
} from "@/lib/validation-helpdesk";

type Option = { id: string; name: string };
type CustomFieldDef = {
  key: string;
  label: string;
  type: string;
  options: string[] | null;
  required: boolean;
};

export function NewTicketForm({
  contacts,
  companies,
  agents,
  teams,
  categories,
  customFields,
  defaults,
}: {
  contacts: (Option & { companyId: string })[];
  companies: Option[];
  agents: Option[];
  teams: Option[];
  categories: (Option & { children: Option[] })[];
  customFields: CustomFieldDef[];
  defaults?: { companyId?: string; contactId?: string };
}) {
  const [result, formAction] = useActionState(createTicketAction, null);
  const [description, setDescription] = useState("");
  const [companyId, setCompanyId] = useState(defaults?.companyId ?? "");
  const [contactId, setContactId] = useState(defaults?.contactId ?? "");
  const [categoryId, setCategoryId] = useState("");
  const router = useRouter();
  const e = (k: string) => fieldErrors(result, k);
  useEffect(() => {
    if (result?.ok) router.push(`/helpdesk/tickets/${result.data.id}`);
  }, [result, router]);
  const visibleContacts = companyId
    ? contacts.filter((c) => c.companyId === companyId)
    : contacts;
  const subs = categories.find((c) => c.id === categoryId)?.children ?? [];
  return (
    <form action={formAction} className="space-y-4">
      <FormMessage result={result && !result.ok ? result : null} />
      <Field label="Subject" htmlFor="t-subject" required error={e("subject")}>
        <Input
          id="t-subject"
          name="subject"
          required
          maxLength={300}
          autoFocus
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Company" htmlFor="t-company" error={e("companyId")}>
          <Select
            id="t-company"
            name="companyId"
            value={companyId}
            onChange={(ev) => {
              setCompanyId(ev.target.value);
              setContactId("");
            }}
          >
            <option value="">—</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Requester (contact)"
          htmlFor="t-contact"
          error={e("requesterContactId")}
          help="Or enter a name and e-mail below for someone not in the CRM yet."
        >
          <Select
            id="t-contact"
            name="requesterContactId"
            value={contactId}
            onChange={(ev) => setContactId(ev.target.value)}
          >
            <option value="">—</option>
            {visibleContacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        {!contactId && (
          <>
            <Field
              label="Requester name"
              htmlFor="t-rname"
              error={e("requesterName")}
            >
              <Input id="t-rname" name="requesterName" maxLength={200} />
            </Field>
            <Field
              label="Requester e-mail"
              htmlFor="t-remail"
              error={e("requesterEmail")}
            >
              <Input id="t-remail" name="requesterEmail" type="email" />
            </Field>
          </>
        )}
        <Field label="Priority" htmlFor="t-priority">
          <Select id="t-priority" name="priority" defaultValue="normal">
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {TICKET_PRIORITY_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Type" htmlFor="t-type">
          <Select id="t-type" name="type" defaultValue="incident">
            {TICKET_TYPES.map((t) => (
              <option key={t} value={t}>
                {TICKET_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Category" htmlFor="t-category">
          <Select
            id="t-category"
            name="categoryId"
            value={categoryId}
            onChange={(ev) => setCategoryId(ev.target.value)}
          >
            <option value="">—</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Subcategory" htmlFor="t-subcategory">
          <Select
            id="t-subcategory"
            name="subcategoryId"
            disabled={subs.length === 0}
            defaultValue=""
          >
            <option value="">—</option>
            {subs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Assign to" htmlFor="t-assignee">
          <Select id="t-assignee" name="assigneeUserId" defaultValue="">
            <option value="">— unassigned —</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Team" htmlFor="t-team">
          <Select id="t-team" name="teamId" defaultValue="">
            <option value="">—</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Tags" htmlFor="t-tags" help="Comma separated.">
          <Input id="t-tags" name="tags" placeholder="vpn, laptop" />
        </Field>
        {customFields.map((f) => (
          <Field
            key={f.key}
            label={f.label}
            htmlFor={`cf-${f.key}`}
            required={f.required}
            error={e(`customFields.${f.key}`)}
          >
            {f.type === "select" ? (
              <Select id={`cf-${f.key}`} name={`cf.${f.key}`} defaultValue="">
                <option value="">—</option>
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            ) : f.type === "boolean" ? (
              <Select id={`cf-${f.key}`} name={`cf.${f.key}`} defaultValue="">
                <option value="">—</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            ) : (
              <Input
                id={`cf-${f.key}`}
                name={`cf.${f.key}`}
                type={
                  f.type === "number"
                    ? "number"
                    : f.type === "date"
                      ? "date"
                      : "text"
                }
              />
            )}
          </Field>
        ))}
      </div>
      <Field
        label="Description"
        htmlFor="t-description"
        error={e("description")}
        help="What is wrong, what was tried, and how urgent it is. Becomes the first message on the ticket."
      >
        <MarkdownEditor
          id="t-description"
          name="description"
          value={description}
          onChange={setDescription}
          rows={8}
        />
      </Field>
      <div className="flex justify-end">
        <SubmitButton>Create ticket</SubmitButton>
      </div>
    </form>
  );
}
