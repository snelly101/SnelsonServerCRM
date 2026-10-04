import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { companies, contractLines, contracts, user } from "@/db/schema";
import { audit, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { getAppSettings } from "@/lib/settings";
import { summariseLines } from "@/lib/money";
import { lineChangesFor } from "./contracts";
import { serviceRegisterRows, type RegisterRow } from "./service-register";

/**
 * Renewal exposure: for every active contract with a renewal date, the
 * customer's decision deadline against the supplier commitments behind its
 * lines, so a mismatch ("the agreement ends in December, the supplier
 * commitment runs to September") shows before the notice deadline, not after.
 *
 * Supplier commitments come from the service register: a Pax8 subscription's
 * commitment end, a 20i domain's expiry. A service counts for a contract when
 * the register ties it to one of the contract's lines (matched or bundled).
 */
import { DECISION_LABELS, type RenewalDecision, type RenewalMismatch } from "@/lib/renewals";
export { DECISION_LABELS, MISMATCH_LABELS, type RenewalDecision, type RenewalMismatch } from "@/lib/renewals";

export type RenewalService = {
  key: string;
  kind: string;
  name: string;
  quantity: number | null;
  monthlyCost: number | null;
  supplierEndsOn: string | null;
  lineDescription: string;
  mismatch: RenewalMismatch | null;
  /** Months of supplier cost beyond the customer's renewal date (when the supplier outlasts it). */
  exposureMonths: number;
  exposure: number | null;
};


export type RenewalRow = {
  contractId: string;
  contractName: string;
  companyId: string;
  companyName: string;
  ownerName: string | null;
  renewalDate: string;
  noticeDeadline: string;
  decideBy: string;
  daysToDecide: number;
  autoRenew: boolean;
  mrr: number;
  monthlyCost: number;
  services: RenewalService[];
  mismatches: string[];
  exposureTotal: number;
  /** Dated line changes that take effect after the run date (planned quantities and prices). */
  planned: { lineDescription: string; field: string; previousValue: string | null; newValue: string | null; effectiveFrom: string }[];
  decision: { kind: RenewalDecision; at: Date; by: string | null; note: string | null } | null;
  status: "decided" | "overdue" | "due" | "upcoming";
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
/** Whole months from a to b, rounded up: a commitment running 20 days past renewal is one more month to pay. */
const monthsBeyond = (a: string, b: string) => Math.max(0, Math.ceil(daysBetween(a, b) / 30.4375));

/** Pure: how a supplier commitment end relates to the customer's renewal date on a run date. */
export function supplierMismatch(renewalDate: string, supplierEndsOn: string | null, asOf: string): RenewalMismatch | null {
  if (!supplierEndsOn) return null;
  if (supplierEndsOn > renewalDate) return "supplier_outlasts";
  if (supplierEndsOn >= asOf && supplierEndsOn < renewalDate) return "supplier_renews_first";
  return null;
}

export async function renewalQueue(asOf = new Date().toISOString().slice(0, 10), opts: { contractId?: string } = {}): Promise<RenewalRow[]> {
  const settings = await getAppSettings();
  const lead = settings.renewalLeadDays;
  const money = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: settings.currency }).format(n);
  const rows = await db
    .select({ c: contracts, companyName: companies.name, ownerName: user.name })
    .from(contracts)
    .innerJoin(companies, eq(companies.id, contracts.companyId))
    .leftJoin(user, eq(user.id, contracts.ownerUserId))
    .where(and(eq(contracts.status, "active"), isNull(contracts.archivedAt), isNull(companies.archivedAt), sql`${contracts.renewalDate} is not null`, opts.contractId ? eq(contracts.id, opts.contractId) : undefined))
    .orderBy(contracts.renewalDate, companies.name);
  if (!rows.length) return [];
  const contractIds = rows.map((r) => r.c.id);
  const companyIds = [...new Set(rows.map((r) => r.c.companyId))];
  const deciderIds = [...new Set(rows.map((r) => r.c.renewalDecidedByUserId).filter((x): x is string => Boolean(x)))];
  const [lines, register, changes, deciders] = await Promise.all([
    db.select().from(contractLines).where(inArray(contractLines.contractId, contractIds)),
    serviceRegisterRows(companyIds),
    lineChangesFor(contractIds),
    deciderIds.length ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, deciderIds)) : Promise.resolve([]),
  ]);
  const deciderName = new Map(deciders.map((d) => [d.id, d.name]));
  const linesByContract = new Map<string, typeof lines>();
  for (const l of lines) linesByContract.set(l.contractId, [...(linesByContract.get(l.contractId) ?? []), l]);
  const servicesByLine = new Map<string, RegisterRow[]>();
  for (const r of register) if (r.line) servicesByLine.set(r.line.id, [...(servicesByLine.get(r.line.id) ?? []), r]);

  return rows.map(({ c, companyName, ownerName }) => {
    const cl = linesByContract.get(c.id) ?? [];
    const renewalDate = c.renewalDate!;
    const noticeDeadline = addDays(renewalDate, -c.noticePeriodDays);
    const decideBy = addDays(noticeDeadline, -lead);
    const services: RenewalService[] = [];
    for (const l of cl) {
      for (const s of servicesByLine.get(l.id) ?? []) {
        if (s.source === "ninja_device") continue; // devices carry no supplier commitment
        const mismatch = supplierMismatch(renewalDate, s.renewsOn, asOf);
        const exposureMonths = mismatch === "supplier_outlasts" ? monthsBeyond(renewalDate, s.renewsOn!) : 0;
        services.push({ key: s.key, kind: s.kind, name: s.name, quantity: s.quantity, monthlyCost: s.monthlyCost, supplierEndsOn: s.renewsOn, lineDescription: l.description, mismatch, exposureMonths, exposure: exposureMonths && s.monthlyCost !== null ? round2(exposureMonths * s.monthlyCost) : exposureMonths ? null : 0 });
      }
    }
    const mismatches: string[] = [];
    for (const s of services) {
      if (s.mismatch === "supplier_outlasts") mismatches.push(`${s.name}: the agreement renews on ${renewalDate} but the supplier commitment runs to ${s.supplierEndsOn}${s.exposure !== null ? ` (≈ ${money(s.exposure)} for ${s.exposureMonths} month${s.exposureMonths === 1 ? "" : "s"} beyond it)` : ""}`);
      if (s.mismatch === "supplier_renews_first") mismatches.push(`${s.name}: the supplier commitment renews on ${s.supplierEndsOn}, before the agreement's ${renewalDate}; the cost may change first`);
    }
    const planned = (cl.flatMap((l) => (changes.get(l.id) ?? []).filter((ch) => ch.effectiveFrom > asOf).map((ch) => ({ lineDescription: l.description, field: ch.field, previousValue: ch.previousValue, newValue: ch.newValue, effectiveFrom: ch.effectiveFrom })))).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    const decision = c.renewalDecision && c.renewalDecisionFor === renewalDate ? { kind: c.renewalDecision as RenewalDecision, at: c.renewalDecidedAt!, by: c.renewalDecidedByUserId ? (deciderName.get(c.renewalDecidedByUserId) ?? null) : null, note: c.renewalDecisionNote } : null;
    const daysToDecide = daysBetween(asOf, decideBy);
    const summary = summariseLines(cl.map((l) => ({ quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), unitCost: l.unitCost === null ? null : Number(l.unitCost), revenueType: l.revenueType, billingFrequency: l.billingFrequency })));
    return {
      contractId: c.id,
      contractName: c.name,
      companyId: c.companyId,
      companyName,
      ownerName,
      renewalDate,
      noticeDeadline,
      decideBy,
      daysToDecide,
      autoRenew: c.autoRenew,
      mrr: round2(summary.mrr),
      monthlyCost: round2(services.reduce((a, s) => a + (s.monthlyCost ?? 0), 0)),
      services,
      mismatches,
      exposureTotal: round2(services.reduce((a, s) => a + (s.exposure ?? 0), 0)),
      planned,
      decision,
      status: decision ? "decided" : daysToDecide < 0 ? "overdue" : daysToDecide <= lead ? "due" : "upcoming",
    };
  });
}

export async function recordRenewalDecision(contractId: string, input: { decision: RenewalDecision; note?: string | null }, actorUserId: string) {
  const [c] = await db.select({ id: contracts.id, name: contracts.name, companyId: contracts.companyId, renewalDate: contracts.renewalDate, status: contracts.status }).from(contracts).where(eq(contracts.id, contractId)).limit(1);
  if (!c) throw new ActionError("Contract not found.");
  if (!c.renewalDate) throw new ActionError("Set a renewal date on the contract first.");
  if (!["renew", "amend", "not_renewing"].includes(input.decision)) throw new ActionError("Unknown decision.");
  const note = input.note?.trim() || null;
  if (input.decision === "not_renewing" && !note) throw new ActionError("Say why the customer is not renewing.");
  const now = new Date();
  await db.update(contracts).set({ renewalDecision: input.decision, renewalDecisionFor: c.renewalDate, renewalDecidedAt: now, renewalDecidedByUserId: actorUserId, renewalDecisionNote: note, updatedAt: now }).where(eq(contracts.id, contractId));
  await audit({ actorUserId, action: "contract.renewal_decision", entityType: "contract", entityId: contractId, details: { decision: input.decision, renewalDate: c.renewalDate, note } });
  await logActivity({ type: "contract", companyId: c.companyId, entityType: "contract", entityId: contractId, title: `Renewal ${c.renewalDate}: ${DECISION_LABELS[input.decision].toLowerCase()} (${c.name})`, body: note, actorUserId });
}

export async function clearRenewalDecision(contractId: string, actorUserId: string) {
  const [c] = await db.select({ id: contracts.id, renewalDate: contracts.renewalDate, decision: contracts.renewalDecision }).from(contracts).where(eq(contracts.id, contractId)).limit(1);
  if (!c) throw new ActionError("Contract not found.");
  await db.update(contracts).set({ renewalDecision: null, renewalDecisionFor: null, renewalDecidedAt: null, renewalDecidedByUserId: null, renewalDecisionNote: null, updatedAt: new Date() }).where(eq(contracts.id, contractId));
  await audit({ actorUserId, action: "contract.renewal_decision", entityType: "contract", entityId: contractId, details: { decision: null, previous: c.decision, renewalDate: c.renewalDate } });
}
