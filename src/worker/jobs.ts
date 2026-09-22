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
  reminders: "crm.reminders",
  bpPoll: "betterproposals.poll",
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

  // Daily at 06:00: renewal/review reminder tasks and contract expiry. Idempotent via task source keys.
  await boss.createQueue(QUEUES.reminders, { deleteAfterSeconds: 30 * 24 * 3600, retryLimit: 3, retryBackoff: true });
  await boss.work(QUEUES.reminders, async ([job]) => {
    const { generateReminders } = await import("@/services/contracts");
    const res = await generateReminders(null);
    logger.info({ jobId: job.id, created: res.created }, "reminders generated");
  });
  await boss.schedule(QUEUES.reminders, "0 6 * * *", {}, { retryLimit: 3 });

  // Better Proposals has no webhooks: poll every 15 minutes. Singleton so overlapping runs never double-process.
  await boss.createQueue(QUEUES.bpPoll, { deleteAfterSeconds: 7 * 24 * 3600, retryLimit: 2, retryBackoff: true, expireInSeconds: 600 });
  await boss.work(QUEUES.bpPoll, async ([job]) => {
    const { syncProposals } = await import("@/services/proposals");
    const res = await syncProposals("schedule");
    logger.info({ jobId: job.id, result: res && { status: res.status, ...res.counters } }, "betterproposals poll");
  });
  await boss.schedule(QUEUES.bpPoll, "*/15 * * * *", {}, { retryLimit: 2, singletonKey: "bp-poll" });
}
