"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Field,
  Input,
  Select,
  SubmitButton,
  FormMessage,
  fieldErrors,
  Checkbox,
} from "@/components/ui/form";
import { MarkdownEditor } from "@/components/helpdesk/markdown-editor";
import { saveTemplateAction } from "@/actions/helpdesk-admin";

export function TemplateDialog({
  template,
}: {
  template?: {
    id: string;
    name: string;
    scope: string;
    subject: string | null;
    body: string;
    category: string | null;
    active: boolean;
  };
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(template?.body ?? "");
  const router = useRouter();
  const [result, formAction] = useActionState(
    saveTemplateAction.bind(null, template?.id ?? null),
    null,
  );
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant={template ? "ghost" : "primary"} onClick={() => setOpen(true)}>
        {template ? (
          <>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </>
        ) : (
          <>
            <Plus className="h-4 w-4" /> New template
          </>
        )}
      </Button>
      <DialogContent title={template ? `Edit ${template.name}` : "New template"} wide>
        <form action={formAction} className="space-y-3">
          <FormMessage result={result && !result.ok ? result : null} />
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
            <Field label="Name" htmlFor="tpl-name" required error={fieldErrors(result, "name")}>
              <Input id="tpl-name" name="name" defaultValue={template?.name ?? ""} required />
            </Field>
            <Field label="Use for" htmlFor="tpl-scope">
              <Select id="tpl-scope" name="scope" defaultValue={template?.scope ?? "public"}>
                <option value="public">Customer replies</option>
                <option value="internal">Internal notes</option>
                <option value="both">Both</option>
              </Select>
            </Field>
            <Field label="Category" htmlFor="tpl-cat">
              <Input id="tpl-cat" name="category" defaultValue={template?.category ?? ""} placeholder="e.g. Accounts" />
            </Field>
          </div>
          <Field label="Subject (optional, for new e-mails)" htmlFor="tpl-subject">
            <Input id="tpl-subject" name="subject" defaultValue={template?.subject ?? ""} />
          </Field>
          <Field label="Body" htmlFor="tpl-body" required error={fieldErrors(result, "body")}>
            <MarkdownEditor
              id="tpl-body"
              name="body"
              value={body}
              onChange={setBody}
              rows={8}
              placeholder={"Hi {{requester.first_name}},\n\n…\n\n{{agent.name}}"}
            />
          </Field>
          <Checkbox name="active" value="true" label="Active" defaultChecked={template?.active ?? true} />
          <input type="hidden" name="active" value="false" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Save template</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
