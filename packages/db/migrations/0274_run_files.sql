CREATE TABLE "retention_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_reports_orgId_subjectType_subjectId_unique" UNIQUE("org_id","subject_type","subject_id"),
	CONSTRAINT "retention_reports_subject" CHECK ("retention_reports"."subject_type" in ('issue', 'mission')),
	CONSTRAINT "retention_reports_outcome" CHECK ("retention_reports"."outcome" in ('done', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "run_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"role" text NOT NULL,
	"size" bigint,
	"sha256" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_files_runId_path_unique" UNIQUE("run_id","path"),
	CONSTRAINT "run_files_kind" CHECK ("run_files"."kind" in ('image', 'video', 'html', 'markdown', 'log', 'build', 'other')),
	CONSTRAINT "run_files_role" CHECK ("run_files"."role" in ('canonical', 'evidence', 'scratch', 'derived', 'unknown')),
	CONSTRAINT "run_files_sha256" CHECK ("run_files"."sha256" is null or "run_files"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "retention_reports" ADD CONSTRAINT "retention_reports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_files" ADD CONSTRAINT "run_files_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_files" ADD CONSTRAINT "run_files_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_files" ADD CONSTRAINT "run_files_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_files_org_id_agent_id_index" ON "run_files" USING btree ("org_id","agent_id");