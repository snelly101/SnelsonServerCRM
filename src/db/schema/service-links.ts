import { pgTable, text, uuid, date, numeric, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { companies, timestamps } from "./core";
import { contractLines } from "./sales";

// ---------------------------------------------------------------------------
// Service links: the one place that says how a service an integration
// supplies relates to what the customer is billed. One row per mirrored
// service (a Pax8 subscription, a 20i package or domain, a NinjaOne device
// that needs its own answer); the role says what the link means and the
// contract line, where there is one, says which agreed charge it belongs to.
//
// Replaces the per-mirror `contract_line_id` columns and `service_coverage`
// (migration 0026 copies them in). Those columns are no longer written.
// ---------------------------------------------------------------------------
export const serviceSourceValues = ["pax8_subscription", "hosting_item", "ninja_device"] as const;
export type ServiceSource = (typeof serviceSourceValues)[number];

/**
 * charged      its own contract line bills it; its quantity counts against that line
 * bundle       included in another contract line (the bundle line); its quantity counts toward that line
 * commitment   covered by a minimum-commitment line (optional line reference); counts against nothing
 * free         intentionally not charged, with a reason and a review date
 * internal     the MSP's own or otherwise non-billable (a test tenant, an engineer's laptop)
 * investigate  flagged as needing a decision, with a note
 */
export const linkRoleValues = ["charged", "bundle", "commitment", "free", "internal", "investigate"] as const;
export type LinkRole = (typeof linkRoleValues)[number];

/** How a charged link came about: chosen by a person, or by a rule (catalogue SKU, product name) at sync time. */
export const matchSourceValues = ["manual", "sku", "name"] as const;
export type MatchSource = (typeof matchSourceValues)[number];

export const serviceLinks = pgTable(
  "service_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    /** The mirror row's id (pax8_subscriptions.id, hosting_items.id, ninja_devices.id). */
    sourceRowId: uuid("source_row_id").notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    contractLineId: uuid("contract_line_id").references(() => contractLines.id, { onDelete: "set null" }),
    role: text("role").notNull(),
    matchSource: text("match_source"),
    /** The service's quantity when the link was last confirmed by a sync (what it contributes to the line's observed count). */
    quantity: numeric("quantity", { precision: 12, scale: 2 }),
    /** Partner cost per month for the whole service when the supplier reports one (Pax8); null when the supplier has no pricing. */
    monthlyCost: numeric("monthly_cost", { precision: 12, scale: 4 }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    reason: text("reason"),
    reviewOn: date("review_on"),
    setByUserId: text("set_by_user_id").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("service_links_source_unique").on(t.source, t.sourceRowId), index("service_links_company_idx").on(t.companyId, t.role), index("service_links_line_idx").on(t.contractLineId), index("service_links_review_idx").on(t.reviewOn)],
);

// Names kept from the service_coverage era so existing imports keep compiling.
export const coverageSourceValues = serviceSourceValues;
export type CoverageSource = ServiceSource;
/** The explicitly recorded roles other than "charged" (what service_coverage used to hold). */
export const coverageStateValues = ["bundle", "commitment", "free", "internal", "investigate"] as const;
export type CoverageState = (typeof coverageStateValues)[number];
