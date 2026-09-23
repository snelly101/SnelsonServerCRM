import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { listUnlinkedXeroCustomers, listXeroRepeatingInvoices, mappingOverview, xeroConnectionSummary, xeroReferenceData } from "@/services/xero";
import { listOutbound, listSyncRuns, recentUnresolvedErrors } from "@/services/integrations";
import { PageHeader, Card, DescriptionList } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { disconnectAction } from "@/actions/integrations";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { TenantPicker, XeroConfigForm, XeroTestButton, XeroSyncButton, MappingTable, UnlinkedCustomersTable, ImportAllXeroButton, RepeatingInvoicesTable, ImportAllRepeatingButton } from "./controls";

export const metadata = { title: "Xero" };

export default async function XeroPage({ searchParams }: { searchParams: Promise<{ error?: string; connected?: string; choose?: string }> }) {
  const me = await requirePermission("integration.read");
  const sp = await searchParams;
  const canManage = can(me.role, "integration.manage");
  const conn = await xeroConnectionSummary();
  const [settings, runs, errors, outbound, mapping, unlinked, repeating] = await Promise.all([ getAppSettings(), listSyncRuns("xero", 10), recentUnresolvedErrors("xero"), listOutbound("xero", 15), mappingOverview(), listUnlinkedXeroCustomers(), conn.configured ? listXeroRepeatingInvoices().catch((err) => ({ rows: [], mode: null, error: err instanceof Error ? err.message : String(err) })) : Promise.resolve({ rows: [], mode: null })]);
  let ref: Awaited<ReturnType<typeof xeroReferenceData>> = null;
  let refError: string | null = null;
  if (conn.configured) {
    try {
      ref = await xeroReferenceData();
    } catch (err) {
      refError = err instanceof Error ? err.message : String(err);
    }
  }
  const cfg = conn.config;
  const webhookUrl = `${process.env.APP_URL ?? ""}/api/webhooks/xero`;
  const webhookKeySet = Boolean(process.env.XERO_WEBHOOK_KEY);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Integrations", href: "/integrations" }, { label: "Xero" }]}
        title={
          <span className="flex items-center gap-2">
            Xero <Badge tone={conn.demo ? "amber" : conn.status === "connected" ? "green" : conn.status === "not_configured" ? "slate" : "red"}>{conn.demo ? "Demo (not connected)" : conn.status.replace("_", " ")}</Badge>
          </span>
        }
        description="Xero is the source of truth for contacts' legal details, invoices and payments. The CRM creates draft invoices only; approving and sending happen in Xero."
        actions={
          <>
            {canManage && conn.configured && <XeroTestButton />}
            {conn.configured && can(me.role, "integration.sync") && <XeroSyncButton />}
          </>
        }
      />
      {sp.error && <Alert tone="error" title="Connection failed" className="mb-4">{sp.error}</Alert>}
      {sp.connected && <Alert tone="success" className="mb-4">Xero connected.</Alert>}
      {conn.demo && (
        <Alert tone="warn" title="Demo adapter in use" className="mb-4">
          No Xero organisation is connected. Contacts, invoices and payments shown are synthetic. Connect below to go live.
        </Alert>
      )}
      {conn.lastError && !conn.demo && <Alert tone="error" title="Last error" className="mb-4">{conn.lastError}</Alert>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Connection">
          <DescriptionList
            items={[
              { label: "Mode", value: conn.demo ? "Demo" : conn.mode === "live" ? "Live" : "Not connected" },
              { label: "Organisation", value: conn.demo ? null : (conn.externalAccountName ?? cfg.tenantName ?? null) },
              { label: "Tenant ID", value: conn.demo ? null : cfg.tenantId ? <code className="text-xs">{cfg.tenantId}</code> : null },
              { label: "Last tested", value: conn.lastTestedAt ? fmtDateTime(conn.lastTestedAt, settings) : null },
              { label: "Last successful sync", value: conn.lastSuccessfulSyncAt ? fmtDateTime(conn.lastSuccessfulSyncAt, settings) : null },
              { label: "Webhooks", value: webhookKeySet ? `${cfg.webhookEvents ?? 0} events, last ${cfg.lastWebhookAt ? fmtRelative(cfg.lastWebhookAt) : "never"}` : "XERO_WEBHOOK_KEY not set (polling only)" },
            ]}
          />
          {canManage && (
            <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
              {!conn.appConfigured ? (
                <Alert tone="info" title="Server setup needed first">
                  Create an app at developer.xero.com (Web app), set the redirect URI to <code className="text-xs">{`${process.env.APP_URL ?? ""}/api/integrations/xero/callback`}</code>, then put <code className="text-xs">XERO_CLIENT_ID</code> and <code className="text-xs">XERO_CLIENT_SECRET</code> in <code className="text-xs">.env</code> and restart. These are the only Xero values that live outside the app.
                </Alert>
              ) : (
                <>
                  {conn.needsTenant || sp.choose ? <TenantPicker tenants={cfg.pendingTenants ?? []} /> : null}
                  <div className="flex flex-wrap gap-2">
                    <Link href="/api/integrations/xero/connect" className="inline-flex h-9 items-center rounded-md border border-transparent bg-brand-600 px-3.5 text-sm font-medium text-white hover:bg-brand-700">
                      {conn.mode === "live" && !conn.demo ? "Reconnect / change organisation" : "Connect to Xero"}
                    </Link>
                    {conn.mode === "live" && !conn.demo && (
                      <ConfirmButton variant="danger-outline" action={disconnectAction.bind(null, "xero")} title="Disconnect Xero?" description="Stored tokens are deleted. Mirrored invoices, contacts and links are kept. Revoke the app in Xero too if you want a clean break." confirmLabel="Disconnect">
                        Disconnect
                      </ConfirmButton>
                    )}
                  </div>
                </>
              )}
              <div className="text-xs text-slate-500">
                <p className="font-medium text-slate-700">Webhook endpoint</p>
                <code className="text-xs">{webhookUrl}</code>
                <p className="mt-1">Register it in the Xero app (Webhooks → Contacts and Invoices) and put the signing key in <code>XERO_WEBHOOK_KEY</code>. Missed events are recovered by the hourly sync and nightly reconciliation.</p>
              </div>
            </div>
          )}
        </Card>

        <Card title="Invoice defaults">
          {!conn.configured ? (
            <p className="text-sm text-slate-500">Connect first to load account codes and tax rates from Xero.</p>
          ) : refError ? (
            <Alert tone="error">Could not load reference data: {refError}</Alert>
          ) : (
            <XeroConfigForm accounts={ref?.accounts ?? []} taxRates={ref?.taxRates ?? []} themes={ref?.themes ?? []} config={cfg} readOnly={!canManage} />
          )}
          <div className="mt-4 border-t border-slate-100 pt-4 text-xs text-slate-500">
            <p className="mb-1 font-medium text-slate-700">Field ownership</p>
            <ul className="list-disc space-y-0.5 pl-4">
              <li><strong>Xero owns:</strong> legal name, addresses, tax number, account number, balances, invoice status and payments. The CRM never edits these.</li>
              <li><strong>CRM owns:</strong> account owner, tags, sites, contact roles, opportunities and contracts.</li>
              <li><strong>Email and phone:</strong> pushed to Xero only on an explicit “Push to Xero” click, and refused (with a review item) when Xero’s copy changed after the last sync and differs.</li>
              <li>Invoices are created as <strong>DRAFT</strong> after approval by a finance user, with an idempotency key so retries cannot duplicate.</li>
            </ul>
          </div>
        </Card>
      </div>

      <Card title={`Xero customers not yet in the CRM (${unlinked.length})`} padded={false} className="mt-4" actions={canManage && unlinked.length > 0 ? <ImportAllXeroButton /> : undefined}>
        <UnlinkedCustomersTable rows={unlinked} canManage={canManage} currency={settings.currency} />
      </Card>

      <Card title={`Repeating invoices in Xero (${repeating.rows.length})`} padded={false} className="mt-4" actions={can(me.role, "contract.write") && repeating.rows.some((r) => !r.contractId && r.companyId && !r.unsupportedReason && r.status === "AUTHORISED") ? <ImportAllRepeatingButton /> : undefined}>
        {"error" in repeating && repeating.error ? <p className="p-4 text-sm text-red-700">Could not load repeating invoices: {repeating.error}</p> : <RepeatingInvoicesTable rows={repeating.rows} canWrite={can(me.role, "contract.write")} currency={settings.currency} />}
      </Card>

      <Card title={`Customer mapping · ${mapping.linkedCount} linked, ${mapping.xeroCustomerCount} Xero customers mirrored`} padded={false} className="mt-4">
        <MappingTable rows={mapping.companies} canManage={canManage} configured={conn.configured} />
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
                  <th>Job</th>
                  <th>Result</th>
                  <th className="text-right">Checked</th>
                  <th className="text-right">Changed</th>
                  <th className="text-right">Errors</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap text-slate-500">{fmtRelative(r.startedAt)}</td>
                    <td>
                      <code className="text-xs">{r.kind}</code> <span className="text-xs text-slate-500">{r.trigger}</span>
                    </td>
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
        <Card title="Unresolved errors and outbound ledger" padded={false}>
          {errors.length === 0 && outbound.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">Nothing to show.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {errors.map((e) => (
                <li key={e.id} className="px-4 py-2">
                  <div className="text-red-700">{e.message}</div>
                  <div className="text-xs text-slate-500">{e.kind} · {fmtRelative(e.at)}</div>
                </li>
              ))}
              {outbound.map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-2 px-4 py-2">
                  <div className="min-w-0">
                    <code className="text-xs">{o.operation}</code> <span className="text-xs text-slate-400">{o.idempotencyKey}</span>
                    {o.error && <div className="truncate text-[11px] text-red-600">{o.error}</div>}
                  </div>
                  <Badge tone={o.status === "succeeded" ? "green" : o.status === "failed" ? "red" : "blue"}>{o.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
