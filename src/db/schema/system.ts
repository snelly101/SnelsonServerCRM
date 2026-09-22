import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Small key/value store for operational status the UI and health endpoint
 * read: worker heartbeat, last retention run. Never holds secrets.
 */
export const systemStatus = pgTable("system_status", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
