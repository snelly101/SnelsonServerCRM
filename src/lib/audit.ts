import { db, type Tx } from "@/db";
import { activities, auditLog } from "@/db/schema";

type AuditInput = {
  actorUserId?: string | null;
  actorType?: "user" | "system";
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
};

const SECRET_KEYS = /password|secret|token|key|authorization/i;

/** Strips anything that looks like a credential before it reaches the audit table. */
export function scrubDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : v;
  }
  return out;
}

export async function audit(input: AuditInput, tx: Tx | typeof db = db) {
  await tx.insert(auditLog).values({
    actorUserId: input.actorUserId ?? null,
    actorType: input.actorType ?? (input.actorUserId ? "user" : "system"),
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    details: scrubDetails(input.details),
    ipAddress: input.ipAddress ?? null,
  });
}

type ActivityInput = {
  type: (typeof activities.$inferInsert)["type"];
  companyId?: string | null;
  contactId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  title: string;
  body?: string | null;
  actorUserId?: string | null;
  source?: string;
  metadata?: Record<string, unknown>;
};

/** Appends an entry to the customer-facing activity timeline. */
export async function logActivity(input: ActivityInput, tx: Tx | typeof db = db) {
  await tx.insert(activities).values({
    type: input.type,
    companyId: input.companyId ?? null,
    contactId: input.contactId ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    title: input.title,
    body: input.body ?? null,
    actorUserId: input.actorUserId ?? null,
    source: input.source ?? (input.actorUserId ? "user" : "system"),
    metadata: input.metadata,
  });
}

/**
 * Computes a shallow field diff for audit details. Only changed keys are kept,
 * so the audit log stays readable.
 */
export function diffFields<T extends Record<string, unknown>>(before: T | null, after: Partial<T>) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    const b = before?.[key];
    const a = after[key];
    if (JSON.stringify(b) !== JSON.stringify(a)) changes[key] = { from: b ?? null, to: a ?? null };
  }
  return changes;
}
