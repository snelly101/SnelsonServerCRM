import Link from "next/link";
import { ExternalLink, FileCheck2 } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { createdDraftsChangedInXero, financeTotals, listInvoiceDrafts, listXeroInvoices, xeroConnectionSummary } from "@/services/xero";
import { listSavedViews } from "@/services/settings";
import { PageHeader, Card, EmptyState, Stat } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Pagination, SortLink } from "@/components/ui/pagination";
import { FilterBar } from "@/components/ui/filter-bar";
import { ButtonLink } from "@/components/ui/button";
import { XeroSyncButton } from "../integrations/xero/controls";
import { fmtDate, fmtMoney, fmtRelative } from "@/lib/format";
import { param, toInt } from "@/lib/utils";

export const metadata = { title: "Finance" };

const STATUS_TONE: Record<string, string> = { DRAFT: "slate", SUBMITTED: "blue", AUTHORISED: "indigo", PAID: "green", VOIDED: "red", DELETED: "red" };

export default async function FinancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("finance.read");
  const sp = await searchParams;
  const changedInXero = await createdDraftsChangedInXero();
  const [data, totals, conn, drafts, views, settings] = await Promise.all([
    listXeroInvoices({ q: param(sp, "q"), status: param(sp, "status"), overdueOnly: param(sp, "overdue") === "1", page: toInt(param(sp, "page"), 1), sort: param(sp, "sort"), dir: param(sp, "dir") }),
    financeTotals(),
    xeroConnectionSummary(),
    listInvoiceDrafts("all"),
    listSavedViews(me.id, "finance"),
    getAppSettings(),
  ]);
  const c = settings.currency;
  const today = new Date().toISOString().slice(0, 10);
  const pending = drafts.filter((d) => d.status === "draft" || d.status === "failed" || d.status === "approved");
  const stale = totals.lastFetched ? Date.now() - new Date(totals.lastFetched).getTime() > 3 * 3600_000 : true;

  return (
    <>
      <PageHeader
        title="Finance"
        description="Invoices and payments mirrored from Xero, plus draft invoices awaiting approval. Xero is the source of truth."
        actions={
          <>
            {conn.configured && can(me.role, "integration.sync") && <XeroSyncButton label="Refresh from Xero" />}
            {can(me.role, "invoice.prepare") && (
              <ButtonLink href="/finance/billing-run">
                <FileCheck2 className="h-4 w-4" /> Billing run
              </ButtonLink>
            )}
            <ButtonLink href="/finance/findings" variant="secondary">
              Findings
            </ButtonLink>
            <ButtonLink href="/finance/services" variant="secondary">
              Service coverage
            </ButtonLink>
            <ButtonLink href="/integrations/xero" variant="secondary">
              Connection
            </ButtonLink>
          </>
        }
      />
      {!conn.configured && <Alert tone="info" className="mb-4">Xero is not connected. <Link href="/integrations/xero" className="underline">Connect it</Link> to see invoices and create drafts.</Alert>}
      {conn.demo && <Alert tone="warn" title="Demo data" className="mb-4">These invoices and payments are synthetic; nothing here comes from a real Xero organisation.</Alert>}
      <div className="mb-1 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Outstanding (authorised)" value={fmtMoney(totals.outstanding, c)} />
        <Stat label="Overdue" value={fmtMoney(totals.overdue, c)} hint={`${totals.overdueCount} invoice${totals.overdueCount === 1 ? "" : "s"}`} tone={totals.overdue > 0 ? "danger" : "default"} />
        <Stat label="Paid (last 30 days)" value={fmtMoney(totals.paidLast30, c)} tone="good" />
        <Stat label="Drafts in Xero" value={totals.draftsInXero} hint="approve/send in Xero" />
        <Stat label="CRM drafts awaiting approval" value={totals.pendingDrafts} tone={totals.pendingDrafts ? "warn" : "default"} />
      </div>
      <p className="mb-4 text-xs text-slate-500">
        Figures are {stale ? <span className="text-amber-700">cached and may be stale</span> : "cached"}; last fetched {totals.lastFetched ? fmtRelative(totals.lastFetched) : "never"}. Live balances per customer come from the Xero contact record on the company page.
      </p>

      {changedInXero.length > 0 && (
        <Card title={`Changed in Xero after approval (${changedInXero.length})`} padded={false} className="mb-4">
          <table className="tbl">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Company</th>
                <th>Xero invoice</th>
                <th className="text-right">Approved net</th>
                <th className="text-right">In Xero now</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {changedInXero.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link href={`/finance/drafts/${d.id}`} className="font-medium text-brand-700 hover:underline">
                      {d.reference}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/companies/${d.companyId}`} className="hover:underline">
                      {d.companyName}
                    </Link>
                  </td>
                  <td className="text-xs text-slate-600">{d.xeroInvoiceNumber ?? "—"}</td>
                  <td className="text-right tabular-nums">{fmtMoney(d.diff!.approvedSubTotal, d.currencyCode)}</td>
                  <td className="text-right tabular-nums">{d.diff!.xeroSubTotal === null ? "—" : fmtMoney(d.diff!.xeroSubTotal, d.currencyCode)}</td>
                  <td>
                    <Badge tone={d.diff!.status === "VOIDED" || d.diff!.status === "DELETED" ? "red" : "amber"}>{d.diff!.status.toLowerCase()}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-2 text-[11px] text-slate-500">Invoices the CRM created as drafts whose amount, currency or status was then changed in Xero. The CRM keeps the approved version for comparison; Xero&apos;s invoice is what the customer receives.</p>
        </Card>
      )}

      {pending.length > 0 && (
        <Card title={`Draft invoices awaiting approval (${pending.length})`} padded={false} className="mb-4">
          <table className="tbl">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Company</th>
                <th>Source</th>
                <th className="text-right">Net</th>
                <th>Status</th>
                <th>Prepared</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pending.map((d) => (
                <tr key={d.id}>
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
                  <td>
                    <Badge tone={d.status === "failed" ? "red" : d.status === "approved" ? "blue" : "slate"}>{d.status}</Badge>
                    {d.stale && <Badge className="ml-1" tone="amber" title="The contract changed after this draft was prepared">stale</Badge>}
                    {d.lastError && <div className="max-w-xs truncate text-[11px] text-red-600" title={d.lastError}>{d.lastError}</div>}
                  </td>
                  <td className="text-xs text-slate-500">{fmtRelative(d.createdAt)}</td>
                  <td className="text-right">
                    <Link href={`/finance/drafts/${d.id}`} className="text-xs text-brand-700 hover:underline">
                      {can(me.role, "invoice.approve") ? "Review & approve" : "View"}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <FilterBar
        page="finance"
        currentUserId={me.id}
        savedViews={views}
        placeholder="Search invoice number, reference, company…"
        filters={[
          { key: "status", label: "Status", options: ["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED"].map((s) => ({ value: s, label: s.toLowerCase() })) },
          { key: "overdue", label: "Overdue", options: [{ value: "1", label: "Overdue only" }] },
        ]}
      />
      {data.total === 0 ? (
        <EmptyState icon={<FileCheck2 className="h-6 w-6" />} title="No invoices" description={conn.configured ? "Run a refresh to pull invoices from Xero." : "Connect Xero first."} />
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th><SortLink column="number" label="Invoice" defaultColumn="date" defaultDir="desc" /></th>
                  <th><SortLink column="customer" label="Customer" defaultColumn="date" defaultDir="desc" /></th>
                  <th><SortLink column="status" label="Status" defaultColumn="date" defaultDir="desc" /></th>
                  <th><SortLink column="date" label="Date" defaultColumn="date" defaultDir="desc" /></th>
                  <th><SortLink column="due" label="Due" defaultColumn="date" defaultDir="desc" /></th>
                  <th className="text-right"><SortLink column="total" label="Total" defaultColumn="date" defaultDir="desc" /></th>
                  <th className="text-right"><SortLink column="paid" label="Paid" defaultColumn="date" defaultDir="desc" /></th>
                  <th className="text-right"><SortLink column="outstanding" label="Due" defaultColumn="date" defaultDir="desc" /></th>
                  <th>Fetched</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((i) => {
                  const overdue = i.status === "AUTHORISED" && i.dueDate && i.dueDate < today;
                  return (
                    <tr key={i.id}>
                      <td>
                        <span className="font-medium">{i.invoiceNumber ?? i.invoiceId.slice(0, 8)}</span>
                        {i.onlineInvoiceUrl && (
                          <a href={i.onlineInvoiceUrl} target="_blank" rel="noreferrer" className="ml-1 inline-flex align-middle text-slate-400 hover:text-brand-700" aria-label="Open online invoice">
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                        {i.reference && <div className="text-xs text-slate-500">{i.reference}</div>}
                      </td>
                      <td>
                        {i.companyId ? (
                          <Link href={`/companies/${i.companyId}`} className="hover:underline">
                            {i.companyName}
                          </Link>
                        ) : (
                          <span className="text-slate-500" title="Xero contact not linked to a CRM company">{i.contactName ?? "—"} <span className="text-xs text-amber-700">(unlinked)</span></span>
                        )}
                      </td>
                      <td>
                        <Badge tone={overdue ? "red" : STATUS_TONE[i.status]}>{overdue ? "overdue" : i.status.toLowerCase()}</Badge>
                      </td>
                      <td>{fmtDate(i.date, settings)}</td>
                      <td className={overdue ? "font-medium text-red-600" : ""}>{fmtDate(i.dueDate, settings)}</td>
                      <td className="text-right tabular-nums">{fmtMoney(i.total, i.currencyCode ?? c)}</td>
                      <td className="text-right tabular-nums text-slate-600">{fmtMoney(i.amountPaid, i.currencyCode ?? c)}</td>
                      <td className="text-right tabular-nums font-medium">{fmtMoney(i.amountDue, i.currencyCode ?? c)}</td>
                      <td className="text-xs text-slate-500">{fmtRelative(i.fetchedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={data.page} pageCount={data.pageCount} total={data.total} pageSize={data.pageSize} />
        </Card>
      )}
    </>
  );
}
