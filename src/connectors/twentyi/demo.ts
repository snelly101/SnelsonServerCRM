import { TWENTYI_CONSOLE, type TwentyIClient, type TwentyIDomainRaw, type TwentyIMailboxRaw, type TwentyIPackageRaw } from "./types";

/**
 * DEMO adapter for 20i: a reseller account with a handful of packages, the
 * domains behind them and a few mailboxes. Read-only like the live client.
 * Never reports as connected. Names line up with the seed companies so the
 * auto-matcher has something to link; two are deliberately unmatched.
 */
const iso = (daysFromNow: number) => new Date(Date.now() + daysFromNow * 86400000).toISOString();
const dateOnly = (daysFromNow: number) => iso(daysFromNow).slice(0, 10);

const packages: TwentyIPackageRaw[] = [
  { id: 900101, name: "harrowgatedental.co.uk", names: ["harrowgatedental.co.uk", "www.harrowgatedental.co.uk"], packageTypeName: "Linux Unlimited", typeRef: 811, enabled: true, created: iso(-820), stackUsers: ["stack-user:5101"], packageLabels: ["managed"] },
  { id: 900102, name: "northernfreight.co.uk", names: ["northernfreight.co.uk", "portal.northernfreight.co.uk"], packageTypeName: "WordPress Unlimited", typeRef: 812, enabled: true, created: iso(-410), stackUsers: ["stack-user:5102"], packageLabels: [] },
  { id: 900103, name: "ridgewayarch.com", names: ["ridgewayarch.com"], packageTypeName: "Linux Unlimited", typeRef: 811, enabled: true, created: iso(-1200), stackUsers: ["stack-user:5103"], packageLabels: [] },
  { id: 900104, name: "greenfieldacademy.org.uk", names: ["greenfieldacademy.org.uk"], packageTypeName: "Linux Unlimited", typeRef: 811, enabled: true, created: iso(-300), stackUsers: ["stack-user:5104"], packageLabels: ["education"] },
  { id: 900105, name: "bramleyaccountants.co.uk", names: ["bramleyaccountants.co.uk"], packageTypeName: "Linux Unlimited", typeRef: 811, enabled: false, created: iso(-1500), stackUsers: ["stack-user:5105"], packageLabels: ["suspended"] },
  { id: 900106, name: "yorkshirecraftbeer.co.uk", names: ["yorkshirecraftbeer.co.uk"], packageTypeName: "Linux Unlimited", typeRef: 811, enabled: true, created: iso(-95), stackUsers: ["stack-user:5106"], packageLabels: [] },
  { id: 900107, name: "snelsonserver.com", names: ["snelsonserver.com", "crm.snelsonserver.com"], packageTypeName: "Managed VPS", typeRef: 950, enabled: true, created: iso(-2000), stackUsers: ["stack-user:1"], packageLabels: ["internal"] },
];

const domains: TwentyIDomainRaw[] = [
  { id: 700101, name: "harrowgatedental.co.uk", expiryDate: dateOnly(24), deadDate: dateOnly(24 + 90), closeToAnniversary: true, hasPrivacy: false, registrantIsVerified: true },
  { id: 700102, name: "northernfreight.co.uk", expiryDate: dateOnly(210), deadDate: dateOnly(300), closeToAnniversary: false, hasPrivacy: false, registrantIsVerified: true },
  { id: 700103, name: "northernfreight.com", expiryDate: dateOnly(12), deadDate: dateOnly(52), closeToAnniversary: true, hasPrivacy: true, registrantIsVerified: true },
  { id: 700104, name: "ridgewayarch.com", expiryDate: dateOnly(140), deadDate: dateOnly(180), closeToAnniversary: false, hasPrivacy: true, registrantIsVerified: true },
  { id: 700105, name: "greenfieldacademy.org.uk", expiryDate: dateOnly(330), deadDate: dateOnly(420), closeToAnniversary: false, hasPrivacy: false, registrantIsVerified: true },
  { id: 700106, name: "bramleyaccountants.co.uk", expiryDate: dateOnly(-5), deadDate: dateOnly(85), closeToAnniversary: true, hasPrivacy: false, registrantIsVerified: false },
  { id: 700107, name: "yorkshirecraftbeer.co.uk", expiryDate: dateOnly(280), deadDate: dateOnly(370), closeToAnniversary: false, hasPrivacy: false, registrantIsVerified: true },
  { id: 700108, name: "snelsonserver.com", expiryDate: dateOnly(400), deadDate: dateOnly(440), closeToAnniversary: false, hasPrivacy: true, registrantIsVerified: true },
];

const mailboxes: Record<string, TwentyIMailboxRaw[]> = {
  "900101:harrowgatedental.co.uk": [{ id: 1, local: "reception", domain: "harrowgatedental.co.uk", forUser: null }, { id: 2, local: "accounts", domain: "harrowgatedental.co.uk", forUser: null }],
  "900102:northernfreight.co.uk": [{ id: 3, local: "info", domain: "northernfreight.co.uk", forUser: null }],
  "900106:yorkshirecraftbeer.co.uk": [{ id: 4, local: "hello", domain: "yorkshirecraftbeer.co.uk", forUser: null }, { id: 5, local: "orders", domain: "yorkshirecraftbeer.co.uk", forUser: null }],
};

const gb = (n: number) => Math.round(n * 1024 ** 3);
const usage: Record<string, { diskUsedBytes: number; diskLimitBytes: number | null }> = {
  "900101": { diskUsedBytes: gb(1.4), diskLimitBytes: null },
  "900102": { diskUsedBytes: gb(6.2), diskLimitBytes: null },
  "900103": { diskUsedBytes: gb(0.6), diskLimitBytes: null },
  "900104": { diskUsedBytes: gb(2.1), diskLimitBytes: null },
  "900107": { diskUsedBytes: gb(18), diskLimitBytes: gb(80) },
};

export class DemoTwentyIClient implements TwentyIClient {
  readonly mode = "demo" as const;
  async testConnection() {
    return { ok: true as const, resellerId: "demo-reseller", packageCount: packages.length };
  }
  async listPackages() {
    return packages.map((p) => ({ ...p }));
  }
  async listDomains() {
    return domains.map((d) => ({ ...d }));
  }
  async listMailboxes(packageId: string | number, domain: string) {
    return (mailboxes[`${packageId}:${domain}`] ?? []).map((m) => ({ ...m }));
  }
  async packageUsage(packageId: string | number) {
    const u = usage[String(packageId)];
    return u ? { ...u, raw: { diskUsage: u.diskUsedBytes } } : null;
  }
  consoleUrl(kind: "package" | "domain", id: string | number) {
    return kind === "package" ? `${TWENTYI_CONSOLE}/services/manage/${id}` : `${TWENTYI_CONSOLE}/domains/manage/${id}`;
  }
}

/** Test hooks. */
export function demoTwentyIPackageIds() {
  return packages.map((p) => String(p.id));
}
