import "dotenv/config";
import { beforeAll, afterAll } from "vitest";

// Point the app's pool at the test database before any module imports it.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL must be set to run the test suite");
process.env.DATABASE_URL = url;
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";

beforeAll(async () => {
  const { resetDatabase } = await import("@/db/reset");
  await resetDatabase(url);
});

afterAll(async () => {
  const { pool } = await import("@/db");
  await pool.end();
});
