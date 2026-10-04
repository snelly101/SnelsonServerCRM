"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Select, Checkbox } from "@/components/ui/form";
import { applyPriceReviewAction, previewPriceReviewAction } from "@/actions/contracts";
import { fmtDate, fmtMoney, type DisplaySettings } from "@/lib/format";
import type { PriceReviewInput, PriceReviewPreview } from "@/services/price-reviews";

type Product = { id: string; name: string; unitPrice: string; unitCost: string | null };
type Kind = PriceReviewInput["change"]["kind"];
const KIND_LABEL: Record<Kind, string> = { percent: "Increase or decrease by a percentage", unit_price: "Set a new unit price", cost_passthrough: "Supplier cost has changed: pass it through at the same margin" };

export function PriceReviewForm({ products, currency, settings, canApply }: { products: Product[]; currency: string; settings: DisplaySettings; canApply: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [productId, setProductId] = useState("");
  const [contains, setContains] = useState("");
  const [kind, setKind] = useState<Kind>("percent");
  const [value, setValue] = useState("5");
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [reason, setReason] = useState("");
  const [updateCatalogue, setUpdateCatalogue] = useState(true);
  const [preview, setPreview] = useState<PriceReviewPreview | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ lines: number; monthlyDelta: number; applied: { contractId: string; companyName: string; contractName: string; lines: number; appliedFrom: string }[] } | null>(null);
  const [pending, start] = useTransition();
  const input = (): PriceReviewInput => ({ scope: { productId: productId || null, descriptionContains: contains || null }, change: { kind, value: Number(value) }, effectiveFrom, reason, updateCatalogue: Boolean(productId) && updateCatalogue });
  const run = () =>
    start(async () => {
      setDone(null);
      const r = await previewPriceReviewAction(input());
      if (!r.ok) return setError(r.error);
      setError(null);
      setPreview(r.data);
      setTicked(new Set(r.data.lines.filter((l) => l.applicable).map((l) => l.lineId)));
    });
  const apply = () =>
    start(async () => {
      const r = await applyPriceReviewAction({ ...input(), lineIds: [...ticked] });
      if (!r.ok) return setError(r.error);
      setError(null);
      setDone(r.data);
      setPreview(null);
    });
  const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);
  const selected = preview ? preview.lines.filter((l) => l.applicable && ticked.has(l.lineId)) : [];
  const selectedDelta = selected.reduce((a, l) => a + l.monthlyDelta, 0);

  return (
    <div className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}
      {done && (
        <Alert tone="success" title={`${done.lines} line${done.lines === 1 ? "" : "s"} changed across ${done.applied.length} contract${done.applied.length === 1 ? "" : "s"} (${done.monthlyDelta >= 0 ? "+" : ""}${fmtMoney(done.monthlyDelta, currency)} per month)`}>
          Each change is dated in the contract&apos;s history with your reason and takes effect on the first invoice period on or after its date.
          <ul className="mt-1 list-disc pl-5 text-xs">
            {done.applied.map((a) => (
              <li key={a.contractId}>
                <Link href={`/contracts/${a.contractId}`} className="underline">{a.companyName} · {a.contractName}</Link>: {a.lines} line{a.lines === 1 ? "" : "s"} from {fmtDate(a.appliedFrom, settings)}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Product" htmlFor="product" help="Lines built from this catalogue product">
          <Select id="product" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Any product</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({fmtMoney(p.unitPrice, currency)})</option>
            ))}
          </Select>
        </Field>
        <Field label="Or line description contains" htmlFor="contains" help="Matches contract lines by their description">
          <Input id="contains" value={contains} onChange={(e) => setContains(e.target.value)} placeholder="Microsoft 365 Business Standard" />
        </Field>
        <Field label="Effective from" htmlFor="effectiveFrom" help="Applies from the first invoice period on or after this day; never pro-rated">
          <Input id="effectiveFrom" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </Field>
        <Field label="Change" htmlFor="kind" className="sm:col-span-2">
          <Select id="kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <option key={k} value={k}>{KIND_LABEL[k]}</option>
            ))}
          </Select>
        </Field>
        <Field label={kind === "percent" ? "Percent" : kind === "unit_price" ? "New unit price" : "New supplier unit cost"} htmlFor="value">
          <Input id="value" type="number" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Reason" htmlFor="reason" required help="Written into every affected customer's change history" className="sm:col-span-2">
          <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Microsoft price increase from 1 November 2026" />
        </Field>
        <div className="flex items-end gap-3">
          {productId && <Checkbox label="Also update the catalogue list price" checked={updateCatalogue} onChange={(e) => setUpdateCatalogue(e.target.checked)} />}
          <Button type="button" onClick={run} loading={pending} variant="secondary">Preview</Button>
        </div>
      </div>

      {preview && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Lines" value={`${preview.totals.lines}`} hint={`${preview.totals.customers} customer${preview.totals.customers === 1 ? "" : "s"}`} />
            <Stat label="Monthly now" value={fmtMoney(preview.totals.monthlyNow, currency)} />
            <Stat label="Monthly after" value={fmtMoney(preview.totals.monthlyAfter, currency)} hint={`${preview.totals.monthlyDelta >= 0 ? "+" : ""}${fmtMoney(preview.totals.monthlyDelta, currency)}`} />
            <Stat label="Margin now" value={pct(preview.totals.marginNow)} />
            <Stat label="Margin after" value={pct(preview.totals.marginAfter)} tone={preview.totals.marginAfter !== null && preview.totals.marginNow !== null && preview.totals.marginAfter < preview.totals.marginNow ? "warn" : "default"} />
          </div>
          {preview.lines.length === 0 ? (
            <p className="text-sm text-slate-500">No active contract lines match.</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  {canApply && <th className="w-8"><input type="checkbox" aria-label="Select all" checked={selected.length === preview.lines.filter((l) => l.applicable).length} onChange={(e) => setTicked(e.target.checked ? new Set(preview.lines.filter((l) => l.applicable).map((l) => l.lineId)) : new Set())} /></th>}
                  <th>Customer / line</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Price → new</th>
                  <th className="text-right">Cost → new</th>
                  <th className="text-right">Margin → after</th>
                  <th className="text-right">Monthly change</th>
                  <th>Applies from</th>
                  <th>Constraints</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((l) => (
                  <tr key={l.lineId} className={!l.applicable ? "opacity-60" : ""}>
                    {canApply && <td><input type="checkbox" aria-label={`Select ${l.description}`} disabled={!l.applicable} checked={l.applicable && ticked.has(l.lineId)} onChange={(e) => setTicked((s) => { const n = new Set(s); if (e.target.checked) n.add(l.lineId); else n.delete(l.lineId); return n; })} /></td>}
                    <td>
                      <Link href={`/companies/${l.companyId}`} className="font-medium text-brand-700 hover:underline">{l.companyName}</Link>
                      <div className="text-xs text-slate-500"><Link href={`/contracts/${l.contractId}`} className="hover:underline">{l.contractName}</Link> · {l.description}</div>
                    </td>
                    <td className="text-right tabular-nums">{l.quantity}</td>
                    <td className="text-right tabular-nums">{fmtMoney(l.unitPrice, currency)} → <span className="font-medium">{fmtMoney(l.newUnitPrice, currency)}</span></td>
                    <td className="text-right tabular-nums text-slate-600">{l.unitCost === null ? "—" : fmtMoney(l.unitCost, currency)}{l.newUnitCost !== null && l.newUnitCost !== l.unitCost ? <> → {fmtMoney(l.newUnitCost, currency)}</> : null}</td>
                    <td className="text-right tabular-nums">{pct(l.marginNow)} → <span className={l.marginAfter !== null && l.marginNow !== null && l.marginAfter < l.marginNow ? "text-amber-700" : ""}>{pct(l.marginAfter)}</span></td>
                    <td className={`text-right tabular-nums ${l.monthlyDelta < 0 ? "text-red-700" : ""}`}>{l.monthlyDelta >= 0 ? "+" : ""}{fmtMoney(l.monthlyDelta, currency)}</td>
                    <td className="text-xs whitespace-nowrap">{l.applicable ? <>{fmtDate(l.appliedFrom, settings)}{l.firstPeriodStart && l.firstPeriodStart !== l.appliedFrom ? <div className="text-slate-500">invoiced from {fmtDate(l.firstPeriodStart, settings)}</div> : null}</> : <Badge tone="slate">not applicable</Badge>}</td>
                    <td className="max-w-xs text-xs text-amber-800">{l.constraints.map((c) => <div key={c}>{c}</div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {canApply && preview.lines.some((l) => l.applicable) && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
              <p className="text-sm text-slate-700">
                {selected.length} line{selected.length === 1 ? "" : "s"} selected · {selectedDelta >= 0 ? "+" : ""}{fmtMoney(selectedDelta, currency)} per month
                <span className="block text-xs text-slate-500">Applying records a dated price change per line with your reason. The next invoice period on or after each date carries the new price. Nothing is sent to Xero by this.</span>
              </p>
              <Button type="button" onClick={apply} loading={pending} disabled={!selected.length || !reason.trim()} title={!reason.trim() ? "Give a reason first" : undefined}>
                Apply to {selected.length} line{selected.length === 1 ? "" : "s"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint, tone = "default" }: { label: string; value: string; hint?: string; tone?: "default" | "warn" }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${tone === "warn" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-surface"}`}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-slate-500">{hint}</div>}
    </div>
  );
}
