CREATE TYPE "public"."discrepancy_status" AS ENUM('open', 'accepted', 'dismissed', 'resolved');--> statement-breakpoint
CREATE TABLE "billing_discrepancies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"contract_line_id" uuid NOT NULL,
	"site_id" uuid,
	"line_description" text NOT NULL,
	"contracted_qty" numeric(12, 2) NOT NULL,
	"observed_qty" integer NOT NULL,
	"difference" numeric(12, 2) NOT NULL,
	"unit_price" numeric(12, 2),
	"status" "discrepancy_status" DEFAULT 'open' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"basis" jsonb,
	"note" text,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ninja_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"org_id" text NOT NULL,
	"location_id" text,
	"company_id" uuid,
	"site_id" uuid,
	"node_class" text NOT NULL,
	"display_name" text,
	"system_name" text,
	"dns_name" text,
	"approval_status" text,
	"offline" boolean,
	"last_contact" timestamp with time zone,
	"last_update" timestamp with time zone,
	"created_external" timestamp with time zone,
	"os_name" text,
	"os_manufacturer" text,
	"os_build" text,
	"needs_reboot" boolean,
	"health_status" text,
	"pending_os_patches" integer,
	"failed_os_patches" integer,
	"active_threats" integer,
	"av_status" text,
	"alert_count" integer,
	"ip_addresses" text[],
	"public_ip" text,
	"external_status" text DEFAULT 'active' NOT NULL,
	"raw" jsonb,
	"health_fetched_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ninja_devices_device_id_unique" UNIQUE("device_id")
);
--> statement-breakpoint
CREATE TABLE "ninja_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"external_status" text DEFAULT 'active' NOT NULL,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ninja_locations_location_id_unique" UNIQUE("location_id")
);
--> statement-breakpoint
CREATE TABLE "ninja_organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"description" text,
	"node_approval_mode" text,
	"external_status" text DEFAULT 'active' NOT NULL,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ninja_organizations_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
ALTER TABLE "billing_discrepancies" ADD CONSTRAINT "billing_discrepancies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_discrepancies" ADD CONSTRAINT "billing_discrepancies_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_discrepancies" ADD CONSTRAINT "billing_discrepancies_contract_line_id_contract_lines_id_fk" FOREIGN KEY ("contract_line_id") REFERENCES "public"."contract_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_discrepancies" ADD CONSTRAINT "billing_discrepancies_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_discrepancies" ADD CONSTRAINT "billing_discrepancies_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ninja_devices" ADD CONSTRAINT "ninja_devices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ninja_devices" ADD CONSTRAINT "ninja_devices_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discrepancies_status_idx" ON "billing_discrepancies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "discrepancies_contract_line_idx" ON "billing_discrepancies" USING btree ("contract_line_id","status");--> statement-breakpoint
CREATE INDEX "discrepancies_company_idx" ON "billing_discrepancies" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "ninja_devices_org_idx" ON "ninja_devices" USING btree ("org_id","location_id");--> statement-breakpoint
CREATE INDEX "ninja_devices_company_idx" ON "ninja_devices" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "ninja_devices_class_idx" ON "ninja_devices" USING btree ("node_class");--> statement-breakpoint
CREATE INDEX "ninja_devices_last_contact_idx" ON "ninja_devices" USING btree ("last_contact");--> statement-breakpoint
CREATE INDEX "ninja_locations_org_idx" ON "ninja_locations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ninja_orgs_name_idx" ON "ninja_organizations" USING btree ("normalized_name");