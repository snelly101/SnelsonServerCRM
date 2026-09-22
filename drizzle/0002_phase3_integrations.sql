CREATE TYPE "public"."bp_proposal_status" AS ENUM('draft', 'sent', 'opened', 'signed', 'paid', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."conflict_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."connection_mode" AS ENUM('live', 'demo');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('not_configured', 'connected', 'error', 'expired');--> statement-breakpoint
CREATE TYPE "public"."link_entity" AS ENUM('company', 'contact', 'site', 'opportunity', 'contract', 'invoice', 'device', 'product');--> statement-breakpoint
CREATE TYPE "public"."link_source" AS ENUM('manual', 'created_by_crm', 'auto_confirmed', 'import');--> statement-breakpoint
CREATE TYPE "public"."outbound_status" AS ENUM('pending', 'in_flight', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('betterproposals', 'xero', 'ninjaone');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('running', 'success', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "bp_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"company_id" uuid,
	"opportunity_id" uuid,
	"contact_id" uuid,
	"subject_line" text,
	"external_company_name" text,
	"external_company_id" text,
	"template_id" text,
	"status" "bp_proposal_status" DEFAULT 'unknown' NOT NULL,
	"currency_code" text,
	"one_off_total" numeric(12, 2),
	"monthly_total" numeric(12, 2),
	"quarterly_total" numeric(12, 2),
	"annual_total" numeric(12, 2),
	"view_url" text,
	"preview_url" text,
	"created_at_external" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"signed_by" text,
	"paid_at" timestamp with time zone,
	"acceptance_processed_at" timestamp with time zone,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bp_proposals_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "external_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"entity_type" "link_entity" NOT NULL,
	"local_id" text NOT NULL,
	"external_id" text NOT NULL,
	"external_type" text,
	"external_name" text,
	"external_url" text,
	"source" "link_source" DEFAULT 'manual' NOT NULL,
	"external_status" text DEFAULT 'active' NOT NULL,
	"linked_by_user_id" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"external_id" text,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"mode" "connection_mode" DEFAULT 'demo' NOT NULL,
	"status" "connection_status" DEFAULT 'not_configured' NOT NULL,
	"credentials_enc" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_account_name" text,
	"external_account_id" text,
	"last_tested_at" timestamp with time zone,
	"last_successful_sync_at" timestamp with time zone,
	"last_error" text,
	"paused_until" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"connected_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connections_provider_unique" UNIQUE("provider")
);
--> statement-breakpoint
CREATE TABLE "mapping_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"entity_type" "link_entity" NOT NULL,
	"local_id" text,
	"external_id" text,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"details" jsonb,
	"status" "conflict_status" DEFAULT 'open' NOT NULL,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"idempotency_key" text NOT NULL,
	"operation" text NOT NULL,
	"status" "outbound_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"request_summary" jsonb,
	"response_summary" jsonb,
	"external_id" text,
	"error" text,
	"requested_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"external_id" text,
	"local_id" text,
	"message" text NOT NULL,
	"details" jsonb,
	"resolved_at" timestamp with time zone,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"kind" text NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"fetched" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"message" text,
	"details" jsonb,
	"triggered_by_user_id" text
);
--> statement-breakpoint
ALTER TABLE "bp_proposals" ADD CONSTRAINT "bp_proposals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bp_proposals" ADD CONSTRAINT "bp_proposals_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bp_proposals" ADD CONSTRAINT "bp_proposals_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_links" ADD CONSTRAINT "external_links_linked_by_user_id_user_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_conflicts" ADD CONSTRAINT "mapping_conflicts_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_requests" ADD CONSTRAINT "outbound_requests_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_errors" ADD CONSTRAINT "sync_errors_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_triggered_by_user_id_user_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bp_proposals_opportunity_idx" ON "bp_proposals" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "bp_proposals_company_idx" ON "bp_proposals" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "bp_proposals_status_idx" ON "bp_proposals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "external_links_local_unique" ON "external_links" USING btree ("provider","entity_type","local_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_links_external_unique" ON "external_links" USING btree ("provider","entity_type","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_unique" ON "inbound_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "inbound_events_unprocessed_idx" ON "inbound_events" USING btree ("provider","processed_at");--> statement-breakpoint
CREATE INDEX "mapping_conflicts_open_idx" ON "mapping_conflicts" USING btree ("provider","status");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_requests_key_unique" ON "outbound_requests" USING btree ("provider","idempotency_key");--> statement-breakpoint
CREATE INDEX "sync_errors_run_idx" ON "sync_errors" USING btree ("sync_run_id");--> statement-breakpoint
CREATE INDEX "sync_runs_provider_started_idx" ON "sync_runs" USING btree ("provider","started_at");