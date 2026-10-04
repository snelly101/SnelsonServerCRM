import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { companies, contractLineChanges, contractLines, contracts, products } from "@/db/schema";
import { audit } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { billingPeriodFor, PERIOD_MONTHS } from "@/lib/billing";
import { contractAsInput, contractLinesAsInput, getContract, updateContract } from "./contracts";

/**
 * Price reviews: a proposed change to the sell price (or a supplier cost rise
 * passed through) across every active contract line it touches, shown with
 * each customer's current and projected margin and the agreement constraints
 * before anything is applied. Applying records dated unit-price (and cost)
 * changes with the review's reason, so the next invoice after the effective
 * date carries the new price and the history says why. Nothing changes a
 * price silently.
 */
export type PriceReviewInput = {
  scope: { productId?: string | null; descriptionContains?: string | null };
  change: { kind: "percent" | "unit_price" | "cost_passthrough"; value: number };
  effectiveFrom: string;
  reason: string;
  /** Apply only these lines (ids from the preview); empty = every line in scope. */
  lineIds?: string[] | null;
  /** Also set the catalogue product's list price (and cost) to the new values. */
  updateCatalogue?: boolean;
};

export type PriceReviewLine = {
  lineId: string;
  contractId: string;
  contractName: string;
  companyId: string;
  companyName: string;
  description: string;
  billingFrequency: string;
  quantity: number;
  unitPrice: number;
  newUnitPrice: number;
  unitCost: number | null;
  newUnitCost: number | null;
  marginNow: number | null;
  marginAfter: number | null;
  /** Monthly revenue change (normalised). */
  monthlyDelta: number;
  /** When the change takes effect for this line after its contract's constraints. */
  appliedFrom: string;
  /** First invoice period that carries the new price (price changes never pro-rate). */
  firstPeriodStart: string | null;
  constraints: string[];
  /** False when the line cannot take the change (contract ending first). */
  applicable: boolean;
};

export type PriceReviewPreview = {
  lines: PriceReviewLine[];
  totals: { lines: number; customers: number; monthlyNow: number; monthlyAfter: number; monthlyDelta: number; marginNow: number | null; marginAfter: number | null };
  product: { id: string; name: string; unitPrice: number; unitCost: number | null } | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const margin = (price: number, cost: number | null) => (cost === null || price === 0 ? null : round2(((price - cost) / price) * 100));
const addDay = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

/** Pure: the new unit price and cost for one line under the proposed change. */
export function priceAfter(change: PriceReviewInput["change"], unitPrice: number, unitCost: number | null): { unitPrice: number; unitCost: number | null; note: string | null } {
  if (change.kind === "percent") return { unitPrice: round2(unitPrice * (1 + change.value / 100)), unitCost, note: null };
  if (change.kind === "unit_price") return { unitPrice: round2(change.value), unitCost, note: null };
  // cost_passthrough: the supplier cost becomes `value`; the sell price moves to keep the same margin percentage.
  if (unitCost !== null && unitCost > 0 && unitPrice > 0) return { unitPrice: round2(unitPrice * (change.value / unitCost)), unitCost: round2(change.value), note: null };
  return { unitPrice: round2(unitPrice + change.value - (unitCost ?? 0)), unitCost: round2(change.value), note: "No previous cost on the line: the cost difference is added to the price" };
}

/** Pure: the first anchored period that starts on or after the effective day (the engine applies price changes from there). */
export function firstPeriodOnOrAfter(c: { startDate: string; billingFrequency: string; endDate: string | null; billingDay: number | null }, effectiveFrom: string): string | null {
  if (!PERIOD_MONTHS[c.billingFrequency]) return null;
  const p = billingPeriodFor(c.startDate, c.billingFrequency, effectiveFrom, c.endDate, c.billingDay);
  if (!p) return effectiveFrom < c.startDate ? c.startDate : null;
  if (p.periodStart === effectiveFrom) return p.periodStart;
  const next = billingPeriodFor(c.startDate, c.billingFrequency, addDay(p.periodEnd, 1), c.endDate, c.billingDay);
  return next?.periodStart ?? null;
}

async function linesInScope(scope: PriceReviewInput["scope"]) {
  if (!scope.productId && !scope.descriptionContains?.trim()) throw new ActionError("Choose a product or a description to review.");
  const rows = await db
    .select({ line: contractLines, contract: contracts, companyName: companies.name })
    .from(contractLines)
    .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
    .innerJoin(companies, eq(companies.id, contracts.companyId))
    .where(and(eq(contracts.status, "active"), isNull(contracts.archivedAt), eq(contractLines.revenueType, "recurring"), scope.productId ? eq(contractLines.productId, scope.productId) : undefined))
    .orderBy(asc(companies.name), asc(contracts.name), asc(contractLines.sortOrder));
  const needle = scope.descriptionContains?.trim().toLowerCase();
  return needle ? rows.filter((r) => r.line.description.toLowerCase().includes(needle)) : rows;
}

export async function previewPriceReview(input: PriceReviewInput, asOf = new Date().toISOString().slice(0, 10)): Promise<PriceReviewPreview> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) throw new ActionError("Effective date must be a date.");
  if (!Number.isFinite(input.change.value)) throw new ActionError("Enter the change.");
  if (input.change.kind === "percent" && (input.change.value < -100 || input.change.value > 1000)) throw new ActionError("Percentage out of range.");
  if (input.change.kind !== "percent" && input.change.value < 0) throw new ActionError("Enter a positive amount.");
  const rows = await linesInScope(input.scope);
  const product = input.scope.productId ? (await db.select({ id: products.id, name: products.name, unitPrice: products.unitPrice, unitCost: products.unitCost }).from(products).where(eq(products.id, input.scope.productId)).limit(1))[0] : null;
  const lines: PriceReviewLine[] = rows.map(({ line, contract, companyName }) => {
    const unitPrice = Number(line.unitPrice);
    const unitCost = line.unitCost === null ? null : Number(line.unitCost);
    const after = priceAfter(input.change, unitPrice, unitCost);
    const constraints: string[] = [];
    if (after.note) constraints.push(after.note);
    let appliedFrom = input.effectiveFrom;
    let applicable = true;
    if (contract.priceLockedUntilRenewal && contract.renewalDate && contract.renewalDate > appliedFrom) {
      appliedFrom = contract.renewalDate;
      constraints.push(`Prices fixed until renewal on ${contract.renewalDate}: applies from then`);
    }
    if (contract.endDate && contract.endDate < appliedFrom) {
      applicable = false;
      constraints.push(`Agreement ends ${contract.endDate}, before the change`);
    }
    if (contract.renewalDecision === "not_renewing" && contract.renewalDecisionFor === contract.renewalDate) constraints.push("Customer has said they are not renewing");
    if (contract.renewalDate) {
      const notice = addDay(contract.renewalDate, -contract.noticePeriodDays);
      if (notice >= asOf && notice <= addDay(asOf, 30)) constraints.push(`Notice deadline ${notice} is within 30 days`);
    }
    const months = PERIOD_MONTHS[line.billingFrequency] ?? PERIOD_MONTHS[contract.billingFrequency] ?? 1;
    const qty = Number(line.quantity);
    return {
      lineId: line.id,
      contractId: contract.id,
      contractName: contract.name,
      companyId: contract.companyId,
      companyName,
      description: line.description,
      billingFrequency: line.billingFrequency,
      quantity: qty,
      unitPrice,
      newUnitPrice: after.unitPrice,
      unitCost,
      newUnitCost: after.unitCost,
      marginNow: margin(unitPrice, unitCost),
      marginAfter: margin(after.unitPrice, after.unitCost),
      monthlyDelta: round2((qty * (after.unitPrice - unitPrice)) / months),
      appliedFrom,
      firstPeriodStart: applicable ? firstPeriodOnOrAfter(contract, appliedFrom) : null,
      constraints,
      applicable,
    };
  });
  const applicable = lines.filter((l) => l.applicable);
  const monthlyOf = (l: PriceReviewLine, price: number) => (l.quantity * price) / (PERIOD_MONTHS[l.billingFrequency] ?? 1);
  const monthlyNow = round2(applicable.reduce((a, l) => a + monthlyOf(l, l.unitPrice), 0));
  const monthlyAfter = round2(applicable.reduce((a, l) => a + monthlyOf(l, l.newUnitPrice), 0));
  const costNow = applicable.reduce((a, l) => a + (l.unitCost === null ? 0 : monthlyOf(l, l.unitCost)), 0);
  const costAfter = applicable.reduce((a, l) => a + (l.newUnitCost === null ? 0 : monthlyOf(l, l.newUnitCost)), 0);
  const anyCost = applicable.some((l) => l.unitCost !== null);
  return {
    lines,
    totals: { lines: applicable.length, customers: new Set(applicable.map((l) => l.companyId)).size, monthlyNow, monthlyAfter, monthlyDelta: round2(monthlyAfter - monthlyNow), marginNow: anyCost && monthlyNow ? round2(((monthlyNow - costNow) / monthlyNow) * 100) : null, marginAfter: anyCost && monthlyAfter ? round2(((monthlyAfter - costAfter) / monthlyAfter) * 100) : null },
    product: product ? { id: product.id, name: product.name, unitPrice: Number(product.unitPrice), unitCost: product.unitCost === null ? null : Number(product.unitCost) } : null,
  };
}

export async function applyPriceReview(input: PriceReviewInput, actorUserId: string) {
  const reason = input.reason?.trim();
  if (!reason) throw new ActionError("Give the reason for the price change; it goes into every customer's change history.");
  const preview = await previewPriceReview(input);
  const wanted = input.lineIds?.length ? new Set(input.lineIds) : null;
  const chosen = preview.lines.filter((l) => l.applicable && (!wanted || wanted.has(l.lineId)));
  if (!chosen.length) throw new ActionError("No lines to change.");
  const byContract = new Map<string, PriceReviewLine[]>();
  for (const l of chosen) byContract.set(l.contractId, [...(byContract.get(l.contractId) ?? []), l]);
  const applied: { contractId: string; companyName: string; contractName: string; lines: number; appliedFrom: string; changeIds: string[] }[] = [];
  for (const [contractId, group] of byContract) {
    const c = await getContract(contractId);
    if (!c) continue;
    const byLine = new Map(group.map((g) => [g.lineId, g]));
    const lines = contractLinesAsInput(c).map((l) => {
      const g = l.id ? byLine.get(l.id) : undefined;
      return g ? { ...l, unitPrice: g.newUnitPrice, unitCost: g.newUnitCost } : l;
    });
    const appliedFrom = group[0].appliedFrom;
    await updateContract(contractId, contractAsInput(c), lines, actorUserId, { quantityEffectiveFrom: appliedFrom, changeReason: reason });
    const changes = await db.select({ id: contractLineChanges.id }).from(contractLineChanges).where(and(inArray(contractLineChanges.contractLineId, group.map((g) => g.lineId)), eq(contractLineChanges.field, "unit_price"), eq(contractLineChanges.effectiveFrom, appliedFrom)));
    applied.push({ contractId, companyName: group[0].companyName, contractName: group[0].contractName, lines: group.length, appliedFrom, changeIds: changes.map((x) => x.id) });
  }
  if (input.updateCatalogue && preview.product) {
    const after = priceAfter(input.change, preview.product.unitPrice, preview.product.unitCost);
    await db.update(products).set({ unitPrice: String(after.unitPrice), unitCost: after.unitCost === null ? null : String(after.unitCost), updatedAt: new Date() }).where(eq(products.id, preview.product.id));
  }
  await audit({ actorUserId, action: "pricing.review.apply", entityType: "product", entityId: preview.product?.id ?? null, details: { scope: input.scope, change: input.change, effectiveFrom: input.effectiveFrom, reason, contracts: applied.length, lines: chosen.length, monthlyDelta: round2(chosen.reduce((a, l) => a + l.monthlyDelta, 0)), updateCatalogue: Boolean(input.updateCatalogue && preview.product) } });
  return { applied, lines: chosen.length, monthlyDelta: round2(chosen.reduce((a, l) => a + l.monthlyDelta, 0)) };
}
