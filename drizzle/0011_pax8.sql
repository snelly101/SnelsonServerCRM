CREATE TYPE "public"."pax8_match_source" AS ENUM('manual', 'auto');--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'pax8';--> statement-breakpoint
CREATE TABLE "pax8_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pax8_id" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"website" text,
	"match_domain" text,
	"phone" text,
	"city" text,
	"country" text,
	"external_ref" text,
	"status" text,
	"company_id" uuid,
	"match_source" "pax8_match_source",
	"external_status" text DEFAULT 'active' NOT NULL,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pax8_invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"invoice_date" date,
	"invoice_status" text,
	"pax8_company_id" text,
	"company_id" uuid,
	"product_id" text,
	"sku" text,
	"description" text,
	"quantity" numeric(12, 2),
	"unit_price" numeric(12, 4),
	"total" numeric(12, 2),
	"currency" text,
	"start_period" date,
	"end_period" date,
	"charge_type" text,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pax8_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" text NOT NULL,
	"name" text NOT NULL,
	"vendor_name" text,
	"sku" text,
	"vendor_sku" text,
	"short_description" text,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pax8_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" text NOT NULL,
	"pax8_company_id" text NOT NULL,
	"company_id" uuid,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"vendor_name" text,
	"sku" text,
	"vendor_sku" text,
	"quantity" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"price" numeric(12, 4),
	"currency" text,
	"billing_term" text,
	"commitment_term" text,
	"commitment_ends_on" date,
	"start_date" date,
	"end_date" date,
	"billing_start" date,
	"created_external" timestamp with time zone,
	"contract_line_id" uuid,
	"external_status" text DEFAULT 'active' NOT NULL,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_discrepancies" ADD COLUMN "source" text DEFAULT 'ninjaone' NOT NULL;--> statement-breakpoint
ALTER TABLE "pax8_companies" ADD CONSTRAINT "pax8_companies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pax8_invoice_items" ADD CONSTRAINT "pax8_invoice_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pax8_subscriptions" ADD CONSTRAINT "pax8_subscriptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pax8_subscriptions" ADD CONSTRAINT "pax8_subscriptions_contract_line_id_contract_lines_id_fk" FOREIGN KEY ("contract_line_id") REFERENCES "public"."contract_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pax8_companies_pax8_id_unique" ON "pax8_companies" USING btree ("pax8_id");--> statement-breakpoint
CREATE INDEX "pax8_companies_company_idx" ON "pax8_companies" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "pax8_companies_name_idx" ON "pax8_companies" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "pax8_companies_domain_idx" ON "pax8_companies" USING btree ("match_domain");--> statement-breakpoint
CREATE UNIQUE INDEX "pax8_invoice_items_item_id_unique" ON "pax8_invoice_items" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "pax8_invoice_items_company_idx" ON "pax8_invoice_items" USING btree ("company_id","invoice_date");--> statement-breakpoint
CREATE INDEX "pax8_invoice_items_invoice_idx" ON "pax8_invoice_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pax8_products_product_id_unique" ON "pax8_products" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "pax8_products_sku_idx" ON "pax8_products" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "pax8_subscriptions_subscription_id_unique" ON "pax8_subscriptions" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "pax8_subscriptions_company_idx" ON "pax8_subscriptions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "pax8_subscriptions_pax8_company_idx" ON "pax8_subscriptions" USING btree ("pax8_company_id");--> statement-breakpoint
CREATE INDEX "pax8_subscriptions_line_idx" ON "pax8_subscriptions" USING btree ("contract_line_id");