import { and, asc, desc, eq, inArray, isNull, sql, count, type SQL, max, type AnyColumn } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { companies, contacts, opportunities, opportunityLines, pipelineStages, user } from "@/db/schema";
import { audit, diffFields, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { summariseLines, weighted, type RevenueSummary } from "@/lib/money";
import type { LineInput, OpportunityInput } from "@/lib/validation-sales";
import { createOnboardingOnce } from "./onboarding";

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------
export async function listStages(includeArchived = false) {
  const rows = await db.select().from(pipelineStages).orderBy(asc(pipelineStages.sortOrder));
  return includeArchived ? rows : rows.filter((s) => !s.archivedAt);
}

export async function createStage(input: { name: string; probability: number; color: string }, actorUserId: string) {
  const [{ maxOrder }] = await db.select({ maxOrder: max(pipelineStages.sortOrder) }).from(pipelineStages);
  // Insert before the won/lost stages so the board reads left-to-right.
  const closed = await db.select({ id: pipelineStages.id, sortOrder: pipelineStages.sortOrder }).from(pipelineStages).where(sql`${pipelineStages.isWon} or ${pipelineStages.isLost}`);
  const order = closed.length ? Math.min(...closed.map((c) => c.sortOrder)) : (maxOrder ?? 0) + 1;
  await db.transaction(async (tx) => {
    await tx.update(pipelineStages).set({ sortOrder: sql`${pipelineStages.sortOrder} + 1` }).where(sql`${pipelineStages.sortOrder} >= ${order}`);
    const [row] = await tx.insert(pipelineStages).values({ ...input, sortOrder: order }).returning({ id: pipelineStages.id });
    await audit({ actorUserId, action: "stage.create", entityType: "pipeline_stage", entityId: row.id, details: input }, tx);
  });
}

export async function updateStage(id: string, input: { name: string; probability: number; color: string }, actorUserId: string) {
  await db.update(pipelineStages).set({ ...input, updatedAt: new Date() }).where(eq(pipelineStages.id, id));
  await audit({ actorUserId, action: "stage.update", entityType: "pipeline_stage", entityId: id, details: input });
}

export async function reorderStages(ids: string[], actorUserId: string) {
  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) await tx.update(pipelineStages).set({ sortOrder: i }).where(eq(pipelineStages.id, ids[i]));
    await audit({ actorUserId, action: "stage.reorder", entityType: "pipeline_stage", details: { ids } }, tx);
  });
}

export async function archiveStage(id: string, actorUserId: string) {
  const [stage] = await db.select().from(pipelineStages).where(eq(pipelineStages.id, id)).limit(1);
  if (!stage) throw new ActionError("Stage not found.");
  if (stage.isWon || stage.isLost) throw new ActionError("The Won and Lost stages cannot be removed.");
  const [{ open }] = await db.select({ open: count() }).from(opportunities).where(and(eq(opportunities.stageId, id), eq(opportunities.status, "open"), isNull(opportunities.archivedAt)));
  if (open > 0) throw new ActionError(`Move the ${open} open opportunit${open === 1 ? "y" : "ies"} out of this stage first.`);
  await db.update(pipelineStages).set({ archivedAt: new Date() }).where(eq(pipelineStages.id, id));
  await audit({ actorUserId, action: "stage.archive", entityType: "pipeline_stage", entityId: id });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
export type OpportunityListParams = {
  q?: string;
  status?: string;
  stageId?: string;
  ownerUserId?: string;
  companyId?: string;
  closingBefore?: string;
  sort?: string;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

function where(p: OpportunityListParams): SQL | undefined {
  const conds: (SQL | undefined)[] = [isNull(opportunities.archivedAt)];
  if (p.q) conds.push(sql`(${opportunities.title} ilike ${"%" + p.q + "%"} or ${companies.name} ilike ${"%" + p.q + "%"})`);
  if (p.status && p.status !== "all") conds.push(eq(opportunities.status, p.status as "open" | "won" | "lost"));
  if (p.stageId) conds.push(eq(opportunities.stageId, p.stageId));
  if (p.ownerUserId) conds.push(eq(opportunities.ownerUserId, p.ownerUserId));
  if (p.companyId) conds.push(eq(opportunities.companyId, p.companyId));
  if (p.closingBefore) conds.push(sql`${opportunities.expectedCloseDate} <= ${p.closingBefore}`);
  return and(...conds.filter((c): c is SQL => Boolean(c)));
}

const lineSummarySubquery = sql<string>`(
  select coalesce(json_agg(json_build_object(
    'quantity', l.quantity, 'unitPrice', l.unit_price, 'unitCost', l.unit_cost,
    'revenueType', l.revenue_type, 'billingFrequency', l.billing_frequency)), '[]'::json)
  from opportunity_lines l where l.opportunity_id = opportunities.id)`;

type LineJson = { quantity: string; unitPrice: string; unitCost: string | null; revenueType: "recurring" | "one_off_project" | "hardware"; billingFrequency: "monthly" | "quarterly" | "annual" | "one_off" };

function parseLines(json: unknown): LineJson[] {
  if (Array.isArray(json)) return json as LineJson[];
  if (typeof json === "string") return JSON.parse(json) as LineJson[];
  return [];
}

export type OpportunityRow = {
  id: string;
  title: string;
  status: "open" | "won" | "lost";
  stageId: string;
  stageName: string;
  stageColor: string;
  companyId: string;
  companyName: string;
  ownerName: string | null;
  ownerUserId: string | null;
  expectedCloseDate: string | null;
  probability: number;
  nextAction: string | null;
  nextActionDate: string | null;
  boardOrder: number;
  updatedAt: Date;
  summary: RevenueSummary;
  weightedValue: number;
  openTasks: number;
  overdueTasks: number;
};

const selectRow = {
  id: opportunities.id,
  title: opportunities.title,
  status: opportunities.status,
  stageId: opportunities.stageId,
  stageName: pipelineStages.name,
  stageColor: pipelineStages.color,
  companyId: opportunities.companyId,
  companyName: companies.name,
  ownerName: user.name,
  ownerUserId: opportunities.ownerUserId,
  expectedCloseDate: opportunities.expectedCloseDate,
  probability: opportunities.probability,
  nextAction: opportunities.nextAction,
  nextActionDate: opportunities.nextActionDate,
  boardOrder: opportunities.boardOrder,
  updatedAt: opportunities.updatedAt,
  lines: lineSummarySubquery,
  openTasks: sql<number>`(select count(*) from tasks t where t.opportunity_id = opportunities.id and t.status = 'open')`.mapWith(Number),
  overdueTasks: sql<number>`(select count(*) from tasks t where t.opportunity_id = opportunities.id and t.status = 'open' and t.due_date < current_date)`.mapWith(Number),
};

function toRow(r: Record<string, unknown>): OpportunityRow {
  const summary = summariseLines(parseLines(r.lines));
  const { lines: _lines, ...rest } = r;
  void _lines;
  return { ...(rest as Omit<OpportunityRow, "summary" | "weightedValue">), summary, weightedValue: weighted(summary.firstYearValue, r.probability as number) };
}

export async function listOpportunities(p: OpportunityListParams) {
  const page = p.page ?? 1;
  const pageSize = Math.min(p.pageSize ?? 25, 200);
  const w = where(p);
  const sortMap: Record<string, AnyColumn | SQL> = {
    title: opportunities.title,
    company: companies.name,
    stage: pipelineStages.sortOrder,
    closeDate: opportunities.expectedCloseDate,
    probability: opportunities.probability,
    updatedAt: opportunities.updatedAt,
  };
  const col = sortMap[p.sort ?? "updatedAt"] ?? opportunities.updatedAt;
  const order = p.dir === "asc" ? asc(col) : desc(col);
  const base = db.select(selectRow).from(opportunities).innerJoin(companies, eq(companies.id, opportunities.companyId)).innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId)).leftJoin(user, eq(user.id, opportunities.ownerUserId)).where(w);
  const [rows, [{ total }]] = await Promise.all([
    base.orderBy(order, asc(opportunities.id)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ total: count() }).from(opportunities).innerJoin(companies, eq(companies.id, opportunities.companyId)).where(w),
  ]);
  return { rows: rows.map((r) => toRow(r)), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** All open opportunities grouped by stage for the board. */
export async function boardData(p: { ownerUserId?: string; q?: string }) {
  const stages = await listStages();
  const rows = await db
    .select(selectRow)
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
    .leftJoin(user, eq(user.id, opportunities.ownerUserId))
    .where(where({ ...p, status: "open" }))
    .orderBy(asc(opportunities.boardOrder), asc(opportunities.updatedAt));
  const byStage = new Map<string, OpportunityRow[]>();
  for (const r of rows) {
    const row = toRow(r);
    byStage.set(row.stageId, [...(byStage.get(row.stageId) ?? []), row]);
  }
  return stages
    .filter((s) => !s.isWon && !s.isLost)
    .map((s) => {
      const items = byStage.get(s.id) ?? [];
      return { stage: s, items, total: items.reduce((a, r) => a + r.summary.firstYearValue, 0), weighted: items.reduce((a, r) => a + r.weightedValue, 0) };
    });
}

export async function getOpportunity(id: string) {
  const [row] = await db
    .select({ ...selectRow, contactId: opportunities.contactId, leadSource: opportunities.leadSource, lostReason: opportunities.lostReason, wonAt: opportunities.wonAt, lostAt: opportunities.lostAt, notes: opportunities.notes, customFields: opportunities.customFields, createdAt: opportunities.createdAt, archivedAt: opportunities.archivedAt })
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
    .leftJoin(user, eq(user.id, opportunities.ownerUserId))
    .where(eq(opportunities.id, id))
    .limit(1);
  if (!row) return null;
  const [lines, contact] = await Promise.all([
    db.select().from(opportunityLines).where(eq(opportunityLines.opportunityId, id)).orderBy(asc(opportunityLines.sortOrder)),
    row.contactId ? db.select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email }).from(contacts).where(eq(contacts.id, row.contactId)).limit(1) : Promise.resolve([]),
  ]);
  return { ...toRow(row), contactId: row.contactId, leadSource: row.leadSource, lostReason: row.lostReason, wonAt: row.wonAt, lostAt: row.lostAt, notes: row.notes, customFields: row.customFields, createdAt: row.createdAt, archivedAt: row.archivedAt, lines, contact: contact[0] ?? null };
}

export async function pipelineTotals() {
  const rows = await db
    .select({ probability: opportunities.probability, lines: lineSummarySubquery, expectedCloseDate: opportunities.expectedCloseDate })
    .from(opportunities)
    .where(and(eq(opportunities.status, "open"), isNull(opportunities.archivedAt)));
  let total = 0;
  let weightedTotal = 0;
  let mrr = 0;
  let overdue = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const r of rows) {
    const s = summariseLines(parseLines(r.lines));
    total += s.firstYearValue;
    weightedTotal += weighted(s.firstYearValue, r.probability);
    mrr += s.mrr;
    if (r.expectedCloseDate && r.expectedCloseDate < today) overdue++;
  }
  return { count: rows.length, total, weighted: weightedTotal, mrr, overdueClose: overdue };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
async function stageProbability(stageId: string) {
  const [s] = await db.select({ probability: pipelineStages.probability, isWon: pipelineStages.isWon, isLost: pipelineStages.isLost }).from(pipelineStages).where(eq(pipelineStages.id, stageId)).limit(1);
  if (!s) throw new ActionError("Stage not found.");
  return s;
}

function toValues(input: OpportunityInput, probability: number) {
  return {
    companyId: input.companyId,
    contactId: input.contactId,
    title: input.title,
    stageId: input.stageId,
    ownerUserId: input.ownerUserId,
    expectedCloseDate: input.expectedCloseDate,
    probability,
    leadSource: input.leadSource,
    nextAction: input.nextAction,
    nextActionDate: input.nextActionDate,
    notes: input.notes,
    customFields: input.customFields,
  };
}

export async function createOpportunity(input: OpportunityInput, lines: LineInput[], actorUserId: string) {
  const stage = await stageProbability(input.stageId);
  if (stage.isWon || stage.isLost) throw new ActionError("Create the opportunity in an open stage, then mark it won or lost.");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(opportunities)
      .values({ ...toValues(input, input.probability ?? stage.probability), ownerUserId: input.ownerUserId ?? actorUserId, createdByUserId: actorUserId })
      .returning({ id: opportunities.id });
    await replaceLines(tx, row.id, lines);
    await audit({ actorUserId, action: "opportunity.create", entityType: "opportunity", entityId: row.id, details: { title: input.title, companyId: input.companyId } }, tx);
    await logActivity({ type: "system", companyId: input.companyId, entityType: "opportunity", entityId: row.id, title: `Opportunity created: ${input.title}`, actorUserId }, tx);
    return row.id;
  });
}

export async function updateOpportunity(id: string, input: OpportunityInput, lines: LineInput[] | null, actorUserId: string) {
  const [before] = await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1);
  if (!before) throw new ActionError("Opportunity not found.");
  if (before.status !== "open") throw new ActionError("This opportunity is closed. Reopen it to edit.");
  const stage = await stageProbability(input.stageId);
  const probability = input.probability ?? (input.stageId !== before.stageId ? stage.probability : before.probability);
  const next = toValues(input, probability);
  const changes = diffFields(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
  await db.transaction(async (tx) => {
    await tx.update(opportunities).set({ ...next, updatedAt: new Date() }).where(eq(opportunities.id, id));
    if (lines) await replaceLines(tx, id, lines);
    await audit({ actorUserId, action: "opportunity.update", entityType: "opportunity", entityId: id, details: { changes, linesReplaced: Boolean(lines) } }, tx);
    if (changes.stageId) {
      const [s] = await tx.select({ name: pipelineStages.name }).from(pipelineStages).where(eq(pipelineStages.id, input.stageId));
      await logActivity({ type: "system", companyId: before.companyId, entityType: "opportunity", entityId: id, title: `${before.title}: moved to ${s?.name}`, actorUserId }, tx);
    }
  });
}

async function replaceLines(tx: Tx, opportunityId: string, lines: LineInput[]) {
  await tx.delete(opportunityLines).where(eq(opportunityLines.opportunityId, opportunityId));
  if (!lines.length) return;
  await tx.insert(opportunityLines).values(
    lines.map((l, i) => ({
      opportunityId,
      productId: l.productId,
      description: l.description,
      revenueType: l.revenueType,
      pricingModel: l.pricingModel,
      billingFrequency: l.revenueType === "recurring" ? l.billingFrequency : ("one_off" as const),
      quantity: String(l.quantity),
      unitPrice: String(l.unitPrice),
      unitCost: l.unitCost === null ? null : String(l.unitCost),
      sortOrder: i,
    })),
  );
}

/** Drag-and-drop: move to a stage and position. Applies the stage's default probability if moving stage. */
export async function moveOpportunity(id: string, stageId: string, position: number, actorUserId: string) {
  const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1);
  if (!opp) throw new ActionError("Opportunity not found.");
  if (opp.status !== "open") throw new ActionError("Closed opportunities cannot be moved. Reopen it first.");
  const stage = await stageProbability(stageId);
  if (stage.isWon || stage.isLost) throw new ActionError("Use the Mark won / Mark lost buttons for closing stages.");
  await db.transaction(async (tx) => {
    const siblings = await tx
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(and(eq(opportunities.stageId, stageId), eq(opportunities.status, "open"), isNull(opportunities.archivedAt), sql`${opportunities.id} <> ${id}`))
      .orderBy(asc(opportunities.boardOrder), asc(opportunities.updatedAt));
    const ordered = siblings.map((s) => s.id);
    ordered.splice(Math.max(0, Math.min(position, ordered.length)), 0, id);
    for (let i = 0; i < ordered.length; i++) {
      await tx.update(opportunities).set({ boardOrder: i }).where(eq(opportunities.id, ordered[i]));
    }
    const stageChanged = opp.stageId !== stageId;
    await tx
      .update(opportunities)
      .set({ stageId, probability: stageChanged ? stage.probability : opp.probability, updatedAt: new Date() })
      .where(eq(opportunities.id, id));
    if (stageChanged) {
      const [s] = await tx.select({ name: pipelineStages.name }).from(pipelineStages).where(eq(pipelineStages.id, stageId));
      await audit({ actorUserId, action: "opportunity.stage", entityType: "opportunity", entityId: id, details: { from: opp.stageId, to: stageId } }, tx);
      await logActivity({ type: "system", companyId: opp.companyId, entityType: "opportunity", entityId: id, title: `${opp.title}: moved to ${s?.name}`, actorUserId }, tx);
    }
  });
}

/**
 * Marks the opportunity won. Promotes the company to customer, and (optionally)
 * creates the onboarding exactly once via the unique source key.
 * Phase 3 calls this from the Better Proposals acceptance handler with the
 * proposal id as the onboarding source key.
 */
export async function markWon(id: string, actorUserId: string | null, opts?: { createOnboarding?: boolean; onboardingSourceKey?: string; source?: string }, tx?: Tx) {
  const run = async (t: Tx) => {
    const [opp] = await t.select().from(opportunities).where(eq(opportunities.id, id)).for("update");
    if (!opp) throw new ActionError("Opportunity not found.");
    const alreadyWon = opp.status === "won";
    const [wonStage] = await t.select({ id: pipelineStages.id }).from(pipelineStages).where(eq(pipelineStages.isWon, true)).limit(1);
    if (!alreadyWon) {
      await t.update(opportunities).set({ status: "won", stageId: wonStage.id, probability: 100, wonAt: new Date(), updatedAt: new Date() }).where(eq(opportunities.id, id));
      await t.update(companies).set({ status: "customer", updatedAt: new Date() }).where(and(eq(companies.id, opp.companyId), eq(companies.status, "prospect")));
      await audit({ actorUserId, action: "opportunity.won", entityType: "opportunity", entityId: id, details: { source: opts?.source ?? "user" } }, t);
      await logActivity({ type: "system", companyId: opp.companyId, entityType: "opportunity", entityId: id, title: `Opportunity won: ${opp.title}`, actorUserId, source: opts?.source }, t);
    }
    let onboardingId: string | null = null;
    if (opts?.createOnboarding !== false) {
      onboardingId = await createOnboardingOnce(
        { companyId: opp.companyId, opportunityId: id, sourceKey: opts?.onboardingSourceKey ?? `opportunity:${id}`, name: `Onboarding: ${opp.title}`, ownerUserId: opp.ownerUserId ?? actorUserId },
        actorUserId,
        t,
      );
    }
    return { alreadyWon, onboardingId };
  };
  return tx ? run(tx) : db.transaction(run);
}

export async function markLost(id: string, reason: string, actorUserId: string) {
  const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1);
  if (!opp) throw new ActionError("Opportunity not found.");
  const [lostStage] = await db.select({ id: pipelineStages.id }).from(pipelineStages).where(eq(pipelineStages.isLost, true)).limit(1);
  await db.transaction(async (tx) => {
    await tx.update(opportunities).set({ status: "lost", stageId: lostStage.id, probability: 0, lostReason: reason, lostAt: new Date(), updatedAt: new Date() }).where(eq(opportunities.id, id));
    await audit({ actorUserId, action: "opportunity.lost", entityType: "opportunity", entityId: id, details: { reason } }, tx);
    await logActivity({ type: "system", companyId: opp.companyId, entityType: "opportunity", entityId: id, title: `Opportunity lost: ${opp.title}`, body: reason, actorUserId }, tx);
  });
}

export async function reopenOpportunity(id: string, actorUserId: string) {
  const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1);
  if (!opp) throw new ActionError("Opportunity not found.");
  const stages = await listStages();
  const first = stages.find((s) => !s.isWon && !s.isLost);
  if (!first) throw new ActionError("No open stage exists.");
  await db.transaction(async (tx) => {
    await tx.update(opportunities).set({ status: "open", stageId: first.id, probability: first.probability, wonAt: null, lostAt: null, lostReason: null, updatedAt: new Date() }).where(eq(opportunities.id, id));
    await audit({ actorUserId, action: "opportunity.reopen", entityType: "opportunity", entityId: id }, tx);
    await logActivity({ type: "system", companyId: opp.companyId, entityType: "opportunity", entityId: id, title: `Opportunity reopened: ${opp.title}`, actorUserId }, tx);
  });
}

export async function archiveOpportunity(id: string, actorUserId: string) {
  await db.update(opportunities).set({ archivedAt: new Date() }).where(eq(opportunities.id, id));
  await audit({ actorUserId, action: "opportunity.archive", entityType: "opportunity", entityId: id });
}

export async function listCompanyOpportunities(companyId: string) {
  const res = await listOpportunities({ companyId, status: "all", pageSize: 100, sort: "updatedAt", dir: "desc" });
  return res.rows;
}

export async function listLeadSources() {
  const rows = await db.selectDistinct({ s: opportunities.leadSource }).from(opportunities).where(sql`${opportunities.leadSource} is not null`);
  return rows.map((r) => r.s!).filter(Boolean).sort();
}

export { inArray };
