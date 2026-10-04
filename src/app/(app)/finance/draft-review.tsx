"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { approveUnchangedDraftsAction } from "@/actions/xero";
import { fmtMoney, fmtRelative } from "@/lib/format";
import type { BatchApprovalResult, DraftReviewRow } from "@/services/draft-review";

/**
 * Drafts awaiting approval, split into unchanged (same lines as the previous
 * invoice, Xero linked, not stale) and exceptions. Unchanged drafts can be
 * approved together; exceptions keep the one-by-one review.
 */
export function DraftReviewTable({ rows, canApprove }: { rows: DraftReviewRow[]; canApprove: boolean }) {
  const unchanged = rows.filter((r) => r.verdict === "unchanged");
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(unchanged.map((r) => r.id)));
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ ok: true; data: BatchApprovalResult } | { ok: false; error: string } | null>(null);
  const [pending, start] = useTransition();
  const selected = unchanged.filter((r) => ticked.has(r.id));
  const total = selected.reduce((a, r) => a + Number(r.subTotal), 0);
  const toggleOpen = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const approve = () =>
    start(async () => {
      const r = await approveUnchangedDraftsAction(selected.map((s) => s.id));
      setResult(r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error });
    });

  if (result?.ok) {
    const { approved, skipped } = result.data;
    return (
      <div className="space-y-3 p-4">
        <Alert tone={skipped.length ? "warn" : "success"} title={`${approved.length} draft${approved.length === 1 ? "" : "s"} created in Xero${skipped.length ? `, ${skipped.length} skipped` : ""}`}>
          Each one is a Xero draft to approve and send from Xero as usual. Skipped drafts were not touched.
        </Alert>
        {approved.length > 0 && (
          <ul className="space-y-0.5 text-sm">
            {approved.map((a) => (
              <li key={a.id}>
                <Link href={`/finance/drafts/${a.id}`} className="text-brand-700 hover:underline">{a.reference}</Link> <span className="text-slate-500">{a.companyName}</span>
              </li>
            ))}
          </ul>
        )}
        {skipped.length > 0 && (
          <div className="text-sm">
            <p className="mb-1 font-medium text-slate-700">Skipped</p>
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-600">
              {skipped.map((s) => (
                <li key={s.id}>
                  <Link href={`/finance/drafts/${s.id}`} className="text-brand-700 hover:underline">{s.reference}</Link> {s.companyName && <span>({s.companyName})</span>}: {s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <table className="tbl">
        <thead>
          <tr>
            {canApprove && (
              <th className="w-8">
                <input type="checkbox" aria-label="Select all unchanged drafts" checked={unchanged.length > 0 && selected.length === unchanged.length} onChange={(e) => setTicked(e.target.checked ? new Set(unchanged.map((r) => r.id)) : new Set())} disabled={!unchanged.length} />
              </th>
            )}
            <th>Reference</th>
            <th>Company</th>
            <th>Source</th>
            <th className="text-right">Net</th>
            <th className="text-right">Previous</th>
            <th>Review</th>
            <th>Prepared</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const isUnchanged = d.verdict === "unchanged";
            const changeLabel = d.delta === null ? null : Math.abs(d.delta) < 0.01 ? "unchanged" : `${d.delta > 0 ? "+" : ""}${fmtMoney(d.delta, d.currencyCode)} vs previous`;
            return (
              <tr key={d.id} className={isUnchanged ? "" : "bg-amber-50/40"}>
                {canApprove && (
                  <td>
                    <input type="checkbox" aria-label={`Select ${d.reference}`} checked={isUnchanged && ticked.has(d.id)} disabled={!isUnchanged} onChange={(e) => setTicked((s) => { const n = new Set(s); if (e.target.checked) n.add(d.id); else n.delete(d.id); return n; })} />
                  </td>
                )}
                <td>
                  <Link href={`/finance/drafts/${d.id}`} className="font-medium text-brand-700 hover:underline">
                    {d.reference}
                  </Link>
                  {d.description && <div className="max-w-xs truncate text-xs text-slate-500">{d.description}</div>}
                </td>
                <td>
                  <Link href={`/companies/${d.companyId}`} className="hover:underline">
                    {d.companyName}
                  </Link>
                </td>
                <td className="text-xs text-slate-600">{d.contractName ?? d.opportunityTitle ?? "manual"}</td>
                <td className="text-right tabular-nums">{fmtMoney(d.subTotal, d.currencyCode)}</td>
                <td className="text-right tabular-nums text-slate-600">
                  {d.previous ? (
                    <Link href={`/finance/drafts/${d.previous.draftId}`} className="hover:underline" title={`${d.previous.reference}, ${d.previous.periodStart} to ${d.previous.periodEnd}`}>
                      {fmtMoney(d.previous.net, d.currencyCode)}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="max-w-sm text-xs">
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge tone={isUnchanged ? "green" : d.status === "failed" ? "red" : "amber"}>{isUnchanged ? "unchanged" : d.status === "failed" ? "failed" : d.status === "approved" ? "approving" : "needs review"}</Badge>
                    {d.stale && <Badge tone="amber" title="The contract changed after this draft was prepared">stale</Badge>}
                    {changeLabel && d.reasons.length > 0 && (
                      <button type="button" className="text-brand-700 hover:underline" onClick={() => toggleOpen(d.id)}>
                        {changeLabel} · {open.has(d.id) ? "hide" : "why"}
                      </button>
                    )}
                  </div>
                  {open.has(d.id) && (
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-700">
                      {d.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  )}
                  {d.flags.filter((f) => !f.startsWith("Amount or lines differ")).map((f) => (
                    <div key={f} className={`mt-0.5 ${d.status === "failed" && f.startsWith("Last approval failed") ? "text-red-600" : "text-amber-700"}`}>{f}</div>
                  ))}
                </td>
                <td className="text-xs text-slate-500">{fmtRelative(d.createdAt)}</td>
                <td className="text-right">
                  <Link href={`/finance/drafts/${d.id}`} className="text-xs text-brand-700 hover:underline">
                    {canApprove ? "Review & approve" : "View"}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {canApprove && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
          <p className="text-sm text-slate-700">
            {selected.length} unchanged draft{selected.length === 1 ? "" : "s"} selected · {fmtMoney(total, rows[0]?.currencyCode)} net
            <span className="block text-xs text-slate-500">Unchanged = same contract lines, quantities and prices as the previous invoice, Xero linked, contract not changed since. Each is re-checked at approval; anything that changed meanwhile is skipped.</span>
          </p>
          <div className="flex items-center gap-2">
            {result && !result.ok && <span className="text-xs text-red-600">{result.error}</span>}
            <Button type="button" onClick={approve} disabled={!selected.length} loading={pending}>
              Approve {selected.length} in Xero
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
