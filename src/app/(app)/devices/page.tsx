import Link from "next/link";
import { MonitorSmartphone } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { listSavedViews } from "@/services/settings";
import { companyOptions } from "@/services/lookups";
import { deviceTotals, listDevices, listDiscrepancies, ninjaConnectionSummary } from "@/services/ninjaone";
import { getNinjaOneClient } from "@/connectors/ninjaone";
import { PageHeader, Card, EmptyState, Stat } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Pagination } from "@/components/ui/pagination";
import { FilterBar } from "@/components/ui/filter-bar";
import { DeviceTable, FRESHNESS_LABEL, FRESHNESS_TONE } from "@/components/device-table";
import { DiscrepancyTable, RecheckButton } from "./discrepancies";
import { NINJA_NODE_CLASSES as NODE_CLASSES } from "@/connectors/ninjaone/types";
import { param, toInt } from "@/lib/utils";
import { fmtRelative } from "@/lib/format";

export const metadata = { title: "Devices" };

export default async function DevicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("device.read");
  const sp = await searchParams;
  const status = param(sp, "status") as "online" | "offline" | "inactive" | "deleted" | undefined;
  const discStatus = param(sp, "disc") ?? "open";
  const [conn, settings, views, companies, data, totals, discrepancies, resolved] = await Promise.all([
    ninjaConnectionSummary(),
    getAppSettings(),
    listSavedViews(me.id, "devices"),
    companyOptions(),
    listDevices({ q: param(sp, "q"), companyId: param(sp, "company"), nodeClass: param(sp, "class"), status, health: param(sp, "health"), page: toInt(param(sp, "page"), 1) }),
    deviceTotals(),
    listDiscrepancies({ status: discStatus }),
    getNinjaOneClient(),
  ]);
  const canReview = can(me.role, "discrepancy.review");
  const consoleUrl = resolved ? (id: string) => resolved.client.consoleUrl("device", id) : undefined;

  if (!conn.configured) {
    return (
      <>
        <PageHeader title="Devices" description="Managed devices mirrored from NinjaOne, compared with per-device contract lines." />
        <EmptyState
          icon={<MonitorSmartphone className="h-6 w-6" />}
          title="NinjaOne is not connected"
          description="Enter the API client id and secret on the Integrations page to start mirroring organisations, locations and devices."
          action={can(me.role, "integration.manage") ? <Link href="/integrations/ninjaone" className="text-brand-700 hover:underline">Open NinjaOne settings</Link> : undefined}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Devices {conn.demo && <Badge tone="amber">Demo data</Badge>}
            <Badge tone={FRESHNESS_TONE[totals.freshness]}>{FRESHNESS_LABEL[totals.freshness]}</Badge>
          </span>
        }
        description={
          <>
            Mirrored from NinjaOne (read-only){totals.lastFetched ? <>, last fetched {fmtRelative(new Date(totals.lastFetched))}</> : null}. Active = seen within {totals.activeDays} days.{" "}
            <Link href="/integrations/ninjaone" className="text-brand-700 hover:underline">
              Mapping and settings
            </Link>
          </>
        }
        actions={canReview && <RecheckButton />}
      />
      {conn.demo && (
        <Alert tone="warn" className="mb-4">
          Demo adapter: these devices are synthetic. Nothing here is live or verified until NinjaOne credentials are entered.
        </Alert>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label="Total devices" value={totals.total} />
        <Stat label="Active" value={totals.active} tone="good" />
        <Stat label="Online now" value={totals.online} />
        <Stat label="Servers" value={totals.servers} hint="active" />
        <Stat label="Needs attention" value={totals.needsAttention} tone={totals.needsAttention ? "warn" : "default"} hint="health ≠ healthy" />
        <Stat label="Unmapped" value={totals.unmapped} tone={totals.unmapped ? "warn" : "default"} hint="org not linked" />
      </div>

      <Card
        title={`Device count discrepancies · ${discrepancies.length} ${discStatus === "all" ? "total" : discStatus}`}
        padded={false}
        className="mb-4"
        actions={
          <span className="flex gap-1 text-xs">
            {["open", "accepted", "resolved", "dismissed", "all"].map((s) => (
              <Link key={s} href={`/devices?disc=${s}`} className={`rounded px-2 py-0.5 ${discStatus === s ? "bg-fg text-surface" : "text-slate-600 hover:bg-slate-100"}`}>
                {s}
              </Link>
            ))}
          </span>
        }
      >
        <DiscrepancyTable rows={discrepancies} canReview={canReview} currency={settings.currency} />
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">Observed = active devices in billable classes at the linked organisation (and location, for site-specific lines). Review only records a decision; contracts and invoices are never changed automatically.</p>
      </Card>

      <FilterBar
        page="devices"
        savedViews={views}
        currentUserId={me.id}
        placeholder="Search device, hostname, organisation…"
        filters={[
          { key: "company", label: "Company", options: companies.map((c) => ({ value: c.id, label: c.name })) },
          { key: "status", label: "Status", options: [{ value: "online", label: "Online" }, { value: "offline", label: "Offline (active)" }, { value: "inactive", label: `Inactive (> ${totals.activeDays} days)` }, { value: "deleted", label: "Removed in NinjaOne" }] },
          { key: "class", label: "Type", options: NODE_CLASSES.map((c) => ({ value: c, label: c.toLowerCase().replace(/_/g, " ") })) },
          { key: "health", label: "Health", options: [{ value: "HEALTHY", label: "Healthy" }, { value: "NEEDS_ATTENTION", label: "Needs attention" }, { value: "UNHEALTHY", label: "Unhealthy" }] },
        ]}
      />
      <Card padded={false}>
        <DeviceTable rows={data.rows} consoleUrl={consoleUrl} />
        <Pagination page={data.page} pageCount={data.pageCount} total={data.total} pageSize={data.pageSize} />
      </Card>
    </>
  );
}
