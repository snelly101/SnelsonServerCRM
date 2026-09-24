import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import {
  pax8ConnectionSummary,
  pax8MappingOverview,
  pax8Totals,
} from "@/services/pax8";
import { listDiscrepancies } from "@/services/ninjaone";
import { getPax8Client } from "@/connectors/pax8";
import { listSyncRuns, recentUnresolvedErrors } from "@/services/integrations";
import { PageHeader, Card, DescriptionList, Stat } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { disconnectAction } from "@/actions/integrations";
import { fmtDateTime, fmtMoney, fmtRelative } from "@/lib/format";
import { DiscrepancyTable } from "@/app/(app)/devices/discrepancies";
import {
  Pax8ConfigForm,
  Pax8ConnectForm,
  Pax8MappingTable,
  Pax8SyncButton,
  Pax8TestButton,
  RecheckLicencesButton,
} from "./controls";

export const metadata = { title: "Pax8" };

export default async function Pax8Page() {
  const me = await requirePermission("integration.read");
  const canManage = can(me.role, "integration.manage");
  const [
    conn,
    settings,
    runs,
    errors,
    mapping,
    totals,
    discrepancies,
    resolved,
  ] = await Promise.all([
    pax8ConnectionSummary(),
    getAppSettings(),
    listSyncRuns("pax8", 10),
    recentUnresolvedErrors("pax8"),
    pax8MappingOverview(),
    pax8Totals(),
    listDiscrepancies({ status: "open", source: "pax8" }),
    getPax8Client(),
  ]);
  const live = conn.mode === "live";

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Integrations", href: "/integrations" },
          { label: "Pax8" },
        ]}
        title={
          <span className="flex items-center gap-2">
            Pax8{" "}
            <Badge
              tone={
                conn.demo
                  ? "amber"
                  : conn.status === "connected"
                    ? "green"
                    : conn.status === "not_configured"
                      ? "slate"
                      : "red"
              }
            >
              {conn.demo
                ? "Demo (not connected)"
                : conn.status.replace("_", " ")}
            </Badge>
          </span>
        }
        description="Read-only. Customer companies, their subscriptions (Microsoft 365 and other cloud licences), the partner cost per licence and recent Pax8 invoices are mirrored hourly, linked to customers, and compared with the contract line that bills them. The CRM never orders or changes anything at Pax8."
        actions={
          <>
            {canManage && conn.configured && <Pax8TestButton />}
            {conn.configured && can(me.role, "integration.sync") && (
              <Pax8SyncButton />
            )}
          </>
        }
      />
      {conn.demo && (
        <Alert tone="warn" title="Demo adapter in use" className="mb-4">
          No Pax8 account is connected. Companies and subscriptions shown are
          synthetic. Enter the API client id and secret below to go live.
        </Alert>
      )}
      {conn.lastError && !conn.demo && (
        <Alert tone="error" title="Last error" className="mb-4">
          {conn.lastError}
        </Alert>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          label="Pax8 companies"
          value={totals.companies}
          hint={
            conn.demo
              ? "demo data"
              : totals.lastFetched
                ? `fetched ${fmtRelative(new Date(totals.lastFetched))}`
                : "never fetched"
          }
        />
        <Stat
          label="Linked to a CRM company"
          value={`${totals.linked} of ${totals.companies}`}
          tone={totals.companies - totals.linked ? "warn" : "default"}
          hint={
            totals.unlinkedSubscriptions
              ? `${totals.unlinkedSubscriptions} subscriptions on unlinked companies`
              : undefined
          }
        />
        <Stat
          label="Active subscriptions"
          value={totals.subscriptions}
          hint={`${totals.licences} licences`}
        />
        <Stat
          label="Partner cost / month"
          value={fmtMoney(totals.monthlyCost, settings.currency)}
          hint="from Pax8 prices, recurring terms only"
        />
        <Stat
          label="Open licence discrepancies"
          value={totals.openDiscrepancies}
          tone={totals.openDiscrepancies ? "warn" : "default"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Connection">
          <DescriptionList
            items={[
              {
                label: "Mode",
                value: conn.demo
                  ? "Demo"
                  : live
                    ? "Live (read-only)"
                    : "Not connected",
              },
              {
                label: "Account",
                value: live ? conn.externalAccountName : null,
              },
              {
                label: "Last tested",
                value: conn.lastTestedAt
                  ? fmtDateTime(conn.lastTestedAt, settings)
                  : null,
              },
              {
                label: "Last successful sync",
                value: conn.lastSuccessfulSyncAt
                  ? fmtDateTime(conn.lastSuccessfulSyncAt, settings)
                  : null,
              },
              {
                label: "Schedule",
                value:
                  "hourly at :50 (worker); licence check runs inside each sync",
              },
            ]}
          />
          {canManage && (
            <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
              <Pax8ConnectForm keyPresent={conn.keyPresent} />
              {live && (
                <ConfirmButton
                  variant="danger-outline"
                  size="sm"
                  action={disconnectAction.bind(null, "pax8")}
                  title="Disconnect Pax8?"
                  description="The stored client id and secret are deleted. Mirrored companies, subscriptions and their links are kept but will go stale."
                  confirmLabel="Disconnect"
                >
                  Disconnect
                </ConfirmButton>
              )}
            </div>
          )}
        </Card>

        <Card title="Matching and costs">
          <Pax8ConfigForm
            autoLink={conn.effectiveConfig.autoLink}
            invoiceCount={conn.effectiveConfig.invoiceCount}
            readOnly={!canManage}
          />
          <div className="mt-4 border-t border-slate-100 pt-4 text-xs text-slate-500">
            <p className="mb-1 font-medium text-slate-700">How it works</p>
            <ul className="list-disc space-y-0.5 pl-4">
              <li>
                A Pax8 company is linked automatically only when its website
                domain, or its exact name, matches one company that is not
                already linked. Anything else is a suggestion for a person to
                confirm.
              </li>
              <li>
                Each subscription is matched to the contract line that bills it:
                the line you choose on the company&apos;s{" "}
                <strong>Subscriptions</strong> tab wins; otherwise the catalogue
                product&apos;s SKU must equal the Pax8 SKU, or the product name
                must equal the Pax8 product name.
              </li>
              <li>
                The licence check compares the contracted quantity with the
                licences held at Pax8 and raises a review item for any
                difference, like the device check. Billing is never changed
                automatically.
              </li>
              <li>
                The Pax8 price is the partner cost. <em>Use as cost</em> on the
                Subscriptions tab copies it onto the contract line so margin on
                the Contracts page is real. Ordering, quantity changes and
                cancellations stay in the{" "}
                <Link
                  href="https://app.pax8.com"
                  className="text-brand-700 hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  Pax8 portal
                </Link>
                .
              </li>
            </ul>
          </div>
        </Card>
      </div>

      <Card
        title={`Pax8 companies · ${mapping.linkedCount} of ${mapping.items.length} linked`}
        padded={false}
        className="mt-4"
      >
        <Pax8MappingTable
          rows={mapping.items.map((i) => ({
            id: i.id,
            pax8Id: i.pax8Id,
            name: i.name,
            website: i.website,
            city: i.city,
            status: i.status,
            externalStatus: i.externalStatus,
            companyId: i.companyId,
            companyName: i.companyName,
            matchSource: i.matchSource,
            subscriptions: i.subscriptions,
            licences: i.licences,
            suggestions: i.suggestions,
            consoleUrl:
              resolved?.client.consoleUrl("company", i.pax8Id) ?? null,
          }))}
          companies={mapping.companies}
          canManage={canManage}
        />
      </Card>

      <Card
        title={`Open licence discrepancies (${discrepancies.length})`}
        padded={false}
        className="mt-4"
        actions={
          can(me.role, "integration.sync") && conn.configured ? (
            <RecheckLicencesButton />
          ) : undefined
        }
      >
        <DiscrepancyTable
          rows={discrepancies}
          canReview={can(me.role, "discrepancy.review")}
          currency={settings.currency}
          kind="licence"
        />
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
                  <th className="text-right">Records</th>
                  <th className="text-right">Changed</th>
                  <th className="text-right">Errors</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap text-slate-500">
                      {fmtRelative(r.startedAt)}
                    </td>
                    <td className="text-xs text-slate-500">{r.trigger}</td>
                    <td>
                      <Badge
                        tone={
                          r.status === "success"
                            ? "green"
                            : r.status === "partial"
                              ? "amber"
                              : r.status === "running"
                                ? "blue"
                                : "red"
                        }
                      >
                        {r.status}
                      </Badge>
                    </td>
                    <td className="text-right tabular-nums">{r.fetched}</td>
                    <td className="text-right tabular-nums">
                      {r.created + r.updated}
                    </td>
                    <td className="text-right tabular-nums">
                      {r.errorCount ? (
                        <Link
                          href={`/integrations/runs/${r.id}`}
                          className="text-red-700 hover:underline"
                        >
                          {r.errorCount}
                        </Link>
                      ) : (
                        0
                      )}
                    </td>
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
                  <div className="text-xs text-slate-500">
                    {e.kind} · {fmtRelative(e.at)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
