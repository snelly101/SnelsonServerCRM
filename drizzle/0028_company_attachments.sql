CREATE TABLE "company_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid,
	"file_name" text NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"sha256" text NOT NULL,
	"storage_path" text NOT NULL,
	"thumbnail_path" text,
	"width" integer,
	"height" integer,
	"caption" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"scan_status" "attachment_scan_status" DEFAULT 'pending' NOT NULL,
	"scan_detail" text,
	"uploaded_by_user_id" text,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_attachments" ADD CONSTRAINT "company_attachments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_attachments" ADD CONSTRAINT "company_attachments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_attachments" ADD CONSTRAINT "company_attachments_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_attachments" ADD CONSTRAINT "company_attachments_deleted_by_user_id_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_attachments_company_idx" ON "company_attachments" USING btree ("company_id","deleted_at");--> statement-breakpoint
CREATE INDEX "company_attachments_site_idx" ON "company_attachments" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "company_attachments_deleted_idx" ON "company_attachments" USING btree ("deleted_at");