import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
  integer,
  numeric,
  date,
} from "drizzle-orm/pg-core";
import { companies, timestamps } from "./core";
import { contractLines } from "./sales";

// ---------------------------------------------------------------------------
// Pax8 mirrors (read-only integration). A Pax8 "company" is the customer
// account at the distributor; subscriptions are the licences it holds
// (Microsoft 365, Acronis, security add-ons…) with quantity, partner cost
// and term; invoice items are what Pax8 charged the partner per customer.
// Rows are linked to a CRM company directly (one Pax8 company per CRM
// company). Nothing is ever deleted by a sync: external_status marks rows
// that disappeared from Pax8.
// ---------------------------------------------------------------------------
export const pax8MatchSourceEnum = pgEnum("pax8_match_source", [
  "manual",
  "auto",
]);

export const pax8Companies = pgTable(
  "pax8_companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pax8Id: text("pax8_id").notNull(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    website: text("website"),
    /** Registrable domain from the website, used for matching (example.co.uk). */
    matchDomain: text("match_domain"),
    phone: text("phone"),
    city: text("city"),
    country: text("country"),
    /** Pax8's own free-text external reference on the company (some partners put their PSA id here). */
    externalRef: text("external_ref"),
    /** Active | Inactive | Deleted at Pax8. */
    status: text("status"),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    matchSource: pax8MatchSourceEnum("match_source"),
    /** active | deleted (disappeared from Pax8) */
    externalStatus: text("external_status").notNull().default("active"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("pax8_companies_pax8_id_unique").on(t.pax8Id),
    index("pax8_companies_company_idx").on(t.companyId),
    index("pax8_companies_name_idx").on(t.normalizedName),
    index("pax8_companies_domain_idx").on(t.matchDomain),
  ],
);

export const pax8Products = pgTable(
  "pax8_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: text("product_id").notNull(),
    name: text("name").notNull(),
    vendorName: text("vendor_name"),
    sku: text("sku"),
    vendorSku: text("vendor_sku"),
    shortDescription: text("short_description"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("pax8_products_product_id_unique").on(t.productId),
    index("pax8_products_sku_idx").on(t.sku),
  ],
);

export const pax8Subscriptions = pgTable(
  "pax8_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: text("subscription_id").notNull(),
    pax8CompanyId: text("pax8_company_id").notNull(),
    /** Derived from the Pax8 company's link at sync time; kept so company queries are cheap. */
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    productId: text("product_id").notNull(),
    /** Denormalised from pax8_products so the subscription row reads on its own. */
    productName: text("product_name").notNull(),
    vendorName: text("vendor_name"),
    sku: text("sku"),
    vendorSku: text("vendor_sku"),
    quantity: integer("quantity").notNull().default(0),
    /** Active, Cancelled, PendingManual, PendingAutomated, PendingCancel, WaitingForDetails, Trial, Converted, PendingActivation, Activated */
    status: text("status").notNull(),
    /** Partner (buy) price per unit per billing term, as Pax8 reports it. */
    price: numeric("price", { precision: 12, scale: 4 }),
    currency: text("currency"),
    /** Monthly, Annual, 2-Year, 3-Year, One-Time, Trial, Activation */
    billingTerm: text("billing_term"),
    commitmentTerm: text("commitment_term"),
    commitmentEndsOn: date("commitment_ends_on"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    billingStart: date("billing_start"),
    createdExternal: timestamp("created_external", { withTimezone: true }),
    /** The contract line that bills this subscription, chosen by a person (overrides SKU / name matching). */
    contractLineId: uuid("contract_line_id").references(
      () => contractLines.id,
      { onDelete: "set null" },
    ),
    /** active | deleted (disappeared from Pax8) */
    externalStatus: text("external_status").notNull().default("active"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("pax8_subscriptions_subscription_id_unique").on(
      t.subscriptionId,
    ),
    index("pax8_subscriptions_company_idx").on(t.companyId, t.status),
    index("pax8_subscriptions_pax8_company_idx").on(t.pax8CompanyId),
    index("pax8_subscriptions_line_idx").on(t.contractLineId),
  ],
);

export const pax8InvoiceItems = pgTable(
  "pax8_invoice_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: text("item_id").notNull(),
    invoiceId: text("invoice_id").notNull(),
    invoiceDate: date("invoice_date"),
    invoiceStatus: text("invoice_status"),
    pax8CompanyId: text("pax8_company_id"),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    productId: text("product_id"),
    sku: text("sku"),
    description: text("description"),
    quantity: numeric("quantity", { precision: 12, scale: 2 }),
    unitPrice: numeric("unit_price", { precision: 12, scale: 4 }),
    total: numeric("total", { precision: 12, scale: 2 }),
    currency: text("currency"),
    startPeriod: date("start_period"),
    endPeriod: date("end_period"),
    chargeType: text("charge_type"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("pax8_invoice_items_item_id_unique").on(t.itemId),
    index("pax8_invoice_items_company_idx").on(t.companyId, t.invoiceDate),
    index("pax8_invoice_items_invoice_idx").on(t.invoiceId),
  ],
);
