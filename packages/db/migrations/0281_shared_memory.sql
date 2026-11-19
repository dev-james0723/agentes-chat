CREATE TABLE "shared_memory_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allowed_sensitivity" jsonb DEFAULT '["personal","workspace","sensitive"]'::jsonb NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"reason" text,
	"last_synced_at" timestamp with time zone,
	CONSTRAINT "shared_memory_destinations_profileId_orgId_unique" UNIQUE("profile_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "shared_memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"logical_key" text NOT NULL,
	"item_id" uuid,
	"item_org_id" uuid NOT NULL,
	"source_org_id" uuid NOT NULL,
	"source_item_id" uuid,
	"source_id" uuid,
	"source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"history_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin_id" text NOT NULL,
	"source_revision" text,
	"content_hash" text NOT NULL,
	"forgotten_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"sensitivity" text DEFAULT 'personal' NOT NULL,
	"assertion" text DEFAULT 'inference' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"observed_at" timestamp with time zone,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"forgotten_at" timestamp with time zone,
	"external_outstanding" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_memory_entries_profileId_logicalKey_unique" UNIQUE("profile_id","logical_key"),
	CONSTRAINT "shared_memory_entries_profileId_originId_unique" UNIQUE("profile_id","origin_id")
);
--> statement-breakpoint
CREATE TABLE "shared_memory_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"consumers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verification" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_memory_profiles_ownerUserId_unique" UNIQUE("owner_user_id")
);
--> statement-breakpoint
CREATE TABLE "shared_memory_replicas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"item_id" uuid,
	"history_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applied_hash" text,
	"applied_version" integer,
	"state" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"checked_at" timestamp with time zone,
	CONSTRAINT "shared_memory_replicas_entryId_orgId_unique" UNIQUE("entry_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "shared_memory_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"origin_id" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_memory_sources_profileId_originId_unique" UNIQUE("profile_id","origin_id")
);
--> statement-breakpoint
ALTER TABLE "shared_memory_destinations" ADD CONSTRAINT "shared_memory_destinations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_destinations" ADD CONSTRAINT "shared_memory_destinations_profile_id_shared_memory_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."shared_memory_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_entries" ADD CONSTRAINT "shared_memory_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_entries" ADD CONSTRAINT "shared_memory_entries_profile_id_shared_memory_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."shared_memory_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_profiles" ADD CONSTRAINT "shared_memory_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_profiles" ADD CONSTRAINT "shared_memory_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_replicas" ADD CONSTRAINT "shared_memory_replicas_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_replicas" ADD CONSTRAINT "shared_memory_replicas_profile_id_shared_memory_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."shared_memory_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_replicas" ADD CONSTRAINT "shared_memory_replicas_entry_id_shared_memory_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."shared_memory_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_sources" ADD CONSTRAINT "shared_memory_sources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_sources" ADD CONSTRAINT "shared_memory_sources_profile_id_shared_memory_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."shared_memory_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shared_memory_destinations_org_id_index" ON "shared_memory_destinations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "shared_memory_entries_item_id_index" ON "shared_memory_entries" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "shared_memory_entries_org_id_index" ON "shared_memory_entries" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "shared_memory_replicas_item_id_index" ON "shared_memory_replicas" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "shared_memory_replicas_org_id_index" ON "shared_memory_replicas" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "shared_memory_sources_org_id_index" ON "shared_memory_sources" USING btree ("org_id");