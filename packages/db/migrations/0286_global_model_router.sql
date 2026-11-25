CREATE TABLE "credit_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid,
	"work_unit_key" text NOT NULL,
	"attempt_key" text NOT NULL,
	"owner_epoch" bigint NOT NULL,
	"owner_job_id" uuid NOT NULL,
	"owner_worker_id" text NOT NULL,
	"bucket" text NOT NULL,
	"reservation_need" jsonb NOT NULL,
	"pricing_snapshot" jsonb NOT NULL,
	"pricing_profile_hash" text NOT NULL,
	"cache_ttl" text NOT NULL,
	"approval_id" uuid,
	"amount_nano_usd" bigint NOT NULL,
	"actual_nano_usd" bigint,
	"state" text DEFAULT 'held' NOT NULL,
	"reason" text,
	"provider_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "credit_attempts_orgId_attemptKey_unique" UNIQUE("org_id","attempt_key"),
	CONSTRAINT "credit_attempt_pricing" CHECK ("credit_attempts"."pricing_profile_hash" ~ '^sha256:[a-f0-9]{64}$' and "credit_attempts"."cache_ttl" in ('default', '1h')),
	CONSTRAINT "credit_attempt_state" CHECK ("credit_attempts"."state" in ('held', 'dispatching', 'settled', 'released', 'unknown')),
	CONSTRAINT "credit_attempt_bucket" CHECK ("credit_attempts"."bucket" in ('automatic', 'emergency')),
	CONSTRAINT "credit_attempt_nonnegative" CHECK ("credit_attempts"."amount_nano_usd" > 0 and "credit_attempts"."owner_epoch" >= 0 and ("credit_attempts"."actual_nano_usd" is null or "credit_attempts"."actual_nano_usd" >= 0))
);
--> statement-breakpoint
CREATE TABLE "credit_grant_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"cycle_key" text NOT NULL,
	"product" text NOT NULL,
	"grant_id" text NOT NULL,
	"grant_start" timestamp with time zone NOT NULL,
	"grant_end" timestamp with time zone NOT NULL,
	"eligible_since" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"evidence_ref" text NOT NULL,
	"verified_by_user_id" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"enforcement" text NOT NULL,
	"external_spend_coverage" text NOT NULL,
	"external_spend_bound_nano_usd" bigint DEFAULT 0 NOT NULL,
	"grant_amount_nano_usd" bigint NOT NULL,
	"observed_remaining_nano_usd" bigint NOT NULL,
	"local_spent_at_observation_nano_usd" bigint DEFAULT 0 NOT NULL,
	"automatic_limit_nano_usd" bigint NOT NULL,
	"emergency_limit_nano_usd" bigint NOT NULL,
	"safety_buffer_nano_usd" bigint NOT NULL,
	"spent_automatic_nano_usd" bigint DEFAULT 0 NOT NULL,
	"spent_emergency_nano_usd" bigint DEFAULT 0 NOT NULL,
	"held_automatic_nano_usd" bigint DEFAULT 0 NOT NULL,
	"held_emergency_nano_usd" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "credit_grant_cycles_orgId_poolId_id_unique" UNIQUE("org_id","pool_id","id"),
	CONSTRAINT "credit_grant_cycles_poolId_cycleKey_unique" UNIQUE("pool_id","cycle_key"),
	CONSTRAINT "credit_grant_cycles_poolId_grantId_unique" UNIQUE("pool_id","grant_id"),
	CONSTRAINT "credit_cycle_product" CHECK ("credit_grant_cycles"."product" in ('openai_pro_api', 'claude_ultra_api')),
	CONSTRAINT "credit_cycle_enforcement" CHECK ("credit_grant_cycles"."enforcement" = 'prepaid_grant_only' and "credit_grant_cycles"."external_spend_coverage" in ('exclusive', 'bounded')),
	CONSTRAINT "credit_cycle_window" CHECK ("credit_grant_cycles"."grant_start" < "credit_grant_cycles"."grant_end" and "credit_grant_cycles"."verified_at" < "credit_grant_cycles"."valid_until" and "credit_grant_cycles"."valid_until" <= "credit_grant_cycles"."grant_end"),
	CONSTRAINT "credit_cycle_nonnegative" CHECK ("credit_grant_cycles"."grant_amount_nano_usd" >= 0 and "credit_grant_cycles"."observed_remaining_nano_usd" >= 0 and "credit_grant_cycles"."observed_remaining_nano_usd" <= "credit_grant_cycles"."grant_amount_nano_usd" and "credit_grant_cycles"."local_spent_at_observation_nano_usd" >= 0 and "credit_grant_cycles"."external_spend_bound_nano_usd" >= 0 and "credit_grant_cycles"."spent_automatic_nano_usd" >= 0 and "credit_grant_cycles"."spent_emergency_nano_usd" >= 0 and "credit_grant_cycles"."held_automatic_nano_usd" >= 0 and "credit_grant_cycles"."held_emergency_nano_usd" >= 0),
	CONSTRAINT "credit_cycle_limits" CHECK ("credit_grant_cycles"."automatic_limit_nano_usd" between 0 and 120000000000 and "credit_grant_cycles"."emergency_limit_nano_usd" between 0 and 60000000000 and "credit_grant_cycles"."safety_buffer_nano_usd" between 0 and 20000000000 and "credit_grant_cycles"."automatic_limit_nano_usd" + "credit_grant_cycles"."emergency_limit_nano_usd" + "credit_grant_cycles"."safety_buffer_nano_usd" <= "credit_grant_cycles"."grant_amount_nano_usd")
);
--> statement-breakpoint
CREATE TABLE "credit_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"upstream_namespace" text NOT NULL,
	"upstream_account" text NOT NULL,
	"current_cycle_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'unverified' NOT NULL,
	CONSTRAINT "credit_pools_orgId_id_unique" UNIQUE("org_id","id"),
	CONSTRAINT "credit_pools_upstreamNamespace_upstreamAccount_unique" UNIQUE("upstream_namespace","upstream_account"),
	CONSTRAINT "credit_pools_orgId_upstreamNamespace_unique" UNIQUE("org_id","upstream_namespace"),
	CONSTRAINT "credit_pool_provider" CHECK ("credit_pools"."upstream_namespace" in ('openai', 'anthropic')),
	CONSTRAINT "credit_pool_status" CHECK ("credit_pools"."status" in ('unverified', 'available', 'exhausted', 'expired', 'billing_blocked', 'reconciliation_required'))
);
--> statement-breakpoint
CREATE TABLE "credit_reserve_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"decision_key" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"amount_nano_usd" bigint NOT NULL,
	"held_nano_usd" bigint DEFAULT 0 NOT NULL,
	"spent_nano_usd" bigint DEFAULT 0 NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "credit_reserve_approvals_orgId_decisionKey_unique" UNIQUE("org_id","decision_key"),
	CONSTRAINT "credit_approval_amount" CHECK ("credit_reserve_approvals"."amount_nano_usd" > 0 and "credit_reserve_approvals"."amount_nano_usd" <= 60000000000 and "credit_reserve_approvals"."held_nano_usd" >= 0 and "credit_reserve_approvals"."spent_nano_usd" >= 0),
	CONSTRAINT "credit_approval_window" CHECK ("credit_reserve_approvals"."approved_at" < "credit_reserve_approvals"."valid_until")
);
--> statement-breakpoint
CREATE TABLE "credit_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"credential_version" text NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"pricing_evidence_ref" text NOT NULL,
	"pricing_verified_at" timestamp with time zone NOT NULL,
	"pricing_valid_until" timestamp with time zone NOT NULL,
	"pricing_profile_hash" text NOT NULL,
	"model" text NOT NULL,
	"route_kind" text NOT NULL,
	"account_evidence_ref" text NOT NULL,
	"supports_tools" boolean DEFAULT false NOT NULL,
	"max_prompt_bytes" bigint NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "credit_routes_orgId_poolId_id_unique" UNIQUE("org_id","pool_id","id"),
	CONSTRAINT "credit_routes_orgId_credentialId_model_unique" UNIQUE("org_id","credential_id","model"),
	CONSTRAINT "credit_route_fingerprint" CHECK ("credit_routes"."credential_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "credit_route_pricing" CHECK ("credit_routes"."pricing_profile_hash" ~ '^sha256:[a-f0-9]{64}$' and "credit_routes"."pricing_verified_at" < "credit_routes"."pricing_valid_until"),
	CONSTRAINT "credit_route_kind" CHECK ("credit_routes"."route_kind" in ('openai_responses', 'anthropic_messages', 'claude_agent_sdk')),
	CONSTRAINT "credit_route_max_prompt" CHECK ("credit_routes"."max_prompt_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_work_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"work_unit_key" text NOT NULL,
	"run_id" uuid NOT NULL,
	"owner_epoch" bigint NOT NULL,
	"owner_job_id" uuid NOT NULL,
	"owner_worker_id" text NOT NULL,
	CONSTRAINT "credit_work_units_orgId_workUnitKey_unique" UNIQUE("org_id","work_unit_key"),
	CONSTRAINT "credit_unit_epoch" CHECK ("credit_work_units"."owner_epoch" >= 0)
);
--> statement-breakpoint
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
ALTER TABLE "provider_credentials" ADD COLUMN "secret_fingerprint" text;--> statement-breakpoint
ALTER TABLE "credit_attempts" ADD CONSTRAINT "credit_attempts_approval_id_credit_reserve_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."credit_reserve_approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_attempts" ADD CONSTRAINT "credit_attempts_org_id_pool_id_cycle_id_credit_grant_cycles_org_id_pool_id_id_fk" FOREIGN KEY ("org_id","pool_id","cycle_id") REFERENCES "public"."credit_grant_cycles"("org_id","pool_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_attempts" ADD CONSTRAINT "credit_attempts_org_id_pool_id_route_id_credit_routes_org_id_pool_id_id_fk" FOREIGN KEY ("org_id","pool_id","route_id") REFERENCES "public"."credit_routes"("org_id","pool_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grant_cycles" ADD CONSTRAINT "credit_grant_cycles_org_id_pool_id_credit_pools_org_id_id_fk" FOREIGN KEY ("org_id","pool_id") REFERENCES "public"."credit_pools"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_pools" ADD CONSTRAINT "credit_pools_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reserve_approvals" ADD CONSTRAINT "credit_reserve_approvals_org_id_pool_id_cycle_id_credit_grant_cycles_org_id_pool_id_id_fk" FOREIGN KEY ("org_id","pool_id","cycle_id") REFERENCES "public"."credit_grant_cycles"("org_id","pool_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_routes" ADD CONSTRAINT "credit_routes_org_id_pool_id_credit_pools_org_id_id_fk" FOREIGN KEY ("org_id","pool_id") REFERENCES "public"."credit_pools"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_work_units" ADD CONSTRAINT "credit_work_units_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_router_accounts" ADD CONSTRAINT "global_router_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_router_attempts" ADD CONSTRAINT "global_router_attempts_org_id_account_id_period_global_router_windows_org_id_account_id_period_fk" FOREIGN KEY ("org_id","account_id","period") REFERENCES "public"."global_router_windows"("org_id","account_id","period") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_router_benchmarks" ADD CONSTRAINT "global_router_benchmarks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_router_offers" ADD CONSTRAINT "global_router_offers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_router_policies" ADD CONSTRAINT "global_router_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_router_windows" ADD CONSTRAINT "global_router_windows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_router_windows" ADD CONSTRAINT "global_router_windows_account_id_global_router_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."global_router_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openrouter_fallback_attempts" ADD CONSTRAINT "openrouter_fallback_attempts_org_id_period_openrouter_fallback_months_org_id_period_fk" FOREIGN KEY ("org_id","period") REFERENCES "public"."openrouter_fallback_months"("org_id","period") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openrouter_fallback_months" ADD CONSTRAINT "openrouter_fallback_months_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openrouter_fallback_settings" ADD CONSTRAINT "openrouter_fallback_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_attempts_org_id_pool_id_state_index" ON "credit_attempts" USING btree ("org_id","pool_id","state");--> statement-breakpoint
CREATE INDEX "credit_attempts_org_id_work_unit_key_index" ON "credit_attempts" USING btree ("org_id","work_unit_key");--> statement-breakpoint
CREATE INDEX "credit_routes_org_id_credential_id_index" ON "credit_routes" USING btree ("org_id","credential_id");--> statement-breakpoint
CREATE INDEX "credit_routes_credential_fingerprint_index" ON "credit_routes" USING btree ("credential_fingerprint");--> statement-breakpoint
CREATE INDEX "global_router_accounts_org_enabled_idx" ON "global_router_accounts" USING btree ("org_id","enabled");--> statement-breakpoint
CREATE INDEX "global_router_attempts_org_state_idx" ON "global_router_attempts" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "global_router_attempts_org_run_idx" ON "global_router_attempts" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "global_router_benchmarks_org_created_idx" ON "global_router_benchmarks" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "global_router_offers_org_status_idx" ON "global_router_offers" USING btree ("org_id","qualification_status");--> statement-breakpoint
CREATE INDEX "openrouter_fallback_attempts_org_id_state_index" ON "openrouter_fallback_attempts" USING btree ("org_id","state");--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credential_fingerprint" CHECK ("provider_credentials"."secret_fingerprint" is null or "provider_credentials"."secret_fingerprint" ~ '^[a-f0-9]{64}$');