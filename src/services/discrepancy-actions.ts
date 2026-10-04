import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { billingDiscrepancies, contractLineChanges, pax8Subscriptions, user } from "@/db/schema";
import { audit, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { discrepancyImpact, type DiscrepancyImpact, type ImpactKind } from "@/lib/discrepancy-impact";
import { contractSchema, type ContractLineInput } from "@/lib/validation-sales";
import { getContract, updateContract } from "./contracts";
import { reviewDiscrepancy, runDiscrepancyCheck } from "./ninjaone";
export { reopenExpiredExceptions } from "./ninjaone";
import { runLicenceCheck } from "./pax8";
import { setServiceCoverage } from "./service-register";

/**
 * Concrete actions on a billing discrepancy, each with its money consequence
 * shown before it is taken:
 *
 * - **amend_line**: the contract line takes the observed quantity as a dated
 *   change (history, pro-rating and catch-up as for any change).
 * - **reduce_at_renewal**: the line takes the observed (lower) quantity but its
 *   reduction policy becomes "at renewal", so the agreed count is billed until
 *   the renewal date.
 * - **include_in_bundle** (Pax8): chosen subscriptions are marked as covered by
 *   another line (a bundle), so they stop counting against this one.
 * - **exception**: the difference is accepted for now with an owner and a
 *   review date; past that date it re-opens by itself.
 * - **dismiss**: not a billing matter.
 */
export type ResolutionKind = ImpactKind | "include_in_bundle" | "dismiss";
export const RESOLUTION_LABELS: Record<string, string> = { amend_line: "Contract line amended", reduce_at_renewal: "Reduced at renewal", include_in_bundle: "Included in a bundle", exception: "Accepted exception", dismiss: "Dismissed" };

const today = () => new Date().toISOString().slice(0, 10);

async function load(id: string) {
  const [d] = await db.select().from(billingDiscrepancies).where(eq(billingDiscrepancies.id, id)).limit(1);
  if (!d) throw new ActionError("Discrepancy not found.");
  const c = await getContract(d.contractId);
  if (!c) throw new ActionError("The contract of this discrepancy no longer exists.");
  const line = c.lines.find((l) => l.id === d.contractLineId);
  if (!line) throw new ActionError("The contract line of this discrepancy no longer exists.");
  return { d, c, line };
}

/** The contract's current terms in the shape the form sends (optional fields as empty strings), so an update from here changes only the line. */
const asInput = (c: Awaited<ReturnType<typeof getContract>> & object) => {
  const s = (v: string | null | undefined) => v ?? "";
  return contractSchema.parse({ companyId: c.companyId, opportunityId: s(c.opportunityId), name: c.name, reference: s(c.reference), status: c.status, startDate: c.startDate, endDate: s(c.endDate), renewalDate: s(c.renewalDate), noticePeriodDays: c.noticePeriodDays, autoRenew: c.autoRenew, billingFrequency: c.billingFrequency, billingDay: c.billingDay, billingFrom: s(c.billingFrom), priceLockedUntilRenewal: c.priceLockedUntilRenewal, purchaseOrderRef: s(c.purchaseOrderRef), nextReviewDate: s(c.nextReviewDate), reviewIntervalMonths: c.reviewIntervalMonths, ownerUserId: s(c.ownerUserId), notes: s(c.notes) });
};
const asLines = (c: Awaited<ReturnType<typeof getContract>> & object): ContractLineInput[] =>
  c.lines.map((l) => ({ id: l.id, productId: l.productId, siteId: l.siteId, description: l.description, revenueType: l.revenueType, pricingModel: l.pricingModel, billingFrequency: l.billingFrequency, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), unitCost: l.unitCost === null ? null : Number(l.unitCost), countsAsManagedDevice: l.countsAsManagedDevice, invoiceSchedule: l.invoiceSchedule as "contract", reductionPolicy: l.reductionPolicy as "next_period" }));

function impactFor(d: { difference: string; unitPrice: string | null }, c: { startDate: string; billingFrequency: string; endDate: string | null; billingDay: number | null; renewalDate: string | null }, line: { reductionPolicy: string }, kind: ImpactKind, effectiveFrom: string) {
  return discrepancyImpact({ difference: Number(d.difference), unitPrice: Number(d.unitPrice ?? 0), contract: c, reductionPolicy: line.reductionPolicy as "next_period", effectiveFrom, asOf: today(), kind });
}

/** Everything the resolution dialog needs for one discrepancy. */
export async function discrepancyOptions(id: string) {
  const { d, c, line } = await load(id);
  const diff = Number(d.difference);
  const effectiveFrom = today();
  const kinds: ResolutionKind[] = ["amend_line"];
  if (diff < 0 && c.renewalDate) kinds.push("reduce_at_renewal");
  if (d.source === "pax8" && diff > 0) kinds.push("include_in_bundle");
  kinds.push("exception", "dismiss");
  const subscriptionIds = ((d.basis as { subscriptionIds?: string[] } | null)?.subscriptionIds ?? []).filter(Boolean);
  const [subs, users] = await Promise.all([
    d.source === "pax8" && subscriptionIds.length
      ? db.select({ id: pax8Subscriptions.id, subscriptionId: pax8Subscriptions.subscriptionId, productName: pax8Subscriptions.productName, quantity: pax8Subscriptions.quantity }).from(pax8Subscriptions).where(and(eq(pax8Subscriptions.companyId, d.companyId), inArray(pax8Subscriptions.subscriptionId, subscriptionIds)))
      : Promise.resolve([]),
    db.select({ id: user.id, name: user.name }).from(user).where(eq(user.active, true)).orderBy(user.name),
  ]);
  const bundleLines = c.lines.filter((l) => l.id !== line.id && l.revenueType === "recurring").map((l) => ({ id: l.id, description: l.description, quantity: Number(l.quantity) }));
  return {
    id: d.id,
    source: d.source,
    status: d.status,
    lineDescription: d.lineDescription,
    contracted: Number(d.contractedQty),
    observed: d.observedQty,
    difference: diff,
    unitPrice: Number(d.unitPrice ?? 0),
    line: { id: line.id, description: line.description, quantity: Number(line.quantity), newQuantity: Number(line.quantity) + diff, reductionPolicy: line.reductionPolicy },
    contract: { id: c.id, name: c.name, renewalDate: c.renewalDate, billingFrequency: c.billingFrequency },
    kinds,
    effectiveFrom,
    impact: {
      amend_line: impactFor(d, c, line, "amend_line", effectiveFrom),
      reduce_at_renewal: diff < 0 ? impactFor(d, c, line, "reduce_at_renewal", effectiveFrom) : null,
      exception: impactFor(d, c, line, "exception", effectiveFrom),
    } as Record<string, DiscrepancyImpact | null>,
    subscriptions: subs.map((s) => ({ id: s.id, subscriptionId: s.subscriptionId, productName: s.productName, quantity: s.quantity })),
    bundleLines,
    users,
  };
}

export async function previewDiscrepancyResolution(id: string, kind: ImpactKind, effectiveFrom: string) {
  const { d, c, line } = await load(id);
  return impactFor(d, c, line, kind, effectiveFrom);
}

export type ResolutionInput = {
  kind: ResolutionKind;
  effectiveFrom?: string | null;
  reason?: string | null;
  bundleLineId?: string | null;
  subscriptionRowIds?: string[] | null;
  ownerUserId?: string | null;
  reviewOn?: string | null;
};

export async function resolveDiscrepancy(id: string, input: ResolutionInput, actorUserId: string) {
  const { d, c, line } = await load(id);
  if (d.status !== "open" && d.status !== "accepted") throw new ActionError(`This discrepancy is ${d.status}; nothing to act on.`);
  const diff = Number(d.difference);
  const now = new Date();
  const reason = input.reason?.trim() || null;
  const licence = d.source === "pax8";
  const recheck = () => (licence ? runLicenceCheck(actorUserId, d.companyId) : runDiscrepancyCheck(actorUserId, d.companyId));

  if (input.kind === "dismiss") {
    await reviewDiscrepancy(id, "dismissed", reason, actorUserId);
    await db.update(billingDiscrepancies).set({ resolution: "dismiss" }).where(eq(billingDiscrepancies.id, id));
    return { kind: input.kind };
  }

  if (input.kind === "exception") {
    if (!input.ownerUserId) throw new ActionError("An accepted exception needs an owner.");
    if (!input.reviewOn || input.reviewOn <= today()) throw new ActionError("An accepted exception needs a review date in the future.");
    if (!reason) throw new ActionError("Say why the difference is accepted for now.");
    const [owner] = await db.select({ id: user.id, name: user.name }).from(user).where(eq(user.id, input.ownerUserId)).limit(1);
    if (!owner) throw new ActionError("Owner not found.");
    await db.update(billingDiscrepancies).set({ status: "accepted", resolution: "exception", ownerUserId: owner.id, reviewOn: input.reviewOn, note: reason, reviewedByUserId: actorUserId, reviewedAt: now, updatedAt: now }).where(eq(billingDiscrepancies.id, id));
    await audit({ actorUserId, action: "discrepancy.exception", entityType: "billing_discrepancy", entityId: id, details: { contractLineId: d.contractLineId, difference: diff, ownerUserId: owner.id, reviewOn: input.reviewOn, reason } });
    await logActivity({ type: licence ? "sync" : "device", companyId: d.companyId, entityType: "contract", entityId: d.contractId, title: `${licence ? "Licence" : "Device"} discrepancy accepted until ${input.reviewOn} (owner ${owner.name}): ${d.lineDescription} (${diff > 0 ? "+" : ""}${diff})`, body: reason, actorUserId, source: d.source });
    return { kind: input.kind };
  }

  if (input.kind === "include_in_bundle") {
    if (!licence) throw new ActionError("Only licence discrepancies can be moved into a bundle.");
    if (!input.bundleLineId || !c.lines.some((l) => l.id === input.bundleLineId && l.id !== line.id)) throw new ActionError("Choose the bundle line on the same contract.");
    const rows = (input.subscriptionRowIds ?? []).filter(Boolean);
    if (!rows.length) throw new ActionError("Choose at least one subscription to include in the bundle.");
    for (const rowId of rows) await setServiceCoverage({ source: "pax8_subscription", sourceRowId: rowId, state: "bundle", contractLineId: input.bundleLineId, reason: reason ?? `Included in bundle from discrepancy on ${d.lineDescription}` }, actorUserId);
    await db.update(billingDiscrepancies).set({ resolution: "include_in_bundle", note: reason, reviewedByUserId: actorUserId, reviewedAt: now, updatedAt: now }).where(eq(billingDiscrepancies.id, id));
    await audit({ actorUserId, action: "discrepancy.include_in_bundle", entityType: "billing_discrepancy", entityId: id, details: { contractLineId: d.contractLineId, bundleLineId: input.bundleLineId, subscriptions: rows, reason } });
    const r = await recheck();
    const [after] = await db.select({ status: billingDiscrepancies.status, difference: billingDiscrepancies.difference }).from(billingDiscrepancies).where(eq(billingDiscrepancies.id, id)).limit(1);
    return { kind: input.kind, status: after?.status, difference: Number(after?.difference ?? 0), check: r };
  }

  // amend_line and reduce_at_renewal: a dated quantity change on the line.
  const effectiveFrom = input.effectiveFrom || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw new ActionError("Effective date must be a date.");
  if (effectiveFrom < c.startDate) throw new ActionError("The change cannot take effect before the contract starts.");
  if (input.kind === "reduce_at_renewal") {
    if (diff >= 0) throw new ActionError("Reduce at renewal only applies when fewer are observed than contracted.");
    if (!c.renewalDate) throw new ActionError("The contract has no renewal date.");
  }
  const newQty = Number(line.quantity) + diff;
  if (newQty < 0) throw new ActionError("The amended quantity would be negative.");
  const lines = asLines(c).map((l) => (l.id === line.id ? { ...l, quantity: newQty, reductionPolicy: input.kind === "reduce_at_renewal" ? ("at_renewal" as const) : l.reductionPolicy } : l));
  const why = reason ?? `${licence ? "Licence" : "Device"} count: contracted ${d.contractedQty}, observed ${d.observedQty}`;
  await updateContract(c.id, asInput(c), lines, actorUserId, { quantityEffectiveFrom: effectiveFrom, changeReason: why });
  const [change] = await db.select({ id: contractLineChanges.id }).from(contractLineChanges).where(and(eq(contractLineChanges.contractLineId, line.id), eq(contractLineChanges.field, "quantity"))).orderBy(desc(contractLineChanges.recordedAt)).limit(1);
  await db.update(billingDiscrepancies).set({ status: "resolved", resolution: input.kind, note: why, appliedChangeId: change?.id ?? null, reviewedByUserId: actorUserId, reviewedAt: now, updatedAt: now }).where(eq(billingDiscrepancies.id, id));
  await audit({ actorUserId, action: `discrepancy.${input.kind}`, entityType: "billing_discrepancy", entityId: id, details: { contractLineId: line.id, from: Number(line.quantity), to: newQty, effectiveFrom, changeId: change?.id ?? null, reason: why } });
  await logActivity({ type: "contract", companyId: d.companyId, entityType: "contract", entityId: c.id, title: `${line.description}: ${Number(line.quantity)} → ${newQty} from ${effectiveFrom}${input.kind === "reduce_at_renewal" ? ` (billed at ${Number(line.quantity)} until renewal ${c.renewalDate})` : ""}, from a ${licence ? "licence" : "device"} discrepancy`, body: why, actorUserId, source: d.source });
  const check = await recheck();
  return { kind: input.kind, changeId: change?.id ?? null, newQuantity: newQty, effectiveFrom, check };
}
