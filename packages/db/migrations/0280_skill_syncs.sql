CREATE TABLE "skill_syncs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"agent_id" uuid,
	"notify_user_id" text,
	"via" text NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"commit" text,
	"reason" text,
	"reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_syncs_skillId_version_unique" UNIQUE("skill_id","version")
);
--> statement-breakpoint
ALTER TABLE "skill_syncs" ADD CONSTRAINT "skill_syncs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_syncs" ADD CONSTRAINT "skill_syncs_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_syncs" ADD CONSTRAINT "skill_syncs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_syncs" ADD CONSTRAINT "skill_syncs_notify_user_id_users_id_fk" FOREIGN KEY ("notify_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_syncs_org_id_index" ON "skill_syncs" USING btree ("org_id");