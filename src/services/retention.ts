import { and, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { inboundEvents, syncRuns } from "@/db/schema";
import { logger } from "@/lib/logger";
import { setSystemStatus } from "@/lib/system-status";

/**
 * Data retention (documented in docs/architecture.md):
 *  - sync runs and their errors: 90 days
 *  - processed inbound events (webhook payloads): 30 days
 *  - audit log, activities, mirrored records, links, discrepancies: kept indefinitely
 *  - pg-boss job rows: per-queue deleteAfterSeconds
 * Customer data is never deleted by a job; archiving is a user action.
 */
export const RETENTION = { syncRunDays: 90, inboundEventDays: 30 } as const;

export async function runRetention() {
  const runsBefore = new Date(Date.now() - RETENTION.syncRunDays * 86400000);
  const eventsBefore = new Date(Date.now() - RETENTION.inboundEventDays * 86400000);
  const runs = await db.delete(syncRuns).where(and(lt(syncRuns.startedAt, runsBefore), sql`${syncRuns.status} <> 'running'`)).returning({ id: syncRuns.id });
  const events = await db.delete(inboundEvents).where(and(isNotNull(inboundEvents.processedAt), lt(inboundEvents.receivedAt, eventsBefore))).returning({ id: inboundEvents.id });
  const result = { syncRunsDeleted: runs.length, inboundEventsDeleted: events.length, at: new Date().toISOString() };
  await setSystemStatus("retention.last", result);
  logger.info(result, "retention run");
  return result;
}
