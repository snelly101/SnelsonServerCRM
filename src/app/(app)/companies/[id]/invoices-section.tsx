import Link from "next/link";
import { Card, EmptyState } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { fmtDate, fmtMoney, fmtRelative, type DisplaySettings } from "@/lib/format";
import type { companyFinancialSummary, xeroConnectionSummary } from "@/services/xero";

/** The customer's invoices as Xero holds them, with the CRM drafts in flight: the Invoices section of the Billing tab. */
export function InvoicesSection({ finance, xero, settings, id }: { finance: Awaited<ReturnType<typeof companyFinancialSummary>> | null; xero: Awaited<ReturnType<typeof xeroConnectionSummary>>; settings: DisplaySettings & { currency: string }; id: string }) {
  void id;
  return (
    <>
      {!finance ? (
        <EmptyState
          title="Finance data is restricted"
          description="Only finance users and administrators can see invoices."
        />
      ) : (
        <div className="space-y-4">
          <Card
            title="Financial summary"
            actions={
              xero.demo ? (
                <Badge tone="amber">demo</Badge>
              ) : finance.link ? (
                <Badge tone="green">linked to Xero</Badge>
              ) : (
                <Badge tone="amber">not linked to Xero</Badge>
              )
            }
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">
                  Outstanding
                </div>
                <div className="text-lg font-semibold">
                  {fmtMoney(
                    finance.xeroContact?.outstanding ??
                      finance.outstanding,
                    settings.currency,
                  )}
                </div>
                <div className="text-[11px] text-slate-500">
                  {finance.xeroContact
                    ? `Xero balance · fetched ${fmtRelative(finance.xeroContact.fetchedAt)}`
                    : "from mirrored invoices"}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">
                  Overdue
                </div>
                <div
                  className={`text-lg font-semibold ${Number(finance.xeroContact?.overdue ?? finance.overdue) > 0 ? "text-red-700" : ""}`}
                >
                  {fmtMoney(
                    finance.xeroContact?.overdue ?? finance.overdue,
                    settings.currency,
                  )}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">
                  Invoiced (12 months)
                </div>
                <div className="text-lg font-semibold">
                  {fmtMoney(finance.invoiced12m, settings.currency)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">
                  Paid (12 months)
                </div>
                <div className="text-lg font-semibold text-green-700">
                  {fmtMoney(finance.paid12m, settings.currency)}
                </div>
              </div>
            </div>
            {!finance.link && (
              <p className="mt-3 text-xs text-amber-700">
                Link this company to its Xero contact on Integrations →
                Xero to see its invoices and create drafts.
              </p>
            )}
          </Card>
          {finance.drafts.length > 0 && (
            <Card title="Draft invoices awaiting approval" padded={false}>
              <ul className="divide-y divide-slate-100 text-sm">
                {finance.drafts.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center justify-between px-4 py-2"
                  >
                    <Link
                      href={`/billing/drafts/${d.id}`}
                      className="text-brand-700 hover:underline"
                    >
                      {d.reference} · {d.description ?? "draft"}
                    </Link>
                    <span className="text-xs text-slate-500">
                      {fmtMoney(d.subTotal, d.currencyCode)} net ·{" "}
                      <Badge
                        tone={d.status === "failed" ? "red" : "slate"}
                      >
                        {d.status}
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="Invoices (from Xero)" padded={false}>
            {finance.invoices.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  title="No invoices"
                  description={
                    finance.link
                      ? "None mirrored yet; run a Xero sync."
                      : "Link the company to a Xero contact first."
                  }
                />
              </div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Status</th>
                    <th>Date</th>
                    <th>Due</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">Amount due</th>
                  </tr>
                </thead>
                <tbody>
                  {finance.invoices.map((i) => {
                    const overdue =
                      i.status === "AUTHORISED" &&
                      i.dueDate &&
                      i.dueDate < new Date().toISOString().slice(0, 10);
                    return (
                      <tr key={i.id}>
                        <td className="font-medium">
                          {i.invoiceNumber ?? i.invoiceId.slice(0, 8)}
                          {i.reference ? (
                            <span className="ml-1 text-xs font-normal text-slate-500">
                              {i.reference}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <Badge
                            tone={
                              overdue
                                ? "red"
                                : i.status === "PAID"
                                  ? "green"
                                  : i.status === "AUTHORISED"
                                    ? "indigo"
                                    : "slate"
                            }
                          >
                            {overdue ? "overdue" : i.status.toLowerCase()}
                          </Badge>
                        </td>
                        <td>{fmtDate(i.date, settings)}</td>
                        <td className={overdue ? "text-red-600" : ""}>
                          {fmtDate(i.dueDate, settings)}
                        </td>
                        <td className="text-right tabular-nums">
                          {fmtMoney(
                            i.total,
                            i.currencyCode ?? settings.currency,
                          )}
                        </td>
                        <td className="text-right tabular-nums font-medium">
                          {fmtMoney(
                            i.amountDue,
                            i.currencyCode ?? settings.currency,
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
