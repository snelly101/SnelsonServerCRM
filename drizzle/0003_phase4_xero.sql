CREATE TYPE "public"."invoice_draft_status" AS ENUM('draft', 'approved', 'created', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."xero_invoice_status" AS ENUM('DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID', 'VOIDED', 'DELETED');--> statement-breakpoint
CREATE TABLE "invoice_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_id" uuid,
	"opportunity_id" uuid,
	"status" "invoice_draft_status" DEFAULT 'draft' NOT NULL,
	"reference" text NOT NULL,
	"description" text,
	"currency_code" text NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date NOT NULL,
	"period_start" date,
	"period_end" date,
	"line_amount_types" text DEFAULT 'Exclusive' NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sub_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"prepared_by_user_id" text,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"xero_invoice_id" text,
	"xero_invoice_number" text,
	"created_in_xero_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "xero_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"email_address" text,
	"email_domain" text,
	"tax_number" text,
	"company_number" text,
	"account_number" text,
	"contact_status" text,
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"phones" jsonb,
	"addresses" jsonb,
	"outstanding" numeric(14, 2),
	"overdue" numeric(14, 2),
	"updated_date_utc" timestamp with time zone,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_contacts_contact_id_unique" UNIQUE("contact_id")
);
--> statement-breakpoint
CREATE TABLE "xero_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" text NOT NULL,
	"invoice_number" text,
	"reference" text,
	"type" text DEFAULT 'ACCREC' NOT NULL,
	"status" "xero_invoice_status" NOT NULL,
	"contact_id" text,
	"company_id" uuid,
	"date" date,
	"due_date" date,
	"currency_code" text,
	"sub_total" numeric(14, 2),
	"total_tax" numeric(14, 2),
	"total" numeric(14, 2),
	"amount_due" numeric(14, 2),
	"amount_paid" numeric(14, 2),
	"amount_credited" numeric(14, 2),
	"fully_paid_on_date" date,
	"sent_to_contact" boolean,
	"online_invoice_url" text,
	"line_items" jsonb,
	"updated_date_utc" timestamp with time zone,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_invoices_invoice_id_unique" UNIQUE("invoice_id")
);
--> statement-breakpoint
CREATE TABLE "xero_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" text NOT NULL,
	"invoice_id" text,
	"date" date,
	"amount" numeric(14, 2),
	"reference" text,
	"status" text,
	"payment_type" text,
	"is_reconciled" boolean,
	"updated_date_utc" timestamp with time zone,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_payments_payment_id_unique" UNIQUE("payment_id")
);
--> statement-breakpoint
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_prepared_by_user_id_user_id_fk" FOREIGN KEY ("prepared_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xero_invoices" ADD CONSTRAINT "xero_invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_drafts_reference_unique" ON "invoice_drafts" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "invoice_drafts_company_idx" ON "invoice_drafts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "invoice_drafts_status_idx" ON "invoice_drafts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "xero_contacts_name_idx" ON "xero_contacts" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "xero_contacts_domain_idx" ON "xero_contacts" USING btree ("email_domain");--> statement-breakpoint
CREATE INDEX "xero_contacts_tax_idx" ON "xero_contacts" USING btree ("tax_number");--> statement-breakpoint
CREATE INDEX "xero_invoices_company_idx" ON "xero_invoices" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "xero_invoices_contact_idx" ON "xero_invoices" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "xero_invoices_status_due_idx" ON "xero_invoices" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "xero_invoices_reference_idx" ON "xero_invoices" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "xero_payments_invoice_idx" ON "xero_payments" USING btree ("invoice_id");