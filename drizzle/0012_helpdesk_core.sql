CREATE TYPE "public"."attachment_scan_status" AS ENUM('pending', 'clean', 'blocked', 'skipped', 'error');--> statement-breakpoint
CREATE TYPE "public"."message_delivery_status" AS ENUM('not_applicable', 'draft', 'queued', 'submitting', 'accepted', 'failed', 'unknown', 'bounced');--> statement-breakpoint
CREATE TYPE "public"."ticket_link_kind" AS ENUM('related', 'parent', 'duplicate', 'merged_from', 'split_from');--> statement-breakpoint
CREATE TYPE "public"."ticket_message_channel" AS ENUM('email', 'manual', 'note', 'system');--> statement-breakpoint
CREATE TYPE "public"."ticket_message_direction" AS ENUM('inbound', 'outbound', 'internal');--> statement-breakpoint
CREATE TYPE "public"."ticket_message_kind" AS ENUM('public', 'internal');--> statement-breakpoint
CREATE TYPE "public"."ticket_participant_role" AS ENUM('requester', 'cc', 'follower');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('low', 'normal', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."ticket_source" AS ENUM('email', 'manual', 'portal');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('new', 'open', 'in_progress', 'awaiting_customer', 'awaiting_third_party', 'resolved', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ticket_type" AS ENUM('incident', 'service_request', 'problem', 'change');--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'ticket';--> statement-breakpoint
ALTER TYPE "public"."custom_field_entity" ADD VALUE 'ticket';--> statement-breakpoint
CREATE TABLE "helpdesk_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helpdesk_team_members" (
	"team_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"is_lead" boolean DEFAULT false NOT NULL,
	CONSTRAINT "helpdesk_team_members_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "helpdesk_teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "helpdesk_teams_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "ticket_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"message_id" uuid,
	"file_name" text NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"sha256" text,
	"storage_path" text,
	"inline" boolean DEFAULT false NOT NULL,
	"content_id" text,
	"scan_status" "attachment_scan_status" DEFAULT 'pending' NOT NULL,
	"scan_detail" text,
	"restricted" boolean DEFAULT false NOT NULL,
	"uploaded_by_user_id" text,
	"external_attachment_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_drafts" (
	"ticket_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" "ticket_message_kind" DEFAULT 'public' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"recipients" jsonb,
	"ticket_version" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_drafts_ticket_id_user_id_pk" PRIMARY KEY("ticket_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"actor_user_id" text,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "ticket_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"related_ticket_id" uuid NOT NULL,
	"kind" "ticket_link_kind" DEFAULT 'related' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"kind" "ticket_message_kind" NOT NULL,
	"channel" "ticket_message_channel" NOT NULL,
	"direction" "ticket_message_direction" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"author_user_id" text,
	"from_name" text,
	"from_email" text,
	"to_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text,
	"body_text" text DEFAULT '' NOT NULL,
	"body_html" text,
	"body_markdown" text,
	"quoted_text" text,
	"is_automated" boolean DEFAULT false NOT NULL,
	"automated_reason" text,
	"mailbox_id" uuid,
	"external_message_id" text,
	"internet_message_id" text,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"conversation_id" text,
	"delivery_status" "message_delivery_status" DEFAULT 'not_applicable' NOT NULL,
	"delivery_detail" text,
	"reply_to_message_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"role" "ticket_participant_role" NOT NULL,
	"name" text,
	"email" text,
	"normalized_email" text,
	"contact_id" uuid,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"minutes" integer NOT NULL,
	"note" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"billable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_timers" (
	"ticket_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_timers_ticket_id_user_id_pk" PRIMARY KEY("ticket_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "tickets_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"subject" text NOT NULL,
	"description" text,
	"status" "ticket_status" DEFAULT 'new' NOT NULL,
	"priority" "ticket_priority" DEFAULT 'normal' NOT NULL,
	"type" "ticket_type" DEFAULT 'incident' NOT NULL,
	"source" "ticket_source" DEFAULT 'manual' NOT NULL,
	"category_id" uuid,
	"subcategory_id" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"requester_name" text,
	"requester_email" text,
	"requester_normalized_email" text,
	"requester_contact_id" uuid,
	"requester_unverified" boolean DEFAULT false NOT NULL,
	"company_id" uuid,
	"assignee_user_id" text,
	"team_id" uuid,
	"needs_review" boolean DEFAULT false NOT NULL,
	"review_reason" text,
	"first_response_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"last_customer_message_at" timestamp with time zone,
	"last_agent_message_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"sla_policy_id" uuid,
	"first_response_due_at" timestamp with time zone,
	"resolution_due_at" timestamp with time zone,
	"first_response_breached" boolean DEFAULT false NOT NULL,
	"resolution_breached" boolean DEFAULT false NOT NULL,
	"resolution_summary" text,
	"resolution_category" text,
	"merged_into_ticket_id" uuid,
	"parent_ticket_id" uuid,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"time_spent_minutes" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "helpdesk_team_members" ADD CONSTRAINT "helpdesk_team_members_team_id_helpdesk_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."helpdesk_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_team_members" ADD CONSTRAINT "helpdesk_team_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_message_id_ticket_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ticket_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_drafts" ADD CONSTRAINT "ticket_drafts_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_drafts" ADD CONSTRAINT "ticket_drafts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_related_ticket_id_tickets_id_fk" FOREIGN KEY ("related_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_participants" ADD CONSTRAINT "ticket_participants_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_participants" ADD CONSTRAINT "ticket_participants_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_participants" ADD CONSTRAINT "ticket_participants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_time_entries" ADD CONSTRAINT "ticket_time_entries_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_time_entries" ADD CONSTRAINT "ticket_time_entries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_timers" ADD CONSTRAINT "ticket_timers_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_timers" ADD CONSTRAINT "ticket_timers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_category_id_helpdesk_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."helpdesk_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_subcategory_id_helpdesk_categories_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."helpdesk_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requester_contact_id_contacts_id_fk" FOREIGN KEY ("requester_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_team_id_helpdesk_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."helpdesk_teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "helpdesk_categories_parent_idx" ON "helpdesk_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "ticket_attachments_ticket_idx" ON "ticket_attachments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_attachments_message_idx" ON "ticket_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_idx" ON "ticket_events" USING btree ("ticket_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_links_unique" ON "ticket_links" USING btree ("ticket_id","related_ticket_id","kind");--> statement-breakpoint
CREATE INDEX "ticket_links_related_idx" ON "ticket_links" USING btree ("related_ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_messages_ticket_idx" ON "ticket_messages" USING btree ("ticket_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_messages_external_unique" ON "ticket_messages" USING btree ("mailbox_id","external_message_id");--> statement-breakpoint
CREATE INDEX "ticket_messages_internet_id_idx" ON "ticket_messages" USING btree ("mailbox_id","internet_message_id");--> statement-breakpoint
CREATE INDEX "ticket_messages_conversation_idx" ON "ticket_messages" USING btree ("mailbox_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_participants_email_unique" ON "ticket_participants" USING btree ("ticket_id","normalized_email");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_participants_user_unique" ON "ticket_participants" USING btree ("ticket_id","user_id");--> statement-breakpoint
CREATE INDEX "ticket_participants_ticket_idx" ON "ticket_participants" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_time_entries_ticket_idx" ON "ticket_time_entries" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_time_entries_user_idx" ON "ticket_time_entries" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_number_unique" ON "tickets" USING btree ("number");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("status","priority");--> statement-breakpoint
CREATE INDEX "tickets_assignee_idx" ON "tickets" USING btree ("assignee_user_id","status");--> statement-breakpoint
CREATE INDEX "tickets_team_idx" ON "tickets" USING btree ("team_id","status");--> statement-breakpoint
CREATE INDEX "tickets_company_idx" ON "tickets" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tickets_contact_idx" ON "tickets" USING btree ("requester_contact_id");--> statement-breakpoint
CREATE INDEX "tickets_requester_email_idx" ON "tickets" USING btree ("requester_normalized_email");--> statement-breakpoint
CREATE INDEX "tickets_last_activity_idx" ON "tickets" USING btree ("last_activity_at");--> statement-breakpoint
CREATE INDEX "tickets_due_idx" ON "tickets" USING btree ("first_response_due_at","resolution_due_at");--> statement-breakpoint
CREATE INDEX "tickets_merged_idx" ON "tickets" USING btree ("merged_into_ticket_id");--> statement-breakpoint
CREATE INDEX "tickets_parent_idx" ON "tickets" USING btree ("parent_ticket_id");