ALTER TABLE "contract_lines" ADD COLUMN "previous_quantity" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "contract_lines" ADD COLUMN "quantity_changed_on" date;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "billing_day" integer;