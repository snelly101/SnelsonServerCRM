import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { pax8InvoiceAllocation, ALLOCATION_FINDING_LABELS } from "@/services/pax8";
import { MATCH_BASIS_LABELS } from "@/lib/pax8-reconcile";
import { PageHeader, Card, DescriptionList } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { fmtDate, fmtMoney } from "@/lib/format";

export const metadata = { title: "Pax8 invoice" };

const FINDING_TONE: Record<string, string> = { ok: "green", no_customer: "red", no_subscription: "amber", price_differs: "amber", quantity_differs: "slate" };

export default async function Pax8InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("integration.read");
  const { id } = await params;
  const [data, settings] = await Promise.all([pax8InvoiceAllocation(decodeURIComponent(id)), getAppSettings()]);
  if (!data) notFound();
  const { invoice, summary, customers, bill } = data;
  const cur = invoice.currency ?? settings.currency;
  const money = (n: number | null) => (n === null ? "—" : fmtMoney(n, cur));
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Integrations", href: "/integrations" }, { label: "Pax8", href: "/integrations/pax8" }, { label: invoice.pax8InvoiceId }]}
        title={`Pax8 invoice ${invoice.pax8InvoiceId}`}
        description={`${invoice.invoiceDate ? fmtDate(invoice.invoiceDate, settings) : "no date"} · ${money(invoice.total)}${invoice.status ? ` · ${invoice.status}` : ""}`}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Allocation" className="lg:col-span-1">
          <DescriptionList
            items={[
              { label: "Charge lines", value: String(summary.items) },
              { label: "Allocated to customers", value: money(summary.allocated) },
              { label: "Unallocated", value: summary.unallocated ? money(summary.unallocated) : "none" },
              { label: "No customer", value: String(summary.findings.no_customer) },
              { label: "No matching subscription", value: String(summary.findings.no_subscription) },
              { label: "Price differs", value: String(summary.findings.price_differs) },
              { label: "Quantity differs", value: String(summary.findings.quantity_differs) },
              { label: "Lines vs invoice total", value: invoice.itemsTotal !== null && invoice.total !== null && Math.abs(invoice.itemsTotal - invoice.total) >= 0.01 ? `lines ${money(invoice.itemsTotal)} vs total ${money(invoice.total)}` : "agree" },
            ]}
          />
        </Card>
        <Card title="Xero bill" className="lg:col-span-2">
          {!bill ? (
            <p className="text-sm text-slate-500">No Xero bill is matched to this invoice.</p>
          ) : (
            <>
              <DescriptionList
                items={[
                  { label: "Bill", value: `${bill.invoiceNumber ?? bill.invoiceId}${bill.reference ? ` · ${bill.reference}` : ""}` },
                  { label: "Matched", value: MATCH_BASIS_LABELS[invoice.matchSource ?? "auto"] ?? invoice.matchSource },
                  { label: "Date / status", value: `${bill.date ? fmtDate(bill.date, settings) : "—"} · ${bill.status.toLowerCase()}` },
                  { label: "Bill total", value: `${money(bill.total)}${bill.subTotal !== null ? ` (net ${money(bill.subTotal)})` : ""}` },
                  { label: "Line comparison", value: summary.billLines?.kind === "lines" ? `${summary.billLines.matched} of ${summary.billLines.total} bill lines match a Pax8 charge by amount` : "summarised bill: totals compared only, not line by line" },
                ]}
              />
              {bill.lineItems.length > 1 && (
                <table className="tbl mt-3">
                  <thead>
                    <tr>
                      <th>Bill line</th>
                      <th className="text-right">Qty</th>
                      <th className="text-right">Unit</th>
                      <th className="text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bill.lineItems.map((l, i) => (
                      <tr key={i}>
                        <td className="text-xs">{l.description || "—"}</td>
                        <td className="text-right tabular-nums">{l.quantity ?? "—"}</td>
                        <td className="text-right tabular-nums">{money(l.unitAmount)}</td>
                        <td className="text-right tabular-nums">{money(l.lineAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </Card>
      </div>
      {customers.map((c) => (
        <Card key={c.companyId ?? c.name} title={c.companyId ? c.name : `${c.name} (no CRM customer)`} padded={false} className="mt-4" actions={<span className="text-sm font-medium">{money(c.total)}</span>}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Charge</th>
                <th>Period</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Unit</th>
                <th className="text-right">Total</th>
                <th>Subscription</th>
                <th>Finding</th>
              </tr>
            </thead>
            <tbody>
              {c.items.map((it) => (
                <tr key={it.itemId}>
                  <td>
                    <div className="text-sm">{it.description ?? it.sku ?? it.itemId}</div>
                    <div className="text-[11px] text-slate-500">{[it.sku, it.chargeType].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td className="whitespace-nowrap text-xs">{it.startPeriod ? `${fmtDate(it.startPeriod, settings)} – ${it.endPeriod ? fmtDate(it.endPeriod, settings) : "?"}` : "—"}</td>
                  <td className="text-right tabular-nums">{it.quantity ?? "—"}</td>
                  <td className="text-right tabular-nums">{money(it.unitPrice)}</td>
                  <td className="text-right tabular-nums">{money(it.total)}</td>
                  <td className="text-xs">
                    {it.subscription ? (
                      <>
                        {it.subscription.productName} <span className="text-slate-500">· now {it.subscription.quantity} × {money(it.subscription.price)} {it.subscription.billingTerm ?? ""} · {it.subscription.status}</span>
                      </>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td>
                    <Badge tone={FINDING_TONE[it.finding]}>{ALLOCATION_FINDING_LABELS[it.finding]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {c.companyId && (
            <p className="px-4 py-2 text-[11px] text-slate-500">
              <Link href={`/companies/${c.companyId}?tab=subscriptions`} className="text-brand-700 hover:underline">
                Open the customer&apos;s Subscriptions tab
              </Link>{" "}
              to see which contract line bills each subscription.
            </p>
          )}
        </Card>
      ))}
      <p className="mt-3 text-xs text-slate-500">
        Each Pax8 charge is tied to the customer through the Pax8 company link and to the subscription through the Pax8 product. <strong>No customer</strong> means the Pax8 company is not linked to a CRM company yet; <strong>no matching subscription</strong> means nothing in the mirror explains the charge (a one-off, or a subscription that ended before the first sync); <strong>price differs</strong> compares the charge&apos;s unit price with the subscription&apos;s current price; <strong>quantity differs</strong> is informational, as counts move between invoices. Nothing here changes Xero or Pax8.
      </p>
    </>
  );
}
