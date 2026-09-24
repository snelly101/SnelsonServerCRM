import { pgTable, text, timestamp, uuid, boolean, index } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { companies, timestamps } from "./core";

/**
 * Standing "things to know" about a customer (site access, escalation
 * contacts, quirks), distinct from the dated activity timeline. Bodies are
 * Markdown rendered by the in-house safe renderer (no raw HTML). Pinned notes
 * also show on the company Overview. Archiving is soft.
 */
export const companyNotes = pgTable(
  "company_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    pinned: boolean("pinned").notNull().default(false),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("company_notes_company_idx").on(t.companyId, t.pinned), index("company_notes_archived_idx").on(t.archivedAt)],
);
