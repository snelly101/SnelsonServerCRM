import { pgTable, text, timestamp, uuid, jsonb, pgEnum, index, uniqueIndex, integer, numeric } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { companies, contacts, timestamps } from "./core";
import { opportunities } from "./sales";

export const providerEnum = pgEnum("integration_provider", ["betterproposals", "xero", "ninjaone", "twentyi"]);

/** live = real API with stored credentials; demo = synthetic adapter (never shows as connected). */
export const connectionModeEnum = pgEnum("connection_mode", ["live", "demo"]);
export const connectionStatusEnum = pgEnum("connection_status", ["not_configured", "connected", "error", "expired"]);

// ---------------------------------------------------------------------------
// One row per provider. Credentials are AES-256-GCM encrypted (lib/crypto).
// ---------------------------------------------------------------------------
export const integrationConnections = pgTable("integration_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: providerEnum("provider").notNull().unique(),
  mode: connectionModeEnum("mode").notNull().default("demo"),
  status: connectionStatusEnum("status").notNull().default("not_configured"),
  /** Encrypted JSON blob: { apiToken } | { accessToken, refreshToken, expiresAt, tenantId } | { clientId, clientSecret, region } */
  credentialsEnc: text("credentials_enc"),
  /** Non-secret config: default template, account codes, region, tenant name, etc. */
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  /** Provider-side identity shown on the Integrations page (org name, account name). */
  externalAccountName: text("external_account_name"),
  externalAccountId: text("external_account_id"),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
  /** Circuit breaker: when set and in the future, scheduled jobs skip this provider. */
  pausedUntil: timestamp("paused_until", { withTimezone: true }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  connectedByUserId: text("connected_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
});

// ---------------------------------------------------------------------------
// Links between CRM records and external records. Unique both ways so one
// external record can never map to two local ones and vice versa.
// ---------------------------------------------------------------------------
export const linkEntityEnum = pgEnum("link_entity", ["company", "contact", "site", "opportunity", "contract", "invoice", "device", "product"]);
export const linkSourceEnum = pgEnum("link_source", ["manual", "created_by_crm", "auto_confirmed", "import"]);

export const externalLinks = pgTable(
  "external_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: providerEnum("provider").notNull(),
    entityType: linkEntityEnum("entity_type").notNull(),
    localId: text("local_id").notNull(),
    externalId: text("external_id").notNull(),
    /** Optional sub-type, e.g. NinjaOne "organization" vs "location". */
    externalType: text("external_type"),
    externalName: text("external_name"),
    externalUrl: text("external_url"),
    source: linkSourceEnum("source").notNull().default("manual"),
    /** Set when the external record was deleted/archived at the provider. The link is kept. */
    externalStatus: text("external_status").notNull().default("active"),
    linkedByUserId: text("linked_by_user_id").references(() => user.id, { onDelete: "set null" }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("external_links_local_unique").on(t.provider, t.entityType, t.localId),
    uniqueIndex("external_links_external_unique").on(t.provider, t.entityType, t.externalId),
  ],
);

// ---------------------------------------------------------------------------
// Sync history, inbound event de-duplication, outbound idempotency
// ---------------------------------------------------------------------------
export const syncStatusEnum = pgEnum("sync_status", ["running", "success", "partial", "failed"]);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: providerEnum("provider").notNull(),
    kind: text("kind").notNull(), // e.g. proposals.poll, xero.invoices, ninjaone.devices
    trigger: text("trigger").notNull().default("schedule"), // schedule | manual | webhook
    status: syncStatusEnum("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    fetched: integer("fetched").notNull().default(0),
    created: integer("created").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    /** Readable summary or error message. Never contains credentials. */
    message: text("message"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    triggeredByUserId: text("triggered_by_user_id").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [index("sync_runs_provider_started_idx").on(t.provider, t.startedAt)],
);

export const syncErrors = pgTable(
  "sync_errors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    syncRunId: uuid("sync_run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    externalId: text("external_id"),
    localId: text("local_id"),
    message: text("message").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sync_errors_run_idx").on(t.syncRunId)],
);

/** Every webhook delivery or polled state change is recorded once; processing is idempotent on (provider, eventId). */
export const inboundEvents = pgTable(
  "inbound_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: providerEnum("provider").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    externalId: text("external_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [uniqueIndex("inbound_events_unique").on(t.provider, t.eventId), index("inbound_events_unprocessed_idx").on(t.provider, t.processedAt)],
);

export const outboundStatusEnum = pgEnum("outbound_status", ["pending", "in_flight", "succeeded", "failed"]);

/**
 * Outbound write ledger. A deterministic idempotency key per logical write
 * (e.g. bp:create:<opportunityId>:1) means retries reuse the row instead of
 * creating a second proposal/invoice at the provider.
 */
export const outboundRequests = pgTable(
  "outbound_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: providerEnum("provider").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    operation: text("operation").notNull(),
    status: outboundStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    requestSummary: jsonb("request_summary").$type<Record<string, unknown>>(),
    responseSummary: jsonb("response_summary").$type<Record<string, unknown>>(),
    externalId: text("external_id"),
    error: text("error"),
    requestedByUserId: text("requested_by_user_id").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("outbound_requests_key_unique").on(t.provider, t.idempotencyKey)],
);

export const conflictStatusEnum = pgEnum("conflict_status", ["open", "resolved", "dismissed"]);

/** Ambiguous matches or conflicting edits that need a person to decide. */
export const mappingConflicts = pgTable(
  "mapping_conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: providerEnum("provider").notNull(),
    entityType: linkEntityEnum("entity_type").notNull(),
    localId: text("local_id"),
    externalId: text("external_id"),
    kind: text("kind").notNull(), // ambiguous_match | field_conflict | external_deleted | unmapped
    message: text("message").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
    status: conflictStatusEnum("status").notNull().default("open"),
    resolvedByUserId: text("resolved_by_user_id").references(() => user.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("mapping_conflicts_open_idx").on(t.provider, t.status)],
);

// ---------------------------------------------------------------------------
// Better Proposals mirror. One row per proposal we know about.
// ---------------------------------------------------------------------------
export const bpProposalStatusEnum = pgEnum("bp_proposal_status", ["draft", "sent", "opened", "signed", "paid", "unknown"]);

export const bpProposals = pgTable(
  "bp_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalId: text("external_id").notNull().unique(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    subjectLine: text("subject_line"),
    externalCompanyName: text("external_company_name"),
    externalCompanyId: text("external_company_id"),
    templateId: text("template_id"),
    status: bpProposalStatusEnum("status").notNull().default("unknown"),
    currencyCode: text("currency_code"),
    oneOffTotal: numeric("one_off_total", { precision: 12, scale: 2 }),
    monthlyTotal: numeric("monthly_total", { precision: 12, scale: 2 }),
    quarterlyTotal: numeric("quarterly_total", { precision: 12, scale: 2 }),
    annualTotal: numeric("annual_total", { precision: 12, scale: 2 }),
    viewUrl: text("view_url"),
    previewUrl: text("preview_url"),
    createdAtExternal: timestamp("created_at_external", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    signedBy: text("signed_by"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** Set once the acceptance workflow (won + onboarding) has run for this proposal. */
    acceptanceProcessedAt: timestamp("acceptance_processed_at", { withTimezone: true }),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index("bp_proposals_opportunity_idx").on(t.opportunityId), index("bp_proposals_company_idx").on(t.companyId), index("bp_proposals_status_idx").on(t.status)],
);


