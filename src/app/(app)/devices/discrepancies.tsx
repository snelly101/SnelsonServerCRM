"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/form";
import { recheckDiscrepanciesAction, reviewDiscrepancyAction } from "@/actions/ninjaone";

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
};

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

export function DiscrepancyTable({ rows, canReview, currency, compact = false }: { rows: DiscrepancyRow[]; canReview: boolean; currency: string; compact?: boolean }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const money = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n);
  const review = (id: string, status: "accepted" | "dismissed") =>
    start(async () => {
      const r = await reviewDiscrepancyAction(id, status, notes[id] ?? "");
      setError(r.ok ? null : r.error);
      router.refresh();
    });
  if (rows.length === 0) return <p className="p-4 text-sm text-slate-500">No discrepancies. Contracted and observed counts match for every compared line.</p>;
  return (
    <div>
      {error && <p className="px-4 py-2 text-sm text-red-700">{error}</p>}
      <table className={`tbl ${pending ? "opacity-70" : ""}`}>
        <thead>
          <tr>
            {!compact && <th>Company</th>}
            <th>Contract line</th>
            <th className="text-right">Contracted</th>
            <th className="text-right">Observed</th>
            <th className="text-right">Difference</th>
            <th>Status</th>
            {canReview && <th>Review</th>}
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
                  {d.reviewedBy && <div className="text-[11px] text-slate-500">by {d.reviewedBy}</div>}
                  {d.note && <div className="max-w-[200px] text-[11px] text-slate-600">{d.note}</div>}
                </td>
                {canReview && (
                  <td>
                    {d.status === "open" ? (
                      <div className="flex flex-wrap items-center gap-1">
                        <Input aria-label="Review note" placeholder="note (optional)" className="h-8 w-40 text-xs" value={notes[d.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [d.id]: e.target.value }))} />
                        <Button size="sm" variant="ghost" title="Accept: the difference is known (e.g. contract will be amended); re-opens if the gap grows" onClick={() => review(d.id, "accepted")}>
                          <Check className="h-3.5 w-3.5" /> Accept
                        </Button>
                        <Button size="sm" variant="ghost" title="Dismiss: not a billing matter" onClick={() => review(d.id, "dismissed")}>
                          <X className="h-3.5 w-3.5" /> Dismiss
                        </Button>
                      </div>
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
