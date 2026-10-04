CREATE TABLE "pax8_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pax8_invoice_id" text NOT NULL,
	"status" text,
	"invoice_date" date,
	"due_date" date,
	"total" numeric(14, 2),
	"balance" numeric(14, 2),
	"items_total" numeric(14, 2),
	"currency" text,
	"partner_name" text,
	"external_id" text,
	"xero_invoice_id" text,
	"match_source" text,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pax8_invoices_pax8_invoice_id_unique" ON "pax8_invoices" USING btree ("pax8_invoice_id");--> statement-breakpoint
CREATE INDEX "pax8_invoices_date_idx" ON "pax8_invoices" USING btree ("invoice_date");--> statement-breakpoint
CREATE INDEX "pax8_invoices_xero_idx" ON "pax8_invoices" USING btree ("xero_invoice_id");