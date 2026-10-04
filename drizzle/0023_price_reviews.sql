ALTER TABLE "contracts" ADD COLUMN "price_locked_until_renewal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bp_proposals" ADD COLUMN "accepted_terms" jsonb;--> statement-breakpoint
ALTER TABLE "bp_proposals" ADD COLUMN "terms_changed_after_signature" boolean DEFAULT false NOT NULL;