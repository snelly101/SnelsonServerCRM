import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { proposalItems } from "@/services/proposals";
import { PageHeader, Card, DescriptionList, EmptyState } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { fmtDate, fmtMoney, fmtRelative } from "@/lib/format";
import { FREQUENCY_LABELS } from "@/lib/validation-sales";
import { ContractFromProposalButton } from "../contract-button";

export const metadata = { title: "Proposal" };

const STATUS_TONE: Record<string, string> = { draft: "slate", sent: "blue", opened: "indigo", signed: "green", paid: "teal", unknown: "slate" };

/** One proposal: its line items as read from the Better Proposals quote, the totals they add up to against the proposal's own, and (for integration admins) the raw responses. */
export default async function ProposalPage({ params }: { params: Promise<{ externalId: string }> }) {
  const me = await requirePermission("proposal.read");
  const { externalId } = await params;
  const [p, settings] = await Promise.all([proposalItems(externalId), getAppSettings()]);
  if (!p) notFound();
  const c = p.currencyCode ?? settings.currency;
  const signed = p.status === "signed" || p.status === "paid";
  const differs = (ours: number, theirs: string | null) => theirs !== null && Math.abs(ours - Number(theirs)) > 0.005;
  const canWrite = can(me.role, "contract.write");
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Proposals", href: "/proposals" }, { label: p.subjectLine ?? `Proposal ${externalId}` }]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {p.subjectLine ?? `Proposal ${externalId}`}
            <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
          </span>
        }
        description={
          <>
            #{externalId}
            {p.companyId ? <> · <Link href={`/companies/${p.companyId}`} className="text-brand-700 hover:underline">{p.companyName}</Link></> : null}
            {p.viewUrl && (
              <a href={p.viewUrl} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 text-brand-700 hover:underline">
                Open in Better Proposals <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </>
        }
        actions={signed ? (p.contract ? <ButtonLink href={`/contracts/${p.contract.id}`} variant="secondary">Contract: {p.contract.name}</ButtonLink> : canWrite ? <ContractFromProposalButton externalId={externalId} linked={Boolean(p.opportunityId)} /> : null) : null}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title={`Line items from the quote (${p.items.length})`} padded={false}>
            {p.items.length === 0 ? (
              <div className="p-4">
                <EmptyState title="No line items" description={p.quoteFetchedAt ? `The quote was fetched ${fmtRelative(p.quoteFetchedAt)} but no priced rows could be read from it. The proposal's totals are still used when creating a contract.` : "The quote has not been fetched yet. Run Refresh from Better Proposals on the Proposals page."} />
              </div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Section</th>
                    <th>Billing</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Unit price</th>
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {p.items.map((it, i) => (
                    <tr key={i}>
                      <td>{it.description}</td>
                      <td className="text-xs text-slate-500">{it.section ?? "—"}</td>
                      <td><Badge tone={it.billingFrequency === "one_off" ? "blue" : "green"}>{FREQUENCY_LABELS[it.billingFrequency as keyof typeof FREQUENCY_LABELS] ?? it.billingFrequency}</Badge></td>
                      <td className="text-right tabular-nums">{it.quantity}</td>
                      <td className="text-right tabular-nums">{fmtMoney(it.unitPrice, c)}</td>
                      <td className="text-right tabular-nums">{fmtMoney(it.total ?? it.quantity * it.unitPrice, c)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-500">Read from the proposal&apos;s quote at Better Proposals (the public API does not document its shape, so rows are recognised by a name and a price, and the billing type by the row, its section or its key). <strong>Create contract</strong> turns these into contract lines, matched to catalogue products by name; check quantities and pricing models before activating.</p>
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Totals">
            <DescriptionList
              items={[
                { label: "Monthly (proposal)", value: <>{fmtMoney(p.monthlyTotal, c)}{p.items.length > 0 && differs(p.totals.monthly, p.monthlyTotal) && <Badge className="ml-1" tone="amber" title="The line items add up differently from the proposal's own total">items {fmtMoney(p.totals.monthly, c)}</Badge>}</> },
                { label: "One-off (proposal)", value: <>{fmtMoney(p.oneOffTotal, c)}{p.items.length > 0 && differs(p.totals.oneOff, p.oneOffTotal) && <Badge className="ml-1" tone="amber" title="The line items add up differently from the proposal's own total">items {fmtMoney(p.totals.oneOff, c)}</Badge>}</> },
                ...(p.quarterlyTotal && Number(p.quarterlyTotal) > 0 ? [{ label: "Quarterly (proposal)", value: fmtMoney(p.quarterlyTotal, c) }] : []),
                ...(p.annualTotal && Number(p.annualTotal) > 0 ? [{ label: "Annual (proposal)", value: fmtMoney(p.annualTotal, c) }] : []),
                { label: "Signed", value: p.signedAt ? `${fmtDate(p.signedAt, settings)}${p.signedBy ? ` by ${p.signedBy}` : ""}` : "—" },
                { label: "Quote", value: p.quoteId ? `#${p.quoteId}${p.quoteFetchedAt ? `, fetched ${fmtRelative(p.quoteFetchedAt)}` : ""}` : "none on the proposal" },
              ]}
            />
          </Card>
          {can(me.role, "integration.manage") && (
            <details className="rounded-lg border border-slate-200 bg-surface shadow-sm">
              <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-slate-800">Raw API responses</summary>
              <div className="space-y-3 border-t border-slate-200 p-4 text-xs">
                <div>
                  <div className="mb-1 font-semibold text-slate-600">GET /quote/{p.quoteId ?? "?"}</div>
                  <pre className="max-h-96 overflow-auto rounded bg-slate-50 p-2">{p.quoteRaw ? JSON.stringify(p.quoteRaw, null, 2) : "not fetched or empty"}</pre>
                </div>
                <div>
                  <div className="mb-1 font-semibold text-slate-600">GET /proposal/{externalId}</div>
                  <pre className="max-h-96 overflow-auto rounded bg-slate-50 p-2">{JSON.stringify(p.raw ?? {}, null, 2)}</pre>
                </div>
                <p className="text-slate-500">Kept so the item extraction can be checked against what the API really returns. If rows are missing from the table above, this is what to send along with the report.</p>
              </div>
            </details>
          )}
        </div>
      </div>
    </>
  );
}
