import { eq } from "drizzle-orm";
import { db } from "@/db";
import { systemStatus } from "@/db/schema";

export async function setSystemStatus(key: string, value: Record<string, unknown>) {
  await db.insert(systemStatus).values({ key, value, updatedAt: new Date() }).onConflictDoUpdate({ target: systemStatus.key, set: { value, updatedAt: new Date() } });
}

export async function getSystemStatus<T extends Record<string, unknown> = Record<string, unknown>>(key: string): Promise<{ value: T; updatedAt: Date } | null> {
  const [row] = await db.select().from(systemStatus).where(eq(systemStatus.key, key)).limit(1);
  return row ? { value: row.value as T, updatedAt: row.updatedAt } : null;
}

/** Worker is considered alive if a heartbeat landed within 3 scheduled intervals (5 min each). */
export const WORKER_STALE_AFTER_MS = 15 * 60_000;

export async function workerHealth() {
  const hb = await getSystemStatus<{ mode: string; pid: number; hostname: string }>("worker.heartbeat");
  if (!hb) return { status: "never" as const, lastSeen: null, mode: null };
  const age = Date.now() - hb.updatedAt.getTime();
  return { status: age < WORKER_STALE_AFTER_MS ? ("alive" as const) : ("stale" as const), lastSeen: hb.updatedAt, mode: hb.value.mode ?? null };
}
