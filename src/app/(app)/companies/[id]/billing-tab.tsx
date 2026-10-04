import Link from "next/link";
import { Card, Stat } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { DraftReviewTable } from "@/app/(app)/billing/run/draft-review";
import { DiscrepancyTable } from "@/app/(app)/devices/discrepancies";
import { RenewalDecisionButton, ClearRenewalDecisionButton } from "@/components/renewal-decision";
import { DECISION_LABELS } from "@/lib/renewals";
import { fmtDate, fmtMoney, fmtRelative, type DisplaySettings } from "@/lib/format";
import type { companyBilling } from "@/services/company-billing";
import type { companyFinancialSummary } from "@/services/xero";

const TONE: Record<string, string> = { red: "red", amber: "amber", slate: "slate" };
const STATUS_TONE: Record<string, string> = { ready: "green", review: "amber", blocked: "red", nothing: "slate" };
const STATUS_LABEL: Record<string, string> = { ready: "ready", review: "needs review", blocked: "blocked", nothing: "nothing due" };

/** The company page's Billing tab: this customer's slice of the Billing area, in the order the month flows. */
export function CompanyBillingTab({ companyId, data, finance, settings, canApprove, canReview, canWrite }: { companyId: string; data: Awaited<ReturnType<typeof companyBilling>>; finance: Awaited<ReturnType<typeof companyFinancialSummary>> | null; settings: DisplaySettings & { currency: string }; canApprove: boolean; canReview: boolean; canWrite: boolean }) {
  const c = data.currency;
  return (
    <div className="space-y-4">
      <Card title="What to do next for this customer" padded={false}>
        <ol className="divide-y divide-slate-100">
          {data.next.map((n, i) => (
            <li key={i} className="flex items-start gap-3 px-4 py-3">
              <Badge tone={TONE[n.tone]} className="mt-0.5 shrink-0">{n.tone === "red" ? "now" : n.tone === "amber" ? "this run" : "info"}</Badge>
              <div className="min-w-0 flex-1">
                <Link href={n.href} className="font-medium text-brand-700 hover:underline">{n.label}</Link>
                {n.detail && <div className="text-xs text-slate-600">{n.detail}</div>}
              </div>
            </li>
          ))}
        </ol>
      </Card>

      {finance && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Outstanding" value={fmtMoney(finance.xeroContact?.outstanding ?? finance.outstanding, c)} hint={finance.xeroContact ? `Xero balance · ${fmtRelative(finance.xeroContact.fetchedAt)}` : "from mirrored invoices"} />
          <Stat label="Overdue" value={fmtMoney(finance.xeroContact?.overdue ?? finance.overdue, c)} tone={Number(finance.xeroContact?.overdue ?? finance.overdue) > 0 ? "danger" : "default"} />
          <Stat label="Invoiced, 12 months" value={fmtMoney(finance.invoiced12m, c)} />
          <Stat label="Xero" value={finance.link ? "linked" : "not linked"} tone={finance.link ? "good" : "warn"} hint={finance.link ? (finance.link.externalName ?? undefined) : "link on Integrations → Xero"} />
        </div>
      )}

      <Card title={`Agreements in the next run (${data.rows.filter((r) => r.status !== "nothing").length})`} padded={false} actions={<Link href="/billing/run?step=prepare" className="text-xs text-brand-700 hover:underline">Monthly run</Link>}>
        {data.rows.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No active agreements.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Agreement</th>
                <th>Period</th>
                <th className="text-right">Proposed</th>
                <th className="text-right">Previous</th>
                <th>Why</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.contractId} className="align-top">
                  <td><Link href={`/contracts/${r.contractId}`} className="font-medium text-brand-700 hover:underline">{r.contractName}</Link><div className="text-xs text-slate-500">{r.billingFrequency} · {r.lineCount} recurring line{r.lineCount === 1 ? "" : "s"}</div></td>
                  <td className="text-xs">{r.period ? `${fmtDate(r.period.periodStart, settings)} – ${fmtDate(r.period.periodEnd, settings)}` : <span className="text-slate-400">{r.skipReason}</span>}</td>
                  <td className="text-right tabular-nums">{r.status === "nothing" ? "—" : fmtMoney(r.net, c)}</td>
                  <td className="text-right tabular-nums text-slate-600">{r.previous ? <Link href={`/billing/drafts/${r.previous.draftId}`} className="hover:underline">{fmtMoney(r.previous.net, c)}</Link> : "—"}</td>
                  <td className="max-w-xs text-xs">
                    {r.status !== "nothing" && (
                      <>
                        <ul className="list-disc pl-4 text-slate-700">{r.reasons.slice(0, 3).map((x) => <li key={x}>{x}</li>)}</ul>
                        {r.blockers.map((b) => <div key={b} className="text-red-700">{b}</div>)}
                        {r.attention.map((a) => <div key={a} className="text-amber-700">{a}</div>)}
                      </>
                    )}
                  </td>
                  <td><Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {data.pending.length > 0 && (
        <Card title={`Draft invoices awaiting approval (${data.pending.length})`} padded={false}>
          <DraftReviewTable rows={data.pending} canApprove={canApprove} />
        </Card>
      )}

      {(data.open.length > 0 || data.accepted.length > 0) && (
        <Card title={`Count discrepancies · ${data.open.length} open${data.accepted.length ? `, ${data.accepted.length} accepted` : ""}`} padded={false}>
          <div id="discrepancies" />
          <DiscrepancyTable rows={[...data.open, ...data.accepted]} canReview={canReview} currency={c} compact />
        </Card>
      )}

      {data.renewals.length > 0 && (
        <Card title="Renewals" padded={false} actions={<Link href="/billing/renewals" className="text-xs text-brand-700 hover:underline">All renewals</Link>}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Agreement</th>
                <th>Decide by</th>
                <th>Renews</th>
                <th>Supplier position</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.renewals.map((r) => (
                <tr key={r.contractId} className="align-top">
                  <td><Link href={`/contracts/${r.contractId}`} className="font-medium text-brand-700 hover:underline">{r.contractName}</Link></td>
                  <td className={`whitespace-nowrap ${r.status === "overdue" ? "text-red-700" : r.status === "due" ? "text-amber-700" : ""}`}>{fmtDate(r.decideBy, settings)}</td>
                  <td className="whitespace-nowrap">{fmtDate(r.renewalDate, settings)}</td>
                  <td className="max-w-md text-xs">{r.mismatches.length ? <ul className="list-disc pl-4 text-amber-800">{r.mismatches.map((m) => <li key={m}>{m}</li>)}</ul> : <span className="text-slate-500">{r.services.length ? "Supplier commitments end with or before the agreement" : "No supplier commitments on record"}</span>}{r.exposureTotal > 0 && <div className="text-amber-800">≈ {fmtMoney(r.exposureTotal, c)} exposure if not renewed</div>}</td>
                  <td><Badge tone={r.status === "overdue" ? "red" : r.status === "due" ? "amber" : r.status === "decided" ? "green" : "slate"}>{r.status === "decided" ? DECISION_LABELS[r.decision!.kind] : r.status === "overdue" ? "decision overdue" : r.status === "due" ? "decide now" : "upcoming"}</Badge></td>
                  <td className="text-right">{canWrite && (r.decision ? <ClearRenewalDecisionButton contractId={r.contractId} /> : <RenewalDecisionButton contractId={r.contractId} renewalDate={r.renewalDate} amendHref={`/contracts/${r.contractId}/edit?effectiveFrom=${r.renewalDate}`} />)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Services and coverage" actions={<Link href={`/companies/${companyId}?tab=services`} className="text-xs text-brand-700 hover:underline">Services tab</Link>}>
          <div className="flex flex-wrap gap-2 text-sm">
            {(["charged", "bundle", "commitment", "free", "internal", "investigate", "unmapped"] as const).map((k) => (
              <span key={k} className={`rounded-md border px-2 py-1 ${k === "unmapped" && data.services.unmapped ? "border-amber-300 bg-amber-50 text-amber-800" : "border-slate-200"}`}>
                <span className="font-semibold tabular-nums">{data.services[k] ?? 0}</span> {k}
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">Only <strong>unmapped</strong> may mean missed revenue. Everything else is a recorded decision.</p>
        </Card>
        <Card title={`Created in Xero (latest ${data.issued.length})`} padded={false}>
          {data.issued.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No invoices created from the CRM yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {data.issued.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2 px-4 py-2">
                  <span><Link href={`/billing/drafts/${d.id}`} className="text-brand-700 hover:underline">{d.reference}</Link>{d.xeroInvoiceNumber && <span className="text-xs text-slate-500"> · {d.xeroInvoiceNumber}</span>}<div className="text-xs text-slate-500">{d.periodStart ? `${fmtDate(d.periodStart, settings)} – ${fmtDate(d.periodEnd, settings)}` : d.description}</div></span>
                  <span className="whitespace-nowrap text-xs text-slate-600">{fmtMoney(d.subTotal, d.currencyCode)} · <Link href={`/billing/drafts/${d.id}/schedule`} className="text-brand-700 hover:underline">schedule</Link></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
