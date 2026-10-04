ALTER TABLE "contract_lines" ADD COLUMN "invoice_schedule" text DEFAULT 'contract' NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_lines" ADD COLUMN "reduction_policy" text DEFAULT 'next_period' NOT NULL;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "billing_from" date;