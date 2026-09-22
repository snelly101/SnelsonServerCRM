import { and, asc, desc, eq, isNull, sql, count, type SQL, inArray } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { companies, contractLines, contracts, opportunityLines, sites, tasks, user } from "@/db/schema";
import { audit, diffFields, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { summariseLines, type RevenueSummary } from "@/lib/money";
import type { ContractInput, ContractLineInput } from "@/lib/validation-sales";
import { createTask } from "./tasks";

export type ContractListParams = {
  q?: string;
  status?: string;
  companyId?: string;
  ownerUserId?: string;
  renewingWithinDays?: number;
  page?: number;
  pageSize?: number;
};

function where(p: ContractListParams): SQL | undefined {
  const conds: (SQL | undefined)[] = [isNull(contracts.archivedAt)];
  if (p.q) conds.push(sql`(${contracts.name} ilike ${"%" + p.q + "%"} or ${companies.name} ilike ${"%" + p.q + "%"} or ${contracts.reference} ilike ${"%" + p.q + "%"})`);
  if (p.status && p.status !== "all") conds.push(eq(contracts.status, p.status as "draft" | "active" | "expired" | "cancelled"));
  if (p.companyId) conds.push(eq(contracts.companyId, p.companyId));
  if (p.ownerUserId) conds.push(eq(contracts.ownerUserId, p.ownerUserId));
  if (p.renewingWithinDays !== undefined) conds.push(sql`${contracts.renewalDate} between current_date and current_date + ${p.renewingWithinDays}::int`);
  return and(...conds.filter((c): c is SQL => Boolean(c)));
}

const linesJson = sql<string>`(
  select coalesce(json_agg(json_build_object(
    'quantity', l.quantity, 'unitPrice', l.unit_price, 'unitCost', l.unit_cost,
    'revenueType', l.revenue_type, 'billingFrequency', l.billing_frequency)), '[]'::json)
  from contract_lines l where l.contract_id = contracts.id)`;

const selectRow = {
  id: contracts.id,
  name: contracts.name,
  reference: contracts.reference,
  status: contracts.status,
  companyId: contracts.companyId,
  companyName: companies.name,
  ownerName: user.name,
  startDate: contracts.startDate,
  endDate: contracts.endDate,
  renewalDate: contracts.renewalDate,
  noticePeriodDays: contracts.noticePeriodDays,
  autoRenew: contracts.autoRenew,
  billingFrequency: contracts.billingFrequency,
  nextReviewDate: contracts.nextReviewDate,
  updatedAt: contracts.updatedAt,
  lines: linesJson,
};

type Row = Omit<typeof selectRow, "lines"> & { lines: unknown };
function withSummary<T extends { lines: unknown }>(r: T): Omit<T, "lines"> & { summary: RevenueSummary; noticeDeadline: string | null } {
  const raw = typeof r.lines === "string" ? JSON.parse(r.lines) : r.lines;
  const { lines: _l, ...rest } = r;
  void _l;
  const row = rest as unknown as { renewalDate: string | null; noticePeriodDays: number };
  const noticeDeadline = row.renewalDate ? new Date(new Date(row.renewalDate).getTime() - row.noticePeriodDays * 86400000).toISOString().slice(0, 10) : null;
  return { ...rest, summary: summariseLines(Array.isArray(raw) ? raw : []), noticeDeadline };
}
void (0 as unknown as Row);

export async function listContracts(p: ContractListParams) {
  const page = p.page ?? 1;
  const pageSize = Math.min(p.pageSize ?? 25, 200);
  const w = where(p);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select(selectRow)
      .from(contracts)
      .innerJoin(companies, eq(companies.id, contracts.companyId))
      .leftJoin(user, eq(user.id, contracts.ownerUserId))
      .where(w)
      .orderBy(asc(contracts.status), sql`${contracts.renewalDate} asc nulls last`, asc(companies.name))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(contracts).innerJoin(companies, eq(companies.id, contracts.companyId)).where(w),
  ]);
  return { rows: rows.map(withSummary), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getContract(id: string) {
  const [row] = await db
    .select({ ...selectRow, opportunityId: contracts.opportunityId, externalProposalId: contracts.externalProposalId, reviewIntervalMonths: contracts.reviewIntervalMonths, ownerUserId: contracts.ownerUserId, notes: contracts.notes, createdAt: contracts.createdAt, archivedAt: contracts.archivedAt })
    .from(contracts)
    .innerJoin(companies, eq(companies.id, contracts.companyId))
    .leftJoin(user, eq(user.id, contracts.ownerUserId))
    .where(eq(contracts.id, id))
    .limit(1);
  if (!row) return null;
  const lines = await db
    .select({ line: contractLines, siteName: sites.name })
    .from(contractLines)
    .leftJoin(sites, eq(sites.id, contractLines.siteId))
    .where(eq(contractLines.contractId, id))
    .orderBy(asc(contractLines.sortOrder));
  return { ...withSummary(row), lines: lines.map((l) => ({ ...l.line, siteName: l.siteName })) };
}

/**
 * MRR across active contracts, with the recurring/one-off split.
 * Documented formula: Σ recurring lines (quantity × unit price ÷ months per period).
 */
export async function contractTotals() {
  const rows = await db.select({ status: contracts.status, lines: linesJson }).from(contracts).where(isNull(contracts.archivedAt));
  const out = { active: 0, mrr: 0, arr: 0, oneOff: 0, hardware: 0, marginIsEstimate: false };
  for (const r of rows) {
    if (r.status !== "active") continue;
    const s = withSummary(r).summary;
    out.active++;
    out.mrr += s.mrr;
    out.arr += s.arr;
    out.oneOff += s.oneOff;
    out.hardware += s.hardware;
    if (s.marginIsEstimate) out.marginIsEstimate = true;
  }
  return out;
}

function toValues(input: ContractInput) {
  return {
    companyId: input.companyId,
    opportunityId: input.opportunityId,
    name: input.name,
    reference: input.reference,
    status: input.status,
    startDate: input.startDate,
    endDate: input.endDate,
    renewalDate: input.renewalDate ?? input.endDate,
    noticePeriodDays: input.noticePeriodDays,
    autoRenew: input.autoRenew,
    billingFrequency: input.billingFrequency,
    nextReviewDate: input.nextReviewDate,
    reviewIntervalMonths: input.reviewIntervalMonths,
    ownerUserId: input.ownerUserId,
    notes: input.notes,
  };
}

async function replaceLines(tx: Tx, contractId: string, lines: ContractLineInput[]) {
  await tx.delete(contractLines).where(eq(contractLines.contractId, contractId));
  if (!lines.length) return;
  await tx.insert(contractLines).values(
    lines.map((l, i) => ({
      contractId,
      productId: l.productId,
      siteId: l.siteId,
      description: l.description,
      revenueType: l.revenueType,
      pricingModel: l.pricingModel,
      billingFrequency: l.revenueType === "recurring" ? l.billingFrequency : ("one_off" as const),
      quantity: String(l.quantity),
      unitPrice: String(l.unitPrice),
      unitCost: l.unitCost === null ? null : String(l.unitCost),
      countsAsManagedDevice: l.pricingModel === "per_device" && l.countsAsManagedDevice,
      sortOrder: i,
    })),
  );
}

export async function createContract(input: ContractInput, lines: ContractLineInput[], actorUserId: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(contracts).values({ ...toValues(input), ownerUserId: input.ownerUserId ?? actorUserId }).returning({ id: contracts.id });
    await replaceLines(tx, row.id, lines);
    await audit({ actorUserId, action: "contract.create", entityType: "contract", entityId: row.id, details: { name: input.name, status: input.status } }, tx);
    await logActivity({ type: "contract", companyId: input.companyId, entityType: "contract", entityId: row.id, title: `Contract created: ${input.name}`, actorUserId }, tx);
    return row.id;
  });
}

export async function updateContract(id: string, input: ContractInput, lines: ContractLineInput[] | null, actorUserId: string) {
  const [before] = await db.select().from(contracts).where(eq(contracts.id, id)).limit(1);
  if (!before) throw new ActionError("Contract not found.");
  const next = toValues(input);
  const changes = diffFields(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
  await db.transaction(async (tx) => {
    await tx.update(contracts).set({ ...next, updatedAt: new Date() }).where(eq(contracts.id, id));
    if (lines) await replaceLines(tx, id, lines);
    await audit({ actorUserId, action: "contract.update", entityType: "contract", entityId: id, details: { changes, linesReplaced: Boolean(lines) } }, tx);
    if (changes.status) await logActivity({ type: "contract", companyId: before.companyId, entityType: "contract", entityId: id, title: `${before.name}: ${changes.status.from} → ${changes.status.to}`, actorUserId }, tx);
  });
}

export async function archiveContract(id: string, actorUserId: string) {
  await db.update(contracts).set({ archivedAt: new Date() }).where(eq(contracts.id, id));
  await audit({ actorUserId, action: "contract.archive", entityType: "contract", entityId: id });
}

/** Builds a draft contract from a won opportunity's lines. Idempotent per opportunity. */
export async function draftContractFromOpportunity(opportunityId: string, actorUserId: string | null, tx?: Tx) {
  const run = async (t: Tx) => {
    const [existing] = await t.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.opportunityId, opportunityId), isNull(contracts.archivedAt))).limit(1);
    if (existing) return existing.id;
    const [opp] = await t.select().from((await import("@/db/schema")).opportunities).where(eq((await import("@/db/schema")).opportunities.id, opportunityId)).limit(1);
    if (!opp) throw new ActionError("Opportunity not found.");
    const lines = await t.select().from(opportunityLines).where(eq(opportunityLines.opportunityId, opportunityId)).orderBy(asc(opportunityLines.sortOrder));
    const start = new Date().toISOString().slice(0, 10);
    const end = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const [row] = await t
      .insert(contracts)
      .values({ companyId: opp.companyId, opportunityId, name: opp.title, status: "draft", startDate: start, endDate: end, renewalDate: end, ownerUserId: opp.ownerUserId ?? actorUserId })
      .returning({ id: contracts.id });
    if (lines.length) {
      await t.insert(contractLines).values(
        lines.map((l, i) => ({
          contractId: row.id,
          productId: l.productId,
          description: l.description,
          revenueType: l.revenueType,
          pricingModel: l.pricingModel,
          billingFrequency: l.billingFrequency,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          unitCost: l.unitCost,
          countsAsManagedDevice: l.pricingModel === "per_device",
          sortOrder: i,
        })),
      );
    }
    await audit({ actorUserId, action: "contract.draft_from_opportunity", entityType: "contract", entityId: row.id, details: { opportunityId } }, t);
    await logActivity({ type: "contract", companyId: opp.companyId, entityType: "contract", entityId: row.id, title: `Draft contract created from ${opp.title}`, actorUserId }, t);
    return row.id;
  };
  return tx ? run(tx) : db.transaction(run);
}

/**
 * Renewal and review reminders. Creates one task per contract per renewal date
 * (source key makes it idempotent) when the notice deadline is within 30 days,
 * and one per review date. Run daily by the worker; also safe to call manually.
 */
export async function generateReminders(actorUserId: string | null = null) {
  const soon = await db
    .select({ id: contracts.id, name: contracts.name, companyId: contracts.companyId, ownerUserId: contracts.ownerUserId, renewalDate: contracts.renewalDate, noticePeriodDays: contracts.noticePeriodDays, nextReviewDate: contracts.nextReviewDate })
    .from(contracts)
    .where(and(eq(contracts.status, "active"), isNull(contracts.archivedAt)));
  let created = 0;
  const today = Date.now();
  for (const c of soon) {
    if (c.renewalDate) {
      const notice = new Date(c.renewalDate).getTime() - c.noticePeriodDays * 86400000;
      if (notice - today <= 30 * 86400000) {
        const id = await createTask(
          { title: `Renewal due: ${c.name} (notice deadline ${new Date(notice).toISOString().slice(0, 10)})`, description: null, priority: "high", dueDate: new Date(notice).toISOString().slice(0, 10), ownerUserId: c.ownerUserId, companyId: c.companyId, opportunityId: null, contractId: c.id, onboardingId: null },
          actorUserId,
          `renewal:${c.id}:${c.renewalDate}`,
        );
        if (id) created++;
      }
    }
    if (c.nextReviewDate && new Date(c.nextReviewDate).getTime() - today <= 14 * 86400000) {
      const id = await createTask(
        { title: `Account review: ${c.name}`, description: null, priority: "normal", dueDate: c.nextReviewDate, ownerUserId: c.ownerUserId, companyId: c.companyId, opportunityId: null, contractId: c.id, onboardingId: null },
        actorUserId,
        `review:${c.id}:${c.nextReviewDate}`,
      );
      if (id) created++;
    }
  }
  // Expire contracts whose end date has passed and that don't auto-renew.
  await db.update(contracts).set({ status: "expired", updatedAt: new Date() }).where(and(eq(contracts.status, "active"), eq(contracts.autoRenew, false), sql`${contracts.endDate} < current_date`));
  return { created };
}

export async function listCompanyContracts(companyId: string) {
  return (await listContracts({ companyId, status: "all", pageSize: 100 })).rows;
}

export { desc, inArray, tasks };
