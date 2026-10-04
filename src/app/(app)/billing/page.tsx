import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { billingOverview } from "@/services/billing-overview";
import { Card, Stat } from "@/components/ui/page";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { fmtDateTime, fmtMoney, fmtRelative } from "@/lib/format";

export const metadata = { title: "Billing" };

const TONE: Record<string, string> = { red: "red", amber: "amber", slate: "slate" };

export default async function BillingOverviewPage() {
  await requirePermission("finance.read");
  const [settings, o] = await Promise.all([getAppSettings(), billingOverview()]);
  const c = o.currency;
  const month = new Date(o.asOf + "T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <div className="space-y-4">
      {!o.conn.configured && <Alert tone="info">Xero is not connected. <Link href="/integrations/xero" className="underline">Connect it</Link> to approve drafts and see invoices.</Alert>}
      {o.conn.demo && <Alert tone="warn" title="Demo data">Invoices, payments and supplier data here are synthetic.</Alert>}

      <Card title={`${month}: what to do next`} padded={false}>
        <ol className="divide-y divide-slate-100">
          {o.next.map((n, i) => (
            <li key={i} className="flex items-start gap-3 px-4 py-3">
              <Badge tone={TONE[n.tone]} className="mt-0.5 shrink-0">{n.tone === "red" ? "now" : n.tone === "amber" ? "this run" : "info"}</Badge>
              <div className="min-w-0 flex-1">
                <Link href={n.href} className="font-medium text-brand-700 hover:underline">{n.label}</Link>
                <div className="text-xs text-slate-600">{n.detail}</div>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Link href="/billing/run?step=prepare"><Stat label="Monthly run" value={fmtMoney(o.workspace.expected, c)} hint={`${o.workspace.ready} ready · ${o.workspace.review} review · ${o.workspace.blocked} blocked`} tone={o.workspace.blocked ? "warn" : "default"} /></Link>
        <Link href="/billing/run?step=approve"><Stat label="Drafts awaiting approval" value={o.drafts.total} hint={`${o.drafts.unchanged} unchanged · ${o.drafts.exceptions} exceptions${o.drafts.failed ? ` · ${o.drafts.failed} failed` : ""}`} tone={o.drafts.failed ? "danger" : o.drafts.total ? "warn" : "default"} /></Link>
        <Link href="/billing/exceptions"><Stat label="Exceptions" value={o.findings.actionable + o.counts.device + o.counts.licence} hint={`${o.findings.red} red · ${o.counts.licence + o.counts.device} count discrepancies · ${o.counts.accepted} accepted`} tone={o.findings.red ? "danger" : "default"} /></Link>
        <Link href="/billing/renewals"><Stat label="Renewals" value={o.renewals.overdue + o.renewals.due} hint={`${o.renewals.overdue} overdue · ${o.renewals.due} due · ${o.renewals.mismatches} supplier mismatches`} tone={o.renewals.overdue ? "danger" : o.renewals.due ? "warn" : "default"} /></Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="In Xero">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Outstanding" value={fmtMoney(o.xero.outstanding, c)} />
            <Stat label="Overdue" value={fmtMoney(o.xero.overdue, c)} hint={`${o.xero.overdueCount} invoice${o.xero.overdueCount === 1 ? "" : "s"}`} tone={o.xero.overdue > 0 ? "danger" : "default"} />
            <Stat label="Paid, last 30 days" value={fmtMoney(o.xero.paidLast30, c)} tone="good" />
            <Stat label="Drafts in Xero" value={o.xero.draftsInXero} hint="approve and send in Xero" />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Last fetched {o.xero.lastFetched ? fmtRelative(o.xero.lastFetched) : "never"}.{o.xero.changed ? <> <Link href="/billing/run?step=issued" className="text-amber-700 underline">{o.xero.changed} changed in Xero after approval</Link>.</> : null} <Link href="/billing/invoices" className="text-brand-700 hover:underline">All invoices</Link>
          </p>
        </Card>
        <Card title="How the month flows">
          <ol className="space-y-2 text-sm text-slate-700">
            <li><strong>1. Prepare</strong> · <Link href="/billing/run?step=prepare" className="text-brand-700 hover:underline">Monthly run</Link>: one row per contract with what changed since last time; tick the ready ones.</li>
            <li><strong>2. Approve</strong> · <Link href="/billing/run?step=approve" className="text-brand-700 hover:underline">Drafts</Link>: unchanged drafts go to Xero together; exceptions one by one, each with a customer explanation.</li>
            <li><strong>3. Issued</strong> · in Xero: approve and send there; the CRM watches for changes after approval.</li>
            <li><strong>Between runs</strong> · <Link href="/billing/exceptions" className="text-brand-700 hover:underline">Exceptions</Link>, <Link href="/billing/services" className="text-brand-700 hover:underline">Services</Link> and <Link href="/billing/renewals" className="text-brand-700 hover:underline">Renewals</Link> keep the next run clean.</li>
          </ol>
          <p className="mt-3 text-xs text-slate-500">
            Automation: <strong>level {o.automation.level}</strong>{o.automation.level === 0 ? " (detect only)" : o.automation.level === 1 ? " (prepare ready drafts)" : " (prepare, then approve unchanged)"}.
            {o.automation.last ? <> Last run {fmtDateTime(o.automation.last.at, settings)}: {o.automation.last.prepared} prepared, {o.automation.last.approved} created in Xero.</> : " Never run."} <Link href="/settings/billing" className="text-brand-700 hover:underline">Policy</Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
