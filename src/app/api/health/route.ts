import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { workerHealth } from "@/lib/system-status";

export const dynamic = "force-dynamic";

/**
 * Liveness/readiness for uptime monitors and Docker healthchecks.
 * Unauthenticated by design; exposes only pass/fail booleans and the worker's last-seen time.
 * 200 = database reachable and worker seen recently; 503 otherwise.
 */
export async function GET() {
  const checks: Record<string, unknown> = {};
  let ok = true;
  try {
    await db.execute(sql`select 1`);
    checks.database = "ok";
  } catch {
    checks.database = "unreachable";
    ok = false;
  }
  try {
    const w = await workerHealth();
    checks.worker = w.status;
    checks.workerLastSeen = w.lastSeen?.toISOString() ?? null;
    if (w.status !== "alive") ok = false;
  } catch {
    checks.worker = "unknown";
    ok = false;
  }
  return NextResponse.json({ status: ok ? "ok" : "degraded", ...checks, time: new Date().toISOString() }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
