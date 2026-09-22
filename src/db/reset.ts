import "dotenv/config";
import { Pool } from "pg";
import { runMigrations } from "./migrate";

/**
 * Drops and recreates the public schema, then re-applies migrations.
 * Development and test use only; refuses to run in production.
 */
export async function resetDatabase(url = process.argv[2] ?? process.env.DATABASE_URL) {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset a production database");
  if (!url) throw new Error("No database URL provided");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("drop schema if exists public cascade; create schema public; drop schema if exists drizzle cascade;");
  } finally {
    await pool.end();
  }
  await runMigrations(url);
}

if (process.argv[1]?.endsWith("reset.ts")) {
  resetDatabase()
    .then(() => {
      console.log("Database reset");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
