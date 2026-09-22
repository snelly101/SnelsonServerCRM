import { Badge } from "@/components/ui/badge";
import { fmtRelative } from "@/lib/format";
import type { DeviceFreshness } from "@/services/ninjaone";

export type DeviceRow = {
  id: string;
  deviceId: string;
  displayName: string | null;
  systemName: string | null;
  nodeClass: string;
  osName: string | null;
  lastContact: Date | null;
  offline: boolean | null;
  approvalStatus: string | null;
  healthStatus: string | null;
  pendingOsPatches: number | null;
  failedOsPatches: number | null;
  activeThreats: number | null;
  needsReboot: boolean | null;
  externalStatus: string;
  orgName: string | null;
  locationName: string | null;
  companyName: string | null;
  companyId: string | null;
  siteName: string | null;
  freshness: DeviceFreshness;
  active: boolean;
};

export const FRESHNESS_TONE: Record<DeviceFreshness, string> = { live: "green", cached: "blue", stale: "amber", unavailable: "slate" };
export const FRESHNESS_LABEL: Record<DeviceFreshness, string> = { live: "live", cached: "cached", stale: "stale", unavailable: "unavailable" };
const HEALTH_TONE: Record<string, string> = { HEALTHY: "green", NEEDS_ATTENTION: "amber", UNHEALTHY: "red", UNKNOWN: "slate" };

export function nodeClassLabel(c: string) {
  return c.toLowerCase().replace(/_/g, " ");
}

export function DeviceTable({ rows, consoleUrl, showCompany = true }: { rows: DeviceRow[]; consoleUrl?: (id: string) => string; showCompany?: boolean }) {
  if (rows.length === 0) return <p className="p-4 text-sm text-slate-500">No devices match.</p>;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Device</th>
          <th>Type</th>
          {showCompany && <th>Company / site</th>}
          <th>OS</th>
          <th>Last seen</th>
          <th>Health</th>
          <th>Data</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.id} className={d.externalStatus === "deleted" ? "opacity-60" : ""}>
            <td>
              <div className="font-medium">
                {consoleUrl ? (
                  <a href={consoleUrl(d.deviceId)} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                    {d.displayName ?? d.systemName ?? d.deviceId}
                  </a>
                ) : (
                  d.displayName ?? d.systemName ?? d.deviceId
                )}
                {d.approvalStatus && d.approvalStatus !== "APPROVED" && <Badge className="ml-1" tone="amber">{d.approvalStatus.toLowerCase()}</Badge>}
                {d.externalStatus === "deleted" && <Badge className="ml-1" tone="red">removed in NinjaOne</Badge>}
              </div>
              <div className="text-xs text-slate-500">{d.systemName && d.systemName !== d.displayName ? d.systemName : d.locationName}</div>
            </td>
            <td className="text-xs">{nodeClassLabel(d.nodeClass)}</td>
            {showCompany && (
              <td className="text-xs">
                {d.companyName ? (
                  <>
                    <div>{d.companyName}</div>
                    <div className="text-slate-500">{d.siteName ?? d.locationName ?? ""}</div>
                  </>
                ) : (
                  <span className="text-amber-700">unmapped · {d.orgName}</span>
                )}
              </td>
            )}
            <td className="text-xs">
              {d.osName ?? "—"}
              {d.needsReboot && <span className="ml-1 text-amber-700">(reboot)</span>}
            </td>
            <td className="whitespace-nowrap text-xs">
              <span className={`mr-1 inline-block h-2 w-2 rounded-full ${d.offline === false ? "bg-green-500" : d.active ? "bg-slate-300" : "bg-red-300"}`} aria-hidden />
              {d.lastContact ? fmtRelative(d.lastContact) : "never"}
              {!d.active && <span className="ml-1 text-red-600">inactive</span>}
            </td>
            <td className="text-xs">
              {d.healthStatus ? <Badge tone={HEALTH_TONE[d.healthStatus] ?? "slate"}>{d.healthStatus.toLowerCase().replace(/_/g, " ")}</Badge> : <span className="text-slate-400">—</span>}
              {(d.failedOsPatches ?? 0) > 0 && <div className="text-red-600">{d.failedOsPatches} failed patches</div>}
              {(d.activeThreats ?? 0) > 0 && <div className="text-red-600">{d.activeThreats} threats</div>}
              {(d.pendingOsPatches ?? 0) > 0 && <div className="text-slate-500">{d.pendingOsPatches} pending patches</div>}
            </td>
            <td>
              <Badge tone={FRESHNESS_TONE[d.freshness]}>{FRESHNESS_LABEL[d.freshness]}</Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
