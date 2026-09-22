import type { NinjaDeviceHealthRaw, NinjaDeviceRaw, NinjaLocationRaw, NinjaOneClient, NinjaOrganizationRaw } from "./types";

/**
 * DEMO adapter for NinjaOne: a handful of organisations, locations and
 * devices with realistic last-seen times and health. Read-only like the
 * live client. Never reports as connected.
 */
const now = Math.floor(Date.now() / 1000);
const days = (n: number) => now - n * 86400;

const orgs: NinjaOrganizationRaw[] = [
  { id: 101, name: "Harrowgate Dental Practice", nodeApprovalMode: "AUTOMATIC" },
  { id: 102, name: "Northern Freight Solutions", nodeApprovalMode: "AUTOMATIC" },
  { id: 103, name: "Ridgeway Architects LLP", nodeApprovalMode: "AUTOMATIC" },
  { id: 104, name: "Greenfield Primary Academy", nodeApprovalMode: "MANUAL" },
  { id: 105, name: "Bramley & Sons", nodeApprovalMode: "AUTOMATIC" },
  { id: 106, name: "Internal - Snelson Server", nodeApprovalMode: "AUTOMATIC" },
];
const locations: Record<number, NinjaLocationRaw[]> = {
  101: [{ id: 1011, name: "Head office", address: "Harrogate" }],
  102: [{ id: 1021, name: "Head office", address: "Leeds" }, { id: 1022, name: "Branch office", address: "Leeds" }],
  103: [{ id: 1031, name: "Main Location", address: "York" }],
  104: [{ id: 1041, name: "School", address: "Wakefield" }],
  105: [{ id: 1051, name: "Main Location", address: "Bradford" }],
  106: [{ id: 1061, name: "Office" }],
};

const devices = new Map<number, NinjaDeviceRaw>();
const health = new Map<number, NinjaDeviceHealthRaw>();
let seq = 5000;

function add(orgId: number, locationId: number, nodeClass: string, name: string, lastSeenDays: number, extra: Partial<NinjaDeviceRaw> = {}, h: Partial<NinjaDeviceHealthRaw> = {}) {
  const id = ++seq;
  const win = nodeClass.startsWith("WINDOWS");
  devices.set(id, {
    id,
    organizationId: orgId,
    locationId,
    nodeClass,
    displayName: name,
    systemName: name.toUpperCase().replace(/\s+/g, "-"),
    dnsName: `${name.toLowerCase().replace(/\s+/g, "-")}.local`,
    approvalStatus: "APPROVED",
    offline: lastSeenDays > 0.01,
    created: days(400),
    lastContact: days(lastSeenDays),
    lastUpdate: days(lastSeenDays),
    ipAddresses: [`10.${orgId - 100}.0.${id % 250}`],
    os: win ? { manufacturer: "Microsoft", name: nodeClass === "WINDOWS_SERVER" ? "Windows Server 2022" : "Windows 11 Pro", buildNumber: "22631", needsReboot: id % 7 === 0 } : nodeClass === "MAC" ? { manufacturer: "Apple", name: "macOS 15" } : { manufacturer: "Canonical", name: "Ubuntu 24.04" },
    ...extra,
  });
  health.set(id, { deviceId: id, healthStatus: h.healthStatus ?? (id % 9 === 0 ? "NEEDS_ATTENTION" : "HEALTHY"), activeThreatsCount: 0, pendingOSPatchesCount: id % 3, failedOSPatchesCount: id % 11 === 0 ? 1 : 0, alertCount: id % 9 === 0 ? 2 : 0, avInstallStatus: "INSTALLED", offline: lastSeenDays > 0.01, ...h });
}

function seed() {
  if (devices.size) return;
  // Harrowgate: contract says 18 managed devices; NinjaOne has 19 active + 1 stale
  for (let i = 1; i <= 19; i++) add(101, 1011, i <= 2 ? "WINDOWS_SERVER" : "WINDOWS_WORKSTATION", `HDP-${i <= 2 ? "SRV" : "PC"}${i}`, i % 5 === 0 ? 3 : 0);
  add(101, 1011, "WINDOWS_WORKSTATION", "HDP-OLD-LAPTOP", 95);
  // Northern Freight: contract 40 across two sites; NinjaOne has 38 active (head office 30, branch 8) + printers
  for (let i = 1; i <= 30; i++) add(102, 1021, i <= 3 ? "WINDOWS_SERVER" : i % 6 === 0 ? "MAC" : "WINDOWS_WORKSTATION", `NFS-${i <= 3 ? "SRV" : "WS"}${i}`, i % 7 === 0 ? 1 : 0);
  for (let i = 1; i <= 8; i++) add(102, 1022, "WINDOWS_WORKSTATION", `NFS-BR-${i}`, 0);
  add(102, 1021, "NMS_PRINTER", "NFS-PRINTER-1", 0);
  add(102, 1021, "NMS_SWITCH", "NFS-CORE-SW", 0);
  add(102, 1021, "VMWARE_VM_HOST", "NFS-ESX1", 0);
  // Ridgeway: contract 24; NinjaOne 24 exactly
  for (let i = 1; i <= 24; i++) add(103, 1031, i === 1 ? "WINDOWS_SERVER" : i % 4 === 0 ? "MAC" : "WINDOWS_WORKSTATION", `RA-${i}`, 0);
  // Greenfield: contract 85; NinjaOne 92 active
  for (let i = 1; i <= 92; i++) add(104, 1041, i <= 2 ? "WINDOWS_SERVER" : "WINDOWS_WORKSTATION", `GPA-${i}`, i % 10 === 0 ? 2 : 0);
  // Bramley: contract 11; NinjaOne 11 (one pending approval)
  for (let i = 1; i <= 11; i++) add(105, 1051, "WINDOWS_WORKSTATION", `BRM-${i}`, 0, i === 11 ? { approvalStatus: "PENDING" } : {});
  // Internal org, unmapped
  for (let i = 1; i <= 6; i++) add(106, 1061, i === 1 ? "LINUX_SERVER" : "WINDOWS_WORKSTATION", `SS-${i}`, 0);
}

export function demoNinjaReset() {
  devices.clear();
  health.clear();
  seq = 5000;
  seed();
}
export function demoNinjaRemoveDevice(deviceId: number) {
  devices.delete(deviceId);
  health.delete(deviceId);
}
export function demoNinjaAddDevice(orgId: number, locationId: number, name: string) {
  add(orgId, locationId, "WINDOWS_WORKSTATION", name, 0);
  return seq;
}
export function demoNinjaDeviceIds(orgId: number) {
  return [...devices.values()].filter((d) => d.organizationId === orgId).map((d) => d.id);
}

export class DemoNinjaOneClient implements NinjaOneClient {
  readonly mode = "demo" as const;
  constructor() {
    seed();
  }
  async testConnection() {
    return { ok: false as const, error: "Demo adapter: no NinjaOne tenant is connected. Enter an API client id and secret to go live." };
  }
  async listOrganizations(after = 0, pageSize = 200) {
    return orgs.filter((o) => o.id > after).slice(0, pageSize);
  }
  async listLocations(orgId: number) {
    return locations[orgId] ?? [];
  }
  async listDevicesDetailed(after = 0, pageSize = 500) {
    return [...devices.values()].filter((d) => d.id > after).sort((a, b) => a.id - b.id).slice(0, pageSize);
  }
  async getDevice(id: number) {
    return devices.get(id) ?? null;
  }
  async deviceHealth(cursor?: string, pageSize = 500) {
    const all = [...health.values()].sort((a, b) => a.deviceId - b.deviceId);
    const start = cursor ? Number(cursor) : 0;
    const page = all.slice(start, start + pageSize);
    return { results: page, nextCursor: start + pageSize < all.length ? String(start + pageSize) : null };
  }
  consoleUrl(kind: "device" | "organization", id: string | number) {
    return `https://eu.ninjarmm.com/#/${kind === "device" ? "deviceDashboard" : "customerDashboard"}/${id}/overview`;
  }
}
