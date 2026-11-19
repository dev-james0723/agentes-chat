CREATE TABLE "file_cleanups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"run_file_id" uuid,
	"agent_id" uuid NOT NULL,
	"machine_id" uuid,
	"path" text NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"reason" text,
	"identity" jsonb,
	"bytes" bigint,
	"free_before" bigint,
	"free_after" bigint,
	"approved_by_user_id" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone,
	CONSTRAINT "file_cleanups_reportId_path_agentId_unique" UNIQUE("report_id","path","agent_id"),
	CONSTRAINT "file_cleanups_status" CHECK ("file_cleanups"."status" in ('approved', 'done', 'skipped', 'blocked', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "run_files" ADD COLUMN "machine_id" uuid;--> statement-breakpoint
ALTER TABLE "file_cleanups" ADD CONSTRAINT "file_cleanups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_cleanups" ADD CONSTRAINT "file_cleanups_report_id_retention_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."retention_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_cleanups" ADD CONSTRAINT "file_cleanups_run_file_id_run_files_id_fk" FOREIGN KEY ("run_file_id") REFERENCES "public"."run_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_cleanups_org_id_status_index" ON "file_cleanups" USING btree ("org_id","status");--> statement-breakpoint
ALTER TABLE "run_files" ADD CONSTRAINT "run_files_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;