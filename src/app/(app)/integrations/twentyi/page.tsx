import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { hostingMappingOverview, hostingTotals, twentyIConnectionSummary } from "@/services/twentyi";
import { listSyncRuns, recentUnresolvedErrors } from "@/services/integrations";
import { PageHeader, Card, DescriptionList, Stat } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { disconnectAction } from "@/actions/integrations";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { HostingMappingTable, TwentyIConfigForm, TwentyIConnectForm, TwentyISyncButton, TwentyITestButton } from "./controls";

export const metadata = { title: "20i Hosting" };

export default async function TwentyIPage() {
  const me = await requirePermission("integration.read");
  const canManage = can(me.role, "integration.manage");
  const [conn, settings, runs, errors, mapping, totals] = await Promise.all([twentyIConnectionSummary(), getAppSettings(), listSyncRuns("twentyi", 10), recentUnresolvedErrors("twentyi"), hostingMappingOverview(), hostingTotals()]);
  const live = conn.mode === "live";

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Integrations", href: "/integrations" }, { label: "20i Hosting" }]}
        title={
          <span className="flex items-center gap-2">
            20i Hosting <Badge tone={conn.demo ? "amber" : conn.status === "connected" ? "green" : conn.status === "not_configured" ? "slate" : "red"}>{conn.demo ? "Demo (not connected)" : conn.status.replace("_", " ")}</Badge>
          </span>
        }
        description="Read-only. Hosting packages, registered domains and mailboxes in the reseller account are mirrored hourly, linked to customers, and tied to the contract line that bills them. The CRM never changes anything at 20i."
        actions={
          <>
            {canManage && conn.configured && <TwentyITestButton />}
            {conn.configured && can(me.role, "integration.sync") && <TwentyISyncButton />}
          </>
        }
      />
      {conn.demo && (
        <Alert tone="warn" title="Demo adapter in use" className="mb-4">
          No 20i account is connected. Packages and domains shown are synthetic. Enter the reseller API key below to go live.
        </Alert>
      )}
      {conn.lastError && !conn.demo && <Alert tone="error" title="Last error" className="mb-4">{conn.lastError}</Alert>}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Packages" value={totals.packages} hint={conn.demo ? "demo data" : totals.lastFetched ? `fetched ${fmtRelative(new Date(totals.lastFetched))}` : "never fetched"} />
        <Stat label="Domains" value={totals.domains} />
        <Stat label="Mailboxes" value={totals.mailboxes} />
        <Stat label="Expiring within 30 days" value={totals.expiring30} tone={totals.expired ? "danger" : totals.expiring30 ? "warn" : "default"} hint={totals.expired ? `${totals.expired} already expired` : undefined} />
        <Stat label="Not linked to a company" value={totals.unlinked} tone={totals.unlinked ? "warn" : "default"} hint={totals.unbilled ? `${totals.unbilled} linked but not billed` : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Connection">
          <DescriptionList
            items={[
              { label: "Mode", value: conn.demo ? "Demo" : live ? "Live (read-only)" : "Not connected" },
              { label: "Account", value: live ? conn.externalAccountName : null },
              { label: "Last tested", value: conn.lastTestedAt ? fmtDateTime(conn.lastTestedAt, settings) : null },
              { label: "Last successful sync", value: conn.lastSuccessfulSyncAt ? fmtDateTime(conn.lastSuccessfulSyncAt, settings) : null },
              { label: "Schedule", value: "hourly at :40 (worker); expiry reminders daily at 06:00" },
            ]}
          />
          {canManage && (
            <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
              <TwentyIConnectForm keyPresent={conn.keyPresent} />
              {live && (
                <ConfirmButton variant="danger-outline" size="sm" action={disconnectAction.bind(null, "twentyi")} title="Disconnect 20i?" description="The stored API key is deleted. Mirrored packages, domains and their company links are kept but will go stale." confirmLabel="Disconnect">
                  Disconnect
                </ConfirmButton>
              )}
            </div>
          )}
        </Card>

        <Card title="Matching and reminders">
          <TwentyIConfigForm expiryReminderDays={conn.effectiveConfig.expiryReminderDays} autoLink={conn.effectiveConfig.autoLink} syncMailboxes={conn.effectiveConfig.syncMailboxes} readOnly={!canManage} />
          <div className="mt-4 border-t border-slate-100 pt-4 text-xs text-slate-500">
            <p className="mb-1 font-medium text-slate-700">How it works</p>
            <ul className="list-disc space-y-0.5 pl-4">
              <li>A package or domain is linked automatically only when its registrable domain (e.g. <em>example.co.uk</em>) matches exactly one company&apos;s website or contact email domain. Anything else is a suggestion for a person to confirm.</li>
              <li>Mailboxes follow the company of their package. Unlinking is remembered, so a sync never re-links what you undid.</li>
              <li>On each company&apos;s <strong>Hosting</strong> tab you choose the contract line that bills every package and domain, and see the Xero invoices whose lines mention them.</li>
              <li>Domains and certificates expiring inside the window become tasks, owned by the account owner. Renewals happen in <Link href="https://my.20i.com" className="text-brand-700 hover:underline" target="_blank" rel="noreferrer">My20i</Link>; the CRM never renews, suspends or provisions.</li>
            </ul>
          </div>
        </Card>
      </div>

      <Card title={`Packages and domains · ${mapping.linkedCount} of ${mapping.items.length} linked`} padded={false} className="mt-4">
        <HostingMappingTable rows={mapping.items.map((i) => ({ id: i.id, kind: i.kind, externalId: i.externalId, name: i.name, typeName: i.typeName, enabled: i.enabled, expiresOn: i.expiresOn, diskUsedBytes: i.diskUsedBytes, companyId: i.companyId, companyName: i.companyName, matchSource: i.matchSource, contractLineId: i.contractLineId, externalStatus: i.externalStatus, suggestions: i.suggestions, children: i.children.map((c) => ({ id: c.id, kind: c.kind, name: c.name, externalStatus: c.externalStatus })), details: i.details }))} companies={mapping.companies} canManage={canManage} />
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
                  <th className="text-right">Items</th>
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
