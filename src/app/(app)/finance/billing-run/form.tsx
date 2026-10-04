"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { SubmitButton, FormMessage } from "@/components/ui/form";
import { runBillingRunAction } from "@/actions/billing";
import { fmtDate, fmtMoney, type DisplaySettings } from "@/lib/format";
import type { WorkspaceRow } from "@/services/billing-workspace";

const STATUS_TONE: Record<string, string> = { ready: "green", review: "amber", blocked: "red", nothing: "slate" };
const STATUS_LABEL: Record<string, string> = { ready: "ready", review: "review", blocked: "blocked", nothing: "nothing due" };

export function BillingRunForm({ asOf, rows, currency, settings }: { asOf: string; rows: WorkspaceRow[]; currency: string; settings: DisplaySettings }) {
  const [result, formAction] = useActionState(runBillingRunAction, null);
  // Blocked rows cannot be prepared usefully; review rows can be ticked after a look; only ready rows start ticked.
  const selectable = rows.filter((r) => r.status === "ready" || r.status === "review");
  const ready = rows.filter((r) => r.status === "ready");
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(ready.map((r) => r.contractId)));
  const [open, setOpen] = useState<Set<string>>(new Set());
  const total = rows.filter((r) => ticked.has(r.contractId) && (r.status === "ready" || r.status === "review")).reduce((a, r) => a + r.net, 0);
  const toggleAll = (on: boolean) => setTicked(on ? new Set(selectable.map((r) => r.contractId)) : new Set());
  const toggleOpen = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

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
                <input type="checkbox" aria-label="Select all ready and review contracts" checked={selectable.length > 0 && ticked.size === selectable.length} onChange={(e) => toggleAll(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand-600" />
              </th>
              <th>Customer / contract</th>
              <th>Period</th>
              <th className="text-right">Proposed</th>
              <th className="text-right">Previous</th>
              <th>Change and why</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const ok = r.status === "ready" || r.status === "review";
              const isOpen = open.has(r.contractId);
              return (
                <tr key={r.contractId} className={r.status === "nothing" ? "text-slate-400" : r.status === "blocked" ? "bg-red-50/40" : r.status === "review" ? "bg-amber-50/30" : ""}>
                  <td className="align-top">
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
                  <td className="align-top">
                    <Link href={`/companies/${r.companyId}`} className="font-medium hover:underline">
                      {r.companyName}
                    </Link>
                    <div className="text-xs text-slate-500">
                      <Link href={`/contracts/${r.contractId}`} className="hover:underline">
                        {r.contractName}
                      </Link>{" "}
                      · {r.billingFrequency} · {r.lineCount} recurring line{r.lineCount === 1 ? "" : "s"}
                    </div>
                  </td>
                  <td className="whitespace-nowrap align-top text-xs">{r.period ? `${fmtDate(r.period.periodStart, settings)} – ${fmtDate(r.period.periodEnd, settings)}` : "—"}</td>
                  <td className="align-top text-right tabular-nums">{r.status === "nothing" ? "—" : fmtMoney(r.net, currency)}</td>
                  <td className="align-top text-right text-xs tabular-nums">
                    {r.previous ? (
                      <Link href={`/finance/drafts/${r.previous.draftId}`} className="hover:underline" title={`${r.previous.periodStart} to ${r.previous.periodEnd} (${r.previous.status})`}>
                        {fmtMoney(r.previous.net, currency)}
                      </Link>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="align-top text-xs">
                    {r.status === "nothing" ? (
                      r.existingDraft ? (
                        <Link href={`/finance/drafts/${r.existingDraft.id}`} className="text-brand-700 hover:underline">
                          {r.skipReason}
                        </Link>
                      ) : (
                        r.skipReason
                      )
                    ) : (
                      <>
                        <button type="button" className={`font-medium hover:underline ${r.delta === null ? "text-slate-600" : Math.abs(r.delta) < 0.01 ? "text-green-700" : r.delta > 0 ? "text-amber-700" : "text-blue-700"}`} onClick={() => toggleOpen(r.contractId)} aria-expanded={isOpen}>
                          {r.delta === null ? "first invoice" : Math.abs(r.delta) < 0.01 ? "unchanged" : `${r.delta > 0 ? "+" : "−"}${fmtMoney(Math.abs(r.delta), currency)} vs previous`}
                          {" "}· {isOpen ? "hide" : "why"}
                        </button>
                        {isOpen && (
                          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-700">
                            {r.reasons.map((x, i) => (
                              <li key={i}>{x}</li>
                            ))}
                          </ul>
                        )}
                        {r.blockers.map((b, i) => (
                          <div key={`b${i}`} className="mt-1 text-red-700">
                            {b}
                          </div>
                        ))}
                        {r.attention.filter((a) => !a.includes("against the previous invoice")).map((a, i) => (
                          <div key={`a${i}`} className="mt-1 text-amber-700">
                            {a}
                          </div>
                        ))}
                      </>
                    )}
                  </td>
                  <td className="align-top">
                    <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    {r.status !== "nothing" && !r.xeroLinked && <div className="mt-1 text-[11px] text-slate-500">draft can be prepared; approval needs the Xero link</div>}
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
        Ready rows start ticked; review rows can be ticked once their reasons have been read; blocked rows need the Xero link first. A draft is never sent to Xero by this run.
      </p>
    </form>
  );
}
