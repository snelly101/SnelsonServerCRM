import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { bpConnectionSummary, listProposals, proposalCounts } from "@/services/proposals";
import { listSavedViews } from "@/services/settings";
import { companyOptions } from "@/services/lookups";
import { listOpportunities } from "@/services/opportunities";
import { PageHeader, Card, EmptyState, Stat } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Pagination } from "@/components/ui/pagination";
import { FilterBar } from "@/components/ui/filter-bar";
import { ButtonLink } from "@/components/ui/button";
import { LinkProposalDialog } from "./link-dialog";
import { SyncNowButton } from "../integrations/controls";
import { fmtDate, fmtMoney } from "@/lib/format";
import { param, toInt } from "@/lib/utils";

export const metadata = { title: "Proposals" };

const STATUS_TONE: Record<string, string> = { draft: "slate", sent: "blue", opened: "indigo", signed: "green", paid: "teal", unknown: "slate" };

export default async function ProposalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("proposal.read");
  const sp = await searchParams;
  const [data, counts, conn, views, settings, companies, opps] = await Promise.all([
    listProposals({ q: param(sp, "q"), status: param(sp, "status"), unlinked: param(sp, "linked") === "no", page: toInt(param(sp, "page"), 1) }),
    proposalCounts(),
    bpConnectionSummary(),
    listSavedViews(me.id, "proposals"),
    getAppSettings(),
    companyOptions(),
    listOpportunities({ status: "open", pageSize: 200 }),
  ]);
  const canLink = can(me.role, "proposal.create");
  return (
    <>
      <PageHeader
        title="Proposals"
        description="Better Proposals documents mirrored into the CRM. Status and dates come from Better Proposals; pricing and sending happen there."
        actions={
          <>
            {conn.configured && can(me.role, "integration.sync") && <SyncNowButton provider="betterproposals" label="Refresh from Better Proposals" />}
            <ButtonLink href="/integrations/betterproposals" variant="secondary">
              Connection
            </ButtonLink>
          </>
        }
      />
      {!conn.configured && (
        <Alert tone="info" className="mb-4">
          Better Proposals is not connected. <Link href="/integrations/betterproposals" className="underline">Connect it</Link> to create and track proposals.
        </Alert>
      )}
      {conn.demo && (
        <Alert tone="warn" title="Demo data" className="mb-4">
          These proposals are synthetic. Nothing here has been sent to a customer.
        </Alert>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Proposals" value={counts.total} />
        <Stat label="Awaiting signature" value={counts.sent} />
        <Stat label="Signed / paid" value={counts.signed} tone="good" />
        <Stat label="Not linked to a company" value={counts.unlinked} tone={counts.unlinked ? "warn" : "default"} />
      </div>
      <FilterBar
        page="proposals"
        currentUserId={me.id}
        savedViews={views}
        placeholder="Search subject or company…"
        filters={[
          { key: "status", label: "Status", options: ["draft", "sent", "opened", "signed", "paid"].map((s) => ({ value: s, label: s })) },
          { key: "linked", label: "Linked", options: [{ value: "no", label: "Unlinked only" }] },
        ]}
      />
      {data.total === 0 ? (
        <EmptyState title="No proposals" description={conn.configured ? "Run a refresh, or create one from an opportunity." : "Connect Better Proposals first."} />
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Proposal</th>
                  <th>Status</th>
                  <th>Company</th>
                  <th>Opportunity</th>
                  <th className="text-right">Monthly</th>
                  <th className="text-right">One-off</th>
                  <th>Sent</th>
                  <th>Opened</th>
                  <th>Signed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className="font-medium">{p.subjectLine ?? `Proposal ${p.externalId}`}</span>
                      {p.viewUrl && (
                        <a href={p.viewUrl} target="_blank" rel="noreferrer" className="ml-1 inline-flex align-middle text-slate-400 hover:text-brand-700" aria-label="Open in Better Proposals">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                      <div className="text-xs text-slate-500">#{p.externalId}</div>
                    </td>
                    <td>
                      <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
                      {p.acceptanceProcessedAt && <Badge className="ml-1" tone="green">won</Badge>}
                    </td>
                    <td>
                      {p.companyId ? (
                        <Link href={`/companies/${p.companyId}`} className="hover:underline">
                          {p.companyName}
                        </Link>
                      ) : (
                        <span className="text-slate-500">{p.externalCompanyName ?? "—"}</span>
                      )}
                    </td>
                    <td>
                      {p.opportunityId ? (
                        <Link href={`/pipeline/${p.opportunityId}`} className="hover:underline">
                          {p.opportunityTitle}
                        </Link>
                      ) : (
                        <span className="text-xs text-amber-700">not linked</span>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{fmtMoney(p.monthlyTotal, p.currencyCode ?? settings.currency)}</td>
                    <td className="text-right tabular-nums">{fmtMoney(p.oneOffTotal, p.currencyCode ?? settings.currency)}</td>
                    <td>{fmtDate(p.sentAt, settings)}</td>
                    <td>{fmtDate(p.openedAt, settings)}</td>
                    <td>{fmtDate(p.signedAt, settings)}</td>
                    <td className="text-right">{canLink && !p.opportunityId && <LinkProposalDialog externalId={p.externalId} subject={p.subjectLine ?? p.externalId} companies={companies} opportunities={opps.rows.map((o) => ({ id: o.id, title: o.title, companyName: o.companyName }))} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={data.page} pageCount={data.pageCount} total={data.total} pageSize={data.pageSize} />
        </Card>
      )}
    </>
  );
}
