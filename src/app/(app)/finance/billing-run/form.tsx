"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { SubmitButton, FormMessage } from "@/components/ui/form";
import { runBillingRunAction } from "@/actions/billing";
import { fmtDate, fmtMoney, type DisplaySettings } from "@/lib/format";
import type { BillingRunRow } from "@/services/billing-run";

export function BillingRunForm({ asOf, rows, currency, settings }: { asOf: string; rows: BillingRunRow[]; currency: string; settings: DisplaySettings }) {
  const [result, formAction] = useActionState(runBillingRunAction, null);
  const ready = rows.filter((r) => !r.skipReason);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(ready.map((r) => r.contractId)));
  const total = rows.filter((r) => ticked.has(r.contractId) && !r.skipReason).reduce((a, r) => a + r.net, 0);
  const toggleAll = (on: boolean) => setTicked(on ? new Set(ready.map((r) => r.contractId)) : new Set());

  if (result?.ok) {
    const { created, skipped } = result.data;
    return (
      <div className="space-y-4">
        <Alert tone="success" title={`${created.length} draft invoice${created.length === 1 ? "" : "s"} prepared`}>
          Review each one on the Finance page, then approve to create it in Xero as a draft. Nothing has been sent to Xero yet.
        </Alert>
        {created.length > 0 && (
          <table className="tbl">
            <thead>
              <tr>
                <th>Company</th>
                <th>Contract</th>
                <th className="text-right">Net</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {created.map((c) => (
                <tr key={c.draftId}>
                  <td>{c.companyName}</td>
                  <td>
                    {c.contractName}
                    {c.missed > 0 && <Badge className="ml-1" tone="amber">{c.missed} missed period{c.missed === 1 ? "" : "s"}</Badge>}
                  </td>
                  <td className="text-right tabular-nums">{fmtMoney(c.net, currency)}</td>
                  <td className="text-right">
                    <Link href={`/finance/drafts/${c.draftId}`} className="text-xs text-brand-700 hover:underline">
                      Review draft
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {skipped.length > 0 && (
          <div className="text-sm text-slate-600">
            <p className="mb-1 font-medium text-slate-700">Skipped</p>
            <ul className="list-disc space-y-0.5 pl-5 text-xs">
              {skipped.map((s) => (
                <li key={s.contractId}>
                  {s.contractName}: {s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        <Link href="/finance" className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline">
          <CheckCircle2 className="h-4 w-4" /> Back to Finance
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <FormMessage result={result} />
      <input type="hidden" name="asOf" value={asOf} />
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No active contracts.</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th className="w-8">
                <input type="checkbox" aria-label="Select all ready contracts" checked={ready.length > 0 && ticked.size === ready.length} onChange={(e) => toggleAll(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand-600" />
              </th>
              <th>Company</th>
              <th>Contract</th>
              <th>Period</th>
              <th className="text-right">Net</th>
              <th>Xero</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const ok = !r.skipReason;
              return (
                <tr key={r.contractId} className={ok ? "" : "text-slate-400"}>
                  <td>
                    <input
                      type="checkbox"
                      name="contractIds[]"
                      value={r.contractId}
                      aria-label={`Include ${r.contractName}`}
                      disabled={!ok}
                      checked={ok && ticked.has(r.contractId)}
                      onChange={(e) => setTicked((s) => { const n = new Set(s); if (e.target.checked) n.add(r.contractId); else n.delete(r.contractId); return n; })}
                      className="h-4 w-4 rounded border-slate-300 text-brand-600"
                    />
                  </td>
                  <td>
                    <Link href={`/companies/${r.companyId}`} className="hover:underline">
                      {r.companyName}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/contracts/${r.contractId}`} className="hover:underline">
                      {r.contractName}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {r.billingFrequency} · {r.lineCount} recurring line{r.lineCount === 1 ? "" : "s"}
                      {r.items.some((i) => i.months !== (r.billingFrequency === "annual" ? 12 : r.billingFrequency === "quarterly" ? 3 : 1)) && " · includes services on their own cycle"}
                    </div>
                  </td>
                  <td className="text-xs">
                    <div className="whitespace-nowrap">{r.period ? `${fmtDate(r.period.periodStart, settings)} – ${fmtDate(r.period.periodEnd, settings)}` : "—"}</div>
                    {r.missedCount > 0 && (
                      <div className="mt-0.5">
                        <Badge tone="amber">{r.missedCount} missed period{r.missedCount === 1 ? "" : "s"}</Badge>
                        <span className="ml-1 text-slate-500">from {fmtDate(r.items.filter((i) => i.missed).reduce((a, i) => (i.period.periodStart < a ? i.period.periodStart : a), r.items[0].period.periodStart), settings)}</span>
                      </div>
                    )}
                  </td>
                  <td className="text-right tabular-nums">{fmtMoney(r.net, currency)}</td>
                  <td>{r.xeroLinked ? <Badge tone="green">linked</Badge> : <Badge tone="amber">not linked</Badge>}</td>
                  <td className="text-xs">
                    {r.skipReason ? (
                      r.existingDraft ? (
                        <Link href={`/finance/drafts/${r.existingDraft.id}`} className="text-brand-700 hover:underline">
                          {r.skipReason}
                        </Link>
                      ) : (
                        r.skipReason
                      )
                    ) : (
                      <span className="text-green-700">ready</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
        <p className="text-sm text-slate-600">
          {ticked.size} contract{ticked.size === 1 ? "" : "s"} selected · {fmtMoney(total, currency)} net
        </p>
        <SubmitButton disabled={ticked.size === 0}>Prepare {ticked.size} draft{ticked.size === 1 ? "" : "s"}</SubmitButton>
      </div>
      <p className="text-xs text-slate-500">
        Companies not linked to Xero can still have drafts prepared, but approval will ask for the link first. A draft is never sent to Xero by this run.
      </p>
    </form>
  );
}
