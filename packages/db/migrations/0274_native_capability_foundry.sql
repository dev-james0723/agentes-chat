CREATE TABLE "foundry_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"person_id" text NOT NULL,
	"approval_id" uuid NOT NULL,
	"approval_hash" text NOT NULL,
	"previous_binding_id" uuid,
	"state" text DEFAULT 'CANARY' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"max_calls" integer NOT NULL,
	"reserved_calls" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "foundry_bindings_orgId_approvalId_unique" UNIQUE("org_id","approval_id")
);
--> statement-breakpoint
CREATE TABLE "foundry_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"person_id" text NOT NULL,
	"origin_run_id" uuid NOT NULL,
	"need_key" text NOT NULL,
	"need_fingerprint" text NOT NULL,
	"context_revision" text NOT NULL,
	"state" text DEFAULT 'DRAFT' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"reason_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "foundry_candidates_orgId_taskId_needFingerprint_contextRevision_unique" UNIQUE("org_id","task_id","need_fingerprint","context_revision")
);
--> statement-breakpoint
CREATE TABLE "foundry_invocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_use_id" text NOT NULL,
	"digest" text NOT NULL,
	"input_digest" text NOT NULL,
	"state" text DEFAULT 'RESERVED' NOT NULL,
	"fencing_token" integer NOT NULL,
	"binding_generation" integer NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"result_digest" text,
	"reason_code" text,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "foundry_invocations_orgId_runId_toolUseId_unique" UNIQUE("org_id","run_id","tool_use_id")
);
--> statement-breakpoint
CREATE TABLE "foundry_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"contract_digest" text NOT NULL,
	"effects_digest" text NOT NULL,
	"storage_config_id" uuid,
	"blob_key" text NOT NULL,
	"blob_bytes" integer NOT NULL,
	"state" text DEFAULT 'DRAFT' NOT NULL,
	"evaluation_ref" text,
	"runtime_digest" text,
	"profile_digest" text,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "foundry_versions_orgId_candidateId_digest_unique" UNIQUE("org_id","candidate_id","digest")
);
--> statement-breakpoint
ALTER TABLE "foundry_bindings" ADD CONSTRAINT "foundry_bindings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foundry_bindings" ADD CONSTRAINT "foundry_bindings_candidate_id_foundry_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."foundry_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foundry_bindings" ADD CONSTRAINT "foundry_bindings_version_id_foundry_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."foundry_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foundry_bindings" ADD CONSTRAINT "foundry_bindings_task_id_issues_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foundry_bindings" ADD CONSTRAINT "foundry_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foundry_bindings" ADD CONSTRAINT "foundry_bindings_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foundry_candidates" ADD CONSTRAINT "foundry_candidates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foundry_candidates" ADD CONSTRAINT "foundry_candidates_task_id_issues_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foundry_candidates" ADD CONSTRAINT "foundry_candidates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foundry_invocations" ADD CONSTRAINT "foundry_invocations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foundry_invocations" ADD CONSTRAINT "foundry_invocations_binding_id_foundry_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."foundry_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foundry_versions" ADD CONSTRAINT "foundry_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foundry_versions" ADD CONSTRAINT "foundry_versions_candidate_id_foundry_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."foundry_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foundry_versions" ADD CONSTRAINT "foundry_versions_storage_config_id_storage_configs_id_fk" FOREIGN KEY ("storage_config_id") REFERENCES "public"."storage_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "foundry_bindings_current" ON "foundry_bindings" USING btree ("org_id","candidate_id","task_id","agent_id") WHERE "foundry_bindings"."state" in ('CANARY', 'ACTIVE');--> statement-breakpoint
CREATE INDEX "foundry_bindings_org_id_task_id_agent_id_index" ON "foundry_bindings" USING btree ("org_id","task_id","agent_id");--> statement-breakpoint
CREATE INDEX "foundry_candidates_org_id_task_id_index" ON "foundry_candidates" USING btree ("org_id","task_id");--> statement-breakpoint
CREATE INDEX "foundry_invocations_org_id_binding_id_state_index" ON "foundry_invocations" USING btree ("org_id","binding_id","state");--> statement-breakpoint
CREATE INDEX "foundry_versions_org_id_candidate_id_index" ON "foundry_versions" USING btree ("org_id","candidate_id");