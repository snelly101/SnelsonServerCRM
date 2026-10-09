import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { companies, contacts, timestamps } from "./core";
import { tickets } from "./helpdesk";

/**
 * Customer portal identity. A portal account is a CRM contact that an agent
 * has invited; it is never a staff user and holds no role. Sign-in is by
 * e-mailed magic link (no passwords), sessions are our own rows with a
 * separate cookie, so staff and customer sessions can never be confused.
 * Only hashes of tokens are stored.
 */
export const portalAccounts = pgTable(
  "portal_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Lower-cased sign-in address, copied from the contact when invited. */
    email: text("email").notNull(),
    /** May see every ticket of the company, not just their own. */
    isCompanyAdmin: boolean("is_company_admin").notNull().default(false),
    invitedByUserId: text("invited_by_user_id").references(() => user.id, { onDelete: "set null" }),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("portal_accounts_contact_unique").on(t.contactId), index("portal_accounts_email_idx").on(t.email), index("portal_accounts_company_idx").on(t.companyId)],
);

/** One-time sign-in links. Short-lived, single use, hash only. */
export const portalLoginTokens = pgTable(
  "portal_login_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => portalAccounts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /** invite | login */
    purpose: text("purpose").notNull().default("login"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    requestIp: text("request_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("portal_login_tokens_hash_unique").on(t.tokenHash), index("portal_login_tokens_account_idx").on(t.accountId, t.createdAt)],
);

export const portalSessions = pgTable(
  "portal_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => portalAccounts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("portal_sessions_hash_unique").on(t.tokenHash), index("portal_sessions_account_idx").on(t.accountId)],
);

/** Optional satisfaction rating a customer leaves on a resolved or closed ticket. One per ticket, editable. */
export const ticketFeedback = pgTable(
  "ticket_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => portalAccounts.id, { onDelete: "set null" }),
    /** 1 (poor) to 5 (excellent). */
    rating: integer("rating").notNull(),
    comment: text("comment"),
    ...timestamps,
  },
  (t) => [uniqueIndex("ticket_feedback_ticket_unique").on(t.ticketId)],
);
