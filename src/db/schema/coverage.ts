import { pgTable, text, uuid, date, uniqueIndex, index } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { companies, timestamps } from "./core";
import { contractLines } from "./sales";

// ---------------------------------------------------------------------------
// Service coverage: the commercial state of a supplied service that is not
// simply "charged by its own contract line". The mirrors (Pax8 subscriptions,
// 20i items, NinjaOne devices) keep their own `contract_line_id` for the
// charged-separately case; this table records the other explicit answers so
// nothing without an invoice line reads as "unbilled" by default.
// ---------------------------------------------------------------------------
export const coverageSourceValues = ["pax8_subscription", "hosting_item", "ninja_device"] as const;
export type CoverageSource = (typeof coverageSourceValues)[number];

/**
 * bundle: included in another contract line (the bundle line); its quantity counts toward that line.
 * commitment: covered by a minimum commitment line (optional line reference); not counted against it.
 * free: intentionally not charged, with a reason and a review date.
 * internal: the MSP's own or otherwise non-billable (a test tenant, an engineer's laptop).
 * investigate: flagged as needing a decision, with a note.
 */
export const coverageStateValues = ["bundle", "commitment", "free", "internal", "investigate"] as const;
export type CoverageState = (typeof coverageStateValues)[number];

export const serviceCoverage = pgTable(
  "service_coverage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    /** The mirror row's id (pax8_subscriptions.id, hosting_items.id, ninja_devices.id). */
    sourceRowId: uuid("source_row_id").notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    contractLineId: uuid("contract_line_id").references(() => contractLines.id, { onDelete: "set null" }),
    reason: text("reason"),
    reviewOn: date("review_on"),
    setByUserId: text("set_by_user_id").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("service_coverage_source_unique").on(t.source, t.sourceRowId), index("service_coverage_company_idx").on(t.companyId, t.state), index("service_coverage_review_idx").on(t.reviewOn)],
);
