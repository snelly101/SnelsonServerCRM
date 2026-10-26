import Link from "next/link";
import { Plus, Package, BellRing, CalendarClock, Link2 } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { contractTotals, listContracts } from "@/services/contracts";
import { listOwners } from "@/services/companies";
import { listSavedViews } from "@/services/settings";
import { getAppSettings } from "@/lib/settings";
import { PageHeader, Card, EmptyState, Stat } from "@/components/ui/page";
import { ButtonLink } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { FilterBar } from "@/components/ui/filter-bar";
import { RunRemindersButton } from "./run-reminders";
import { ContractTable } from "./table";
import { billedPerYear, fmtMoney } from "@/lib/format";
import { param, toInt } from "@/lib/utils";

export const metadata = { title: "Contracts & Services" };

export default async function ContractsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("contract.read");
  const sp = await searchParams;
  const renew = param(sp, "renewing");
  const archived = param(sp, "archived") === "1";
  const [data, owners, views, settings, totals] = await Promise.all([
    listContracts({ q: param(sp, "q"), status: param(sp, "status") ?? "all", ownerUserId: param(sp, "owner"), renewingWithinDays: renew ? Number(renew) : undefined, archived, page: toInt(param(sp, "page"), 1) }),
    listOwners(),
    listSavedViews(me.id, "contracts"),
    getAppSettings(),
    contractTotals(),
  ]);
  const c = settings.currency;
  return (
    <>
      <PageHeader
        title="Contracts & Services"
        description="Managed service agreements, renewals and the service catalogue."
        actions={
          <>
            <ButtonLink href="/billing/renewals" variant="secondary">
              <CalendarClock className="h-4 w-4" /> Renewals & pricing
            </ButtonLink>
            <ButtonLink href="/contracts/catalogue" variant="secondary">
              <Package className="h-4 w-4" /> Service catalogue
            </ButtonLink>
            <ButtonLink href="/billing/services" variant="secondary" title="Services the integrations supply that are not yet charged on a contract line">
              <Link2 className="h-4 w-4" /> Match services
            </ButtonLink>
            {can(me.role, "contract.write") && <RunRemindersButton />}
            {can(me.role, "contract.write") && (
              <ButtonLink href="/contracts/new">
                <Plus className="h-4 w-4" /> New contract
              </ButtonLink>
            )}
          </>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Active contracts" value={totals.active} />
        <Stat label="Billed monthly" value={fmtMoney(totals.monthlyBilled, c)} hint={totals.quarterlyBilled > 0 ? `+ ${fmtMoney(totals.quarterlyBilled, c)} quarterly` : "monthly lines on active contracts"} tone="good" />
        <Stat label="Billed annually" value={fmtMoney(totals.annualBilled, c)} hint={`annual lines at their yearly price · ${fmtMoney(billedPerYear(totals), c)} over a year of invoices`} />
        <Stat label="One-off in active contracts" value={fmtMoney(totals.oneOff + totals.hardware, c)} hint="project + hardware, reported separately" />
      </div>
      <FilterBar
        page="contracts"
        currentUserId={me.id}
        savedViews={views}
        placeholder="Search contract, reference or company…"
        filters={[
          { key: "status", label: "Status", options: ["draft", "active", "expired", "cancelled"].map((s) => ({ value: s, label: s })) },
          { key: "owner", label: "Owner", options: owners.map((o) => ({ value: o.id, label: o.name })) },
          { key: "renewing", label: "Renewing", options: [{ value: "30", label: "within 30 days" }, { value: "60", label: "within 60 days" }, { value: "90", label: "within 90 days" }, { value: "180", label: "within 6 months" }] },
        ]}
        trailing={
          <Link href={archived ? "/contracts" : "/contracts?archived=1"} className="link">
            {archived ? "Back to current contracts" : "Show archived"}
          </Link>
        }
      />
      {archived && (
        <p className="mb-3 text-sm text-slate-600">
          Showing <span className="font-medium text-slate-900">archived</span> contracts. They are excluded from MRR and billing; open one to restore it.
        </p>
      )}
      {data.total === 0 ? (
        <EmptyState icon={<BellRing className="h-6 w-6" />} title={archived ? "No archived contracts" : "No contracts match"} description={archived ? "Archived contracts appear here and can be restored from their page." : "Contracts are created from won opportunities or manually."} />
      ) : (
        <Card padded={false}>
          <ContractTable
            rows={data.rows.map((r) => ({ id: r.id, name: r.name, reference: r.reference, status: r.status, companyId: r.companyId, companyName: r.companyName, billed: { monthlyBilled: r.summary.monthlyBilled, quarterlyBilled: r.summary.quarterlyBilled, annualBilled: r.summary.annualBilled }, billingFrequency: r.billingFrequency, startDate: r.startDate, renewalDate: r.renewalDate, noticeDeadline: r.noticeDeadline, nextReviewDate: r.nextReviewDate }))}
            canWrite={can(me.role, "contract.write")}
            settings={{ currency: settings.currency, dateFormat: settings.dateFormat, timezone: settings.timezone }}
            owners={owners}
            archived={archived}
          />
          <Pagination page={data.page} pageCount={data.pageCount} total={data.total} pageSize={data.pageSize} />
        </Card>
      )}
    </>
  );
}
