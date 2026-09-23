import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getSystemStatus, workerHealth } from "@/lib/system-status";
import { vaultConfigured } from "@/lib/vault-crypto";

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
  try {
    const chain = await getSystemStatus<{ ok: boolean }>("vault.chain");
    checks.vault = { configured: vaultConfigured(), chainOk: chain?.value.ok ?? null, chainCheckedAt: chain?.updatedAt.toISOString() ?? null };
    if (chain && chain.value.ok === false) ok = false;
  } catch {
    checks.vault = { configured: vaultConfigured(), chainOk: null };
  }
  return NextResponse.json({ status: ok ? "ok" : "degraded", ...checks, time: new Date().toISOString() }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
