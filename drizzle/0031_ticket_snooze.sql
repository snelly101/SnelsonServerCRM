ALTER TABLE "tickets" ADD COLUMN "snoozed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "snooze_reason" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "snoozed_by_user_id" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_snoozed_by_user_id_user_id_fk" FOREIGN KEY ("snoozed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;