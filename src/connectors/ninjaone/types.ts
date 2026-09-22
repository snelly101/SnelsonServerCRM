/**
 * NinjaOne Public API v2 shapes (subset), from the official OpenAPI YAML
 * (https://app.ninjarmm.com/apidocs-beta/NinjaRMM-API-v2.yaml).
 */
export type NinjaRegion = "us" | "us2" | "eu" | "ca" | "oc";

export const NINJA_REGION_HOSTS: Record<NinjaRegion, string> = {
  us: "https://app.ninjarmm.com",
  us2: "https://us2.ninjarmm.com",
  eu: "https://eu.ninjarmm.com",
  ca: "https://ca.ninjarmm.com",
  oc: "https://oc.ninjarmm.com",
};

export type NinjaOrganizationRaw = { id: number; name: string; description?: string; nodeApprovalMode?: string; userData?: Record<string, unknown>; [k: string]: unknown };
export type NinjaLocationRaw = { id: number; name: string; address?: string; description?: string; userData?: Record<string, unknown>; [k: string]: unknown };

export type NinjaDeviceRaw = {
  id: number;
  organizationId: number;
  locationId?: number;
  nodeClass: string;
  displayName?: string;
  systemName?: string;
  dnsName?: string;
  netbiosName?: string;
  approvalStatus?: string;
  offline?: boolean;
  /** epoch seconds */
  created?: number;
  lastContact?: number;
  lastUpdate?: number;
  ipAddresses?: string[];
  publicIP?: string;
  tags?: string[];
  os?: { manufacturer?: string; name?: string; architecture?: string; buildNumber?: string; releaseId?: string; needsReboot?: boolean; lastBootTime?: number };
  system?: { name?: string; manufacturer?: string; model?: string; serialNumber?: string };
  [k: string]: unknown;
};

export type NinjaDeviceHealthRaw = {
  deviceId: number;
  healthStatus?: string;
  activeThreatsCount?: number;
  pendingOSPatchesCount?: number;
  failedOSPatchesCount?: number;
  alertCount?: number;
  avInstallStatus?: string;
  offline?: boolean;
  [k: string]: unknown;
};

export type NinjaCursorReport<T> = { cursor?: { name?: string; offset?: number; count?: number; expires?: number }; results: T[] };

export interface NinjaOneClient {
  readonly mode: "live" | "demo";
  testConnection(): Promise<{ ok: true; organisationCount: number; region: string; instance: string } | { ok: false; error: string }>;
  listOrganizations(after?: number, pageSize?: number): Promise<NinjaOrganizationRaw[]>;
  listLocations(orgId: number): Promise<NinjaLocationRaw[]>;
  listDevicesDetailed(after?: number, pageSize?: number, filter?: string): Promise<NinjaDeviceRaw[]>;
  getDevice(deviceId: number): Promise<NinjaDeviceRaw | null>;
  /** Returns a page of health results and the cursor name for the next page. */
  deviceHealth(cursor?: string, pageSize?: number): Promise<{ results: NinjaDeviceHealthRaw[]; nextCursor: string | null }>;
  /** Deep link to a device or organisation in the NinjaOne console. */
  consoleUrl(kind: "device" | "organization", id: string | number): string;
}

/** Node classes from the OpenAPI enum, in the order shown in the UI. */
export const NINJA_NODE_CLASSES = [
  "WINDOWS_WORKSTATION",
  "WINDOWS_SERVER",
  "MAC",
  "MAC_SERVER",
  "LINUX_WORKSTATION",
  "LINUX_SERVER",
  "VMWARE_VM_GUEST",
  "VMWARE_VM_HOST",
  "HYPERV_VMM_GUEST",
  "HYPERV_VMM_HOST",
  "NMS_SWITCH",
  "NMS_ROUTER",
  "NMS_FIREWALL",
  "NMS_PRINTER",
  "NMS_OTHER",
  "CLOUD_MONITOR_TARGET",
  "ANDROID",
  "APPLE_IOS",
];
