import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/**
 * Applies pending SQL migrations from ./drizzle. Safe to run repeatedly.
 * Usage: npm run db:migrate   (uses DATABASE_URL, or the URL passed as argv[2])
 */
export async function runMigrations(url = process.argv[2] ?? process.env.DATABASE_URL) {
  if (!url) throw new Error("No database URL provided");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  runMigrations()
    .then(() => {
      console.log("Migrations applied");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
