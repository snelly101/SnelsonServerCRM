import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { serviceRegister, SERVICE_STATE_LABELS } from "@/services/service-register";
import { matchableLinesFor } from "@/services/service-links";
import { PROVIDER_LABELS } from "@/lib/billing-model";
import { Card } from "@/components/ui/page";
import { Input, Select } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { param } from "@/lib/utils";
import { RegisterSummaryBar, ServiceRegisterTable } from "@/components/service-register";

export const metadata = { title: "Service coverage" };

export default async function ServiceCoveragePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("contract.read");
  const sp = await searchParams;
  const state = param(sp, "state") ?? "all";
  const companyId = param(sp, "companyId") ?? "";
  const provider = param(sp, "provider") ?? "all";
  const q = param(sp, "q") ?? "";
  const [settings, data] = await Promise.all([getAppSettings(), serviceRegister({ state, companyId: companyId || undefined, provider, q: q || undefined })]);
  const canEdit = can(me.role, "contract.write");
  const companyIds = [...new Set(data.rows.map((r) => r.companyId))];
  const linesByCompany = canEdit ? Object.fromEntries(await matchableLinesFor(companyIds.slice(0, 200), ["draft", "active"])) : {};
  return (
    <>
      <p className="mb-4 text-sm text-slate-600">Every service the integrations say a customer has (Pax8 subscriptions, 20i packages and domains, NinjaOne managed devices): which integration supplies it, the supplier product, the quantity and cost last synced, and how it maps to a charge. Only <strong>unmapped</strong> means possibly missed revenue; everything else is a recorded decision or a rule match.</p>
      <Card className="mb-4">
        <RegisterSummaryBar summary={data.summary} />
        <form method="get" className="mt-3 flex flex-wrap items-end gap-2">
          <Select name="state" defaultValue={state} aria-label="Coverage state" className="w-48">
            <option value="all">All states</option>
            <option value="unmapped">Unmapped</option>
            <option value="investigate">Needs investigation</option>
            <option value="review">Review overdue</option>
            {(["charged", "bundle", "commitment", "free", "internal"] as const).map((s) => (
              <option key={s} value={s}>
                {SERVICE_STATE_LABELS[s]}
              </option>
            ))}
          </Select>
          <Select name="provider" defaultValue={provider} aria-label="Integration" className="w-40">
            <option value="all">All integrations</option>
            {(Object.keys(PROVIDER_LABELS) as (keyof typeof PROVIDER_LABELS)[]).map((k) => (
              <option key={k} value={k}>
                {PROVIDER_LABELS[k]}
              </option>
            ))}
          </Select>
          <Select name="companyId" defaultValue={companyId} aria-label="Company" className="w-56">
            <option value="">All customers</option>
            {data.customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Input name="q" defaultValue={q} placeholder="Search service or company" className="w-56" />
          <Button type="submit" size="sm" variant="secondary">
            Filter
          </Button>
          {(state !== "all" || provider !== "all" || companyId || q) && (
            <Link href="/billing/services" className="text-xs text-brand-700 hover:underline">
              clear
            </Link>
          )}
        </form>
      </Card>
      <Card title={`${data.rows.length}${data.truncated ? "+" : ""} service${data.rows.length === 1 ? "" : "s"}`} padded={false}>
        <ServiceRegisterTable rows={data.rows} linesByCompany={linesByCompany} canEdit={canEdit} settings={settings} showCompany />
        <p className="px-4 py-2 text-[11px] text-slate-500">
          <strong>Charged</strong> comes from the billing line chosen on the Subscriptions or Hosting tab (or a Pax8 SKU / name match). <strong>Included in a bundle</strong> counts the licences toward the bundle line in the licence check. <strong>Free</strong> needs a review date and shows here when it passes. Devices marked internal or free are left out of the device count check. Nothing here changes a contract or an invoice.
        </p>
      </Card>
    </>
  );
}
