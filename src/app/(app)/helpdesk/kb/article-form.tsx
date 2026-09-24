"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Field,
  Input,
  SubmitButton,
  FormMessage,
  fieldErrors,
  Checkbox,
} from "@/components/ui/form";
import { MarkdownEditor } from "@/components/helpdesk/markdown-editor";
import { saveArticleAction } from "@/actions/helpdesk-kb";

export function ArticleForm({
  article,
  canManage,
  fromTicketId,
  initialTitle,
  initialBody,
}: {
  article?: {
    id: string;
    title: string;
    body: string;
    summary: string | null;
    category: string | null;
    tags: string[];
    customerVisible: boolean;
    reviewDueAt: Date | null;
  };
  canManage: boolean;
  fromTicketId?: string | null;
  initialTitle?: string;
  initialBody?: string;
}) {
  const router = useRouter();
  const [body, setBody] = useState(article?.body ?? initialBody ?? "");
  const [result, formAction] = useActionState(
    saveArticleAction.bind(null, article?.id ?? null),
    null,
  );
  useEffect(() => {
    if (result?.ok) {
      router.push(`/helpdesk/kb/${result.data.id}`);
      router.refresh();
    }
  }, [result, router]);
  return (
    <form action={formAction} className="space-y-3" aria-label="Article">
      <FormMessage result={result && !result.ok ? result : null} />
      {fromTicketId && <input type="hidden" name="fromTicketId" value={fromTicketId} />}
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Field label="Title" htmlFor="kb-title" required error={fieldErrors(result, "title")}>
          <Input id="kb-title" name="title" defaultValue={article?.title ?? initialTitle ?? ""} required />
        </Field>
        <Field label="Category" htmlFor="kb-category">
          <Input id="kb-category" name="category" defaultValue={article?.category ?? ""} placeholder="e.g. Microsoft 365" />
        </Field>
      </div>
      <Field label="Summary (shown in lists and suggestions)" htmlFor="kb-summary" error={fieldErrors(result, "summary")}>
        <Input id="kb-summary" name="summary" defaultValue={article?.summary ?? ""} maxLength={500} />
      </Field>
      <Field label="Article (Markdown)" htmlFor="kb-body" error={fieldErrors(result, "body")}>
        <MarkdownEditor id="kb-body" name="body" value={body} onChange={setBody} rows={16} placeholder="## Symptoms\n\n## Fix\n\n1. …" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Tags (comma separated)" htmlFor="kb-tags">
          <Input id="kb-tags" name="tags" defaultValue={article?.tags.join(", ") ?? ""} />
        </Field>
        <Field label="Review due" htmlFor="kb-review">
          <Input id="kb-review" name="reviewDueAt" type="date" defaultValue={article?.reviewDueAt ? article.reviewDueAt.toISOString().slice(0, 10) : ""} />
        </Field>
        <Field label="Change note" htmlFor="kb-note">
          <Input id="kb-note" name="changeNote" placeholder="What changed and why" />
        </Field>
      </div>
      <Checkbox
        name="customerVisible"
        value="true"
        label={canManage ? "Customer-visible (may be inserted into replies to customers)" : "Customer-visible (helpdesk managers only)"}
        defaultChecked={article?.customerVisible ?? false}
        disabled={!canManage}
      />
      {fieldErrors(result, "customerVisible") && (
        <p className="text-xs text-red-700">{fieldErrors(result, "customerVisible")?.join(", ")}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
        <SubmitButton>{article ? "Save changes" : "Create article"}</SubmitButton>
      </div>
    </form>
  );
}
