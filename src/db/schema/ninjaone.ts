import { pgTable, text, timestamp, uuid, jsonb, pgEnum, index, integer, boolean, numeric } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { companies, sites, timestamps } from "./core";
import { contractLines, contracts } from "./sales";

// ---------------------------------------------------------------------------
// NinjaOne mirrors (read-only integration). Rows carry fetched_at so the UI
// can label live / cached / stale, and external_status for deleted records.
// ---------------------------------------------------------------------------
export const ninjaOrganizations = pgTable(
  "ninja_organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull().unique(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    description: text("description"),
    nodeApprovalMode: text("node_approval_mode"),
    externalStatus: text("external_status").notNull().default("active"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index("ninja_orgs_name_idx").on(t.normalizedName)],
);

export const ninjaLocations = pgTable(
  "ninja_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: text("location_id").notNull().unique(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    address: text("address"),
    externalStatus: text("external_status").notNull().default("active"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index("ninja_locations_org_idx").on(t.orgId)],
);

export const ninjaDevices = pgTable(
  "ninja_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: text("device_id").notNull().unique(),
    orgId: text("org_id").notNull(),
    locationId: text("location_id"),
    /** Derived from external links at sync time; kept so device queries by company are cheap. */
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    nodeClass: text("node_class").notNull(),
    displayName: text("display_name"),
    systemName: text("system_name"),
    dnsName: text("dns_name"),
    approvalStatus: text("approval_status"),
    offline: boolean("offline"),
    lastContact: timestamp("last_contact", { withTimezone: true }),
    lastUpdate: timestamp("last_update", { withTimezone: true }),
    createdExternal: timestamp("created_external", { withTimezone: true }),
    osName: text("os_name"),
    osManufacturer: text("os_manufacturer"),
    osBuild: text("os_build"),
    needsReboot: boolean("needs_reboot"),
    healthStatus: text("health_status"),
    pendingOsPatches: integer("pending_os_patches"),
    failedOsPatches: integer("failed_os_patches"),
    activeThreats: integer("active_threats"),
    avStatus: text("av_status"),
    alertCount: integer("alert_count"),
    ipAddresses: text("ip_addresses").array(),
    publicIp: text("public_ip"),
    /** active | deleted (disappeared from NinjaOne) */
    externalStatus: text("external_status").notNull().default("active"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    healthFetchedAt: timestamp("health_fetched_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index("ninja_devices_org_idx").on(t.orgId, t.locationId), index("ninja_devices_company_idx").on(t.companyId), index("ninja_devices_class_idx").on(t.nodeClass), index("ninja_devices_last_contact_idx").on(t.lastContact)],
);

// ---------------------------------------------------------------------------
// Contracted vs observed device counts, for human review. Never changes billing.
// ---------------------------------------------------------------------------
export const discrepancyStatusEnum = pgEnum("discrepancy_status", ["open", "accepted", "dismissed", "resolved"]);

export const billingDiscrepancies = pgTable(
  "billing_discrepancies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    contractLineId: uuid("contract_line_id")
      .notNull()
      .references(() => contractLines.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    lineDescription: text("line_description").notNull(),
    contractedQty: numeric("contracted_qty", { precision: 12, scale: 2 }).notNull(),
    observedQty: integer("observed_qty").notNull(),
    /** observed − contracted. Positive = more devices than billed. */
    difference: numeric("difference", { precision: 12, scale: 2 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }),
    status: discrepancyStatusEnum("status").notNull().default("open"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** How the observed count was derived (window, classes, scope). */
    basis: jsonb("basis").$type<Record<string, unknown>>(),
    note: text("note"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("discrepancies_status_idx").on(t.status), index("discrepancies_contract_line_idx").on(t.contractLineId, t.status), index("discrepancies_company_idx").on(t.companyId)],
);
