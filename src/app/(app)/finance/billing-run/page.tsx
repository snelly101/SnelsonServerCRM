import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { billingWorkspace } from "@/services/billing-workspace";
import { PageHeader, Card } from "@/components/ui/page";
import { Input } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { fmtMoney } from "@/lib/format";
import { param } from "@/lib/utils";
import { BillingRunForm } from "./form";

export const metadata = { title: "Billing run" };

export default async function BillingRunPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission("invoice.prepare");
  const sp = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const raw = param(sp, "asOf");
  const asOf = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : today;
  const settings = await getAppSettings();
  const { rows, summary } = await billingWorkspace(asOf, settings.currency);
  const c = settings.currency;
  const month = new Date(asOf + "T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Finance", href: "/finance" }, { label: "Billing run" }]}
        title="Billing run"
        description="One draft invoice per active contract for every line period that is due and not yet invoiced, billed in advance. Each row shows what changed against the previous invoice and why, so the clear ones go through together and the exceptions get a look."
      />
      <Card className="mb-4">
        <p className="text-sm text-slate-800">
          <strong>{month} billing:</strong> {summary.ready} ready, {summary.review} need review, {summary.blocked} blocked{summary.nothing ? `, ${summary.nothing} with nothing due` : ""}. <strong>{fmtMoney(summary.expected, c)}</strong> expected billing
          {summary.unmappedServices ? (
            <>
              , <Link href="/finance/services?state=unmapped" className="text-amber-700 underline">{fmtMoney(summary.potentialMissed, c)}/month potential missed revenue</Link> across {summary.unmappedServices} unmapped service{summary.unmappedServices === 1 ? "" : "s"}
            </>
          ) : null}
          {summary.renewalsThisWeek || summary.noticeDeadlinesThisWeek ? (
            <>
              , <Link href="/contracts?renewing=30&status=active" className="text-brand-700 underline">{summary.renewalsThisWeek} renewal{summary.renewalsThisWeek === 1 ? "" : "s"} and {summary.noticeDeadlinesThisWeek} notice deadline{summary.noticeDeadlinesThisWeek === 1 ? "" : "s"} this week</Link>
            </>
          ) : null}
          .
        </p>
        <p className="mt-1 text-xs text-slate-500">Potential missed revenue is partner cost of services nobody has mapped; it is not confirmed billable. Expected billing is net of tax. Figures are for the run date.</p>
      </Card>
      <Card
        title={`Contracts due on ${asOf}`}
        actions={
          <form method="get" className="flex items-center gap-2">
            <label htmlFor="asOf" className="text-xs text-slate-500">
              Run date
            </label>
            <Input id="asOf" name="asOf" type="date" defaultValue={asOf} className="w-40" />
            <Button type="submit" size="sm" variant="secondary">
              Recalculate
            </Button>
          </form>
        }
      >
        <BillingRunForm key={asOf} asOf={asOf} rows={rows} currency={c} settings={settings} />
      </Card>
      <p className="mt-3 text-xs text-slate-500">
        <strong>Ready</strong>: same lines as last time, Xero linked, nothing open for the customer. <strong>Review</strong>: the amount changed, a discrepancy or unmapped service is open, data is stale, or missed periods are included; open the reasons before ticking. <strong>Blocked</strong>: the draft could be prepared but not approved (no Xero link). A line period that already has a draft is never proposed again, so running twice is safe. Quantities come from the contract lines and their dated change history.
      </p>
    </>
  );
}
