"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare, StickyNote, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Field,
  Select,
  SubmitButton,
  FormMessage,
  fieldErrors,
} from "@/components/ui/form";
import { MarkdownEditor } from "@/components/helpdesk/markdown-editor";
import { addMessageAction, saveDraftAction } from "@/actions/helpdesk";
import {
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
} from "@/lib/validation-helpdesk";

/**
 * Reply / note composer. Drafts are saved automatically (debounced) per user
 * and ticket; a stale draft (ticket changed since) is shown with a warning.
 * Stage 1 records public messages by hand (phone, in person); e-mail replies
 * arrive with the mailbox stage.
 */
export function Composer({
  ticketId,
  version,
  draft,
  emailEnabled,
  requesterEmail,
  allowedStatuses,
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
  allowedStatuses: string[];
}) {
  const [kind, setKind] = useState<"public" | "internal">(
    draft?.kind ?? "internal",
  );
  const [body, setBody] = useState(draft?.body ?? "");
  const [savedAt, setSavedAt] = useState<Date | null>(
    draft ? new Date(draft.updatedAt) : null,
  );
  const [result, formAction] = useActionState(
    addMessageAction.bind(null, ticketId),
    null,
  );
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stale =
    draft?.ticketVersion !== null &&
    draft?.ticketVersion !== undefined &&
    draft.ticketVersion < version;
  useEffect(() => {
    if (result?.ok) {
      setBody("");
      setSavedAt(null);
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
  const submitRef = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={submitRef}
      action={formAction}
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
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => setKind("internal")}
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
          No support mailbox is connected yet, so this records what was said to{" "}
          {requesterEmail ?? "the requester"} (by phone or in person) without
          sending anything.
        </p>
      ) : null}
      <FormMessage result={result && !result.ok ? result : null} />
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
          textareaRef={textareaRef}
          rows={6}
          placeholder={
            kind === "internal"
              ? "Notes for the team… use @name to mention someone"
              : "What was said to the customer…"
          }
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter")
              submitRef.current?.requestSubmit();
          }}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          name="status"
          aria-label="Status after sending"
          className="h-9 w-auto text-sm"
          defaultValue=""
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
        <SubmitButton size="sm">
          <Send className="h-3.5 w-3.5" />{" "}
          {kind === "internal" ? "Add note" : "Save message"}
        </SubmitButton>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={() => {
            setBody("");
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
