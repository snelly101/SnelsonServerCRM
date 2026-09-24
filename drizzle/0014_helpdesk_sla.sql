CREATE TYPE "public"."automation_trigger" AS ENUM('ticket_created', 'ticket_updated', 'customer_replied', 'agent_replied', 'status_changed', 'sla_breached', 'sla_due_soon', 'schedule');--> statement-breakpoint
CREATE TYPE "public"."sla_event_kind" AS ENUM('start', 'pause', 'resume', 'met', 'breach', 'reset', 'policy_changed');--> statement-breakpoint
CREATE TYPE "public"."sla_target_kind" AS ENUM('first_response', 'resolution');--> statement-breakpoint
CREATE TABLE "helpdesk_automation_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger" "automation_trigger" NOT NULL,
	"match" text DEFAULT 'all' NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"stop_processing" boolean DEFAULT false NOT NULL,
	"cooldown_minutes" integer DEFAULT 60 NOT NULL,
	"after_minutes" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helpdesk_automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"trigger" "automation_trigger" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"matched" boolean NOT NULL,
	"actions_applied" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "helpdesk_business_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Europe/London' NOT NULL,
	"schedule" jsonb NOT NULL,
	"holidays" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"always" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "helpdesk_business_hours_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "helpdesk_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"ticket_id" uuid,
	"message_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"actor_user_id" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helpdesk_sla_assignments" (
	"company_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	CONSTRAINT "helpdesk_sla_assignments_company_id_pk" PRIMARY KEY("company_id")
);
--> statement-breakpoint
CREATE TABLE "helpdesk_sla_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"business_hours_id" uuid,
	"first_response_minutes" jsonb DEFAULT '{"low":480,"normal":240,"high":60,"critical":30}'::jsonb NOT NULL,
	"resolution_minutes" jsonb DEFAULT '{"low":4800,"normal":2400,"high":480,"critical":240}'::jsonb NOT NULL,
	"pause_statuses" text[] DEFAULT '{"awaiting_customer"}' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "helpdesk_sla_policies_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "helpdesk_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"scope" text DEFAULT 'public' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"category" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "helpdesk_templates_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "ticket_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"title" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"done_by_user_id" text,
	"done_at" timestamp with time zone,
	"assignee_user_id" text,
	"due_date" date,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_sla_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"target" "sla_target_kind" NOT NULL,
	"kind" "sla_event_kind" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"elapsed_minutes" integer,
	"policy_id" uuid,
	"reason" text
);
--> statement-breakpoint
ALTER TABLE "helpdesk_automation_rules" ADD CONSTRAINT "helpdesk_automation_rules_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_automation_runs" ADD CONSTRAINT "helpdesk_automation_runs_rule_id_helpdesk_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."helpdesk_automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_automation_runs" ADD CONSTRAINT "helpdesk_automation_runs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_notifications" ADD CONSTRAINT "helpdesk_notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_notifications" ADD CONSTRAINT "helpdesk_notifications_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_notifications" ADD CONSTRAINT "helpdesk_notifications_message_id_ticket_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ticket_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_notifications" ADD CONSTRAINT "helpdesk_notifications_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_sla_assignments" ADD CONSTRAINT "helpdesk_sla_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_sla_assignments" ADD CONSTRAINT "helpdesk_sla_assignments_policy_id_helpdesk_sla_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."helpdesk_sla_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_sla_policies" ADD CONSTRAINT "helpdesk_sla_policies_business_hours_id_helpdesk_business_hours_id_fk" FOREIGN KEY ("business_hours_id") REFERENCES "public"."helpdesk_business_hours"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_templates" ADD CONSTRAINT "helpdesk_templates_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_checklist_items" ADD CONSTRAINT "ticket_checklist_items_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_checklist_items" ADD CONSTRAINT "ticket_checklist_items_done_by_user_id_user_id_fk" FOREIGN KEY ("done_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_checklist_items" ADD CONSTRAINT "ticket_checklist_items_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_checklist_items" ADD CONSTRAINT "ticket_checklist_items_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_sla_events" ADD CONSTRAINT "ticket_sla_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "helpdesk_rules_trigger_idx" ON "helpdesk_automation_rules" USING btree ("trigger","active","sort_order");--> statement-breakpoint
CREATE INDEX "helpdesk_runs_rule_idx" ON "helpdesk_automation_runs" USING btree ("rule_id","ticket_id","at");--> statement-breakpoint
CREATE INDEX "helpdesk_runs_ticket_idx" ON "helpdesk_automation_runs" USING btree ("ticket_id","at");--> statement-breakpoint
CREATE INDEX "helpdesk_notifications_user_idx" ON "helpdesk_notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "ticket_checklist_ticket_idx" ON "ticket_checklist_items" USING btree ("ticket_id","sort_order");--> statement-breakpoint
CREATE INDEX "ticket_sla_events_ticket_idx" ON "ticket_sla_events" USING btree ("ticket_id","target","at");