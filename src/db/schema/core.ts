import {
  pgTable,
  text,
  timestamp,
  boolean,
  uuid,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
  integer,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth";

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

// ---------------------------------------------------------------------------
// App-wide settings (single row). Currency, dates, timezone, tax.
// ---------------------------------------------------------------------------
export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  companyName: text("company_name").notNull().default("My MSP"),
  currency: text("currency").notNull().default("GBP"),
  dateFormat: text("date_format").notNull().default("dd/MM/yyyy"),
  timezone: text("timezone").notNull().default("Europe/London"),
  defaultTaxRatePercent: text("default_tax_rate_percent").notNull().default("20"),
  taxLabel: text("tax_label").notNull().default("VAT"),
  // Devices not seen for longer than this are excluded from billable counts.
  deviceActiveDays: integer("device_active_days").notNull().default(30),
  ...timestamps,
});

// ---------------------------------------------------------------------------
// Audit log: every create/update/delete and every sensitive action.
// ---------------------------------------------------------------------------
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    // "system" for jobs/webhooks, otherwise "user"
    actorType: text("actor_type").notNull().default("user"),
    action: text("action").notNull(), // e.g. company.create, invoice.approve
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    // Field-level diff or request summary. Never contains secrets.
    details: jsonb("details").$type<Record<string, unknown>>(),
    ipAddress: text("ip_address"),
  },
  (t) => [
    index("audit_entity_idx").on(t.entityType, t.entityId),
    index("audit_at_idx").on(t.at),
    index("audit_actor_idx").on(t.actorUserId),
  ],
);

// ---------------------------------------------------------------------------
// Companies (prospects and customers), sites, contacts
// ---------------------------------------------------------------------------
export const companyStatusEnum = pgEnum("company_status", ["prospect", "customer", "former", "other"]);

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Lower-cased, punctuation-stripped name used for duplicate detection and search.
    normalizedName: text("normalized_name").notNull(),
    status: companyStatusEnum("status").notNull().default("prospect"),
    website: text("website"),
    // Extracted from website/email addresses; used for duplicate detection.
    domain: text("domain"),
    industry: text("industry"),
    phone: text("phone"),
    email: text("email"),
    companyNumber: text("company_number"),
    vatNumber: text("vat_number"),
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "set null" }),
    // Billing address lives here; operational sites live in `sites`.
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    region: text("region"),
    postcode: text("postcode"),
    country: text("country").default("GB"),
    notes: text("notes"),
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("companies_normalized_name_idx").on(t.normalizedName),
    index("companies_domain_idx").on(t.domain),
    index("companies_status_idx").on(t.status),
    index("companies_owner_idx").on(t.ownerUserId),
    // Trigram-style search is handled by the `search_text` generated expression index in the migration.
  ],
);

export const sites = pgTable(
  "sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    region: text("region"),
    postcode: text("postcode"),
    country: text("country").default("GB"),
    phone: text("phone"),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("sites_company_idx").on(t.companyId)],
);

export const contactRoleEnum = pgEnum("contact_role", [
  "decision_maker",
  "technical",
  "billing",
  "primary",
  "other",
]);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull().default(""),
    email: text("email"),
    normalizedEmail: text("normalized_email"),
    phone: text("phone"),
    mobile: text("mobile"),
    jobTitle: text("job_title"),
    // A contact can hold several roles (e.g. decision maker + billing).
    roles: contactRoleEnum("roles").array().notNull().default(sql`'{}'::contact_role[]`),
    isPrimary: boolean("is_primary").notNull().default(false),
    notes: text("notes"),
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("contacts_company_idx").on(t.companyId),
    index("contacts_email_idx").on(t.normalizedEmail),
    index("contacts_name_idx").on(t.lastName, t.firstName),
  ],
);

// ---------------------------------------------------------------------------
// Tags and custom fields
// ---------------------------------------------------------------------------
export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    color: text("color").notNull().default("slate"),
    ...timestamps,
  },
  (t) => [uniqueIndex("tags_name_unique").on(sql`lower(${t.name})`)],
);

export const companyTags = pgTable(
  "company_tags",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.tagId] })],
);

export const customFieldTypeEnum = pgEnum("custom_field_type", ["text", "number", "date", "boolean", "select"]);
export const customFieldEntityEnum = pgEnum("custom_field_entity", ["company", "contact", "opportunity"]);

export const customFieldDefs = pgTable(
  "custom_field_defs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entity: customFieldEntityEnum("entity").notNull(),
    key: text("key").notNull(), // stable machine key used inside custom_fields jsonb
    label: text("label").notNull(),
    type: customFieldTypeEnum("type").notNull().default("text"),
    options: text("options").array(), // for "select"
    required: boolean("required").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("custom_field_entity_key_unique").on(t.entity, t.key)],
);

// ---------------------------------------------------------------------------
// Activity timeline + internal notes. Activities are appended by the app
// (and later by integrations) and are never edited.
// ---------------------------------------------------------------------------
export const activityTypeEnum = pgEnum("activity_type", [
  "note",
  "call",
  "email",
  "meeting",
  "system",
  "task",
  "proposal",
  "invoice",
  "contract",
  "device",
  "sync",
]);

export const activities = pgTable(
  "activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    type: activityTypeEnum("type").notNull(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    // Generic link to any other entity (opportunity, proposal, invoice...)
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    title: text("title").notNull(),
    body: text("body"),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    source: text("source").notNull().default("user"), // user | system | betterproposals | xero | ninjaone
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("activities_company_at_idx").on(t.companyId, t.at),
    index("activities_entity_idx").on(t.entityType, t.entityId),
  ],
);

// ---------------------------------------------------------------------------
// Saved views (per user, per list page)
// ---------------------------------------------------------------------------
export const savedViews = pgTable(
  "saved_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    page: text("page").notNull(), // companies | contacts | opportunities | ...
    name: text("name").notNull(),
    // URL search params snapshot
    params: jsonb("params").$type<Record<string, string>>().notNull().default({}),
    isShared: boolean("is_shared").notNull().default(false),
    ...timestamps,
  },
  (t) => [index("saved_views_user_page_idx").on(t.userId, t.page)],
);
