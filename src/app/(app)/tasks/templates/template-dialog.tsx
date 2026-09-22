"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Checkbox, SubmitButton, FormMessage, fieldErrors } from "@/components/ui/form";
import { saveTemplateAction } from "@/actions/tasks";
import { ROLES, ROLE_LABELS } from "@/lib/permissions";

type Item = { key: string; title: string; dueOffsetDays: number; defaultOwnerRole: string };
type Template = { id: string; name: string; description: string | null; isDefaultOnboarding: boolean; items: { id: string; title: string; dueOffsetDays: number; defaultOwnerRole: string | null }[] };

let n = 0;
export function TemplateDialog({ template }: { template?: Template }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [result, formAction] = useActionState(saveTemplateAction.bind(null, template?.id ?? null), null);
  const [items, setItems] = useState<Item[]>(template ? template.items.map((i) => ({ key: i.id, title: i.title, dueOffsetDays: i.dueOffsetDays, defaultOwnerRole: i.defaultOwnerRole ?? "" })) : [{ key: "i0", title: "", dueOffsetDays: 7, defaultOwnerRole: "" }]);
  const [isDefault, setIsDefault] = useState(template?.isDefaultOnboarding ?? false);
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);
  const update = (key: string, patch: Partial<Item>) => setItems((is) => is.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size={template ? "sm" : "md"} variant={template ? "ghost" : "primary"} onClick={() => setOpen(true)}>
        {template ? "Edit" : (<><Plus className="h-4 w-4" /> New template</>)}
      </Button>
      <DialogContent title={template ? `Edit ${template.name}` : "New checklist template"} wide>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="isDefaultOnboarding" value={isDefault ? "true" : "false"} />
          <FormMessage result={result && !result.ok ? result : null} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="t-name" required error={fieldErrors(result, "name")}>
              <Input id="t-name" name="name" required defaultValue={template?.name ?? ""} />
            </Field>
            <Field label="Description" htmlFor="t-desc">
              <Input id="t-desc" name="description" defaultValue={template?.description ?? ""} />
            </Field>
          </div>
          <Checkbox label="Use as the default onboarding checklist" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          <div>
            <div className="mb-1 grid grid-cols-[1fr_90px_160px_32px] gap-2 text-xs font-medium text-slate-500">
              <span>Item</span>
              <span>Due (days)</span>
              <span>Default owner</span>
              <span />
            </div>
            <div className="space-y-2">
              {items.map((it, i) => (
                <div key={it.key} className="grid grid-cols-[1fr_90px_160px_32px] gap-2">
                  <Input aria-label="Item title" name={`items[${i}][title]`} value={it.title} onChange={(e) => update(it.key, { title: e.target.value })} required />
                  <Input aria-label="Due offset days" name={`items[${i}][dueOffsetDays]`} type="number" min={0} value={it.dueOffsetDays} onChange={(e) => update(it.key, { dueOffsetDays: Number(e.target.value) })} />
                  <Select aria-label="Default owner role" name={`items[${i}][defaultOwnerRole]`} value={it.defaultOwnerRole} onChange={(e) => update(it.key, { defaultOwnerRole: e.target.value })}>
                    <option value="">Onboarding owner</option>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </Select>
                  <button type="button" aria-label="Remove item" className="rounded p-1 text-slate-400 hover:text-red-600" onClick={() => setItems((is) => is.filter((x) => x.key !== it.key))}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            {fieldErrors(result, "items") && <p className="field-error">{fieldErrors(result, "items")?.[0]}</p>}
            <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => setItems((is) => [...is, { key: `n${n++}`, title: "", dueOffsetDays: 7, defaultOwnerRole: "" }])}>
              <Plus className="h-4 w-4" /> Add item
            </Button>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Save template</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
