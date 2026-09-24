"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Heading2, Bold, List, Link2, Eye, Pencil } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Field,
  Input,
  Textarea,
  Checkbox,
  SubmitButton,
  FormMessage,
  fieldErrors,
} from "@/components/ui/form";
import { MarkdownLite } from "@/lib/markdown-lite";
import { saveNoteAction } from "@/actions/notes";

export type NoteForEdit = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
};

/**
 * Create / edit a company note. The body is Markdown; the toolbar inserts
 * the syntax at the cursor and a preview renders it with the same safe
 * renderer the page uses, so what you see is what everyone gets.
 */
export function NoteDialog({
  companyId,
  note,
  trigger,
}: {
  companyId: string;
  note?: NoteForEdit;
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [body, setBody] = useState(note?.body ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();
  const [result, formAction] = useActionState(
    saveNoteAction.bind(null, note?.id ?? null),
    null,
  );
  const e = (k: string) => fieldErrors(result, k);

  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      setPreview(false);
      if (!note) setBody("");
      router.refresh();
    }
  }, [result, router, note]);

  useEffect(() => {
    if (open) setBody(note?.body ?? "");
  }, [open, note]);

  /** Wraps the selection (or inserts a placeholder) with Markdown syntax, keeping focus in the textarea. */
  const insert = (
    before: string,
    after = "",
    placeholder = "text",
    linePrefix = false,
  ) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = body.slice(start, end) || placeholder;
    let next: string;
    let cursor: number;
    if (linePrefix) {
      const lineStart = body.lastIndexOf("\n", start - 1) + 1;
      next = body.slice(0, lineStart) + before + body.slice(lineStart);
      cursor = end + before.length;
    } else {
      next = body.slice(0, start) + before + selected + after + body.slice(end);
      cursor = start + before.length + selected.length + after.length;
    }
    setBody(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(cursor, cursor);
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? (
        <span onClick={() => setOpen(true)}>{trigger}</span>
      ) : (
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden /> Add note
        </Button>
      )}
      <DialogContent
        title={note ? "Edit note" : "Add note"}
        description="Standing information about this customer: access details, escalation contacts, preferences."
        wide
      >
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="companyId" value={companyId} />
          <FormMessage result={result && !result.ok ? result : null} />
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <Field
              label="Title"
              htmlFor="note-title"
              required
              error={e("title")}
            >
              <Input
                id="note-title"
                name="title"
                required
                maxLength={120}
                defaultValue={note?.title ?? ""}
                placeholder="Site access"
              />
            </Field>
            <div className="flex items-end pb-1">
              <Checkbox
                name="pinned"
                value="true"
                defaultChecked={note?.pinned ?? false}
                label="Pin to Overview"
              />
            </div>
          </div>
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-1">
              <span className="field-label mb-0 mr-2">Note</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                title="Heading"
                aria-label="Heading"
                onClick={() => insert("## ", "", "", true)}
                disabled={preview}
              >
                <Heading2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                title="Bold"
                aria-label="Bold"
                onClick={() => insert("**", "**")}
                disabled={preview}
              >
                <Bold className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                title="Bullet list"
                aria-label="Bullet list"
                onClick={() => insert("- ", "", "", true)}
                disabled={preview}
              >
                <List className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                title="Link"
                aria-label="Link"
                onClick={() => insert("[", "](https://)", "link text")}
                disabled={preview}
              >
                <Link2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <Button
                type="button"
                size="sm"
                variant={preview ? "secondary" : "ghost"}
                className="ml-auto"
                onClick={() => setPreview((p) => !p)}
                aria-pressed={preview}
              >
                {preview ? (
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <Eye className="h-3.5 w-3.5" aria-hidden />
                )}{" "}
                {preview ? "Edit" : "Preview"}
              </Button>
            </div>
            {preview ? (
              <div className="min-h-[200px] rounded-md border border-slate-200 bg-slate-50 p-3">
                {body.trim() ? (
                  <MarkdownLite text={body} />
                ) : (
                  <p className="text-sm text-slate-400">
                    Nothing to preview yet.
                  </p>
                )}
              </div>
            ) : (
              <Textarea
                ref={textareaRef}
                id="note-body"
                name="body"
                rows={10}
                value={body}
                onChange={(ev) => setBody(ev.target.value)}
                className="font-mono text-[13px]"
                placeholder={
                  "## Access\n- Key safe code with reception\n- Server room: **second floor**, badge required"
                }
              />
            )}
            {preview && <input type="hidden" name="body" value={body} />}
            <p className="field-help">
              Formatting: <code>## heading</code>, <code>**bold**</code>,{" "}
              <code>*italic*</code>, <code>- bullet</code>,{" "}
              <code>1. numbered</code>, <code>[text](https://…)</code>. Plain
              text works too.
            </p>
            {e("body") && (
              <p className="field-error">{e("body")!.join(", ")}</p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <SubmitButton>{note ? "Save note" : "Add note"}</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
