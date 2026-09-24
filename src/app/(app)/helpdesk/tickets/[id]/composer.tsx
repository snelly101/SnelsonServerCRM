"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import {
  MessageSquare,
  StickyNote,
  Send,
  Paperclip,
  X,
  Eye,
  Pencil,
  FileText,
} from "lucide-react";
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
import { addMessageAction, saveDraftAction } from "@/actions/helpdesk";
import { sendReplyAction, uploadAttachmentAction } from "@/actions/mailbox";
import { renderTemplateAction } from "@/actions/helpdesk-collab";
import {
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
} from "@/lib/validation-helpdesk";

type Upload = { id: string; name: string; size: number };
const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

/**
 * Reply / note composer. Internal notes are never e-mailed. With a mailbox
 * connected, "Reply to customer" sends through it (To/CC/BCC editable,
 * attachments uploaded and scanned first, preview before sending, an
 * idempotency key so a double click or retry never sends twice). Without
 * one it logs the message. Drafts save automatically per user.
 */
export function Composer({
  ticketId,
  version,
  draft,
  emailEnabled,
  requesterEmail,
  ccDefaults,
  allowedStatuses,
  signature,
  templates = [],
  openChecklist = 0,
}: {
  ticketId: string;
  version: number;
  draft: {
    kind: "public" | "internal";
    body: string;
    ticketVersion: number | null;
    updatedAt: Date;
  } | null;
  emailEnabled: boolean;
  requesterEmail: string | null;
  ccDefaults: string[];
  allowedStatuses: string[];
  signature: string | null;
  templates?: { id: string; name: string; scope: string; body: string; category: string | null }[];
  /** Open checklist items: shown as a warning next to "then mark resolved". */
  openChecklist?: number;
}) {
  const [kind, setKind] = useState<"public" | "internal">(
    draft?.kind ?? "internal",
  );
  const [body, setBody] = useState(draft?.body ?? "");
  const [savedAt, setSavedAt] = useState<Date | null>(
    draft ? new Date(draft.updatedAt) : null,
  );
  const [to, setTo] = useState(requesterEmail ?? "");
  const [cc, setCc] = useState(ccDefaults.join(", "));
  const [bcc, setBcc] = useState("");
  const [showBcc, setShowBcc] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [key, setKey] = useState(newKey);
  const [noteResult, noteAction] = useActionState(
    addMessageAction.bind(null, ticketId),
    null,
  );
  const [mailResult, mailAction] = useActionState(
    sendReplyAction.bind(null, ticketId),
    null,
  );
  const [uploading, startUpload] = useTransition();
  const [inserting, startInsert] = useTransition();
  const [statusAfter, setStatusAfter] = useState("");
  const usable = templates.filter(
    (t) => t.scope === "both" || t.scope === (kind === "internal" ? "internal" : "public"),
  );
  const insertTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    startInsert(async () => {
      const r = await renderTemplateAction(ticketId, t.body);
      const text = r.ok ? r.data.body : t.body;
      onChange(body.trim() ? `${body.replace(/\s+$/, "")}\n\n${text}` : text);
    });
  };
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stale =
    draft?.ticketVersion !== null &&
    draft?.ticketVersion !== undefined &&
    draft.ticketVersion < version;
  const email = emailEnabled && kind === "public";
  const result = email ? mailResult : noteResult;
  useEffect(() => {
    if (result?.ok) {
      setBody("");
      setUploads([]);
      setPreview(false);
      setSavedAt(null);
      setKey(newKey());
      router.refresh();
    }
  }, [result, router]);
  const onChange = (v: string) => {
    setBody(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const r = await saveDraftAction(ticketId, {
        kind,
        body: v,
        ticketVersion: version,
      });
      if (r.ok) setSavedAt(v.trim() ? new Date() : null);
    }, 800);
  };
  const upload = (files: FileList | null) => {
    if (!files?.length) return;
    setUploadError(null);
    startUpload(async () => {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.set("file", f);
        const r = await uploadAttachmentAction(ticketId, fd);
        if (r.ok) setUploads((u) => [...u, r.data]);
        else setUploadError(r.error);
      }
      if (fileRef.current) fileRef.current.value = "";
    });
  };
  return (
    <form
      ref={formRef}
      action={email ? mailAction : noteAction}
      className="space-y-2"
      aria-label="Add to conversation"
    >
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="kind" value={kind} />
      <input
        type="hidden"
        name="channel"
        value={kind === "internal" ? "note" : "manual"}
      />
      <input type="hidden" name="idempotencyKey" value={key} />
      {uploads.map((u) => (
        <input key={u.id} type="hidden" name="attachmentIds" value={u.id} />
      ))}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => {
            setKind("internal");
            setPreview(false);
          }}
          aria-pressed={kind === "internal"}
          className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-sm ${kind === "internal" ? "bg-amber-100 text-amber-900" : "text-slate-600 hover:bg-slate-100"}`}
        >
          <StickyNote className="h-3.5 w-3.5" /> Internal note
        </button>
        <button
          type="button"
          onClick={() => setKind("public")}
          aria-pressed={kind === "public"}
          className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-sm ${kind === "public" ? "bg-brand-100 text-brand-800" : "text-slate-600 hover:bg-slate-100"}`}
        >
          <MessageSquare className="h-3.5 w-3.5" />{" "}
          {emailEnabled ? "Reply to customer" : "Log customer message"}
        </button>
        {usable.length > 0 && !preview && (
          <label className="ml-1 inline-flex items-center gap-1 text-xs text-slate-600">
            <FileText className="h-3.5 w-3.5" aria-hidden />
            <Select
              aria-label="Insert template"
              className="h-7 w-auto text-xs"
              value=""
              disabled={inserting}
              onChange={(e) => {
                insertTemplate(e.target.value);
              }}
            >
              <option value="">{inserting ? "Inserting…" : "Insert template…"}</option>
              {usable.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.category ? `${t.category}: ` : ""}
                  {t.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        <span className="ml-auto text-xs text-slate-500">
          {savedAt ? `Draft saved ${savedAt.toLocaleTimeString()}` : ""}
        </span>
      </div>
      {stale && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
          This ticket changed since your draft was saved. Check the conversation
          before sending.
        </p>
      )}
      {kind === "internal" ? (
        <p className="text-xs text-slate-500">
          Internal notes are never e-mailed and never shown to customers.
        </p>
      ) : !emailEnabled ? (
        <p className="text-xs text-slate-500">
          No support mailbox is connected, so this records what was said to{" "}
          {requesterEmail ?? "the requester"} (by phone or in person) without
          sending anything.
        </p>
      ) : null}
      <FormMessage result={result && !result.ok ? result : null} />
      {email && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field
            label="To"
            htmlFor="composer-to"
            required
            error={fieldErrors(result, "to")}
          >
            <Input
              id="composer-to"
              name="to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="customer@example.com, other@example.com"
            />
          </Field>
          <Field label="CC" htmlFor="composer-cc">
            <Input
              id="composer-cc"
              name="cc"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="optional"
            />
          </Field>
          {showBcc ? (
            <Field
              label="BCC (never shown to recipients)"
              htmlFor="composer-bcc"
            >
              <Input
                id="composer-bcc"
                name="bcc"
                value={bcc}
                onChange={(e) => setBcc(e.target.value)}
              />
            </Field>
          ) : (
            <button
              type="button"
              className="justify-self-start text-xs text-brand-700 hover:underline"
              onClick={() => setShowBcc(true)}
            >
              Add BCC
            </button>
          )}
        </div>
      )}
      {preview && email ? (
        <div
          className="rounded-md border border-slate-200 bg-surface p-3 text-sm"
          aria-live="polite"
        >
          <p className="mb-1 text-xs text-slate-500">
            To: {to || "—"}
            {cc && ` · CC: ${cc}`}
            {bcc && ` · BCC: ${bcc}`}
          </p>
          <MarkdownLite text={body} />
          {signature && (
            <div className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-500">
              <MarkdownLite text={signature} />
            </div>
          )}
          {uploads.length > 0 && (
            <p className="mt-2 text-xs text-slate-500">
              Attachments: {uploads.map((u) => u.name).join(", ")}
            </p>
          )}
        </div>
      ) : (
        <Field
          label={kind === "internal" ? "Note" : "Message"}
          htmlFor="composer-body"
          error={fieldErrors(result, "body")}
        >
          <MarkdownEditor
            id="composer-body"
            name="body"
            value={body}
            onChange={onChange}
            rows={6}
            placeholder={
              kind === "internal"
                ? "Notes for the team… use @name to mention someone"
                : emailEnabled
                  ? "Your reply to the customer…"
                  : "What was said to the customer…"
            }
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter")
                formRef.current?.requestSubmit();
            }}
          />
        </Field>
      )}
      {preview && email && <input type="hidden" name="body" value={body} />}
      {kind === "public" && emailEnabled && (
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
              <span className="ml-1 text-slate-400">
                {Math.max(1, Math.round(u.size / 1024))} KB
              </span>
              <button
                type="button"
                aria-label={`Remove ${u.name}`}
                className="ml-1 text-slate-500 hover:text-red-700"
                onClick={() =>
                  setUploads((x) => x.filter((y) => y.id !== u.id))
                }
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          {uploadError && <span className="text-red-700">{uploadError}</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          name="status"
          aria-label="Status after sending"
          className="h-9 w-auto text-sm"
          value={statusAfter}
          onChange={(e) => setStatusAfter(e.target.value)}
        >
          <option value="">Keep status</option>
          {TICKET_STATUSES.filter((s) => allowedStatuses.includes(s)).map(
            (s) => (
              <option key={s} value={s}>
                then mark {TICKET_STATUS_LABELS[s].toLowerCase()}
              </option>
            ),
          )}
        </Select>
        {email && (
          <Button
            size="sm"
            variant="secondary"
            type="button"
            onClick={() => setPreview((p) => !p)}
            disabled={!body.trim()}
          >
            {preview ? (
              <>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </>
            ) : (
              <>
                <Eye className="h-3.5 w-3.5" /> Preview
              </>
            )}
          </Button>
        )}
        {openChecklist > 0 && (statusAfter === "resolved" || statusAfter === "closed") && (
          <span className="text-xs text-amber-700">
            {openChecklist} checklist item{openChecklist === 1 ? "" : "s"} still open
          </span>
        )}
        <SubmitButton size="sm" disabled={uploading}>
          <Send className="h-3.5 w-3.5" />{" "}
          {kind === "internal"
            ? "Add note"
            : email
              ? "Send e-mail"
              : "Save message"}
        </SubmitButton>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={() => {
            setBody("");
            setUploads([]);
            void saveDraftAction(ticketId, {
              kind,
              body: "",
              ticketVersion: version,
            });
            setSavedAt(null);
          }}
          disabled={!body}
        >
          Discard
        </Button>
        <span className="text-[11px] text-slate-400">Ctrl+Enter to submit</span>
      </div>
    </form>
  );
}
