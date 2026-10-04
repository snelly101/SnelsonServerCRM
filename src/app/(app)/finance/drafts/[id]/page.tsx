import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { getInvoiceDraft, xeroConnectionSummary, xeroReferenceData } from "@/services/xero";
import { PageHeader, Card, DescriptionList } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { DraftEditor, ApproveControls, ReprepareButton } from "./editor";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";
import { explainLineCalc } from "@/lib/billing";
import { customerExplanation } from "@/lib/customer-explanation";

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
  const customer = customerExplanation(draft.lines, { money: (n) => fmtMoney(n, draft.currencyCode), date: (iso) => fmtDate(iso, settings) });
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
      {draft.stale && (
        <Alert tone="warn" title="The contract changed after this draft was prepared" className="mb-4">
          <div className="space-y-2">
            <p>
              Prepared {fmtDateTime(draft.createdAt, settings)}.{" "}
              {draft.stale.changes.length > 0 ? `${draft.stale.changes.length} dated change${draft.stale.changes.length === 1 ? "" : "s"} recorded since:` : draft.stale.linesChanged ? "A contract line was edited since." : "The contract's terms were edited since."}
            </p>
            {draft.stale.changes.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                {draft.stale.changes.slice(0, 8).map((c) => (
                  <li key={c.id}>
                    {c.lineDescription}: {c.field === "unit_price" ? `${fmtMoney(c.previousValue ?? 0, draft.currencyCode)} → ${fmtMoney(c.newValue ?? 0, draft.currencyCode)}` : `${Number(c.previousValue ?? 0)} → ${Number(c.newValue ?? 0)}`} from {fmtDate(c.effectiveFrom, settings)}
                    {c.reason ? ` (${c.reason})` : ""}
                  </li>
                ))}
              </ul>
            )}
            {editable && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <ReprepareButton id={draft.id} />
                <span className="text-xs text-slate-600">Cancels this draft and prepares a fresh one for the same periods from the contract as it is now. Nothing is sent to Xero.</span>
              </div>
            )}
          </div>
        </Alert>
      )}
      {draft.xeroDiff && (
        <Alert tone="warn" title={draft.xeroDiff.status === "VOIDED" || draft.xeroDiff.status === "DELETED" ? `This invoice was ${draft.xeroDiff.status.toLowerCase()} in Xero` : "This invoice was changed in Xero after approval"} className="mb-4">
          {draft.xeroDiff.xeroSubTotal !== null && draft.xeroDiff.difference !== null && Math.abs(draft.xeroDiff.difference) >= 0.01 && (
            <>Approved net {fmtMoney(draft.xeroDiff.approvedSubTotal, draft.currencyCode)}; Xero now shows {fmtMoney(draft.xeroDiff.xeroSubTotal, draft.currencyCode)} ({draft.xeroDiff.difference > 0 ? "+" : ""}{fmtMoney(draft.xeroDiff.difference, draft.currencyCode)}). </>
          )}
          {draft.xeroDiff.currencyChanged && <>The currency differs from the approved draft. </>}
          The CRM keeps the approved version here for comparison; the Xero invoice is what the customer receives.
        </Alert>
      )}
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
          {customer.summary && (
            <Card title="What the customer sees" className="mt-4" actions={<Link href={`/finance/drafts/${draft.id}/schedule`} className="text-xs text-brand-700 hover:underline">Customer schedule (printable)</Link>}>
              <p className="text-sm leading-6 text-slate-800">{customer.summary}</p>
              <p className="mt-2 text-xs text-slate-500">Plain-language wording derived from the calculated lines, for the invoice email or notes. The schedule page adds service dates and the licences, devices and domains behind each charge.</p>
            </Card>
          )}
          {draft.lines.some((l) => l.calc) && (
            <Card title="How these amounts were calculated" className="mt-4">
              <ol className="space-y-2 text-sm text-slate-700">
                {draft.lines.map((l, i) => {
                  const edited = l.calc && (l.calc.kind === "period" ? l.quantity !== l.calc.quantity : l.quantity !== 1);
                  return (
                    <li key={i} className="flex gap-2">
                      <span className="w-5 shrink-0 text-right text-xs text-slate-400">{i + 1}.</span>
                      <span>
                        <span className="font-medium">{l.description}</span>
                        <span className="text-slate-500"> · {fmtMoney(l.quantity * l.unitAmount, draft.currencyCode)}</span>
                        <br />
                        {l.calc ? explainLineCalc(l.calc, (n) => fmtMoney(n, draft.currencyCode)) : "Entered by hand."}
                        {edited && <span className="ml-1 text-amber-700">Edited after it was calculated.</span>}
                      </span>
                    </li>
                  );
                })}
              </ol>
              {draft.contractId && (
                <p className="mt-3 text-xs text-slate-500">
                  Quantities come from the <Link href={`/contracts/${draft.contractId}`} className="text-brand-700 hover:underline">contract</Link> and its dated change history as they stood when this draft was prepared.
                </p>
              )}
              {!draft.contractId && draft.contractIds?.length ? (
                <p className="mt-3 text-xs text-slate-500">
                  Consolidated invoice: quantities come from {draft.contractIds.map((cid, i) => (
                    <span key={cid}>{i > 0 ? ", " : ""}<Link href={`/contracts/${cid}`} className="text-brand-700 hover:underline">agreement {i + 1}</Link></span>
                  ))} and their dated change history as they stood when this draft was prepared.
                </p>
              ) : null}
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <Card title="Details">
            <DescriptionList
              items={[
                { label: "Invoice date", value: fmtDate(draft.invoiceDate, settings) },
                { label: "Due date", value: fmtDate(draft.dueDate, settings) },
                { label: "Period", value: draft.periodStart ? `${fmtDate(draft.periodStart, settings)} – ${fmtDate(draft.periodEnd, settings)}` : null },
                { label: "Customer PO", value: draft.purchaseOrderRef },
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
