import { bigserial, boolean, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { companies, sites, timestamps } from "./core";

/**
 * Secure Vault: per-customer credentials.
 *
 * Everything searchable (name, username, url, reference, category, tags) is
 * plaintext metadata. Every secret lives inside `ciphertext`, an AES-256-GCM
 * encrypted JSON document whose data key is wrapped by the vault master key
 * (envelope encryption, see src/lib/vault-crypto.ts). Nothing in this file
 * ever holds a plaintext secret.
 */
export const vaultCategories = pgTable(
  "vault_categories",
  {
    id: text("id").primaryKey(), // slug, e.g. "microsoft_365"
    name: text("name").notNull(),
    icon: text("icon").notNull().default("key"),
    sortOrder: integer("sort_order").notNull().default(0),
    isSystem: boolean("is_system").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("vault_categories_name_unique").on(t.name)],
);

/** Records which master-key versions exist (fingerprints only, never key material). */
export const vaultKeys = pgTable("vault_keys", {
  keyVersion: integer("key_version").primaryKey(),
  fingerprint: text("fingerprint").notNull(), // sha256(key) hex, so a wrong key is detected before use
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
});

export const vaultItems = pgTable(
  "vault_items",
  {
    id: uuid("id").primaryKey(), // generated in code so it can be bound into the AAD before insert
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => vaultCategories.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    username: text("username"),
    url: text("url"),
    reference: text("reference"),
    tags: text("tags").array().notNull().default([]),
    isFavourite: boolean("is_favourite").notNull().default(false),
    reviewAt: date("review_at"),
    expiresAt: date("expires_at"),
    // Envelope encryption
    keyVersion: integer("key_version")
      .notNull()
      .references(() => vaultKeys.keyVersion),
    wrappedDek: text("wrapped_dek").notNull(), // base64: nonce‖tag‖encrypted DEK
    ciphertext: text("ciphertext").notNull(), // base64: nonce‖tag‖encrypted JSON
    cipherVersion: integer("cipher_version").notNull().default(1),
    /** Which secret fields exist (e.g. password, totp, api_key) so the UI can show buttons without decrypting. */
    secretKinds: text("secret_kinds").array().notNull().default([]),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, { onDelete: "set null" }),
    lastRevealedAt: timestamp("last_revealed_at", { withTimezone: true }),
    revealCount: integer("reveal_count").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("vault_items_company_idx").on(t.companyId, t.archivedAt), index("vault_items_category_idx").on(t.categoryId), index("vault_items_review_idx").on(t.reviewAt), index("vault_items_expires_idx").on(t.expiresAt)],
);

export const vaultGrantScopeEnum = pgEnum("vault_grant_scope", ["all", "company"]);

/** Per-user capabilities, layered on top of roles. Admins have an implicit all-capability grant. */
export const vaultGrants = pgTable(
  "vault_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scope: vaultGrantScopeEnum("scope").notNull().default("all"),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    canList: boolean("can_list").notNull().default(true),
    canViewUsername: boolean("can_view_username").notNull().default(true),
    canReveal: boolean("can_reveal").notNull().default(false),
    canCopy: boolean("can_copy").notNull().default(false),
    canCreate: boolean("can_create").notNull().default(false),
    canEdit: boolean("can_edit").notNull().default(false),
    canDelete: boolean("can_delete").notNull().default(false),
    canAudit: boolean("can_audit").notNull().default(false),
    grantedByUserId: text("granted_by_user_id").references(() => user.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("vault_grants_user_idx").on(t.userId, t.revokedAt)],
);

/** Records that a user proved their password recently (step-up) for reveal/copy. */
export const vaultStepUps = pgTable("vault_step_ups", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
});

/**
 * Append-only, hash-chained audit trail. A database trigger (see migration)
 * refuses UPDATE and DELETE. `hash = sha256(prevHash || canonical row json)`.
 * Details never contain a secret.
 */
export const vaultAudit = pgTable(
  "vault_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorUserId: text("actor_user_id"),
    actorName: text("actor_name"),
    companyId: uuid("company_id"),
    itemId: uuid("item_id"),
    itemName: text("item_name"),
    action: text("action").notNull(),
    field: text("field"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    sessionId: text("session_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [index("vault_audit_item_idx").on(t.itemId, t.at), index("vault_audit_company_idx").on(t.companyId, t.at), index("vault_audit_actor_idx").on(t.actorUserId, t.at), index("vault_audit_at_idx").on(t.at)],
);
