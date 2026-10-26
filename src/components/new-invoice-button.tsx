"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FilePlus2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Checkbox, Field, Input } from "@/components/ui/form";
import { prepareAdHocInvoiceAction } from "@/actions/xero";
import { fmtMoney } from "@/lib/format";

type Row = { key: number; description: string; quantity: string; unitAmount: string; hardware: boolean };
let seq = 0;
const blank = (): Row => ({ key: ++seq, description: "", quantity: "1", unitAmount: "", hardware: false });

/**
 * An ad hoc invoice for a customer: anything that is not on an agreement or
 * a won opportunity (a call-out, a licence bought on request, a one-off
 * piece of work). Typed lines, an invoice date and a reference; the draft
 * then goes through the usual review and approval.
 */
export function NewInvoiceButton({ companyId, companyName, currency }: { companyId: string; companyName: string; currency: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [rows, setRows] = useState<Row[]>(() => [blank()]);
  const router = useRouter();
  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const net = rows.reduce((a, r) => a + Number(r.quantity || 0) * Number(r.unitAmount || 0), 0);
  const valid = rows.some((r) => r.description.trim()) && rows.every((r) => !r.description.trim() || r.unitAmount !== "");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <FilePlus2 className="h-4 w-4" /> New invoice
      </Button>
      <DialogContent wide title={`New invoice for ${companyName}`} description="For work that is not on an agreement or a won opportunity. The draft is reviewed and approved like any other before it is created in Xero; lines, accounts and tax can still be changed on the draft.">
        {error && (
          <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Invoice date" htmlFor="ai-date" help="The due date counts from it.">
            <Input id="ai-date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className="w-44" />
          </Field>
          <Field label="Reference" htmlFor="ai-ref" help={`Shown in Xero as the reference, followed by the month. Empty uses the customer's name.`}>
            <Input id="ai-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} placeholder={companyName} />
          </Field>
        </div>
        <table className="tbl mt-3">
          <thead>
            <tr>
              <th>Description</th>
              <th className="w-20 text-right">Qty</th>
              <th className="w-32 text-right">Unit ({currency})</th>
              <th className="w-28 text-right">Line</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  <Input aria-label="Description" value={r.description} onChange={(e) => update(r.key, { description: e.target.value })} maxLength={300} placeholder="e.g. Out-of-hours call-out, 14 Nov" />
                  <Checkbox label="Hardware (hardware account code)" className="mt-1 text-xs" checked={r.hardware} onChange={(e) => update(r.key, { hardware: e.target.checked })} />
                </td>
                <td className="align-top">
                  <Input aria-label="Quantity" type="number" min={0} step="any" value={r.quantity} onChange={(e) => update(r.key, { quantity: e.target.value })} className="text-right" />
                </td>
                <td className="align-top">
                  <Input aria-label="Unit amount" type="number" step="0.01" value={r.unitAmount} onChange={(e) => update(r.key, { unitAmount: e.target.value })} className="text-right" />
                </td>
                <td className="align-top pt-3 text-right tabular-nums">{fmtMoney(Number(r.quantity || 0) * Number(r.unitAmount || 0), currency)}</td>
                <td className="align-top pt-2">
                  <button type="button" className="pill-icon h-7 w-7 text-slate-400" aria-label="Remove line" disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 flex items-center justify-between">
          <Button size="sm" variant="ghost" onClick={() => setRows((rs) => [...rs, blank()])}>
            <Plus className="h-3.5 w-3.5" /> Add line
          </Button>
          <span className="text-sm text-slate-600">
            Net <span className="font-medium tabular-nums">{fmtMoney(net, currency)}</span>
          </span>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button
            loading={pending}
            disabled={!valid}
            onClick={() =>
              start(async () => {
                const r = await prepareAdHocInvoiceAction({ companyId, invoiceDate, reference: reference || undefined, lines: rows.filter((x) => x.description.trim()).map((x) => ({ description: x.description, quantity: Number(x.quantity || 0), unitAmount: Number(x.unitAmount || 0), hardware: x.hardware })) });
                if (!r.ok) return setError(r.error);
                setOpen(false);
                router.push(`/billing/drafts/${r.data.draftId}`);
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
