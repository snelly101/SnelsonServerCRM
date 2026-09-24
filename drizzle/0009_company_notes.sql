CREATE TABLE "company_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_notes" ADD CONSTRAINT "company_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_notes" ADD CONSTRAINT "company_notes_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_notes" ADD CONSTRAINT "company_notes_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_notes_company_idx" ON "company_notes" USING btree ("company_id","pinned");--> statement-breakpoint
CREATE INDEX "company_notes_archived_idx" ON "company_notes" USING btree ("archived_at");--> statement-breakpoint
-- Carry the old free-text "Internal notes" field over as a pinned note so nothing is lost.
INSERT INTO "company_notes" ("company_id", "title", "body", "pinned", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at")
SELECT "id", 'Internal notes', "notes", true, "created_by_user_id", "created_by_user_id", "created_at", "updated_at"
FROM "companies" WHERE "notes" IS NOT NULL AND btrim("notes") <> '';--> statement-breakpoint
UPDATE "companies" SET "notes" = NULL WHERE "notes" IS NOT NULL;
