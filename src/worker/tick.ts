import "dotenv/config";
import { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { registerJobs } from "./jobs";

/**
 * Cron-friendly job runner for hosts without a long-lived worker process
 * (e.g. shared hosting). Processes queued jobs for up to TICK_SECONDS then exits.
 * Schedule it every minute:  * * * * * cd /app && npm run jobs:tick
 *
 * Jobs are durable in Postgres, so overlapping or missed ticks are safe.
 */
const TICK_SECONDS = Number(process.env.JOBS_TICK_SECONDS ?? 50);

async function main() {
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema: "pgboss" });
  boss.on("error", (err) => logger.error({ err }, "pg-boss error"));
  await boss.start();
  await registerJobs(boss);
  logger.info({ seconds: TICK_SECONDS }, "Job tick started");
  await new Promise((r) => setTimeout(r, TICK_SECONDS * 1000));
  await boss.stop({ graceful: true, timeout: 8_000 });
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "Job tick failed");
  process.exit(1);
});
