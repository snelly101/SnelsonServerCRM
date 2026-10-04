CREATE TABLE "contract_line_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"contract_line_id" uuid,
	"line_description" text NOT NULL,
	"field" text NOT NULL,
	"previous_value" numeric(12, 2),
	"new_value" numeric(12, 2),
	"effective_from" date NOT NULL,
	"reason" text,
	"actor_user_id" text,
	"settled_by_draft_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contract_line_changes" ADD CONSTRAINT "contract_line_changes_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_line_changes" ADD CONSTRAINT "contract_line_changes_contract_line_id_contract_lines_id_fk" FOREIGN KEY ("contract_line_id") REFERENCES "public"."contract_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_line_changes" ADD CONSTRAINT "contract_line_changes_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_line_changes_line_idx" ON "contract_line_changes" USING btree ("contract_line_id","effective_from");--> statement-breakpoint
CREATE INDEX "contract_line_changes_contract_idx" ON "contract_line_changes" USING btree ("contract_id","effective_from");--> statement-breakpoint
-- Carry the single pending quantity change each line could hold into the dated history, so nothing waiting to be invoiced is lost.
INSERT INTO "contract_line_changes" ("contract_id", "contract_line_id", "line_description", "field", "previous_value", "new_value", "effective_from", "reason")
SELECT "contract_id", "id", "description", 'quantity', "previous_quantity", "quantity", "quantity_changed_on", 'migrated from the pending quantity change'
FROM "contract_lines"
WHERE "quantity_changed_on" IS NOT NULL;
