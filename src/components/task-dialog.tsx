"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea, SubmitButton, FormMessage, fieldErrors } from "@/components/ui/form";
import { saveTaskAction } from "@/actions/tasks";

type Defaults = { companyId?: string | null; opportunityId?: string | null; contractId?: string | null; onboardingId?: string | null };

export function TaskDialog({
  owners,
  defaults = {},
  task,
  companies,
  label = "Add task",
}: {
  owners: { id: string; name: string }[];
  defaults?: Defaults;
  task?: { id: string; title: string; description: string | null; priority: string; dueDate: string | null; ownerUserId: string | null; companyId: string | null };
  companies?: { id: string; name: string }[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [result, formAction] = useActionState(saveTaskAction.bind(null, task?.id ?? null), null);
  const e = (k: string) => fieldErrors(result, k);
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant={task ? "ghost" : "primary"} onClick={() => setOpen(true)}>
        {task ? "Edit" : (<><Plus className="h-4 w-4" /> {label}</>)}
      </Button>
      <DialogContent title={task ? "Edit task" : "New task"}>
        <form action={formAction} className="space-y-3">
          {defaults.opportunityId && <input type="hidden" name="opportunityId" value={defaults.opportunityId} />}
          {defaults.contractId && <input type="hidden" name="contractId" value={defaults.contractId} />}
          {defaults.onboardingId && <input type="hidden" name="onboardingId" value={defaults.onboardingId} />}
          {(defaults.companyId || task?.companyId) && !companies && <input type="hidden" name="companyId" value={defaults.companyId ?? task?.companyId ?? ""} />}
          <FormMessage result={result && !result.ok ? result : null} />
          <Field label="Title" htmlFor="task-title" required error={e("title")}>
            <Input id="task-title" name="title" required maxLength={200} defaultValue={task?.title ?? ""} autoFocus />
          </Field>
          {companies && (
            <Field label="Company" htmlFor="task-company" error={e("companyId")}>
              <Select id="task-company" name="companyId" defaultValue={task?.companyId ?? defaults.companyId ?? ""}>
                <option value="">—</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="grid grid-cols-3 gap-2">
            <Field label="Due" htmlFor="task-due" error={e("dueDate")}>
              <Input id="task-due" name="dueDate" type="date" defaultValue={task?.dueDate ?? ""} />
            </Field>
            <Field label="Priority" htmlFor="task-priority">
              <Select id="task-priority" name="priority" defaultValue={task?.priority ?? "normal"}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </Select>
            </Field>
            <Field label="Owner" htmlFor="task-owner">
              <Select id="task-owner" name="ownerUserId" defaultValue={task?.ownerUserId ?? ""}>
                <option value="">Me</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Details" htmlFor="task-desc">
            <Textarea id="task-desc" name="description" rows={2} defaultValue={task?.description ?? ""} />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Save task</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
