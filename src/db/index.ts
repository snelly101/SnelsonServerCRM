import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

declare global {
  var __crmPool: Pool | undefined;
}

function createPool() {
  const url = process.env.DATABASE_URL;
  // `next build` imports server modules while collecting page data but never queries.
  // Allow the pool to be constructed then; at runtime a missing URL is still a hard error.
  if (!url && process.env.NEXT_PHASE !== "phase-production-build") throw new Error("DATABASE_URL is not set");
  return new Pool({
    connectionString: url ?? "postgres://build-placeholder/unused",
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
  });
}

// Reuse the pool across hot reloads in development.
export const pool: Pool = global.__crmPool ?? createPool();
if (process.env.NODE_ENV !== "production") global.__crmPool = pool;

export const db = drizzle(pool, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export { schema };
