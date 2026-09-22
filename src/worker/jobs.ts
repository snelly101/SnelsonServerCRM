import os from "node:os";
import type { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { setSystemStatus } from "@/lib/system-status";

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
  xeroSync: "xero.sync",
  xeroReconcile: "xero.reconcile",
  xeroInbound: "xero.inbound",
  ninjaSync: "ninjaone.sync",
  retention: "system.retention",
} as const;

/** Records that a job runner is alive. Read by /api/health and the Integrations page as "worker last seen". */
export async function heartbeat(mode: "worker" | "tick") {
  await setSystemStatus("worker.heartbeat", { mode, pid: process.pid, hostname: os.hostname() });
}

export async function registerJobs(boss: PgBoss, mode: "worker" | "tick" = "worker") {
  // Keep finished job rows for a week so the Integrations page can show history.
  await boss.createQueue(QUEUES.heartbeat, { deleteAfterSeconds: 7 * 24 * 3600 });
  await boss.work(QUEUES.heartbeat, async ([job]) => {
    await heartbeat(mode);
    logger.debug({ jobId: job.id }, "heartbeat");
  });
  // A cheap scheduled job that proves the worker is alive, plus one beat at start-up.
  await boss.schedule(QUEUES.heartbeat, "*/5 * * * *", {}, { retryLimit: 0 });
  await heartbeat(mode);

  // Nightly data retention (sync history, processed webhook payloads). Never touches customer data.
  await boss.createQueue(QUEUES.retention, { deleteAfterSeconds: 30 * 24 * 3600, retryLimit: 1 });
  await boss.work(QUEUES.retention, async () => {
    const { runRetention } = await import("@/services/retention");
    await runRetention();
  });
  await boss.schedule(QUEUES.retention, "15 3 * * *", {}, { retryLimit: 1, singletonKey: "retention" });

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

  // Xero: incremental sync hourly (If-Modified-Since), full reconciliation nightly, webhook events every minute.
  await boss.createQueue(QUEUES.xeroSync, { deleteAfterSeconds: 7 * 24 * 3600, retryLimit: 2, retryBackoff: true, expireInSeconds: 1800 });
  await boss.work(QUEUES.xeroSync, async ([job]) => {
    const { syncXero } = await import("@/services/xero");
    const res = await syncXero("schedule");
    logger.info({ jobId: job.id, result: res && { status: res.status, ...res.counters } }, "xero sync");
  });
  await boss.schedule(QUEUES.xeroSync, "5 * * * *", {}, { retryLimit: 2, singletonKey: "xero-sync" });

  await boss.createQueue(QUEUES.xeroReconcile, { deleteAfterSeconds: 30 * 24 * 3600, retryLimit: 1, expireInSeconds: 3600 });
  await boss.work(QUEUES.xeroReconcile, async ([job]) => {
    const { syncXero } = await import("@/services/xero");
    const res = await syncXero("schedule", null, { full: true });
    logger.info({ jobId: job.id, result: res && { status: res.status, ...res.counters } }, "xero reconcile");
  });
  await boss.schedule(QUEUES.xeroReconcile, "30 2 * * *", {}, { retryLimit: 1, singletonKey: "xero-reconcile" });

  await boss.createQueue(QUEUES.xeroInbound, { deleteAfterSeconds: 24 * 3600, retryLimit: 1, expireInSeconds: 300 });
  await boss.work(QUEUES.xeroInbound, async () => {
    const { processXeroInboundEvents } = await import("@/services/xero");
    const res = await processXeroInboundEvents();
    if (res.processed) logger.info(res, "xero inbound events processed");
  });
  await boss.schedule(QUEUES.xeroInbound, "* * * * *", {}, { retryLimit: 0, singletonKey: "xero-inbound" });

  // NinjaOne (read-only): organisations, locations, devices and health hourly; discrepancy check runs inside.
  await boss.createQueue(QUEUES.ninjaSync, { deleteAfterSeconds: 7 * 24 * 3600, retryLimit: 2, retryBackoff: true, expireInSeconds: 1800 });
  await boss.work(QUEUES.ninjaSync, async ([job]) => {
    const { syncNinjaOne } = await import("@/services/ninjaone");
    const res = await syncNinjaOne("schedule");
    logger.info({ jobId: job.id, result: res && { status: res.status, ...res.counters } }, "ninjaone sync");
  });
  await boss.schedule(QUEUES.ninjaSync, "20 * * * *", {}, { retryLimit: 2, singletonKey: "ninja-sync" });
}
