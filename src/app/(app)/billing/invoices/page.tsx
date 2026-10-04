import Link from "next/link";
import { ExternalLink, FileCheck2 } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { financeTotals, listXeroInvoices, xeroConnectionSummary } from "@/services/xero";
import { pax8ConnectionSummary, pax8InvoiceReconciliation } from "@/services/pax8";
import { listSavedViews } from "@/services/settings";
import { Card, EmptyState, Stat } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Pagination, SortLink } from "@/components/ui/pagination";
import { FilterBar } from "@/components/ui/filter-bar";
import { XeroSyncButton } from "@/app/(app)/integrations/xero/controls";
import { Pax8ImportForm, Pax8ReconciliationTable, Pax8SupplierForm } from "@/app/(app)/integrations/pax8/controls";
import { fmtDate, fmtMoney, fmtRelative } from "@/lib/format";
import { param, toInt } from "@/lib/utils";

export const metadata = { title: "Invoices" };

const STATUS_TONE: Record<string, string> = { DRAFT: "slate", SUBMITTED: "blue", AUTHORISED: "indigo", PAID: "green", VOIDED: "red", DELETED: "red" };

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("finance.read");
  const sp = await searchParams;
  const view = param(sp, "view") === "supplier" ? "supplier" : "customer";
  const settings = await getAppSettings();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link href="/billing/invoices" className={`rounded-md border px-3 py-1 ${view === "customer" ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-200 bg-surface hover:bg-slate-50"}`}>Customer invoices</Link>
        <Link href="/billing/invoices?view=supplier" className={`rounded-md border px-3 py-1 ${view === "supplier" ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-200 bg-surface hover:bg-slate-50"}`}>Supplier bills (Pax8)</Link>
      </div>
      {view === "customer" ? <CustomerInvoices sp={sp} me={me} settings={settings} /> : <SupplierBills me={me} settings={settings} />}
    </div>
  );
}

async function CustomerInvoices({ sp, me, settings }: { sp: Record<string, string | string[] | undefined>; me: { id: string; role: string }; settings: Awaited<ReturnType<typeof getAppSettings>> }) {
  const [data, totals, conn, views] = await Promise.all([
    listXeroInvoices({ q: param(sp, "q"), status: param(sp, "status"), overdueOnly: param(sp, "overdue") === "1", page: toInt(param(sp, "page"), 1), sort: param(sp, "sort"), dir: param(sp, "dir") }),
    financeTotals(),
    xeroConnectionSummary(),
    listSavedViews(me.id, "finance"),
  ]);
  const c = settings.currency;
  const today = new Date().toISOString().slice(0, 10);
  const stale = totals.lastFetched ? Date.now() - new Date(totals.lastFetched).getTime() > 3 * 3600_000 : true;
  return (
    <>
      {!conn.configured && <Alert tone="info">Xero is not connected. <Link href="/integrations/xero" className="underline">Connect it</Link> to see invoices.</Alert>}
      {conn.demo && <Alert tone="warn" title="Demo data">These invoices and payments are synthetic.</Alert>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Outstanding (authorised)" value={fmtMoney(totals.outstanding, c)} />
        <Stat label="Overdue" value={fmtMoney(totals.overdue, c)} hint={`${totals.overdueCount} invoice${totals.overdueCount === 1 ? "" : "s"}`} tone={totals.overdue > 0 ? "danger" : "default"} />
        <Stat label="Paid (last 30 days)" value={fmtMoney(totals.paidLast30, c)} tone="good" />
        <Stat label="Drafts in Xero" value={totals.draftsInXero} hint="approve/send in Xero" />
      </div>
      <p className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>Mirrored from Xero; figures are {stale ? <span className="text-amber-700">cached and may be stale</span> : "cached"}, last fetched {totals.lastFetched ? fmtRelative(totals.lastFetched) : "never"}. Live balances per customer are on the company page.</span>
        {conn.configured && can(me.role as never, "integration.sync") && <XeroSyncButton label="Refresh from Xero" />}
      </p>
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
                      <td>{i.companyId ? <Link href={`/companies/${i.companyId}`} className="hover:underline">{i.companyName}</Link> : <span className="text-slate-500" title="Xero contact not linked to a CRM company">{i.contactName ?? "—"} <span className="text-xs text-amber-700">(unlinked)</span></span>}</td>
                      <td><Badge tone={overdue ? "red" : STATUS_TONE[i.status]}>{overdue ? "overdue" : i.status.toLowerCase()}</Badge></td>
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

async function SupplierBills({ me, settings }: { me: { role: string }; settings: Awaited<ReturnType<typeof getAppSettings>> }) {
  const [recon, conn] = await Promise.all([pax8InvoiceReconciliation(), pax8ConnectionSummary()]);
  const canManage = can(me.role as never, "integration.manage");
  return (
    <Card
      title={`Pax8 invoices vs Xero bills · ${recon.totals.matched} total-matched, ${recon.totals.differs} differ, ${recon.totals.noBill} without a bill${recon.totals.extraBills ? `, ${recon.totals.extraBills} bill${recon.totals.extraBills === 1 ? "" : "s"} without an invoice` : ""}${recon.totals.chargeFindings ? `, ${recon.totals.chargeFindings} charge finding${recon.totals.chargeFindings === 1 ? "" : "s"}` : ""}`}
      padded={false}
    >
      <div className="border-b border-slate-100 px-4 py-3">
        <Pax8SupplierForm value={recon.supplier?.contactId ?? null} suppliers={recon.suppliers} readOnly={!canManage || !recon.xeroConfigured} />
        <p className="mt-2 text-xs text-slate-500">
          {recon.xeroConfigured
            ? "Each sync mirrors the recent Pax8 partner invoices and the purchase bills Xero holds for this supplier, then matches them by reference (strong) or by a unique identical total within ten days (weaker, amber). Finance can match or unmatch by hand; a hand decision is kept. Charge lines are allocated to customers and subscriptions separately; a one-line bill is reported as total-matched only. Nothing is changed in Xero or at Pax8."
            : "Connect Xero to compare Pax8 invoices with the bills entered there."}
        </p>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-t border-slate-100 pt-3">
          <p className="text-xs text-slate-600">
            <strong>Imported history:</strong>{" "}
            {recon.coverage.count ? `${recon.coverage.count} Pax8 invoice${recon.coverage.count === 1 ? "" : "s"} from ${fmtDate(recon.coverage.oldest!, settings)} to ${fmtDate(recon.coverage.newest!, settings)}` : "none"}
            {recon.coverage.lastFetched ? ` · last fetched ${fmtRelative(recon.coverage.lastFetched)}` : ""}
            {recon.totals.olderBills ? ` · ${recon.totals.olderBills} supplier bill${recon.totals.olderBills === 1 ? "" : "s"} older than the imported history (not a finding until their invoices are imported)` : ""}
            . The routine sync keeps the last {conn.effectiveConfig.invoiceCount} invoices fresh; older invoices stay once imported. Sync settings are on the <Link href="/integrations/pax8" className="text-brand-700 hover:underline">Pax8 integration page</Link>.
          </p>
          {canManage && conn.configured && <Pax8ImportForm oldest={recon.coverage.oldest} />}
        </div>
      </div>
      <Pax8ReconciliationTable rows={recon.rows} unmatchedBills={recon.unmatchedBills} freeBills={recon.freeBills} canMatch={can(me.role as never, "invoice.approve") && Boolean(recon.supplier)} settings={settings} />
    </Card>
  );
}
