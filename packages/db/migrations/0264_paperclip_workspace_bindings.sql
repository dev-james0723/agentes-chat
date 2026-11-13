CREATE TABLE "paperclip_workspace_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"machine_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"source_company_id" uuid NOT NULL,
	"source_project_id" uuid NOT NULL,
	"source_workspace_id" uuid NOT NULL,
	"project_digest" text NOT NULL,
	"snapshot_digest" text NOT NULL,
	"binding_digest" text NOT NULL,
	"target_cwd" text NOT NULL,
	"agents" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paperclip_workspace_bindings_orgId_id_unique" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "paperclip_workspace_bindings" ADD CONSTRAINT "paperclip_workspace_bindings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperclip_workspace_bindings" ADD CONSTRAINT "paperclip_workspace_bindings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperclip_workspace_bindings" ADD CONSTRAINT "paperclip_workspace_bindings_org_id_machine_id_machines_org_id_id_fk" FOREIGN KEY ("org_id","machine_id") REFERENCES "public"."machines"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paperclip_workspace_bindings_org_id_source_company_id_source_project_id_source_workspace_id_index" ON "paperclip_workspace_bindings" USING btree ("org_id","source_company_id","source_project_id","source_workspace_id");