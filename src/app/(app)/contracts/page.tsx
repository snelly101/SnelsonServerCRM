import Link from "next/link";
import { Plus, Package, BellRing } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { contractTotals, listContracts } from "@/services/contracts";
import { listOwners } from "@/services/companies";
import { listSavedViews } from "@/services/settings";
import { getAppSettings } from "@/lib/settings";
import { PageHeader, Card, EmptyState, Stat } from "@/components/ui/page";
import { ButtonLink } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pagination } from "@/components/ui/pagination";
import { FilterBar } from "@/components/ui/filter-bar";
import { RunRemindersButton } from "./run-reminders";
import { fmtDate, fmtMoney } from "@/lib/format";
import { param, toInt } from "@/lib/utils";
import { FREQUENCY_LABELS } from "@/lib/validation-sales";

export const metadata = { title: "Contracts & Services" };

const STATUS_TONE: Record<string, string> = { draft: "slate", active: "green", expired: "amber", cancelled: "red" };

export default async function ContractsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("contract.read");
  const sp = await searchParams;
  const renew = param(sp, "renewing");
  const [data, owners, views, settings, totals] = await Promise.all([
    listContracts({ q: param(sp, "q"), status: param(sp, "status") ?? "all", ownerUserId: param(sp, "owner"), renewingWithinDays: renew ? Number(renew) : undefined, page: toInt(param(sp, "page"), 1) }),
    listOwners(),
    listSavedViews(me.id, "contracts"),
    getAppSettings(),
    contractTotals(),
  ]);
  const c = settings.currency;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <PageHeader
        title="Contracts & Services"
        description="Managed service agreements, renewals and the service catalogue."
        actions={
          <>
            <ButtonLink href="/contracts/catalogue" variant="secondary">
              <Package className="h-4 w-4" /> Service catalogue
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
        <Stat label="MRR" value={fmtMoney(totals.mrr, c)} hint="Σ recurring lines ÷ months per period" tone="good" />
        <Stat label="ARR" value={fmtMoney(totals.arr, c)} hint="MRR × 12" />
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
      />
      {data.total === 0 ? (
        <EmptyState icon={<BellRing className="h-6 w-6" />} title="No contracts match" description="Contracts are created from won opportunities or manually." />
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Company</th>
                  <th>Status</th>
                  <th className="text-right">MRR</th>
                  <th>Billing</th>
                  <th>Start</th>
                  <th>Renewal</th>
                  <th>Notice by</th>
                  <th>Next review</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/contracts/${r.id}`} className="font-medium text-brand-700 hover:underline">
                        {r.name}
                      </Link>
                      {r.reference && <div className="text-xs text-slate-500">{r.reference}</div>}
                    </td>
                    <td>
                      <Link href={`/companies/${r.companyId}`} className="hover:underline">
                        {r.companyName}
                      </Link>
                    </td>
                    <td>
                      <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                    </td>
                    <td className="text-right tabular-nums">{fmtMoney(r.summary.mrr, c)}</td>
                    <td>{FREQUENCY_LABELS[r.billingFrequency]}</td>
                    <td>{fmtDate(r.startDate, settings)}</td>
                    <td>{fmtDate(r.renewalDate, settings)}</td>
                    <td className={r.noticeDeadline && r.noticeDeadline <= today && r.status === "active" ? "font-medium text-red-600" : ""}>{fmtDate(r.noticeDeadline, settings)}</td>
                    <td className={r.nextReviewDate && r.nextReviewDate < today ? "text-amber-700" : ""}>{fmtDate(r.nextReviewDate, settings)}</td>
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
