ALTER TABLE "app_settings" ADD COLUMN "renewal_lead_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "renewal_decision" text;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "renewal_decision_for" date;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "renewal_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "renewal_decided_by_user_id" text;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "renewal_decision_note" text;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_renewal_decided_by_user_id_user_id_fk" FOREIGN KEY ("renewal_decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;