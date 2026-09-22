"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trophy, XCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogClose } from "@/components/ui/dialog";
import { Checkbox, Field, Textarea } from "@/components/ui/form";
import { markLostAction, markWonAction, reopenOpportunityAction } from "@/actions/sales";

export function CloseControls({ id, status, hasLines }: { id: string; status: "open" | "won" | "lost"; hasLines: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [wonOpen, setWonOpen] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);
  const [createOnboarding, setCreateOnboarding] = useState(true);
  const [draftContract, setDraftContract] = useState(hasLines);
  const [reason, setReason] = useState("");

  if (status !== "open") {
    return (
      <Button
        variant="secondary"
        loading={pending}
        onClick={() =>
          start(async () => {
            const res = await reopenOpportunityAction(id);
            if (!res.ok) setError(res.error);
            router.refresh();
          })
        }
      >
        <RotateCcw className="h-4 w-4" /> Reopen
      </Button>
    );
  }

  return (
    <>
      {error && <span className="text-sm text-red-600">{error}</span>}
      <Dialog open={wonOpen} onOpenChange={setWonOpen}>
        <Button onClick={() => setWonOpen(true)}>
          <Trophy className="h-4 w-4" /> Mark won
        </Button>
        <DialogContent title="Mark this opportunity as won?" description="The company becomes a customer. Choose what to set up next.">
          <div className="space-y-3">
            <Checkbox label="Create onboarding checklist (from the default template)" checked={createOnboarding} onChange={(e) => setCreateOnboarding(e.target.checked)} />
            <Checkbox label="Draft a contract from the line items" checked={draftContract} onChange={(e) => setDraftContract(e.target.checked)} disabled={!hasLines} />
            {!hasLines && <p className="text-xs text-slate-500">Add line items first to draft a contract.</p>}
            <p className="text-xs text-slate-500">In Phase 3, accepting the Better Proposals proposal will do this automatically, exactly once.</p>
            <div className="flex justify-end gap-2 pt-2">
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <Button
                loading={pending}
                onClick={() =>
                  start(async () => {
                    const res = await markWonAction(id, { createOnboarding, draftContract });
                    if (!res.ok) return setError(res.error);
                    setWonOpen(false);
                    router.refresh();
                  })
                }
              >
                Confirm won
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={lostOpen} onOpenChange={setLostOpen}>
        <Button variant="danger-outline" onClick={() => setLostOpen(true)}>
          <XCircle className="h-4 w-4" /> Mark lost
        </Button>
        <DialogContent title="Mark as lost" description="Record why, so lost reasons can be reported on.">
          <Field label="Lost reason" htmlFor="lost-reason" required>
            <Textarea id="lost-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Chose incumbent provider on price" />
          </Field>
          <div className="mt-3 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button
              variant="danger"
              loading={pending}
              disabled={!reason.trim()}
              onClick={() =>
                start(async () => {
                  const res = await markLostAction(id, reason);
                  if (!res.ok) return setError(res.error);
                  setLostOpen(false);
                  router.refresh();
                })
              }
            >
              Confirm lost
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
