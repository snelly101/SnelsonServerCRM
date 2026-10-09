ALTER TABLE "portal_accounts" ADD COLUMN "totp_secret_enc" text;--> statement-breakpoint
ALTER TABLE "portal_accounts" ADD COLUMN "totp_enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portal_accounts" ADD COLUMN "recovery_codes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "portal_sessions" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portal_sessions" ADD COLUMN "failed_attempts" integer DEFAULT 0 NOT NULL;