import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { customersBillingPicture } from "@/services/billing-picture";
import { Card, Stat } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { fmtDate, fmtMoney } from "@/lib/format";
import { param } from "@/lib/utils";
import { FREQUENCY_LABELS } from "@/lib/validation-sales";

export const metadata = { title: "Billing · Customers" };

/** One row per customer: what we bill, what it costs, margin, next invoice and whether anything needs attention. */
export default async function BillingCustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission("finance.read");
  const sp = await searchParams;
  const q = (param(sp, "q") ?? "").toLowerCase();
  const only = param(sp, "only") ?? "all";
  const [settings, all] = await Promise.all([getAppSettings(), customersBillingPicture()]);
  const c = settings.currency;
  let rows = all;
  if (q) rows = rows.filter((r) => r.companyName.toLowerCase().includes(q));
  if (only === "attention") rows = rows.filter((r) => r.attention > 0);
  if (only === "unknown_cost") rows = rows.filter((r) => r.unknownCostLines > 0);
  if (only === "no_agreement") rows = rows.filter((r) => r.agreements === 0);
  const charge = all.reduce((a, r) => a + r.chargeMonthly, 0);
  const billed = { monthly: all.reduce((a, r) => a + r.billed.monthly, 0), quarterly: all.reduce((a, r) => a + r.billed.quarterly, 0), annual: all.reduce((a, r) => a + r.billed.annual, 0) };
  const cost = all.reduce((a, r) => a + (r.costMonthly ?? 0), 0);
  const known = all.filter((r) => r.costMonthly !== null).length;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Customers billed" value={all.filter((r) => r.agreements > 0).length} hint={`${all.filter((r) => r.agreements === 0).length} supplied without an agreement`} />
        <Stat label="Billed monthly" value={fmtMoney(billed.monthly, c)} hint={[billed.quarterly > 0 ? `+ ${fmtMoney(billed.quarterly, c)}/qtr` : null, billed.annual > 0 ? `+ ${fmtMoney(billed.annual, c)}/yr` : null, Math.abs(charge - billed.monthly) >= 0.005 ? `MRR ${fmtMoney(charge, c)} normalised` : "across active agreements"].filter(Boolean).join(" · ")} />
        <Stat label="Supplier cost / month" value={fmtMoney(cost, c)} hint={`known for ${known} of ${all.length} customers`} />
        <Stat label="Margin / month" value={fmtMoney(charge - cost, c)} hint={charge ? `${Math.round(((charge - cost) / charge) * 100)}% where cost is known` : undefined} tone="good" />
      </div>
      <Card padded={false}>
        <form method="get" className="flex flex-wrap items-end gap-2 border-b border-slate-100 px-4 py-3">
          <Input name="q" defaultValue={param(sp, "q") ?? ""} placeholder="Search customer" className="w-56" aria-label="Search" />
          <Select name="only" defaultValue={only} aria-label="Show" className="w-56">
            <option value="all">All customers</option>
            <option value="attention">Needs attention</option>
            <option value="unknown_cost">Cost unknown on a line</option>
            <option value="no_agreement">Supplied without an agreement</option>
          </Select>
          <Button type="submit" size="sm" variant="secondary">Filter</Button>
          {(q || only !== "all") && <Link href="/billing/customers" className="text-xs text-brand-700 hover:underline">clear</Link>}
        </form>
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No customers match.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Agreements</th>
                  <th>Next invoice</th>
                  <th className="text-right" title="Recurring lines billed monthly; quarterly and annual lines listed per period">Billed / mo</th>
                  <th className="text-right">Cost / mo</th>
                  <th className="text-right">Margin / mo</th>
                  <th>Supplied</th>
                  <th>Attention</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.companyId}>
                    <td><Link href={`/companies/${r.companyId}?tab=billing`} className="font-medium text-brand-700 hover:underline">{r.companyName}</Link></td>
                    <td className="text-xs text-slate-600">{r.agreements === 0 ? <span className="text-amber-700">none</span> : <>{r.agreements} · {r.frequencies.map((f) => FREQUENCY_LABELS[f as keyof typeof FREQUENCY_LABELS] ?? f).join(", ")}</>}</td>
                    <td className="whitespace-nowrap">{r.nextInvoiceOn ? fmtDate(r.nextInvoiceOn, settings) : <span className="text-slate-400">—</span>}</td>
                    <td className="text-right tabular-nums" title={Math.abs(r.chargeMonthly - r.billed.monthly) >= 0.005 ? `MRR ${fmtMoney(r.chargeMonthly, c)} normalised` : undefined}>
                      {fmtMoney(r.billed.monthly, c)}
                      {(r.billed.quarterly > 0 || r.billed.annual > 0) && <div className="text-xs text-slate-500">{[r.billed.quarterly > 0 ? `+ ${fmtMoney(r.billed.quarterly, c)}/qtr` : null, r.billed.annual > 0 ? `+ ${fmtMoney(r.billed.annual, c)}/yr` : null].filter(Boolean).join(" ")}</div>}
                    </td>
                    <td className="text-right tabular-nums">{r.costMonthly === null ? <span className="text-slate-400">unknown</span> : <>{fmtMoney(r.costMonthly, c)}{r.unknownCostLines ? <span className="text-xs text-amber-700" title={`${r.unknownCostLines} line(s) with cost unknown`}> +?</span> : null}</>}</td>
                    <td className="text-right tabular-nums">{r.marginMonthly === null ? <span className="text-slate-400">—</span> : <span className={r.marginMonthly < 0 ? "text-red-700" : ""}>{fmtMoney(r.marginMonthly, c)}</span>}</td>
                    <td className="text-xs text-slate-600">{r.linesTotal ? `${r.linesSupplied} of ${r.linesTotal} lines from integrations` : "—"}{r.unmapped ? <div className="text-amber-700">{r.unmapped} unmapped</div> : null}</td>
                    <td>{r.attention ? <Badge tone="amber">{r.attention}</Badge> : <Badge tone="green">in step</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-500">Charge is the normalised monthly value of every active agreement (annual ÷ 12, quarterly ÷ 3). Cost comes from the supplier where it prices the service (Pax8) and otherwise from the cost recorded on the line; <strong>unknown</strong> means neither. Open a customer for the line-by-line picture.</p>
      </Card>
    </div>
  );
}
