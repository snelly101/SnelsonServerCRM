"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { fmtMoney, fmtPercent } from "@/lib/format";
import { summariseLines } from "@/lib/money";
import { FREQUENCY_LABELS, PRICING_LABELS, REVENUE_LABELS, billingFrequencyValues, pricingModelValues, revenueTypeValues } from "@/lib/validation-sales";

export type EditableLine = {
  key: string;
  productId: string;
  description: string;
  revenueType: (typeof revenueTypeValues)[number];
  pricingModel: (typeof pricingModelValues)[number];
  billingFrequency: (typeof billingFrequencyValues)[number];
  quantity: number;
  unitPrice: number;
  unitCost: number | null;
  siteId?: string;
  countsAsManagedDevice?: boolean;
};

export type ProductOption = {
  id: string;
  name: string;
  pricingModel: EditableLine["pricingModel"];
  revenueType: EditableLine["revenueType"];
  billingFrequency: EditableLine["billingFrequency"];
  unitPrice: string;
  unitCost: string | null;
  countsAsManagedDevice: boolean;
};

let counter = 0;
const newKey = () => `l${Date.now()}_${counter++}`;

export function emptyLine(): EditableLine {
  return { key: newKey(), productId: "", description: "", revenueType: "recurring", pricingModel: "per_user", billingFrequency: "monthly", quantity: 1, unitPrice: 0, unitCost: null };
}

/**
 * Line-item editor used by opportunities and contracts. Renders hidden
 * inputs named lines[i][field] so the server action can parse them with
 * `linesFromForm`. Shows a live revenue/margin summary.
 */
export function LinesEditor({
  initial,
  products,
  currency,
  showSite,
  sites = [],
  quantityLabel = "Qty",
}: {
  initial: EditableLine[];
  products: ProductOption[];
  currency: string;
  showSite?: boolean;
  sites?: { id: string; name: string }[];
  quantityLabel?: string;
}) {
  const [lines, setLines] = useState<EditableLine[]>(initial.length ? initial : []);
  const summary = useMemo(() => summariseLines(lines), [lines]);

  const update = (key: string, patch: Partial<EditableLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const applyProduct = (key: string, productId: string) => {
    const p = products.find((x) => x.id === productId);
    if (!p) return update(key, { productId: "" });
    update(key, {
      productId,
      description: p.name,
      pricingModel: p.pricingModel,
      revenueType: p.revenueType,
      billingFrequency: p.billingFrequency,
      unitPrice: Number(p.unitPrice),
      unitCost: p.unitCost === null ? null : Number(p.unitCost),
      countsAsManagedDevice: p.countsAsManagedDevice,
    });
  };

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="tbl min-w-[900px]">
          <thead>
            <tr>
              <th className="w-48">Product</th>
              <th>Description</th>
              <th className="w-32">Type</th>
              <th className="w-28">Pricing</th>
              <th className="w-28">Billing</th>
              {showSite && <th className="w-32">Site</th>}
              <th className="w-20">{quantityLabel}</th>
              <th className="w-28">Unit price</th>
              <th className="w-28">Unit cost</th>
              <th className="w-28 text-right">Total</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={showSite ? 11 : 10} className="py-6 text-center text-sm text-slate-500">
                  No line items yet. Add products or services to value this record.
                </td>
              </tr>
            )}
            {lines.map((l, i) => (
              <tr key={l.key} className="align-top">
                <td>
                  <Select aria-label="Product" value={l.productId} onChange={(e) => applyProduct(l.key, e.target.value)} className="text-xs">
                    <option value="">Custom line</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                  <input type="hidden" name={`lines[${i}][productId]`} value={l.productId} />
                  {showSite && <input type="hidden" name={`lines[${i}][countsAsManagedDevice]`} value={l.pricingModel === "per_device" && l.countsAsManagedDevice ? "true" : "false"} />}
                </td>
                <td>
                  <Input aria-label="Description" name={`lines[${i}][description]`} value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} required className="text-xs" />
                  {showSite && l.pricingModel === "per_device" && (
                    <label className="mt-1 flex items-center gap-1 text-[11px] text-slate-600">
                      <input type="checkbox" checked={Boolean(l.countsAsManagedDevice)} onChange={(e) => update(l.key, { countsAsManagedDevice: e.target.checked })} /> Compare with NinjaOne device count
                    </label>
                  )}
                </td>
                <td>
                  <Select aria-label="Revenue type" name={`lines[${i}][revenueType]`} value={l.revenueType} onChange={(e) => update(l.key, { revenueType: e.target.value as EditableLine["revenueType"], billingFrequency: e.target.value === "recurring" ? (l.billingFrequency === "one_off" ? "monthly" : l.billingFrequency) : "one_off" })} className="text-xs">
                    {revenueTypeValues.map((v) => (
                      <option key={v} value={v}>
                        {REVENUE_LABELS[v]}
                      </option>
                    ))}
                  </Select>
                </td>
                <td>
                  <Select aria-label="Pricing model" name={`lines[${i}][pricingModel]`} value={l.pricingModel} onChange={(e) => update(l.key, { pricingModel: e.target.value as EditableLine["pricingModel"] })} className="text-xs">
                    {pricingModelValues.map((v) => (
                      <option key={v} value={v}>
                        {PRICING_LABELS[v]}
                      </option>
                    ))}
                  </Select>
                </td>
                <td>
                  <Select aria-label="Billing frequency" name={`lines[${i}][billingFrequency]`} value={l.billingFrequency} disabled={l.revenueType !== "recurring"} onChange={(e) => update(l.key, { billingFrequency: e.target.value as EditableLine["billingFrequency"] })} className="text-xs">
                    {billingFrequencyValues.map((v) => (
                      <option key={v} value={v}>
                        {FREQUENCY_LABELS[v]}
                      </option>
                    ))}
                  </Select>
                  {l.revenueType !== "recurring" && <input type="hidden" name={`lines[${i}][billingFrequency]`} value="one_off" />}
                </td>
                {showSite && (
                  <td>
                    <Select aria-label="Site" name={`lines[${i}][siteId]`} value={l.siteId ?? ""} onChange={(e) => update(l.key, { siteId: e.target.value })} className="text-xs">
                      <option value="">All sites</option>
                      {sites.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                )}
                <td>
                  <Input aria-label="Quantity" name={`lines[${i}][quantity]`} type="number" min={0} step="1" value={l.quantity} onChange={(e) => update(l.key, { quantity: Number(e.target.value) })} className="text-xs" />
                </td>
                <td>
                  <Input aria-label="Unit price" name={`lines[${i}][unitPrice]`} type="number" min={0} step="0.01" value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: Number(e.target.value) })} className="text-xs" />
                </td>
                <td>
                  <Input aria-label="Unit cost" name={`lines[${i}][unitCost]`} type="number" min={0} step="0.01" value={l.unitCost ?? ""} placeholder="unknown" onChange={(e) => update(l.key, { unitCost: e.target.value === "" ? null : Number(e.target.value) })} className="text-xs" />
                </td>
                <td className="text-right text-sm tabular-nums">
                  {fmtMoney(l.quantity * l.unitPrice, currency)}
                  {l.revenueType === "recurring" && <div className="text-[11px] text-slate-500">/{l.billingFrequency === "annual" ? "yr" : l.billingFrequency === "quarterly" ? "qtr" : "mo"}</div>}
                </td>
                <td>
                  <button type="button" aria-label="Remove line" className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
          <Plus className="h-4 w-4" /> Add line
        </Button>
        <RevenueSummaryBadges summary={summary} currency={currency} />
      </div>
    </div>
  );
}

export function RevenueSummaryBadges({ summary, currency, compact }: { summary: ReturnType<typeof summariseLines>; currency: string; compact?: boolean }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? "text-xs" : "text-sm"}`}>
      <Badge tone="green">MRR {fmtMoney(summary.mrr, currency)}</Badge>
      {summary.oneOff > 0 && <Badge tone="blue">Project {fmtMoney(summary.oneOff, currency)}</Badge>}
      {summary.hardware > 0 && <Badge tone="indigo">Hardware {fmtMoney(summary.hardware, currency)}</Badge>}
      <Badge>First year {fmtMoney(summary.firstYearValue, currency)}</Badge>
      <Badge tone={summary.marginPercent === null ? "slate" : summary.marginPercent < 20 ? "red" : "teal"} className="inline-flex items-center gap-1">
        Margin {summary.marginPercent === null ? "unknown" : fmtPercent(summary.marginPercent, 0)}
        {summary.marginIsEstimate && summary.marginPercent !== null && <span title="One or more lines have no cost recorded">(estimate)</span>}
      </Badge>
    </div>
  );
}
