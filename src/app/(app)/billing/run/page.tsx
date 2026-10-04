import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { billingWorkspace } from "@/services/billing-workspace";
import { reviewPendingDrafts } from "@/services/draft-review";
import { createdDraftsChangedInXero, listInvoiceDrafts, xeroConnectionSummary } from "@/services/xero";
import { Card } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { fmtDateTime, fmtMoney, fmtRelative } from "@/lib/format";
import { param } from "@/lib/utils";
import { BillingRunForm } from "./form";
import { DraftReviewTable } from "./draft-review";

export const metadata = { title: "Monthly run" };

const STEPS = [
  { key: "prepare", n: 1, label: "Prepare", detail: "What is due and what changed" },
  { key: "approve", n: 2, label: "Approve", detail: "Drafts to Xero" },
  { key: "issued", n: 3, label: "Issued", detail: "Created in Xero" },
] as const;

export default async function MonthlyRunPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("invoice.prepare");
  const sp = await searchParams;
  const step = (["prepare", "approve", "issued"].includes(param(sp, "step") ?? "") ? param(sp, "step") : "prepare") as "prepare" | "approve" | "issued";
  const today = new Date().toISOString().slice(0, 10);
  const raw = param(sp, "asOf");
  const asOf = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : today;
  const settings = await getAppSettings();
  const c = settings.currency;
  const [workspace, pending, conn] = await Promise.all([billingWorkspace(asOf, c), reviewPendingDrafts(c), xeroConnectionSummary()]);
  const month = new Date(asOf + "T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const unchanged = pending.filter((d) => d.verdict === "unchanged").length;
  const counts: Record<string, string> = { prepare: `${workspace.summary.ready} ready · ${workspace.summary.review} review`, approve: `${pending.length} waiting · ${unchanged} unchanged`, issued: "" };

  return (
    <div className="space-y-4">
      <nav aria-label="Run steps" className="grid gap-2 sm:grid-cols-3">
        {STEPS.map((s) => (
          <Link key={s.key} href={`/billing/run?step=${s.key}${asOf !== today ? `&asOf=${asOf}` : ""}`} aria-current={step === s.key ? "step" : undefined} className={`rounded-lg border px-4 py-3 ${step === s.key ? "border-brand-500 bg-brand-50" : "border-slate-200 bg-surface hover:bg-slate-50"}`}>
            <div className="text-xs uppercase tracking-wide text-slate-500">Step {s.n}</div>
            <div className="font-semibold">{s.label}</div>
            <div className="text-xs text-slate-600">{counts[s.key] || s.detail}</div>
          </Link>
        ))}
      </nav>

      {step === "prepare" && (
        <>
          <Card className="mb-0">
            <p className="text-sm text-slate-800">
              <strong>{month} billing:</strong> {workspace.summary.ready} ready, {workspace.summary.review} need review, {workspace.summary.blocked} blocked{workspace.summary.nothing ? `, ${workspace.summary.nothing} with nothing due` : ""}. <strong>{fmtMoney(workspace.summary.expected, c)}</strong> expected billing
              {workspace.summary.unmappedServices ? (
                <>, <Link href="/billing/services?state=unmapped" className="text-amber-700 underline">{fmtMoney(workspace.summary.potentialMissed, c)}/month potential missed revenue</Link> across {workspace.summary.unmappedServices} unmapped service{workspace.summary.unmappedServices === 1 ? "" : "s"}</>
              ) : null}
              {workspace.summary.renewalsThisWeek || workspace.summary.noticeDeadlinesThisWeek ? (
                <>, <Link href="/billing/renewals" className="text-brand-700 underline">{workspace.summary.renewalsThisWeek} renewal{workspace.summary.renewalsThisWeek === 1 ? "" : "s"} and {workspace.summary.noticeDeadlinesThisWeek} notice deadline{workspace.summary.noticeDeadlinesThisWeek === 1 ? "" : "s"} this week</Link></>
              ) : null}
              .
            </p>
            <p className="mt-1 text-xs text-slate-500">One draft per active contract for every line period that is due and not yet invoiced, billed in advance. Each row shows what changed against the previous invoice and why. Potential missed revenue is partner cost of services nobody has mapped; it is not confirmed billable.</p>
          </Card>
          <Card
            title={`Contracts due on ${asOf}`}
            actions={
              <form method="get" className="flex items-center gap-2">
                <input type="hidden" name="step" value="prepare" />
                <label htmlFor="asOf" className="text-xs text-slate-500">Run date</label>
                <Input id="asOf" name="asOf" type="date" defaultValue={asOf} className="w-40" />
                <Button type="submit" size="sm" variant="secondary">Recalculate</Button>
              </form>
            }
          >
            <BillingRunForm key={asOf} asOf={asOf} rows={workspace.rows} currency={c} settings={settings} />
          </Card>
          <p className="text-xs text-slate-500">
            <strong>Ready</strong>: same lines as last time, Xero linked, nothing open for the customer. <strong>Review</strong>: the amount changed, a discrepancy or unmapped service is open, data is stale, or missed periods are included; open the reasons before ticking. <strong>Blocked</strong>: the draft could be prepared but not approved (no Xero link). A line period that already has a draft is never proposed again, so running twice is safe.
          </p>
        </>
      )}

      {step === "approve" && (
        <>
          {!conn.configured && <p className="text-sm text-amber-700">Xero is not connected; drafts can be reviewed but not approved.</p>}
          <Card title={`Draft invoices awaiting approval (${pending.length}${unchanged ? `, ${unchanged} unchanged` : ""})`} padded={false}>
            {pending.length === 0 ? <p className="p-4 text-sm text-slate-500">No drafts waiting. Prepare the run in step 1.</p> : <DraftReviewTable rows={pending} canApprove={can(me.role, "invoice.approve")} />}
          </Card>
          <p className="text-xs text-slate-500">Approving creates the invoice in Xero as a <strong>draft</strong>; it is never authorised or sent by the CRM. Each draft page carries the customer explanation and a printable schedule.</p>
        </>
      )}

      {step === "issued" && <IssuedStep settings={settings} />}
    </div>
  );
}

async function IssuedStep({ settings }: { settings: { currency: string; dateFormat: string; timezone: string } }) {
  const [all, changed] = await Promise.all([listInvoiceDrafts("created"), createdDraftsChangedInXero()]);
  const recent = all.slice(0, 50);
  return (
    <>
      {changed.length > 0 && (
        <Card title={`Changed in Xero after approval (${changed.length})`} padded={false}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Company</th>
                <th>Xero invoice</th>
                <th className="text-right">Approved net</th>
                <th className="text-right">In Xero now</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {changed.map((d) => (
                <tr key={d.id}>
                  <td><Link href={`/billing/drafts/${d.id}`} className="font-medium text-brand-700 hover:underline">{d.reference}</Link></td>
                  <td><Link href={`/companies/${d.companyId}`} className="hover:underline">{d.companyName}</Link></td>
                  <td className="text-xs text-slate-600">{d.xeroInvoiceNumber ?? "—"}</td>
                  <td className="text-right tabular-nums">{fmtMoney(d.diff!.approvedSubTotal, d.currencyCode)}</td>
                  <td className="text-right tabular-nums">{d.diff!.xeroSubTotal === null ? "—" : fmtMoney(d.diff!.xeroSubTotal, d.currencyCode)}</td>
                  <td><Badge tone={d.diff!.status === "VOIDED" || d.diff!.status === "DELETED" ? "red" : "amber"}>{d.diff!.status.toLowerCase()}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-2 text-[11px] text-slate-500">The CRM keeps the approved version for comparison; Xero&apos;s invoice is what the customer receives.</p>
        </Card>
      )}
      <Card title={`Created in Xero (latest ${recent.length})`} padded={false}>
        {recent.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">Nothing has been created in Xero from the CRM yet.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Company</th>
                <th>Xero invoice</th>
                <th className="text-right">Net</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {recent.map((d) => (
                <tr key={d.id}>
                  <td><Link href={`/billing/drafts/${d.id}`} className="font-medium text-brand-700 hover:underline">{d.reference}</Link></td>
                  <td><Link href={`/companies/${d.companyId}`} className="hover:underline">{d.companyName}</Link></td>
                  <td className="text-xs text-slate-600">{d.xeroInvoiceNumber ?? d.xeroInvoiceId ?? "—"}</td>
                  <td className="text-right tabular-nums">{fmtMoney(d.subTotal, d.currencyCode)}</td>
                  <td className="text-xs text-slate-500" title={d.createdInXeroAt ? fmtDateTime(d.createdInXeroAt, settings) : ""}>{d.createdInXeroAt ? fmtRelative(d.createdInXeroAt) : "—"}</td>
                  <td className="text-right"><Link href={`/billing/drafts/${d.id}/schedule`} className="text-xs text-brand-700 hover:underline">Customer schedule</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="px-4 py-2 text-[11px] text-slate-500">Approve and send from Xero. Payments and status flow back through the hourly sync and webhooks into <Link href="/billing/invoices" className="text-brand-700 hover:underline">Invoices</Link>.</p>
      </Card>
    </>
  );
}
