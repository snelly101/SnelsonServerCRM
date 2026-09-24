import {
  pgTable,
  text,
  timestamp,
  uuid,
  pgEnum,
  index,
  integer,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { timestamps } from "./core";
import { tickets } from "./helpdesk";
import { ninjaDevices } from "./ninjaone";

// ---------------------------------------------------------------------------
// Stage 4: knowledge base articles with revision history and ticket links,
// and ticket ↔ device (asset) links against the NinjaOne mirror.
// ---------------------------------------------------------------------------
export const kbStatusEnum = pgEnum("kb_status", [
  "draft",
  "published",
  "archived",
]);

export const kbArticles = pgTable(
  "kb_articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    /** Markdown, rendered by the in-house safe renderer; never raw HTML. */
    body: text("body").notNull().default(""),
    summary: text("summary"),
    category: text("category"),
    tags: text("tags").array().notNull().default([]),
    status: kbStatusEnum("status").notNull().default("draft"),
    /**
     * Whether the article may be shown to customers (portal later, and
     * inserted into customer replies now). Internal-only articles can only
     * be inserted into internal notes.
     */
    customerVisible: boolean("customer_visible").notNull().default(false),
    version: integer("version").notNull().default(1),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    reviewDueAt: timestamp("review_due_at", { withTimezone: true }),
    viewCount: integer("view_count").notNull().default(0),
    usedCount: integer("used_count").notNull().default(0),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("kb_articles_slug_unique").on(t.slug),
    index("kb_articles_status_idx").on(t.status, t.customerVisible),
    index("kb_articles_category_idx").on(t.category),
  ],
);

export const kbArticleRevisions = pgTable(
  "kb_article_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => kbArticles.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    summary: text("summary"),
    editedByUserId: text("edited_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    note: text("note"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("kb_revisions_unique").on(t.articleId, t.version),
  ],
);

export const ticketKbLinks = pgTable(
  "ticket_kb_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    articleId: uuid("article_id")
      .notNull()
      .references(() => kbArticles.id, { onDelete: "cascade" }),
    /** linked | sent (inserted into a customer reply) | created_from (article written from this ticket) */
    kind: text("kind").notNull().default("linked"),
    linkedByUserId: text("linked_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ticket_kb_links_unique").on(t.ticketId, t.articleId),
    index("ticket_kb_links_article_idx").on(t.articleId),
  ],
);

export const ticketAssets = pgTable(
  "ticket_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => ninjaDevices.id, { onDelete: "cascade" }),
    note: text("note"),
    linkedByUserId: text("linked_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ticket_assets_unique").on(t.ticketId, t.deviceId),
    index("ticket_assets_device_idx").on(t.deviceId),
  ],
);
