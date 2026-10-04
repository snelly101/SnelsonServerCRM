CREATE TABLE "service_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_row_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"state" text NOT NULL,
	"contract_line_id" uuid,
	"reason" text,
	"review_on" date,
	"set_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_coverage" ADD CONSTRAINT "service_coverage_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_coverage" ADD CONSTRAINT "service_coverage_contract_line_id_contract_lines_id_fk" FOREIGN KEY ("contract_line_id") REFERENCES "public"."contract_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_coverage" ADD CONSTRAINT "service_coverage_set_by_user_id_user_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_coverage_source_unique" ON "service_coverage" USING btree ("source","source_row_id");--> statement-breakpoint
CREATE INDEX "service_coverage_company_idx" ON "service_coverage" USING btree ("company_id","state");--> statement-breakpoint
CREATE INDEX "service_coverage_review_idx" ON "service_coverage" USING btree ("review_on");