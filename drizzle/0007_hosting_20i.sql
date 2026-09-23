CREATE TYPE "public"."hosting_item_kind" AS ENUM('package', 'domain', 'mailbox', 'ssl');--> statement-breakpoint
CREATE TYPE "public"."hosting_match_source" AS ENUM('manual', 'auto', 'inherited');--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'twentyi';--> statement-breakpoint
CREATE TABLE "hosting_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "hosting_item_kind" NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"match_domain" text,
	"parent_external_id" text,
	"type_name" text,
	"enabled" boolean,
	"expires_on" date,
	"created_external" timestamp with time zone,
	"details" jsonb,
	"disk_used_bytes" bigint,
	"disk_limit_bytes" bigint,
	"company_id" uuid,
	"match_source" "hosting_match_source",
	"contract_line_id" uuid,
	"external_status" text DEFAULT 'active' NOT NULL,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hosting_items" ADD CONSTRAINT "hosting_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_items" ADD CONSTRAINT "hosting_items_contract_line_id_contract_lines_id_fk" FOREIGN KEY ("contract_line_id") REFERENCES "public"."contract_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hosting_items_external_unique" ON "hosting_items" USING btree ("kind","external_id");--> statement-breakpoint
CREATE INDEX "hosting_items_company_idx" ON "hosting_items" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX "hosting_items_parent_idx" ON "hosting_items" USING btree ("parent_external_id");--> statement-breakpoint
CREATE INDEX "hosting_items_expires_idx" ON "hosting_items" USING btree ("expires_on");--> statement-breakpoint
CREATE INDEX "hosting_items_match_domain_idx" ON "hosting_items" USING btree ("match_domain");--> statement-breakpoint
CREATE INDEX "hosting_items_contract_line_idx" ON "hosting_items" USING btree ("contract_line_id");