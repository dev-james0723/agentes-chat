CREATE TABLE "openrouter_fallback_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"period" text NOT NULL,
	"run_id" uuid NOT NULL,
	"turn" integer NOT NULL,
	"credential_id" uuid NOT NULL,
	"credential_version" text NOT NULL,
	"router" text NOT NULL,
	"allowed_models" jsonb NOT NULL,
	"reserved_nano_usd" bigint NOT NULL,
	"actual_nano_usd" bigint,
	"actual_model" text,
	"state" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "openrouter_fallback_attempts_orgId_runId_turn_unique" UNIQUE("org_id","run_id","turn"),
	CONSTRAINT "openrouter_attempt_router" CHECK ("openrouter_fallback_attempts"."router" in ('openrouter/auto', 'openrouter/auto-code')),
	CONSTRAINT "openrouter_attempt_amount" CHECK ("openrouter_fallback_attempts"."reserved_nano_usd" > 0 and "openrouter_fallback_attempts"."turn" > 0 and ("openrouter_fallback_attempts"."actual_nano_usd" is null or "openrouter_fallback_attempts"."actual_nano_usd" >= 0)),
	CONSTRAINT "openrouter_attempt_state" CHECK ("openrouter_fallback_attempts"."state" in ('held','settled','unknown') and ("openrouter_fallback_attempts"."state" <> 'settled' or ("openrouter_fallback_attempts"."actual_nano_usd" is not null and "openrouter_fallback_attempts"."actual_model" is not null and "openrouter_fallback_attempts"."settled_at" is not null)))
);
--> statement-breakpoint
CREATE TABLE "openrouter_fallback_months" (
	"org_id" uuid NOT NULL,
	"period" text NOT NULL,
	"spent_nano_usd" bigint DEFAULT 0 NOT NULL,
	"held_nano_usd" bigint DEFAULT 0 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	CONSTRAINT "openrouter_fallback_months_org_id_period_pk" PRIMARY KEY("org_id","period"),
	CONSTRAINT "openrouter_month_amounts" CHECK ("openrouter_fallback_months"."spent_nano_usd" >= 0 and "openrouter_fallback_months"."held_nano_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "openrouter_fallback_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"monthly_cap_nano_usd" bigint DEFAULT 50000000000 NOT NULL,
	"credential_id" uuid,
	"credential_version" text,
	"credential_fingerprint" text,
	"approved_by" text,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openrouter_fallback_settings_credentialFingerprint_unique" UNIQUE("credential_fingerprint"),
	CONSTRAINT "openrouter_fallback_cap" CHECK ("openrouter_fallback_settings"."monthly_cap_nano_usd" > 0 and "openrouter_fallback_settings"."monthly_cap_nano_usd" <= 50000000000),
	CONSTRAINT "openrouter_fallback_identity" CHECK (not "openrouter_fallback_settings"."enabled" or ("openrouter_fallback_settings"."credential_id" is not null and "openrouter_fallback_settings"."credential_version" is not null and "openrouter_fallback_settings"."credential_fingerprint" is not null and "openrouter_fallback_settings"."approved_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "openrouter_fallback_attempts" ADD CONSTRAINT "openrouter_fallback_attempts_org_id_period_openrouter_fallback_months_org_id_period_fk" FOREIGN KEY ("org_id","period") REFERENCES "public"."openrouter_fallback_months"("org_id","period") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openrouter_fallback_months" ADD CONSTRAINT "openrouter_fallback_months_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openrouter_fallback_settings" ADD CONSTRAINT "openrouter_fallback_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openrouter_fallback_attempts_org_id_state_index" ON "openrouter_fallback_attempts" USING btree ("org_id","state");