import { describe, expect, it, beforeAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { billingDiscrepancies, companies, ninjaDevices, ninjaOrganizations, sites } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { LiveNinjaOneClient, ninjaTime } from "@/connectors/ninjaone/live";
import { demoNinjaAddDevice, demoNinjaDeviceIds, demoNinjaRemoveDevice, demoNinjaReset } from "@/connectors/ninjaone/demo";
import { companyDeviceOverview, deviceFreshness, deviceTotals, importAllOrganizations, importOrganizationAsCompany, linkLocation, linkOrganization, listDevices, listDiscrepancies, ninjaConnectionSummary, ninjaMappingOverview, reviewDiscrepancy, runDiscrepancyCheck, saveNinjaConfig, syncNinjaOne, unlinkOrganization } from "@/services/ninjaone";
import { getLink, listOpenConflicts } from "@/services/integrations";
import { ActionError } from "@/lib/action-result";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "ninja admin");
  demoNinjaReset();
});

describe("NinjaOne live client (read-only)", () => {
  it("fetches a client_credentials token once for concurrent calls, sends it as Bearer, and re-fetches on 401", async () => {
    let tokenCalls = 0;
    let apiCalls = 0;
    const saved: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/ws/oauth/token")) {
        tokenCalls++;
        const body = String(init?.body);
        expect(body).toContain("grant_type=client_credentials");
        expect(body).toContain("scope=monitoring");
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ access_token: `tok-${tokenCalls}`, expires_in: 3600, token_type: "bearer" }), { headers: { "content-type": "application/json" } });
      }
      apiCalls++;
      const auth = String((init?.headers as Record<string, string>).Authorization);
      if (auth === "Bearer tok-1" && apiCalls > 2) return new Response("expired", { status: 401 });
      expect(init?.method ?? "GET").toBe("GET");
      if (u.includes("/organizations")) return new Response(JSON.stringify([{ id: 1, name: "A" }, { id: 2, name: "B" }]), { headers: { "content-type": "application/json" } });
      if (u.includes("/queries/device-health")) return new Response(JSON.stringify({ cursor: { name: "c2", offset: 0, count: 1, expires: 0 }, results: [{ deviceId: 5, healthStatus: "HEALTHY" }] }), { headers: { "content-type": "application/json" } });
      return new Response("[]", { headers: { "content-type": "application/json" } });
    });
    const client = new LiveNinjaOneClient({ clientId: "id", clientSecret: "secret", region: "eu" }, null, async (t) => void saved.push(t.accessToken), fetchImpl as unknown as typeof fetch);
    const [a, b] = await Promise.all([client.listOrganizations(), client.listOrganizations()]);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(tokenCalls).toBe(1);
    expect(saved).toEqual(["tok-1"]);
    expect(String(fetchImpl.mock.calls[1][0])).toMatch(/^https:\/\/eu\.ninjarmm\.com\/api\/v2\/organizations/);
    // Third call is rejected with 401 → token refreshed once and the call retried.
    const orgs = await client.listOrganizations();
    expect(orgs).toHaveLength(2);
    expect(tokenCalls).toBe(2);
    // Health cursor paging: fewer results than pageSize means no next cursor.
    const health = await client.deviceHealth(undefined, 500);
    expect(health.results[0].healthStatus).toBe("HEALTHY");
    expect(health.nextCursor).toBeNull();
    // No method on the client performs a write.
    for (const m of Object.getOwnPropertyNames(LiveNinjaOneClient.prototype)) expect(m).not.toMatch(/create|update|delete|reboot|run|set/i);
  });

  it("converts epoch-second timestamps and rejects junk", () => {
    expect(ninjaTime(1_700_000_000)?.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(ninjaTime(0)).toBeNull();
    expect(ninjaTime("x")).toBeNull();
  });

  it("freshness labels are derived from the fetch time", () => {
    expect(deviceFreshness(null)).toBe("unavailable");
    expect(deviceFreshness(new Date())).toBe("live");
    expect(deviceFreshness(new Date(Date.now() - 30 * 60_000))).toBe("cached");
    expect(deviceFreshness(new Date(Date.now() - 5 * 3600_000))).toBe("stale");
  });
});

describe("NinjaOne sync, mapping and discrepancies (demo adapter)", () => {
  let dentalId: string;
  let freightId: string;
  let headOfficeId: string;
  let branchId: string;

  it("is never reported as connected in demo mode", async () => {
    const s = await ninjaConnectionSummary();
    expect(s.demo).toBe(true);
    expect(s.configured).toBe(true);
    expect(s.status).toBe("not_configured");
  });

  it("mirrors organisations, locations, devices and health; second run is idempotent", async () => {
    const first = await syncNinjaOne("manual", admin.id);
    expect(first?.status).toBe("success");
    expect(first?.counters.created).toBeGreaterThan(190);
    const orgs = await db.select().from(ninjaOrganizations);
    expect(orgs.map((o) => o.orgId).sort()).toEqual(["101", "102", "103", "104", "105", "106"]);
    const second = await syncNinjaOne("manual", admin.id);
    expect(second?.counters.created).toBe(0);
    const [d] = await db.select().from(ninjaDevices).where(eq(ninjaDevices.displayName, "HDP-SRV1"));
    expect(d.nodeClass).toBe("WINDOWS_SERVER");
    expect(d.osName).toBe("Windows Server 2022");
    expect(d.healthStatus).toMatch(/HEALTHY|NEEDS_ATTENTION/);
    expect(d.companyId).toBeNull(); // nothing is mapped until a person links it
    const totals = await deviceTotals();
    expect(totals.unmapped).toBe(totals.total);
  });

  it("suggests companies by name but never auto-links; linking assigns devices and site links require the org link", async () => {
    dentalId = await createCompany(companySchema.parse({ name: "Harrowgate Dental Practice" }), admin.id);
    freightId = await createCompany(companySchema.parse({ name: "Northern Freight Solutions Ltd" }), admin.id);
    const [ho] = await db.insert(sites).values({ companyId: freightId, name: "Head office", isPrimary: true }).returning({ id: sites.id });
    const [br] = await db.insert(sites).values({ companyId: freightId, name: "Branch office" }).returning({ id: sites.id });
    headOfficeId = ho.id;
    branchId = br.id;
    const overview = await ninjaMappingOverview();
    const dental = overview.organisations.find((o) => o.orgId === "101")!;
    expect(dental.link).toBeNull();
    expect(dental.suggestions[0]).toMatchObject({ id: dentalId, score: 2 });
    const freight = overview.organisations.find((o) => o.orgId === "102")!;
    expect(freight.suggestions[0]).toMatchObject({ id: freightId });
    expect(freight.suggestions[0].score).toBe(2); // legal suffixes are normalised away
    await expect(linkLocation("1021", headOfficeId, admin.id)).rejects.toThrow(/Link the site's company/);

    await linkOrganization("101", dentalId, admin.id);
    await linkOrganization("102", freightId, admin.id);
    await linkLocation("1021", headOfficeId, admin.id);
    await linkLocation("1022", branchId, admin.id);
    expect((await getLink("ninjaone", "company", dentalId))?.externalId).toBe("101");
    const dentalDevices = await listDevices({ companyId: dentalId, pageSize: 100 });
    expect(dentalDevices.total).toBe(20);
    const branchDevices = await db.select().from(ninjaDevices).where(eq(ninjaDevices.siteId, branchId));
    expect(branchDevices).toHaveLength(8);
    // One org cannot be linked to two companies
    const other = await createCompany(companySchema.parse({ name: "Someone Else" }), admin.id);
    await expect(linkOrganization("101", other, admin.id)).rejects.toThrow();
  });

  it("counts only active, approved, billable-class devices and opens discrepancies per compared line", async () => {
    const line = (description: string, quantity: number, siteId: string | null = null) => ({ id: null, productId: null, siteId, description, revenueType: "recurring" as const, pricingModel: "per_device" as const, billingFrequency: "monthly" as const, quantity, unitPrice: 12, unitCost: 4, countsAsManagedDevice: true });
    const dentalContract = await createContract(contractSchema.parse({ companyId: dentalId, name: "MSA", startDate: "2026-01-01", status: "active" }), [line("Managed device", 18), { ...line("Users", 14), pricingModel: "per_user", countsAsManagedDevice: false }], admin.id);
    const freightContract = await createContract(contractSchema.parse({ companyId: freightId, name: "MSA", startDate: "2026-01-01", status: "active" }), [line("Managed device", 40), line("Branch EDR", 8, branchId), line("Head office EDR", 30, headOfficeId)], admin.id);
    const r = await runDiscrepancyCheck(admin.id);
    expect(r.checked).toBe(4);
    const open = await listDiscrepancies({ status: "open" });
    // Dental: 19 active workstations/servers (stale laptop excluded) vs 18 → +1
    const dental = open.find((d) => d.contractId === dentalContract)!;
    expect(dental).toMatchObject({ observedQty: 19, contractedQty: "18.00", difference: "1.00" });
    // Freight: 38 billable active (printer/switch/VM host excluded) vs 40 → -2; branch 8 = 8 (no item); head office 30 = 30
    const freight = open.filter((d) => d.contractId === freightContract);
    expect(freight).toHaveLength(1);
    expect(freight[0]).toMatchObject({ lineDescription: "Managed device", observedQty: 38, difference: "-2.00" });
    const overview = await companyDeviceOverview(freightId);
    expect(overview?.totals.billable).toBe(38);
    expect(overview?.totals.total).toBe(41);
  });

  it("re-running with matching counts resolves the item; accepted items re-open only when the gap grows", async () => {
    const [dental] = await listDiscrepancies({ companyId: dentalId, status: "open" });
    await reviewDiscrepancy(dental.id, "accepted", "Adding a device to the contract next month", admin.id);
    // Gap unchanged → stays accepted
    await runDiscrepancyCheck(admin.id, dentalId);
    expect((await db.select().from(billingDiscrepancies).where(eq(billingDiscrepancies.id, dental.id)))[0].status).toBe("accepted");
    // Gap grows → re-opens
    demoNinjaAddDevice(101, 1011, "HDP-NEW-PC");
    await syncNinjaOne("manual", admin.id);
    expect((await db.select().from(billingDiscrepancies).where(eq(billingDiscrepancies.id, dental.id)))[0]).toMatchObject({ status: "open", observedQty: 20 });
    // Remove two devices → 18 = 18 → resolved
    const ids = demoNinjaDeviceIds(101);
    const [a] = await db.select().from(ninjaDevices).where(eq(ninjaDevices.displayName, "HDP-NEW-PC"));
    demoNinjaRemoveDevice(Number(a.deviceId));
    const [b] = await db.select().from(ninjaDevices).where(eq(ninjaDevices.displayName, "HDP-PC19"));
    demoNinjaRemoveDevice(Number(b.deviceId));
    expect(ids.length).toBeGreaterThan(0);
    await syncNinjaOne("manual", admin.id);
    expect((await db.select().from(billingDiscrepancies).where(eq(billingDiscrepancies.id, dental.id)))[0]).toMatchObject({ status: "resolved", observedQty: 18 });
    // Removed devices are kept, flagged as deleted, and excluded from active lists
    const gone = await db.select().from(ninjaDevices).where(and(eq(ninjaDevices.orgId, "101"), eq(ninjaDevices.externalStatus, "deleted")));
    expect(gone).toHaveLength(2);
    expect((await listDevices({ companyId: dentalId, status: "deleted" })).total).toBe(2);
    expect((await listDevices({ companyId: dentalId })).rows.every((d) => d.externalStatus === "active")).toBe(true);
  });

  it("counting rules are configurable and re-checked on save", async () => {
    await saveNinjaConfig({ billableNodeClasses: ["WINDOWS_WORKSTATION", "WINDOWS_SERVER", "MAC", "NMS_PRINTER", "NMS_SWITCH", "VMWARE_VM_HOST"], approvedOnly: true }, admin.id);
    const freight = (await listDiscrepancies({ companyId: freightId, status: "all" })).find((d) => d.lineDescription === "Managed device")!;
    expect(freight).toMatchObject({ observedQty: 41, difference: "1.00", status: "open" });
    await saveNinjaConfig({ billableNodeClasses: ["WINDOWS_WORKSTATION", "WINDOWS_SERVER", "MAC", "MAC_SERVER", "LINUX_WORKSTATION", "LINUX_SERVER", "VMWARE_VM_GUEST", "HYPERV_VMM_GUEST"], approvedOnly: true }, admin.id);
  });

  it("unlinking clears device ownership, site links and open items; a missing organisation raises a conflict", async () => {
    await unlinkOrganization(freightId, admin.id);
    expect(await getLink("ninjaone", "company", freightId)).toBeNull();
    expect(await getLink("ninjaone", "site", branchId)).toBeNull();
    expect((await db.select().from(ninjaDevices).where(eq(ninjaDevices.companyId, freightId))).length).toBe(0);
    expect((await listDiscrepancies({ companyId: freightId, status: "open" })).length).toBe(0);
    // Site link for an org that is not linked is refused with a readable message
    await expect(linkLocation("1022", branchId, admin.id)).rejects.toBeInstanceOf(ActionError);
    // Org disappears from NinjaOne → marked deleted, conflict raised because it is linked
    const before = (await listOpenConflicts()).length;
    const { DemoNinjaOneClient } = await import("@/connectors/ninjaone/demo");
    const original = DemoNinjaOneClient.prototype.listOrganizations;
    DemoNinjaOneClient.prototype.listOrganizations = async function (after = 0, pageSize = 200) {
      return (await original.call(this, after, pageSize)).filter((o) => o.id !== 101);
    };
    try {
      await syncNinjaOne("manual", admin.id);
    } finally {
      DemoNinjaOneClient.prototype.listOrganizations = original;
    }
    const [org] = await db.select().from(ninjaOrganizations).where(eq(ninjaOrganizations.orgId, "101"));
    expect(org.externalStatus).toBe("deleted");
    expect((await listOpenConflicts()).length).toBe(before + 1);
    await syncNinjaOne("manual", admin.id);
    expect((await db.select().from(ninjaOrganizations).where(eq(ninjaOrganizations.orgId, "101")))[0].externalStatus).toBe("active");
  });

  it("creates companies from organisations, linking an obvious existing company instead of duplicating; idempotent", async () => {
    // Northern Freight was unlinked above; its company still exists → link rather than create
    const freight = await importOrganizationAsCompany("102", admin.id);
    expect(freight).toMatchObject({ action: "linked", companyId: freightId });
    expect((await importOrganizationAsCompany("102", admin.id)).action).toBe("skipped");
    const internal = await importOrganizationAsCompany("106", admin.id);
    expect(internal.action).toBe("created");
    const [co] = await db.select().from(companies).where(eq(companies.id, internal.companyId!));
    expect(co).toMatchObject({ name: "Internal - Snelson Server", status: "customer" });
    expect((await getLink("ninjaone", "company", co.id))?.externalId).toBe("106");
    expect((await db.select().from(ninjaDevices).where(eq(ninjaDevices.companyId, co.id))).length).toBe(6);
    const all = await importAllOrganizations(admin.id);
    expect(all.results.every((r) => r.action !== "skipped" || r.reason === "already linked" || /already linked to another/.test(r.reason ?? ""))).toBe(true);
    const again = await importAllOrganizations(admin.id);
    expect(again.created + again.linked).toBe(0);
  });
});
