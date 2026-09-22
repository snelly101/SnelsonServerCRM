import "dotenv/config";
import { PgBoss } from "pg-boss";
import { logger } from "@/lib/logger";
import { registerJobs } from "./jobs";

/**
 * Long-running worker process (VPS / Docker). Runs the same job handlers as
 * `jobs:tick`; this one stays up and polls continuously.
 *
 *   npm run worker
 */
async function main() {
  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL!,
    schema: "pgboss",
  });
  boss.on("error", (err) => logger.error({ err }, "pg-boss error"));
  await boss.start();
  await registerJobs(boss);
  logger.info("Worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Worker stopping");
    await boss.stop({ graceful: true, timeout: 20_000 });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "Worker failed to start");
  process.exit(1);
});
