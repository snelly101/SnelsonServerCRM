"use client";

import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Field,
  Input,
  Select,
  Textarea,
  SubmitButton,
  FormMessage,
  fieldErrors,
} from "@/components/ui/form";
import {
  addChecklistAction,
  deleteChecklistAction,
  toggleChecklistAction,
} from "@/actions/helpdesk-collab";
import { fmtDate, type DisplaySettings } from "@/lib/format";

export type ChecklistItem = {
  id: string;
  title: string;
  done: boolean;
  assigneeUserId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
};

export function Checklist({
  ticketId,
  items,
  agents,
  editable,
  settings,
}: {
  ticketId: string;
  items: ChecklistItem[];
  agents: { id: string; name: string }[];
  editable: boolean;
  settings: DisplaySettings;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setError(r.ok ? null : (r.error ?? "Failed"));
      router.refresh();
    });
  // Optimistic ticks: the server confirms on refresh, and props then win.
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const doneKey = useMemo(() => items.map((i) => `${i.id}:${i.done}`).join(","), [items]);
  useEffect(() => setOverride({}), [doneKey]);
  const isDone = (i: ChecklistItem) => override[i.id] ?? i.done;
  const done = items.filter(isDone).length;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <section className="rounded-lg border border-slate-200 bg-surface p-3 text-sm" aria-label="Checklist">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Checklist{items.length ? ` ${done}/${items.length}` : ""}
        </h3>
        {editable && <AddDialog ticketId={ticketId} agents={agents} />}
      </div>
      {error && <p className="mb-1 text-xs text-red-700">{error}</p>}
      {items.length === 0 ? (
        <p className="text-xs text-slate-400">No items.</p>
      ) : (
        <>
          <div className="mb-2 h-1.5 overflow-hidden rounded bg-slate-100">
            <div className="h-full bg-green-500" style={{ width: `${(done / items.length) * 100}%` }} />
          </div>
          <ul className="space-y-1">
            {items.map((i) => (
              <li key={i.id} className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  aria-label={i.title}
                  checked={isDone(i)}
                  disabled={!editable}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setOverride((o) => ({ ...o, [i.id]: next }));
                    run(() => toggleChecklistAction(ticketId, i.id, next));
                  }}
                  className="mt-0.5 h-3.5 w-3.5 accent-brand-600"
                />
                <span className={`min-w-0 flex-1 ${isDone(i) ? "text-slate-400 line-through" : "text-slate-800"}`}>
                  {i.title}
                  {(i.assigneeName || i.dueDate) && (
                    <span className="ml-1 text-slate-400">
                      {i.assigneeName ? `· ${i.assigneeName}` : ""}
                      {i.dueDate ? (
                        <span className={!isDone(i) && i.dueDate < today ? " text-red-600" : ""}>
                          {" "}· due {fmtDate(i.dueDate, settings)}
                        </span>
                      ) : null}
                    </span>
                  )}
                </span>
                {editable && (
                  <button
                    type="button"
                    aria-label={`Remove ${i.title}`}
                    className="text-slate-300 hover:text-red-700"
                    onClick={() => run(() => deleteChecklistAction(ticketId, i.id))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function AddDialog({ ticketId, agents }: { ticketId: string; agents: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [result, formAction] = useActionState(addChecklistAction.bind(null, ticketId), null);
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" /> Add
      </Button>
      <DialogContent title="Add checklist items">
        <form action={formAction} className="space-y-3">
          <FormMessage result={result && !result.ok ? result : null} />
          <Field label="Items (one per line)" htmlFor="cl-items" required error={fieldErrors(result, "items")}>
            <Textarea id="cl-items" name="items" rows={5} placeholder={"Back up mailbox\nRemove licence\nDisable account"} required />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Assign to" htmlFor="cl-assignee">
              <Select id="cl-assignee" name="assigneeUserId" defaultValue="">
                <option value="">nobody</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Due" htmlFor="cl-due">
              <Input id="cl-due" name="dueDate" type="date" />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Add items</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
