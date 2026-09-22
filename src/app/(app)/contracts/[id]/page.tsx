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

const STATUS_TONE: Record<string, string> = { draft: "slate", active: "green", expired: "amber", cancelled: "red" };

export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requirePermission("contract.read");
  const { id } = await params;
  const contract = await getContract(id);
  if (!contract) notFound();
  const [settings, tasks, owners, devices] = await Promise.all([getAppSettings(), listTasks({ contractId: id, status: "all", pageSize: 100 }), listOwners(), can(me.role, "device.read") ? companyDeviceOverview(contract.companyId) : Promise.resolve(null)]);
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
              {can(me.role, "invoice.prepare") && contract.status === "active" && <PrepareInvoiceButton companyId={contract.companyId} contractId={id} billingFrequency={contract.billingFrequency} />}
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
                        {l.revenueType === "recurring" && <span className="text-xs"> · {FREQUENCY_LABELS[l.billingFrequency]}</span>}
                      </td>
                      <td className="text-slate-600">{l.siteName ?? "All"}</td>
                      <td className="text-right tabular-nums font-medium">{Number(l.quantity)}</td>
                      <td className="text-right tabular-nums">{fmtMoney(l.unitPrice, c)}</td>
                      <td className="text-right tabular-nums">{fmtMoney(Number(l.quantity) * Number(l.unitPrice), c)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-3 text-xs text-slate-500">MRR = Σ recurring lines (contracted qty × unit price ÷ months per billing period). One-off and hardware lines are excluded from MRR and shown separately.</p>
          </Card>

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
          <Card title="Terms">
            <DescriptionList
              items={[
                { label: "Start", value: fmtDate(contract.startDate, settings) },
                { label: "End", value: fmtDate(contract.endDate, settings) },
                { label: "Renewal", value: fmtDate(contract.renewalDate, settings) },
                { label: "Notice period", value: `${contract.noticePeriodDays} days (by ${fmtDate(contract.noticeDeadline, settings)})` },
                { label: "Auto-renew", value: contract.autoRenew ? "Yes" : "No" },
                { label: "Billing", value: FREQUENCY_LABELS[contract.billingFrequency] },
                { label: "Next review", value: fmtDate(contract.nextReviewDate, settings) },
                { label: "Review interval", value: `${contract.reviewIntervalMonths} months` },
                { label: "Owner", value: contract.ownerName },
                { label: "Linked opportunity", value: contract.opportunityId ? <Link href={`/pipeline/${contract.opportunityId}`} className="text-brand-700 hover:underline">Open</Link> : null },
                { label: "Proposal", value: contract.externalProposalId ?? "Not linked (Phase 3)" },
              ]}
            />
            {contract.notes && <p className="mt-4 whitespace-pre-wrap border-t border-slate-100 pt-4 text-sm text-slate-800">{contract.notes}</p>}
          </Card>
        </div>
      </div>
    </>
  );
}
