ALTER TABLE "billing_discrepancies" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "billing_discrepancies" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "billing_discrepancies" ADD COLUMN "review_on" date;--> statement-breakpoint
ALTER TABLE "billing_discrepancies" ADD COLUMN "applied_change_id" uuid;--> statement-breakpoint
ALTER TABLE "billing_discrepancies" ADD CONSTRAINT "billing_discrepancies_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;