CREATE TABLE "service_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_row_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_line_id" uuid,
	"role" text NOT NULL,
	"match_source" text,
	"quantity" numeric(12, 2),
	"monthly_cost" numeric(12, 4),
	"last_seen_at" timestamp with time zone,
	"reason" text,
	"review_on" date,
	"set_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_links" ADD CONSTRAINT "service_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_links" ADD CONSTRAINT "service_links_contract_line_id_contract_lines_id_fk" FOREIGN KEY ("contract_line_id") REFERENCES "public"."contract_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_links" ADD CONSTRAINT "service_links_set_by_user_id_user_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_links_source_unique" ON "service_links" USING btree ("source","source_row_id");--> statement-breakpoint
CREATE INDEX "service_links_company_idx" ON "service_links" USING btree ("company_id","role");--> statement-breakpoint
CREATE INDEX "service_links_line_idx" ON "service_links" USING btree ("contract_line_id");--> statement-breakpoint
CREATE INDEX "service_links_review_idx" ON "service_links" USING btree ("review_on");--> statement-breakpoint
-- Data: the billing lines chosen on the Subscriptions and Hosting tabs become charged links (chosen by a person).
INSERT INTO "service_links" ("source", "source_row_id", "company_id", "contract_line_id", "role", "match_source", "quantity", "last_seen_at")
SELECT 'pax8_subscription', ps.id, ps.company_id, ps.contract_line_id, 'charged', 'manual', ps.quantity, ps.fetched_at
FROM "pax8_subscriptions" ps
WHERE ps.contract_line_id IS NOT NULL AND ps.company_id IS NOT NULL;--> statement-breakpoint
INSERT INTO "service_links" ("source", "source_row_id", "company_id", "contract_line_id", "role", "match_source", "quantity", "last_seen_at")
SELECT 'hosting_item', hi.id, hi.company_id, hi.contract_line_id, 'charged', 'manual', 1, hi.fetched_at
FROM "hosting_items" hi
WHERE hi.contract_line_id IS NOT NULL AND hi.company_id IS NOT NULL;--> statement-breakpoint
-- Data: explicit coverage decisions (bundle, commitment, free, internal, investigate) win over a billing line, as they did on screen.
INSERT INTO "service_links" ("source", "source_row_id", "company_id", "contract_line_id", "role", "match_source", "reason", "review_on", "set_by_user_id", "created_at", "updated_at")
SELECT sc.source, sc.source_row_id, sc.company_id, sc.contract_line_id, sc.state, 'manual', sc.reason, sc.review_on, sc.set_by_user_id, sc.created_at, sc.updated_at
FROM "service_coverage" sc
ON CONFLICT ("source", "source_row_id") DO UPDATE SET
  "contract_line_id" = EXCLUDED."contract_line_id", "role" = EXCLUDED."role", "reason" = EXCLUDED."reason", "review_on" = EXCLUDED."review_on", "set_by_user_id" = EXCLUDED."set_by_user_id", "updated_at" = EXCLUDED."updated_at";--> statement-breakpoint
DROP TABLE "service_coverage" CASCADE;--> statement-breakpoint
ALTER TABLE "contract_lines" ADD COLUMN "quantity_rule" text DEFAULT 'fixed' NOT NULL;
