"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarCheck } from "lucide-react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Field, Textarea } from "@/components/ui/form";
import { clearRenewalDecisionAction, recordRenewalDecisionAction } from "@/actions/contracts";

type Decision = "renew" | "amend" | "not_renewing";
const LABELS: Record<Decision, string> = { renew: "Renew as is", amend: "Renew with amendments", not_renewing: "Not renewing" };
const HELP: Record<Decision, string> = {
  renew: "The customer has confirmed the agreement continues on the same terms.",
  amend: "The customer has agreed changes: prepare them as a dated amendment from the renewal date.",
  not_renewing: "The customer is leaving or the agreement ends; supplier commitments that outlast it stay payable.",
};

/** Records the customer's renewal decision for the contract's current renewal date, with a note. */
export function RenewalDecisionButton({ contractId, renewalDate, amendHref, size = "sm", variant = "secondary" }: { contractId: string; renewalDate: string; amendHref: string; size?: "sm" | "md"; variant?: "primary" | "secondary" }) {
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<Decision>("renew");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const submit = () =>
    start(async () => {
      const r = await recordRenewalDecisionAction(contractId, { decision, note });
      if (!r.ok) return setError(r.error);
      setOpen(false);
      router.refresh();
      if (decision === "amend") router.push(amendHref);
    });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size={size} variant={variant}>
          <CalendarCheck className="h-3.5 w-3.5" /> Record decision
        </Button>
      </DialogTrigger>
      <DialogContent title={`Renewal decision for ${renewalDate}`} description="What the customer has agreed. The decision is kept against this renewal date and audited.">
        {error && <Alert tone="error" className="mb-3">{error}</Alert>}
        <fieldset className="mb-3 space-y-1.5">
          {(Object.keys(LABELS) as Decision[]).map((k) => (
            <label key={k} className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="radio" name="decision" className="mt-1" checked={decision === k} onChange={() => setDecision(k)} />
              <span>
                {LABELS[k]}
                <span className="block text-xs text-slate-500">{HELP[k]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Field label={decision === "not_renewing" ? "Why" : "Note"} htmlFor="renewalNote" required={decision === "not_renewing"}>
          <Textarea id="renewalNote" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={decision === "amend" ? "e.g. drop 2 users, add Defender; confirmed by email 3 Oct" : "Who confirmed and how"} />
        </Field>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="button" onClick={submit} loading={pending}>
            {decision === "amend" ? "Record and prepare amendment" : "Record"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ClearRenewalDecisionButton({ contractId }: { contractId: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button size="sm" variant="ghost" loading={pending} onClick={() => start(async () => { await clearRenewalDecisionAction(contractId); router.refresh(); })}>
      Reopen
    </Button>
  );
}
