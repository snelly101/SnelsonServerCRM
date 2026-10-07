"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { recheckDiscrepanciesAction } from "@/actions/ninjaone";
import { ResolveDiscrepancyButton } from "./discrepancy-dialog";

export type DiscrepancyRow = {
  id: string;
  companyId: string;
  companyName: string;
  contractId: string;
  contractName: string;
  siteName: string | null;
  lineDescription: string;
  contractedQty: string;
  observedQty: number;
  difference: string;
  unitPrice: string | null;
  status: string;
  detectedAt: Date;
  lastSeenAt: Date;
  note: string | null;
  reviewedBy: string | null;
  resolution?: string | null;
  ownerName?: string | null;
  reviewOn?: string | null;
};

const RESOLUTION: Record<string, string> = { amend_line: "line amended", reduce_at_renewal: "reduced at renewal", include_in_bundle: "included in bundle", exception: "exception", dismiss: "dismissed" };

const TONE: Record<string, string> = { open: "amber", accepted: "blue", dismissed: "slate", resolved: "green" };

export function RecheckButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="secondary" loading={pending} onClick={() => start(async () => { const r = await recheckDiscrepanciesAction(); setMsg(r.ok ? `${r.data.checked} lines checked, ${r.data.open} open, ${r.data.resolved} resolved` : r.error); router.refresh(); })}>
        <RefreshCw className="h-3.5 w-3.5" /> Re-check now
      </Button>
      {msg && <span className="text-xs text-slate-600">{msg}</span>}
    </span>
  );
}

export function DiscrepancyTable({ rows, canReview, currency, compact = false, kind = "device" }: { rows: DiscrepancyRow[]; canReview: boolean; currency: string; compact?: boolean; kind?: "device" | "licence" }) {
  const money = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n);
  const today = new Date().toISOString().slice(0, 10);
  if (rows.length === 0) return <p className="p-4 text-sm text-slate-500">No discrepancies. Contracted and observed {kind === "licence" ? "licence" : "device"} counts match for every compared line.</p>;
  return (
    <div>
      <table className="tbl">
        <thead>
          <tr>
            {!compact && <th>Company</th>}
            <th>Contract line</th>
            <th className="text-right">Contracted</th>
            <th className="text-right">{kind === "licence" ? "At supplier" : "Observed"}</th>
            <th className="text-right">Difference</th>
            <th>Status</th>
            {canReview && <th>Action</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const diff = Number(d.difference);
            const monthly = d.unitPrice ? diff * Number(d.unitPrice) : null;
            return (
              <tr key={d.id} className="align-top">
                {!compact && (
                  <td>
                    <Link href={`/companies/${d.companyId}`} className="font-medium text-brand-700 hover:underline">
                      {d.companyName}
                    </Link>
                  </td>
                )}
                <td>
                  <Link href={`/contracts/${d.contractId}`} className="hover:underline">
                    {d.lineDescription}
                  </Link>
                  <div className="text-xs text-slate-500">
                    {d.contractName}
                    {d.siteName && <> · {d.siteName}</>}
                  </div>
                </td>
                <td className="text-right tabular-nums">{Number(d.contractedQty)}</td>
                <td className="text-right tabular-nums">{d.observedQty}</td>
                <td className={`text-right tabular-nums font-medium ${diff > 0 ? "text-amber-700" : "text-blue-700"}`}>
                  {diff > 0 ? "+" : ""}
                  {diff}
                  {monthly !== null && <div className="text-[11px] font-normal text-slate-500">≈ {money(Math.abs(monthly))}/period {diff > 0 ? "unbilled" : "over-billed"}</div>}
                </td>
                <td>
                  <Badge tone={TONE[d.status]}>{d.status}</Badge>
                  {d.resolution && <div className="text-[11px] text-slate-600">{RESOLUTION[d.resolution] ?? d.resolution}</div>}
                  {d.status === "accepted" && d.reviewOn && (
                    <div className={`text-[11px] ${d.reviewOn < today ? "text-red-600" : "text-slate-500"}`}>
                      {d.ownerName ? `owner ${d.ownerName} · ` : ""}review {d.reviewOn}
                    </div>
                  )}
                  {d.reviewedBy && <div className="text-[11px] text-slate-500">by {d.reviewedBy}</div>}
                  {d.note && <div className="max-w-[200px] text-[11px] text-slate-600">{d.note}</div>}
                </td>
                {canReview && (
                  <td>
                    {d.status === "open" || d.status === "accepted" ? (
                      <ResolveDiscrepancyButton id={d.id} currency={currency} kindLabel={kind} />
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
