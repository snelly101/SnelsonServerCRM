import { and, desc, eq, isNull, sql, count } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { externalLinks, inboundEvents, integrationConnections, mappingConflicts, outboundRequests, syncErrors, syncRuns, user } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { logger } from "@/lib/logger";

export type Provider = "betterproposals" | "xero" | "ninjaone";
export const PROVIDERS: Provider[] = ["betterproposals", "xero", "ninjaone"];
export const PROVIDER_LABELS: Record<Provider, string> = { betterproposals: "Better Proposals", xero: "Xero", ninjaone: "NinjaOne" };

/** Demo adapters are only ever selected when DEMO_MODE=true. Deployment docs set it to false; the UI labels demo data everywhere. */
export const demoModeEnabled = () => process.env.DEMO_MODE === "true";

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------
export async function getConnection(provider: Provider) {
  const [row] = await db.select().from(integrationConnections).where(eq(integrationConnections.provider, provider)).limit(1);
  if (row) return row;
  const [created] = await db.insert(integrationConnections).values({ provider, mode: "demo", status: "not_configured" }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(integrationConnections).where(eq(integrationConnections.provider, provider)))[0];
}

export async function listConnections() {
  for (const p of PROVIDERS) await getConnection(p);
  return db.select().from(integrationConnections).orderBy(integrationConnections.provider);
}

/** Decrypts stored credentials. Server-side only; never return this to a page component's props. */
export async function getCredentials<T = Record<string, unknown>>(provider: Provider): Promise<T | null> {
  const c = await getConnection(provider);
  if (!c.credentialsEnc) return null;
  return JSON.parse(decryptSecret(c.credentialsEnc)) as T;
}

export async function setCredentials(provider: Provider, credentials: Record<string, unknown>, actorUserId: string | null, patch: Partial<typeof integrationConnections.$inferInsert> = {}) {
  await getConnection(provider);
  await db
    .update(integrationConnections)
    .set({ credentialsEnc: encryptSecret(JSON.stringify(credentials)), mode: "live", connectedByUserId: actorUserId ?? undefined, updatedAt: new Date(), ...patch })
    .where(eq(integrationConnections.provider, provider));
  await audit({ actorUserId, action: "integration.credentials.set", entityType: "integration", entityId: provider, details: { keys: Object.keys(credentials) } });
}

export async function updateConnection(provider: Provider, patch: Partial<typeof integrationConnections.$inferInsert>) {
  await getConnection(provider);
  await db.update(integrationConnections).set({ ...patch, updatedAt: new Date() }).where(eq(integrationConnections.provider, provider));
}

export async function setConnectionConfig(provider: Provider, config: Record<string, unknown>, actorUserId: string) {
  const c = await getConnection(provider);
  await db.update(integrationConnections).set({ config: { ...c.config, ...config }, updatedAt: new Date() }).where(eq(integrationConnections.provider, provider));
  await audit({ actorUserId, action: "integration.config.set", entityType: "integration", entityId: provider, details: config });
}

export async function disconnect(provider: Provider, actorUserId: string) {
  await db
    .update(integrationConnections)
    .set({ credentialsEnc: null, mode: "demo", status: "not_configured", externalAccountName: null, externalAccountId: null, lastError: null, pausedUntil: null, consecutiveFailures: 0, updatedAt: new Date() })
    .where(eq(integrationConnections.provider, provider));
  await audit({ actorUserId, action: "integration.disconnect", entityType: "integration", entityId: provider });
}

/** Records a failure and pauses scheduled syncs with backoff after repeated failures (circuit breaker). */
export async function recordFailure(provider: Provider, message: string) {
  const c = await getConnection(provider);
  const failures = c.consecutiveFailures + 1;
  const pauseMinutes = failures >= 3 ? Math.min(240, 5 * 2 ** (failures - 3)) : 0;
  await db
    .update(integrationConnections)
    .set({ status: /401|403|Authentication|Invalid token/i.test(message) ? "expired" : "error", lastError: message.slice(0, 1000), consecutiveFailures: failures, pausedUntil: pauseMinutes ? new Date(Date.now() + pauseMinutes * 60_000) : null, updatedAt: new Date() })
    .where(eq(integrationConnections.provider, provider));
  logger.warn({ provider, failures, pauseMinutes, message }, "integration failure recorded");
}

export async function recordSuccess(provider: Provider, patch: Partial<typeof integrationConnections.$inferInsert> = {}) {
  await db
    .update(integrationConnections)
    .set({ status: "connected", lastError: null, consecutiveFailures: 0, pausedUntil: null, lastSuccessfulSyncAt: new Date(), updatedAt: new Date(), ...patch })
    .where(eq(integrationConnections.provider, provider));
}

export async function isPaused(provider: Provider) {
  const c = await getConnection(provider);
  return Boolean(c.pausedUntil && c.pausedUntil > new Date());
}

// ---------------------------------------------------------------------------
// Sync runs
// ---------------------------------------------------------------------------
export type SyncCounters = { fetched: number; created: number; updated: number; skipped: number; errors: number };

export async function startSyncRun(provider: Provider, kind: string, trigger: "schedule" | "manual" | "webhook", triggeredByUserId?: string | null) {
  const [row] = await db.insert(syncRuns).values({ provider, kind, trigger, triggeredByUserId: triggeredByUserId ?? null }).returning({ id: syncRuns.id });
  return row.id;
}

export async function finishSyncRun(id: string, status: "success" | "partial" | "failed", counters: Partial<SyncCounters>, message?: string, details?: Record<string, unknown>) {
  await db.update(syncRuns).set({ status, finishedAt: new Date(), message: message?.slice(0, 2000), details, ...counters }).where(eq(syncRuns.id, id));
}

export async function addSyncError(syncRunId: string, provider: Provider, message: string, extra?: { externalId?: string; localId?: string; details?: Record<string, unknown> }) {
  await db.insert(syncErrors).values({ syncRunId, provider, message: message.slice(0, 2000), externalId: extra?.externalId, localId: extra?.localId, details: extra?.details });
}

/**
 * Runs a sync with bookkeeping: sync_runs row, connection status, circuit
 * breaker. The body receives counters to mutate and an error recorder.
 */
export async function runSync(
  provider: Provider,
  kind: string,
  trigger: "schedule" | "manual" | "webhook",
  body: (ctx: { runId: string; counters: SyncCounters; fail: (message: string, extra?: { externalId?: string; localId?: string; details?: Record<string, unknown> }) => Promise<void> }) => Promise<string | void>,
  triggeredByUserId?: string | null,
) {
  if (trigger === "schedule" && (await isPaused(provider))) {
    logger.info({ provider, kind }, "sync skipped: provider paused after repeated failures");
    return null;
  }
  const runId = await startSyncRun(provider, kind, trigger, triggeredByUserId);
  const counters: SyncCounters = { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
  const fail = async (message: string, extra?: { externalId?: string; localId?: string; details?: Record<string, unknown> }) => {
    counters.errors++;
    await addSyncError(runId, provider, message, extra);
  };
  try {
    const message = await body({ runId, counters, fail });
    const status = counters.errors ? "partial" : "success";
    await finishSyncRun(runId, status, counters, message ?? undefined);
    await recordSuccess(provider);
    return { runId, status, counters };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishSyncRun(runId, "failed", counters, message);
    await recordFailure(provider, message);
    logger.error({ provider, kind, err: message }, "sync failed");
    return { runId, status: "failed" as const, counters, message };
  }
}

export async function listSyncRuns(provider?: Provider, limit = 30) {
  return db
    .select({ run: syncRuns, triggeredBy: user.name, errorCount: sql<number>`(select count(*) from sync_errors e where e.sync_run_id = sync_runs.id)`.mapWith(Number) })
    .from(syncRuns)
    .leftJoin(user, eq(user.id, syncRuns.triggeredByUserId))
    .where(provider ? eq(syncRuns.provider, provider) : undefined)
    .orderBy(desc(syncRuns.startedAt))
    .limit(limit)
    .then((rows) => rows.map((r) => ({ ...r.run, triggeredBy: r.triggeredBy, errorCount: r.errorCount })));
}

export async function listSyncErrors(syncRunId: string) {
  return db.select().from(syncErrors).where(eq(syncErrors.syncRunId, syncRunId)).orderBy(desc(syncErrors.at));
}

export async function recentUnresolvedErrors(provider: Provider, limit = 20) {
  return db
    .select({ err: syncErrors, kind: syncRuns.kind })
    .from(syncErrors)
    .innerJoin(syncRuns, eq(syncRuns.id, syncErrors.syncRunId))
    .where(and(eq(syncErrors.provider, provider), isNull(syncErrors.resolvedAt)))
    .orderBy(desc(syncErrors.at))
    .limit(limit)
    .then((rows) => rows.map((r) => ({ ...r.err, kind: r.kind })));
}

// ---------------------------------------------------------------------------
// External links
// ---------------------------------------------------------------------------
type LinkEntity = (typeof externalLinks.$inferInsert)["entityType"];

export async function getLink(provider: Provider, entityType: LinkEntity, localId: string) {
  const [row] = await db.select().from(externalLinks).where(and(eq(externalLinks.provider, provider), eq(externalLinks.entityType, entityType), eq(externalLinks.localId, localId))).limit(1);
  return row ?? null;
}

export async function getLinkByExternal(provider: Provider, entityType: LinkEntity, externalId: string) {
  const [row] = await db.select().from(externalLinks).where(and(eq(externalLinks.provider, provider), eq(externalLinks.entityType, entityType), eq(externalLinks.externalId, externalId))).limit(1);
  return row ?? null;
}

export async function listLinks(provider: Provider, entityType?: LinkEntity) {
  return db
    .select()
    .from(externalLinks)
    .where(entityType ? and(eq(externalLinks.provider, provider), eq(externalLinks.entityType, entityType)) : eq(externalLinks.provider, provider))
    .orderBy(desc(externalLinks.updatedAt));
}

/**
 * Creates a link. Refuses when either side is already linked to something
 * else, which is what prevents two CRM companies from sharing one Xero contact.
 */
export async function createLink(
  input: { provider: Provider; entityType: LinkEntity; localId: string; externalId: string; externalType?: string; externalName?: string; externalUrl?: string; source?: (typeof externalLinks.$inferInsert)["source"] },
  actorUserId: string | null,
  tx: Tx | typeof db = db,
) {
  const existingLocal = await tx.select().from(externalLinks).where(and(eq(externalLinks.provider, input.provider), eq(externalLinks.entityType, input.entityType), eq(externalLinks.localId, input.localId))).limit(1);
  if (existingLocal[0] && existingLocal[0].externalId !== input.externalId) throw new ActionError(`This record is already linked to ${input.provider} record ${existingLocal[0].externalName ?? existingLocal[0].externalId}. Unlink it first.`);
  const existingExternal = await tx.select().from(externalLinks).where(and(eq(externalLinks.provider, input.provider), eq(externalLinks.entityType, input.entityType), eq(externalLinks.externalId, input.externalId))).limit(1);
  if (existingExternal[0] && existingExternal[0].localId !== input.localId) throw new ActionError(`That ${input.provider} record is already linked to another ${input.entityType}. Unlink it first.`);
  if (existingLocal[0]) return existingLocal[0].id;
  const [row] = await tx
    .insert(externalLinks)
    .values({ ...input, source: input.source ?? "manual", linkedByUserId: actorUserId, lastSyncedAt: new Date() })
    .returning({ id: externalLinks.id });
  await audit({ actorUserId, action: "integration.link", entityType: input.entityType, entityId: input.localId, details: { provider: input.provider, externalId: input.externalId, externalName: input.externalName } }, tx);
  return row.id;
}

export async function removeLink(id: string, actorUserId: string) {
  const [row] = await db.select().from(externalLinks).where(eq(externalLinks.id, id)).limit(1);
  if (!row) return;
  await db.delete(externalLinks).where(eq(externalLinks.id, id));
  await audit({ actorUserId, action: "integration.unlink", entityType: row.entityType, entityId: row.localId, details: { provider: row.provider, externalId: row.externalId } });
}

// ---------------------------------------------------------------------------
// Inbound events (webhooks and polled state changes)
// ---------------------------------------------------------------------------
/** Returns the new row id, or null when this event was already recorded. */
export async function recordInboundEvent(provider: Provider, eventId: string, eventType: string, payload?: Record<string, unknown>, externalId?: string, tx: Tx | typeof db = db) {
  const [row] = await tx.insert(inboundEvents).values({ provider, eventId, eventType, payload, externalId }).onConflictDoNothing({ target: [inboundEvents.provider, inboundEvents.eventId] }).returning({ id: inboundEvents.id });
  return row?.id ?? null;
}

export async function markEventProcessed(id: string, error?: string) {
  await db.update(inboundEvents).set({ processedAt: new Date(), error: error ?? null }).where(eq(inboundEvents.id, id));
}

// ---------------------------------------------------------------------------
// Outbound idempotency
// ---------------------------------------------------------------------------
export class OutboundInFlightError extends ActionError {
  constructor() {
    super("This request is already being processed. Wait a moment and refresh.");
  }
}

/**
 * Runs an outbound write exactly once per idempotency key.
 * - New key: inserts a pending row, runs `perform`, stores the external id.
 * - Succeeded before: returns the stored external id without calling the provider.
 * - In flight (another worker mid-call): throws so the user can retry later.
 * - Failed before: runs `reconcile` first (look the record up at the provider by
 *   our reference) and only calls `perform` again if nothing is found.
 */
export async function runOutbound<T extends { externalId: string; summary?: Record<string, unknown> }>(
  provider: Provider,
  idempotencyKey: string,
  operation: string,
  actorUserId: string | null,
  handlers: { perform: () => Promise<T>; reconcile?: () => Promise<T | null>; requestSummary?: Record<string, unknown> },
): Promise<{ result: T; reused: boolean }> {
  const claimed = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(outboundRequests).where(and(eq(outboundRequests.provider, provider), eq(outboundRequests.idempotencyKey, idempotencyKey))).for("update");
    if (existing?.status === "succeeded" && existing.externalId) return { reuse: existing };
    if (existing?.status === "in_flight" && existing.updatedAt > new Date(Date.now() - 5 * 60_000)) throw new OutboundInFlightError();
    if (existing) {
      await tx.update(outboundRequests).set({ status: "in_flight", attempts: existing.attempts + 1, updatedAt: new Date() }).where(eq(outboundRequests.id, existing.id));
      return { row: existing, retry: true };
    }
    const [row] = await tx.insert(outboundRequests).values({ provider, idempotencyKey, operation, status: "in_flight", attempts: 1, requestSummary: handlers.requestSummary, requestedByUserId: actorUserId }).returning();
    return { row, retry: false };
  });
  if ("reuse" in claimed && claimed.reuse) {
    return { result: { externalId: claimed.reuse.externalId!, summary: claimed.reuse.responseSummary ?? undefined } as T, reused: true };
  }
  if (!("row" in claimed)) throw new Error("unreachable");
  try {
    let result: T | null = null;
    if (claimed.retry && handlers.reconcile) result = await handlers.reconcile();
    if (!result) result = await handlers.perform();
    await db.update(outboundRequests).set({ status: "succeeded", externalId: result.externalId, responseSummary: result.summary, error: null, updatedAt: new Date() }).where(eq(outboundRequests.id, claimed.row.id));
    return { result, reused: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(outboundRequests).set({ status: "failed", error: message.slice(0, 1000), updatedAt: new Date() }).where(eq(outboundRequests.id, claimed.row.id));
    throw err;
  }
}

export async function listOutbound(provider: Provider, limit = 30) {
  return db.select().from(outboundRequests).where(eq(outboundRequests.provider, provider)).orderBy(desc(outboundRequests.updatedAt)).limit(limit);
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------
export async function raiseConflict(input: { provider: Provider; entityType: LinkEntity; localId?: string | null; externalId?: string | null; kind: string; message: string; details?: Record<string, unknown> }) {
  // One open conflict per (provider, kind, local, external)
  const existing = await db
    .select({ id: mappingConflicts.id })
    .from(mappingConflicts)
    .where(and(eq(mappingConflicts.provider, input.provider), eq(mappingConflicts.kind, input.kind), eq(mappingConflicts.status, "open"), input.localId ? eq(mappingConflicts.localId, input.localId) : isNull(mappingConflicts.localId), input.externalId ? eq(mappingConflicts.externalId, input.externalId) : isNull(mappingConflicts.externalId)))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const [row] = await db.insert(mappingConflicts).values({ ...input, localId: input.localId ?? null, externalId: input.externalId ?? null }).returning({ id: mappingConflicts.id });
  return row.id;
}

export async function listOpenConflicts(provider?: Provider) {
  return db.select().from(mappingConflicts).where(provider ? and(eq(mappingConflicts.provider, provider), eq(mappingConflicts.status, "open")) : eq(mappingConflicts.status, "open")).orderBy(desc(mappingConflicts.createdAt));
}

export async function resolveConflict(id: string, status: "resolved" | "dismissed", actorUserId: string) {
  await db.update(mappingConflicts).set({ status, resolvedByUserId: actorUserId, resolvedAt: new Date(), updatedAt: new Date() }).where(eq(mappingConflicts.id, id));
  await audit({ actorUserId, action: `integration.conflict.${status}`, entityType: "mapping_conflict", entityId: id });
}

export async function integrationHealth() {
  const conns = await listConnections();
  const [{ openConflicts }] = await db.select({ openConflicts: count() }).from(mappingConflicts).where(eq(mappingConflicts.status, "open"));
  return { connections: conns, openConflicts };
}
