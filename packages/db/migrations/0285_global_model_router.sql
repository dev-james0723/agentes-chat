CREATE TABLE "global_router_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"lane" text NOT NULL,
	"entitlement" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"credential_version" text NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"workspace_account_ref" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"extra_usage_allowed" boolean DEFAULT false NOT NULL,
	"monthly_cap_nano_usd" bigint DEFAULT 0 NOT NULL,
	"max_prompt_nano_per_token" bigint DEFAULT 5000 NOT NULL,
	"max_completion_nano_per_token" bigint DEFAULT 25000 NOT NULL,
	"allowed_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rpm_limit" integer,
	"rpd_limit" integer,
	"tpm_limit" integer,
	"tpd_limit" integer,
	"daily_neurons_limit" integer DEFAULT 10000 NOT NULL,
	"zdr_required" boolean DEFAULT false NOT NULL,
	"allowed_region" text DEFAULT 'global' NOT NULL,
	"health_state" text DEFAULT 'healthy' NOT NULL,
	"quota_telemetry" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quota_observed_at" timestamp with time zone,
	"resets_at" timestamp with time zone,
	"approved_by" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "global_router_accounts_org_provider_lane_unique" UNIQUE("org_id","provider","lane"),
	CONSTRAINT "global_router_account_provider" CHECK ("global_router_accounts"."provider" in ('openrouter','groq','cloudflare','opencode','deepseek','tencent','minimax','zai','moonshot','xiaomi','nvidia')),
	CONSTRAINT "global_router_account_lane" CHECK ("global_router_accounts"."lane" in ('opencode_go','free_api','paid_low_cost','paid_dynamic','direct_api')),
	CONSTRAINT "global_router_account_extra_off" CHECK ("global_router_accounts"."extra_usage_allowed" = false),
	CONSTRAINT "global_router_account_caps" CHECK ((
        ("global_router_accounts"."entitlement" in ('free_only','subscription_go') and "global_router_accounts"."monthly_cap_nano_usd" = 0)
        or (
          "global_router_accounts"."entitlement" = 'paid_capped'
          and "global_router_accounts"."monthly_cap_nano_usd" > 0
          and ("global_router_accounts"."provider" <> 'openrouter' or "global_router_accounts"."monthly_cap_nano_usd" <= 50000000000)
        )
      ) and "global_router_accounts"."max_prompt_nano_per_token" >= 0 and "global_router_accounts"."max_completion_nano_per_token" >= 0 and "global_router_accounts"."daily_neurons_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "global_router_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"period" text NOT NULL,
	"run_id" uuid NOT NULL,
	"routine_run_id" uuid,
	"agent_id" uuid NOT NULL,
	"turn" integer NOT NULL,
	"attempt_index" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"credential_version" text NOT NULL,
	"lane" text NOT NULL,
	"provider" text NOT NULL,
	"requested_model" text NOT NULL,
	"actual_model" text,
	"allowed_models" jsonb NOT NULL,
	"reserved_nano_usd" bigint DEFAULT 0 NOT NULL,
	"actual_nano_usd" bigint,
	"reserved_neurons" integer DEFAULT 0 NOT NULL,
	"actual_neurons" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"latency_ms" integer,
	"quality_verified" boolean DEFAULT false NOT NULL,
	"provider_request_id" text,
	"escalated_from_id" uuid,
	"state" text DEFAULT 'held' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "global_router_attempts_org_idempotency_unique" UNIQUE("org_id","idempotency_key"),
	CONSTRAINT "global_router_attempts_org_run_turn_attempt_unique" UNIQUE("org_id","run_id","turn","attempt_index"),
	CONSTRAINT "global_router_attempt_amounts" CHECK ("global_router_attempts"."reserved_nano_usd" >= 0 and "global_router_attempts"."reserved_neurons" >= 0 and "global_router_attempts"."turn" > 0 and "global_router_attempts"."attempt_index" > 0 and ("global_router_attempts"."actual_nano_usd" is null or "global_router_attempts"."actual_nano_usd" >= 0) and ("global_router_attempts"."actual_neurons" is null or "global_router_attempts"."actual_neurons" >= 0)),
	CONSTRAINT "global_router_attempt_state" CHECK ("global_router_attempts"."state" in ('held','settled','released','unknown') and ("global_router_attempts"."state" <> 'settled' or ("global_router_attempts"."actual_nano_usd" is not null and "global_router_attempts"."actual_model" is not null and "global_router_attempts"."settled_at" is not null)))
);
--> statement-breakpoint
CREATE TABLE "global_router_benchmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"suite_version" text NOT NULL,
	"task_count" integer NOT NULL,
	"model_count" integer NOT NULL,
	"summary" jsonb NOT NULL,
	"results" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "global_router_benchmark_counts" CHECK ("global_router_benchmarks"."task_count" >= 30 and "global_router_benchmarks"."model_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "global_router_offers" (
	"org_id" uuid NOT NULL,
	"offer_id" text NOT NULL,
	"provider" text NOT NULL,
	"lane" text NOT NULL,
	"model_id" text NOT NULL,
	"label" text NOT NULL,
	"qualification_status" text NOT NULL,
	"free_eligible" boolean DEFAULT false NOT NULL,
	"offer" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "global_router_offers_org_id_offer_id_pk" PRIMARY KEY("org_id","offer_id")
);
--> statement-breakpoint
CREATE TABLE "global_router_policies" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"opt_out_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_escalations" integer DEFAULT 2 NOT NULL,
	"max_retries_per_route" integer DEFAULT 1 NOT NULL,
	"warn_at50" boolean DEFAULT true NOT NULL,
	"warn_at80" boolean DEFAULT true NOT NULL,
	"warn_at95" boolean DEFAULT true NOT NULL,
	"approved_by" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "global_router_policy_bounds" CHECK ("global_router_policies"."max_escalations" >= 0 and "global_router_policies"."max_escalations" <= 2 and "global_router_policies"."max_retries_per_route" >= 0 and "global_router_policies"."max_retries_per_route" <= 1),
	CONSTRAINT "global_router_policy_approver" CHECK (not "global_router_policies"."enabled" or "global_router_policies"."approved_by" is not null)
);
--> statement-breakpoint
CREATE TABLE "global_router_windows" (
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"period" text NOT NULL,
	"spent_nano_usd" bigint DEFAULT 0 NOT NULL,
	"held_nano_usd" bigint DEFAULT 0 NOT NULL,
	"day_key" text DEFAULT '' NOT NULL,
	"day_requests_used" integer DEFAULT 0 NOT NULL,
	"day_requests_held" integer DEFAULT 0 NOT NULL,
	"day_tokens_used" bigint DEFAULT 0 NOT NULL,
	"day_neurons_used" integer DEFAULT 0 NOT NULL,
	"day_neurons_held" integer DEFAULT 0 NOT NULL,
	"minute_key" text DEFAULT '' NOT NULL,
	"minute_requests_used" integer DEFAULT 0 NOT NULL,
	"minute_tokens_used" bigint DEFAULT 0 NOT NULL,
	"warned50" boolean DEFAULT false NOT NULL,
	"warned80" boolean DEFAULT false NOT NULL,
	"warned95" boolean DEFAULT false NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	CONSTRAINT "global_router_windows_org_id_account_id_period_pk" PRIMARY KEY("org_id","account_id","period"),
	CONSTRAINT "global_router_window_nonnegative" CHECK ("global_router_windows"."spent_nano_usd" >= 0 and "global_router_windows"."held_nano_usd" >= 0 and "global_router_windows"."day_requests_used" >= 0 and "global_router_windows"."day_requests_held" >= 0 and "global_router_windows"."day_tokens_used" >= 0 and "global_router_windows"."day_neurons_used" >= 0 and "global_router_windows"."day_neurons_held" >= 0 and "global_router_windows"."minute_requests_used" >= 0 and "global_router_windows"."minute_tokens_used" >= 0)
);
--> statement-breakpoint
ALTER TABLE "global_router_accounts" ADD CONSTRAINT "global_router_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_router_attempts" ADD CONSTRAINT "global_router_attempts_org_id_account_id_period_global_router_windows_org_id_account_id_period_fk" FOREIGN KEY ("org_id","account_id","period") REFERENCES "public"."global_router_windows"("org_id","account_id","period") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_router_benchmarks" ADD CONSTRAINT "global_router_benchmarks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_router_offers" ADD CONSTRAINT "global_router_offers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_router_policies" ADD CONSTRAINT "global_router_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_router_windows" ADD CONSTRAINT "global_router_windows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_router_windows" ADD CONSTRAINT "global_router_windows_account_id_global_router_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."global_router_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "global_router_accounts_org_enabled_idx" ON "global_router_accounts" USING btree ("org_id","enabled");--> statement-breakpoint
CREATE INDEX "global_router_attempts_org_state_idx" ON "global_router_attempts" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "global_router_attempts_org_run_idx" ON "global_router_attempts" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "global_router_benchmarks_org_created_idx" ON "global_router_benchmarks" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "global_router_offers_org_status_idx" ON "global_router_offers" USING btree ("org_id","qualification_status");