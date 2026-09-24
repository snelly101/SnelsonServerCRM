CREATE TYPE "public"."kb_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TABLE "kb_article_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"summary" text,
	"edited_by_user_id" text,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"summary" text,
	"category" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"status" "kb_status" DEFAULT 'draft' NOT NULL,
	"customer_visible" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"published_at" timestamp with time zone,
	"review_due_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"note" text,
	"linked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_kb_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"kind" text DEFAULT 'linked' NOT NULL,
	"linked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_article_revisions" ADD CONSTRAINT "kb_article_revisions_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_revisions" ADD CONSTRAINT "kb_article_revisions_edited_by_user_id_user_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_assets" ADD CONSTRAINT "ticket_assets_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_assets" ADD CONSTRAINT "ticket_assets_device_id_ninja_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."ninja_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_assets" ADD CONSTRAINT "ticket_assets_linked_by_user_id_user_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_kb_links" ADD CONSTRAINT "ticket_kb_links_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_kb_links" ADD CONSTRAINT "ticket_kb_links_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_kb_links" ADD CONSTRAINT "ticket_kb_links_linked_by_user_id_user_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_revisions_unique" ON "kb_article_revisions" USING btree ("article_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_articles_slug_unique" ON "kb_articles" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "kb_articles_status_idx" ON "kb_articles" USING btree ("status","customer_visible");--> statement-breakpoint
CREATE INDEX "kb_articles_category_idx" ON "kb_articles" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_assets_unique" ON "ticket_assets" USING btree ("ticket_id","device_id");--> statement-breakpoint
CREATE INDEX "ticket_assets_device_idx" ON "ticket_assets" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_kb_links_unique" ON "ticket_kb_links" USING btree ("ticket_id","article_id");--> statement-breakpoint
CREATE INDEX "ticket_kb_links_article_idx" ON "ticket_kb_links" USING btree ("article_id");