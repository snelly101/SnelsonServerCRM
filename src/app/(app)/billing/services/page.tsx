import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { serviceRegister } from "@/services/service-register";
import { matchableLinesFor } from "@/services/service-links";
import { contractOptionsFor } from "@/services/contracts";
import { productOptions } from "@/services/lookups";
import { PROVIDER_LABELS } from "@/lib/billing-model";
import { Card } from "@/components/ui/page";
import { Input, Select } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { param } from "@/lib/utils";
import { RegisterSummaryBar, ServiceRegisterTable } from "@/components/service-register";

export const metadata = { title: "Services to match" };

/**
 * Billing → Services: every service the integrations supply, across every
 * customer, opening on the ones nobody has matched to a charge yet. Each
 * row is matched in place: one click on the suggested line, or the dialog
 * to pick a line, create the line it should be charged on, or record that
 * it is not charged separately.
 */
export default async function ServiceCoveragePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("contract.read");
  const sp = await searchParams;
  const state = param(sp, "state") ?? "decide";
  const companyId = param(sp, "companyId") ?? "";
  const provider = param(sp, "provider") ?? "all";
  const q = param(sp, "q") ?? "";
  const [settings, data] = await Promise.all([getAppSettings(), serviceRegister({ state, companyId: companyId || undefined, provider, q: q || undefined })]);
  const canEdit = can(me.role, "contract.write");
  const companyIds = [...new Set(data.rows.map((r) => r.companyId))].slice(0, 200);
  const [lines, contracts, products]: [Awaited<ReturnType<typeof matchableLinesFor>>, Awaited<ReturnType<typeof contractOptionsFor>>, Awaited<ReturnType<typeof productOptions>>] = canEdit ? await Promise.all([matchableLinesFor(companyIds, ["draft", "active"]), contractOptionsFor(companyIds), productOptions()]) : [new Map(), new Map(), []];
  const linesByCompany = Object.fromEntries([...lines].map(([k, v]) => [k, v.map((l) => ({ id: l.id, description: l.description, contractId: l.contractId, contractName: l.contractName, contractStatus: l.contractStatus, productSku: l.productSku, productName: l.productName }))]));
  const contractsByCompany = Object.fromEntries(contracts);
  const baseQuery = new URLSearchParams();
  if (provider !== "all") baseQuery.set("provider", provider);
  if (companyId) baseQuery.set("companyId", companyId);
  if (q) baseQuery.set("q", q);
  const toDecide = data.summary.unmapped + data.summary.investigate + data.summary.reviewOverdue;
  return (
    <>
      <p className="mb-4 text-sm text-slate-600">
        Every service the integrations say a customer has (Pax8 subscriptions, 20i packages and domains, NinjaOne managed devices), across every customer, and how each one is charged. <strong>To decide</strong> lists the ones nobody has matched yet: charge each on the line that bills it, create that line if the agreement does not have one, or record that it is bundled, covered, free or internal.
      </p>
      <Card className="mb-4">
        <RegisterSummaryBar summary={data.summary} current={state} baseQuery={baseQuery.toString()} />
        <form method="get" className="mt-3 flex flex-wrap items-end gap-2">
          {state !== "decide" && <input type="hidden" name="state" value={state} />}
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
          {(state !== "decide" || provider !== "all" || companyId || q) && (
            <Link href="/billing/services" className="text-xs link">
              clear
            </Link>
          )}
        </form>
      </Card>
      <Card title={state === "decide" ? `${data.rows.length}${data.truncated ? "+" : ""} to decide` : `${data.rows.length}${data.truncated ? "+" : ""} service${data.rows.length === 1 ? "" : "s"}`} padded={false} actions={state === "decide" && toDecide === 0 ? <span className="text-xs text-green-700">Everything the integrations supply is accounted for.</span> : undefined}>
        <ServiceRegisterTable rows={data.rows} linesByCompany={linesByCompany} canEdit={canEdit} settings={settings} showCompany={!companyId} matching={canEdit ? { contractsByCompany, products, currency: settings.currency } : undefined} />
        <p className="px-4 py-2 text-[11px] text-slate-500">
          <strong>Charged</strong> means a contract line bills the service (chosen here, or matched by catalogue SKU or name at sync time). The ✦ button charges it on the suggested line in one click; <strong>Match</strong> opens the full choice, including creating the line on an agreement or on a new draft agreement. <strong>Included in a bundle</strong> counts the licences toward the bundle line in the licence check. <strong>Free</strong> needs a review date and shows here again when it passes. Devices marked internal or free are left out of the device count check.
        </p>
      </Card>
    </>
  );
}
