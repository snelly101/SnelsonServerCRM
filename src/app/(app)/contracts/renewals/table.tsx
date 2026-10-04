"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { RenewalDecisionButton, ClearRenewalDecisionButton } from "@/components/renewal-decision";
import { fmtDate, fmtMoney, type DisplaySettings } from "@/lib/format";
import { DECISION_LABELS } from "@/lib/renewals";
import type { RenewalRow } from "@/services/renewals";

const STATUS_TONE: Record<string, string> = { overdue: "red", due: "amber", upcoming: "slate", decided: "green" };
const STATUS_LABEL: Record<string, string> = { overdue: "decision overdue", due: "decide now", upcoming: "upcoming", decided: "decided" };

export function RenewalTable({ rows, canWrite, currency, settings }: { rows: RenewalRow[]; canWrite: boolean; currency: string; settings: DisplaySettings }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(rows.filter((r) => r.status === "overdue" || r.status === "due").map((r) => r.contractId)));
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  if (!rows.length) return <p className="p-4 text-sm text-slate-500">No contracts with a renewal date match this view.</p>;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Customer / contract</th>
          <th>Decide by</th>
          <th>Renewal</th>
          <th className="text-right">MRR</th>
          <th className="text-right">Supplier exposure</th>
          <th>Position</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const expanded = open.has(r.contractId);
          return (
            <tr key={r.contractId} className="align-top">
              <td>
                <Link href={`/companies/${r.companyId}`} className="font-medium text-brand-700 hover:underline">{r.companyName}</Link>
                <div className="text-xs text-slate-500">
                  <Link href={`/contracts/${r.contractId}`} className="hover:underline">{r.contractName}</Link>
                  {r.ownerName && <> · {r.ownerName}</>}
                </div>
              </td>
              <td className="whitespace-nowrap">
                <span className={r.status === "overdue" ? "font-medium text-red-700" : r.status === "due" ? "font-medium text-amber-700" : ""}>{fmtDate(r.decideBy, settings)}</span>
                <div className="text-[11px] text-slate-500">{r.daysToDecide < 0 ? `${-r.daysToDecide} days ago` : `in ${r.daysToDecide} days`} · notice by {fmtDate(r.noticeDeadline, settings)}</div>
              </td>
              <td className="whitespace-nowrap">
                {fmtDate(r.renewalDate, settings)}
                <div className="text-[11px] text-slate-500">{r.autoRenew ? "auto-renews" : "expires unless renewed"}</div>
              </td>
              <td className="text-right tabular-nums">{fmtMoney(r.mrr, currency)}</td>
              <td className="text-right tabular-nums">
                {r.exposureTotal > 0 ? <span className="font-medium text-amber-700">{fmtMoney(r.exposureTotal, currency)}</span> : r.services.some((s) => s.mismatch === "supplier_outlasts") ? <span className="text-amber-700" title="A supplier commitment outlasts the agreement but its cost is not known">unknown</span> : <span className="text-slate-400">—</span>}
                {r.monthlyCost > 0 && <div className="text-[11px] text-slate-500">{fmtMoney(r.monthlyCost, currency)}/month supplier cost</div>}
              </td>
              <td className="max-w-md text-xs">
                {r.mismatches.length > 0 ? (
                  <ul className="list-disc space-y-0.5 pl-4 text-amber-800">
                    {r.mismatches.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-slate-500">{r.services.length ? "Supplier commitments end with or before the agreement" : "No supplier commitments on record"}</span>
                )}
                {r.planned.length > 0 && (
                  <div className="mt-1 text-slate-600">
                    Planned: {r.planned.map((p) => `${p.lineDescription} ${p.field === "unit_price" ? "price " : ""}${p.previousValue ?? "—"} → ${p.newValue ?? "—"} from ${p.effectiveFrom}`).join("; ")}
                  </div>
                )}
                {(r.services.length > 0) && (
                  <button type="button" className="mt-1 text-brand-700 hover:underline" onClick={() => toggle(r.contractId)}>
                    {expanded ? "hide services" : `${r.services.length} service${r.services.length === 1 ? "" : "s"}`}
                  </button>
                )}
                {expanded && r.services.length > 0 && (
                  <table className="mt-1 w-full text-[11px]">
                    <tbody>
                      {r.services.map((s) => (
                        <tr key={s.key} className={s.mismatch ? "text-amber-800" : "text-slate-600"}>
                          <td className="pr-2">{s.name}{s.quantity !== null && s.quantity !== 1 ? ` × ${s.quantity}` : ""}</td>
                          <td className="pr-2">{s.lineDescription}</td>
                          <td className="pr-2 whitespace-nowrap">{s.supplierEndsOn ? `to ${fmtDate(s.supplierEndsOn, settings)}` : "no commitment"}</td>
                          <td className="text-right tabular-nums">{s.monthlyCost !== null ? `${fmtMoney(s.monthlyCost, currency)}/m` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </td>
              <td>
                <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                {r.decision && (
                  <div className="mt-0.5 text-[11px] text-slate-600">
                    {DECISION_LABELS[r.decision.kind]}{r.decision.by ? ` · ${r.decision.by}` : ""}
                    {r.decision.note && <div className="max-w-[180px] truncate" title={r.decision.note}>{r.decision.note}</div>}
                  </div>
                )}
              </td>
              <td className="text-right">
                {canWrite && (
                  <div className="flex flex-col items-end gap-1">
                    {r.decision ? <ClearRenewalDecisionButton contractId={r.contractId} /> : <RenewalDecisionButton contractId={r.contractId} renewalDate={r.renewalDate} amendHref={`/contracts/${r.contractId}/edit?effectiveFrom=${r.renewalDate}`} />}
                    <ButtonLink href={`/contracts/${r.contractId}/edit?effectiveFrom=${r.renewalDate}`} variant="ghost" size="sm">
                      Prepare amendment
                    </ButtonLink>
                  </div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
