"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogClose } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { prepareInvoiceAction, previewInvoiceAction } from "@/actions/xero";
import { fmtMoney } from "@/lib/format";

type Preview = { lines: { description: string; quantity: number; unitAmount: number }[]; net: number; covered: string[] };

/**
 * Prepares a CRM invoice draft from a contract period or a won opportunity's
 * one-off lines. For a contract the dialog shows the calculated lines for the
 * chosen period before anything is created, so a partial or already-drafted
 * period is visible up front.
 */
export function PrepareInvoiceButton({ companyId, contractId, opportunityId, billingFrequency, currency = "GBP" }: { companyId: string; contractId?: string; opportunityId?: string; billingFrequency?: string; currency?: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const today = new Date();
  const start0 = new Date(today.getFullYear(), today.getMonth(), 1);
  const months = billingFrequency === "annual" ? 12 : billingFrequency === "quarterly" ? 3 : 1;
  const end0 = new Date(start0.getFullYear(), start0.getMonth() + months, 0);
  const [periodStart, setPeriodStart] = useState(start0.toISOString().slice(0, 10));
  const [periodEnd, setPeriodEnd] = useState(end0.toISOString().slice(0, 10));

  useEffect(() => {
    if (!open || !contractId || !/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) return;
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      const r = await previewInvoiceAction({ contractId, periodStart, periodEnd });
      if (cancelled) return;
      setLoading(false);
      if (r.ok) {
        setPreview(r.data);
        setPreviewError(null);
      } else {
        setPreview(null);
        setPreviewError(r.error);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, contractId, periodStart, periodEnd]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Receipt className="h-4 w-4" /> Prepare invoice
      </Button>
      <DialogContent title="Prepare a draft invoice" description={contractId ? "Builds lines from the contract's recurring services for the period below. A finance user then reviews and approves it before it is created in Xero as a draft." : "Builds lines from the opportunity's one-off and hardware items. A finance user then reviews and approves it."}>
        {error && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {contractId && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Period start" htmlFor="pi-start">
                <Input id="pi-start" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
              </Field>
              <Field label="Period end" htmlFor="pi-end">
                <Input id="pi-end" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
              </Field>
            </div>
            <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm" aria-live="polite">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">What this draft will carry</span>
                {loading && <span className="text-xs text-slate-400">calculating…</span>}
              </div>
              {previewError && <p className="text-red-700">{previewError}</p>}
              {preview && preview.lines.length === 0 && <p className="text-amber-700">Nothing is due in that period: no recurring line has a period starting in it.</p>}
              {preview && preview.lines.length > 0 && (
                <>
                  <ul className="space-y-0.5">
                    {preview.lines.map((l, i) => (
                      <li key={i} className="flex justify-between gap-3">
                        <span className="min-w-0 truncate" title={l.description}>
                          {l.description}
                        </span>
                        <span className="shrink-0 tabular-nums">{fmtMoney(l.quantity * l.unitAmount, currency)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-medium">
                    <span>Net</span>
                    <span className="tabular-nums">{fmtMoney(preview.net, currency)}</span>
                  </div>
                </>
              )}
              {preview && preview.covered.length > 0 && (
                <p className="mt-2 text-xs text-amber-700">
                  Already drafted: {preview.covered.join("; ")}. Preparing again would bill {preview.covered.length === 1 ? "it" : "them"} twice.
                </p>
              )}
              {!preview && !previewError && !loading && <p className="text-xs text-slate-500">Choose a period to see the lines.</p>}
            </div>
          </>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button
            loading={pending}
            disabled={Boolean(contractId) && (!preview || preview.lines.length === 0)}
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
