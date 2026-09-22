"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogClose } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { prepareInvoiceAction } from "@/actions/xero";

/** Prepares a CRM invoice draft from a contract period or a won opportunity's one-off lines. */
export function PrepareInvoiceButton({ companyId, contractId, opportunityId, billingFrequency }: { companyId: string; contractId?: string; opportunityId?: string; billingFrequency?: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const today = new Date();
  const start0 = new Date(today.getFullYear(), today.getMonth(), 1);
  const months = billingFrequency === "annual" ? 12 : billingFrequency === "quarterly" ? 3 : 1;
  const end0 = new Date(start0.getFullYear(), start0.getMonth() + months, 0);
  const [periodStart, setPeriodStart] = useState(start0.toISOString().slice(0, 10));
  const [periodEnd, setPeriodEnd] = useState(end0.toISOString().slice(0, 10));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Receipt className="h-4 w-4" /> Prepare invoice
      </Button>
      <DialogContent title="Prepare a draft invoice" description={contractId ? "Builds lines from the contract's recurring services for the period below. A finance user then reviews and approves it before it is created in Xero as a draft." : "Builds lines from the opportunity's one-off and hardware items. A finance user then reviews and approves it."}>
        {error && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {contractId && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Period start" htmlFor="pi-start">
              <Input id="pi-start" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
            </Field>
            <Field label="Period end" htmlFor="pi-end">
              <Input id="pi-end" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
            </Field>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button
            loading={pending}
            onClick={() =>
              start(async () => {
                const r = await prepareInvoiceAction({ companyId, contractId, opportunityId, periodStart: contractId ? periodStart : undefined, periodEnd: contractId ? periodEnd : undefined });
                if (!r.ok) return setError(r.error);
                setOpen(false);
                router.push(`/finance/drafts/${r.data.draftId}`);
              })
            }
          >
            Prepare draft
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
