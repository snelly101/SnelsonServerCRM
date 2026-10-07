import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { ninjaDevices } from "@/db/schema";
import { getAppSettings } from "@/lib/settings";
import { getNinjaOneClient } from "./index";
import type { BillingAdapter, SuppliedService } from "@/lib/billing-model";

/**
 * NinjaOne as a supplier of counts: one pooled "managed devices" service per
 * linked company whose quantity is the billable device count under the
 * counting rules (active window, billable classes, approval). NinjaOne has no
 * pricing, so cost is unknown. The pool matches, by rule, the per-device
 * lines marked "compare with NinjaOne"; a device that needs its own answer
 * (an engineer's laptop, a free loaner) gets a link of its own and leaves the
 * pool's count.
 */
export const ninjaOneBillingAdapter: BillingAdapter = {
  provider: "ninjaone",
  async services(companyIds) {
    if (companyIds && companyIds.length === 0) return [];
    const [settings, resolved] = await Promise.all([getAppSettings(), getNinjaOneClient()]);
    const classes = resolved?.config.billableNodeClasses ?? [];
    const approvedOnly = resolved?.config.approvedOnly ?? true;
    const cutoff = new Date(Date.now() - settings.deviceActiveDays * 86400000);
    const devices = await db
      .select({ id: ninjaDevices.id, companyId: ninjaDevices.companyId, displayName: ninjaDevices.displayName, systemName: ninjaDevices.systemName, nodeClass: ninjaDevices.nodeClass, fetchedAt: ninjaDevices.fetchedAt })
      .from(ninjaDevices)
      .where(and(sql`${ninjaDevices.companyId} is not null`, companyIds ? inArray(ninjaDevices.companyId, companyIds) : undefined, eq(ninjaDevices.externalStatus, "active"), sql`${ninjaDevices.lastContact} >= ${cutoff}`, classes.length ? inArray(ninjaDevices.nodeClass, classes) : sql`false`, approvedOnly ? or(eq(ninjaDevices.approvalStatus, "APPROVED"), isNull(ninjaDevices.approvalStatus)) : undefined));
    const byCompany = new Map<string, typeof devices>();
    for (const d of devices) byCompany.set(d.companyId!, [...(byCompany.get(d.companyId!) ?? []), d]);
    return [...byCompany].map(
      ([cid, list]): SuppliedService => ({
        key: `ninja_device:${cid}`,
        source: "ninja_device",
        rowId: cid,
        provider: "ninjaone",
        companyId: cid,
        kind: "Managed devices",
        name: `${list.length} billable device${list.length === 1 ? "" : "s"} at NinjaOne`,
        supplierProduct: classes.join(", ") || null,
        detail: `active within ${settings.deviceActiveDays} days${approvedOnly ? ", approved" : ""}`,
        quantity: list.length,
        monthlyCost: null,
        costKnown: false,
        renewsOn: null,
        status: "active",
        syncedAt: list.reduce<Date | null>((a, d) => (!a || d.fetchedAt > a ? d.fetchedAt : a), null),
        href: `/companies/${cid}?tab=devices`,
        consoleUrl: null,
        pool: true,
        members: list.map((d) => ({ id: d.id, name: d.displayName ?? d.systemName ?? d.id, detail: d.nodeClass.toLowerCase().replace(/_/g, " ") })),
      }),
    );
  },
  autoMatch(_service, lines) {
    const line = lines.find((l) => l.countsAsManagedDevice);
    return line ? { lineId: line.id, by: "name" } : null;
  },
};
