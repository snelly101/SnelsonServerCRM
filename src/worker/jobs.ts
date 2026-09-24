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
 *  - Phase 8: twentyi.sync (hosting mirror), expiry reminders inside crm.reminders
 *  - Phase 12: pax8.sync (subscription mirror), licence check runs inside
 *  - Phase 13: m365.tick (inbound queue + outbox every minute), m365.delta (recovery every 5 min), m365.subscriptions (renewal every 30 min)
 *  - Phase 13 stage 3: helpdesk.sla (deadline check every 5 min), helpdesk.rules (scheduled automation every 15 min)
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
  twentyISync: "twentyi.sync",
  pax8Sync: "pax8.sync",
  m365Tick: "m365.tick",
  m365Delta: "m365.delta",
  m365Subscriptions: "m365.subscriptions",
  helpdeskSla: "helpdesk.sla",
  helpdeskRules: "helpdesk.rules",
  retention: "system.retention",
} as const;

/** Records that a job runner is alive. Read by /api/health and the Integrations page as "worker last seen". */
export async function heartbeat(mode: "worker" | "tick") {
  await setSystemStatus("worker.heartbeat", {
    mode,
    pid: process.pid,
    hostname: os.hostname(),
  });
}

export async function registerJobs(
  boss: PgBoss,
  mode: "worker" | "tick" = "worker",
) {
  // Keep finished job rows for a week so the Integrations page can show history.
  await boss.createQueue(QUEUES.heartbeat, {
    deleteAfterSeconds: 7 * 24 * 3600,
  });
  await boss.work(QUEUES.heartbeat, async ([job]) => {
    await heartbeat(mode);
    logger.debug({ jobId: job.id }, "heartbeat");
  });
  // A cheap scheduled job that proves the worker is alive, plus one beat at start-up.
  await boss.schedule(QUEUES.heartbeat, "*/5 * * * *", {}, { retryLimit: 0 });
  await heartbeat(mode);

  // Nightly data retention (sync history, processed webhook payloads). Never touches customer data.
  await boss.createQueue(QUEUES.retention, {
    deleteAfterSeconds: 30 * 24 * 3600,
    retryLimit: 1,
  });
  await boss.work(QUEUES.retention, async () => {
    const { runRetention } = await import("@/services/retention");
    await runRetention();
    // Nightly integrity check of the vault audit chain (hashing only; needs no key).
    const { verifyAuditChain } = await import("@/services/vault");
    const chain = await verifyAuditChain(null);
    if (!chain.ok)
      logger.error(
        { brokenAt: chain.brokenAt },
        "vault audit chain integrity check FAILED",
      );
  });
  await boss.schedule(
    QUEUES.retention,
    "15 3 * * *",
    {},
    { retryLimit: 1, singletonKey: "retention" },
  );

  // Daily at 06:00: renewal/review reminder tasks and contract expiry. Idempotent via task source keys.
  await boss.createQueue(QUEUES.reminders, {
    deleteAfterSeconds: 30 * 24 * 3600,
    retryLimit: 3,
    retryBackoff: true,
  });
  await boss.work(QUEUES.reminders, async ([job]) => {
    const { generateReminders } = await import("@/services/contracts");
    const res = await generateReminders(null);
    const { generateVaultReminders } = await import("@/services/vault");
    const vault = await generateVaultReminders();
    const { generateHostingReminders } = await import("@/services/twentyi");
    const hosting = await generateHostingReminders();
    logger.info(
      {
        jobId: job.id,
        created: res.created,
        vaultReminders: vault.created,
        hostingReminders: hosting.created,
      },
      "reminders generated",
    );
  });
  await boss.schedule(QUEUES.reminders, "0 6 * * *", {}, { retryLimit: 3 });

  // Better Proposals has no webhooks: poll every 15 minutes. Singleton so overlapping runs never double-process.
  await boss.createQueue(QUEUES.bpPoll, {
    deleteAfterSeconds: 7 * 24 * 3600,
    retryLimit: 2,
    retryBackoff: true,
    expireInSeconds: 600,
  });
  await boss.work(QUEUES.bpPoll, async ([job]) => {
    const { syncProposals } = await import("@/services/proposals");
    const res = await syncProposals("schedule");
    logger.info(
      { jobId: job.id, result: res && { status: res.status, ...res.counters } },
      "betterproposals poll",
    );
  });
  await boss.schedule(
    QUEUES.bpPoll,
    "*/15 * * * *",
    {},
    { retryLimit: 2, singletonKey: "bp-poll" },
  );

  // Xero: incremental sync hourly (If-Modified-Since), full reconciliation nightly, webhook events every minute.
  await boss.createQueue(QUEUES.xeroSync, {
    deleteAfterSeconds: 7 * 24 * 3600,
    retryLimit: 2,
    retryBackoff: true,
    expireInSeconds: 1800,
  });
  await boss.work(QUEUES.xeroSync, async ([job]) => {
    const { syncXero } = await import("@/services/xero");
    const res = await syncXero("schedule");
    logger.info(
      { jobId: job.id, result: res && { status: res.status, ...res.counters } },
      "xero sync",
    );
  });
  await boss.schedule(
    QUEUES.xeroSync,
    "5 * * * *",
    {},
    { retryLimit: 2, singletonKey: "xero-sync" },
  );

  await boss.createQueue(QUEUES.xeroReconcile, {
    deleteAfterSeconds: 30 * 24 * 3600,
    retryLimit: 1,
    expireInSeconds: 3600,
  });
  await boss.work(QUEUES.xeroReconcile, async ([job]) => {
    const { syncXero } = await import("@/services/xero");
    const res = await syncXero("schedule", null, { full: true });
    logger.info(
      { jobId: job.id, result: res && { status: res.status, ...res.counters } },
      "xero reconcile",
    );
  });
  await boss.schedule(
    QUEUES.xeroReconcile,
    "30 2 * * *",
    {},
    { retryLimit: 1, singletonKey: "xero-reconcile" },
  );

  await boss.createQueue(QUEUES.xeroInbound, {
    deleteAfterSeconds: 24 * 3600,
    retryLimit: 1,
    expireInSeconds: 300,
  });
  await boss.work(QUEUES.xeroInbound, async () => {
    const { processXeroInboundEvents } = await import("@/services/xero");
    const res = await processXeroInboundEvents();
    if (res.processed) logger.info(res, "xero inbound events processed");
  });
  await boss.schedule(
    QUEUES.xeroInbound,
    "* * * * *",
    {},
    { retryLimit: 0, singletonKey: "xero-inbound" },
  );

  // NinjaOne (read-only): organisations, locations, devices and health hourly; discrepancy check runs inside.
  await boss.createQueue(QUEUES.ninjaSync, {
    deleteAfterSeconds: 7 * 24 * 3600,
    retryLimit: 2,
    retryBackoff: true,
    expireInSeconds: 1800,
  });
  await boss.work(QUEUES.ninjaSync, async ([job]) => {
    const { syncNinjaOne } = await import("@/services/ninjaone");
    const res = await syncNinjaOne("schedule");
    logger.info(
      { jobId: job.id, result: res && { status: res.status, ...res.counters } },
      "ninjaone sync",
    );
  });
  await boss.schedule(
    QUEUES.ninjaSync,
    "20 * * * *",
    {},
    { retryLimit: 2, singletonKey: "ninja-sync" },
  );

  // 20i (read-only): packages, domains and mailboxes hourly; auto-links by domain; expiry reminders run with crm.reminders.
  await boss.createQueue(QUEUES.twentyISync, {
    deleteAfterSeconds: 7 * 24 * 3600,
    retryLimit: 2,
    retryBackoff: true,
    expireInSeconds: 1800,
  });
  await boss.work(QUEUES.twentyISync, async ([job]) => {
    const { syncTwentyI } = await import("@/services/twentyi");
    const res = await syncTwentyI("schedule");
    logger.info(
      { jobId: job.id, result: res && { status: res.status, ...res.counters } },
      "twentyi sync",
    );
  });
  await boss.schedule(
    QUEUES.twentyISync,
    "40 * * * *",
    {},
    { retryLimit: 2, singletonKey: "twentyi-sync" },
  );

  // Pax8 (read-only): companies, subscriptions, products and recent invoices hourly; auto-links by domain/name; licence check runs inside.
  await boss.createQueue(QUEUES.pax8Sync, {
    deleteAfterSeconds: 7 * 24 * 3600,
    retryLimit: 2,
    retryBackoff: true,
    expireInSeconds: 1800,
  });
  await boss.work(QUEUES.pax8Sync, async ([job]) => {
    const { syncPax8 } = await import("@/services/pax8");
    const res = await syncPax8("schedule");
    logger.info(
      { jobId: job.id, result: res && { status: res.status, ...res.counters } },
      "pax8 sync",
    );
  });
  await boss.schedule(
    QUEUES.pax8Sync,
    "50 * * * *",
    {},
    { retryLimit: 2, singletonKey: "pax8-sync" },
  );

  // Helpdesk mailbox: drain the inbound queue and the outbox every minute; delta sync recovers missed notifications; subscriptions renew before expiry.
  await boss.createQueue(QUEUES.m365Tick, {
    deleteAfterSeconds: 24 * 3600,
    retryLimit: 0,
    expireInSeconds: 300,
  });
  await boss.work(QUEUES.m365Tick, async () => {
    const { mailboxTick } = await import("@/services/mailbox");
    const res = await mailboxTick();
    const inbound = res.inbound as { claimed: number } | undefined;
    const outbox = res.outbox as { attempted: number } | undefined;
    if ((inbound?.claimed ?? 0) + (outbox?.attempted ?? 0) > 0)
      logger.info(res, "m365 tick");
  });
  await boss.schedule(
    QUEUES.m365Tick,
    "* * * * *",
    {},
    { retryLimit: 0, singletonKey: "m365-tick" },
  );

  await boss.createQueue(QUEUES.m365Delta, {
    deleteAfterSeconds: 7 * 24 * 3600,
    retryLimit: 1,
    expireInSeconds: 900,
  });
  await boss.work(QUEUES.m365Delta, async ([job]) => {
    const { mailboxTick } = await import("@/services/mailbox");
    const res = await mailboxTick({ delta: true });
    logger.info({ jobId: job.id, res }, "m365 delta sync");
  });
  await boss.schedule(
    QUEUES.m365Delta,
    "*/5 * * * *",
    {},
    { retryLimit: 1, singletonKey: "m365-delta" },
  );

  await boss.createQueue(QUEUES.m365Subscriptions, {
    deleteAfterSeconds: 7 * 24 * 3600,
    retryLimit: 1,
    expireInSeconds: 300,
  });
  await boss.work(QUEUES.m365Subscriptions, async ([job]) => {
    const { mailboxTick } = await import("@/services/mailbox");
    const res = await mailboxTick({ subscriptions: true });
    logger.info({ jobId: job.id, res }, "m365 subscriptions");
  });
  await boss.schedule(
    QUEUES.m365Subscriptions,
    "*/30 * * * *",
    {},
    { retryLimit: 1, singletonKey: "m365-subscriptions" },
  );

  // SLA deadlines: flag breaches, warn assignees an hour ahead, then let rules react.
  await boss.createQueue(QUEUES.helpdeskSla, {
    deleteAfterSeconds: 7 * 24 * 3600,
    retryLimit: 0,
    expireInSeconds: 240,
  });
  await boss.work(QUEUES.helpdeskSla, async () => {
    const { checkSlaDeadlines } = await import("@/services/helpdesk-sla");
    const { runAutomation } = await import("@/services/helpdesk-automation");
    const res = await checkSlaDeadlines();
    for (const b of res.breaches)
      await runAutomation("sla_breached", b.ticketId).catch((err) =>
        logger.warn({ err, ticketId: b.ticketId }, "sla_breached rules failed"),
      );
    for (const d of res.dueSoon)
      await runAutomation("sla_due_soon", d.ticketId).catch((err) =>
        logger.warn({ err, ticketId: d.ticketId }, "sla_due_soon rules failed"),
      );
    if (res.breaches.length || res.dueSoon.length)
      logger.info(
        { breaches: res.breaches.length, dueSoon: res.dueSoon.length },
        "helpdesk sla check",
      );
  });
  await boss.schedule(
    QUEUES.helpdeskSla,
    "*/5 * * * *",
    {},
    { retryLimit: 0, singletonKey: "helpdesk-sla" },
  );

  // Time-based automation rules (auto-close resolved tickets, escalate untouched ones).
  await boss.createQueue(QUEUES.helpdeskRules, {
    deleteAfterSeconds: 7 * 24 * 3600,
    retryLimit: 0,
    expireInSeconds: 600,
  });
  await boss.work(QUEUES.helpdeskRules, async () => {
    const { runScheduledRules } = await import("@/services/helpdesk-automation");
    const res = await runScheduledRules();
    if (res.applied) logger.info(res, "helpdesk scheduled rules");
  });
  await boss.schedule(
    QUEUES.helpdeskRules,
    "*/15 * * * *",
    {},
    { retryLimit: 0, singletonKey: "helpdesk-rules" },
  );
}
