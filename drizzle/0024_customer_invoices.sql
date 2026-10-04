ALTER TABLE "contracts" ADD COLUMN "purchase_order_ref" text;--> statement-breakpoint
ALTER TABLE "invoice_drafts" ADD COLUMN "contract_ids" jsonb;--> statement-breakpoint
ALTER TABLE "invoice_drafts" ADD COLUMN "purchase_order_ref" text;