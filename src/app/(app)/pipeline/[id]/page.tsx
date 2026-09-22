import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { getOpportunity } from "@/services/opportunities";
import { listTasks } from "@/services/tasks";
import { listOwners } from "@/services/companies";
import { db } from "@/db";
import { activities, contracts, onboardings, user } from "@/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { PageHeader, Card, DescriptionList, EmptyState } from "@/components/ui/page";
import { ButtonLink } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { RevenueSummaryBadges } from "@/components/lines-editor";
import { CloseControls } from "./close-controls";
import { TaskList } from "@/components/task-list";
import { TaskDialog } from "@/components/task-dialog";
import { Timeline } from "@/components/timeline";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";
import { FREQUENCY_LABELS, PRICING_LABELS, REVENUE_LABELS } from "@/lib/validation-sales";
import { ProposalCard } from "@/components/proposal-card";
import { PrepareInvoiceButton } from "@/components/prepare-invoice-button";
import { bpConnectionSummary, listBpMergeTags, listBpTemplates, proposalsForOpportunity } from "@/services/proposals";
import { contacts as contactsTable } from "@/db/schema";

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requirePermission("opportunity.read");
  const { id } = await params;
  const opp = await getOpportunity(id);
  if (!opp) notFound();
  const [settings, tasks, owners, timeline, [onboarding], [contract]] = await Promise.all([
    getAppSettings(),
    listTasks({ opportunityId: id, status: "all", pageSize: 100 }),
    listOwners(),
    db.select({ id: activities.id, at: activities.at, type: activities.type, title: activities.title, body: activities.body, source: activities.source, actorName: user.name }).from(activities).leftJoin(user, eq(user.id, activities.actorUserId)).where(and(eq(activities.entityType, "opportunity"), eq(activities.entityId, id))).orderBy(desc(activities.at)).limit(30),
    db.select({ id: onboardings.id, name: onboardings.name, status: onboardings.status }).from(onboardings).where(eq(onboardings.opportunityId, id)).limit(1),
    db.select({ id: contracts.id, name: contracts.name, status: contracts.status }).from(contracts).where(eq(contracts.opportunityId, id)).limit(1),
  ]);
  const canWrite = can(me.role, "opportunity.write");
  const c = settings.currency;
  const [bpConn, proposals, companyContacts] = await Promise.all([bpConnectionSummary(), proposalsForOpportunity(id), db.select({ id: contactsTable.id, firstName: contactsTable.firstName, lastName: contactsTable.lastName, email: contactsTable.email, roles: contactsTable.roles }).from(contactsTable).where(and(eq(contactsTable.companyId, opp.companyId), isNull(contactsTable.archivedAt)))]);
  let bpTemplates: { id: string; name: string }[] = [];
  let bpMergeTags: { tag: string; name: string; fallback: string | null }[] = [];
  if (bpConn.configured && can(me.role, "proposal.create") && opp.status === "open") {
    try {
      [bpTemplates, bpMergeTags] = await Promise.all([listBpTemplates().then((r) => r.templates), listBpMergeTags()]);
    } catch {
      /* shown as an error on the Integrations page */
    }
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Sales Pipeline", href: "/pipeline" }, { label: opp.title }]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {opp.title}
            <Badge tone={opp.status === "won" ? "green" : opp.status === "lost" ? "red" : opp.stageColor}>{opp.status === "open" ? opp.stageName : opp.status}</Badge>
          </span>
        }
        description={
          <Link href={`/companies/${opp.companyId}`} className="text-brand-700 hover:underline">
            {opp.companyName}
          </Link>
        }
        actions={
          (canWrite || can(me.role, "invoice.prepare")) && (
            <>
              {opp.status === "won" && can(me.role, "invoice.prepare") && opp.lines.some((l) => l.revenueType !== "recurring") && <PrepareInvoiceButton companyId={opp.companyId} opportunityId={id} />}
              {canWrite && opp.status === "open" && (
                <ButtonLink href={`/pipeline/${id}/edit`} variant="secondary">
                  <Pencil className="h-4 w-4" /> Edit
                </ButtonLink>
              )}
              {canWrite && <CloseControls id={id} status={opp.status} hasLines={opp.lines.length > 0} />}
            </>
          )
        }
      />
      {opp.status === "won" && (
        <Alert tone="success" title={`Won on ${fmtDate(opp.wonAt, settings)}`} className="mb-4">
          <span className="flex flex-wrap gap-3">
            {onboarding ? (
              <Link href={`/tasks/onboarding/${onboarding.id}`} className="underline">
                Onboarding: {onboarding.name} ({onboarding.status.replace("_", " ")})
              </Link>
            ) : (
              <span>No onboarding was created.</span>
            )}
            {contract ? (
              <Link href={`/contracts/${contract.id}`} className="underline">
                Contract: {contract.name} ({contract.status})
              </Link>
            ) : (
              <span>No contract drafted.</span>
            )}
          </span>
        </Alert>
      )}
      {opp.status === "lost" && (
        <Alert tone="warn" title={`Lost on ${fmtDate(opp.lostAt, settings)}`} className="mb-4">
          {opp.lostReason}
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Value" actions={<RevenueSummaryBadges summary={opp.summary} currency={c} compact />}>
            {opp.lines.length === 0 ? (
              <EmptyState title="No line items" description="Add products and services to value this opportunity." />
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th>Type</th>
                    <th>Pricing</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Unit price</th>
                    <th className="text-right">Unit cost</th>
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {opp.lines.map((l) => (
                    <tr key={l.id}>
                      <td>{l.description}</td>
                      <td>
                        <Badge tone={l.revenueType === "recurring" ? "green" : l.revenueType === "hardware" ? "indigo" : "blue"}>{REVENUE_LABELS[l.revenueType]}</Badge>
                      </td>
                      <td className="text-slate-600">
                        {PRICING_LABELS[l.pricingModel]}
                        {l.revenueType === "recurring" && <span className="text-xs"> · {FREQUENCY_LABELS[l.billingFrequency]}</span>}
                      </td>
                      <td className="text-right tabular-nums">{Number(l.quantity)}</td>
                      <td className="text-right tabular-nums">{fmtMoney(l.unitPrice, c)}</td>
                      <td className="text-right tabular-nums text-slate-500">{l.unitCost === null ? <span title="Cost unknown">—</span> : fmtMoney(l.unitCost, c)}</td>
                      <td className="text-right tabular-nums font-medium">{fmtMoney(Number(l.quantity) * Number(l.unitPrice), c)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-3 text-xs text-slate-500">Weighted value: {fmtMoney(opp.weightedValue, c)} ({opp.probability}% of first-year value {fmtMoney(opp.summary.firstYearValue, c)}). Margin is labelled an estimate whenever a line has no cost.</p>
          </Card>

          <Card title="Details">
            <DescriptionList
              items={[
                { label: "Owner", value: opp.ownerName },
                { label: "Primary contact", value: opp.contact ? <Link href={`/contacts/${opp.contact.id}`} className="text-brand-700 hover:underline">{opp.contact.firstName} {opp.contact.lastName}</Link> : null },
                { label: "Expected close", value: fmtDate(opp.expectedCloseDate) },
                { label: "Probability", value: `${opp.probability}%` },
                { label: "Lead source", value: opp.leadSource },
                { label: "Next action", value: opp.nextAction ? `${opp.nextAction}${opp.nextActionDate ? ` (${fmtDate(opp.nextActionDate)})` : ""}` : null },
                { label: "Created", value: fmtDate(opp.createdAt, settings) },
              ]}
            />
            {opp.notes && <p className="mt-4 whitespace-pre-wrap border-t border-slate-100 pt-4 text-sm text-slate-800">{opp.notes}</p>}
          </Card>

          <Card title="Tasks" padded={false} actions={can(me.role, "task.write") && <TaskDialog owners={owners} defaults={{ opportunityId: id, companyId: opp.companyId }} />}>
            <TaskList tasks={tasks.rows} canWrite={can(me.role, "task.write")} settings={settings} compact />
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Proposal" actions={bpConn.demo ? <Badge tone="amber">demo</Badge> : undefined}>
            <ProposalCard
              opportunityId={id}
              proposals={proposals}
              canCreate={can(me.role, "proposal.create")}
              configured={bpConn.configured}
              demo={bpConn.demo}
              templates={bpTemplates}
              defaultTemplateId={String((bpConn.config as { defaultTemplateId?: string }).defaultTemplateId ?? "")}
              contacts={companyContacts.map((x) => ({ id: x.id, name: `${x.firstName} ${x.lastName}`.trim(), email: x.email, roles: x.roles }))}
              mergeTags={bpMergeTags}
              settings={settings}
              opportunityOpen={opp.status === "open"}
            />
          </Card>
          <Card title="History" padded={false}>
            <Timeline items={timeline.map((t) => ({ ...t, at: fmtDateTime(t.at, settings) }))} />
          </Card>
        </div>
      </div>
    </>
  );
}
