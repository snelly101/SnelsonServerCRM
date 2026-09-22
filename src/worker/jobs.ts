import type { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";

/**
 * Job registry. Each phase adds queues here:
 *  - Phase 2: task reminders, renewal reminders
 *  - Phase 3: betterproposals.poll, betterproposals.create
 *  - Phase 4: xero.sync, xero.webhook, xero.invoice.create, xero.reconcile
 *  - Phase 5: ninjaone.sync, discrepancy.check
 *
 * Every handler must be idempotent: pg-boss guarantees at-least-once delivery.
 */
export const QUEUES = {
  heartbeat: "system.heartbeat",
} as const;

export async function registerJobs(boss: PgBoss) {
  // Keep finished job rows for a week so the Integrations page can show history.
  await boss.createQueue(QUEUES.heartbeat, { deleteAfterSeconds: 7 * 24 * 3600 });
  await boss.work(QUEUES.heartbeat, async ([job]) => {
    logger.debug({ jobId: job.id }, "heartbeat");
  });
  // A cheap scheduled job that proves the worker is alive; the Integrations
  // page (Phase 6) reads the last completed heartbeat as "worker last seen".
  await boss.schedule(QUEUES.heartbeat, "*/5 * * * *", {}, { retryLimit: 0 });
}
