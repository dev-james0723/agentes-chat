CREATE TABLE "artifact_leases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_file_id" uuid NOT NULL,
	"holder_agent_id" uuid NOT NULL,
	"holder_run_id" uuid,
	"kind" text NOT NULL,
	"stage" text,
	"generation" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "artifact_leases_kind" CHECK ("artifact_leases"."kind" in ('write', 'read', 'future')),
	CONSTRAINT "artifact_leases_status" CHECK ("artifact_leases"."status" in ('open', 'released', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "artifact_transitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_file_id" uuid NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"version" integer NOT NULL,
	"actor" text NOT NULL,
	"code" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_transitions_runFileId_version_unique" UNIQUE("run_file_id","version")
);
--> statement-breakpoint
CREATE TABLE "storage_gc_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"mode_override" text,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_review_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_file_id" uuid NOT NULL,
	"code" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_review_items_runFileId_unique" UNIQUE("run_file_id"),
	CONSTRAINT "storage_review_items_status" CHECK ("storage_review_items"."status" in ('open', 'kept', 'protected', 'archive', 'delete', 'restored'))
);
--> statement-breakpoint
CREATE TABLE "storage_scopes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"root" text NOT NULL,
	"mode" text DEFAULT 'shadow' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_scopes_orgId_machineId_root_unique" UNIQUE("org_id","machine_id","root"),
	CONSTRAINT "storage_scopes_mode" CHECK ("storage_scopes"."mode" in ('shadow', 'enforce'))
);
--> statement-breakpoint
ALTER TABLE "file_cleanups" ALTER COLUMN "report_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "file_cleanups" ADD COLUMN "source" text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "file_cleanups" ADD COLUMN "shadow" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "run_files" ADD COLUMN "state" text DEFAULT 'created' NOT NULL;--> statement-breakpoint
ALTER TABLE "run_files" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_files" ADD COLUMN "sealed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_files" ADD COLUMN "reserved_token" text;--> statement-breakpoint
ALTER TABLE "run_files" ADD COLUMN "reserved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_files" ADD COLUMN "gc_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "artifact_leases" ADD CONSTRAINT "artifact_leases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_leases" ADD CONSTRAINT "artifact_leases_run_file_id_run_files_id_fk" FOREIGN KEY ("run_file_id") REFERENCES "public"."run_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_transitions" ADD CONSTRAINT "artifact_transitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_transitions" ADD CONSTRAINT "artifact_transitions_run_file_id_run_files_id_fk" FOREIGN KEY ("run_file_id") REFERENCES "public"."run_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_gc_settings" ADD CONSTRAINT "storage_gc_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_review_items" ADD CONSTRAINT "storage_review_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_review_items" ADD CONSTRAINT "storage_review_items_run_file_id_run_files_id_fk" FOREIGN KEY ("run_file_id") REFERENCES "public"."run_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_scopes" ADD CONSTRAINT "storage_scopes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_scopes" ADD CONSTRAINT "storage_scopes_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_leases_run_file_id_status_index" ON "artifact_leases" USING btree ("run_file_id","status");--> statement-breakpoint
CREATE INDEX "artifact_leases_org_id_status_expires_at_index" ON "artifact_leases" USING btree ("org_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "artifact_transitions_org_id_created_at_index" ON "artifact_transitions" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "storage_review_items_org_id_status_index" ON "storage_review_items" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "run_files_org_id_machine_id_state_index" ON "run_files" USING btree ("org_id","machine_id","state");--> statement-breakpoint
ALTER TABLE "file_cleanups" ADD CONSTRAINT "file_cleanups_source" CHECK ("file_cleanups"."source" in ('approved', 'auto', 'review')) NOT VALID;--> statement-breakpoint
ALTER TABLE "file_cleanups" VALIDATE CONSTRAINT "file_cleanups_source";--> statement-breakpoint
ALTER TABLE "run_files" ADD CONSTRAINT "run_files_state" CHECK ("run_files"."state" in ('created', 'writing', 'sealed', 'released', 'reserved', 'deleted', 'review', 'protected', 'kept', 'archived', 'relocated', 'failed', 'unknown')) NOT VALID;--> statement-breakpoint
ALTER TABLE "run_files" VALIDATE CONSTRAINT "run_files_state";