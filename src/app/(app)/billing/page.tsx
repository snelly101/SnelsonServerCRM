import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { attentionQueue, ATTENTION_GROUPS, ATTENTION_KINDS, type AttentionGroup, type AttentionKind } from "@/services/attention";
import { listDiscrepancies } from "@/services/ninjaone";
import { xeroConnectionSummary, financeTotals } from "@/services/xero";
import { lastAutomationRun } from "@/services/billing-automation";
import { Card, Stat } from "@/components/ui/page";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { DiscrepancyTable } from "@/app/(app)/devices/discrepancies";
import { fmtDateTime, fmtMoney, fmtRelative } from "@/lib/format";
import { param } from "@/lib/utils";
import { PROVIDER_LABELS } from "@/lib/billing-model";

export const metadata = { title: "Billing" };

const TONE: Record<string, string> = { red: "red", amber: "amber", slate: "slate" };

/**
 * Billing → Needs attention: where the month stands and every item a person
 * should look at, from every check, in one list with filters by group, kind
 * and customer. Each row links to where it is dealt with.
 */
export default async function BillingAttentionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("finance.read");
  const sp = await searchParams;
  const group = param(sp, "group") as AttentionGroup | undefined;
  const kind = param(sp, "kind") as AttentionKind | undefined;
  const companyId = param(sp, "company");
  const view = param(sp, "view");
  const [settings, q, conn, totals, automation, accepted] = await Promise.all([getAppSettings(), attentionQueue(), xeroConnectionSummary(), financeTotals(), lastAutomationRun(), view === "accepted" ? listDiscrepancies({ status: "accepted" }) : Promise.resolve([])]);
  const c = q.currency;
  const month = new Date(q.asOf + "T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  let items = q.items;
  if (group && ATTENTION_GROUPS.some((g) => g.key === group)) items = items.filter((i) => ATTENTION_KINDS[i.kind].group === group);
  if (kind && kind in ATTENTION_KINDS) items = items.filter((i) => i.kind === kind);
  if (companyId) items = items.filter((i) => i.companyId === companyId);
  const customers = [...new Map(q.items.filter((i) => i.companyId).map((i) => [i.companyId!, i.companyName ?? ""])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const link = (p: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ group, kind, company: companyId, ...p })) if (v) u.set(k, v);
    const s = u.toString();
    return `/billing${s ? `?${s}` : ""}`;
  };
  return (
    <div className="space-y-4">
      {!conn.configured && <Alert tone="info">Xero is not connected. <Link href="/integrations/xero" className="underline">Connect it</Link> to approve drafts and see invoices.</Alert>}
      {conn.demo && <Alert tone="warn" title="Demo data">Invoices, payments and supplier data here are synthetic.</Alert>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Link href="/billing/run?step=prepare"><Stat label={`${month} run`} value={fmtMoney(q.workspace.expected, c)} hint={`${q.workspace.ready} ready · ${q.workspace.review} review · ${q.workspace.blocked} blocked`} tone={q.workspace.blocked ? "warn" : "default"} /></Link>
        <Link href="/billing/run?step=approve"><Stat label="Drafts to approve" value={q.drafts.total} hint={`${q.drafts.unchanged} unchanged, one click`} tone={q.drafts.total - q.drafts.unchanged > 0 ? "warn" : "default"} /></Link>
        <Stat label="Needs attention" value={q.actionable} hint={`${q.red} now · ${q.actionable - q.red} this run`} tone={q.red ? "danger" : q.actionable ? "warn" : "good"} />
        <Link href="/billing/invoices?overdue=1"><Stat label="Overdue in Xero" value={fmtMoney(totals.overdue, c)} hint={`${totals.overdueCount} invoice${totals.overdueCount === 1 ? "" : "s"} · ${fmtMoney(totals.outstanding, c)} outstanding`} tone={totals.overdue > 0 ? "danger" : "default"} /></Link>
        <Link href="/billing/services?state=unmapped"><Stat label="Unmapped services" value={q.workspace.unmappedServices} hint={q.workspace.potentialMissed ? `≈ ${fmtMoney(q.workspace.potentialMissed, c)}/month supplier cost` : "nothing possibly missed"} tone={q.workspace.unmappedServices ? "warn" : "default"} /></Link>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link href={link({ group: undefined, kind: undefined })} className={`rounded-md border px-3 py-1 ${!group && !kind && view !== "accepted" ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-200 bg-surface hover:bg-slate-50"}`}>Everything ({q.actionable})</Link>
        {ATTENTION_GROUPS.map((g) => (
          <Link key={g.key} href={link({ group: g.key, kind: undefined })} className={`rounded-md border px-3 py-1 ${group === g.key && !kind ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-200 bg-surface hover:bg-slate-50"} ${q.groups[g.key] === 0 ? "text-slate-400" : ""}`}>
            {g.label} ({q.groups[g.key]})
          </Link>
        ))}
        <Link href="/billing?view=accepted" className={`rounded-md border px-3 py-1 ${view === "accepted" ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-200 bg-surface hover:bg-slate-50"}`}>Accepted exceptions</Link>
        {customers.length > 1 && (
          <form method="get" className="ml-auto">
            {group && <input type="hidden" name="group" value={group} />}
            {kind && <input type="hidden" name="kind" value={kind} />}
            <select name="company" defaultValue={companyId ?? ""} aria-label="Customer" className="h-8 rounded-md border border-slate-200 bg-surface px-2 text-sm" onChange={undefined}>
              <option value="">All customers</option>
              {customers.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
            <button type="submit" className="ml-1 h-8 rounded-md border border-slate-200 bg-surface px-2 text-xs">Go</button>
          </form>
        )}
      </div>

      {view === "accepted" ? (
        <Card title={`Accepted exceptions (${accepted.length})`} padded={false}>
          <DiscrepancyTable rows={accepted} canReview={can(me.role, "discrepancy.review")} currency={c} />
          <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-500">Accepted for now with an owner and a review date; each re-opens by itself when the date passes or the gap grows.</p>
        </Card>
      ) : (
        <Card title={kind ? ATTENTION_KINDS[kind].label : group ? ATTENTION_GROUPS.find((g) => g.key === group)!.label : "Needs attention"} padded={false} actions={kind || group || companyId ? <Link href="/billing" className="text-xs text-brand-700 hover:underline">clear filters</Link> : undefined}>
          {kind && <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-600">{ATTENTION_KINDS[kind].what}</p>}
          {items.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-500">
              <div className="font-medium text-slate-700">Nothing waiting{group || kind || companyId ? " under this filter" : ""}.</div>
              <div className="mt-1">Every ready contract is drafted, every draft is approved and no check has found anything to decide.</div>
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>What</th>
                  <th>Customer</th>
                  <th>Detail</th>
                  <th className="text-right">At stake</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((i, n) => (
                  <tr key={n} className="align-top">
                    <td>
                      <Link href={link({ kind: i.kind, group: undefined })} className="inline-block"><Badge tone={TONE[i.severity]}>{ATTENTION_KINDS[i.kind].label}</Badge></Link>
                      {i.provider && <div className="mt-0.5 text-[11px] text-slate-500">{PROVIDER_LABELS[i.provider]}</div>}
                    </td>
                    <td>{i.companyId ? <Link href={`/companies/${i.companyId}?tab=billing`} className="hover:underline">{i.companyName}</Link> : <span className="text-slate-400">—</span>}</td>
                    <td className="max-w-md">
                      <div className="text-sm">{i.title}</div>
                      {i.detail && <div className="text-xs text-slate-500">{i.detail}</div>}
                    </td>
                    <td className="whitespace-nowrap text-right tabular-nums">{i.amount === null ? "—" : fmtMoney(i.amount, i.currency ?? c)}</td>
                    <td className="text-right"><Link href={i.href} className="text-xs text-brand-700 hover:underline">Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-500">
            <strong>Now</strong> (red) blocks or changes money before the next run; <strong>this run</strong> (amber) is a decision to record; grey is information. Possible missed revenue is kept apart from confirmed gaps. Automation: level {settings.billingAutomationLevel}{automation?.value ? `, last run ${fmtDateTime(automation.value.at, settings)}` : ", never run"} · Xero last fetched {totals.lastFetched ? fmtRelative(totals.lastFetched) : "never"}.
          </p>
        </Card>
      )}
    </div>
  );
}
