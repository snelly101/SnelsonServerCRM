import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { renewalQueue } from "@/services/renewals";
import { PageHeader, Card, Stat } from "@/components/ui/page";
import { fmtMoney } from "@/lib/format";
import { param } from "@/lib/utils";
import { RenewalTable } from "./table";

export const metadata = { title: "Renewals" };

const VIEWS = [
  { key: "open", label: "Needs a decision" },
  { key: "all", label: "All upcoming" },
  { key: "decided", label: "Decided" },
] as const;

export default async function RenewalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("contract.read");
  const sp = await searchParams;
  const view = param(sp, "view") ?? "open";
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(param(sp, "asOf") ?? "") ? param(sp, "asOf")! : new Date().toISOString().slice(0, 10);
  const [settings, all] = await Promise.all([getAppSettings(), renewalQueue(asOf)]);
  const c = settings.currency;
  const rows = view === "open" ? all.filter((r) => r.status === "overdue" || r.status === "due") : view === "decided" ? all.filter((r) => r.status === "decided") : all;
  const overdue = all.filter((r) => r.status === "overdue");
  const due = all.filter((r) => r.status === "due");
  const mismatched = all.filter((r) => r.status !== "decided" && r.mismatches.length);
  const exposure = all.filter((r) => r.status !== "decided").reduce((a, r) => a + r.exposureTotal, 0);
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Contracts", href: "/contracts" }, { label: "Renewals" }]}
        title="Renewals"
        description={`Every active contract with a renewal date, ordered by when a decision is needed: ${settings.renewalLeadDays} days before the notice deadline (Settings → General). Each row sets the customer's renewal against the supplier commitments behind its lines, so a mismatch is visible before the deadline, not after.`}
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Decision overdue" value={overdue.length} hint={`${fmtMoney(overdue.reduce((a, r) => a + r.mrr, 0), c)} MRR`} tone={overdue.length ? "danger" : "default"} />
        <Stat label="Decide now" value={due.length} hint={`${fmtMoney(due.reduce((a, r) => a + r.mrr, 0), c)} MRR`} tone={due.length ? "warn" : "default"} />
        <Stat label="Supplier mismatches" value={mismatched.length} hint="commitments ending after or renewing before the agreement" tone={mismatched.length ? "warn" : "default"} />
        <Stat label="Exposure if not renewed" value={fmtMoney(exposure, c)} hint="supplier cost beyond undecided renewal dates" />
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {VIEWS.map((v) => (
          <Link key={v.key} href={`/contracts/renewals?view=${v.key}${asOf !== new Date().toISOString().slice(0, 10) ? `&asOf=${asOf}` : ""}`} className={`rounded-md border px-3 py-1 ${view === v.key ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-200 bg-surface hover:bg-slate-50"}`}>
            {v.label} ({v.key === "open" ? overdue.length + due.length : v.key === "decided" ? all.filter((r) => r.status === "decided").length : all.length})
          </Link>
        ))}
      </div>
      <Card padded={false}>
        <RenewalTable rows={rows} canWrite={can(me.role, "contract.write")} currency={c} settings={settings} />
        <p className="px-4 py-2 text-[11px] text-slate-500">
          Supplier commitments come from the service register (Pax8 commitment end dates, 20i domain expiries) through the lines they are charged on. Exposure counts whole months of supplier cost beyond the renewal date where the cost is known. <strong>Prepare amendment</strong> opens the contract with changes dated from the renewal date, so the invoice preview shows their effect before anything is sent.
        </p>
      </Card>
    </>
  );
}
