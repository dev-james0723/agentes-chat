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
ALTER TABLE "provider_credentials" ADD COLUMN "secret_fingerprint" text;--> statement-breakpoint
ALTER TABLE "credit_attempts" ADD CONSTRAINT "credit_attempts_approval_id_credit_reserve_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."credit_reserve_approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_attempts" ADD CONSTRAINT "credit_attempts_org_id_pool_id_cycle_id_credit_grant_cycles_org_id_pool_id_id_fk" FOREIGN KEY ("org_id","pool_id","cycle_id") REFERENCES "public"."credit_grant_cycles"("org_id","pool_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_attempts" ADD CONSTRAINT "credit_attempts_org_id_pool_id_route_id_credit_routes_org_id_pool_id_id_fk" FOREIGN KEY ("org_id","pool_id","route_id") REFERENCES "public"."credit_routes"("org_id","pool_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grant_cycles" ADD CONSTRAINT "credit_grant_cycles_org_id_pool_id_credit_pools_org_id_id_fk" FOREIGN KEY ("org_id","pool_id") REFERENCES "public"."credit_pools"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_pools" ADD CONSTRAINT "credit_pools_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reserve_approvals" ADD CONSTRAINT "credit_reserve_approvals_org_id_pool_id_cycle_id_credit_grant_cycles_org_id_pool_id_id_fk" FOREIGN KEY ("org_id","pool_id","cycle_id") REFERENCES "public"."credit_grant_cycles"("org_id","pool_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_routes" ADD CONSTRAINT "credit_routes_org_id_pool_id_credit_pools_org_id_id_fk" FOREIGN KEY ("org_id","pool_id") REFERENCES "public"."credit_pools"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_work_units" ADD CONSTRAINT "credit_work_units_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_attempts_org_id_pool_id_state_index" ON "credit_attempts" USING btree ("org_id","pool_id","state");--> statement-breakpoint
CREATE INDEX "credit_attempts_org_id_work_unit_key_index" ON "credit_attempts" USING btree ("org_id","work_unit_key");--> statement-breakpoint
CREATE INDEX "credit_routes_org_id_credential_id_index" ON "credit_routes" USING btree ("org_id","credential_id");--> statement-breakpoint
CREATE INDEX "credit_routes_credential_fingerprint_index" ON "credit_routes" USING btree ("credential_fingerprint");--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credential_fingerprint" CHECK ("provider_credentials"."secret_fingerprint" is null or "provider_credentials"."secret_fingerprint" ~ '^[a-f0-9]{64}$');