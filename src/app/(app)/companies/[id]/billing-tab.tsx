import Link from "next/link";
import { Card, Stat } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { DraftReviewTable } from "@/app/(app)/billing/run/draft-review";
import { DiscrepancyTable } from "@/app/(app)/devices/discrepancies";
import { RenewalDecisionButton, ClearRenewalDecisionButton } from "@/components/renewal-decision";
import { AgreementLines } from "@/components/billing/agreement-lines";
import { ServiceLineSelect } from "@/components/billing/service-line-select";
import { CoverageDialog, STATE_TONE } from "@/components/service-register";
import { SubscriptionsPanel } from "@/components/subscriptions-panel";
import { HostingPanel } from "@/components/hosting-panel";
import { InvoicesSection } from "./invoices-section";
import { DECISION_LABELS } from "@/lib/renewals";
import { SERVICE_STATE_LABELS } from "@/lib/billing-model";
import { FREQUENCY_LABELS } from "@/lib/validation-sales";
import { fmtDate, fmtMoney, fmtRelative, type DisplaySettings } from "@/lib/format";
import type { companyBilling } from "@/services/company-billing";
import type { CompanyBillingPicture } from "@/services/billing-picture";
import type { companyFinancialSummary, xeroConnectionSummary } from "@/services/xero";
import type { companySubscriptionOverview } from "@/services/pax8";
import type { companyHostingOverview } from "@/services/twentyi";

const TONE: Record<string, string> = { red: "red", amber: "amber", slate: "slate" };
const STATUS_TONE: Record<string, string> = { ready: "green", review: "amber", blocked: "red", nothing: "slate" };
const STATUS_LABEL: Record<string, string> = { ready: "ready", review: "needs review", blocked: "blocked", nothing: "nothing due" };

type Props = {
  companyId: string;
  data: Awaited<ReturnType<typeof companyBilling>>;
  picture: CompanyBillingPicture;
  finance: Awaited<ReturnType<typeof companyFinancialSummary>> | null;
  xero: Awaited<ReturnType<typeof xeroConnectionSummary>>;
  subscriptions: Awaited<ReturnType<typeof companySubscriptionOverview>>;
  hosting: Awaited<ReturnType<typeof companyHostingOverview>>;
  settings: DisplaySettings & { currency: string };
  canApprove: boolean;
  canReview: boolean;
  canWrite: boolean;
  canManageIntegrations: boolean;
};

/**
 * The company's Billing tab: one place that answers what we bill this
 * customer, what it costs us, where each quantity comes from, what changed
 * and what the next invoice will be. Essentials first; supplier detail,
 * invoice history and renewals behind expandable sections.
 */
export function CompanyBillingTab({ companyId, data, picture, finance, xero, subscriptions, hosting, settings, canApprove, canReview, canWrite, canManageIntegrations }: Props) {
  const c = data.currency;
  const t = picture.totals;
  const active = picture.agreements.filter((a) => a.status === "active");
  const drafts = picture.agreements.filter((a) => a.status !== "active");
  const lineOptions = picture.agreements.flatMap((a) => a.lines.map((l) => ({ id: l.id, description: l.description, contractName: a.name, contractStatus: a.status })));
  const runRow = (contractId: string) => data.rows.find((r) => r.contractId === contractId);
  const unmapped = picture.otherServices.filter((r) => r.state === "unmapped");
  const decided = picture.otherServices.filter((r) => r.state !== "unmapped");
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label="Billed monthly" value={fmtMoney(t.billed.monthly, c)} hint={[t.billed.quarterly > 0 ? `+ ${fmtMoney(t.billed.quarterly, c)}/qtr` : null, t.billed.annual > 0 ? `+ ${fmtMoney(t.billed.annual, c)}/yr` : null, Math.abs(t.chargeMonthly - t.billed.monthly) >= 0.005 ? `MRR ${fmtMoney(t.chargeMonthly, c)} normalised` : `${active.length} active agreement${active.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")} />
        <Stat label="Supplier cost / month" value={t.costMonthly === null ? "unknown" : fmtMoney(t.costMonthly, c)} hint={t.unknownCostLines ? `${t.unknownCostLines} line${t.unknownCostLines === 1 ? "" : "s"} with cost unknown` : "from Pax8 where linked, else recorded"} />
        <Stat label="Margin / month" value={t.marginMonthly === null ? "—" : fmtMoney(t.marginMonthly, c)} tone={t.marginMonthly !== null && t.marginMonthly < 0 ? "danger" : t.marginMonthly !== null ? "good" : "default"} hint={t.chargeMonthly && t.marginMonthly !== null ? `${Math.round((t.marginMonthly / t.chargeMonthly) * 100)}% of charge` : undefined} />
        <Stat label="Next invoice" value={t.nextInvoiceOn ? fmtDate(t.nextInvoiceOn, settings) : "—"} hint={active[0] ? `${FREQUENCY_LABELS[active[0].billingFrequency as keyof typeof FREQUENCY_LABELS]}${active.length > 1 ? " and others" : ""}` : "no active agreement"} />
        <Stat label="Outstanding" value={finance ? fmtMoney(finance.xeroContact?.outstanding ?? finance.outstanding, c) : "—"} hint={finance?.xeroContact ? `Xero · ${fmtRelative(finance.xeroContact.fetchedAt)}` : finance ? "from mirrored invoices" : "finance only"} />
        <Stat label="Needs attention" value={t.attention + data.next.filter((n) => n.tone === "red").length} tone={t.attention ? "warn" : "default"} hint={t.attention ? "see below" : "nothing on the lines"} />
      </div>

      <Card title="Needs attention" padded={false}>
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

      <div id="services" />
      {active.length === 0 && drafts.length === 0 ? (
        <Card title="Agreements">
          <p className="text-sm text-slate-600">No agreement yet. Contracts are drafted from a won opportunity or a signed proposal, or created by hand.</p>
          {canWrite && <ButtonLink href={`/contracts/new?companyId=${companyId}`} variant="secondary" className="mt-3">New contract</ButtonLink>}
        </Card>
      ) : (
        [...active, ...drafts].map((a) => {
          const r = runRow(a.id);
          return (
            <Card
              key={a.id}
              padded={false}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <Link href={`/contracts/${a.id}`} className="text-brand-700 hover:underline">{a.name}</Link>
                  {a.status !== "active" && <Badge tone={a.status === "draft" ? "slate" : "amber"}>{a.status}</Badge>}
                  <span className="text-xs font-normal text-slate-500">
                    {FREQUENCY_LABELS[a.billingFrequency as keyof typeof FREQUENCY_LABELS]}
                    {a.billingDay ? `, from the ${a.billingDay}` : ""}
                    {a.currentPeriod && <> · current period {fmtDate(a.currentPeriod.periodStart, settings)} – {fmtDate(a.currentPeriod.periodEnd, settings)}</>}
                    {a.nextInvoiceOn && <> · next invoice {fmtDate(a.nextInvoiceOn, settings)}</>}
                    {a.renewalDate && <> · renews {fmtDate(a.renewalDate, settings)}</>}
                  </span>
                </span>
              }
              actions={
                <span className="flex items-center gap-2 text-xs">
                  {r && r.status !== "nothing" && (
                    <span title={[...r.reasons, ...r.blockers, ...r.attention].join("\n")}>
                      <Badge tone={STATUS_TONE[r.status]}>next run: {STATUS_LABEL[r.status]} · {fmtMoney(r.net, c)}</Badge>
                    </span>
                  )}
                  {canWrite && <Link href={`/contracts/${a.id}/edit`} className="text-brand-700 hover:underline">Edit</Link>}
                </span>
              }
            >
              <AgreementLines agreement={a} settings={settings} lines={lineOptions} canEdit={canWrite} canReview={canReview} />
              {r && r.status !== "nothing" && (r.reasons.length > 0 || r.attention.length > 0 || r.blockers.length > 0) && (
                <div className="border-t border-slate-100 px-4 py-2 text-xs">
                  <span className="font-semibold text-slate-700">Next invoice:</span>{" "}
                  <span className="text-slate-700">{r.reasons.slice(0, 3).join("; ")}</span>
                  {r.blockers.map((b) => <span key={b} className="ml-2 text-red-700">{b}</span>)}
                  {r.attention.map((x) => <span key={x} className="ml-2 text-amber-700">{x}</span>)}
                  {r.previous && <Link href={`/billing/drafts/${r.previous.draftId}`} className="ml-2 text-brand-700 hover:underline">previous {fmtMoney(r.previous.net, c)}</Link>}
                </div>
              )}
            </Card>
          );
        })
      )}

      {picture.otherServices.length > 0 && (
        <Card title={`Supplied but not on an active agreement (${picture.otherServices.length})`} padded={false} actions={<Link href={`/billing/services?companyId=${companyId}`} className="text-xs text-brand-700 hover:underline">Service register</Link>}>
          {unmapped.length > 0 && <p className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800"><strong>{unmapped.length} unmapped</strong>: the integrations supply these and nothing says how they are charged. Choose the line that bills each one, or record that it is bundled, covered by a commitment, intentionally free or internal.</p>}
          <table className="tbl">
            <thead>
              <tr>
                <th>Service</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Cost / mo</th>
                <th>Synced</th>
                <th>State</th>
                {canWrite && <th>Billed on</th>}
              </tr>
            </thead>
            <tbody>
              {[...unmapped, ...decided].map((r) => (
                <tr key={r.key} className="align-top">
                  <td>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge tone={r.provider === "pax8" ? "indigo" : r.provider === "twentyi" ? "teal" : "blue"}>{r.providerLabel}</Badge>
                      <span className="font-medium">{r.name}</span>
                    </div>
                    <div className="text-xs text-slate-500">{r.kind}{r.supplierProduct ? ` · ${r.supplierProduct}` : ""}{r.renewsOn ? ` · renews ${fmtDate(r.renewsOn, settings)}` : ""}</div>
                    {r.reason && <div className="text-xs text-slate-500">{r.reason}{r.setByName ? ` (${r.setByName})` : ""}</div>}
                  </td>
                  <td className="text-right tabular-nums">{r.quantity}</td>
                  <td className="text-right tabular-nums">{r.monthlyCost === null ? <span className="text-slate-400">{r.costKnown ? "—" : "not reported"}</span> : fmtMoney(r.monthlyCost, c)}</td>
                  <td className="text-xs text-slate-500">{r.syncedAt ? fmtRelative(r.syncedAt) : "—"}</td>
                  <td>
                    <Badge tone={STATE_TONE[r.state]}>{SERVICE_STATE_LABELS[r.state]}</Badge>
                    {r.reviewOverdue && <Badge tone="red" className="ml-1">review overdue</Badge>}
                    {r.line && r.state !== "charged" && <div className="text-[11px] text-slate-500">{r.line.description}</div>}
                  </td>
                  {canWrite && (
                    <td>
                      <div className="flex flex-wrap items-center gap-1">
                        {!r.pool && <ServiceLineSelect source={r.source} rowId={r.rowId} value={r.state === "charged" ? (r.line?.id ?? null) : null} lines={lineOptions} canEdit compact />}
                        {!r.pool && <CoverageDialog row={r} lines={lineOptions} trigger={r.state === "unmapped" ? "Not charged?" : "Change"} />}
                        {r.pool && <span className="text-xs text-slate-500">tick “Compare with NinjaOne” on a per-device line</span>}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {data.pending.length > 0 && (
        <Card title={`Draft invoices awaiting approval (${data.pending.length})`} padded={false}>
          <DraftReviewTable rows={data.pending} canApprove={canApprove} />
        </Card>
      )}

      <details className="group rounded-lg border border-slate-200 bg-surface shadow-sm" open={Boolean(finance && (finance.drafts.length > 0 || Number(finance.xeroContact?.overdue ?? finance.overdue) > 0))}>
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-slate-800">
          Invoices
          {finance && <span className="ml-2 text-xs font-normal text-slate-500">{finance.count} in Xero · {fmtMoney(finance.invoiced12m, c)} invoiced in 12 months{t.billed.perYear > 0 && <InvoicedVersusExpected invoiced={finance.invoiced12m} expected={t.billed.perYear} currency={c} />}</span>}
        </summary>
        <div className="border-t border-slate-200 p-4">
          <InvoicesSection finance={finance} xero={xero} settings={settings} id={companyId} />
          {data.issued.length > 0 && (
            <Card title={`Created from the CRM (latest ${data.issued.length})`} padded={false} className="mt-4">
              <ul className="divide-y divide-slate-100 text-sm">
                {data.issued.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 px-4 py-2">
                    <span><Link href={`/billing/drafts/${d.id}`} className="text-brand-700 hover:underline">{d.reference}</Link>{d.xeroInvoiceNumber && <span className="text-xs text-slate-500"> · {d.xeroInvoiceNumber}</span>}<div className="text-xs text-slate-500">{d.periodStart ? `${fmtDate(d.periodStart, settings)} – ${fmtDate(d.periodEnd, settings)}` : d.description}</div></span>
                    <span className="whitespace-nowrap text-xs text-slate-600">{fmtMoney(d.subTotal, d.currencyCode)} · <Link href={`/billing/drafts/${d.id}/schedule`} className="text-brand-700 hover:underline">schedule</Link></span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </details>

      {(data.open.length > 0 || data.accepted.length > 0 || data.renewals.length > 0) && (
        <details className="rounded-lg border border-slate-200 bg-surface shadow-sm" open={data.open.length > 0 || data.renewals.some((r) => r.status === "overdue" || r.status === "due")}>
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-slate-800">
            Count checks and renewals
            <span className="ml-2 text-xs font-normal text-slate-500">{data.open.length} open{data.accepted.length ? `, ${data.accepted.length} accepted` : ""} · {data.renewals.length} renewal{data.renewals.length === 1 ? "" : "s"}</span>
          </summary>
          <div className="space-y-4 border-t border-slate-200 p-4">
            {(data.open.length > 0 || data.accepted.length > 0) && (
              <Card title="Count checks" padded={false}>
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
          </div>
        </details>
      )}

      <details className="rounded-lg border border-slate-200 bg-surface shadow-sm">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-slate-800">
          Supplier detail
          <span className="ml-2 text-xs font-normal text-slate-500">
            Pax8 {subscriptions ? `${subscriptions.totals.subscriptions} subscriptions, ${fmtMoney(subscriptions.totals.monthlyCost, c)}/mo` : "not linked"} · 20i {hosting ? `${hosting.totals.packages} packages, ${hosting.totals.domains} domains` : "none linked"}
          </span>
        </summary>
        <div className="space-y-6 border-t border-slate-200 p-4">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Pax8 subscriptions and partner invoices</h3>
            <SubscriptionsPanel overview={subscriptions} canEdit={canWrite} canReview={canReview} canManageIntegrations={canManageIntegrations} settings={settings} companyId={companyId} />
          </section>
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">20i hosting and domains</h3>
            <HostingPanel overview={hosting} canEdit={canWrite} canManageIntegrations={canManageIntegrations} settings={settings} companyId={companyId} />
          </section>
        </div>
      </details>
    </div>
  );
}

/**
 * Compares what Xero shows invoiced in the last 12 months with what a full
 * year of the active agreements' invoices adds up to (monthly × 12 +
 * quarterly × 4 + annual), never the normalised MRR. Agreements younger
 * than a year, one-off work and price changes all move the figure, so it is
 * a prompt to look, not a verdict.
 */
function InvoicedVersusExpected({ invoiced, expected, currency }: { invoiced: number; expected: number; currency: string }) {
  const diff = invoiced - expected;
  const pct = expected ? Math.round((diff / expected) * 100) : 0;
  const tone = Math.abs(pct) <= 10 ? "text-slate-500" : "text-amber-700";
  return (
    <span className={tone} title="A year of the active agreements' invoices: monthly × 12 + quarterly × 4 + annual. Not the normalised MRR.">
      {" "}· agreements expect {fmtMoney(expected, currency)}/yr{Math.abs(pct) > 10 ? ` (${diff > 0 ? "+" : ""}${pct}%)` : ""}
    </span>
  );
}
