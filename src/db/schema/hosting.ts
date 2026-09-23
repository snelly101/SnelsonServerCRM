import { pgTable, text, timestamp, uuid, jsonb, pgEnum, index, uniqueIndex, boolean, date, bigint } from "drizzle-orm/pg-core";
import { companies, timestamps } from "./core";
import { contractLines } from "./sales";

// ---------------------------------------------------------------------------
// 20i hosting mirror (read-only integration). One row per thing the reseller
// account holds: a hosting package, a registered domain, a mailbox. Rows are
// linked to a CRM company (directly, not via external_links, because one
// company can own many packages) and optionally to the contract line that
// bills them. fetched_at gives freshness; external_status marks things that
// disappeared from 20i (kept, never deleted).
// ---------------------------------------------------------------------------
export const hostingItemKindEnum = pgEnum("hosting_item_kind", ["package", "domain", "mailbox", "ssl"]);
export const hostingMatchSourceEnum = pgEnum("hosting_match_source", ["manual", "auto", "inherited"]);

export const hostingItems = pgTable(
  "hosting_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: hostingItemKindEnum("kind").notNull(),
    /** 20i id: package id, domain id, or `<packageId>:<mailbox address>` for mailboxes. */
    externalId: text("external_id").notNull(),
    /** Package name (primary domain), registered domain, or mailbox address. */
    name: text("name").notNull(),
    /** Registrable domain used for matching to companies (e.g. example.co.uk). */
    matchDomain: text("match_domain"),
    /** Parent package id for mailboxes / SSL certs; the package a domain is attached to when known. */
    parentExternalId: text("parent_external_id"),
    /** e.g. "Linux Unlimited", "WordPress"; the TLD for domains; "mailbox" for mailboxes. */
    typeName: text("type_name"),
    enabled: boolean("enabled"),
    /** Domain expiry (registry) or certificate expiry. Packages do not expire at 20i. */
    expiresOn: date("expires_on"),
    createdExternal: timestamp("created_external", { withTimezone: true }),
    /** Extra names on a package, StackCP users, labels, usage figures. */
    details: jsonb("details").$type<Record<string, unknown>>(),
    diskUsedBytes: bigint("disk_used_bytes", { mode: "number" }),
    diskLimitBytes: bigint("disk_limit_bytes", { mode: "number" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    matchSource: hostingMatchSourceEnum("match_source"),
    /** The contract line that bills this item (a domain renewal line, a hosting line). */
    contractLineId: uuid("contract_line_id").references(() => contractLines.id, { onDelete: "set null" }),
    /** active | deleted (disappeared from 20i) */
    externalStatus: text("external_status").notNull().default("active"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("hosting_items_external_unique").on(t.kind, t.externalId),
    index("hosting_items_company_idx").on(t.companyId, t.kind),
    index("hosting_items_parent_idx").on(t.parentExternalId),
    index("hosting_items_expires_idx").on(t.expiresOn),
    index("hosting_items_match_domain_idx").on(t.matchDomain),
    index("hosting_items_contract_line_idx").on(t.contractLineId),
  ],
);
