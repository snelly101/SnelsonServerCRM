import { describe, expect, it, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contractLines, hostingItems, serviceLinks } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { createContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { syncPax8, companySubscriptionOverview, runLicenceCheck } from "@/services/pax8";
import { syncTwentyI, hostingTotals, companyHostingOverview } from "@/services/twentyi";
import { syncNinjaOne, linkOrganization, deviceTotals, runDiscrepancyCheck, listDiscrepancies, listDevices } from "@/services/ninjaone";
import { clearServiceCoverage, companyServiceRegister, serviceRegister, setServiceCoverage } from "@/services/service-register";
import { ActionError } from "@/lib/action-result";
import { makeUser } from "./helpers";

let admin: { id: string };
let dental: string;

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "register admin");
});

const line = (over: Record<string, unknown>) => ({ id: null, productId: null, siteId: null, description: "x", revenueType: "recurring" as const, pricingModel: "per_user" as const, billingFrequency: "monthly" as const, quantity: 1, unitPrice: 10, unitCost: null, countsAsManagedDevice: false, ...over });

describe("service register (demo adapters)", () => {
  it("lists every supplied service with a derived state, and explicit coverage changes what the engines count", async () => {
    dental = await createCompany(companySchema.parse({ name: "Harrowgate Dental Practice", status: "customer", website: "https://www.harrowgatedental.co.uk" }), admin.id);
    const contractId = await createContract(
      contractSchema.parse({ companyId: dental, name: "Managed IT", startDate: "2026-01-01", status: "active" }),
      [line({ description: "Microsoft 365 Business Standard", quantity: 14, unitPrice: 12 }), line({ description: "Managed user", quantity: 14, unitPrice: 30 }), line({ description: "Managed device", pricingModel: "per_device", quantity: 18, unitPrice: 12, countsAsManagedDevice: true })],
      admin.id,
    );
    const lines = await db.select().from(contractLines).where(eq(contractLines.contractId, contractId));
    const managedUser = lines.find((l) => l.description === "Managed user")!;
    await syncPax8("manual", admin.id);
    await syncTwentyI("manual", admin.id);
    await syncNinjaOne("manual", admin.id);
    await linkOrganization("101", dental, admin.id);
    await runDiscrepancyCheck(admin.id, dental);

    const before = await companyServiceRegister(dental);
    const acronis = before.rows.find((r) => r.source === "pax8_subscription" && /Acronis/i.test(r.name))!;
    const standard = before.rows.find((r) => r.source === "pax8_subscription" && /Business Standard/i.test(r.name))!;
    expect(standard.state).toBe("charged"); // matched by product name
    expect(acronis.state).toBe("unmapped"); // nothing bills it
    expect(before.rows.find((r) => r.key === `ninja_device:${dental}` && r.pool)).toMatchObject({ state: "charged", quantity: 19, matchedBy: "rule" });
    expect(before.summary.unmapped).toBeGreaterThanOrEqual(1);
    expect((await companySubscriptionOverview(dental))!.totals.unbilled).toBe(1);

    // Free needs a reason and a review date; bundle needs a line of this company.
    await expect(setServiceCoverage({ source: "pax8_subscription", sourceRowId: acronis.rowId, state: "free" }, admin.id)).rejects.toThrow(/reason/);
    await expect(setServiceCoverage({ source: "pax8_subscription", sourceRowId: acronis.rowId, state: "free", reason: "goodwill" }, admin.id)).rejects.toThrow(/review date/);
    await expect(setServiceCoverage({ source: "pax8_subscription", sourceRowId: acronis.rowId, state: "bundle" }, admin.id)).rejects.toThrow(/Choose the contract line/);
    const other = await createCompany(companySchema.parse({ name: "Someone Else Ltd" }), admin.id);
    const otherContract = await createContract(contractSchema.parse({ companyId: other, name: "Other", startDate: "2026-01-01", status: "active" }), [line({ description: "Other line" })], admin.id);
    const [otherLine] = await db.select().from(contractLines).where(eq(contractLines.contractId, otherContract));
    await expect(setServiceCoverage({ source: "pax8_subscription", sourceRowId: acronis.rowId, state: "bundle", contractLineId: otherLine.id }, admin.id)).rejects.toThrow(/different company/);

    // Bundle the backup seats into the managed-user line: no longer unbilled, and its 14 licences count toward that line in the licence check.
    await setServiceCoverage({ source: "pax8_subscription", sourceRowId: acronis.rowId, state: "bundle", contractLineId: managedUser.id, reason: "backup is part of the managed user package" }, admin.id);
    const bundled = (await companyServiceRegister(dental)).rows.find((r) => r.rowId === acronis.rowId)!;
    expect(bundled).toMatchObject({ state: "bundle", line: { id: managedUser.id }, reason: "backup is part of the managed user package" });
    const ov = (await companySubscriptionOverview(dental))!;
    expect(ov.totals.unbilled).toBe(0);
    expect(ov.subscriptions.find((s) => s.id === acronis.rowId)!.line?.id).toBe(managedUser.id);
    await runLicenceCheck(admin.id, dental);
    const open = (await listDiscrepancies({ companyId: dental, source: "pax8", status: "open" })).filter((d) => d.contractLineId === managedUser.id);
    expect(open).toHaveLength(0); // 14 bundled licences = 14 managed users

    // Switch to intentionally free: nothing counts toward the line any more, and the review date is tracked.
    await setServiceCoverage({ source: "pax8_subscription", sourceRowId: acronis.rowId, state: "free", reason: "goodwill after the March outage", reviewOn: "2020-01-01" }, admin.id);
    const free = (await companyServiceRegister(dental)).rows.find((r) => r.rowId === acronis.rowId)!;
    expect(free).toMatchObject({ state: "free", reviewOverdue: true });
    expect((await serviceRegister({ state: "review" })).rows.some((r) => r.rowId === acronis.rowId)).toBe(true);
    expect((await companySubscriptionOverview(dental))!.totals.unbilled).toBe(0);

    // Clearing goes back to the derived state.
    await clearServiceCoverage("pax8_subscription", acronis.rowId, admin.id);
    expect((await companyServiceRegister(dental)).rows.find((r) => r.rowId === acronis.rowId)!.state).toBe("unmapped");
    expect(await db.select().from(serviceLinks).where(and(eq(serviceLinks.source, "pax8_subscription"), eq(serviceLinks.sourceRowId, acronis.rowId)))).toHaveLength(0);
  });

  it("20i items: a package marked internal drops out of the linked-but-not-billed count and shows its coverage on the Hosting tab", async () => {
    const [pkg] = await db.select().from(hostingItems).where(and(eq(hostingItems.kind, "package"), eq(hostingItems.companyId, dental)));
    expect(pkg).toBeTruthy();
    const unbilledBefore = (await hostingTotals(dental)).unbilled;
    expect(unbilledBefore).toBeGreaterThanOrEqual(1);
    await setServiceCoverage({ source: "hosting_item", sourceRowId: pkg.id, state: "internal", reason: "our own staging site" }, admin.id);
    expect((await hostingTotals(dental)).unbilled).toBe(unbilledBefore - 1);
    const overview = (await companyHostingOverview(dental))!;
    expect(overview.packages.find((p) => p.id === pkg.id)!.coverage).toMatchObject({ state: "internal", reason: "our own staging site" });
    expect((await companyServiceRegister(dental)).rows.find((r) => r.rowId === pkg.id)!.state).toBe("internal");
  });

  it("devices: one marked internal leaves the billable count and the device check; lines sharing a scope are compared as one pool", async () => {
    const totalsBefore = await deviceTotals(dental);
    expect(totalsBefore.billable).toBe(19);
    const devices = await listDevices({ companyId: dental, pageSize: 100 });
    const srv = devices.rows.find((d) => d.displayName === "HDP-SRV1")!;
    await expect(setServiceCoverage({ source: "ninja_device", sourceRowId: srv.id, state: "internal" }, admin.id)).rejects.toBeInstanceOf(ActionError);
    await setServiceCoverage({ source: "ninja_device", sourceRowId: srv.id, state: "internal", reason: "our monitoring box in their rack" }, admin.id);
    expect((await deviceTotals(dental)).billable).toBe(18);
    expect((await listDevices({ companyId: dental, pageSize: 100 })).rows.find((d) => d.id === srv.id)!.coverage).toMatchObject({ state: "internal" });
    await runDiscrepancyCheck(admin.id, dental);
    expect((await listDiscrepancies({ companyId: dental, source: "ninjaone", status: "open" }))).toHaveLength(0); // 18 contracted = 18 billable now
    const reg = await companyServiceRegister(dental);
    expect(reg.rows.find((r) => r.key === `ninja_device:${dental}` && r.pool)).toMatchObject({ quantity: 18, detail: "1 marked separately" });
    expect(reg.rows.find((r) => r.key === `ninja_device:${srv.id}`)).toMatchObject({ state: "internal" });

    // Two device lines without a site on one contract: compared together against the organisation's 18 billable devices.
    const twoLines = await createContract(
      contractSchema.parse({ companyId: dental, name: "Split devices", startDate: "2026-01-01", status: "active" }),
      [line({ description: "Workstations", pricingModel: "per_device", quantity: 10, countsAsManagedDevice: true }), line({ description: "Servers", pricingModel: "per_device", quantity: 5, countsAsManagedDevice: true })],
      admin.id,
    );
    await runDiscrepancyCheck(admin.id, dental);
    const items = (await listDiscrepancies({ companyId: dental, source: "ninjaone", status: "open" })).filter((d) => d.contractId === twoLines);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ lineDescription: "Workstations + Servers", contractedQty: "15.00", observedQty: 18, difference: "3.00" });
    expect((items[0].basis as { lineIds: string[] }).lineIds).toHaveLength(2);
  });
});
