import Link from "next/link";
import { CheckCircle2, XCircle, AlertTriangle, PlugZap, Clock } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { integrationHealth, listOpenConflicts, listSyncRuns, PROVIDER_LABELS, type Provider } from "@/services/integrations";
import { bpConnectionSummary, proposalCounts } from "@/services/proposals";
import { xeroConnectionSummary } from "@/services/xero";
import { XeroSyncButton, XeroTestButton } from "./xero/controls";
import { NinjaSyncButton, NinjaTestButton } from "./ninjaone/controls";
import { ninjaConnectionSummary } from "@/services/ninjaone";
import { PageHeader, Card, EmptyState, Stat } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { resolveConflictAction } from "@/actions/integrations";
import { SyncNowButton, TestButton } from "./controls";

export const metadata = { title: "Integrations" };

const STATUS_TONE: Record<string, string> = { connected: "green", error: "red", expired: "amber", not_configured: "slate" };

export default async function IntegrationsPage() {
  const me = await requirePermission("integration.read");
  const [health, runs, conflicts, bp, counts, settings, xero, ninja] = await Promise.all([integrationHealth(), listSyncRuns(undefined, 15), listOpenConflicts(), bpConnectionSummary(), proposalCounts(), getAppSettings(), xeroConnectionSummary(), ninjaConnectionSummary()]);
  const canManage = can(me.role, "integration.manage");
  const canSync = can(me.role, "integration.sync");
  const demo = process.env.DEMO_MODE === "true";

  return (
    <>
      <PageHeader title="Integrations" description="Connection status, mapping, manual sync, history and unresolved conflicts." />
      {demo && (
        <Alert tone="warn" title="Demo mode is on" className="mb-4">
          Providers without credentials use synthetic data and are shown as <strong>Demo (not connected)</strong>. Nothing marked demo is live or verified.
        </Alert>
      )}
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        {health.connections.map((c) => {
          const provider = c.provider as Provider;
          const isDemo = provider === "betterproposals" ? bp.demo : provider === "xero" ? xero.demo : ninja.demo;
          const label = isDemo ? "Demo (not connected)" : c.status.replace("_", " ");
          return (
            <Card
              key={c.provider}
              title={
                <span className="flex items-center gap-2">
                  {c.status === "connected" && !isDemo ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : c.status === "error" || c.status === "expired" ? <XCircle className="h-4 w-4 text-red-600" /> : <PlugZap className="h-4 w-4 text-slate-400" />}
                  {PROVIDER_LABELS[provider]}
                </span>
              }
              actions={<Badge tone={isDemo ? "amber" : STATUS_TONE[c.status]}>{label}</Badge>}
            >
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Account</dt>
                  <dd className="truncate text-right">{isDemo ? "—" : (c.externalAccountName ?? "—")}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Last successful sync</dt>
                  <dd title={c.lastSuccessfulSyncAt ? fmtDateTime(c.lastSuccessfulSyncAt, settings) : ""}>{c.lastSuccessfulSyncAt ? fmtRelative(c.lastSuccessfulSyncAt) : "never"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Last tested</dt>
                  <dd>{c.lastTestedAt ? fmtRelative(c.lastTestedAt) : "never"}</dd>
                </div>
                {c.pausedUntil && c.pausedUntil > new Date() && (
                  <div className="flex justify-between gap-2 text-amber-700">
                    <dt>Scheduled syncs paused</dt>
                    <dd>until {fmtDateTime(c.pausedUntil, settings)}</dd>
                  </div>
                )}
              </dl>
              {c.lastError && (
                <p className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700" role="alert">
                  {c.lastError}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href={`/integrations/${provider}`} className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium hover:bg-slate-50">
                  {canManage ? "Configure" : "Details"}
                </Link>
                {provider === "xero" ? (
                  <>
                    {canManage && xero.configured && <XeroTestButton />}
                    {canSync && xero.configured && <XeroSyncButton />}
                  </>
                ) : provider === "ninjaone" ? (
                  <>
                    {canManage && ninja.configured && <NinjaTestButton />}
                    {canSync && ninja.configured && <NinjaSyncButton />}
                  </>
                ) : (
                  <>
                    {canManage && <TestButton provider={provider} />}
                    {canSync && bp.configured && <SyncNowButton provider={provider} />}
                  </>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Proposals mirrored" value={counts.total} hint={bp.demo ? "demo data" : undefined} />
        <Stat label="Awaiting signature" value={counts.sent} />
        <Stat label="Signed / paid" value={counts.signed} tone="good" />
        <Stat label="Unlinked proposals" value={counts.unlinked} tone={counts.unlinked ? "warn" : "default"} hint={counts.unlinked ? "link them on the Proposals page" : undefined} />
      </div>

      {conflicts.length > 0 && (
        <Card title={`Needs review (${conflicts.length})`} padded={false} className="mb-4">
          <ul className="divide-y divide-slate-100">
            {conflicts.map((c) => (
              <li key={c.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="min-w-0 flex-1">
                  <div className="text-slate-800">{c.message}</div>
                  <div className="text-xs text-slate-500">
                    {PROVIDER_LABELS[c.provider as Provider]} · {c.kind.replace("_", " ")} · {fmtRelative(c.createdAt)}
                  </div>
                </div>
                {canManage && (
                  <span className="flex shrink-0 gap-1">
                    <ConfirmButton variant="ghost" size="sm" action={resolveConflictAction.bind(null, c.id, "resolved")} title="Mark as resolved?" confirmLabel="Resolved">
                      Resolved
                    </ConfirmButton>
                    <ConfirmButton variant="ghost" size="sm" action={resolveConflictAction.bind(null, c.id, "dismissed")} title="Dismiss this conflict?" confirmLabel="Dismiss">
                      Dismiss
                    </ConfirmButton>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Sync history" padded={false}>
        {runs.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={<Clock className="h-6 w-6" />} title="No syncs yet" description="Runs appear here with counts and any errors." />
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Started</th>
                <th>Provider</th>
                <th>Job</th>
                <th>Trigger</th>
                <th>Result</th>
                <th className="text-right">Fetched</th>
                <th className="text-right">New</th>
                <th className="text-right">Updated</th>
                <th className="text-right">Errors</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap text-slate-500">{fmtDateTime(r.startedAt, settings)}</td>
                  <td>{PROVIDER_LABELS[r.provider as Provider]}</td>
                  <td>
                    <code className="text-xs">{r.kind}</code>
                  </td>
                  <td className="text-slate-600">
                    {r.trigger}
                    {r.triggeredBy && <span className="text-xs"> · {r.triggeredBy}</span>}
                  </td>
                  <td>
                    <Badge tone={r.status === "success" ? "green" : r.status === "partial" ? "amber" : r.status === "running" ? "blue" : "red"}>{r.status}</Badge>
                  </td>
                  <td className="text-right tabular-nums">{r.fetched}</td>
                  <td className="text-right tabular-nums">{r.created}</td>
                  <td className="text-right tabular-nums">{r.updated}</td>
                  <td className="text-right tabular-nums">
                    {r.errorCount > 0 ? (
                      <Link href={`/integrations/runs/${r.id}`} className="text-red-700 hover:underline">
                        {r.errorCount}
                      </Link>
                    ) : (
                      0
                    )}
                  </td>
                  <td className="max-w-md truncate text-xs text-slate-600" title={r.message ?? ""}>
                    {r.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
