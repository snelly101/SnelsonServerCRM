CREATE TYPE "public"."inbound_queue_status" AS ENUM('pending', 'processing', 'done', 'failed', 'dead', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."mailbox_status" AS ENUM('not_configured', 'connected', 'error', 'expired', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('queued', 'submitting', 'accepted', 'failed', 'unknown', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'm365';--> statement-breakpoint
CREATE TABLE "helpdesk_mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"display_name" text,
	"tenant_id" text,
	"auth_mode" text DEFAULT 'secret' NOT NULL,
	"credentials_enc" text,
	"credential_expires_at" timestamp with time zone,
	"status" "mailbox_status" DEFAULT 'not_configured' NOT NULL,
	"last_error" text,
	"last_tested_at" timestamp with time zone,
	"folders" jsonb DEFAULT '[{"id":"inbox","name":"Inbox"}]'::jsonb NOT NULL,
	"import_from" timestamp with time zone,
	"delta_links" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subscription_id" text,
	"subscription_expires_at" timestamp with time zone,
	"subscription_client_state" text,
	"subscription_error" text,
	"last_notification_at" timestamp with time zone,
	"last_inbound_sync_at" timestamp with time zone,
	"last_outbound_accepted_at" timestamp with time zone,
	"ack_enabled" boolean DEFAULT true NOT NULL,
	"ack_subject" text DEFAULT '[{{reference}}] We have received your request: {{subject}}' NOT NULL,
	"ack_body" text DEFAULT 'Hello {{requester}},

Thanks for getting in touch. We have logged your request as **{{reference}}** and someone will be in touch shortly.

Please keep the reference in the subject line when you reply.

{{signature}}' NOT NULL,
	"unknown_sender_policy" text DEFAULT 'create_unverified' NOT NULL,
	"closed_reply_policy" text DEFAULT 'reopen' NOT NULL,
	"closed_reopen_days" integer DEFAULT 14 NOT NULL,
	"signature" text DEFAULT 'Kind regards,
The support team' NOT NULL,
	"is_default" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"connected_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_inbound_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"external_message_id" text NOT NULL,
	"source" text DEFAULT 'notification' NOT NULL,
	"status" "inbound_queue_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"outcome" jsonb,
	"ticket_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mailbox_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"ticket_id" uuid,
	"message_id" uuid,
	"to_summary" text,
	"idempotency_key" text NOT NULL,
	"kind" text DEFAULT 'reply' NOT NULL,
	"status" "outbox_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"provider_message_id" text,
	"internet_message_id" text,
	"reply_to_external_id" text,
	"reply_all" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "ack_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "mailbox_id" uuid;--> statement-breakpoint
ALTER TABLE "helpdesk_mailboxes" ADD CONSTRAINT "helpdesk_mailboxes_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_inbound_queue" ADD CONSTRAINT "mailbox_inbound_queue_mailbox_id_helpdesk_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."helpdesk_mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_inbound_queue" ADD CONSTRAINT "mailbox_inbound_queue_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_outbox" ADD CONSTRAINT "mailbox_outbox_mailbox_id_helpdesk_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."helpdesk_mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_outbox" ADD CONSTRAINT "mailbox_outbox_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_outbox" ADD CONSTRAINT "mailbox_outbox_message_id_ticket_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ticket_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_outbox" ADD CONSTRAINT "mailbox_outbox_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "helpdesk_mailboxes_address_unique" ON "helpdesk_mailboxes" USING btree ("address");--> statement-breakpoint
CREATE INDEX "helpdesk_mailboxes_subscription_idx" ON "helpdesk_mailboxes" USING btree ("subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_inbound_unique" ON "mailbox_inbound_queue" USING btree ("mailbox_id","external_message_id");--> statement-breakpoint
CREATE INDEX "mailbox_inbound_status_idx" ON "mailbox_inbound_queue" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_outbox_key_unique" ON "mailbox_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "mailbox_outbox_status_idx" ON "mailbox_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "mailbox_outbox_ticket_idx" ON "mailbox_outbox" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "mailbox_outbox_provider_idx" ON "mailbox_outbox" USING btree ("provider_message_id");