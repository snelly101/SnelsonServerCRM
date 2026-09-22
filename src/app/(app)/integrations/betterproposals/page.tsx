import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { bpConnectionSummary, listBpTemplates } from "@/services/proposals";
import { listLinks, listOutbound, listSyncRuns, recentUnresolvedErrors } from "@/services/integrations";
import { PageHeader, Card, DescriptionList } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { disconnectAction, unlinkAction } from "@/actions/integrations";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { ConnectForm, ConfigForm } from "./forms";
import { SyncNowButton, TestButton } from "../controls";

export const metadata = { title: "Better Proposals" };

export default async function BetterProposalsPage() {
  const me = await requirePermission("integration.read");
  const canManage = can(me.role, "integration.manage");
  const [conn, settings, runs, errors, links, outbound] = await Promise.all([bpConnectionSummary(), getAppSettings(), listSyncRuns("betterproposals", 10), recentUnresolvedErrors("betterproposals"), listLinks("betterproposals"), listOutbound("betterproposals", 15)]);
  let templates: { id: string; name: string; description: string | null; isDefault: boolean }[] = [];
  let templateError: string | null = null;
  if (conn.configured) {
    try {
      templates = (await listBpTemplates()).templates;
    } catch (err) {
      templateError = err instanceof Error ? err.message : String(err);
    }
  }
  const config = conn.config as { defaultTemplateId?: string; taxLabel?: string | null; taxAmount?: string | null };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Integrations", href: "/integrations" }, { label: "Better Proposals" }]}
        title={
          <span className="flex items-center gap-2">
            Better Proposals <Badge tone={conn.demo ? "amber" : conn.status === "connected" ? "green" : conn.status === "not_configured" ? "slate" : "red"}>{conn.demo ? "Demo (not connected)" : conn.status.replace("_", " ")}</Badge>
          </span>
        }
        description="Proposals are created from templates with customer details and merge tags. Pricing, sending and e-signature happen in Better Proposals; status is polled every 15 minutes."
        actions={
          <>
            {canManage && <TestButton provider="betterproposals" />}
            {conn.configured && can(me.role, "integration.sync") && <SyncNowButton provider="betterproposals" />}
          </>
        }
      />
      {conn.demo && (
        <Alert tone="warn" title="Demo adapter in use" className="mb-4">
          No API token is stored. Proposal data on this site is synthetic. Paste a token below to go live; the demo data is ignored once a live connection exists.
        </Alert>
      )}
      {conn.lastError && !conn.demo && (
        <Alert tone="error" title="Last error" className="mb-4">
          {conn.lastError}
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Connection">
          <DescriptionList
            items={[
              { label: "Mode", value: conn.demo ? "Demo" : conn.mode === "live" ? "Live" : "Not configured" },
              { label: "Account", value: conn.demo ? null : conn.externalAccountName },
              { label: "Last tested", value: conn.lastTestedAt ? fmtDateTime(conn.lastTestedAt, settings) : null },
              { label: "Last successful sync", value: conn.lastSuccessfulSyncAt ? fmtDateTime(conn.lastSuccessfulSyncAt, settings) : null },
              { label: "Tax defaults (from BP brand)", value: config.taxLabel ? `${config.taxLabel} ${config.taxAmount ?? ""}%` : null },
            ]}
          />
          {canManage && (
            <div className="mt-4 border-t border-slate-100 pt-4">
              <h3 className="mb-2 text-sm font-semibold">{conn.mode === "live" && !conn.demo ? "Replace API token" : "Connect"}</h3>
              <p className="mb-3 text-xs text-slate-500">
                Better Proposals → Settings → Integrations → API → Generate API Key (Premium/Enterprise plans). The token is verified against the API before it is stored, encrypted, on the server.
              </p>
              <ConnectForm />
              {conn.mode === "live" && !conn.demo && (
                <div className="mt-3">
                  <ConfirmButton variant="danger-outline" size="sm" action={disconnectAction.bind(null, "betterproposals")} title="Disconnect Better Proposals?" description="The stored token is deleted. Mirrored proposals and links are kept." confirmLabel="Disconnect">
                    Disconnect
                  </ConfirmButton>
                </div>
              )}
            </div>
          )}
        </Card>

        <Card title="Defaults">
          {!conn.configured ? (
            <p className="text-sm text-slate-500">Connect first to choose a default template.</p>
          ) : templateError ? (
            <Alert tone="error">Could not load templates: {templateError}</Alert>
          ) : (
            <ConfigForm templates={templates} defaultTemplateId={config.defaultTemplateId ?? ""} readOnly={!canManage} />
          )}
          <div className="mt-4 border-t border-slate-100 pt-4 text-xs text-slate-500">
            <p className="mb-1 font-medium text-slate-700">What the API supports (verified against the vendor docs)</p>
            <ul className="list-disc space-y-0.5 pl-4">
              <li>Create a proposal from a template with company, contacts and merge tags.</li>
              <li>Read proposal lists by status (sent, opened, signed, paid) with dates and totals.</li>
              <li>No line-item pricing on create: edit the quote in Better Proposals via the “Open in Better Proposals” link.</li>
              <li>No webhooks: the CRM polls every 15 minutes (and on “Sync now”).</li>
              <li>Sending and e-signature happen in Better Proposals.</li>
            </ul>
          </div>
        </Card>
      </div>

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
                  <th className="text-right">Checked</th>
                  <th className="text-right">Changed</th>
                  <th className="text-right">Errors</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap text-slate-500">{fmtRelative(r.startedAt)}</td>
                    <td>{r.trigger}</td>
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
            <p className="p-4 text-sm text-slate-500">None.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {errors.map((e) => (
                <li key={e.id} className="px-4 py-2">
                  <div className="text-slate-800">{e.message}</div>
                  <div className="text-xs text-slate-500">
                    {e.kind} · {e.externalId ? `proposal ${e.externalId} · ` : ""}
                    {fmtRelative(e.at)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Record mapping" padded={false}>
          {links.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No CRM records are linked to Better Proposals yet. Links are created when you create a proposal from an opportunity or link one on the Proposals page.</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>CRM record</th>
                  <th>Better Proposals</th>
                  <th>How</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <Link href={l.entityType === "company" ? `/companies/${l.localId}` : `/pipeline/${l.localId}`} className="text-brand-700 hover:underline">
                        {l.entityType} {l.localId.slice(0, 8)}
                      </Link>
                    </td>
                    <td>
                      {l.externalName ?? l.externalId}
                      {l.externalUrl && (
                        <a href={l.externalUrl} target="_blank" rel="noreferrer" className="ml-1 inline-flex align-middle text-slate-400 hover:text-brand-700" aria-label="Open in Better Proposals">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                      {l.externalStatus !== "active" && <Badge className="ml-1" tone="amber">{l.externalStatus}</Badge>}
                    </td>
                    <td className="text-xs text-slate-500">{l.source.replace(/_/g, " ")}</td>
                    <td className="text-right">
                      {canManage && (
                        <ConfirmButton variant="ghost" size="sm" action={unlinkAction.bind(null, l.id)} title="Remove this link?" description="The Better Proposals record is not affected." confirmLabel="Unlink">
                          Unlink
                        </ConfirmButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Outbound requests (idempotency ledger)" padded={false}>
          {outbound.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No writes to Better Proposals yet.</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Operation</th>
                  <th>Status</th>
                  <th className="text-right">Attempts</th>
                  <th>External ID</th>
                </tr>
              </thead>
              <tbody>
                {outbound.map((o) => (
                  <tr key={o.id}>
                    <td className="whitespace-nowrap text-slate-500">{fmtRelative(o.updatedAt)}</td>
                    <td>
                      <code className="text-xs">{o.operation}</code>
                      <div className="max-w-xs truncate text-[11px] text-slate-400">{o.idempotencyKey}</div>
                    </td>
                    <td>
                      <Badge tone={o.status === "succeeded" ? "green" : o.status === "failed" ? "red" : "blue"}>{o.status}</Badge>
                      {o.error && <div className="max-w-xs truncate text-[11px] text-red-600" title={o.error}>{o.error}</div>}
                    </td>
                    <td className="text-right tabular-nums">{o.attempts}</td>
                    <td className="text-xs">{o.externalId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
