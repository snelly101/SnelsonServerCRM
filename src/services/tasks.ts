import { and, asc, desc, eq, isNull, lt, or, sql, count, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { companies, contracts, opportunities, tasks, user } from "@/db/schema";
import { audit, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import type { TaskInput } from "@/lib/validation-sales";

export type TaskListParams = {
  q?: string;
  status?: "open" | "done" | "all";
  ownerUserId?: string;
  priority?: string;
  due?: "overdue" | "today" | "week" | "none";
  companyId?: string;
  opportunityId?: string;
  contractId?: string;
  page?: number;
  pageSize?: number;
};

function where(p: TaskListParams): SQL | undefined {
  const conds: (SQL | undefined)[] = [];
  const status = p.status ?? "open";
  if (status !== "all") conds.push(eq(tasks.status, status));
  if (p.q) conds.push(or(sql`${tasks.title} ilike ${"%" + p.q + "%"}`, sql`${companies.name} ilike ${"%" + p.q + "%"}`));
  if (p.ownerUserId) conds.push(p.ownerUserId === "unassigned" ? isNull(tasks.ownerUserId) : eq(tasks.ownerUserId, p.ownerUserId));
  if (p.priority) conds.push(eq(tasks.priority, p.priority as "low" | "normal" | "high" | "urgent"));
  if (p.companyId) conds.push(eq(tasks.companyId, p.companyId));
  if (p.opportunityId) conds.push(eq(tasks.opportunityId, p.opportunityId));
  if (p.contractId) conds.push(eq(tasks.contractId, p.contractId));
  if (p.due === "overdue") conds.push(and(eq(tasks.status, "open"), lt(tasks.dueDate, sql`current_date`)));
  if (p.due === "today") conds.push(sql`${tasks.dueDate} = current_date`);
  if (p.due === "week") conds.push(sql`${tasks.dueDate} between current_date and current_date + 7`);
  if (p.due === "none") conds.push(isNull(tasks.dueDate));
  return and(...conds.filter((c): c is SQL => Boolean(c)));
}

const selectRow = {
  id: tasks.id,
  title: tasks.title,
  description: tasks.description,
  status: tasks.status,
  priority: tasks.priority,
  dueDate: tasks.dueDate,
  ownerUserId: tasks.ownerUserId,
  ownerName: user.name,
  companyId: tasks.companyId,
  companyName: companies.name,
  opportunityId: tasks.opportunityId,
  opportunityTitle: opportunities.title,
  contractId: tasks.contractId,
  contractName: contracts.name,
  onboardingId: tasks.onboardingId,
  sourceKey: tasks.sourceKey,
  completedAt: tasks.completedAt,
  createdAt: tasks.createdAt,
  overdue: sql<boolean>`(${tasks.status} = 'open' and ${tasks.dueDate} < current_date)`,
};

export async function listTasks(p: TaskListParams) {
  const page = p.page ?? 1;
  const pageSize = Math.min(p.pageSize ?? 50, 200);
  const w = where(p);
  const base = () => db.select(selectRow).from(tasks).leftJoin(user, eq(user.id, tasks.ownerUserId)).leftJoin(companies, eq(companies.id, tasks.companyId)).leftJoin(opportunities, eq(opportunities.id, tasks.opportunityId)).leftJoin(contracts, eq(contracts.id, tasks.contractId));
  const [rows, [{ total }]] = await Promise.all([
    base()
      .where(w)
      .orderBy(asc(tasks.status), sql`${tasks.dueDate} asc nulls last`, desc(tasks.priority), asc(tasks.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(tasks).leftJoin(companies, eq(companies.id, tasks.companyId)).where(w),
  ]);
  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function taskCounts(ownerUserId: string) {
  const [row] = await db
    .select({
      mine: sql<number>`count(*) filter (where ${tasks.ownerUserId} = ${ownerUserId} and ${tasks.status} = 'open')`.mapWith(Number),
      mineOverdue: sql<number>`count(*) filter (where ${tasks.ownerUserId} = ${ownerUserId} and ${tasks.status} = 'open' and ${tasks.dueDate} < current_date)`.mapWith(Number),
      allOverdue: sql<number>`count(*) filter (where ${tasks.status} = 'open' and ${tasks.dueDate} < current_date)`.mapWith(Number),
      dueToday: sql<number>`count(*) filter (where ${tasks.status} = 'open' and ${tasks.dueDate} = current_date)`.mapWith(Number),
    })
    .from(tasks);
  return row;
}

function toValues(input: TaskInput) {
  return {
    title: input.title,
    description: input.description,
    priority: input.priority,
    dueDate: input.dueDate,
    ownerUserId: input.ownerUserId,
    companyId: input.companyId,
    opportunityId: input.opportunityId,
    contractId: input.contractId,
    onboardingId: input.onboardingId,
  };
}

export async function createTask(input: TaskInput, actorUserId: string | null, sourceKey?: string) {
  // Derive the company from a linked opportunity/contract so the task shows on the customer overview.
  let companyId = input.companyId;
  if (!companyId && input.opportunityId) {
    const [o] = await db.select({ companyId: opportunities.companyId }).from(opportunities).where(eq(opportunities.id, input.opportunityId));
    companyId = o?.companyId ?? null;
  }
  if (!companyId && input.contractId) {
    const [c] = await db.select({ companyId: contracts.companyId }).from(contracts).where(eq(contracts.id, input.contractId));
    companyId = c?.companyId ?? null;
  }
  const [row] = await db
    .insert(tasks)
    .values({ ...toValues(input), companyId, ownerUserId: input.ownerUserId ?? actorUserId, sourceKey: sourceKey ?? null, createdByUserId: actorUserId })
    .onConflictDoNothing({ target: tasks.sourceKey })
    .returning({ id: tasks.id });
  if (!row) return null; // already exists for this sourceKey
  await audit({ actorUserId, action: "task.create", entityType: "task", entityId: row.id, details: { title: input.title, sourceKey } });
  return row.id;
}

export async function updateTask(id: string, input: TaskInput, actorUserId: string) {
  const [before] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!before) throw new ActionError("Task not found.");
  await db.update(tasks).set({ ...toValues(input), companyId: input.companyId ?? before.companyId, updatedAt: new Date() }).where(eq(tasks.id, id));
  await audit({ actorUserId, action: "task.update", entityType: "task", entityId: id, details: { title: input.title } });
}

export async function setTaskStatus(id: string, status: "open" | "done", actorUserId: string) {
  const [t] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!t) throw new ActionError("Task not found.");
  await db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({ status, completedAt: status === "done" ? new Date() : null, completedByUserId: status === "done" ? actorUserId : null, updatedAt: new Date() })
      .where(eq(tasks.id, id));
    await audit({ actorUserId, action: status === "done" ? "task.complete" : "task.reopen", entityType: "task", entityId: id }, tx);
    if (status === "done" && t.companyId) {
      await logActivity({ type: "task", companyId: t.companyId, entityType: "task", entityId: id, title: `Task completed: ${t.title}`, actorUserId }, tx);
    }
  });
}

export async function deleteTask(id: string, actorUserId: string) {
  await db.delete(tasks).where(eq(tasks.id, id));
  await audit({ actorUserId, action: "task.delete", entityType: "task", entityId: id });
}
