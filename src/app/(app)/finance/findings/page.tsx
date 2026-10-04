import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { billingFindings, FINDING_KINDS, type FindingKind } from "@/services/billing-findings";
import { PageHeader, Card } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { fmtMoney } from "@/lib/format";
import { param } from "@/lib/utils";

export const metadata = { title: "Billing findings" };

const TONE: Record<string, string> = { red: "red", amber: "amber", slate: "slate" };

export default async function BillingFindingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission("finance.read");
  const sp = await searchParams;
  const kind = param(sp, "kind") ?? "all";
  const [settings, data] = await Promise.all([getAppSettings(), billingFindings()]);
  const rows = kind === "all" ? data.findings : data.findings.filter((f) => f.kind === kind);
  const meta = FINDING_KINDS.find((k) => k.kind === kind);
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Finance", href: "/finance" }, { label: "Findings" }]}
        title="Billing findings"
        description={`What needs a decision today, read across the service register, the billing run, the drafts, Xero and the Pax8 reconciliation. ${data.actionable} actionable, ${data.total - data.actionable} informational. Each row links to where it is resolved; nothing here changes data.`}
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {FINDING_KINDS.map((k) => (
          <Link key={k.kind} href={kind === k.kind ? "/finance/findings" : `/finance/findings?kind=${k.kind}`} className={`rounded-md border px-3 py-2 text-sm hover:bg-slate-50 ${kind === k.kind ? "border-brand-500 bg-brand-50" : "border-slate-200 bg-surface"}`} title={k.interpretation}>
            <div className="text-xl font-semibold tabular-nums">{data.counts[k.kind as FindingKind]}</div>
            <div className="text-xs text-slate-600">{k.label}</div>
          </Link>
        ))}
      </div>
      <Card title={meta ? meta.label : `All findings (${rows.length})`} padded={false} actions={kind !== "all" ? <Link href="/finance/findings" className="text-xs text-brand-700 hover:underline">show all</Link> : undefined}>
        {meta && <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-600">{meta.interpretation}</p>}
        {rows.length === 0 ? (
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
              {rows.map((f, i) => (
                <tr key={i}>
                  <td>
                    <Badge tone={TONE[f.severity]}>{FINDING_KINDS.find((k) => k.kind === f.kind)?.label ?? f.kind}</Badge>
                  </td>
                  <td>
                    {f.companyId ? (
                      <Link href={`/companies/${f.companyId}`} className="hover:underline">
                        {f.companyName}
                      </Link>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td>
                    <div className="text-sm">{f.title}</div>
                    {f.detail && <div className="text-xs text-slate-500">{f.detail}</div>}
                  </td>
                  <td className="text-right tabular-nums">{f.amount === null ? "—" : fmtMoney(f.amount, f.currency ?? settings.currency)}</td>
                  <td className="text-right">
                    <Link href={f.href} className="text-xs text-brand-700 hover:underline">
                      Resolve
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="mt-3 text-xs text-slate-500">
        Red needs attention before the next billing run; amber is a decision to record; grey is information. <strong>Potential</strong> missed revenue (unmapped services) is listed separately from <strong>confirmed</strong> gaps (expected charges not drafted, covered services that cannot charge). Accepting a licence or device discrepancy keeps it out of here; the register&apos;s free arrangements come back when their review date passes.
      </p>
    </>
  );
}
