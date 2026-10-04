import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { previewBillingRun } from "@/services/billing-run";
import { PageHeader, Card } from "@/components/ui/page";
import { Input } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { param } from "@/lib/utils";
import { BillingRunForm } from "./form";

export const metadata = { title: "Billing run" };

export default async function BillingRunPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission("invoice.prepare");
  const sp = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const raw = param(sp, "asOf");
  const asOf = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : today;
  const [rows, settings] = await Promise.all([previewBillingRun(asOf), getAppSettings()]);
  const ready = rows.filter((r) => !r.skipReason).length;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Finance", href: "/finance" }, { label: "Billing run" }]}
        title="Billing run"
        description="Prepares one draft invoice per active contract carrying every line period that is due and not yet invoiced: the current period of each recurring service (on the contract's cycle, or the service's own cycle), plus earlier periods a contract's billing-from date says were missed. Billed in advance. Drafts are reviewed and approved one by one; approval creates them in Xero as drafts, where they are sent."
      />
      <Card title={`Contracts due on ${asOf} · ${ready} ready of ${rows.length}`} actions={
        <form method="get" className="flex items-center gap-2">
          <label htmlFor="asOf" className="text-xs text-slate-500">
            Run date
          </label>
          <Input id="asOf" name="asOf" type="date" defaultValue={asOf} className="w-40" />
          <Button type="submit" size="sm" variant="secondary">
            Recalculate
          </Button>
        </form>
      }>
        <BillingRunForm key={asOf} asOf={asOf} rows={rows} currency={settings.currency} settings={settings} />
      </Card>
      <p className="mt-3 text-xs text-slate-500">
        A line period that already has a draft (in any state but cancelled) is never proposed again, so running twice is safe. Earlier periods are proposed only when the contract has a <em>Bill from</em> date and are marked <em>missed</em>; otherwise they stay a manual <em>Prepare invoice</em> on the contract. Quantities come from the contract lines and their dated change history; check open device and licence discrepancies before approving.
      </p>
    </>
  );
}
