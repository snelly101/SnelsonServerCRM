import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { billingDiscrepancies } from "@/db/schema";
import { logActivity } from "@/lib/audit";
import { PROVIDER_LABELS, type MatchableLine, type ProviderKey } from "@/lib/billing-model";
import { reopenExpiredExceptions } from "./ninjaone";
import { autoMatcher, registerContext } from "./service-register";
import { resolveService } from "./service-links";

/**
 * The quantity check for every provider whose services map one by one to
 * lines (Pax8 licences, 20i packages and domains): for each active line,
 * the sum of the quantities of the services charged on it or bundled into
 * it, against the line's contracted quantity. A difference becomes (or
 * updates) a review item in `billing_discrepancies` with `source` = the
 * provider; matching counts resolve it; an accepted item re-opens if the gap
 * grows. NinjaOne's pooled device count keeps its own check in ninjaone.ts
 * (lines of one contract that share a scope are compared together) but
 * writes the same rows. Nothing here changes a contract or an invoice.
 */
export const DISCREPANCY_NOUNS: Record<string, string> = { pax8: "Licence", twentyi: "Hosting", ninjaone: "Device" };

export async function runQuantityChecks(actorUserId: string | null, opts: { companyId?: string; providers?: ProviderKey[] } = {}) {
  await reopenExpiredExceptions();
  const providers = opts.providers ?? ["pax8", "twentyi"];
  const ctx = await registerContext(opts.companyId ? [opts.companyId] : null, providers);
  const observed = new Map<string, { line: MatchableLine; companyId: string; provider: ProviderKey; observed: number; serviceKeys: string[] }>();
  for (const s of ctx.services) {
    if (s.pool) continue;
    const lines = ctx.lines.get(s.companyId) ?? [];
    const r = resolveService(s, ctx.links.get(s.key), lines, autoMatcher(s.source));
    if ((r.state !== "charged" && r.state !== "bundle") || !r.lineId) continue;
    const line = lines.find((l) => l.id === r.lineId);
    if (!line || line.contractStatus !== "active") continue;
    const key = `${s.provider}:${line.id}`;
    const cur = observed.get(key) ?? { line, companyId: s.companyId, provider: s.provider, observed: 0, serviceKeys: [] };
    cur.observed += s.quantity;
    cur.serviceKeys.push(s.key);
    observed.set(key, cur);
  }
  let open = 0;
  let resolvedCount = 0;
  const now = new Date();
  // Items for lines no longer covered by any service of the provider are resolved: there is nothing left to compare.
  const stale = await db
    .select({ id: billingDiscrepancies.id, source: billingDiscrepancies.source, contractLineId: billingDiscrepancies.contractLineId, companyId: billingDiscrepancies.companyId })
    .from(billingDiscrepancies)
    .where(and(inArray(billingDiscrepancies.source, providers), inArray(billingDiscrepancies.status, ["open", "accepted"]), opts.companyId ? eq(billingDiscrepancies.companyId, opts.companyId) : undefined));
  for (const d of stale) {
    if (observed.has(`${d.source}:${d.contractLineId}`)) continue;
    await db.update(billingDiscrepancies).set({ status: "resolved", note: "No service of this provider is charged on the line any more", updatedAt: now }).where(eq(billingDiscrepancies.id, d.id));
    resolvedCount++;
  }
  for (const { line, companyId, provider, observed: obs, serviceKeys } of observed.values()) {
    const contracted = Number(line.quantity);
    const diff = obs - contracted;
    const [existing] = await db.select().from(billingDiscrepancies).where(and(eq(billingDiscrepancies.source, provider), eq(billingDiscrepancies.contractLineId, line.id), inArray(billingDiscrepancies.status, ["open", "accepted"]))).orderBy(desc(billingDiscrepancies.detectedAt)).limit(1);
    const basis = { source: provider, serviceKeys, quantityRule: line.quantityRule, checkedAt: now.toISOString() };
    if (diff === 0) {
      if (existing) {
        await db.update(billingDiscrepancies).set({ status: "resolved", observedQty: obs, difference: "0", note: "Counts now match", lastSeenAt: now, updatedAt: now }).where(eq(billingDiscrepancies.id, existing.id));
        resolvedCount++;
      }
      continue;
    }
    if (existing) {
      const changed = existing.observedQty !== obs;
      await db.update(billingDiscrepancies).set({ observedQty: obs, contractedQty: String(contracted), difference: String(diff), lineDescription: line.description, lastSeenAt: now, basis, status: existing.status === "accepted" && changed && Math.abs(diff) > Math.abs(Number(existing.difference)) ? "open" : existing.status, updatedAt: now }).where(eq(billingDiscrepancies.id, existing.id));
      if (existing.status === "open") open++;
    } else {
      await db.insert(billingDiscrepancies).values({ source: provider, companyId, contractId: line.contractId, contractLineId: line.id, siteId: null, lineDescription: line.description, contractedQty: String(contracted), observedQty: obs, difference: String(diff), unitPrice: line.unitPrice, basis });
      await logActivity({ type: "sync", companyId, entityType: "contract", entityId: line.contractId, title: `${DISCREPANCY_NOUNS[provider]} count ${line.quantityRule === "synced" ? "change" : "discrepancy"}: ${line.description} contracted ${contracted}, ${PROVIDER_LABELS[provider]} has ${obs} (${diff > 0 ? "+" : ""}${diff})`, actorUserId, source: provider });
      open++;
    }
  }
  return { open, resolved: resolvedCount, checked: observed.size };
}
