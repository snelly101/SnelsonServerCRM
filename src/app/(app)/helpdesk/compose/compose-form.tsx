"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { Paperclip, Send, X, Eye, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Field,
  Input,
  Select,
  SubmitButton,
  FormMessage,
  fieldErrors,
} from "@/components/ui/form";
import { MarkdownEditor } from "@/components/helpdesk/markdown-editor";
import { MarkdownLite } from "@/lib/markdown-lite";
import { composeEmailAction, uploadAttachmentAction } from "@/actions/mailbox";

type Option = { id: string; name: string };
const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

export function ComposeForm({
  companies,
  contacts,
  defaults,
  signature,
}: {
  companies: Option[];
  contacts: (Option & { companyId: string; email: string | null })[];
  defaults: { companyId?: string; contactId?: string; to?: string };
  signature: string | null;
}) {
  const [result, formAction] = useActionState(composeEmailAction, null);
  const [companyId, setCompanyId] = useState(defaults.companyId ?? "");
  const [contactId, setContactId] = useState(defaults.contactId ?? "");
  const initialTo =
    defaults.to ??
    contacts.find((c) => c.id === defaults.contactId)?.email ??
    "";
  const [to, setTo] = useState(initialTo);
  const [body, setBody] = useState("");
  const [uploads, setUploads] = useState<
    { id: string; name: string; size: number }[]
  >([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [key] = useState(newKey);
  const [uploading, startUpload] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (result?.ok) router.push(`/helpdesk/tickets/${result.data.ticketId}`);
  }, [result, router]);
  const visibleContacts = companyId
    ? contacts.filter((c) => c.companyId === companyId)
    : contacts;
  const upload = (files: FileList | null) => {
    if (!files?.length) return;
    setUploadError(null);
    startUpload(async () => {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.set("file", f);
        const r = await uploadAttachmentAction(null, fd);
        if (r.ok) setUploads((u) => [...u, r.data]);
        else setUploadError(r.error);
      }
      if (fileRef.current) fileRef.current.value = "";
    });
  };
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="idempotencyKey" value={key} />
      {uploads.map((u) => (
        <input key={u.id} type="hidden" name="attachmentIds" value={u.id} />
      ))}
      <FormMessage result={result && !result.ok ? result : null} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Company" htmlFor="cp-company">
          <Select
            id="cp-company"
            name="companyId"
            value={companyId}
            onChange={(e) => {
              setCompanyId(e.target.value);
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
          label="Contact"
          htmlFor="cp-contact"
          help="Picking a contact fills the To address and links the ticket to them."
        >
          <Select
            id="cp-contact"
            name="contactId"
            value={contactId}
            onChange={(e) => {
              setContactId(e.target.value);
              const c = contacts.find((x) => x.id === e.target.value);
              if (c?.email) setTo(c.email);
              if (c && !companyId) setCompanyId(c.companyId);
            }}
          >
            <option value="">—</option>
            {visibleContacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.email ? ` (${c.email})` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="To"
          htmlFor="cp-to"
          required
          error={fieldErrors(result, "to")}
        >
          <Input
            id="cp-to"
            name="to"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            required
            placeholder="someone@customer.co.uk"
          />
        </Field>
        <Field label="CC" htmlFor="cp-cc">
          <Input id="cp-cc" name="cc" placeholder="optional" />
        </Field>
        <Field label="BCC (never shown to recipients)" htmlFor="cp-bcc">
          <Input id="cp-bcc" name="bcc" />
        </Field>
        <Field
          label="Subject"
          htmlFor="cp-subject"
          required
          error={fieldErrors(result, "subject")}
        >
          <Input id="cp-subject" name="subject" required maxLength={300} />
        </Field>
      </div>
      {preview ? (
        <div className="rounded-md border border-slate-200 bg-surface p-3 text-sm">
          <MarkdownLite text={body} />
          {signature && (
            <div className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-500">
              <MarkdownLite text={signature} />
            </div>
          )}
          <input type="hidden" name="body" value={body} />
        </div>
      ) : (
        <Field
          label="Message"
          htmlFor="cp-body"
          error={fieldErrors(result, "body")}
        >
          <MarkdownEditor
            id="cp-body"
            name="body"
            value={body}
            onChange={setBody}
            rows={10}
          />
        </Field>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50">
          <Paperclip className="h-3.5 w-3.5" />{" "}
          {uploading ? "Uploading…" : "Attach files"}
          <input
            ref={fileRef}
            type="file"
            multiple
            className="sr-only"
            onChange={(e) => upload(e.target.files)}
            disabled={uploading}
          />
        </label>
        {uploads.map((u) => (
          <Badge key={u.id} tone="slate">
            {u.name}{" "}
            <button
              type="button"
              aria-label={`Remove ${u.name}`}
              className="ml-1 text-slate-500 hover:text-red-700"
              onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        {uploadError && <span className="text-red-700">{uploadError}</span>}
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          type="button"
          onClick={() => setPreview((p) => !p)}
          disabled={!body.trim()}
        >
          {preview ? (
            <>
              <Pencil className="h-4 w-4" /> Edit
            </>
          ) : (
            <>
              <Eye className="h-4 w-4" /> Preview
            </>
          )}
        </Button>
        <SubmitButton disabled={uploading}>
          <Send className="h-4 w-4" /> Send and open ticket
        </SubmitButton>
      </div>
    </form>
  );
}
