ALTER TABLE "pax8_invoice_items" ADD COLUMN "cost" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "pax8_invoice_items" ADD COLUMN "cost_total" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "pax8_subscriptions" ADD COLUMN "partner_cost" numeric(12, 4);