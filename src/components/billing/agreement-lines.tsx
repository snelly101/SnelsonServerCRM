"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CoverageDialog } from "@/components/service-register";
import { ResolveDiscrepancyButton } from "@/app/(app)/devices/discrepancy-dialog";
import { ServiceLineSelect, type LineOption } from "./service-line-select";
import { fmtDate, fmtMoney, fmtRelative, type DisplaySettings } from "@/lib/format";
import { FREQUENCY_LABELS, PRICING_LABELS, REVENUE_LABELS } from "@/lib/validation-sales";
import { LINE_STATUS_LABELS, MATCH_SOURCE_LABELS } from "@/lib/billing-model";
import type { AgreementView, LineView } from "@/services/billing-picture";

const STATUS_TONE: Record<LineView["status"], string> = { ok: "green", count_differs: "amber", proposed_change: "amber", exception_accepted: "blue", cost_stale: "amber", no_source: "slate", not_recurring: "slate" };
const PROVIDER_TONE: Record<string, string> = { pax8: "indigo", twentyi: "teal", ninjaone: "blue" };

/**
 * One agreement's lines: what we bill, what it costs, where the quantity
 * comes from and whether it agrees with the rule. Essentials in the row;
 * the source records, the rule, pending changes and the count check behind
 * an expander, so a charge is explained without leaving the page.
 */
export function AgreementLines({ agreement, settings, lines, canEdit, canReview, showTotals = true }: { agreement: AgreementView; settings: DisplaySettings & { currency: string }; lines: LineOption[]; canEdit: boolean; canReview: boolean; showTotals?: boolean }) {
  const c = settings.currency;
  const [open, setOpen] = useState<Set<string>>(() => new Set(agreement.lines.filter((l) => l.status === "count_differs" || l.status === "proposed_change").map((l) => l.id)));
  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  if (agreement.lines.length === 0) return <p className="p-4 text-sm text-slate-500">No services on this agreement.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th className="w-6" />
            <th>Service</th>
            <th>Quantity</th>
            <th>Supplied by</th>
            <th className="text-right">Unit price</th>
            <th className="text-right">Cost / unit</th>
            <th className="text-right">Margin / mo</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {agreement.lines.map((l) => {
            const isOpen = open.has(l.id);
            const months = l.billingFrequency === "annual" ? 12 : l.billingFrequency === "quarterly" ? 3 : 1;
            const recurring = l.status !== "not_recurring";
            return (
              <LineRows key={l.id} line={l} isOpen={isOpen} onToggle={() => toggle(l.id)} months={months} recurring={recurring} c={c} settings={settings} lines={lines} canEdit={canEdit} canReview={canReview} />
            );
          })}
        </tbody>
        {showTotals && (
          <tfoot>
            <tr className="bg-slate-50 text-sm font-medium">
              <td colSpan={4} className="px-3 py-2">
                Per month, normalised{agreement.unknownCostLines ? <span className="ml-1 font-normal text-slate-500">({agreement.unknownCostLines} line{agreement.unknownCostLines === 1 ? "" : "s"} with cost unknown)</span> : null}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {fmtMoney(agreement.chargeMonthly, c)}
                {Math.abs(agreement.chargeMonthly - agreement.billed.monthly) >= 0.005 && (
                  <div className="text-xs font-normal text-slate-500" title="What actually goes on the invoices">
                    invoiced {[agreement.billed.monthly > 0 ? `${fmtMoney(agreement.billed.monthly, c)}/mo` : null, agreement.billed.quarterly > 0 ? `${fmtMoney(agreement.billed.quarterly, c)}/qtr` : null, agreement.billed.annual > 0 ? `${fmtMoney(agreement.billed.annual, c)}/yr` : null].filter(Boolean).join(" + ")}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{agreement.costMonthly === null ? <span className="text-slate-400">unknown</span> : fmtMoney(agreement.costMonthly, c)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{agreement.marginMonthly === null ? <span className="text-slate-400">—</span> : <span className={agreement.marginMonthly < 0 ? "text-red-700" : ""}>{fmtMoney(agreement.marginMonthly, c)}</span>}</td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function LineRows({ line: l, isOpen, onToggle, months, recurring, c, settings, lines, canEdit, canReview }: { line: LineView; isOpen: boolean; onToggle: () => void; months: number; recurring: boolean; c: string; settings: DisplaySettings & { currency: string }; lines: LineOption[]; canEdit: boolean; canReview: boolean }) {
  const perUnitLabel = months === 12 ? "/yr" : months === 3 ? "/qtr" : "/mo";
  const costPerUnitLinePeriod = l.costMonthlyPerUnit === null ? null : l.costMonthlyPerUnit * months;
  return (
    <>
      <tr className={`align-top ${isOpen ? "bg-slate-50/60" : ""}`}>
        <td className="pr-0">
          <button type="button" onClick={onToggle} className="rounded p-0.5 text-slate-500 hover:bg-slate-100" aria-expanded={isOpen} aria-label={isOpen ? "Hide details" : "Show details"}>
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </td>
        <td>
          <div className="font-medium text-slate-900">{l.description}</div>
          <div className="text-xs text-slate-500">
            {REVENUE_LABELS[l.revenueType as keyof typeof REVENUE_LABELS]} · {PRICING_LABELS[l.pricingModel as keyof typeof PRICING_LABELS]}
            {recurring && <> · {FREQUENCY_LABELS[l.billingFrequency as keyof typeof FREQUENCY_LABELS]}{l.invoiceSchedule === "own" ? ", own cycle" : ""}</>}
            {l.siteName && <> · {l.siteName}</>}
          </div>
        </td>
        <td className="tabular-nums">
          <div>
            <span className="font-medium">{l.quantity}</span>
            {recurring && <span className="ml-1 text-xs text-slate-500">{l.quantityRule === "synced" ? "synced" : "fixed"}</span>}
          </div>
          {l.observed !== null && l.observed !== l.quantity && <div className="text-xs text-amber-700">{l.observed} supplied</div>}
          {l.pendingChanges.filter((h) => h.field === "quantity").map((h) => (
            <div key={h.id} className="text-[11px] text-amber-700" title="Not yet on an invoice; the next one pro-rates it">
              {Number(h.previousValue ?? 0)} → {Number(h.newValue ?? 0)} from {fmtDate(h.effectiveFrom, settings)}
            </div>
          ))}
        </td>
        <td>
          {l.sources.length === 0 ? (
            <span className="text-xs text-slate-400">{recurring ? "manual entry" : "—"}</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {l.sources.map((s) => (
                <Badge key={s.key} tone={PROVIDER_TONE[s.provider] ?? "slate"} title={`${s.name}${s.supplierProduct ? ` · ${s.supplierProduct}` : ""}`}>
                  {s.providerLabel} × {s.quantity}
                </Badge>
              ))}
            </div>
          )}
        </td>
        <td className="text-right tabular-nums">
          {fmtMoney(l.unitPrice, c)}
          {recurring && <span className="text-xs text-slate-500">{perUnitLabel}</span>}
        </td>
        <td className="text-right tabular-nums">
          {costPerUnitLinePeriod === null ? (
            <span className="text-slate-400" title={l.unknownCostSources ? "The supplier carries no pricing; record a unit cost on the line if you know it" : "No cost recorded"}>unknown</span>
          ) : (
            <>
              {fmtMoney(costPerUnitLinePeriod, c)}
              {recurring && <span className="text-xs text-slate-500">{perUnitLabel}</span>}
              <div className="text-[11px] text-slate-500">{l.costBasis === "supplier" ? "from supplier" : "recorded"}</div>
            </>
          )}
        </td>
        <td className="text-right tabular-nums">{l.marginMonthly === null ? <span className="text-slate-400">—</span> : <span className={l.marginMonthly < 0 ? "text-red-700" : ""}>{fmtMoney(l.marginMonthly, c)}</span>}</td>
        <td>
          <Badge tone={STATUS_TONE[l.status]}>{LINE_STATUS_LABELS[l.status]}</Badge>
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-slate-50/60">
          <td />
          <td colSpan={7} className="pb-3 pt-0">
            <div className="grid gap-3 text-xs md:grid-cols-2">
              <div className="space-y-2">
                <div className="font-semibold text-slate-700">Where the quantity comes from</div>
                {l.sources.length === 0 ? (
                  <p className="text-slate-600">{recurring ? "No integration supplies this line; the quantity is what was agreed and entered by hand." : "One-off line; invoiced once."}</p>
                ) : (
                  <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-surface">
                    {l.sources.map((s) => (
                      <li key={s.key} className="flex flex-wrap items-start justify-between gap-2 px-2 py-1.5">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge tone={PROVIDER_TONE[s.provider] ?? "slate"}>{s.providerLabel}</Badge>
                            <span className="font-medium text-slate-800">{s.name}</span>
                            {s.state === "bundle" && <Badge tone="teal">bundled</Badge>}
                            {s.consoleUrl && (
                              <a href={s.consoleUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline" title="Open at the supplier">
                                <ExternalLink className="inline h-3 w-3" />
                              </a>
                            )}
                          </div>
                          <div className="text-slate-500">
                            {s.kind}
                            {s.supplierProduct && <> · {s.supplierProduct}</>} · qty {s.quantity}
                            {s.monthlyCost !== null ? <> · {fmtMoney(s.monthlyCost, c)}/mo cost</> : !s.costKnown ? <> · cost not reported</> : null}
                            {s.renewsOn && <> · renews {fmtDate(s.renewsOn, settings)}</>}
                          </div>
                          <div className="text-slate-500">
                            {s.matchedBy ? MATCH_SOURCE_LABELS[s.matchedBy] : "unmapped"}
                            {s.syncedAt && <> · synced {fmtRelative(s.syncedAt)}</>}
                            {s.status && s.status !== "active" && <> · {s.status}</>}
                          </div>
                        </div>
                        {canEdit && !s.pool && (
                          <div className="flex items-center gap-1">
                            <ServiceLineSelect source={s.source} rowId={s.rowId} value={s.state === "charged" ? (s.line?.id ?? null) : null} lines={lines} canEdit compact />
                            <CoverageDialog row={s} lines={lines} trigger="Other" />
                          </div>
                        )}
                        {s.pool && <Link href={s.href} className="text-brand-700 hover:underline">devices</Link>}
                      </li>
                    ))}
                  </ul>
                )}
                {recurring && (
                  <p className="text-slate-600">
                    <strong>Rule:</strong>{" "}
                    {l.quantityRule === "synced" ? "the integrations' count should be billed; a different count is a proposed change that one approval records as dated history." : "the agreed quantity bills; a different count from the integrations is an exception to decide."}{" "}
                    Invoices come from the recorded history, never from a live count.
                    {l.reductionPolicy !== "next_period" && <> Decreases: {l.reductionPolicy === "immediate" ? "credited for the unused days" : "old quantity billed until renewal"}.</>}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                {l.discrepancy && (
                  <div className={`rounded-md border px-3 py-2 ${l.discrepancy.status === "open" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-surface text-slate-700"}`}>
                    <div className="font-semibold">{l.status === "proposed_change" ? "Quantity change to approve" : l.discrepancy.status === "open" ? "Count differs" : "Accepted exception"}</div>
                    <div>
                      Agreed {l.discrepancy.contracted}, supplied {l.discrepancy.observed} ({l.discrepancy.difference > 0 ? "+" : ""}{l.discrepancy.difference}).
                      {l.status === "proposed_change" ? " Approve to record the new quantity from the date it changed; the next invoice pro-rates it." : " Amend the line, reduce at renewal, bundle, accept as an exception or dismiss; the money consequence is shown first."}
                    </div>
                    {canReview && l.discrepancy.status === "open" && (
                      <div className="mt-2">
                        <ResolveDiscrepancyButton id={l.discrepancy.id} currency={c} kindLabel={l.discrepancy.source === "ninjaone" ? "device" : "licence"} />
                      </div>
                    )}
                  </div>
                )}
                {l.costStale && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                    <div className="font-semibold">Recorded cost differs from the supplier</div>
                    <div>
                      The line records {l.unitCost === null ? "no cost" : `${fmtMoney(l.unitCost, c)}${perUnitLabel} per unit`}; the supplier reports {l.supplierMonthlyCost !== null && l.observed ? `${fmtMoney((l.supplierMonthlyCost / l.observed) * months, c)}${perUnitLabel}` : "a different cost"}. Margin above uses the supplier figure. Edit the line to bring the recorded cost up to date.
                    </div>
                  </div>
                )}
                {recurring && (
                  <div className="text-slate-600">
                    <strong>Per month:</strong> charge {fmtMoney(l.chargeMonthly, c)}
                    {l.costMonthly !== null ? <>, cost {fmtMoney(l.costMonthly, c)}, margin {fmtMoney(l.marginMonthly ?? 0, c)}</> : <>, cost unknown</>}
                    {l.unknownCostSources > 0 && <> ({l.unknownCostSources} source{l.unknownCostSources === 1 ? "" : "s"} without supplier pricing)</>}.
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
