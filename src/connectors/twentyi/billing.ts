import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { hostingItems } from "@/db/schema";
import { getTwentyIClient } from "./index";
import type { BillingAdapter, SuppliedService } from "@/lib/billing-model";

/**
 * 20i as a supplier: every active package and domain of a linked company is
 * one service with quantity 1. 20i's own pricing is not read, so cost is
 * unknown rather than zero. A line is matched by rule when its description
 * names the package or domain.
 */
export const twentyIBillingAdapter: BillingAdapter = {
  provider: "twentyi",
  async services(companyIds) {
    if (companyIds && companyIds.length === 0) return [];
    const [resolved, items] = await Promise.all([
      getTwentyIClient(),
      db
        .select()
        .from(hostingItems)
        .where(and(sql`${hostingItems.companyId} is not null`, companyIds ? inArray(hostingItems.companyId, companyIds) : undefined, eq(hostingItems.externalStatus, "active"), inArray(hostingItems.kind, ["package", "domain"]))),
    ]);
    return items.map(
      (h): SuppliedService => ({
        key: `hosting_item:${h.id}`,
        source: "hosting_item",
        rowId: h.id,
        provider: "twentyi",
        companyId: h.companyId!,
        kind: h.kind === "package" ? "Hosting package" : "Domain",
        name: h.name,
        supplierProduct: h.typeName ?? null,
        detail: h.typeName ?? null,
        quantity: 1,
        monthlyCost: null,
        costKnown: false,
        renewsOn: h.expiresOn,
        status: h.enabled === false ? "disabled" : "active",
        syncedAt: h.fetchedAt,
        href: `/companies/${h.companyId}?tab=billing#services`,
        consoleUrl: h.kind === "package" || h.kind === "domain" ? (resolved?.client.consoleUrl(h.kind, h.externalId) ?? null) : null,
        pool: false,
      }),
    );
  },
  autoMatch(service, lines) {
    const name = service.name.toLowerCase();
    const byName = lines.find((l) => l.description.toLowerCase().includes(name));
    return byName ? { lineId: byName.id, by: "name" } : null;
  },
};
