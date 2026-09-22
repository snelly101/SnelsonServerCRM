"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea, SubmitButton, FormMessage } from "@/components/ui/form";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { approveInvoiceAction, cancelDraftAction, updateDraftAction } from "@/actions/xero";
import { fmtMoney } from "@/lib/format";
import type { InvoiceDraftLine } from "@/db/schema";

export function DraftEditor({ draft, accounts, taxRates }: { draft: { id: string; invoiceDate: string; dueDate: string; description: string | null; notes: string | null; lines: InvoiceDraftLine[]; currencyCode: string }; accounts: { code: string; name: string }[]; taxRates: { type: string; name: string }[] }) {
  const [lines, setLines] = useState<InvoiceDraftLine[]>(draft.lines);
  const [result, formAction] = useActionState(updateDraftAction.bind(null, draft.id), null);
  const update = (i: number, patch: Partial<InvoiceDraftLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const net = lines.reduce((a, l) => a + l.quantity * l.unitAmount, 0);
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      <FormMessage result={result} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Invoice date" htmlFor="d-date">
          <Input id="d-date" name="invoiceDate" type="date" defaultValue={draft.invoiceDate} required />
        </Field>
        <Field label="Due date" htmlFor="d-due">
          <Input id="d-due" name="dueDate" type="date" defaultValue={draft.dueDate} required />
        </Field>
        <Field label="Description (internal)" htmlFor="d-desc" className="sm:col-span-2">
          <Input id="d-desc" name="description" defaultValue={draft.description ?? ""} />
        </Field>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Description</th>
            <th className="w-20">Qty</th>
            <th className="w-28">Unit</th>
            <th className="w-40">Account</th>
            <th className="w-44">Tax</th>
            <th className="w-24 text-right">Line</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <Input aria-label="Line description" value={l.description} onChange={(e) => update(i, { description: e.target.value })} className="text-xs" />
              </td>
              <td>
                <Input aria-label="Quantity" type="number" min={0} step="0.01" value={l.quantity} onChange={(e) => update(i, { quantity: Number(e.target.value) })} className="text-xs" />
              </td>
              <td>
                <Input aria-label="Unit amount" type="number" step="0.01" value={l.unitAmount} onChange={(e) => update(i, { unitAmount: Number(e.target.value) })} className="text-xs" />
              </td>
              <td>
                {accounts.length ? (
                  <select aria-label="Account code" className="input text-xs" value={l.accountCode} onChange={(e) => update(i, { accountCode: e.target.value })}>
                    {accounts.map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                    {!accounts.some((a) => a.code === l.accountCode) && <option value={l.accountCode}>{l.accountCode}</option>}
                  </select>
                ) : (
                  <Input aria-label="Account code" value={l.accountCode} onChange={(e) => update(i, { accountCode: e.target.value })} className="text-xs" />
                )}
              </td>
              <td>
                {taxRates.length ? (
                  <select aria-label="Tax type" className="input text-xs" value={l.taxType} onChange={(e) => update(i, { taxType: e.target.value })}>
                    {taxRates.map((t) => (
                      <option key={t.type} value={t.type}>
                        {t.name}
                      </option>
                    ))}
                    {!taxRates.some((t) => t.type === l.taxType) && <option value={l.taxType}>{l.taxType}</option>}
                  </select>
                ) : (
                  <Input aria-label="Tax type" value={l.taxType} onChange={(e) => update(i, { taxType: e.target.value })} className="text-xs" />
                )}
              </td>
              <td className="text-right text-xs tabular-nums">{fmtMoney(l.quantity * l.unitAmount, draft.currencyCode)}</td>
              <td>
                <button type="button" aria-label="Remove line" className="rounded p-1 text-slate-400 hover:text-red-600" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between">
        <Button type="button" size="sm" variant="secondary" onClick={() => setLines((ls) => [...ls, { description: "", quantity: 1, unitAmount: 0, accountCode: accounts[0]?.code ?? "200", taxType: taxRates[0]?.type ?? "OUTPUT2" }])}>
          <Plus className="h-4 w-4" /> Add line
        </Button>
        <span className="text-sm font-medium">Net {fmtMoney(net, draft.currencyCode)}</span>
      </div>
      <Field label="Notes (internal)" htmlFor="d-notes">
        <Textarea id="d-notes" name="notes" rows={2} defaultValue={draft.notes ?? ""} />
      </Field>
      <SubmitButton size="sm" variant="secondary">
        Save changes
      </SubmitButton>
    </form>
  );
}

export function ApproveControls({ id, linked, canCancel }: { id: string; linked: boolean; canCancel: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();
  return (
    <div className="space-y-2">
      {msg && <p className={`text-sm ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          loading={pending}
          disabled={!linked}
          onClick={() =>
            start(async () => {
              const r = await approveInvoiceAction(id);
              setMsg(r.ok ? { ok: true, text: r.data.reused ? "Already created in Xero; nothing new was sent." : "Draft invoice created in Xero." } : { ok: false, text: r.error });
              router.refresh();
            })
          }
        >
          <CheckCircle2 className="h-4 w-4" /> Approve and create in Xero
        </Button>
        {canCancel && (
          <ConfirmButton variant="danger-outline" action={cancelDraftAction.bind(null, id)} title="Cancel this draft?" confirmLabel="Cancel draft">
            Cancel draft
          </ConfirmButton>
        )}
      </div>
    </div>
  );
}
