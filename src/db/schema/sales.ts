import { pgTable, text, timestamp, boolean, uuid, jsonb, pgEnum, index, integer, numeric, date, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { companies, contacts, sites, timestamps } from "./core";

// ---------------------------------------------------------------------------
// Service catalogue
// ---------------------------------------------------------------------------
export const productCategoryEnum = pgEnum("product_category", [
  "managed_it",
  "microsoft_365",
  "security",
  "backup",
  "networking",
  "hardware",
  "consultancy",
  "other",
]);

/** How a line is priced. Drives contracted-quantity vs observed-device comparison. */
export const pricingModelEnum = pgEnum("pricing_model", ["per_user", "per_device", "fixed", "one_off"]);

/** Recurring revenue is reported separately from one-off project and hardware revenue. */
export const revenueTypeEnum = pgEnum("revenue_type", ["recurring", "one_off_project", "hardware"]);

export const billingFrequencyEnum = pgEnum("billing_frequency", ["monthly", "quarterly", "annual", "one_off"]);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: text("sku"),
    name: text("name").notNull(),
    category: productCategoryEnum("category").notNull().default("managed_it"),
    description: text("description"),
    pricingModel: pricingModelEnum("pricing_model").notNull().default("per_user"),
    revenueType: revenueTypeEnum("revenue_type").notNull().default("recurring"),
    billingFrequency: billingFrequencyEnum("billing_frequency").notNull().default("monthly"),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull().default("0"),
    // Null means cost unknown: margins are then labelled as estimates.
    unitCost: numeric("unit_cost", { precision: 12, scale: 2 }),
    // Counted against NinjaOne devices when true and pricing is per_device.
    countsAsManagedDevice: boolean("counts_as_managed_device").notNull().default(false),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("products_sku_unique").on(t.sku), index("products_category_idx").on(t.category)],
);

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    // Default probability applied when an opportunity enters this stage.
    probability: integer("probability").notNull().default(10),
    isWon: boolean("is_won").notNull().default(false),
    isLost: boolean("is_lost").notNull().default(false),
    color: text("color").notNull().default("slate"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("pipeline_stages_order_idx").on(t.sortOrder)],
);

export const opportunityStatusEnum = pgEnum("opportunity_status", ["open", "won", "lost"]);

export const opportunities = pgTable(
  "opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => pipelineStages.id),
    status: opportunityStatusEnum("status").notNull().default("open"),
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "set null" }),
    expectedCloseDate: date("expected_close_date"),
    probability: integer("probability").notNull().default(10),
    leadSource: text("lead_source"),
    nextAction: text("next_action"),
    nextActionDate: date("next_action_date"),
    lostReason: text("lost_reason"),
    wonAt: timestamp("won_at", { withTimezone: true }),
    lostAt: timestamp("lost_at", { withTimezone: true }),
    // Board ordering within a stage.
    boardOrder: integer("board_order").notNull().default(0),
    notes: text("notes"),
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("opportunities_company_idx").on(t.companyId),
    index("opportunities_stage_idx").on(t.stageId, t.boardOrder),
    index("opportunities_owner_idx").on(t.ownerUserId),
    index("opportunities_status_idx").on(t.status),
    index("opportunities_close_idx").on(t.expectedCloseDate),
  ],
);

export const opportunityLines = pgTable(
  "opportunity_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    revenueType: revenueTypeEnum("revenue_type").notNull().default("recurring"),
    pricingModel: pricingModelEnum("pricing_model").notNull().default("per_user"),
    billingFrequency: billingFrequencyEnum("billing_frequency").notNull().default("monthly"),
    quantity: numeric("quantity", { precision: 12, scale: 2 }).notNull().default("1"),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull().default("0"),
    unitCost: numeric("unit_cost", { precision: 12, scale: 2 }),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("opportunity_lines_opp_idx").on(t.opportunityId, t.sortOrder)],
);

// ---------------------------------------------------------------------------
// Contracts (managed service agreements)
// ---------------------------------------------------------------------------
export const contractStatusEnum = pgEnum("contract_status", ["draft", "active", "expired", "cancelled"]);

export const contracts = pgTable(
  "contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "set null" }),
    // Better Proposals external id, set in Phase 3.
    externalProposalId: text("external_proposal_id"),
    name: text("name").notNull(),
    reference: text("reference"),
    status: contractStatusEnum("status").notNull().default("draft"),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    renewalDate: date("renewal_date"),
    noticePeriodDays: integer("notice_period_days").notNull().default(90),
    autoRenew: boolean("auto_renew").notNull().default(true),
    billingFrequency: billingFrequencyEnum("billing_frequency").notNull().default("monthly"),
    nextReviewDate: date("next_review_date"),
    reviewIntervalMonths: integer("review_interval_months").notNull().default(6),
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "set null" }),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("contracts_company_idx").on(t.companyId),
    index("contracts_status_idx").on(t.status),
    index("contracts_renewal_idx").on(t.renewalDate),
    index("contracts_review_idx").on(t.nextReviewDate),
  ],
);

export const contractLines = pgTable(
  "contract_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    // Optional: restrict a per-device line to one site (maps to a NinjaOne location).
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    revenueType: revenueTypeEnum("revenue_type").notNull().default("recurring"),
    pricingModel: pricingModelEnum("pricing_model").notNull().default("per_user"),
    billingFrequency: billingFrequencyEnum("billing_frequency").notNull().default("monthly"),
    // The contracted (billable) quantity. Observed device counts live in ninja_devices (Phase 5).
    quantity: numeric("quantity", { precision: 12, scale: 2 }).notNull().default("1"),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull().default("0"),
    unitCost: numeric("unit_cost", { precision: 12, scale: 2 }),
    countsAsManagedDevice: boolean("counts_as_managed_device").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("contract_lines_contract_idx").on(t.contractId, t.sortOrder)],
);

// ---------------------------------------------------------------------------
// Tasks, checklists, onboarding
// ---------------------------------------------------------------------------
export const taskPriorityEnum = pgEnum("task_priority", ["low", "normal", "high", "urgent"]);
export const taskStatusEnum = pgEnum("task_status", ["open", "done"]);

export const checklistTemplates = pgTable("checklist_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  isDefaultOnboarding: boolean("is_default_onboarding").notNull().default(false),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const checklistTemplateItems = pgTable(
  "checklist_template_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => checklistTemplates.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    // Days after onboarding start that the task is due.
    dueOffsetDays: integer("due_offset_days").notNull().default(7),
    defaultOwnerRole: text("default_owner_role"),
  },
  (t) => [index("checklist_template_items_tpl_idx").on(t.templateId, t.sortOrder)],
);

export const onboardingStatusEnum = pgEnum("onboarding_status", ["in_progress", "completed", "cancelled"]);

export const onboardings = pgTable(
  "onboardings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "set null" }),
    contractId: uuid("contract_id").references(() => contracts.id, { onDelete: "set null" }),
    /**
     * Idempotency key for automatic creation. For acceptance-driven onboarding
     * this is `proposal:<external id>`; for manual it is `opportunity:<id>`.
     * The unique index guarantees "create onboarding exactly once".
     */
    sourceKey: text("source_key"),
    templateId: uuid("template_id").references(() => checklistTemplates.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    status: onboardingStatusEnum("status").notNull().default("in_progress"),
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("onboardings_source_key_unique").on(t.sourceKey), index("onboardings_company_idx").on(t.companyId)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatusEnum("status").notNull().default("open"),
    priority: taskPriorityEnum("priority").notNull().default("normal"),
    dueDate: date("due_date"),
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "set null" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id").references(() => contracts.id, { onDelete: "cascade" }),
    onboardingId: uuid("onboarding_id").references(() => onboardings.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Idempotency key for system-generated tasks (e.g. `renewal:<contractId>:<date>`). */
    sourceKey: text("source_key"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedByUserId: text("completed_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tasks_source_key_unique").on(t.sourceKey),
    index("tasks_owner_status_idx").on(t.ownerUserId, t.status),
    index("tasks_due_idx").on(t.status, t.dueDate),
    index("tasks_company_idx").on(t.companyId),
    index("tasks_opportunity_idx").on(t.opportunityId),
    index("tasks_onboarding_idx").on(t.onboardingId, t.sortOrder),
  ],
);
