import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil, Archive } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { getContract } from "@/services/contracts";
import { listTasks } from "@/services/tasks";
import { listOwners } from "@/services/companies";
import { archiveContractAction } from "@/actions/contracts";
import { PageHeader, Card, DescriptionList, EmptyState } from "@/components/ui/page";
import { ButtonLink } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { RevenueSummaryBadges } from "@/components/lines-editor";
import { TaskList } from "@/components/task-list";
import { TaskDialog } from "@/components/task-dialog";
import { fmtDate, fmtMoney, fmtRelative } from "@/lib/format";
import { PrepareInvoiceButton } from "@/components/prepare-invoice-button";
import { FREQUENCY_LABELS, PRICING_LABELS, REVENUE_LABELS } from "@/lib/validation-sales";
import { companyDeviceOverview } from "@/services/ninjaone";
import { DiscrepancyTable } from "@/app/(app)/devices/discrepancies";
import { renewalQueue, DECISION_LABELS } from "@/services/renewals";
import { proposalForContract } from "@/services/proposals";
import { RenewalDecisionButton, ClearRenewalDecisionButton } from "@/components/renewal-decision";

const STATUS_TONE: Record<string, string> = { draft: "slate", active: "green", expired: "amber", cancelled: "red" };

export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requirePermission("contract.read");
  const { id } = await params;
  const contract = await getContract(id);
  if (!contract) notFound();
  const [settings, tasks, owners, devices, renewalRows] = await Promise.all([getAppSettings(), listTasks({ contractId: id, status: "all", pageSize: 100 }), listOwners(), can(me.role, "device.read") ? companyDeviceOverview(contract.companyId) : Promise.resolve(null), contract.status === "active" && contract.renewalDate ? renewalQueue(undefined, { contractId: id }) : Promise.resolve([])]);
  const renewal = renewalRows[0] ?? null;
  const proposal = contract.externalProposalId ? await proposalForContract(contract.externalProposalId) : null;
  const contractDiscrepancies = devices?.discrepancies.filter((d) => d.contractId === id) ?? [];
  const c = settings.currency;
  const today = new Date().toISOString().slice(0, 10);
  const canWrite = can(me.role, "contract.write");
  const deviceLines = contract.lines.filter((l) => l.countsAsManagedDevice);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Contracts", href: "/contracts" }, { label: contract.name }]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {contract.name}
            <Badge tone={STATUS_TONE[contract.status]}>{contract.status}</Badge>
          </span>
        }
        description={
          <>
            <Link href={`/companies/${contract.companyId}`} className="text-brand-700 hover:underline">
              {contract.companyName}
            </Link>
            {contract.reference && <> · {contract.reference}</>}
          </>
        }
        actions={
          (canWrite || can(me.role, "invoice.prepare")) && (
            <>
              {can(me.role, "invoice.prepare") && contract.status === "active" && <PrepareInvoiceButton companyId={contract.companyId} contractId={id} billingFrequency={contract.billingFrequency} currency={c} />}
              {canWrite && (
                <>
                  <ButtonLink href={`/contracts/${id}/edit`} variant="secondary">
                    <Pencil className="h-4 w-4" /> Edit
                  </ButtonLink>
                  <ConfirmButton variant="danger-outline" action={archiveContractAction.bind(null, id)} title="Archive this contract?" description="It will be hidden from lists and excluded from MRR. Nothing is deleted." confirmLabel="Archive">
                    <Archive className="h-4 w-4" /> Archive
                  </ConfirmButton>
                </>
              )}
            </>
          )
        }
      />
      {contract.status === "active" && contract.noticeDeadline && contract.noticeDeadline <= today && (
        <Alert tone="warn" title="Notice deadline reached" className="mb-4">
          The notice period for the {fmtDate(contract.renewalDate, settings)} renewal ended on {fmtDate(contract.noticeDeadline, settings)}. {contract.autoRenew ? "This contract auto-renews." : "This contract will expire unless renewed."}
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Contracted services" actions={<RevenueSummaryBadges summary={contract.summary} currency={c} compact />}>
            {contract.lines.length === 0 ? (
              <EmptyState title="No services on this contract" />
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Type</th>
                    <th>Pricing</th>
                    <th>Site</th>
                    <th className="text-right">Contracted qty</th>
                    <th className="text-right">Unit price</th>
                    <th className="text-right">Per period</th>
                  </tr>
                </thead>
                <tbody>
                  {contract.lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.description}
                        {l.countsAsManagedDevice && <Badge className="ml-1" tone="teal">device-checked</Badge>}
                      </td>
                      <td>
                        <Badge tone={l.revenueType === "recurring" ? "green" : l.revenueType === "hardware" ? "indigo" : "blue"}>{REVENUE_LABELS[l.revenueType]}</Badge>
                      </td>
                      <td className="text-slate-600">
                        {PRICING_LABELS[l.pricingModel]}
                        {l.revenueType === "recurring" && <span className="text-xs"> · {FREQUENCY_LABELS[l.billingFrequency]}{l.invoiceSchedule === "own" ? ", own cycle" : ""}</span>}
                        {l.revenueType === "recurring" && l.reductionPolicy !== "next_period" && <div className="text-[11px] text-slate-500">{l.reductionPolicy === "immediate" ? "decreases credited" : "decreases at renewal"}</div>}
                      </td>
                      <td className="text-slate-600">{l.siteName ?? "All"}</td>
                      <td className="text-right tabular-nums font-medium">
                        {Number(l.quantity)}
                        {l.pendingChanges.filter((h) => h.field === "quantity").map((h) => (
                          <div key={h.id} className="text-[11px] font-normal text-amber-700" title="Not yet on an invoice; the next one pro-rates it">
                            {Number(h.previousValue ?? 0)} → {Number(h.newValue ?? 0)} from {fmtDate(h.effectiveFrom, settings)}
                          </div>
                        ))}
                      </td>
                      <td className="text-right tabular-nums">{fmtMoney(l.unitPrice, c)}</td>
                      <td className="text-right tabular-nums">{fmtMoney(Number(l.quantity) * Number(l.unitPrice), c)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-3 text-xs text-slate-500">
              <strong>Monthly</strong> is what the monthly invoice carries (recurring lines billed monthly). Quarterly and annual lines are invoiced on their own cycle and shown per quarter or per year. <strong>MRR normalised</strong> (annual ÷ 12, quarterly ÷ 3, added to the monthly lines) appears only when it differs; it is the forecasting figure used on the Reports page, not a monthly bill. One-off and hardware lines are excluded from both.
            </p>
          </Card>

          {contract.history.length > 0 && (
            <Card title={`Change history (${contract.history.length})`} padded={false}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Recorded</th>
                    <th>Service</th>
                    <th>Change</th>
                    <th>Effective</th>
                    <th>By / reason</th>
                    <th>Invoiced on</th>
                  </tr>
                </thead>
                <tbody>
                  {contract.history.map((h) => (
                    <tr key={h.id}>
                      <td className="whitespace-nowrap text-xs text-slate-500">{fmtDate(h.recordedAt, settings)}</td>
                      <td>
                        {h.lineDescription}
                        {!h.contractLineId && <Badge className="ml-1" tone="slate">removed</Badge>}
                      </td>
                      <td className="tabular-nums">
                        {h.field === "unit_price" ? `${fmtMoney(h.previousValue ?? 0, c)} → ${fmtMoney(h.newValue ?? 0, c)}` : `${Number(h.previousValue ?? 0)} → ${Number(h.newValue ?? 0)}`}
                        <span className="ml-1 text-xs text-slate-500">{h.field === "unit_price" ? "price" : "qty"}</span>
                      </td>
                      <td className="whitespace-nowrap">{fmtDate(h.effectiveFrom, settings)}</td>
                      <td className="text-xs text-slate-600">
                        {h.actorName ?? "—"}
                        {h.reason && <div className="text-slate-500">{h.reason}</div>}
                      </td>
                      <td className="text-xs">
                        {h.settledByDraftId ? (
                          <Link href={`/finance/drafts/${h.settledByDraftId}`} className="text-brand-700 hover:underline">
                            {h.draftReference} <span className="text-slate-500">({h.draftStatus})</span>
                          </Link>
                        ) : (
                          <span className="text-amber-700">awaiting invoice</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-4 py-2 text-[11px] text-slate-500">Every dated change on this active contract. The next invoice bills increases pro rata from their effective day; decreases apply from the following period; price changes apply from the next period starting on or after the effective day. A cancelled draft hands its changes back to the next one.</p>
            </Card>
          )}

          <Card title="Device count check" padded={contractDiscrepancies.length === 0}>
            {deviceLines.length === 0 ? (
              <p className="text-sm text-slate-500">No per-device lines are marked for comparison. Edit the contract and tick “Compare with NinjaOne device count” on a per-device line.</p>
            ) : !devices ? (
              <div className="text-sm text-slate-700">
                <p className="mb-2">{deviceLines.length} line{deviceLines.length === 1 ? "" : "s"} will be compared with observed device counts once this company is linked to a NinjaOne organisation. Discrepancies appear here for review; billing is never changed automatically.</p>
                <ul className="list-disc pl-5 text-slate-600">
                  {deviceLines.map((l) => (
                    <li key={l.id}>
                      {l.description}: contracted <strong>{Number(l.quantity)}</strong>, observed <span className="italic text-slate-400">unavailable (not linked)</span>
                    </li>
                  ))}
                </ul>
                {can(me.role, "integration.manage") && (
                  <Link href="/integrations/ninjaone" className="mt-2 inline-block text-xs text-brand-700 hover:underline">
                    Link on Integrations → NinjaOne
                  </Link>
                )}
              </div>
            ) : contractDiscrepancies.length === 0 ? (
              <div className="text-sm text-slate-700">
                <p className="mb-1">
                  All {deviceLines.length} compared line{deviceLines.length === 1 ? "" : "s"} match the observed count ({devices.totals.billable} billable active devices{devices.mode === "demo" ? ", demo data" : ""}).
                </p>
                <p className="text-xs text-slate-500">Observed counts are {devices.totals.freshness}{devices.totals.lastFetched ? `, fetched ${fmtRelative(new Date(devices.totals.lastFetched))}` : ""}. Site-scoped lines whose site is not linked to a NinjaOne location are skipped.</p>
              </div>
            ) : (
              <>
                <DiscrepancyTable rows={contractDiscrepancies} canReview={can(me.role, "discrepancy.review")} currency={c} compact />
                <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
                  Observed counts are {devices.totals.freshness}{devices.mode === "demo" ? " (demo data)" : ""}. Accepting records the decision only; amend the contract to change billing.
                </p>
              </>
            )}
          </Card>

          <Card title="Tasks" padded={false} actions={can(me.role, "task.write") && <TaskDialog owners={owners} defaults={{ contractId: id, companyId: contract.companyId }} />}>
            <TaskList tasks={tasks.rows} canWrite={can(me.role, "task.write")} settings={settings} compact />
          </Card>
        </div>
        <div className="space-y-4">
          {renewal && (
            <Card
              title="Renewal"
              actions={canWrite && (renewal.decision ? <ClearRenewalDecisionButton contractId={id} /> : <RenewalDecisionButton contractId={id} renewalDate={renewal.renewalDate} amendHref={`/contracts/${id}/edit?effectiveFrom=${renewal.renewalDate}`} />)}
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={renewal.status === "overdue" ? "red" : renewal.status === "due" ? "amber" : renewal.status === "decided" ? "green" : "slate"}>
                  {renewal.status === "decided" ? DECISION_LABELS[renewal.decision!.kind] : renewal.status === "overdue" ? "decision overdue" : renewal.status === "due" ? "decide now" : "upcoming"}
                </Badge>
                <span className="text-slate-700">
                  Decide by {fmtDate(renewal.decideBy, settings)} · notice by {fmtDate(renewal.noticeDeadline, settings)} · renews {fmtDate(renewal.renewalDate, settings)}
                </span>
              </div>
              {renewal.decision && (
                <p className="mt-2 text-xs text-slate-600">
                  Recorded {fmtRelative(renewal.decision.at)}{renewal.decision.by ? ` by ${renewal.decision.by}` : ""}{renewal.decision.note ? `: ${renewal.decision.note}` : ""}
                </p>
              )}
              {renewal.mismatches.length > 0 ? (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-amber-800">
                  {renewal.mismatches.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-slate-500">{renewal.services.length ? `${renewal.services.length} supplier service${renewal.services.length === 1 ? "" : "s"} behind this agreement; commitments end with or before it.` : "No supplier commitments on record for this agreement's lines."}</p>
              )}
              {renewal.exposureTotal > 0 && <p className="mt-1 text-xs text-amber-800">≈ {fmtMoney(renewal.exposureTotal, c)} supplier cost would remain payable beyond the renewal date if the customer does not renew.</p>}
              {renewal.planned.length > 0 && (
                <p className="mt-1 text-xs text-slate-600">Planned: {renewal.planned.map((p) => `${p.lineDescription} ${p.field === "unit_price" ? "price " : ""}${p.previousValue ?? "—"} → ${p.newValue ?? "—"} from ${p.effectiveFrom}`).join("; ")}</p>
              )}
              {canWrite && (
                <Link href={`/contracts/${id}/edit?effectiveFrom=${renewal.renewalDate}`} className="mt-2 inline-block text-xs text-brand-700 hover:underline">
                  Prepare an amendment from the renewal date
                </Link>
              )}
            </Card>
          )}
          <Card title="Terms">
            <DescriptionList
              items={[
                { label: "Start", value: fmtDate(contract.startDate, settings) },
                { label: "End", value: fmtDate(contract.endDate, settings) },
                { label: "Renewal", value: fmtDate(contract.renewalDate, settings) },
                { label: "Notice period", value: `${contract.noticePeriodDays} days (by ${fmtDate(contract.noticeDeadline, settings)})` },
                { label: "Auto-renew", value: contract.autoRenew ? "Yes" : "No" },
                { label: "Prices", value: contract.priceLockedUntilRenewal ? `Fixed until renewal (${fmtDate(contract.renewalDate, settings)})` : "May be reviewed at any time" },
                { label: "Billing", value: `${FREQUENCY_LABELS[contract.billingFrequency]}${contract.billingDay ? `, periods from the ${contract.billingDay}${[1, 21].includes(contract.billingDay) ? "st" : [2, 22].includes(contract.billingDay) ? "nd" : [3, 23].includes(contract.billingDay) ? "rd" : "th"}` : ", periods from the start date"}` },
                { label: "Next review", value: fmtDate(contract.nextReviewDate, settings) },
                { label: "Review interval", value: `${contract.reviewIntervalMonths} months` },
                { label: "Owner", value: contract.ownerName },
                { label: "Linked opportunity", value: contract.opportunityId ? <Link href={`/pipeline/${contract.opportunityId}`} className="text-brand-700 hover:underline">Open</Link> : null },
                {
                  label: "Proposal",
                  value: proposal ? (
                    <span>
                      {proposal.viewUrl ? <a href={proposal.viewUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">{proposal.subjectLine ?? contract.externalProposalId}</a> : (proposal.subjectLine ?? contract.externalProposalId)}
                      {proposal.signedAt && <span className="text-xs text-slate-500"> · signed {fmtDate(proposal.signedAt, settings)}{proposal.signedBy ? ` by ${proposal.signedBy}` : ""}</span>}
                      {proposal.termsChangedAfterSignature ? <Badge className="ml-1" tone="red" title="The opportunity's lines were edited after the signature and before the contract was drafted; check the contract against the signed proposal">terms changed after signature</Badge> : proposal.acceptedTerms ? <Badge className="ml-1" tone="green" title="The contract was drafted from the lines captured at acceptance">signed terms captured</Badge> : null}
                    </span>
                  ) : (contract.externalProposalId ?? "Not linked"),
                },
              ]}
            />
            {contract.notes && <p className="mt-4 whitespace-pre-wrap border-t border-slate-100 pt-4 text-sm text-slate-800">{contract.notes}</p>}
          </Card>
        </div>
      </div>
    </>
  );
}
