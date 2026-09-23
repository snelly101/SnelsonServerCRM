CREATE TYPE "public"."vault_grant_scope" AS ENUM('all', 'company');--> statement-breakpoint
CREATE TABLE "vault_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text,
	"actor_name" text,
	"company_id" uuid,
	"item_id" uuid,
	"item_name" text,
	"action" text NOT NULL,
	"field" text,
	"ip_address" text,
	"user_agent" text,
	"session_id" text,
	"details" jsonb,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"icon" text DEFAULT 'key' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"scope" "vault_grant_scope" DEFAULT 'all' NOT NULL,
	"company_id" uuid,
	"can_list" boolean DEFAULT true NOT NULL,
	"can_view_username" boolean DEFAULT true NOT NULL,
	"can_reveal" boolean DEFAULT false NOT NULL,
	"can_copy" boolean DEFAULT false NOT NULL,
	"can_create" boolean DEFAULT false NOT NULL,
	"can_edit" boolean DEFAULT false NOT NULL,
	"can_delete" boolean DEFAULT false NOT NULL,
	"can_audit" boolean DEFAULT false NOT NULL,
	"granted_by_user_id" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid,
	"category_id" text NOT NULL,
	"name" text NOT NULL,
	"username" text,
	"url" text,
	"reference" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"is_favourite" boolean DEFAULT false NOT NULL,
	"review_at" date,
	"expires_at" date,
	"key_version" integer NOT NULL,
	"wrapped_dek" text NOT NULL,
	"ciphertext" text NOT NULL,
	"cipher_version" integer DEFAULT 1 NOT NULL,
	"secret_kinds" text[] DEFAULT '{}' NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"last_revealed_at" timestamp with time zone,
	"reveal_count" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_keys" (
	"key_version" integer PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vault_step_ups" (
	"user_id" text PRIMARY KEY NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"last_failed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "vault_reveal_seconds" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "vault_clipboard_seconds" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "vault_step_up_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "vault_review_reminder_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "vault_reveal_limit" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_grants" ADD CONSTRAINT "vault_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_grants" ADD CONSTRAINT "vault_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_grants" ADD CONSTRAINT "vault_grants_granted_by_user_id_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_category_id_vault_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."vault_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_key_version_vault_keys_key_version_fk" FOREIGN KEY ("key_version") REFERENCES "public"."vault_keys"("key_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_step_ups" ADD CONSTRAINT "vault_step_ups_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vault_audit_item_idx" ON "vault_audit" USING btree ("item_id","at");--> statement-breakpoint
CREATE INDEX "vault_audit_company_idx" ON "vault_audit" USING btree ("company_id","at");--> statement-breakpoint
CREATE INDEX "vault_audit_actor_idx" ON "vault_audit" USING btree ("actor_user_id","at");--> statement-breakpoint
CREATE INDEX "vault_audit_at_idx" ON "vault_audit" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_categories_name_unique" ON "vault_categories" USING btree ("name");--> statement-breakpoint
CREATE INDEX "vault_grants_user_idx" ON "vault_grants" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "vault_items_company_idx" ON "vault_items" USING btree ("company_id","archived_at");--> statement-breakpoint
CREATE INDEX "vault_items_category_idx" ON "vault_items" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "vault_items_review_idx" ON "vault_items" USING btree ("review_at");--> statement-breakpoint
CREATE INDEX "vault_items_expires_idx" ON "vault_items" USING btree ("expires_at");--> statement-breakpoint
-- Append-only audit trail: no row may be updated or deleted, whoever connects.
CREATE OR REPLACE FUNCTION vault_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'vault_audit is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER vault_audit_no_update BEFORE UPDATE ON "vault_audit" FOR EACH ROW EXECUTE FUNCTION vault_audit_immutable();
--> statement-breakpoint
CREATE TRIGGER vault_audit_no_delete BEFORE DELETE ON "vault_audit" FOR EACH ROW EXECUTE FUNCTION vault_audit_immutable();
--> statement-breakpoint
CREATE TRIGGER vault_audit_no_truncate BEFORE TRUNCATE ON "vault_audit" FOR EACH STATEMENT EXECUTE FUNCTION vault_audit_immutable();
--> statement-breakpoint
INSERT INTO "vault_categories" ("id", "name", "icon", "sort_order", "is_system") VALUES
  ('microsoft_365', 'Microsoft 365', 'cloud', 10, true),
  ('domain_dns', 'Domain / DNS', 'globe', 20, true),
  ('firewall', 'Firewall', 'shield', 30, true),
  ('router', 'Router', 'router', 40, true),
  ('wifi', 'Wi-Fi', 'wifi', 50, true),
  ('server', 'Server', 'server', 60, true),
  ('backup', 'Backup', 'database', 70, true),
  ('voip', 'VoIP / Telecoms', 'phone', 80, true),
  ('website_hosting', 'Website / Hosting', 'layout', 90, true),
  ('vendor_portal', 'Vendor Portal', 'store', 100, true),
  ('api_integration', 'API / Integration', 'plug', 110, true),
  ('other', 'Other', 'key', 999, true)
ON CONFLICT DO NOTHING;
