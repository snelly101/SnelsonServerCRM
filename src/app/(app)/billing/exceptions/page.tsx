import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { billingFindings, FINDING_KINDS, type FindingKind } from "@/services/billing-findings";
import { listDiscrepancies } from "@/services/ninjaone";
import { Card } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { DiscrepancyTable } from "@/app/(app)/devices/discrepancies";
import { fmtMoney } from "@/lib/format";
import { param } from "@/lib/utils";

export const metadata = { title: "Billing exceptions" };

const TONE: Record<string, string> = { red: "red", amber: "amber", slate: "slate" };
const VIEWS = [
  { key: "all", label: "Everything open" },
  { key: "findings", label: "Findings" },
  { key: "counts", label: "Count discrepancies" },
  { key: "accepted", label: "Accepted exceptions" },
] as const;

/** Every reason the next run would not be clean, in one place, each with the way to resolve it. */
export default async function ExceptionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("finance.read");
  const sp = await searchParams;
  const view = (VIEWS.some((v) => v.key === param(sp, "view")) ? param(sp, "view") : "all") as (typeof VIEWS)[number]["key"];
  const kind = param(sp, "kind") ?? "all";
  const [settings, data, openDisc, acceptedDisc] = await Promise.all([getAppSettings(), billingFindings(), listDiscrepancies({ status: "open" }), listDiscrepancies({ status: "accepted" })]);
  const canReview = can(me.role, "discrepancy.review");
  const findings = kind === "all" ? data.findings : data.findings.filter((f) => f.kind === kind);
  const meta = FINDING_KINDS.find((k) => k.kind === kind);
  const showFindings = view === "all" || view === "findings";
  const showCounts = view === "all" || view === "counts";
  const licence = openDisc.filter((d) => d.source !== "ninjaone");
  const device = openDisc.filter((d) => d.source === "ninjaone");
  const href = (v: string) => `/billing/exceptions?view=${v}`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {VIEWS.map((v) => {
          const n = v.key === "findings" ? data.actionable : v.key === "counts" ? openDisc.length : v.key === "accepted" ? acceptedDisc.length : data.actionable + openDisc.length;
          return (
            <Link key={v.key} href={href(v.key)} className={`rounded-md border px-3 py-1 ${view === v.key ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-200 bg-surface hover:bg-slate-50"}`}>
              {v.label} ({n})
            </Link>
          );
        })}
      </div>

      {showFindings && (
        <>
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {FINDING_KINDS.map((k) => (
              <Link key={k.kind} href={kind === k.kind ? href("findings") : `${href("findings")}&kind=${k.kind}`} className={`rounded-md border px-3 py-2 text-sm hover:bg-slate-50 ${kind === k.kind ? "border-brand-500 bg-brand-50" : "border-slate-200 bg-surface"}`} title={k.interpretation}>
                <div className="text-xl font-semibold tabular-nums">{data.counts[k.kind as FindingKind]}</div>
                <div className="text-xs text-slate-600">{k.label}</div>
              </Link>
            ))}
          </div>
          <Card title={meta ? meta.label : `Findings (${findings.length})`} padded={false} actions={kind !== "all" ? <Link href={href("findings")} className="text-xs text-brand-700 hover:underline">show all</Link> : undefined}>
            {meta && <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-600">{meta.interpretation}</p>}
            {findings.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">Nothing to decide here.</p>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Finding</th>
                    <th>Company</th>
                    <th>What</th>
                    <th className="text-right">Amount</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {findings.map((f, i) => (
                    <tr key={i}>
                      <td><Badge tone={TONE[f.severity]}>{FINDING_KINDS.find((k) => k.kind === f.kind)?.label ?? f.kind}</Badge></td>
                      <td>{f.companyId ? <Link href={`/companies/${f.companyId}`} className="hover:underline">{f.companyName}</Link> : <span className="text-slate-400">—</span>}</td>
                      <td>
                        <div className="text-sm">{f.title}</div>
                        {f.detail && <div className="text-xs text-slate-500">{f.detail}</div>}
                      </td>
                      <td className="text-right tabular-nums">{f.amount === null ? "—" : fmtMoney(f.amount, f.currency ?? settings.currency)}</td>
                      <td className="text-right"><Link href={f.href} className="text-xs text-brand-700 hover:underline">Resolve</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="px-4 py-2 text-[11px] text-slate-500">Red needs attention before the next run; amber is a decision to record; grey is information. Potential missed revenue (unmapped services) is kept apart from confirmed gaps.</p>
          </Card>
        </>
      )}

      {showCounts && (
        <>
          <Card title={`Licence and hosting count discrepancies (${licence.length})`} padded={false}>
            <DiscrepancyTable rows={licence} canReview={canReview} currency={settings.currency} kind="licence" />
          </Card>
          <Card title={`Device count discrepancies (${device.length})`} padded={false}>
            <DiscrepancyTable rows={device} canReview={canReview} currency={settings.currency} kind="device" />
            <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-500">Contracted vs observed at Pax8, 20i and NinjaOne. <strong>Resolve</strong> offers amend the line, reduce at renewal, include in a bundle, accept as an exception with an owner and review date, or dismiss, each with the money consequence first. Re-checked on every sync.</p>
          </Card>
        </>
      )}

      {view === "accepted" && (
        <Card title={`Accepted exceptions (${acceptedDisc.length})`} padded={false}>
          <DiscrepancyTable rows={acceptedDisc} canReview={canReview} currency={settings.currency} />
          <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-500">Accepted for now with an owner and a review date; each re-opens by itself when the date passes or the gap grows.</p>
        </Card>
      )}
    </div>
  );
}
