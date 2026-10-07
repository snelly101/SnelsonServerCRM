import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { companies, contractLines, contracts, hostingItems, ninjaDevices, pax8Subscriptions, products, serviceLinks, linkRoleValues, serviceSourceValues, type LinkRole, type ServiceSource, type MatchSource } from "@/db/schema";
import { audit, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { COUNTING_ROLES, NON_BILLABLE_ROLES, SERVICE_STATE_LABELS, type MatchableLine, type ServiceState, type SuppliedService } from "@/lib/billing-model";

/**
 * Service links: how each supplied service relates to the customer's agreed
 * charges. Read side for the register and the checks; write side for the
 * mapping actions (choose a line, bundle, mark free or internal, clear) and
 * for the syncs, which confirm quantities and record rule matches.
 */
export type ServiceLink = typeof serviceLinks.$inferSelect & { role: LinkRole; matchSource: MatchSource | null };

/** Links keyed by `${source}:${rowId}`; scoped to companies, a source or specific rows when given. */
export async function linksFor(opts: { companyIds?: string[]; source?: ServiceSource; rowIds?: string[] } = {}): Promise<Map<string, ServiceLink>> {
  if ((opts.companyIds && opts.companyIds.length === 0) || (opts.rowIds && opts.rowIds.length === 0)) return new Map();
  const rows = await db
    .select()
    .from(serviceLinks)
    .where(and(opts.companyIds ? inArray(serviceLinks.companyId, opts.companyIds) : undefined, opts.source ? eq(serviceLinks.source, opts.source) : undefined, opts.rowIds ? inArray(serviceLinks.sourceRowId, opts.rowIds) : undefined));
  return new Map(rows.map((r) => [`${r.source}:${r.sourceRowId}`, r as ServiceLink]));
}

/** One source's links keyed by row id (the shape the mirror queries want). */
export async function linksByRow(source: ServiceSource, opts: { companyId?: string; rowIds?: string[] } = {}) {
  const m = await linksFor({ source, companyIds: opts.companyId ? [opts.companyId] : undefined, rowIds: opts.rowIds });
  return new Map([...m.values()].map((l) => [l.sourceRowId, l]));
}

export const isNonBillable = (l: { role: LinkRole } | undefined | null) => Boolean(l && NON_BILLABLE_ROLES.includes(l.role));
export const countsTowardLine = (l: { role: LinkRole } | undefined | null) => Boolean(l && COUNTING_ROLES.includes(l.role));

/** Contract lines a service of these companies may be linked to, with what the matchers need. */
export async function matchableLinesFor(companyIds: string[], statuses: ("draft" | "active" | "expired" | "cancelled")[] = ["draft", "active"]): Promise<Map<string, MatchableLine[]>> {
  const out = new Map<string, MatchableLine[]>();
  if (!companyIds.length) return out;
  const rows = await db
    .select({
      id: contractLines.id,
      companyId: contracts.companyId,
      contractId: contracts.id,
      contractName: contracts.name,
      contractStatus: contracts.status,
      description: contractLines.description,
      quantity: contractLines.quantity,
      unitPrice: contractLines.unitPrice,
      unitCost: contractLines.unitCost,
      billingFrequency: contractLines.billingFrequency,
      pricingModel: contractLines.pricingModel,
      quantityRule: contractLines.quantityRule,
      countsAsManagedDevice: contractLines.countsAsManagedDevice,
      siteId: contractLines.siteId,
      productSku: products.sku,
      productName: products.name,
    })
    .from(contractLines)
    .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
    .leftJoin(products, eq(products.id, contractLines.productId))
    .where(and(inArray(contracts.companyId, companyIds), isNull(contracts.archivedAt), inArray(contracts.status, statuses)))
    .orderBy(asc(contracts.name), asc(contractLines.sortOrder));
  for (const r of rows) {
    const { companyId, ...line } = r;
    out.set(companyId, [...(out.get(companyId) ?? []), line]);
  }
  return out;
}

export type Resolved = { state: ServiceState; lineId: string | null; by: MatchSource | "rule" | null; link: ServiceLink | null };

/**
 * What a service's state and line are: its link when it has one, otherwise
 * the adapter's rule over the active lines (shown as such), otherwise
 * unmapped. A charged or bundle link whose line has been deleted reads as
 * unmapped again; one whose contract is no longer active keeps its role (the
 * findings report that nothing can charge it).
 */
export function resolveService(service: SuppliedService, link: ServiceLink | undefined, lines: MatchableLine[], autoMatch: (s: SuppliedService, lines: MatchableLine[]) => { lineId: string; by: MatchSource } | null): Resolved {
  if (link) {
    if ((link.role === "charged" || link.role === "bundle") && !link.contractLineId) return { state: "unmapped", lineId: null, by: null, link };
    return { state: link.role, lineId: link.contractLineId, by: link.matchSource ?? (link.role === "charged" || link.role === "bundle" ? "manual" : null), link };
  }
  const auto = autoMatch(service, lines.filter((l) => l.contractStatus === "active"));
  if (auto) return { state: "charged", lineId: auto.lineId, by: service.pool ? "rule" : auto.by, link: null };
  return { state: "unmapped", lineId: null, by: null, link: null };
}

async function lineOfCompany(contractLineId: string, companyId: string) {
  const [line] = await db.select({ id: contractLines.id, companyId: contracts.companyId, description: contractLines.description, contractId: contracts.id }).from(contractLines).innerJoin(contracts, eq(contracts.id, contractLines.contractId)).where(eq(contractLines.id, contractLineId)).limit(1);
  if (!line || line.companyId !== companyId) throw new ActionError("That contract line belongs to a different company.");
  return line;
}

export type SetLinkInput = { source: ServiceSource; sourceRowId: string; role: LinkRole; contractLineId?: string | null; reason?: string | null; reviewOn?: string | null; matchSource?: MatchSource };

/**
 * Records (or replaces) how a service is billed. Charged and bundle need the
 * line; free needs a reason and a review date; internal and investigate need
 * a reason. Audited and posted on the company timeline.
 */
export async function setServiceLink(input: SetLinkInput, actorUserId: string | null) {
  if (!serviceSourceValues.includes(input.source)) throw new ActionError("Unknown service source.");
  if (!linkRoleValues.includes(input.role)) throw new ActionError("Unknown link role.");
  const row = await sourceRow(input.source, input.sourceRowId);
  if (!row?.companyId) throw new ActionError("That service is not linked to a company; link it first.");
  const companyId = row.companyId;
  const reason = input.reason?.trim() || null;
  const reviewOn = input.reviewOn || null;
  let contractLineId = input.contractLineId || null;
  if (input.role === "charged" || input.role === "bundle") {
    if (!contractLineId) throw new ActionError(input.role === "bundle" ? "Choose the contract line the bundle is included in." : "Choose the contract line that bills this service.");
    await lineOfCompany(contractLineId, companyId);
  } else if (input.role === "commitment") {
    if (contractLineId) await lineOfCompany(contractLineId, companyId);
  } else contractLineId = null;
  if ((input.role === "free" || input.role === "internal" || input.role === "investigate") && !reason) throw new ActionError("Give a reason; it is what the next person reads.");
  if (input.role === "free" && !reviewOn) throw new ActionError("Set a review date for anything given away free, so it is looked at again.");
  const values = { source: input.source, sourceRowId: input.sourceRowId, companyId, role: input.role, contractLineId, matchSource: input.matchSource ?? "manual", quantity: String(row.quantity), lastSeenAt: new Date(), reason, reviewOn, setByUserId: actorUserId, updatedAt: new Date() };
  await db.insert(serviceLinks).values(values).onConflictDoUpdate({ target: [serviceLinks.source, serviceLinks.sourceRowId], set: values });
  await audit({ actorUserId, action: "service.link.set", entityType: "company", entityId: companyId, details: { source: input.source, sourceRowId: input.sourceRowId, name: row.name, role: input.role, contractLineId, matchSource: values.matchSource, reason, reviewOn } });
  if (values.matchSource === "manual") await logActivity({ type: "contract", companyId, entityType: input.source, entityId: input.sourceRowId, title: `${row.name}: ${SERVICE_STATE_LABELS[input.role].toLowerCase()}${reason ? ` (${reason})` : ""}`, actorUserId });
  return { companyId, contractLineId };
}

/** Removes a link; the service reads as rule-matched or unmapped again. */
export async function clearServiceLink(source: ServiceSource, sourceRowId: string, actorUserId: string | null) {
  const [existing] = await db.select().from(serviceLinks).where(and(eq(serviceLinks.source, source), eq(serviceLinks.sourceRowId, sourceRowId))).limit(1);
  if (!existing) return null;
  await db.delete(serviceLinks).where(eq(serviceLinks.id, existing.id));
  await audit({ actorUserId, action: "service.link.clear", entityType: "company", entityId: existing.companyId, details: { source, sourceRowId, was: existing.role, contractLineId: existing.contractLineId } });
  return existing;
}

/**
 * Called at the end of a provider sync: confirms each linked service's
 * quantity and cost as of now, and records rule matches as links (so the
 * mapping is stable and inspectable rather than recomputed on every read).
 * Manual links are never changed here. Returns how many rule links were added.
 */
export async function confirmLinksFromSync(services: SuppliedService[], lines: Map<string, MatchableLine[]>, autoMatch: (s: SuppliedService, lines: MatchableLine[]) => { lineId: string; by: MatchSource } | null) {
  const real = services.filter((s) => !s.pool);
  if (!real.length) return { confirmed: 0, added: 0 };
  const links = await linksFor({ rowIds: real.map((s) => s.rowId), source: real[0].source });
  const now = new Date();
  let confirmed = 0;
  let added = 0;
  for (const s of real) {
    const link = links.get(s.key);
    if (link) {
      await db.update(serviceLinks).set({ quantity: String(s.quantity), monthlyCost: s.monthlyCost === null ? null : String(s.monthlyCost), lastSeenAt: s.syncedAt ?? now, updatedAt: now }).where(eq(serviceLinks.id, link.id));
      confirmed++;
      continue;
    }
    const auto = autoMatch(s, (lines.get(s.companyId) ?? []).filter((l) => l.contractStatus === "active"));
    if (!auto) continue;
    await db.insert(serviceLinks).values({ source: s.source, sourceRowId: s.rowId, companyId: s.companyId, contractLineId: auto.lineId, role: "charged", matchSource: auto.by, quantity: String(s.quantity), monthlyCost: s.monthlyCost === null ? null : String(s.monthlyCost), lastSeenAt: s.syncedAt ?? now }).onConflictDoNothing();
    added++;
  }
  return { confirmed, added };
}

async function sourceRow(source: ServiceSource, rowId: string): Promise<{ companyId: string | null; name: string; quantity: number } | null> {
  if (source === "pax8_subscription") {
    const [r] = await db.select({ companyId: pax8Subscriptions.companyId, name: pax8Subscriptions.productName, quantity: pax8Subscriptions.quantity }).from(pax8Subscriptions).where(eq(pax8Subscriptions.id, rowId)).limit(1);
    return r ?? null;
  }
  if (source === "hosting_item") {
    const [r] = await db.select({ companyId: hostingItems.companyId, name: hostingItems.name }).from(hostingItems).where(eq(hostingItems.id, rowId)).limit(1);
    return r ? { ...r, quantity: 1 } : null;
  }
  const [d] = await db.select({ companyId: ninjaDevices.companyId, a: ninjaDevices.displayName, b: ninjaDevices.systemName }).from(ninjaDevices).where(eq(ninjaDevices.id, rowId)).limit(1);
  return d ? { companyId: d.companyId, name: d.a ?? d.b ?? "device", quantity: 1 } : null;
}

/** Links whose review date has passed, oldest first (free arrangements to look at again). */
export async function overdueLinkReviews(limit = 50) {
  return db.select({ c: serviceLinks, companyName: companies.name }).from(serviceLinks).innerJoin(companies, eq(companies.id, serviceLinks.companyId)).where(sql`${serviceLinks.reviewOn} < current_date`).orderBy(asc(serviceLinks.reviewOn)).limit(limit);
}

/** SQL fragment: true when a NinjaOne device has a link that takes it out of the billable pool. */
export const deviceNotNonBillable = sql`not exists (select 1 from service_links sl where sl.source = 'ninja_device' and sl.source_row_id = ${ninjaDevices.id} and sl.role in (${sql.join(NON_BILLABLE_ROLES.map((x) => sql`${x}`), sql`, `)}))`;
