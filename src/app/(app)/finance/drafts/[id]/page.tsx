import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { getInvoiceDraft, xeroConnectionSummary, xeroReferenceData } from "@/services/xero";
import { PageHeader, Card, DescriptionList } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { DraftEditor, ApproveControls } from "./editor";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";

export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requirePermission("finance.read");
  const { id } = await params;
  const [draft, settings, conn] = await Promise.all([getInvoiceDraft(id), getAppSettings(), xeroConnectionSummary()]);
  if (!draft) notFound();
  let ref: Awaited<ReturnType<typeof xeroReferenceData>> = null;
  if (conn.configured) {
    try {
      ref = await xeroReferenceData();
    } catch {
      /* editor falls back to free text */
    }
  }
  const editable = (draft.status === "draft" || draft.status === "failed") && can(me.role, "invoice.prepare");
  const canApprove = can(me.role, "invoice.approve");
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Finance", href: "/finance" }, { label: draft.reference }]}
        title={
          <span className="flex items-center gap-2">
            Draft invoice {draft.reference} <Badge tone={draft.status === "created" ? "green" : draft.status === "failed" ? "red" : draft.status === "approved" ? "blue" : "slate"}>{draft.status}</Badge>
          </span>
        }
        description={
          <Link href={`/companies/${draft.companyId}`} className="text-brand-700 hover:underline">
            {draft.companyName}
          </Link>
        }
      />
      {draft.status === "created" && (
        <Alert tone="success" title="Created in Xero as a DRAFT" className="mb-4">
          Xero invoice {draft.xeroInvoiceNumber ?? draft.xeroInvoiceId} on {fmtDateTime(draft.createdInXeroAt, settings)}. Review, approve and send it in Xero. {draft.xeroInvoice && <>Current status in Xero: <strong>{draft.xeroInvoice.status}</strong> (fetched {fmtDate(draft.xeroInvoice.fetchedAt, settings)}).</>}
        </Alert>
      )}
      {draft.lastError && <Alert tone="error" title="Last attempt failed" className="mb-4">{draft.lastError}</Alert>}
      {!draft.xeroLink && draft.status !== "created" && (
        <Alert tone="warn" title="Company not linked to a Xero contact" className="mb-4">
          Approval will be refused until the company is linked on <Link href="/integrations/xero" className="underline">Integrations → Xero</Link>.
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title="Lines" actions={<span className="text-sm font-medium">Net {fmtMoney(draft.subTotal, draft.currencyCode)}</span>}>
            {editable ? (
              <DraftEditor draft={{ id: draft.id, invoiceDate: draft.invoiceDate, dueDate: draft.dueDate, description: draft.description, notes: draft.notes, lines: draft.lines, currencyCode: draft.currencyCode }} accounts={ref?.accounts.map((a) => ({ code: a.Code ?? "", name: a.Name })) ?? []} taxRates={ref?.taxRates.map((t) => ({ type: t.TaxType, name: t.Name })) ?? []} />
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Unit</th>
                    <th>Account</th>
                    <th>Tax</th>
                    <th className="text-right">Line</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.description}</td>
                      <td className="text-right tabular-nums">{l.quantity}</td>
                      <td className="text-right tabular-nums">{fmtMoney(l.unitAmount, draft.currencyCode)}</td>
                      <td>{l.accountCode}</td>
                      <td>{l.taxType}</td>
                      <td className="text-right tabular-nums">{fmtMoney(l.quantity * l.unitAmount, draft.currencyCode)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Details">
            <DescriptionList
              items={[
                { label: "Invoice date", value: fmtDate(draft.invoiceDate, settings) },
                { label: "Due date", value: fmtDate(draft.dueDate, settings) },
                { label: "Period", value: draft.periodStart ? `${fmtDate(draft.periodStart, settings)} – ${fmtDate(draft.periodEnd, settings)}` : null },
                { label: "Currency", value: draft.currencyCode },
                { label: "Amounts are", value: draft.lineAmountTypes === "Exclusive" ? "tax exclusive" : draft.lineAmountTypes },
                { label: "Xero contact", value: draft.xeroLink ? draft.xeroLink.externalName ?? draft.xeroLink.externalId : "not linked" },
                { label: "Approved by", value: draft.approvedAt ? `${fmtDateTime(draft.approvedAt, settings)}` : null },
              ]}
            />
            {draft.description && <p className="mt-3 border-t border-slate-100 pt-3 text-sm text-slate-700">{draft.description}</p>}
            {draft.notes && <p className="mt-2 text-xs text-slate-500">{draft.notes}</p>}
          </Card>
          {draft.status !== "created" && draft.status !== "cancelled" && (
            <Card title="Approval">
              <p className="mb-3 text-xs text-slate-500">
                Approving creates the invoice in Xero as a <strong>DRAFT</strong>. It is never authorised or sent by the CRM. Retrying after a failure looks the invoice up by reference first, so it cannot be duplicated.
              </p>
              {canApprove ? <ApproveControls id={draft.id} linked={Boolean(draft.xeroLink)} canCancel={can(me.role, "invoice.prepare")} /> : <p className="text-sm text-slate-600">Only finance users or administrators can approve.</p>}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
