import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { getInvoiceDraft } from "@/services/xero";
import { customerSchedule } from "@/services/customer-schedule";
import { fmtDate, fmtMoney } from "@/lib/format";
import { PrintButton } from "./print-button";

export const metadata = { title: "Customer schedule" };

/**
 * The customer-facing schedule for one draft: what the invoice covers in plain
 * words, lines grouped by agreement with service dates, and the supporting
 * list of licences, devices and domains behind each charge. Printable; the
 * invoice itself still comes from Xero.
 */
export default async function CustomerSchedulePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("finance.read");
  const { id } = await params;
  const [draft, settings] = await Promise.all([getInvoiceDraft(id), getAppSettings()]);
  if (!draft) notFound();
  const s = await customerSchedule(draft, settings);
  const cur = draft.currencyCode;
  return (
    <div className="mx-auto max-w-3xl space-y-6 bg-surface p-6 text-slate-900 print:max-w-none print:p-0">
      <div className="flex items-start justify-between gap-4 print:hidden">
        <Link href={`/billing/drafts/${id}`} className="text-sm text-brand-700 hover:underline">← Back to draft {draft.reference}</Link>
        <PrintButton />
      </div>
      <header className="border-b border-slate-200 pb-4">
        <h1 className="text-xl font-semibold">Invoice schedule</h1>
        <p className="text-sm text-slate-600">
          {settings.companyName} for <strong>{draft.companyName}</strong> · reference {draft.reference}
          {draft.xeroInvoiceNumber && <> · invoice {draft.xeroInvoiceNumber}</>}
          {draft.purchaseOrderRef && <> · your PO {draft.purchaseOrderRef}</>}
        </p>
        <p className="text-sm text-slate-600">
          Invoice date {fmtDate(draft.invoiceDate, settings)} · due {fmtDate(draft.dueDate, settings)}
          {s.from && s.to && <> · service period {fmtDate(s.from, settings)} to {fmtDate(s.to, settings)}</>}
        </p>
      </header>

      {s.summary && (
        <section>
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">What this invoice covers</h2>
          <p className="text-sm leading-6">{s.summary}</p>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Charges</h2>
        {s.groups.map((g) => (
          <div key={g.key} className="mb-4">
            {s.groups.length > 1 && <h3 className="mb-1 text-sm font-medium">{g.title}</h3>}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-1 pr-2">Service</th>
                  <th className="py-1 pr-2">Dates</th>
                  <th className="py-1 pr-2 text-right">Qty</th>
                  <th className="py-1 pr-2 text-right">Unit</th>
                  <th className="py-1 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {g.lines.map((l, i) => (
                  <tr key={i} className="border-b border-slate-100 align-top">
                    <td className="py-1 pr-2">
                      {l.name}
                      {l.note && <div className="text-xs text-slate-500">{l.note}</div>}
                    </td>
                    <td className="py-1 pr-2 whitespace-nowrap text-xs text-slate-600">{l.from ? `${fmtDate(l.from, settings)} – ${fmtDate(l.to, settings)}` : ""}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{l.quantity}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{fmtMoney(l.unitAmount, cur)}</td>
                    <td className="py-1 text-right tabular-nums">{fmtMoney(l.amount, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        <p className="text-right text-sm font-semibold">Net total {fmtMoney(draft.subTotal, cur)} <span className="font-normal text-slate-500">(excluding {settings.taxLabel})</span></p>
      </section>

      {s.supporting.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Supporting schedule</h2>
          {s.supporting.map((sup) => (
            <div key={sup.lineId} className="mb-3">
              <h3 className="text-sm font-medium">{sup.name}</h3>
              <ul className="ml-4 list-disc text-xs text-slate-700">
                {sup.items.map((it) => (
                  <li key={it.key}>
                    {it.name}
                    {it.quantity !== null && it.quantity !== 1 ? ` × ${it.quantity}` : ""}
                    {it.detail ? <span className="text-slate-500"> · {it.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-xs text-slate-500">As recorded at the time this schedule was produced.</p>
        </section>
      )}

      {s.renewals.length > 0 && (
        <section>
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">Your agreement</h2>
          <ul className="text-sm">
            {s.renewals.map((r) => (
              <li key={r.contractId}>
                {r.name}: renews {fmtDate(r.renewalDate, settings)}{r.noticeDeadline ? ` (notice by ${fmtDate(r.noticeDeadline, settings)})` : ""}{r.autoRenew ? ", renews automatically" : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
