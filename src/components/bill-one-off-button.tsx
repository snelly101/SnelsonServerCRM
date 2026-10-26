"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ReceiptText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { prepareOneOffInvoiceAction } from "@/actions/xero";
import { fmtMoney } from "@/lib/format";
import type { OneOffLineStatus } from "@/services/billing-coverage";

/**
 * Bills a contract's one-off and hardware lines: tick the ones to invoice,
 * pick the invoice date, and a draft is prepared for review. A line already
 * on a draft is shown with that draft and cannot be ticked again.
 */
export function BillOneOffButton({ contractId, lines, currency }: { contractId: string; lines: OneOffLineStatus[]; currency: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const free = lines.filter((l) => !l.invoicedOn);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(free.map((l) => l.id)));
  const router = useRouter();
  const total = free.filter((l) => ticked.has(l.id)).reduce((a, l) => a + l.amount, 0);
  const toggle = (id: string) =>
    setTicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} title={free.length ? `${free.length} one-off line${free.length === 1 ? "" : "s"} not yet invoiced` : "Every one-off line is on a draft"}>
        <ReceiptText className="h-4 w-4" /> Bill one-off{free.length ? ` (${free.length})` : ""}
      </Button>
      <DialogContent title="Bill one-off lines" description="Project and hardware lines are invoiced once, on their own draft. Tick the lines to bill; a finance user then reviews and approves the draft before it goes to Xero.">
        {error && (
          <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
        <Field label="Invoice date" htmlFor="oo-date" help="The date on the draft; the due date counts from it." className="mb-3">
          <Input id="oo-date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className="w-44" />
        </Field>
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {lines.map((l) => (
            <li key={l.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <input type="checkbox" className="h-4 w-4 rounded border-slate-300" aria-label={`Bill ${l.description}`} disabled={Boolean(l.invoicedOn)} checked={!l.invoicedOn && ticked.has(l.id)} onChange={() => toggle(l.id)} />
              <span className="min-w-0 flex-1">
                <span className={l.invoicedOn ? "text-slate-400" : "text-slate-900"}>{l.description}</span>
                <span className="ml-2 text-xs text-slate-500">
                  {l.quantity} × {fmtMoney(l.unitPrice, currency)}
                  {l.revenueType === "hardware" ? " · hardware" : ""}
                </span>
                {l.invoicedOn && (
                  <span className="ml-2 text-xs">
                    <Badge tone="slate">invoiced</Badge>{" "}
                    <Link href={`/billing/drafts/${l.invoicedOn.draftId}`} className="link">
                      draft ({l.invoicedOn.status})
                    </Link>
                  </span>
                )}
              </span>
              <span className={`tabular-nums ${l.invoicedOn ? "text-slate-400" : ""}`}>{fmtMoney(l.amount, currency)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-sm text-slate-600">
            Net <span className="font-medium tabular-nums">{fmtMoney(total, currency)}</span>
          </span>
          <span className="flex gap-2">
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button
              loading={pending}
              disabled={ticked.size === 0}
              onClick={() =>
                start(async () => {
                  const r = await prepareOneOffInvoiceAction({ contractId, lineIds: [...ticked], invoiceDate });
                  if (!r.ok) return setError(r.error);
                  setOpen(false);
                  router.push(`/billing/drafts/${r.data.draftId}`);
                })
              }
            >
              Prepare draft
            </Button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
