"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, SubmitButton, FormMessage, fieldErrors } from "@/components/ui/form";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { archiveStageAction, reorderStagesAction, saveStageAction } from "@/actions/sales";

type Stage = { id: string; name: string; probability: number; color: string; isWon: boolean; isLost: boolean };
const COLORS = ["slate", "blue", "indigo", "amber", "teal", "purple", "pink", "orange"];

export function StageEditor({ stages }: { stages: Stage[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const move = (i: number, dir: -1 | 1) => {
    const ids = stages.map((s) => s.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    start(async () => {
      const res = await reorderStagesAction(ids);
      if (!res.ok) setError(res.error);
      router.refresh();
    });
  };
  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-600">{error}</p>}
      <ul className={`divide-y divide-slate-100 rounded-md border border-slate-200 ${pending ? "opacity-70" : ""}`}>
        {stages.map((s, i) => (
          <li key={s.id} className="flex items-center gap-3 px-3 py-2">
            <Badge tone={s.color}>{s.name}</Badge>
            <span className="text-xs text-slate-500">{s.probability}%</span>
            {(s.isWon || s.isLost) && <span className="text-xs text-slate-400">(fixed)</span>}
            <span className="ml-auto flex items-center gap-1">
              {!s.isWon && !s.isLost && (
                <>
                  <button aria-label="Move up" className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button aria-label="Move down" className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30" disabled={stages[i + 1]?.isWon || stages[i + 1]?.isLost || i === stages.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown className="h-4 w-4" />
                  </button>
                </>
              )}
              <StageDialog stage={s} />
              {!s.isWon && !s.isLost && (
                <ConfirmButton variant="ghost" size="sm" action={archiveStageAction.bind(null, s.id)} title={`Remove stage "${s.name}"?`} description="Only possible when no open opportunities are in it." confirmLabel="Remove">
                  Remove
                </ConfirmButton>
              )}
            </span>
          </li>
        ))}
      </ul>
      <StageDialog />
    </div>
  );
}

function StageDialog({ stage }: { stage?: Stage }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [result, formAction] = useActionState(saveStageAction.bind(null, stage?.id ?? null), null);
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant={stage ? "ghost" : "secondary"} onClick={() => setOpen(true)}>
        {stage ? "Edit" : (<><Plus className="h-4 w-4" /> Add stage</>)}
      </Button>
      <DialogContent title={stage ? `Edit ${stage.name}` : "New stage"}>
        <form action={formAction} className="space-y-3">
          <FormMessage result={result && !result.ok ? result : null} />
          <Field label="Name" htmlFor="s-name" required error={fieldErrors(result, "name")}>
            <Input id="s-name" name="name" required defaultValue={stage?.name ?? ""} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Default probability (%)" htmlFor="s-prob" error={fieldErrors(result, "probability")}>
              <Input id="s-prob" name="probability" type="number" min={0} max={100} defaultValue={stage?.probability ?? 10} disabled={stage?.isWon || stage?.isLost} />
            </Field>
            <Field label="Colour" htmlFor="s-color">
              <Select id="s-color" name="color" defaultValue={stage?.color ?? "slate"}>
                {[...COLORS, "green", "red"].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Save</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
