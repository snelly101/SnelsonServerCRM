ALTER TABLE "app_settings" ADD COLUMN "billing_automation_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "billing_automation_day" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "billing_automation_consolidate" boolean DEFAULT true NOT NULL;