ALTER TABLE "bp_proposals" ADD COLUMN "quote_raw" jsonb;--> statement-breakpoint
ALTER TABLE "bp_proposals" ADD COLUMN "quote_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bp_proposals" ADD COLUMN "line_items" jsonb;