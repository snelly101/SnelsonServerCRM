import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { pax8Subscriptions } from "@/db/schema";
import { termMonths } from "./types";
import { getPax8Client } from "./index";
import { matchBySkuOrName, type BillingAdapter, type SuppliedService } from "@/lib/billing-model";

/** Subscription statuses that are being supplied (and so should be paid for). */
export const BILLED_STATUSES = ["Active", "Activated", "PendingCancel"];

/** Monthly partner cost per unit, from the per-term price. Null for one-off or unknown terms. */
export function monthlyUnitCost(price: string | number | null, billingTerm: string | null): number | null {
  const p = price === null || price === "" ? null : Number(price);
  const months = termMonths(billingTerm);
  if (p === null || Number.isNaN(p) || !months) return null;
  return p / months;
}

/**
 * Pax8 as a supplier: every billed subscription of a linked company is a
 * service with a licence count and a partner cost per month.
 */
export const pax8BillingAdapter: BillingAdapter = {
  provider: "pax8",
  async services(companyIds) {
    if (companyIds && companyIds.length === 0) return [];
    const [resolved, subs] = await Promise.all([
      getPax8Client(),
      db
        .select()
        .from(pax8Subscriptions)
        .where(and(sql`${pax8Subscriptions.companyId} is not null`, companyIds ? inArray(pax8Subscriptions.companyId, companyIds) : undefined, eq(pax8Subscriptions.externalStatus, "active"), inArray(pax8Subscriptions.status, BILLED_STATUSES))),
    ]);
    return subs.map((s): SuppliedService => {
      const unit = monthlyUnitCost(s.price, s.billingTerm);
      return {
        key: `pax8_subscription:${s.id}`,
        source: "pax8_subscription",
        rowId: s.id,
        provider: "pax8",
        companyId: s.companyId!,
        kind: s.vendorName ? `${s.vendorName} subscription` : "Subscription",
        name: s.productName,
        supplierProduct: s.sku ?? s.vendorSku ?? null,
        matchKeys: [s.sku, s.vendorSku].filter((x): x is string => Boolean(x)),
        detail: [s.sku, s.billingTerm].filter(Boolean).join(" · ") || null,
        quantity: s.quantity,
        monthlyCost: unit === null ? null : Math.round(unit * s.quantity * 100) / 100,
        costKnown: true,
        renewsOn: s.commitmentEndsOn,
        status: s.status,
        syncedAt: s.fetchedAt,
        href: `/companies/${s.companyId}?tab=billing#services`,
        consoleUrl: resolved?.client.consoleUrl("subscription", s.subscriptionId) ?? null,
        pool: false,
      };
    });
  },
  autoMatch(service, lines) {
    return matchBySkuOrName(service.matchKeys ?? [service.supplierProduct], service.name, lines);
  },
};
