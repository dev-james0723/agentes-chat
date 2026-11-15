CREATE TABLE "paperclip_routine_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"source_company_id" uuid NOT NULL,
	"source_routine_id" uuid NOT NULL,
	"source_revision_id" text,
	"config_hash" text NOT NULL,
	"native_config_hash" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"source_active" boolean NOT NULL,
	"source_archived" boolean DEFAULT false NOT NULL,
	"triggers" jsonb NOT NULL,
	"policy" text NOT NULL,
	"definition" jsonb NOT NULL,
	"routine_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paperclip_routine_mappings_orgId_sourceCompanyId_sourceRoutineId_unique" UNIQUE("org_id","source_company_id","source_routine_id")
);
--> statement-breakpoint
CREATE TABLE "paperclip_routine_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"mapping_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_trigger_id" uuid,
	"idempotency_scope_hash" text,
	"dispatch_fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"issue_id" uuid,
	"routine_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paperclip_routine_receipts_orgId_mappingId_idempotencyScopeHash_unique" UNIQUE("org_id","mapping_id","idempotency_scope_hash")
);
--> statement-breakpoint
ALTER TABLE "paperclip_routine_mappings" ADD CONSTRAINT "paperclip_routine_mappings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperclip_routine_mappings" ADD CONSTRAINT "paperclip_routine_mappings_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperclip_routine_mappings" ADD CONSTRAINT "paperclip_routine_mappings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperclip_routine_receipts" ADD CONSTRAINT "paperclip_routine_receipts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperclip_routine_receipts" ADD CONSTRAINT "paperclip_routine_receipts_mapping_id_paperclip_routine_mappings_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."paperclip_routine_mappings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperclip_routine_receipts" ADD CONSTRAINT "paperclip_routine_receipts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paperclip_routine_mappings_org_id_index" ON "paperclip_routine_mappings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "paperclip_routine_receipts_mapping_id_dispatch_fingerprint_index" ON "paperclip_routine_receipts" USING btree ("mapping_id","dispatch_fingerprint");--> statement-breakpoint
CREATE INDEX "paperclip_routine_receipts_routine_run_id_index" ON "paperclip_routine_receipts" USING btree ("routine_run_id");