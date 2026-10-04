"use client";

import { useId, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { fmtMoney, fmtPercent } from "@/lib/format";
import { summariseLines } from "@/lib/money";
import { CATEGORY_LABELS, FREQUENCY_LABELS, PRICING_LABELS, REVENUE_LABELS, billingFrequencyValues, pricingModelValues, revenueTypeValues } from "@/lib/validation-sales";

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
  sku: string | null;
  category: string;
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
  // Lines whose details panel is open. A custom line with no description opens by itself so it can be named.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
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
    <div className="space-y-2">
      <div className="rounded-md border border-slate-200">
        <div className="hidden grid-cols-12 gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 sm:grid">
          <div className="col-span-5">Product</div>
          <div className="col-span-2">{quantityLabel}</div>
          <div className="col-span-2">Unit price</div>
          <div className="col-span-2 text-right">Total</div>
          <div className="col-span-1" />
        </div>
        {lines.length === 0 && <div className="px-4 py-6 text-center text-sm text-slate-500">No line items yet. Add a product or service to value this record.</div>}
        {lines.map((l, i) => {
          const product = products.find((p) => p.id === l.productId) ?? null;
          const open = expanded.has(l.key);
          const perPeriod = l.quantity * l.unitPrice;
          const periodLabel = l.revenueType === "recurring" ? `/${l.billingFrequency === "annual" ? "yr" : l.billingFrequency === "quarterly" ? "qtr" : "mo"}` : "one-off";
          const siteName = l.siteId ? sites.find((x) => x.id === l.siteId)?.name : null;
          const summary = [
            product && l.description && l.description !== product.name ? `“${l.description}”` : null,
            REVENUE_LABELS[l.revenueType],
            PRICING_LABELS[l.pricingModel],
            l.revenueType === "recurring" ? FREQUENCY_LABELS[l.billingFrequency] : null,
            showSite ? (siteName ?? "all sites") : null,
            l.unitCost !== null ? `cost ${fmtMoney(l.unitCost, currency)}` : "cost unknown",
            showSite && l.pricingModel === "per_device" && l.countsAsManagedDevice ? "checked against NinjaOne" : null,
          ]
            .filter(Boolean)
            .join(" · ");
          const field = (label: string, node: React.ReactNode) => (
            <label className="block min-w-0">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
              {node}
            </label>
          );
          return (
            <div key={l.key} className="border-b border-slate-100 px-3 py-2 last:border-b-0">
              <input type="hidden" name={`lines[${i}][productId]`} value={l.productId} />
              {/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(l.key) && <input type="hidden" name={`lines[${i}][id]`} value={l.key} />}
              {showSite && <input type="hidden" name={`lines[${i}][countsAsManagedDevice]`} value={l.pricingModel === "per_device" && l.countsAsManagedDevice ? "true" : "false"} />}
              {l.revenueType !== "recurring" && <input type="hidden" name={`lines[${i}][billingFrequency]`} value="one_off" />}
              {/* Fields that stay in the form even while the details panel is closed. */}
              {!open && (
                <>
                  <input type="hidden" name={`lines[${i}][description]`} value={l.description} />
                  <input type="hidden" name={`lines[${i}][revenueType]`} value={l.revenueType} />
                  <input type="hidden" name={`lines[${i}][pricingModel]`} value={l.pricingModel} />
                  {l.revenueType === "recurring" && <input type="hidden" name={`lines[${i}][billingFrequency]`} value={l.billingFrequency} />}
                  {showSite && <input type="hidden" name={`lines[${i}][siteId]`} value={l.siteId ?? ""} />}
                  <input type="hidden" name={`lines[${i}][unitCost]`} value={l.unitCost ?? ""} />
                </>
              )}

              <div className="grid grid-cols-2 items-start gap-3 sm:grid-cols-12">
                <div className="col-span-2 sm:col-span-5">
                  <ProductPicker products={products} value={l.productId} currency={currency} fallbackLabel={l.description} onSelect={(id) => applyProduct(l.key, id)} />
                  <button type="button" className="mt-1 max-w-full truncate text-left text-xs text-slate-500 hover:text-brand-700 hover:underline" onClick={() => toggle(l.key)} title="Show or hide the details">
                    {summary} · {open ? "hide details" : "details"}
                  </button>
                </div>
                <div className="sm:col-span-2">
                  <Input aria-label="Quantity" name={`lines[${i}][quantity]`} type="number" min={0} step="1" value={l.quantity} onChange={(e) => update(l.key, { quantity: Number(e.target.value) })} />
                </div>
                <div className="sm:col-span-2">
                  <Input aria-label="Unit price" name={`lines[${i}][unitPrice]`} type="number" min={0} step="0.01" value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: Number(e.target.value) })} />
                </div>
                <div className="py-2 text-right text-sm font-medium tabular-nums text-slate-800 sm:col-span-2">
                  {fmtMoney(perPeriod, currency)}
                  <span className="ml-1 text-xs font-normal text-slate-500">{periodLabel}</span>
                </div>
                <div className="flex justify-end sm:col-span-1">
                  <button type="button" aria-label="Remove line" className="rounded p-2 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {open && (
                <div className="mt-2 rounded-md bg-slate-50 p-3">
                  <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 ${showSite ? "lg:grid-cols-6" : "lg:grid-cols-5"}`}>
                    <div className="col-span-2 sm:col-span-3 lg:col-span-6">
                      {field("Description on the invoice", <Input aria-label="Description" name={`lines[${i}][description]`} value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} required placeholder={product ? product.name : "What the customer is paying for"} />)}
                    </div>
                    {field(
                      "Type",
                      <Select aria-label="Revenue type" name={`lines[${i}][revenueType]`} value={l.revenueType} onChange={(e) => update(l.key, { revenueType: e.target.value as EditableLine["revenueType"], billingFrequency: e.target.value === "recurring" ? (l.billingFrequency === "one_off" ? "monthly" : l.billingFrequency) : "one_off" })}>
                        {revenueTypeValues.map((v) => (
                          <option key={v} value={v}>
                            {REVENUE_LABELS[v]}
                          </option>
                        ))}
                      </Select>,
                    )}
                    {field(
                      "Pricing",
                      <Select aria-label="Pricing model" name={`lines[${i}][pricingModel]`} value={l.pricingModel} onChange={(e) => update(l.key, { pricingModel: e.target.value as EditableLine["pricingModel"] })}>
                        {pricingModelValues.map((v) => (
                          <option key={v} value={v}>
                            {PRICING_LABELS[v]}
                          </option>
                        ))}
                      </Select>,
                    )}
                    {field(
                      "Billing",
                      <Select aria-label="Billing frequency" name={`lines[${i}][billingFrequency]`} value={l.billingFrequency} disabled={l.revenueType !== "recurring"} onChange={(e) => update(l.key, { billingFrequency: e.target.value as EditableLine["billingFrequency"] })}>
                        {billingFrequencyValues.map((v) => (
                          <option key={v} value={v}>
                            {FREQUENCY_LABELS[v]}
                          </option>
                        ))}
                      </Select>,
                    )}
                    {showSite &&
                      field(
                        "Site",
                        <Select aria-label="Site" name={`lines[${i}][siteId]`} value={l.siteId ?? ""} onChange={(e) => update(l.key, { siteId: e.target.value })}>
                          <option value="">All sites</option>
                          {sites.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                        </Select>,
                      )}
                    {field("Unit cost", <Input aria-label="Unit cost" name={`lines[${i}][unitCost]`} type="number" min={0} step="0.01" value={l.unitCost ?? ""} placeholder="unknown" onChange={(e) => update(l.key, { unitCost: e.target.value === "" ? null : Number(e.target.value) })} />)}
                    {showSite && l.pricingModel === "per_device" && (
                      <label className="flex items-end gap-2 pb-2 text-xs text-slate-600">
                        <input type="checkbox" className="h-3.5 w-3.5 accent-brand-600" checked={Boolean(l.countsAsManagedDevice)} onChange={(e) => update(l.key, { countsAsManagedDevice: e.target.checked })} /> Compare with NinjaOne device count
                      </label>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            const line = emptyLine();
            setLines((ls) => [...ls, line]);
            setExpanded((s) => new Set(s).add(line.key));
          }}
        >
          <Plus className="h-4 w-4" /> Add line
        </Button>
        <RevenueSummaryBadges summary={summary} currency={currency} />
      </div>
    </div>
  );
}

/**
 * Searchable product picker: type to filter the catalogue by name, SKU or
 * category; arrow keys and Enter choose; Escape closes. Choosing a product
 * fills the line; "Custom line" keeps whatever is typed and clears the link.
 */
export function ProductPicker({ products, value, currency, fallbackLabel, onSelect }: { products: ProductOption[]; value: string; currency: string; fallbackLabel?: string; onSelect: (id: string) => void }) {
  const selected = products.find((p) => p.id === value) ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listId = useId();
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    const scored = products
      .map((p) => {
        const name = p.name.toLowerCase();
        const sku = (p.sku ?? "").toLowerCase();
        const cat = ((CATEGORY_LABELS as Record<string, string>)[p.category] ?? p.category).toLowerCase();
        const score = !q ? 1 : name.startsWith(q) ? 4 : sku.startsWith(q) ? 3 : name.includes(q) || sku.includes(q) ? 2 : cat.includes(q) ? 1 : 0;
        return { p, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name));
    return scored.slice(0, 50).map((x) => x.p);
  }, [products, q]);
  const choose = (id: string) => {
    onSelect(id);
    setQuery("");
    setOpen(false);
  };
  return (
    <div className="relative">
      <input
        role="combobox"
        aria-label="Product"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        className="input"
        placeholder={selected ? selected.name : fallbackLabel ? `${fallbackLabel} (custom)` : "Search the catalogue…"}
        value={open ? query : selected ? selected.name : fallbackLabel ? `${fallbackLabel} (custom)` : ""}
        onFocus={() => {
          setOpen(true);
          setCursor(0);
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setQuery(e.target.value);
          setCursor(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, matches.length));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(cursor === 0 ? "" : matches[cursor - 1]?.id ?? "");
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && (
        <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-72 w-full min-w-[20rem] overflow-auto rounded-md border border-slate-200 bg-surface py-1 text-sm shadow-lg" onMouseDown={(e) => e.preventDefault()}>
          <li role="option" aria-selected={cursor === 0} className={`cursor-pointer px-3 py-1.5 text-slate-600 ${cursor === 0 ? "bg-brand-50" : "hover:bg-slate-50"}`} onMouseEnter={() => setCursor(0)} onClick={() => choose("")}>
            Custom line (no catalogue product)
          </li>
          {matches.length === 0 && <li className="px-3 py-1.5 text-slate-400">No products match “{query}”</li>}
          {matches.map((p, idx) => {
            const active = cursor === idx + 1;
            return (
              <li key={p.id} role="option" aria-selected={active} className={`cursor-pointer px-3 py-1.5 ${active ? "bg-brand-50" : "hover:bg-slate-50"}`} onMouseEnter={() => setCursor(idx + 1)} onClick={() => choose(p.id)}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate font-medium text-slate-800">{p.name}</span>
                  <span className="shrink-0 tabular-nums text-slate-600">
                    {fmtMoney(p.unitPrice, currency)}
                    <span className="text-xs text-slate-400">{p.revenueType === "recurring" ? `/${p.billingFrequency === "annual" ? "yr" : p.billingFrequency === "quarterly" ? "qtr" : "mo"}` : ""}</span>
                  </span>
                </div>
                <div className="truncate text-xs text-slate-500">
                  {p.sku ? `${p.sku} · ` : ""}
                  {(CATEGORY_LABELS as Record<string, string>)[p.category] ?? p.category} · {PRICING_LABELS[p.pricingModel]}
                </div>
              </li>
            );
          })}
          {products.length > matches.length && q === "" && <li className="px-3 py-1.5 text-xs text-slate-400">Showing the first {matches.length} of {products.length}: type to search.</li>}
        </ul>
      )}
    </div>
  );
}

export function RevenueSummaryBadges({ summary, currency, compact }: { summary: ReturnType<typeof summariseLines>; currency: string; compact?: boolean }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? "text-xs" : "text-sm"}`}>
      <Badge tone="green" title="Recurring lines billed monthly: what goes on each monthly invoice">
        Monthly {fmtMoney(summary.monthlyBilled, currency)}
      </Badge>
      {summary.quarterlyBilled > 0 && (
        <Badge tone="green" title="Recurring lines billed every three months">
          Quarterly {fmtMoney(summary.quarterlyBilled, currency)}/qtr
        </Badge>
      )}
      {summary.annualBilled > 0 && (
        <Badge tone="green" title="Recurring lines billed once a year">
          Annually {fmtMoney(summary.annualBilled, currency)}/yr
        </Badge>
      )}
      {Math.abs(summary.mrr - summary.monthlyBilled) >= 0.005 && (
        <Badge tone="slate" title="Normalised MRR: annual ÷ 12 and quarterly ÷ 3 added to the monthly lines. Used for forecasting, not what is invoiced in a month.">
          MRR {fmtMoney(summary.mrr, currency)} normalised
        </Badge>
      )}
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
