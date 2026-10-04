import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { renewalQueue } from "@/services/renewals";
import { listProducts } from "@/services/catalogue";
import { Card, Stat } from "@/components/ui/page";
import { fmtMoney } from "@/lib/format";
import { param } from "@/lib/utils";
import { RenewalTable } from "./table";
import { PriceReviewForm } from "./price-form";

export const metadata = { title: "Renewals & pricing" };

const FILTERS = [
  { key: "open", label: "Needs a decision" },
  { key: "all", label: "All upcoming" },
  { key: "decided", label: "Decided" },
] as const;

export default async function RenewalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("contract.read");
  const sp = await searchParams;
  const view = param(sp, "view") === "pricing" ? "pricing" : "renewals";
  const filter = param(sp, "filter") ?? "open";
  const today = new Date().toISOString().slice(0, 10);
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(param(sp, "asOf") ?? "") ? param(sp, "asOf")! : today;
  const settings = await getAppSettings();
  const c = settings.currency;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link href="/billing/renewals" className={`rounded-md border px-3 py-1 ${view === "renewals" ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-200 bg-surface hover:bg-slate-50"}`}>Renewals</Link>
        <Link href="/billing/renewals?view=pricing" className={`rounded-md border px-3 py-1 ${view === "pricing" ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-200 bg-surface hover:bg-slate-50"}`}>Price review</Link>
      </div>
      {view === "renewals" ? <RenewalsView asOf={asOf} today={today} filter={filter} currency={c} settings={settings} canWrite={can(me.role, "contract.write")} leadDays={settings.renewalLeadDays} /> : <PricingView currency={c} settings={settings} canApply={can(me.role, "contract.write")} />}
    </div>
  );
}

async function RenewalsView({ asOf, today, filter, currency, settings, canWrite, leadDays }: { asOf: string; today: string; filter: string; currency: string; settings: Parameters<typeof RenewalTable>[0]["settings"]; canWrite: boolean; leadDays: number }) {
  const all = await renewalQueue(asOf);
  const rows = filter === "open" ? all.filter((r) => r.status === "overdue" || r.status === "due") : filter === "decided" ? all.filter((r) => r.status === "decided") : all;
  const overdue = all.filter((r) => r.status === "overdue");
  const due = all.filter((r) => r.status === "due");
  const mismatched = all.filter((r) => r.status !== "decided" && r.mismatches.length);
  const exposure = all.filter((r) => r.status !== "decided").reduce((a, r) => a + r.exposureTotal, 0);
  const q = (f: string) => `/billing/renewals?filter=${f}${asOf !== today ? `&asOf=${asOf}` : ""}`;
  return (
    <>
      <p className="text-sm text-slate-600">Every active contract with a renewal date, ordered by when a decision is needed: {leadDays} days before the notice deadline (Settings → General). Each row sets the customer&apos;s renewal against the supplier commitments behind its lines, so a mismatch is visible before the deadline.</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Decision overdue" value={overdue.length} hint={`${fmtMoney(overdue.reduce((a, r) => a + r.mrr, 0), currency)} MRR`} tone={overdue.length ? "danger" : "default"} />
        <Stat label="Decide now" value={due.length} hint={`${fmtMoney(due.reduce((a, r) => a + r.mrr, 0), currency)} MRR`} tone={due.length ? "warn" : "default"} />
        <Stat label="Supplier mismatches" value={mismatched.length} hint="commitments ending after or renewing before the agreement" tone={mismatched.length ? "warn" : "default"} />
        <Stat label="Exposure if not renewed" value={fmtMoney(exposure, currency)} hint="supplier cost beyond undecided renewal dates" />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {FILTERS.map((f) => (
          <Link key={f.key} href={q(f.key)} className={`rounded-md border px-3 py-1 ${filter === f.key ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-200 bg-surface hover:bg-slate-50"}`}>
            {f.label} ({f.key === "open" ? overdue.length + due.length : f.key === "decided" ? all.filter((r) => r.status === "decided").length : all.length})
          </Link>
        ))}
      </div>
      <Card padded={false}>
        <RenewalTable rows={rows} canWrite={canWrite} currency={currency} settings={settings} />
        <p className="px-4 py-2 text-[11px] text-slate-500">Supplier commitments come from the service register through the lines they are charged on. <strong>Prepare amendment</strong> opens the contract with changes dated from the renewal date, so the invoice preview shows their effect before anything is sent.</p>
      </Card>
    </>
  );
}

async function PricingView({ currency, settings, canApply }: { currency: string; settings: Parameters<typeof PriceReviewForm>[0]["settings"]; canApply: boolean }) {
  const products = await listProducts();
  return (
    <>
      <p className="text-sm text-slate-600">Propose a sell price change, or pass a supplier cost change through, and see every affected customer with current and projected margin and the agreement constraints before anything is applied. Applied changes are dated and reasoned in each contract&apos;s history; no price ever changes silently.</p>
      <Card>
        <PriceReviewForm products={products.map((p) => ({ id: p.id, name: p.name, unitPrice: p.unitPrice, unitCost: p.unitCost }))} currency={currency} settings={settings} canApply={canApply} />
      </Card>
    </>
  );
}
