import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { deviceTotals, ninjaConnectionSummary, ninjaMappingOverview } from "@/services/ninjaone";
import { listSyncRuns, recentUnresolvedErrors } from "@/services/integrations";
import { PageHeader, Card, DescriptionList, Stat } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { disconnectAction } from "@/actions/integrations";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { ImportAllOrganizationsButton, NinjaConfigForm, NinjaConnectForm, NinjaSyncButton, NinjaTestButton, OrgMappingTable } from "./controls";

export const metadata = { title: "NinjaOne" };

export default async function NinjaOnePage() {
  const me = await requirePermission("integration.read");
  const canManage = can(me.role, "integration.manage");
  const [conn, settings, runs, errors, mapping, totals] = await Promise.all([ninjaConnectionSummary(), getAppSettings(), listSyncRuns("ninjaone", 10), recentUnresolvedErrors("ninjaone"), ninjaMappingOverview(), deviceTotals()]);
  const live = conn.mode === "live";

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Integrations", href: "/integrations" }, { label: "NinjaOne" }]}
        title={
          <span className="flex items-center gap-2">
            NinjaOne <Badge tone={conn.demo ? "amber" : conn.status === "connected" ? "green" : conn.status === "not_configured" ? "slate" : "red"}>{conn.demo ? "Demo (not connected)" : conn.status.replace("_", " ")}</Badge>
          </span>
        }
        description="Read-only. Organisations, locations and devices are mirrored hourly and compared with per-device contract lines. The CRM never changes anything in NinjaOne."
        actions={
          <>
            {canManage && conn.configured && <NinjaTestButton />}
            {conn.configured && can(me.role, "integration.sync") && <NinjaSyncButton />}
          </>
        }
      />
      {conn.demo && (
        <Alert tone="warn" title="Demo adapter in use" className="mb-4">
          No NinjaOne tenant is connected. Organisations and devices shown are synthetic. Enter API credentials below to go live.
        </Alert>
      )}
      {conn.lastError && !conn.demo && <Alert tone="error" title="Last error" className="mb-4">{conn.lastError}</Alert>}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Devices mirrored" value={totals.total} hint={conn.demo ? "demo data" : totals.lastFetched ? `fetched ${fmtRelative(new Date(totals.lastFetched))}` : "never fetched"} />
        <Stat label={`Active (seen in ${totals.activeDays} days)`} value={totals.active} tone="good" />
        <Stat label="Billable class, active" value={totals.billable} hint="per the classes below" />
        <Stat label="Not mapped to a company" value={totals.unmapped} tone={totals.unmapped ? "warn" : "default"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Connection">
          <DescriptionList
            items={[
              { label: "Mode", value: conn.demo ? "Demo" : live ? "Live (read-only)" : "Not connected" },
              { label: "Instance", value: live ? conn.externalAccountName : null },
              { label: "Region", value: live ? conn.region.toUpperCase() : null },
              { label: "Client ID", value: live ? conn.clientIdMasked : null },
              { label: "Last tested", value: conn.lastTestedAt ? fmtDateTime(conn.lastTestedAt, settings) : null },
              { label: "Last successful sync", value: conn.lastSuccessfulSyncAt ? fmtDateTime(conn.lastSuccessfulSyncAt, settings) : null },
              { label: "Schedule", value: "hourly at :20 (worker)" },
            ]}
          />
          {canManage && (
            <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
              <NinjaConnectForm region={conn.region} clientIdMasked={conn.clientIdMasked} />
              {live && (
                <ConfirmButton variant="danger-outline" size="sm" action={disconnectAction.bind(null, "ninjaone")} title="Disconnect NinjaOne?" description="Stored credentials are deleted. Mirrored devices and mappings are kept but will go stale." confirmLabel="Disconnect">
                  Disconnect
                </ConfirmButton>
              )}
            </div>
          )}
        </Card>

        <Card title="Counting rules">
          <NinjaConfigForm billableNodeClasses={conn.effectiveConfig?.billableNodeClasses ?? []} approvedOnly={conn.effectiveConfig?.approvedOnly ?? true} readOnly={!canManage} />
          <div className="mt-4 border-t border-slate-100 pt-4 text-xs text-slate-500">
            <p className="mb-1 font-medium text-slate-700">How observed counts work</p>
            <ul className="list-disc space-y-0.5 pl-4">
              <li>A device is <strong>active</strong> if NinjaOne saw it within the last {settings.deviceActiveDays} days (Settings → General → “Device active window”).</li>
              <li>Only active devices in a ticked class count towards a contract line marked “compare with NinjaOne”.</li>
              <li>Lines tied to a site only count devices at the linked NinjaOne location; unlinked sites are skipped, never guessed.</li>
              <li>Discrepancies are review items on the <Link href="/devices" className="text-brand-700 hover:underline">Devices</Link> page. Billing is never changed automatically.</li>
            </ul>
          </div>
        </Card>
      </div>

      <Card title={`Organisation mapping · ${mapping.linkedCount} of ${mapping.organisations.length} linked`} padded={false} className="mt-4" actions={canManage && mapping.linkedCount < mapping.organisations.length ? <ImportAllOrganizationsButton /> : undefined}>
        <OrgMappingTable rows={mapping.organisations} companies={mapping.companies} canManage={canManage} />
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Recent sync runs" padded={false}>
          {runs.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No runs yet.</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Trigger</th>
                  <th>Result</th>
                  <th className="text-right">Devices</th>
                  <th className="text-right">Changed</th>
                  <th className="text-right">Errors</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap text-slate-500">{fmtRelative(r.startedAt)}</td>
                    <td className="text-xs text-slate-500">{r.trigger}</td>
                    <td>
                      <Badge tone={r.status === "success" ? "green" : r.status === "partial" ? "amber" : r.status === "running" ? "blue" : "red"}>{r.status}</Badge>
                    </td>
                    <td className="text-right tabular-nums">{r.fetched}</td>
                    <td className="text-right tabular-nums">{r.created + r.updated}</td>
                    <td className="text-right tabular-nums">{r.errorCount ? <Link href={`/integrations/runs/${r.id}`} className="text-red-700 hover:underline">{r.errorCount}</Link> : 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Unresolved errors" padded={false}>
          {errors.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">Nothing to show.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {errors.map((e) => (
                <li key={e.id} className="px-4 py-2">
                  <div className="text-red-700">{e.message}</div>
                  <div className="text-xs text-slate-500">{e.kind} · {fmtRelative(e.at)}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
