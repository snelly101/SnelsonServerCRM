import { pgTable, text, timestamp, uuid, jsonb, pgEnum, index, numeric, date, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { companies, timestamps } from "./core";
import { contracts, opportunities } from "./sales";

// ---------------------------------------------------------------------------
// Xero mirrors. Xero is the source of truth for everything in these tables;
// the CRM only reads them. Each row carries fetched_at for freshness labels.
// ---------------------------------------------------------------------------
export const xeroContacts = pgTable(
  "xero_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: text("contact_id").notNull().unique(), // Xero ContactID
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    emailAddress: text("email_address"),
    emailDomain: text("email_domain"),
    taxNumber: text("tax_number"),
    companyNumber: text("company_number"),
    accountNumber: text("account_number"),
    contactStatus: text("contact_status"), // ACTIVE | ARCHIVED | GDPRREQUEST
    isCustomer: boolean("is_customer").notNull().default(false),
    isSupplier: boolean("is_supplier").notNull().default(false),
    phones: jsonb("phones").$type<{ type: string; number: string | null; areaCode: string | null; countryCode: string | null }[]>(),
    addresses: jsonb("addresses").$type<Record<string, unknown>[]>(),
    outstanding: numeric("outstanding", { precision: 14, scale: 2 }),
    overdue: numeric("overdue", { precision: 14, scale: 2 }),
    updatedDateUtc: timestamp("updated_date_utc", { withTimezone: true }),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index("xero_contacts_name_idx").on(t.normalizedName), index("xero_contacts_domain_idx").on(t.emailDomain), index("xero_contacts_tax_idx").on(t.taxNumber)],
);

export const xeroInvoiceStatusEnum = pgEnum("xero_invoice_status", ["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED"]);

export const xeroInvoices = pgTable(
  "xero_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: text("invoice_id").notNull().unique(), // Xero InvoiceID
    invoiceNumber: text("invoice_number"),
    reference: text("reference"),
    type: text("type").notNull().default("ACCREC"),
    status: xeroInvoiceStatusEnum("status").notNull(),
    contactId: text("contact_id"), // Xero ContactID
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    date: date("date"),
    dueDate: date("due_date"),
    currencyCode: text("currency_code"),
    subTotal: numeric("sub_total", { precision: 14, scale: 2 }),
    totalTax: numeric("total_tax", { precision: 14, scale: 2 }),
    total: numeric("total", { precision: 14, scale: 2 }),
    amountDue: numeric("amount_due", { precision: 14, scale: 2 }),
    amountPaid: numeric("amount_paid", { precision: 14, scale: 2 }),
    amountCredited: numeric("amount_credited", { precision: 14, scale: 2 }),
    fullyPaidOnDate: date("fully_paid_on_date"),
    sentToContact: boolean("sent_to_contact"),
    onlineInvoiceUrl: text("online_invoice_url"),
    lineItems: jsonb("line_items").$type<Record<string, unknown>[]>(),
    updatedDateUtc: timestamp("updated_date_utc", { withTimezone: true }),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index("xero_invoices_company_idx").on(t.companyId), index("xero_invoices_contact_idx").on(t.contactId), index("xero_invoices_status_due_idx").on(t.status, t.dueDate), index("xero_invoices_reference_idx").on(t.reference)],
);

export const xeroPayments = pgTable(
  "xero_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: text("payment_id").notNull().unique(),
    invoiceId: text("invoice_id"),
    date: date("date"),
    amount: numeric("amount", { precision: 14, scale: 2 }),
    reference: text("reference"),
    status: text("status"),
    paymentType: text("payment_type"),
    isReconciled: boolean("is_reconciled"),
    updatedDateUtc: timestamp("updated_date_utc", { withTimezone: true }),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("xero_payments_invoice_idx").on(t.invoiceId)],
);

// ---------------------------------------------------------------------------
// CRM-side invoice drafts. A draft is prepared from approved commercial data
// (a contract period or a won opportunity's one-off lines), reviewed by an
// authorised user, then created in Xero as a DRAFT exactly once.
// ---------------------------------------------------------------------------
export const invoiceDraftStatusEnum = pgEnum("invoice_draft_status", ["draft", "approved", "created", "failed", "cancelled"]);

export type InvoiceDraftLine = {
  description: string;
  quantity: number;
  unitAmount: number;
  accountCode: string;
  taxType: string;
  itemCode?: string | null;
};

export const invoiceDrafts = pgTable(
  "invoice_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id").references(() => contracts.id, { onDelete: "set null" }),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "set null" }),
    status: invoiceDraftStatusEnum("status").notNull().default("draft"),
    /** CRM reference sent to Xero as `Reference`; used to reconcile after a failed create. */
    reference: text("reference").notNull(),
    description: text("description"),
    currencyCode: text("currency_code").notNull(),
    invoiceDate: date("invoice_date").notNull(),
    dueDate: date("due_date").notNull(),
    /** Billing period covered (recurring contracts). */
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    lineAmountTypes: text("line_amount_types").notNull().default("Exclusive"),
    lines: jsonb("lines").$type<InvoiceDraftLine[]>().notNull().default([]),
    subTotal: numeric("sub_total", { precision: 14, scale: 2 }).notNull().default("0"),
    notes: text("notes"),
    preparedByUserId: text("prepared_by_user_id").references(() => user.id, { onDelete: "set null" }),
    approvedByUserId: text("approved_by_user_id").references(() => user.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    xeroInvoiceId: text("xero_invoice_id"),
    xeroInvoiceNumber: text("xero_invoice_number"),
    createdInXeroAt: timestamp("created_in_xero_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [uniqueIndex("invoice_drafts_reference_unique").on(t.reference), index("invoice_drafts_company_idx").on(t.companyId), index("invoice_drafts_status_idx").on(t.status)],
);
